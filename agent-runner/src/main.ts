import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { selectAgent } from "./agents/registry.ts";
import type { AgentResult } from "./agents/types.ts";
import { ensureAgentCli } from "./cli.ts";
import { agentEnv, withheldSecretNames } from "./env.ts";
import * as git from "./git.ts";
import type { PrInfo } from "./github.ts";
import { renderLearnings } from "./learnings.ts";
import { metricsLine, writeMetrics } from "./metrics.ts";
import { auditStagedChanges, describeAudit, stageChanges } from "./policy.ts";
import { resolveProvider } from "./providers/index.ts";
import { profileFor } from "./profile.ts";
import {
  classifyTask,
  DEFAULT_LOCALE,
  loadTemplate,
  normalizeLocale,
  normalizePromptsDir,
  renderTaskMarkdown,
  type TaskKind,
} from "./prompt.ts";
import { assessRisk, autoMergeDecision, parseAutoMergeMode, type RiskAssessment } from "./risk.ts";
import { routeAgent } from "./router.ts";
import { captureVerifySpec, runVerify, type VerifyResult } from "./verify.ts";

const L = {
  trigger: "ai",
  running: "ai-running",
  pr: "ai-pr",
  failed: "ai-failed",
  done: "ai-done",
  /** the agent needs a human answer before it can continue (H2) */
  needsInput: "ai-needs-input",
  /** the diff touches the runner / CI / installers -> human review required */
  core: "ai-core",
  /** the repository's check configuration changed while the agent was running */
  verifyChanged: "ai-verify-changed",
  /** auto-merge was armed on the resulting PR */
  automerge: "ai-automerge",
  /** skipped because a quota/deadline was hit; safe to retry later */
  deferred: "ai-deferred",
};

type Outcome = "pr" | "done" | "failed" | "blocked" | "deferred";

/** Labels that mean "this issue has already been handled"; used as a fast skip. */
const HANDLED = [L.running, L.pr, L.failed, L.done, L.needsInput, L.deferred];

const BLOCKED_FILE = "EASYGH_BLOCKED.md";

const log = (...args: unknown[]) => console.log("[runner]", ...args);

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isInteger(raw)) return fallback;
  return Math.min(max, Math.max(min, raw));
}

function redact(text: string): string {
  let out = text;
  const patterns: Array<[RegExp, string]> = [
    [/sk-[A-Za-z0-9_\-]{12,}/g, "sk-[redacted]"],
    [/gh[pousr]_[A-Za-z0-9]{20,}/g, "gh[redacted]"],
    [/githu[b]_[A-Za-z0-9]{20,}/gi, "github[redacted]"],
  ];
  for (const [re, rep] of patterns) out = out.replace(re, rep);
  for (const name of [
    "DEEPSEEK_API_KEY",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "EASYGH_PR_TOKEN",
    "EASYGH_APP_PRIVATE_KEY",
  ]) {
    const val = process.env[name];
    if (val && val.length > 4) out = out.split(val).join(`[${name} redacted]`);
  }
  return out;
}

function writeText(file: string, text: string): string {
  writeFileSync(file, text, "utf8");
  return file;
}

function logTail(logFile: string, maxLines = 120, maxChars = 8000): string {
  try {
    const raw = readFileSync(logFile, "utf8").split("\n");
    const tail = raw.slice(-maxLines).join("\n");
    return tail.length > maxChars ? "…" + tail.slice(-maxChars) : tail;
  } catch {
    return "(no log file)";
  }
}

/** Context appended to the task file when a previous attempt failed verification. */
function retryContext(verifyOutput: string, failedAttempt: number): string {
  const tail = verifyOutput.trim().slice(-6000) || "(verification produced no output)";
  return [
    ``,
    `---`,
    ``,
    `## ⚠️ Previous attempt did NOT pass independent verification`,
    ``,
    `The repository checks failed after attempt ${failedAttempt}. Your previous changes may still be in the working tree — inspect and fix them (do not redo or duplicate work).`,
    `Make the checks pass; the pipeline re-verifies automatically after you finish.`,
    ``,
    "```",
    tail,
    "```",
  ].join("\n");
}

/**
 * H2: the agent can stop and ask for a decision by writing EASYGH_BLOCKED.md
 * (or by starting its summary with NEEDS_INPUT:). The runner then posts the
 * question and parks the issue — it must not guess on the human's behalf.
 */
function readBlocked(workDir: string, summary: string): string | null {
  const file = join(workDir, BLOCKED_FILE);
  if (existsSync(file)) {
    let body = "";
    try {
      body = readFileSync(file, "utf8").trim();
    } catch {
      body = "";
    }
    try {
      rmSync(file, { force: true });
    } catch {
      // ignore
    }
    return body || "(the agent requested input but wrote no details)";
  }
  const marker = summary.search(/\bNEEDS_INPUT\s*:/);
  if (marker >= 0) return summary.slice(marker).trim();
  return null;
}

function verificationLine(result: VerifyResult | null, kind: string): string {
  if (kind === "review") return "🧐 Review 任务：不做代码改动，也不要求通过仓库检查";
  if (!result) return "⚠️ 未执行独立检查（时间预算耗尽）";
  if (result.skipped) return "⚠️ 仓库中没有可运行的检查命令，本次改动**未经独立验证**";
  if (result.tampered) return `⚠️ 检查配置在运行期间被修改，已用冻结版本复验：\`${result.command}\``;
  return `✅ 已通过独立检查：\`${result.command}\``;
}

function riskLine(risk: RiskAssessment | null): string {
  if (!risk) return "";
  const icon = risk.level === "high" ? "🔴" : risk.level === "medium" ? "🟡" : "🟢";
  return `${icon} 风险等级：**${risk.level}** — ${risk.reasons.join("；")}`;
}

async function main(): Promise<void> {
  // `AI_TARGET_REPO` is for workflows that cannot override the reserved
  // GITHUB_REPOSITORY variable (ai-run.yml runs one task for a foreign repo).
  const repo = process.env.AI_TARGET_REPO?.trim() || requireEnv("GITHUB_REPOSITORY");
  const issueNumber = Number(requireEnv("ISSUE_NUMBER"));
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) throw new Error(`Bad ISSUE_NUMBER: ${process.env.ISSUE_NUMBER}`);

  const startedAt = Date.now();
  // Repository profile (hub-side config/repos.json): project-specific verify
  // commands, protected paths and agent/model, without touching this project.
  const profile = profileFor(repo);
  if (Object.keys(profile).length > 0) {
    log(`profile: ${Object.keys(profile).sort().join(",")}`);
  }
  const thinking = process.env.THINKING?.trim() || "high";
  const defaultBranch = process.env.DEFAULT_BRANCH ?? "main";
  const workDir = process.env.WORK_DIR ?? process.cwd();
  const runDir = join(process.env.RUNNER_TEMP ?? ".tmp/runner", `ai-issue-${issueNumber}`);
  mkdirSync(runDir, { recursive: true });

  // All platform calls go through the provider seam (GitHub today; GitLab or
  // Gitea would implement the same interface).
  const platform = resolveProvider();
  const ref = { repo, number: issueNumber };
  const caps = Object.entries(platform.capabilities)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
  log(`provider=${platform.name} capabilities=${caps.join(",") || "(none)"}`);

  // Time budget: the job timeout must cover attempts * (agent + verify) plus
  // install/push overhead. Every step below is clamped by the remaining budget
  // so a slow run reports "budget exhausted" instead of being killed mid-flight.
  const piTimeoutMs = intEnv("PI_TIMEOUT_MS", 15 * 60 * 1000, 60_000, 60 * 60 * 1000);
  const verifyTimeoutMs = intEnv("VERIFY_TIMEOUT_MS", profile.verifyTimeoutMs ?? 10 * 60 * 1000, 10_000, 60 * 60 * 1000);
  const budgetMs = intEnv("AGENT_BUDGET_MS", 75 * 60 * 1000, 60_000, 6 * 60 * 60 * 1000);
  const lockTtlMs = intEnv("LOCK_TTL_MS", 3 * 60 * 60 * 1000, 10 * 60 * 1000, 24 * 60 * 60 * 1000);
  const maxAttempts = intEnv("AI_MAX_ATTEMPTS", profile.maxAttempts ?? 3, 1, 5);
  const maxPrsPerDay = intEnv("AI_MAX_PRS_PER_DAY", profile.maxPrsPerDay ?? 10, 0, 200);
  const autoMergeMode = parseAutoMergeMode(process.env.AI_AUTOMERGE);
  const reviewer = process.env.AI_REVIEWER?.trim() ?? "";
  const remainingMs = () => budgetMs - (Date.now() - startedAt);

  const branch = `ai/issue-${issueNumber}`;
  log(`repo=${repo} issue=#${issueNumber} branch=${branch}`);
  log(
    `budget=${Math.round(budgetMs / 60000)}m agent≤${Math.round(piTimeoutMs / 60000)}m verify≤${Math.round(verifyTimeoutMs / 60000)}m attempts=${maxAttempts} automerge=${autoMergeMode}`,
  );
  if (maxAttempts * (piTimeoutMs + verifyTimeoutMs) > budgetMs) {
    log("warning: AI_MAX_ATTEMPTS * (PI_TIMEOUT_MS + VERIFY_TIMEOUT_MS) exceeds AGENT_BUDGET_MS; later attempts may be skipped");
  }

  let claimed = false;
  let locked = false;
  let outcome: Outcome | null = null;
  let kind: TaskKind = "bug-fix";
  let agentName = "pi";
  let provider = "deepseek";
  let model = "unknown";
  let risk: RiskAssessment | null = null;
  let verifyResult: VerifyResult | null = null;
  let attempts = 0;
  let changedFiles = 0;
  let changedLines = 0;
  let prNumber: number | undefined;
  let automergeArmed = false;

  const finish = (result: Outcome) => {
    platform.issues.removeLabel(ref, L.running);
    if (result === "pr") platform.issues.addLabel(ref, L.pr);
    else if (result === "failed") platform.issues.addLabel(ref, L.failed);
    else if (result === "blocked") platform.issues.addLabel(ref, L.needsInput);
    else if (result === "deferred") platform.issues.addLabel(ref, L.deferred);
    else platform.issues.addLabel(ref, L.done);
  };

  const postComment = (body: string, name = "comment.md") =>
    platform.issues.commentFromFile(ref, writeText(join(runDir, name), body));

  const retryHint = `如需重试：在工作流 \`ai-decide\` 选择动作 \`retry\`，或移除 \`${L.failed}\`/\`${L.needsInput}\`/\`${L.deferred}\` 标签后重新添加 \`${L.trigger}\`。`;

  try {
    // --- claim: labels (fast) + atomic lock (authoritative) -------------------
    const labels = platform.issues.labels(ref);
    if (HANDLED.some((x) => labels.includes(x))) {
      log(`skip: issue already handled/in-flight (labels: ${labels.join(",")})`);
      return;
    }

    const lockState = platform.locks.acquire(ref, { defaultBranch, ttlMs: lockTtlMs });
    if (lockState === "busy") {
      log("skip: another run holds the claim lock");
      return;
    }
    locked = lockState === "acquired";
    if (lockState === "unavailable") {
      log("warning: claim lock API unavailable (permissions/ruleset); falling back to labels only");
    }

    platform.issues.addLabel(ref, L.running);
    platform.issues.removeLabel(ref, L.trigger);
    claimed = true;
    log(locked ? "claimed (lock + ai-running set, ai removed)" : "claimed (labels only, ai removed)");

    // --- quota: cap how much work one day may spend ---------------------------
    if (maxPrsPerDay > 0) {
      const recent = platform.pulls.countRecent(repo, 24);
      if (recent >= maxPrsPerDay) {
        log(`deferred: ${recent}/${maxPrsPerDay} AI PRs in the last 24h`);
        postComment(
          `⏳ **今日 AI 配额已用尽**（最近 24h 已开 ${recent}/${maxPrsPerDay} 个 PR）。\n\n本次未执行，标签改为 \`${L.deferred}\`。配额恢复后重试即可。`,
        );
        outcome = "deferred";
        return;
      }
      log(`quota: ${recent}/${maxPrsPerDay} AI PRs in the last 24h`);
    }

    // --- context -------------------------------------------------------------
    const issue = platform.issues.get(ref);
    kind = classifyTask(issue);
    log(`issue: ${issue.title} | kind=${kind} | labels=${issue.labels.join(",") || "(none)"}`);

    // --- prompt variant: env > profile > default language ---------------------
    const localeRaw = process.env.AI_LOCALE?.trim() || profile.locale;
    const locale = normalizeLocale(localeRaw) ?? DEFAULT_LOCALE;
    if (localeRaw && normalizeLocale(localeRaw) === undefined) {
      log(`prompt: ignoring invalid locale "${localeRaw}", using ${DEFAULT_LOCALE}`);
    }
    const promptsDir = normalizePromptsDir(process.env.EASYGH_PROMPTS_DIR?.trim() || profile.promptsDir);
    const templateOptions = { locale, ...(promptsDir ? { promptsDir } : {}) };
    log(`prompt: ${loadTemplate(kind, templateOptions).label}`);

    // H2 replies live in the issue thread; replay them into the task.
    const humanComments = platform.issues.recentHumanComments(ref);
    const humanContext =
      humanComments.length === 0
        ? ""
        : [
            ``,
            `---`,
            ``,
            `## 人工补充说明（Issue 评论，按时间顺序；以此为准）`,
            ``,
            ...humanComments.map((c) => `**@${c.author}** (${c.createdAt}):\n${c.body}`),
          ].join("\n");
    const issueBody = issue.body + humanContext;
    const learnings = renderLearnings(workDir, `${issue.title} ${issue.body}`, profile.learningsFile);
    if (learnings) log("injected repository learnings from docs/learnings.md");

    // --- agent selection: env override > issue label agent:x > rules > default ---
    const explicitAgent = process.env.AGENT?.trim();
    agentName = explicitAgent
      ? explicitAgent.toLowerCase()
      : await routeAgent({ labels: issue.labels, title: issue.title }, profile.agent);
    const agent = selectAgent(agentName);
    const isPi = agentName === "pi";
    provider = isPi ? (process.env.PROVIDER ?? "deepseek") : agentName;
    model = isPi
      ? process.env.MODEL?.trim() || profile.model || "deepseek-v4-flash"
      : (process.env[`AI_${agentName.toUpperCase()}_MODEL`]?.trim() ?? profile.model ?? "default");
    const extraArgs = isPi && thinking ? ["--thinking", thinking] : [];
    log(`agent=${agent.name} provider=${provider} model=${model} (override=${explicitAgent ?? "no"})`);

    const cliIssue = await ensureAgentCli(agentName);
    if (cliIssue) log(`warning: agent CLI provisioning: ${cliIssue}`);
    else log(`agent CLI ready (${agentName})`);

    // The agent never sees repository write credentials (GH_TOKEN & friends).
    const childEnv = agentEnv();
    const withheld = withheldSecretNames();
    log(`agent env: ${Object.keys(childEnv).length} vars forwarded, ${withheld.length} secret-looking withheld (${withheld.join(",") || "none"})`);

    const meta = {
      repo,
      issueNumber,
      title: issue.title,
      url: issue.url,
      labels: issue.labels,
      branch,
      provider,
      model,
    };

    // --- branch (created once; retries reuse it) -----------------------------
    const head = git.currentBranch(workDir);
    if (head !== defaultBranch) log(`warning: current branch "${head}" != default "${defaultBranch}"`);
    git.deleteRemoteBranchIfExists(workDir, branch);
    git.createBranch(workDir, branch);
    git.setIdentity(workDir, "EasyGithub Agent", "41898282+github-actions[bot]@users.noreply.github.com");
    log(`branch ${branch} ready`);

    // --- freeze the referee before the agent can touch the repo --------------
    const verifySpec = await captureVerifySpec(workDir, profile);
    log(`gate frozen: cmd="${verifySpec.command ?? "(none)"}" (${verifySpec.scriptBody ? "script body captured" : "no script body"})`);

    // --- remove push credentials for the agent phase --------------------------
    git.hideCredentials(workDir);
    log("git push credentials hidden from the agent");

    // --- agent attempts with independent verification -------------------------
    let agentResult: AgentResult | null = null;
    let lastVerify = "";
    let verifiedPass = kind === "review";

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const remaining = remainingMs();
      if (remaining <= 90_000) {
        log(`budget exhausted before attempt ${attempt} (${Math.round(remaining / 1000)}s left)`);
        break;
      }
      attempts = attempt;
      const attemptTimeout = Math.min(piTimeoutMs, Math.max(60_000, remaining - verifyTimeoutMs - 30_000));
      log(
        `--- attempt ${attempt}/${maxAttempts} (agent ≤${Math.round(attemptTimeout / 60000)}m, budget left ${Math.round(remaining / 60000)}m) ---`,
      );

      const bodyWithContext = (attempt === 1 ? issueBody : issueBody + retryContext(lastVerify, attempt - 1)) + learnings;
      const taskMd = renderTaskMarkdown(kind, meta, bodyWithContext, templateOptions);
      const taskFile = writeText(join(runDir, "TASK.md"), taskMd);
      const logFile = join(runDir, `pi-${attempt}.jsonl`);

      const result = await agent.run({
        repo,
        issueNumber,
        workDir,
        taskFile,
        provider,
        model,
        extraArgs,
        logFile,
        timeoutMs: attemptTimeout,
        env: childEnv,
      });
      agentResult = result;
      log(`attempt ${attempt}: agent ok=${result.ok} error=${result.error ?? "(none)"}`);

      if (!result.ok) {
        // Agent itself failed (crash/timeout/model error). Not something a code
        // retry fixes — report and stop.
        const detail = redact(`${result.error ?? "agent failed"}\n\n--- last log lines ---\n${logTail(logFile)}`);
        postComment(
          `❌ **AI 处理失败（${agent.name} / ${model}，attempt ${attempt}/${maxAttempts}）**\n\n\`\`\`\n${detail.slice(0, 6000)}\n\`\`\`\n\n${retryHint}`,
        );
        outcome = "failed";
        process.exitCode = 1;
        return;
      }

      // H2: the agent explicitly asked for a human decision.
      const blocked = readBlocked(workDir, result.summary ?? "");
      if (blocked) {
        log("agent requested human input (blocked)");
        const mention = reviewer ? `\n\ncc ${reviewer}` : "";
        postComment(
          `## 🙋 需要人工决策\n\n${redact(blocked).slice(0, 4000)}\n\n` +
            `**如何回答**：直接在本 Issue 评论（仓库成员/协作者，任意文本）。下次运行会把最近的评论原样交给 AI。` +
            `${mention}\n\n回答后在工作流 \`ai-decide\` 选择动作 \`retry\`（或移除 \`${L.needsInput}\` 标签后重新添加 \`${L.trigger}\`）。`,
        );
        outcome = "blocked";
        return;
      }

      if (kind === "review") break;

      // Independent referee — do not trust the agent's self-reported checks.
      const verify = await runVerify(
        workDir,
        verifySpec,
        Math.min(verifyTimeoutMs, Math.max(30_000, remainingMs() - 30_000)),
      );
      verifyResult = verify;
      lastVerify = verify.output;
      writeText(join(runDir, `verify-${attempt}.log`), verify.output);
      log(
        `attempt ${attempt}: verify ok=${verify.ok} skipped=${verify.skipped} tampered=${verify.tampered} cmd="${verify.command || "(none)"}"`,
      );

      if (verify.ok) {
        verifiedPass = true;
        break; // checks pass -> package & deliver
      }

      if (attempt < maxAttempts) {
        log(`attempt ${attempt}: verification FAILED — feeding failure back to agent for retry`);
        continue;
      }
    }

    if (!agentResult) {
      log("no agent attempt could be started");
      postComment(
        `⏱️ **AI 流水线未能在时间预算内启动**（预算 ${Math.round(budgetMs / 60000)} 分钟，agent 上限 ${Math.round(piTimeoutMs / 60000)} 分钟/次）。\n\n` +
          `请调大 \`AGENT_BUDGET_MS\` / \`PI_TIMEOUT_MS\`，或缩小 Issue 范围。${retryHint}`,
      );
      outcome = "failed";
      process.exitCode = 1;
      return;
    }

    if (!verifiedPass) {
      const reason = verifyResult
        ? verifyResult.timedOut
          ? "检查超时"
          : "仓库检查未通过"
        : "时间预算耗尽";
      const detail = redact(
        verifyResult
          ? `Verification still failing after ${maxAttempts} attempts.\n\nCommand: ${verifyResult.command}\n\n--- last verify output ---\n${verifyResult.output.slice(-6000)}`
          : `The run exhausted its ${Math.round(budgetMs / 60000)} minute budget before verification could pass.`,
      );
      postComment(
        `❌ **AI 处理后仍未通过仓库检查**（${agent.name} / ${model}，${reason}）\n\n\`\`\`\n${detail.slice(0, 6000)}\n\`\`\`\n\n${retryHint}`,
      );
      outcome = "failed";
      process.exitCode = 1;
      return;
    }

    // --- review tasks are read-only: publish the report, never commit ----------
    if (kind === "review") {
      const summary = redact(agentResult.summary || "(review produced no output)");
      postComment(`## 🧐 AI Review（${agent.name} / ${model}）\n\n${summary.slice(0, 6000)}`);
      log("review report posted (no code change expected)");
      outcome = "done";
      return;
    }

    // --- verify passed: package & deliver --------------------------------------
    const staged = stageChanges(workDir, profile);
    if (staged.ignored.length > 0) log(`not committing ${staged.ignored.length} generated path(s): ${staged.ignored.slice(0, 5).join(",")}`);

    if (!git.hasStagedChanges(workDir)) {
      log("no code changes produced");
      const summary = redact(agentResult.summary || "(no summary)");
      postComment(
        `🤖 **AI 处理完成，但未产生可提交的代码变更**（${agent.name} / ${model}）。\n\n${verificationLine(verifyResult, kind)}\n\n${summary.slice(0, 3000)}`,
      );
      outcome = "done";
      return;
    }

    // Policy gate: path allow-list + secret scan on the staged diff.
    const audit = auditStagedChanges(workDir, profile);
    if (!audit.ok) {
      log(`policy violation: blocked=${audit.blocked.length} secrets=${audit.secrets.length}`);
      postComment(
        `❌ **AI 改动被流水线策略拒绝**（${agent.name} / ${model}）\n\n${redact(describeAudit(audit))}\n\n` +
          `分支 \`${branch}\` 未推送，未创建 PR。这些路径需要人工提交（H3）。`,
      );
      outcome = "failed";
      process.exitCode = 1;
      return;
    }

    // Risk classification decides whether a human is required.
    const stats = git.stagedDiffStats(workDir);
    changedFiles = stats.files;
    changedLines = stats.added + stats.deleted;
    risk = assessRisk({
      paths: audit.paths,
      changedLines,
      verify: verifyResult
        ? { verified: verifyResult.verified, tampered: verifyResult.tampered, skipped: verifyResult.skipped }
        : null,
      protectedPaths: profile.protectedPaths,
      protectedFiles: profile.protectedFiles,
      dependencyFiles: profile.dependencyFiles,
    });
    log(`risk=${risk.level} (${risk.reasons.join("; ")}) files=${changedFiles} lines=${changedLines}`);

    if (audit.sensitive.length > 0 || risk.level === "high") {
      platform.issues.addLabel(ref, L.core);
      log(`flagged ${L.core} (${audit.sensitive.length} sensitive path(s), risk=${risk.level})`);
    }
    if (verifyResult?.tampered) {
      platform.issues.addLabel(ref, L.verifyChanged);
      log(`flagged ${L.verifyChanged}: the check configuration changed during the run`);
    }

    const shortTitle = issue.title.slice(0, 60);
    const kindPrefix = kind === "feature" ? "feat" : "fix";
    const commitMessage = `${kindPrefix}: #${issueNumber} ${shortTitle}`;
    git.commitStaged(workDir, commitMessage);
    log(`committed: ${commitMessage}`);

    git.restoreCredentials(workDir);

    // The base branch can move while the agent works (another PR merged). A PR
    // opened from a stale branch stays BLOCKED/DIRTY, so rebase first and, when
    // the tree actually changed, verify the rebased tree again before pushing.
    const reportConflict = (conflicts: string[]) => {
      const files = conflicts.slice(0, 12).map((f) => `- ${f}`).join("\n") || "- (unknown)";
      log(`rebase conflict in ${conflicts.length} file(s): ${conflicts.slice(0, 5).join(",")}`);
      postComment(
        `⚠️ **基线分支 \`${defaultBranch}\` 在本任务运行期间发生了变更，且与本次改动冲突**\n\n${files}\n\n` +
          `分支 \`${branch}\` **未推送**，Issue 标记为 \`${L.needsInput}\`。请选择：\n\n` +
          `- \`ai-decide retry\`：删除分支、在最新基线上重跑（推荐，多数冲突会自动消失）；\n` +
          `- 人工基于最新 \`${defaultBranch}\` 解决冲突后自行提交。`,
      );
      outcome = "blocked";
    };

    const sync = git.syncWithBase(workDir, defaultBranch);
    if (sync.warning) log(`warn: ${sync.warning} (pushing without a rebase)`);
    if (!sync.ok) {
      reportConflict(sync.conflicts);
      return;
    }
    if (sync.changed) {
      log(`rebased onto origin/${defaultBranch} — re-running verification on the rebased tree`);
      const recheck = await runVerify(
        workDir,
        verifySpec,
        Math.min(verifyTimeoutMs, Math.max(30_000, remainingMs() - 30_000)),
      );
      verifyResult = recheck;
      writeText(join(runDir, "verify-rebased.log"), recheck.output);
      log(`post-rebase verify ok=${recheck.ok} tampered=${recheck.tampered} cmd="${recheck.command || "(none)"}"`);
      if (!recheck.ok) {
        postComment(
          `❌ **基线分支已变更，rebase 后仓库检查不再通过**（\`${recheck.command || "no check"}\`）\n\n` +
            `\`\`\`\n${redact(recheck.output.slice(-5000))}\n\`\`\`\n\n` +
            `分支 \`${branch}\` 未推送。冲突通常意味着基线的新改动与本任务不兼容，需要人工判断。${retryHint}`,
        );
        outcome = "failed";
        process.exitCode = 1;
        return;
      }
    }

    try {
      git.pushBranch(workDir, branch, { force: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/rejected|non-fast-forward|fetch first|stale info/i.test(message)) throw err;
      // Race window: the base moved between the rebase and the push.
      log("push rejected — base moved again, rebasing once more and retrying");
      const retry = git.syncWithBase(workDir, defaultBranch);
      if (!retry.ok) {
        reportConflict(retry.conflicts);
        return;
      }
      git.pushBranch(workDir, branch, { force: true });
    }
    log("pushed");

    const summary = redact(agentResult.summary || "(agent did not provide a summary; review the diff)");
    const draft = risk.level === "high";
    const prBody = [
      `## Summary`,
      ``,
      summary.slice(0, 4000),
      ``,
      `Fixes #${issueNumber}`,
      ``,
      `---`,
      verificationLine(verifyResult, kind),
      ``,
      riskLine(risk),
      ``,
      draft ? `🚧 **草稿 PR**：风险等级 high，需要 code owner 审查后标记 "Ready for review"。` : ``,
      ``,
      `_Auto-generated by EasyGithub AI pipeline (${agent.name} / ${provider} / ${model})._`,
    ]
      .filter((line, i, all) => !(line === `` && all[i + 1] === ``))
      .join("\n");
    const prBodyFile = writeText(join(runDir, "pr-body.md"), prBody);

    let pr: PrInfo;
    try {
      pr = platform.pulls.create({
        repo,
        base: defaultBranch,
        head: branch,
        title: `[AI] ${kindPrefix}: #${issueNumber} ${shortTitle}`.slice(0, 110),
        bodyFile: prBodyFile,
        draft,
      });
      prNumber = pr.number;
    } catch (err) {
      log(`PR creation failed: ${err instanceof Error ? err.message : err}`);
      const detail = redact(err instanceof Error ? err.message : String(err));
      postComment(
        `⚠️ **代码已完成、验证通过并推送，但自动创建 PR 失败**。分支：\`${branch}\`\n\n\`\`\`\n${detail.slice(0, 2000)}\n\`\`\`\n\n请手动创建 PR 或重试。`,
      );
      outcome = "failed";
      process.exitCode = 1;
      return;
    }

    // Arm auto-merge only for low-risk, fully verified, non-draft PRs.
    const decision = autoMergeDecision({
      mode: autoMergeMode,
      risk,
      verify: verifyResult
        ? { verified: verifyResult.verified, tampered: verifyResult.tampered, skipped: verifyResult.skipped }
        : null,
      paths: audit.paths,
    });
    const incidentOpen = platform.incidents.hasOpen(repo);
    if (incidentOpen) log("auto-merge suppressed: open ai-incident (circuit breaker latch)");
    if (decision.allowed && !draft && !incidentOpen) {
      const armed = platform.pulls.armAutoMerge(repo, pr.number);
      automergeArmed = armed.ok;
      if (armed.ok) {
        platform.issues.addLabel(ref, L.automerge);
        log(`auto-merge armed on PR #${pr.number}`);
      } else {
        log(`warning: auto-merge could not be armed: ${armed.detail}`);
      }
    } else {
      log(`auto-merge not armed: ${incidentOpen ? "open incident latch" : decision.reason}`);
    }

    const body = [
      `✅ **AI 完成并创建 PR**（${agent.name} / ${model}）：${pr.url}`,
      ``,
      verificationLine(verifyResult, kind),
      ``,
      riskLine(risk),
      automergeArmed ? `\n🤖 已开启 auto-merge（必需检查通过后自动合并）。` : "",
      draft ? `\n🚧 这是**草稿 PR**（high 风险），需要 code owner 审查。` : "",
      ``,
      `任务：#${issueNumber} 「${issue.title}」`,
    ].join("\n");
    postComment(body);
    log(`PR created: ${pr.url}`);
    outcome = "pr";
  } catch (err) {
    const detail = redact(err instanceof Error ? (err.stack ?? err.message) : String(err));
    log("error:", detail);
    if (claimed) {
      try {
        postComment(
          `❌ **AI 流水线执行出错**\n\n\`\`\`\n${detail.slice(0, 4000)}\n\`\`\`\n\n${retryHint}`,
        );
      } catch {
        // commenting failed too; nothing more we can do
      }
      outcome = "failed";
    }
    process.exitCode = 1;
  } finally {
    // Always give the lock and credentials back, even on crash paths.
    git.restoreCredentials(workDir);
    if (locked) {
      try {
        platform.locks.release(ref);
      } catch (err) {
        log(`warning: failed to release claim lock: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (claimed && outcome) {
      try {
        finish(outcome);
      } catch (err) {
        log(`warning: failed to update labels: ${err instanceof Error ? err.message : err}`);
      }
    }
    try {
      const metrics = {
        repo,
        issue: issueNumber,
        kind,
        agent: agentName,
        provider,
        model,
        outcome: outcome ?? "failed",
        risk: risk?.level ?? "n/a",
        riskReasons: risk?.reasons ?? [],
        changedFiles,
        changedLines,
        verified: verifyResult?.verified ?? false,
        tampered: verifyResult?.tampered ?? false,
        skipped: verifyResult?.skipped ?? false,
        attempts,
        verifyCommand: verifyResult?.command ?? "",
        automerge: automergeArmed,
        ...(prNumber !== undefined ? { pr: prNumber } : {}),
        durationMs: Date.now() - startedAt,
      };
      writeMetrics(runDir, metrics);
      log("metrics", metricsLine(metrics));
    } catch (err) {
      log(`warning: failed to write metrics: ${err instanceof Error ? err.message : err}`);
    }
  }
}

main().catch((err) => {
  console.error("[runner] fatal:", err);
  process.exitCode = 1;
});

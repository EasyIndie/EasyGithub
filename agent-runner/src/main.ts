import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { selectAgent } from "./agents/registry.ts";
import type { AgentResult } from "./agents/types.ts";
import { ensureAgentCli } from "./cli.ts";
import { agentEnv, withheldSecretNames } from "./env.ts";
import * as git from "./git.ts";
import {
  acquireLock,
  addLabel,
  commentFromFile,
  createPr,
  getIssue,
  listLabels,
  releaseLock,
  removeLabel,
  type PrInfo,
} from "./github.ts";
import { auditStagedChanges, describeAudit, stageChanges } from "./policy.ts";
import { classifyTask, renderTaskMarkdown } from "./prompt.ts";
import { routeAgent } from "./router.ts";
import { captureVerifySpec, runVerify, type VerifyResult } from "./verify.ts";

const L = {
  trigger: "ai",
  running: "ai-running",
  pr: "ai-pr",
  failed: "ai-failed",
  done: "ai-done",
  /** the diff touches the runner / CI / installers -> human review required */
  core: "ai-core",
  /** the repository's check configuration changed while the agent was running */
  verifyChanged: "ai-verify-changed",
};

/** Labels that mean "this issue has already been handled"; used as a fast skip. */
const HANDLED = [L.running, L.pr, L.failed, L.done];

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

function verificationLine(result: VerifyResult | null, kind: string): string {
  if (kind === "review") return "🧐 Review 任务：不做代码改动，也不要求通过仓库检查";
  if (!result) return "⚠️ 未执行独立检查（时间预算耗尽）";
  if (result.skipped) return "⚠️ 仓库中没有可运行的检查命令，本次改动**未经独立验证**";
  if (result.tampered) return `⚠️ 检查配置在运行期间被修改，已用冻结版本复验：\`${result.command}\``;
  return `✅ 已通过独立检查：\`${result.command}\``;
}

async function main(): Promise<void> {
  const repo = requireEnv("GITHUB_REPOSITORY");
  const issueNumber = Number(requireEnv("ISSUE_NUMBER"));
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) throw new Error(`Bad ISSUE_NUMBER: ${process.env.ISSUE_NUMBER}`);

  const thinking = process.env.THINKING?.trim() || "high";
  const defaultBranch = process.env.DEFAULT_BRANCH ?? "main";
  const workDir = process.env.WORK_DIR ?? process.cwd();
  const runDir = join(process.env.RUNNER_TEMP ?? ".tmp/runner", `ai-issue-${issueNumber}`);
  mkdirSync(runDir, { recursive: true });

  // Time budget: the job timeout must cover attempts * (agent + verify) plus
  // install/push overhead. Every step below is clamped by the remaining budget
  // so a slow run reports "budget exhausted" instead of being killed mid-flight.
  const piTimeoutMs = intEnv("PI_TIMEOUT_MS", 15 * 60 * 1000, 60_000, 60 * 60 * 1000);
  const verifyTimeoutMs = intEnv("VERIFY_TIMEOUT_MS", 10 * 60 * 1000, 10_000, 60 * 60 * 1000);
  const budgetMs = intEnv("AGENT_BUDGET_MS", 75 * 60 * 1000, 60_000, 6 * 60 * 60 * 1000);
  const lockTtlMs = intEnv("LOCK_TTL_MS", 3 * 60 * 60 * 1000, 10 * 60 * 1000, 24 * 60 * 60 * 1000);
  const maxAttempts = intEnv("AI_MAX_ATTEMPTS", 3, 1, 5);
  const startedAt = Date.now();
  const remainingMs = () => budgetMs - (Date.now() - startedAt);

  const branch = `ai/issue-${issueNumber}`;
  log(`repo=${repo} issue=#${issueNumber} branch=${branch}`);
  log(
    `budget=${Math.round(budgetMs / 60000)}m agent≤${Math.round(piTimeoutMs / 60000)}m verify≤${Math.round(verifyTimeoutMs / 60000)}m attempts=${maxAttempts}`,
  );
  if (maxAttempts * (piTimeoutMs + verifyTimeoutMs) > budgetMs) {
    log("warning: AI_MAX_ATTEMPTS * (PI_TIMEOUT_MS + VERIFY_TIMEOUT_MS) exceeds AGENT_BUDGET_MS; later attempts may be skipped");
  }

  let claimed = false;
  let locked = false;
  let outcome: "pr" | "done" | "failed" | null = null;

  const finish = (result: "pr" | "done" | "failed") => {
    removeLabel(repo, issueNumber, L.running);
    if (result === "pr") addLabel(repo, issueNumber, L.pr);
    else if (result === "failed") addLabel(repo, issueNumber, L.failed);
    else addLabel(repo, issueNumber, L.done);
  };

  const postComment = (body: string, name = "comment.md") =>
    commentFromFile(repo, issueNumber, writeText(join(runDir, name), body));

  try {
    // --- claim: labels (fast) + atomic lock (authoritative) -------------------
    const labels = listLabels(repo, issueNumber);
    if (HANDLED.some((x) => labels.includes(x))) {
      log(`skip: issue already handled/in-flight (labels: ${labels.join(",")})`);
      return;
    }

    const lockState = acquireLock(repo, issueNumber, { defaultBranch, ttlMs: lockTtlMs });
    if (lockState === "busy") {
      log("skip: another run holds the claim lock");
      return;
    }
    locked = lockState === "acquired";
    if (lockState === "unavailable") {
      log("warning: claim lock API unavailable (permissions/ruleset); falling back to labels only");
    }

    addLabel(repo, issueNumber, L.running);
    removeLabel(repo, issueNumber, L.trigger);
    claimed = true;
    log(locked ? "claimed (lock + ai-running set, ai removed)" : "claimed (labels only, ai removed)");

    // --- context -------------------------------------------------------------
    const issue = getIssue(repo, issueNumber);
    const kind = classifyTask(issue);
    log(`issue: ${issue.title} | kind=${kind} | labels=${issue.labels.join(",") || "(none)"}`);

    // --- agent selection: env override > issue label agent:x > rules > default ---
    const explicitAgent = process.env.AGENT?.trim();
    const agentName = explicitAgent ? explicitAgent.toLowerCase() : await routeAgent({ labels: issue.labels, title: issue.title });
    const agent = selectAgent(agentName);
    const isPi = agentName === "pi";
    const provider = isPi ? (process.env.PROVIDER ?? "deepseek") : agentName;
    const model = isPi ? (process.env.MODEL?.trim() || "deepseek-v4-flash") : (process.env[`AI_${agentName.toUpperCase()}_MODEL`]?.trim() ?? "default");
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
    const verifySpec = await captureVerifySpec(workDir);
    log(`gate frozen: cmd="${verifySpec.command ?? "(none)"}" (${verifySpec.scriptBody ? "script body captured" : "no script body"})`);

    // --- remove push credentials for the agent phase --------------------------
    git.hideCredentials(workDir);
    log("git push credentials hidden from the agent");

    // --- agent attempts with independent verification -------------------------
    let agentResult: AgentResult | null = null;
    let verifyResult: VerifyResult | null = null;
    let lastVerify = "";
    let verifiedPass = kind === "review";

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const remaining = remainingMs();
      if (remaining <= 90_000) {
        log(`budget exhausted before attempt ${attempt} (${Math.round(remaining / 1000)}s left)`);
        break;
      }
      const attemptTimeout = Math.min(piTimeoutMs, Math.max(60_000, remaining - verifyTimeoutMs - 30_000));
      log(
        `--- attempt ${attempt}/${maxAttempts} (agent ≤${Math.round(attemptTimeout / 60000)}m, budget left ${Math.round(remaining / 60000)}m) ---`,
      );

      const bodyWithContext = attempt === 1 ? issue.body : issue.body + retryContext(lastVerify, attempt - 1);
      const taskMd = await renderTaskMarkdown(kind, meta, bodyWithContext);
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
        const body = `❌ **AI 处理失败（${agent.name} / ${model}，attempt ${attempt}/${maxAttempts}）**\n\n\`\`\`\n${detail.slice(0, 6000)}\n\`\`\`\n\n如需重试：移除 \`${L.failed}\` 标签后重新添加 \`${L.trigger}\` 标签。`;
        postComment(body);
        outcome = "failed";
        process.exitCode = 1;
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
          `请调大 \`AGENT_BUDGET_MS\` / \`PI_TIMEOUT_MS\`，或缩小 Issue 范围。移除 \`${L.failed}\` 标签后重新添加 \`${L.trigger}\` 可重试。`,
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
        `❌ **AI 处理后仍未通过仓库检查**（${agent.name} / ${model}，${reason}）\n\n\`\`\`\n${detail.slice(0, 6000)}\n\`\`\`\n\n如需重试：移除 \`${L.failed}\` 标签后重新添加 \`${L.trigger}\` 标签。`,
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
    const staged = stageChanges(workDir);
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
    const audit = auditStagedChanges(workDir);
    if (!audit.ok) {
      log(`policy violation: blocked=${audit.blocked.length} secrets=${audit.secrets.length}`);
      postComment(
        `❌ **AI 改动被流水线策略拒绝**（${agent.name} / ${model}）\n\n${redact(describeAudit(audit))}\n\n` +
          `分支 \`${branch}\` 未推送，未创建 PR。如需修改这些路径，请人工提交。`,
      );
      outcome = "failed";
      process.exitCode = 1;
      return;
    }
    if (audit.sensitive.length > 0) {
      addLabel(repo, issueNumber, L.core);
      log(`flagged ai-core (${audit.sensitive.length} sensitive path(s)): ${audit.sensitive.slice(0, 6).join(",")}`);
    }
    if (verifyResult?.tampered) {
      addLabel(repo, issueNumber, L.verifyChanged);
      log("flagged ai-verify-changed: the check configuration changed during the run");
    }

    const shortTitle = issue.title.slice(0, 60);
    const kindPrefix = kind === "feature" ? "feat" : "fix";
    const commitMessage = `${kindPrefix}: #${issueNumber} ${shortTitle}`;
    git.commitStaged(workDir, commitMessage);
    log(`committed: ${commitMessage}`);

    git.restoreCredentials(workDir);
    git.pushBranch(workDir, branch);
    log("pushed");

    const summary = redact(agentResult.summary || "(agent did not provide a summary; review the diff)");
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
      audit.sensitive.length > 0
        ? `⚠️ 本次改动涉及流水线/CI/安装器（\`ai-core\`），需要人工审查后合并。`
        : ``,
      ``,
      `_Auto-generated by EasyGithub AI pipeline (${agent.name} / ${provider} / ${model}). Review before merging._`,
    ]
      .filter((line, i, all) => !(line === `` && all[i + 1] === ``))
      .join("\n");
    const prBodyFile = writeText(join(runDir, "pr-body.md"), prBody);

    let pr: PrInfo;
    try {
      pr = createPr(repo, {
        base: defaultBranch,
        head: branch,
        title: `[AI] ${kindPrefix}: #${issueNumber} ${shortTitle}`.slice(0, 110),
        bodyFile: prBodyFile,
      });
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

    const body = `✅ **AI 完成并创建 PR**（${agent.name} / ${model}）：${pr.url}\n\n${verificationLine(verifyResult, kind)}\n\n任务：#${issueNumber} 「${issue.title}」`;
    postComment(body);
    log(`PR created: ${pr.url}`);
    outcome = "pr";
  } catch (err) {
    const detail = redact(err instanceof Error ? (err.stack ?? err.message) : String(err));
    log("error:", detail);
    if (claimed) {
      try {
        postComment(
          `❌ **AI 流水线执行出错**\n\n\`\`\`\n${detail.slice(0, 4000)}\n\`\`\`\n\n如需重试：移除 \`${L.failed}\` 标签后重新添加 \`${L.trigger}\` 标签。`,
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
        releaseLock(repo, issueNumber);
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
  }
}

main().catch((err) => {
  console.error("[runner] fatal:", err);
  process.exitCode = 1;
});

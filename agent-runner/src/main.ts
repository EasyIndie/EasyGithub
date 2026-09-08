import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { selectAgent } from "./agents/registry.ts";
import * as git from "./git.ts";
import { addLabel, commentFromFile, createPr, getIssue, listLabels, removeLabel, type PrInfo } from "./github.ts";
import { classifyTask, renderTaskMarkdown } from "./prompt.ts";

const L = {
  trigger: "ai",
  running: "ai-running",
  pr: "ai-pr",
  failed: "ai-failed",
  done: "ai-done",
};

const log = (...args: unknown[]) => console.log("[runner]", ...args);

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

function redact(text: string): string {
  let out = text;
  const patterns: Array<[RegExp, string]> = [
    [/sk-[A-Za-z0-9_\-]{12,}/g, "sk-[redacted]"],
    [/gh[pousr]_[A-Za-z0-9]{20,}/g, "gh[redacted]"],
    [/githu[b]_[A-Za-z0-9]{20,}/gi, "github[redacted]"],
  ];
  for (const [re, rep] of patterns) out = out.replace(re, rep);
  for (const name of ["DEEPSEEK_API_KEY", "GH_TOKEN", "GITHUB_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
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

async function main(): Promise<void> {
  const repo = requireEnv("GITHUB_REPOSITORY");
  const issueNumber = Number(requireEnv("ISSUE_NUMBER"));
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) throw new Error(`Bad ISSUE_NUMBER: ${process.env.ISSUE_NUMBER}`);

  const agentName = process.env.AGENT ?? "pi";
  const provider = process.env.PROVIDER ?? "deepseek";
  const model = process.env.MODEL ?? "deepseek-v4-pro";
  const thinking = process.env.THINKING?.trim();
  const timeoutMs = Number(process.env.PI_TIMEOUT_MS ?? 25 * 60 * 1000);
  const defaultBranch = process.env.DEFAULT_BRANCH ?? "main";
  const workDir = process.env.WORK_DIR ?? process.cwd();
  const runDir = join(process.env.RUNNER_TEMP ?? ".tmp/runner", `ai-issue-${issueNumber}`);
  mkdirSync(runDir, { recursive: true });

  const branch = `ai/issue-${issueNumber}`;
  const agent = selectAgent(agentName);
  const extraArgs = thinking ? ["--thinking", thinking] : [];

  log(`repo=${repo} issue=#${issueNumber} agent=${agent.name} provider=${provider} model=${model} branch=${branch}`);
  log(`runDir=${runDir} defaultBranch=${defaultBranch}`);

  // --- claim ---------------------------------------------------------------
  const labels = listLabels(repo, issueNumber);
  const handled = [L.running, L.pr, L.failed, L.done].some((x) => labels.includes(x));
  if (handled) {
    log(`skip: issue already handled/in-flight (labels: ${labels.join(",")})`);
    return;
  }
  addLabel(repo, issueNumber, L.running);
  removeLabel(repo, issueNumber, L.trigger);
  log("claimed (ai-running set, ai removed)");

  const finish = (outcome: "pr" | "done" | "failed") => {
    removeLabel(repo, issueNumber, L.running);
    if (outcome === "pr") addLabel(repo, issueNumber, L.pr);
    else if (outcome === "failed") addLabel(repo, issueNumber, L.failed);
    else addLabel(repo, issueNumber, L.done);
  };

  let failed = true;
  try {
    // --- context -------------------------------------------------------------
    const issue = getIssue(repo, issueNumber);
    const kind = classifyTask(issue);
    log(`issue: ${issue.title} | kind=${kind} | labels=${issue.labels.join(",") || "(none)"}`);

    const taskMd = await renderTaskMarkdown(kind, {
      repo,
      issueNumber,
      title: issue.title,
      url: issue.url,
      labels: issue.labels,
      branch,
      provider,
      model,
    }, issue.body);
    const taskFile = writeText(join(runDir, "TASK.md"), taskMd);
    const logFile = join(runDir, "pi.jsonl");

    // --- branch ----------------------------------------------------------------
    const head = git.currentBranch(workDir);
    if (head !== defaultBranch) log(`warning: current branch "${head}" != default "${defaultBranch}"`);
    git.deleteRemoteBranchIfExists(workDir, branch);
    git.createBranch(workDir, branch);
    git.setIdentity(workDir, "EasyGithub Agent", "41898282+github-actions[bot]@users.noreply.github.com");
    log(`branch ${branch} ready`);

    // --- run agent ---------------------------------------------------------------
    const agentResult = await agent.run({
      repo,
      issueNumber,
      workDir,
      taskFile,
      provider,
      model,
      extraArgs,
      logFile,
      timeoutMs,
      env: process.env,
    });
    log(`agent ok=${agentResult.ok} error=${agentResult.error ?? "(none)"}`);

    if (!agentResult.ok) {
      const detail = redact(`${agentResult.error ?? "agent failed"}\n\n--- last log lines ---\n${logTail(logFile)}`);
      const body = `❌ **AI 处理失败（${agent.name} / ${model}）**\n\n\`\`\`\n${detail.slice(0, 6000)}\n\`\`\`\n\n如需重试：移除 \`${L.failed}\` 标签后重新添加 \`${L.trigger}\` 标签。`;
      commentFromFile(repo, issueNumber, writeText(join(runDir, "comment.md"), body));
      finish("failed");
      process.exitCode = 1;
      return;
    }

    // --- verify & package ---------------------------------------------------------
    if (!git.hasChanges(workDir)) {
      log("no code changes produced");
      const summary = redact(agentResult.summary || "(no summary)");
      const body = `🤖 **AI 处理完成，但没有产生任何代码变更**（${agent.name} / ${model}）。\n\n${summary.slice(0, 3000)}`;
      commentFromFile(repo, issueNumber, writeText(join(runDir, "comment.md"), body));
      finish("done");
      failed = false;
      return;
    }

    const shortTitle = issue.title.slice(0, 60);
    const kindPrefix = kind === "feature" ? "feat" : kind === "review" ? "review" : "fix";
    const commitMessage = `${kindPrefix}: #${issueNumber} ${shortTitle}`;
    git.commitAll(workDir, commitMessage);
    log(`committed: ${commitMessage}`);

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
      `_Auto-generated by EasyGithub AI pipeline (${agent.name} / ${provider} / ${model}). Review before merging._`,
    ].join("\n");
    const prBodyFile = writeText(join(runDir, "pr-body.md"), prBody);

    let pr: PrInfo;
    try {
      pr = createPr(repo, { base: defaultBranch, head: branch, title: `[AI] ${kindPrefix}: #${issueNumber} ${shortTitle}`.slice(0, 110), bodyFile: prBodyFile });
    } catch (err) {
      // PR creation failed; report but don't crash the label flow.
      log(`PR creation failed: ${err instanceof Error ? err.message : err}`);
      const detail = redact(err instanceof Error ? err.message : String(err));
      const body = `⚠️ **代码已完成并推送，但自动创建 PR 失败**。分支：\`${branch}\`\n\n\`\`\`\n${detail.slice(0, 2000)}\n\`\`\`\n\n请手动创建 PR 或重试。`;
      commentFromFile(repo, issueNumber, writeText(join(runDir, "comment.md"), body));
      finish("failed");
      process.exitCode = 1;
      return;
    }

    const body = `✅ **AI 完成并创建了 PR**（${agent.name} / ${model}）：${pr.url}\n\n任务：#${issueNumber} 「${issue.title}」`;
    commentFromFile(repo, issueNumber, writeText(join(runDir, "comment.md"), body));
    log(`PR created: ${pr.url}`);
    finish("pr");
    failed = false;
  } catch (err) {
    const detail = redact(err instanceof Error ? err.stack ?? err.message : String(err));
    log("error:", detail);
    try {
      const body = `❌ **AI 流水线执行出错**\n\n\`\`\`\n${detail.slice(0, 4000)}\n\`\`\`\n\n如需重试：移除 \`${L.failed}\` 标签后重新添加 \`${L.trigger}\` 标签。`;
      commentFromFile(repo, issueNumber, writeText(join(runDir, "comment.md"), body));
    } catch {
      // commenting failed too; nothing more we can do
    }
    finish("failed");
    process.exitCode = 1;
  } finally {
    if (failed && process.exitCode !== 0) {
      log("pipeline failed");
    }
  }
}

main().catch((err) => {
  console.error("[runner] fatal:", err);
  process.exitCode = 1;
});

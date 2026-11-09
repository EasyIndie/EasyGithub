import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runSync } from "./util/exec.ts";

/**
 * Weekly retro: turn pipeline telemetry into a human-readable review.
 *
 * Reads Issue/PR metadata through `gh` (no artifact download, no DB) and
 * clusters the recurring failure signatures. The output is posted as a single
 * `retro` Issue — deliberately NOT labelled `ai`, because "is this worth
 * fixing?" is a human decision (H1).
 *
 * Usage: node agent-runner/src/retro.ts [--repo owner/name] [--days 7] [--create]
 */

interface IssueRow {
  number: number;
  title: string;
  url: string;
  updatedAt: string;
}

interface PrRow {
  number: number;
  title: string;
  url: string;
  mergedAt: string;
}

interface CommentRow {
  author?: { login?: string };
  body?: string;
  createdAt?: string;
}

function ghJson<T>(args: string[]): T | null {
  const res = runSync("gh", args);
  if (res.status !== 0) return null;
  try {
    return JSON.parse(res.stdout) as T;
  } catch {
    return null;
  }
}

function issues(repo: string, label: string): IssueRow[] {
  return ghJson<IssueRow[]>(["issue", "list", "-R", repo, "--label", label, "--state", "open", "--limit", "100", "--json", "number,title,url,updatedAt"]) ?? [];
}

function lastBotComment(repo: string, number: number): string {
  const data = ghJson<{ comments?: CommentRow[] }>(["issue", "view", String(number), "-R", repo, "--json", "comments"]);
  const comments = data?.comments ?? [];
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    if (!comment) continue;
    if ((comment.author?.login ?? "").endsWith("[bot]")) return comment.body ?? "";
  }
  return "";
}

/** Reduce a failure comment to a stable signature group. */
export function signatureOf(text: string): string {
  const command = /Command:\s*(.+)/.exec(text)?.[1]?.trim();
  if (command) return `check failed: ${command.slice(0, 60)}`;
  if (/Timed out|超时/i.test(text)) return "agent/check timeout";
  if (/budget|预算/i.test(text)) return "budget exhausted";
  if (/exit(ed)? with code|exited with code|agent failed|AI 处理失败/i.test(text)) return "agent crash";
  if (/Verification still failing|未通过仓库检查|仍未通过/i.test(text)) return "verification failed";
  if (/策略拒绝|policy/i.test(text)) return "policy rejection";
  if (/需要人工决策|NEEDS_INPUT/i.test(text)) return "needs human input";
  return "unclassified";
}

function mergedAiPrs(repo: string, days: number): PrRow[] {
  const list = ghJson<PrRow[]>(["pr", "list", "-R", repo, "--state", "merged", "--limit", "100", "--json", "number,title,url,mergedAt"]) ?? [];
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return list.filter((pr) => pr.title.startsWith("[AI]") && Number.isFinite(Date.parse(pr.mergedAt)) && Date.parse(pr.mergedAt) >= cutoff);
}

export function buildReport(args: {
  repo: string;
  days: number;
  failed: Array<{ issue: IssueRow; signature: string }>;
  blocked: IssueRow[];
  deferred: IssueRow[];
  merged: PrRow[];
}): string {
  const groups = new Map<string, Array<{ issue: IssueRow; signature: string }>>();
  for (const entry of args.failed) {
    const list = groups.get(entry.signature) ?? [];
    list.push(entry);
    groups.set(entry.signature, list);
  }
  const ranked = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);

  const lines: string[] = [
    `# AI 流水线周报（最近 ${args.days} 天）`,
    ``,
    `- 仓库：\`${args.repo}\``,
    `- 生成时间：${new Date().toISOString()}`,
    ``,
    `## 概览`,
    ``,
    `| 指标 | 数量 |`,
    `| --- | --- |`,
    `| 已合并的 AI PR | ${args.merged.length} |`,
    `| 失败运行（\`ai-failed\`） | ${args.failed.length} |`,
    `| 等待人工输入（\`ai-needs-input\`） | ${args.blocked.length} |`,
    `| 因配额延后（\`ai-deferred\`） | ${args.deferred.length} |`,
    ``,
    `## 失败签名聚类`,
    ``,
  ];

  if (ranked.length === 0) {
    lines.push("无失败运行。");
  } else {
    lines.push(`| 次数 | 签名 | 示例 |`, `| --- | --- | --- |`);
    for (const [signature, entries] of ranked) {
      const sample = entries[0]?.issue;
      lines.push(`| ${entries.length} | ${signature} | ${sample ? `#${sample.number}` : "-"} |`);
    }
    lines.push("", "### 明细", "");
    for (const [signature, entries] of ranked) {
      lines.push(`- **${signature}**`);
      for (const entry of entries.slice(0, 5)) lines.push(`  - #${entry.issue.number} ${entry.issue.title}`);
    }
  }

  if (args.blocked.length > 0) {
    lines.push("", "## 等待人工输入", "");
    for (const issue of args.blocked) lines.push(`- #${issue.number} ${issue.title}`);
  }
  if (args.deferred.length > 0) {
    lines.push("", "## 被配额延后（可重试）", "");
    for (const issue of args.deferred) lines.push(`- #${issue.number} ${issue.title}`);
  }

  lines.push(
    "",
    "## 建议动作",
    "",
    "- 如果同一签名重复出现 ≥ 3 次：把它变成 `docs/learnings.md` 的一条经验，或在 `eval/tasks/` 增加一个冻结任务。",
    "- 如果 `ai-needs-input` 堆积：检查 Issue 模板是否缺少验收标准。",
    "- 如果 `ai-failed` 多为 agent 崩溃/超时：考虑调大 `PI_TIMEOUT_MS` 或换更强的模型。",
    "",
    "_由 `node agent-runner/src/retro.ts --create` 自动生成；是否执行上面的建议由人决定（本 Issue 不带 `ai` 标签）。_",
  );
  return lines.join("\n");
}

function main(): void {
  const args = process.argv.slice(2);
  const flag = (name: string, fallback: string): string => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && args[index + 1] ? (args[index + 1] as string) : fallback;
  };
  const repo = flag("repo", process.env.GITHUB_REPOSITORY ?? "EasyIndie/EasyGithub");
  const days = Number(flag("days", "7"));
  const create = args.includes("--create");

  const failedIssues = issues(repo, "ai-failed");
  const failed = failedIssues.map((issue) => ({ issue, signature: signatureOf(lastBotComment(repo, issue.number)) }));
  const report = buildReport({
    repo,
    days: Number.isFinite(days) && days > 0 ? days : 7,
    failed,
    blocked: issues(repo, "ai-needs-input"),
    deferred: issues(repo, "ai-deferred"),
    merged: mergedAiPrs(repo, Number.isFinite(days) && days > 0 ? days : 7),
  });

  const dir = mkdtempSync(join(tmpdir(), "easygh-retro-"));
  const file = join(dir, "retro.md");
  writeFileSync(file, report);

  if (!create) {
    console.log(report);
    return;
  }

  const title = `retro: AI 流水线周报 ${new Date().toISOString().slice(0, 10)}`;
  const existing = ghJson<Array<{ title: string }>>(["issue", "list", "-R", repo, "--label", "retro", "--state", "open", "--limit", "20", "--json", "title"]);
  if ((existing ?? []).some((issue) => issue.title === title)) {
    console.log(`[retro] already open: ${title}`);
    return;
  }
  runSync("gh", ["label", "create", "retro", "-R", repo, "--color", "FBCA04", "--description", "AI 流水线周报"]);
  const created = runSync("gh", ["issue", "create", "-R", repo, "--title", title, "--body-file", file, "--label", "retro"]);
  if (created.status !== 0) {
    console.error(`[retro] create failed: ${created.stderr.trim()}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[retro] created: ${created.stdout.trim()}`);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();

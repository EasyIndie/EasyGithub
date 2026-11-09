import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runSync } from "./util/exec.ts";

/**
 * Weekly retro: turn pipeline telemetry into a human-readable review.
 *
 * Reads Issue/PR metadata through `gh` (no artifact download, no DB) and
 * clusters the recurring failure signatures. Covers the hub **and** the target
 * repositories listed in `EASYGH_RETRO_REPOS` (zero-file targets keep their
 * labels in their own repos, so a single-repo report would miss them).
 *
 * The output is posted as a single `retro` Issue — deliberately NOT labelled
 * `ai`, because "is this worth fixing?" is a human decision (H1).
 *
 * Usage: node agent-runner/src/retro.ts [--repos a/b,c/d] [--days 7] [--create]
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
}

export interface RepoFindings {
  repo: string;
  failed: Array<{ issue: IssueRow; signature: string }>;
  blocked: IssueRow[];
  deferred: IssueRow[];
  merged: PrRow[];
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
  return (
    ghJson<IssueRow[]>([
      "issue",
      "list",
      "-R",
      repo,
      "--label",
      label,
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "number,title,url,updatedAt",
    ]) ?? []
  );
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
  if (/exit(ed)? with code|agent failed|AI 处理失败/i.test(text)) return "agent crash";
  if (/Verification still failing|未通过仓库检查|仍未通过/i.test(text)) return "verification failed";
  if (/策略拒绝|policy/i.test(text)) return "policy rejection";
  if (/需要人工决策|NEEDS_INPUT/i.test(text)) return "needs human input";
  return "unclassified";
}

function mergedAiPrs(repo: string, days: number): PrRow[] {
  const list =
    ghJson<PrRow[]>([
      "pr",
      "list",
      "-R",
      repo,
      "--state",
      "merged",
      "--limit",
      "100",
      "--json",
      "number,title,url,mergedAt",
    ]) ?? [];
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return list.filter(
    (pr) => pr.title.startsWith("[AI]") && Number.isFinite(Date.parse(pr.mergedAt)) && Date.parse(pr.mergedAt) >= cutoff,
  );
}

/** Collect telemetry for one repository. Safe to call for repos with no activity. */
export function collect(repo: string, days: number): RepoFindings {
  const failed = issues(repo, "ai-failed").map((issue) => ({ issue, signature: signatureOf(lastBotComment(repo, issue.number)) }));
  return {
    repo,
    failed,
    blocked: issues(repo, "ai-needs-input"),
    deferred: issues(repo, "ai-deferred"),
    merged: mergedAiPrs(repo, days),
  };
}

export function buildReport(args: { days: number; repos: RepoFindings[] }): string {
  const totals = args.repos.reduce(
    (acc, repo) => ({
      merged: acc.merged + repo.merged.length,
      failed: acc.failed + repo.failed.length,
      blocked: acc.blocked + repo.blocked.length,
      deferred: acc.deferred + repo.deferred.length,
    }),
    { merged: 0, failed: 0, blocked: 0, deferred: 0 },
  );

  const lines: string[] = [
    `# AI 流水线周报（最近 ${args.days} 天）`,
    ``,
    `- 覆盖仓库：${args.repos.map((repo) => `\`${repo.repo}\``).join("、") || "(none)"}`,
    `- 生成时间：${new Date().toISOString()}`,
    ``,
    `## 概览`,
    ``,
    `| 指标 | 数量 |`,
    `| --- | --- |`,
    `| 已合并的 AI PR | ${totals.merged} |`,
    `| 失败运行（\`ai-failed\`） | ${totals.failed} |`,
    `| 等待人工输入（\`ai-needs-input\`） | ${totals.blocked} |`,
    `| 因配额延后（\`ai-deferred\`） | ${totals.deferred} |`,
    ``,
  ];

  if (args.repos.length === 0) {
    lines.push("没有可报告的仓库。");
    return lines.join("\n");
  }

  for (const repo of args.repos) {
    lines.push(`## ${repo.repo}`, ``);
    if (repo.failed.length === 0 && repo.blocked.length === 0 && repo.deferred.length === 0 && repo.merged.length === 0) {
      lines.push("无活动。", "");
      continue;
    }

    const groups = new Map<string, Array<{ issue: IssueRow; signature: string }>>();
    for (const entry of repo.failed) {
      const list = groups.get(entry.signature) ?? [];
      list.push(entry);
      groups.set(entry.signature, list);
    }
    const ranked = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);

    lines.push(`- 已合并 AI PR：${repo.merged.length}`);
    lines.push(`- 失败：${repo.failed.length}；等待输入：${repo.blocked.length}；延后：${repo.deferred.length}`, "");

    if (ranked.length > 0) {
      lines.push(`| 次数 | 签名 | 示例 |`, `| --- | --- | --- |`);
      for (const [signature, entries] of ranked) {
        const sample = entries[0]?.issue;
        lines.push(`| ${entries.length} | ${signature} | ${sample ? `#${sample.number}` : "-"} |`);
      }
      lines.push("");
      for (const [signature, entries] of ranked) {
        lines.push(`- **${signature}**`);
        for (const entry of entries.slice(0, 5)) lines.push(`  - #${entry.issue.number} ${entry.issue.title}`);
      }
      lines.push("");
    }

    if (repo.blocked.length > 0) {
      lines.push("等待人工输入：", "");
      for (const issue of repo.blocked) lines.push(`- #${issue.number} ${issue.title}`);
      lines.push("");
    }
    if (repo.deferred.length > 0) {
      lines.push("被配额延后（可重试）：", "");
      for (const issue of repo.deferred) lines.push(`- #${issue.number} ${issue.title}`);
      lines.push("");
    }
  }

  lines.push(
    `## 建议动作`,
    ``,
    `- 同一签名重复出现 ≥ 3 次：把它写进 \`docs/learnings.md\`，或在 \`eval/tasks/\` 增加一个冻结任务。`,
    `- \`ai-needs-input\` 堆积：检查 Issue 模板是否缺少验收标准。`,
    `- \`ai-failed\` 多为崩溃/超时：调大 \`PI_TIMEOUT_MS\` 或换更强模型。`,
    `- 出现被 revert 的 AI 合并：把 \`AI_AUTOMERGE\` 调回 \`probation\` 或 \`off\`。`,
    ``,
    `_由 \`node agent-runner/src/retro.ts --create\` 自动生成；是否执行上面的建议由人决定（本 Issue 不带 \`ai\` 标签）。_`,
  );
  return lines.join("\n");
}

function parseRepos(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((repo) => repo.trim())
    .filter(Boolean);
}

function main(): void {
  const args = process.argv.slice(2);
  const flag = (name: string, fallback: string): string => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && args[index + 1] ? (args[index + 1] as string) : fallback;
  };
  const current = process.env.GITHUB_REPOSITORY ?? "EasyIndie/EasyGithub";
  const explicit = flag("repos", process.env.EASYGH_RETRO_REPOS ?? "");
  const repos = parseRepos(explicit);
  const targets = repos.length > 0 ? repos : [current];
  const days = Number(flag("days", "7"));
  const window = Number.isFinite(days) && days > 0 ? days : 7;

  const findings = targets.map((repo) => collect(repo, window));
  const report = buildReport({ days: window, repos: findings });

  const dir = mkdtempSync(join(tmpdir(), "easygh-retro-"));
  const file = join(dir, "retro.md");
  writeFileSync(file, report);

  if (!args.includes("--create")) {
    console.log(report);
    return;
  }

  const title = `retro: AI 流水线周报 ${new Date().toISOString().slice(0, 10)}`;
  const existing = ghJson<Array<{ title: string }>>([
    "issue",
    "list",
    "-R",
    current,
    "--label",
    "retro",
    "--state",
    "open",
    "--limit",
    "20",
    "--json",
    "title",
  ]);
  if ((existing ?? []).some((issue) => issue.title === title)) {
    console.log(`[retro] already open: ${title}`);
    return;
  }
  runSync("gh", ["label", "create", "retro", "-R", current, "--color", "FBCA04", "--description", "AI 流水线周报"]);
  const created = runSync("gh", [
    "issue",
    "create",
    "-R",
    current,
    "--title",
    title,
    "--body-file",
    file,
    "--label",
    "retro",
  ]);
  if (created.status !== 0) {
    console.error(`[retro] create failed: ${created.stderr.trim()}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[retro] created: ${created.stdout.trim()}`);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();

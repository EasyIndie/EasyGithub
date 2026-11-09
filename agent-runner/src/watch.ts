import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runSync } from "./util/exec.ts";

/**
 * Post-merge watchdog for target repositories (zero-file / App mode).
 *
 * The hub cannot install files into the repositories it serves, so the
 * watchdog lives here and runs inside the dispatcher (which already holds an
 * installation token and knows the repository list).
 *
 * Trigger for an incident:
 *   1. the default branch head is a recently merged `[AI]` PR, AND
 *   2. a `push`-triggered workflow on that exact commit failed.
 *
 * Scheduled/security workflows are ignored on purpose (they attach to the head
 * commit but do not mean "the merge broke main").
 *
 * The incident issue doubles as the circuit breaker latch: main.ts refuses to
 * arm auto-merge while an open `ai-incident` exists in the repository.
 */

export interface RunRow {
  name: string;
  event: string;
  headSha: string;
  conclusion: string | null;
  url: string;
  createdAt: string;
}

export interface WatchResult {
  repo: string;
  action: "none" | "skipped" | "incident" | "reverted";
  detail: string;
}

const MAX_AGE_DAYS_DEFAULT = 7;
const INCIDENT_LABEL = "ai-incident";

function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** gh through bash: the dispatcher learned that a direct spawn breaks with app tokens. */
function gh(args: string[]): string | null {
  const res = runSync("bash", ["-c", `gh ${args.map(sq).join(" ")}`]);
  return res.status === 0 ? res.stdout : null;
}

function ghJson<T>(args: string[]): T | null {
  const out = gh(args);
  if (out === null) return null;
  try {
    return JSON.parse(out) as T;
  } catch {
    return null;
  }
}

/** An AI merge is recognised by the commit subject or the merged PR title. */
export function isAiMerge(subject: string, prTitles: string[]): boolean {
  const first = subject.split("\n")[0]?.trim() ?? "";
  return first.startsWith("[AI]") || prTitles.some((title) => title.startsWith("[AI]"));
}

/** `push`-triggered runs on exactly this commit that failed. */
export function failingPushRuns(runs: RunRow[], sha: string): RunRow[] {
  return runs.filter((run) => run.event === "push" && run.headSha === sha && run.conclusion === "failure");
}

interface CommitInfo {
  sha?: string;
  /** `/repos/{repo}/commits/{sha}` nests the git data here */
  commit?: { message?: string; committer?: { date?: string } };
}

function mapRuns(raw: {
  workflow_runs?: Array<{
    name?: string;
    event?: string;
    head_sha?: string;
    conclusion?: string | null;
    html_url?: string;
    created_at?: string;
  }>;
}): RunRow[] {
  return (raw.workflow_runs ?? []).map((run) => ({
    name: run.name ?? "",
    event: run.event ?? "",
    headSha: run.head_sha ?? "",
    conclusion: run.conclusion ?? null,
    url: run.html_url ?? "",
    createdAt: run.created_at ?? "",
  }));
}

/** Repositories of the App installation (optionally filtered). */
export function discoverRepos(filter: string[] | undefined): string[] {
  const data = ghJson<{ repositories?: Array<{ full_name?: string }> }>([
    "api",
    "/installation/repositories",
    "--jq",
    "{repositories: [.repositories[] | {full_name}]}",
  ]);
  const all = (data?.repositories ?? []).map((repo) => repo.full_name ?? "").filter(Boolean);
  return filter && filter.length > 0 ? all.filter((repo) => filter.includes(repo)) : all;
}

/** Cheap pre-check: only repositories that ever ran the pipeline need watching. */
function hasPipelineHistory(repo: string): boolean {
  return gh(["api", `repos/${repo}/labels/ai-pr`]) !== null;
}

function openIncidentFor(repo: string, sha: string): { number: number } | null {
  const list = ghJson<Array<{ number: number; body?: string }>>([
    "issue",
    "list",
    "-R",
    repo,
    "--label",
    INCIDENT_LABEL,
    "--state",
    "open",
    "--limit",
    "50",
    "--json",
    "number,body",
  ]);
  const short = sha.slice(0, 7);
  const hit = (list ?? []).find(
    (issue) => (issue.body ?? "").includes(`easygh-incident sha=${sha}`) || (issue.body ?? "").includes(short),
  );
  return hit ? { number: hit.number } : null;
}

function ensureIncidentLabel(repo: string): void {
  gh(["label", "create", INCIDENT_LABEL, "-R", repo, "--color", "B60205", "--description", "AI 合并后 main 失败"]);
}

function tokenUrl(repo: string): string {
  const token = process.env.GH_TOKEN ?? "";
  return `https://x-access-token:${token}@github.com/${repo}.git`;
}

/** Prepare a revert PR for `sha`; returns a human note describing the outcome. */
function prepareRevert(repo: string, sha: string, subject: string, defaultBranch: string): string {
  const workDir = mkdtempSync(join(tmpdir(), "easygh-revert-"));
  const branch = `ai/revert-${sha.slice(0, 7)}`;
  try {
    const clone = runSync("git", ["clone", "--quiet", "--single-branch", tokenUrl(repo), workDir], {
      env: { GIT_TERMINAL_PROMPT: "0" },
    });
    if (clone.status !== 0) return `revert 失败（clone 失败）：${clone.stderr.trim().slice(0, 200)}`;

    const checkout = runSync("git", ["checkout", "--quiet", "-B", branch, `origin/${defaultBranch}`], { cwd: workDir });
    if (checkout.status !== 0) return `revert 失败（checkout ${defaultBranch} 失败）`;

    const revert = runSync("git", ["-c", "user.name=EasyGithub Watchdog", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com", "revert", "--no-edit", sha], {
      cwd: workDir,
    });
    if (revert.status !== 0) {
      runSync("git", ["revert", "--abort"], { cwd: workDir });
      return `revert 冲突（${sha.slice(0, 7)}），请人工回滚。`;
    }
    const push = runSync("git", ["push", "--quiet", "-u", "origin", branch], { cwd: workDir });
    if (push.status !== 0) return `revert 分支推送失败：${push.stderr.trim().slice(0, 200)}`;

    const body = `自动回滚 ${sha.slice(0, 7)}（main CI 失败）。由 EasyGithub ai-watchdog 生成。`;
    const created = runSync("bash", [
      "-c",
      `gh pr create -R ${sq(repo)} --base ${sq(defaultBranch)} --head ${sq(branch)} --title ${sq(`Revert ${subject}`)} --body ${sq(body)}`,
    ]);
    if (created.status === 0) return `已创建 revert PR：${created.stdout.trim()}`;
    if (/already exists/i.test(created.stderr)) return `revert PR 已存在（${branch}）。`;
    return `revert PR 创建失败：${created.stderr.trim().slice(0, 200)}`;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function openIncident(repo: string, sha: string, subject: string, runs: RunRow[], defaultBranch: string): string {
  ensureIncidentLabel(repo);
  const revertNote = prepareRevert(repo, sha, subject, defaultBranch);
  const body = [
    `<!-- easygh-incident sha=${sha} -->`,
    ``,
    `## main CI 失败，且失败提交来自 AI 合并`,
    ``,
    `- commit: \`${sha}\``,
    `- subject: \`${subject}\``,
    ...runs.map((run) => `- 失败运行：${run.name} → ${run.url}`),
    ``,
    `流水线已自动准备回滚（人工只需合并）：${revertNote}`,
    ``,
    `> 熔断：本 Issue 打开期间，该仓库不会自动合并 AI PR（关闭本 Issue 即恢复）。`,
  ].join("\n");

  const dir = mkdtempSync(join(tmpdir(), "easygh-incident-"));
  const file = join(dir, "incident.md");
  writeFileSync(file, body, "utf8");
  const created = runSync("bash", [
    "-c",
    `gh issue create -R ${sq(repo)} --title ${sq(`incident: AI 合并导致 main 失败 (${sha.slice(0, 7)})`)} --body-file ${sq(file)} --label ${INCIDENT_LABEL}`,
  ]);
  rmSync(dir, { recursive: true, force: true });
  return created.status === 0 ? created.stdout.trim() : `incident 创建失败：${created.stderr.trim().slice(0, 300)}`;
}

/** Detect recent human reverts of AI merges (a trust signal, not an outage). */
function detectReverts(repo: string): string[] {
  const prs = ghJson<Array<{ number: number; title: string; mergedAt?: string }>>([
    "pr",
    "list",
    "-R",
    repo,
    "--state",
    "merged",
    "--limit",
    "30",
    "--json",
    "number,title,mergedAt",
  ]);
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return (prs ?? [])
    .filter((pr) => pr.title.startsWith('Revert "[AI]') && Number.isFinite(Date.parse(pr.mergedAt ?? "")) && Date.parse(pr.mergedAt ?? "") >= cutoff)
    .map((pr) => `#${pr.number} ${pr.title}`);
}

export function watchRepo(repo: string, opts: { maxAgeDays?: number; dryRun?: boolean } = {}): WatchResult {
  if (!hasPipelineHistory(repo)) return { repo, action: "skipped", detail: "no ai-pr label (pipeline never used here)" };

  const info = ghJson<{ default_branch?: string }>(["api", `repos/${repo}`]);
  const defaultBranch = info?.default_branch ?? "main";

  const ref = ghJson<{ object?: { sha?: string } }>(["api", `repos/${repo}/git/ref/heads/${defaultBranch}`]);
  const sha = ref?.object?.sha;
  if (!sha) return { repo, action: "skipped", detail: `cannot read ${defaultBranch} head` };

  const commit = ghJson<CommitInfo>(["api", `repos/${repo}/commits/${sha}`]);
  const subject = (commit?.commit?.message ?? "").split("\n")[0]?.trim() ?? "";
  const date = Date.parse(commit?.commit?.committer?.date ?? "");
  const maxAgeMs = (opts.maxAgeDays ?? MAX_AGE_DAYS_DEFAULT) * 24 * 60 * 60 * 1000;
  if (Number.isFinite(date) && Date.now() - date > maxAgeMs) {
    return { repo, action: "skipped", detail: `head ${sha.slice(0, 7)} is older than ${opts.maxAgeDays ?? MAX_AGE_DAYS_DEFAULT}d` };
  }

  const associated = ghJson<Array<{ title?: string; merged_at?: string | null }>>([
    "api",
    `repos/${repo}/commits/${sha}/pulls`,
  ]);
  const prTitles = (associated ?? []).filter((pr) => pr.merged_at !== null).map((pr) => pr.title ?? "");
  if (!isAiMerge(subject, prTitles)) return { repo, action: "none", detail: `head ${sha.slice(0, 7)} is not an AI merge` };

  const runsRaw = ghJson<Parameters<typeof mapRuns>[0]>(["api", `repos/${repo}/actions/runs?branch=${defaultBranch}&per_page=30`]);
  const failing = failingPushRuns(mapRuns(runsRaw ?? {}), sha);
  if (failing.length === 0) {
    const reverts = detectReverts(repo);
    return {
      repo,
      action: "none",
      detail: reverts.length > 0 ? `main healthy; recent AI reverts: ${reverts.join(", ")}` : "main healthy",
    };
  }

  if (openIncidentFor(repo, sha)) return { repo, action: "skipped", detail: `incident already open for ${sha.slice(0, 7)}` };
  if (opts.dryRun) {
    return { repo, action: "none", detail: `dry-run: would open incident for ${sha.slice(0, 7)} (${failing.map((r) => r.name).join(", ")})` };
  }

  const created = openIncident(repo, sha, subject, failing, defaultBranch);
  return { repo, action: "incident", detail: created };
}

/** Run the watchdog across the installation (or a filtered subset). */
export function runWatchdog(opts: { filter?: string[]; maxRepos?: number; maxAgeDays?: number } = {}): WatchResult[] {
  const repos = discoverRepos(opts.filter);
  const limit = opts.maxRepos ?? repos.length;
  const results: WatchResult[] = [];
  for (const repo of repos.slice(0, limit)) {
    try {
      results.push(watchRepo(repo, { maxAgeDays: opts.maxAgeDays }));
    } catch (err) {
      results.push({ repo, action: "skipped", detail: err instanceof Error ? err.message.slice(0, 300) : String(err) });
    }
  }
  return results;
}

/**
 * CLI used by the hub's own ai-watch workflow:
 *   node agent-runner/src/watch.ts --repo owner/name [--max-age-days 7] [--dry-run]
 *
 * Logs go to stderr; the last stdout line is a single JSON object so a shell
 * step can read `action` without parsing prose.
 */
function cli(): void {
  const args = process.argv.slice(2);
  const flag = (name: string, fallback: string): string => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && args[index + 1] ? (args[index + 1] as string) : fallback;
  };
  const repo = flag("repo", process.env.GITHUB_REPOSITORY ?? "");
  if (!repo) {
    console.error("[watch] --repo owner/name is required");
    process.exitCode = 1;
    return;
  }
  const maxAgeDays = Number(flag("max-age-days", "7"));
  const result = watchRepo(repo, {
    maxAgeDays: Number.isFinite(maxAgeDays) && maxAgeDays > 0 ? maxAgeDays : 7,
    dryRun: args.includes("--dry-run"),
  });
  console.error(`[watch] ${result.repo}: ${result.action} — ${result.detail}`);
  console.log(JSON.stringify(result));
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) cli();

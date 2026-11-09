import { runSync } from "./util/exec.ts";

export interface IssueInfo {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
}

export interface PrInfo {
  number: number;
  url: string;
}

function gh(args: string[], opts: { input?: string; cwd?: string } = {}) {
  const res = runSync("gh", args, { input: opts.input, cwd: opts.cwd });
  if (res.status !== 0) {
    throw new Error(`gh ${args.slice(0, 3).join(" ")}... failed (${res.status}): ${res.stderr.trim()}`);
  }
  return res.stdout;
}

export function getIssue(repo: string, number: number): IssueInfo {
  const out = gh([
    "issue",
    "view",
    String(number),
    "-R",
    repo,
    "--json",
    "number,title,body,url,labels",
    "--jq",
    "{number,title,body,url,labels:[.labels[].name]}",
  ]);
  const data = JSON.parse(out) as Partial<IssueInfo>;
  return {
    number: data.number ?? number,
    title: data.title ?? "",
    body: data.body ?? "",
    url: data.url ?? "",
    labels: Array.isArray(data.labels) ? data.labels : [],
  };
}

export function listLabels(repo: string, number: number): string[] {
  const out = gh(["issue", "view", String(number), "-R", repo, "--json", "labels", "--jq", "[.labels[].name]"]);
  const labels = JSON.parse(out) as unknown;
  return Array.isArray(labels) ? (labels as string[]) : [];
}

export function addLabel(repo: string, number: number, label: string): void {
  try {
    gh(["issue", "edit", String(number), "-R", repo, "--add-label", label]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Zero-config repos may not have the label yet — create it on the fly.
    if (/not found|could not find/i.test(msg)) {
      ensureLabel(repo, label);
      gh(["issue", "edit", String(number), "-R", repo, "--add-label", label]);
    } else {
      throw err;
    }
  }
}

const LABEL_COLORS: Record<string, string> = {
  ai: "1F6FEB",
  "ai-running": "DB61A2",
  "ai-pr": "8250DF",
  "ai-failed": "B60205",
  "ai-done": "0E8A16",
  feature: "C5DEF5",
  bug: "D73A4A",
  documentation: "0075CA",
  "agent:pi": "1F6FEB",
  "agent:claude": "5319E7",
  "agent:codex": "BFD4F2",
  "ai-core": "5319E7",
  "ai-verify-changed": "FBCA04",
  "ai-needs-input": "D876E3",
  "ai-deferred": "EDEDED",
  "ai-automerge": "2CBE4E",
  "ai-incident": "B60205",
  retro: "FBCA04",
};

/** Create a label if it does not exist (used for zero-config repositories). */
export function ensureLabel(repo: string, label: string): void {
  const color = LABEL_COLORS[label] ?? "EDEDED";
  const res = runSync("gh", ["api", `repos/${repo}/labels`, "-X", "POST", "-f", `name=${label}`, "-f", `color=${color}`, "-f", "description=EasyGithub AI pipeline label"]);
  if (res.status !== 0 && !/already exists/i.test(res.stderr)) {
    throw new Error(`create label ${label} failed: ${res.stderr.trim().slice(0, 300)}`);
  }
}

export function removeLabel(repo: string, number: number, label: string): void {
  // Removing a label that does not exist is not an error worth failing on.
  const res = runSync("gh", ["issue", "edit", String(number), "-R", repo, "--remove-label", label]);
  if (res.status !== 0) {
    // label may already be gone
    if (!/could not be found|could not remove|not exist|not found/i.test(res.stderr)) {
      throw new Error(`remove-label ${label} failed: ${res.stderr.trim()}`);
    }
  }
}

export function commentFromFile(repo: string, number: number, bodyFile: string): void {
  gh(["issue", "comment", String(number), "-R", repo, "--body-file", bodyFile]);
}

export function createPr(
  repo: string,
  opts: { base: string; head: string; title: string; bodyFile: string; draft?: boolean },
): PrInfo {
  // PR creation may be blocked for the automatic GITHUB_TOKEN by an org policy
  // ("Allow GitHub Actions to create and approve pull requests"). A personal
  // token (EASYGH_PR_TOKEN) is not subject to that restriction; use it when set.
  const env = { ...process.env };
  if (process.env.EASYGH_PR_TOKEN) env.GH_TOKEN = process.env.EASYGH_PR_TOKEN;
  const res = runSync(
    "gh",
    [
      "pr",
      "create",
      "-R",
      repo,
      "--base",
      opts.base,
      "--head",
      opts.head,
      "--title",
      opts.title,
      "--body-file",
      opts.bodyFile,
      ...(opts.draft ? ["--draft"] : []),
    ],
    { env },
  );
  if (res.status === 0) {
    const m = /pull\/(\d+)/.exec(res.stdout);
    if (m?.[1]) {
      return { number: Number(m[1]), url: `https://github.com/${repo}/pull/${m[1]}` };
    }
  }
  // Fallback: PR may already exist for this head branch.
  const listRes = runSync("gh", ["pr", "list", "-R", repo, "--head", opts.head, "--state", "open", "--json", "number,url", "--jq", ".[0]"], { env });
  const list = listRes.status === 0 ? listRes.stdout : "";
  const found = list.trim() ? (JSON.parse(list) as PrInfo | null) : null;
  if (found?.number) return found;
  throw new Error(`Failed to create PR for ${opts.head}: ${res.stderr.trim()}`);
}

// --- delivery helpers -----------------------------------------------------

const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export interface HumanComment {
  author: string;
  association: string;
  body: string;
  createdAt: string;
}

/**
 * Human comments on the issue, newest last.
 *
 * Used as the "answer the agent's question" channel (H2): the runner replays
 * them into TASK.md on the next attempt. Only trusted authors are included —
 * comments are untrusted input just like the issue body.
 */
export function recentHumanComments(repo: string, number: number, limit = 3): HumanComment[] {
  let data: { comments?: Array<{ author?: { login?: string }; authorAssociation?: string; body?: string; createdAt?: string }> };
  try {
    data = JSON.parse(gh(["issue", "view", String(number), "-R", repo, "--json", "comments"])) as typeof data;
  } catch {
    return [];
  }
  const out: HumanComment[] = [];
  for (const comment of data.comments ?? []) {
    const login = comment.author?.login ?? "";
    const association = comment.authorAssociation ?? "NONE";
    const body = (comment.body ?? "").trim();
    if (!body) continue;
    if (!TRUSTED_ASSOCIATIONS.has(association)) continue;
    if (login.endsWith("[bot]") || login === "github-actions") continue;
    if (body.includes("easygh-decision")) continue; // pipeline audit trail
    out.push({ author: login, association, body: body.slice(0, 2000), createdAt: comment.createdAt ?? "" });
  }
  return out.slice(-limit);
}

/** Arm auto-merge on a PR (the repository must allow auto-merge). */
export function mergePrAuto(repo: string, prNumber: number): { ok: boolean; detail: string } {
  const res = runSync("gh", [
    "pr",
    "merge",
    String(prNumber),
    "-R",
    repo,
    "--auto",
    "--squash",
    "--delete-branch",
  ]);
  return { ok: res.status === 0, detail: (res.stderr || res.stdout).trim().slice(0, 500) };
}

/** Count `[AI]` pull requests opened in the last `hours` (cost/queue cap). */
export function countRecentAiPrs(repo: string, hours: number): number {
  let list: Array<{ title?: string; createdAt?: string }>;
  try {
    list = JSON.parse(gh(["pr", "list", "-R", repo, "--state", "all", "--limit", "100", "--json", "title,createdAt"])) as typeof list;
  } catch {
    return 0;
  }
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return list.filter((pr) => {
    if (!(pr.title ?? "").startsWith("[AI]")) return false;
    const ts = Date.parse(pr.createdAt ?? "");
    return Number.isFinite(ts) && ts >= cutoff;
  }).length;
}

/** True while an unresolved AI incident latches the repo (auto-merge breaker). */
export function hasOpenIncident(repo: string): boolean {
  const res = runSync("gh", [
    "issue",
    "list",
    "-R",
    repo,
    "--label",
    "ai-incident",
    "--state",
    "open",
    "--limit",
    "1",
    "--json",
    "number",
  ]);
  if (res.status !== 0) return false;
  return res.stdout.trim() !== "[]";
}

// --- claim lock -----------------------------------------------------------
//
// Labels are not a compare-and-swap primitive: two triggers (the `labeled`
// workflow and the App dispatcher) can both observe `ai` and start a run,
// double-spending tokens, and a crashed run leaves `ai-running` stuck forever.
//
// We use a tag ref as an atomic server-side lock: creating `refs/tags/ai-lock-
// issue-N` succeeds exactly once (409/422 otherwise). The tag object carries a
// timestamp so a dead run's lock can be reclaimed after a TTL. Repositories
// where ref creation is blocked fall back to label-only behaviour.

const LOCK_TAG = (issue: number) => `ai-lock-issue-${issue}`;

export type LockState = "acquired" | "busy" | "unavailable";

function ghJson<T>(args: string[], input?: string): T | null {
  const res = runSync("gh", args, { input });
  if (res.status !== 0) return null;
  try {
    return JSON.parse(res.stdout) as T;
  } catch {
    return null;
  }
}

/** Age of a lock tag object in ms, or null when it cannot be determined. */
function lockAgeMs(repo: string, tagSha: string): number | null {
  const obj = ghJson<{ tagger?: { date?: string } }>(["api", `repos/${repo}/git/tags/${tagSha}`]);
  const date = obj?.tagger?.date;
  if (!date) return null;
  const ts = Date.parse(date);
  return Number.isFinite(ts) ? Math.max(0, Date.now() - ts) : null;
}

/**
 * Try to claim exclusive ownership of an issue run.
 *
 * `busy`      -> another live run owns it; skip.
 * `acquired`  -> this process owns it; release with releaseLock().
 * `unavailable` -> lock API not usable (permissions/ruleset); caller falls back
 *                  to the legacy label check. Never blocks the pipeline.
 */
export function acquireLock(
  repo: string,
  issue: number,
  opts: { defaultBranch: string; ttlMs: number },
): LockState {
  const tag = LOCK_TAG(issue);
  const existing = ghJson<{ object?: { sha?: string } }>(["api", `repos/${repo}/git/ref/tags/${tag}`]);
  const existingSha = existing?.object?.sha;
  if (existingSha) {
    const age = lockAgeMs(repo, existingSha);
    if (age === null || age < opts.ttlMs) return "busy";
    // Stale (crashed run): reclaim below.
    runSync("gh", ["api", "-X", "DELETE", `repos/${repo}/git/refs/tags/${tag}`]);
  }

  const head = ghJson<{ object?: { sha?: string } }>([
    "api",
    `repos/${repo}/git/ref/heads/${opts.defaultBranch}`,
  ]);
  const headSha = head?.object?.sha;
  if (!headSha) return "unavailable";

  const tagObject = ghJson<{ sha?: string }>(
    ["api", `repos/${repo}/git/tags`, "-X", "POST", "--input", "-"],
    JSON.stringify({
      tag,
      message: "EasyGithub pipeline lock (removed automatically)",
      object: headSha,
      type: "commit",
      tagger: {
        name: "EasyGithub Agent",
        email: "41898282+github-actions[bot]@users.noreply.github.com",
        date: new Date().toISOString(),
      },
    }),
  );
  if (!tagObject?.sha) return "unavailable";

  const created = runSync(
    "gh",
    ["api", `repos/${repo}/git/refs`, "-X", "POST", "--input", "-"],
    { input: JSON.stringify({ ref: `refs/tags/${tag}`, sha: tagObject.sha }) },
  );
  if (created.status === 0) return "acquired";
  if (/already exists|already_exists|422/i.test(`${created.stderr}${created.stdout}`)) return "busy";
  return "unavailable";
}

/** Release a lock acquired by acquireLock (safe to call unconditionally). */
export function releaseLock(repo: string, issue: number): void {
  runSync("gh", ["api", "-X", "DELETE", `repos/${repo}/git/refs/tags/${LOCK_TAG(issue)}`]);
}


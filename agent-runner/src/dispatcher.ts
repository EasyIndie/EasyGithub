import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runAsync, runSync } from "./util/exec.ts";
import { listInstallationRepos, runWatchdog } from "./watch.ts";

/**
 * Central dispatcher for the GitHub-App (zero-file) cross-repo mode.
 *
 * Runs on a schedule in the hub repository (EasyGithub) with a GitHub App
 * installation token. It finds open Issues tagged for AI work across the org,
 * then runs the standard single-issue Agent Runner (agent-runner/src/main.ts)
 * against each repository — cloning, editing, verifying and opening a PR with
 * the app token. Target repositories contain no pipeline files at all.
 *
 * Triggers (union):
 *   - Issue has label `ai`
 *   - Issue title or body contains the marker `easygh-ai` (trusted authors only)
 */
const HANDLED = ["ai-running", "ai-pr", "ai-failed", "ai-done"];

/**
 * Per-repo verification for zero-file (App mode) targets.
 *
 * Sources (env wins over file):
 *   1. hub repo variable `EASYGH_VERIFY_CMDS` — JSON map (ops override)
 *   2. `agent-runner/config/verify.json` — committed, reviewable default
 * Both accept either a string ({ "Org/repo": "cargo test" }) or an object
 * ({ "Org/repo": { "cmd": "cargo test", "timeout_ms": 900000 } }).
 * Targets keep no pipeline files at all.
 */
export interface VerifyConfig {
  cmd?: string;
  timeoutMs?: number;
}

let cachedVerifyMap: Record<string, unknown> | undefined;

function verifyMap(): Record<string, unknown> {
  if (cachedVerifyMap) return cachedVerifyMap;
  let map: Record<string, unknown> = {};
  try {
    const fileUrl = new URL("../config/verify.json", import.meta.url);
    const parsed = JSON.parse(readFileSync(fileUrl, "utf8")) as unknown;
    if (parsed && typeof parsed === "object") map = parsed as Record<string, unknown>;
  } catch {
    // no config file -> fine
  }
  const raw = process.env.EASYGH_VERIFY_CMDS?.trim();
  if (raw) {
    try {
      const envMap = JSON.parse(raw) as unknown;
      if (envMap && typeof envMap === "object") map = { ...map, ...(envMap as Record<string, unknown>) };
    } catch {
      console.log("[dispatch] EASYGH_VERIFY_CMDS is not valid JSON; ignoring");
    }
  }
  cachedVerifyMap = map;
  return map;
}

export function verifyFor(repo: string): VerifyConfig {
  const value = verifyMap()[repo];
  if (typeof value === "string" && value.trim()) return { cmd: value };
  if (value && typeof value === "object") {
    const obj = value as { cmd?: unknown; timeout_ms?: unknown };
    const cmd = typeof obj.cmd === "string" && obj.cmd.trim() ? obj.cmd : undefined;
    const timeoutMs = typeof obj.timeout_ms === "number" && obj.timeout_ms > 0 ? obj.timeout_ms : undefined;
    return { cmd, timeoutMs };
  }
  return {};
}

interface Candidate {
  repo: string; // owner/name
  number: number;
}

/**
 * Issue authors allowed to trigger a run by writing the `easygh-ai` marker.
 * Anything else (drive-by issues on public repos, external contributors) is
 * ignored: the agent executes untrusted text with a write-capable token.
 * The `ai` label stays trusted because applying a label requires triage access.
 */
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isInteger(raw)) return fallback;
  return Math.min(max, Math.max(min, raw));
}

function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function gh(args: string[]): string {
  // NOTE: gh spawned directly from node misbehaves on the Actions runner with
  // app tokens (HTTP 404); invoking it through bash matches the verified path.
  const cmd = args.map(sq).join(" ");
  const res = runSync("bash", ["-c", `gh ${cmd}`]);
  if (res.status !== 0) throw new Error(`gh ${args[0] ?? ""} failed: ${res.stderr.trim().slice(0, 600)}`);
  return res.stdout;
}

function ghLines(args: string[]): string[] {
  return gh(args).split("\n").map((s) => s.trim()).filter(Boolean);
}

function searchCandidates(): Candidate[] {
  // GitHub App installation tokens CANNOT use the Search API (404), so we
  // discover via the installation's repositories + per-repo open issues.
  const set = new Map<string, Candidate>();
  const maxRepos = intEnv("MAX_REPOS", 40, 1, 200);
  let repos: string[] = [];
  try {
    // Paginated: /installation/repositories returns 30 per page and app tokens
    // cannot use `gh --paginate`.
    repos = listInstallationRepos();
    if (repos.length === 0) {
      console.log("[dispatch] installation repos returned nothing");
      return [...set.values()];
    }
  } catch (e) {
    console.log(`[dispatch] installation repos failed: ${e instanceof Error ? e.message : e}`);
    return [...set.values()];
  }
  const filter = process.env.REPO_FILTER?.split(",").map((s) => s.trim()).filter(Boolean);
  if (filter?.length) repos = repos.filter((r) => filter.includes(r));
  repos = repos.slice(0, maxRepos);
  console.log(`[dispatch] accessible repos: ${repos.length}`);

  for (const repo of repos) {
    let items: Array<{ n: number; t: string; b: string; l: string[]; a: string }> = [];
    try {
      const raw = gh(["api", `repos/${repo}/issues?state=open&per_page=100`, "--jq", "[.[] | select(.pull_request == null) | {n:.number,t:(.title // \"\"),b:(.body // \"\"),l:[.labels[].name],a:(.author_association // \"\")}]"]);
      items = JSON.parse(raw) as typeof items;
    } catch (e) {
      console.log(`[dispatch] issues list failed for ${repo}: ${e instanceof Error ? e.message.slice(0, 200) : e}`);
      continue;
    }
    let matched = 0;
    for (const it of items) {
      const labelHit = it.l.includes("ai");
      const markerHit = it.t.includes("easygh-ai") || it.b.includes("easygh-ai");
      if (markerHit && !TRUSTED_ASSOCIATIONS.has(it.a)) {
        console.log(`[dispatch] ${repo} #${it.n}: ignoring marker from ${it.a || "unknown"} author`);
      }
      if (labelHit || (markerHit && TRUSTED_ASSOCIATIONS.has(it.a))) {
        set.set(`${repo}#${it.n}`, { repo, number: it.n });
        matched++;
      }
    }
    console.log(`[dispatch] ${repo}: ${items.length} open issues, ${matched} matched`);
  }

  return [...set.values()];
}

function candidates(): Candidate[] {
  const set = new Map<string, Candidate>();
  const add = (list: Candidate[]) => list.forEach((c) => set.set(`${c.repo}#${c.number}`, c));
  add(searchCandidates());
  return [...set.values()];
}

function isHandled(repo: string, number: number): boolean {
  try {
    const labels = JSON.parse(gh(["issue", "view", String(number), "-R", repo, "--json", "labels", "--jq", "[.labels[].name]"])) as string[];
    if (labels.some((l) => HANDLED.includes(l))) return true;
  } catch {
    return true; // issue gone / inaccessible -> treat as handled
  }
  const prs = gh(["pr", "list", "-R", repo, "--head", `ai/issue-${number}`, "--state", "open", "--json", "number", "--jq", "length"]).trim();
  return Number(prs) > 0;
}

async function processIssue(c: Candidate, budgetLeftMs: number): Promise<void> {
  const runnerMain = new URL("./main.ts", import.meta.url).pathname;
  const tmpBase = join(process.env.RUNNER_TEMP ?? tmpdir(), "ghapp-dispatch");
  mkdirSync(tmpBase, { recursive: true });
  const workDir = join(tmpBase, `${c.repo.replace("/", "-")}-issue-${c.number}`);
  rmSync(workDir, { recursive: true, force: true });

  const token = process.env.GH_TOKEN ?? "";
  console.log(`\n[dispatch] === ${c.repo} #${c.number} ===`);

  const cloneUrl = `https://x-access-token:${token}@github.com/${c.repo}.git`;
  const clone = runSync("git", ["clone", "--quiet", "--single-branch", cloneUrl, workDir], { env: { GIT_TERMINAL_PROMPT: "0" } });
  if (clone.status !== 0) {
    console.log(`[dispatch] clone failed: ${clone.stderr.trim().slice(0, 500)}`);
    return;
  }

  let defaultBranch = "main";
  try {
    defaultBranch = JSON.parse(gh(["repo", "view", c.repo, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"])).toString();
  } catch {
    // keep main
  }

  const runDir = join(tmpBase, `logs-${c.repo.replace("/", "-")}-${c.number}`);
  // Per-issue wall clock: the agent session plus its verification retries must
  // fit inside the dispatcher's own deadline, otherwise the parent kills the
  // child mid-push and leaves the target issue stuck.
  const piTimeoutMs = intEnv("PI_TIMEOUT_MS", 15 * 60 * 1000, 60_000, 60 * 60 * 1000);
  const childBudgetMs = intEnv("AGENT_BUDGET_MS", 75 * 60 * 1000, 120_000, 3 * 60 * 60 * 1000);
  const timeoutMs = Math.max(120_000, Math.min(piTimeoutMs * 4, budgetLeftMs, childBudgetMs + 120_000));

  const verify = verifyFor(c.repo);
  const res = await runAsync("node", [runnerMain], {
    cwd: workDir,
    env: {
      ...process.env,
      GITHUB_REPOSITORY: c.repo,
      ISSUE_NUMBER: String(c.number),
      WORK_DIR: workDir,
      RUNNER_TEMP: runDir,
      DEFAULT_BRANCH: defaultBranch,
      PI_TIMEOUT_MS: String(piTimeoutMs),
      // The runner enforces its own budget strictly below the parent timeout.
      AGENT_BUDGET_MS: String(Math.max(120_000, timeoutMs - 120_000)),
      ...(verify.cmd ? { VERIFY_CMD: verify.cmd } : {}),
      ...(verify.timeoutMs ? { VERIFY_TIMEOUT_MS: String(verify.timeoutMs) } : {}),
    },
    timeoutMs,
    onStdout: (s) => process.stdout.write(s),
    onStderr: (s) => process.stderr.write(s),
  });
  console.log(`[dispatch] ${c.repo} #${c.number} -> ok=${res.ok}${res.error ? " " + res.error : ""}`);
  rmSync(workDir, { recursive: true, force: true });
}

async function main(): Promise<void> {
  const org = process.env.ORG ?? "EasyIndie";
  const maxIssues = intEnv("MAX_ISSUES", 4, 1, 20);
  const startedAt = Date.now();
  // Total wall clock for one scan. The workflow job timeout is 60 min; stop
  // picking up new issues in time to let the current one finish cleanly.
  const deadlineMs = intEnv("DISPATCH_BUDGET_MS", 50 * 60 * 1000, 120_000, 6 * 60 * 60 * 1000);
  // Cross-repo post-merge watchdog: the targets cannot host ai-watch themselves
  // (zero-file mode), so the dispatcher inspects their default branch here.
  // An incident it opens also latches auto-merge off for that repository.
  if ((process.env.EASYGH_WATCHDOG ?? "on").toLowerCase() !== "off") {
    const results = runWatchdog({
      filter: process.env.REPO_FILTER?.split(",").map((s) => s.trim()).filter(Boolean),
      maxRepos: intEnv("MAX_REPOS", 40, 1, 200),
    });
    for (const result of results) {
      if (result.action === "none") continue;
      console.log(`[watch] ${result.repo}: ${result.action} — ${result.detail}`);
    }
    console.log(`[watch] checked ${results.length} repo(s), ${results.filter((r) => r.action === "incident").length} incident(s)`);
  } else {
    console.log("[watch] disabled (EASYGH_WATCHDOG=off)");
  }

  const list = candidates();
  console.log(`[dispatch] org=${org} candidates=${list.length} (max ${maxIssues}, budget ${Math.round(deadlineMs / 60000)}m)`);

  let processed = 0;
  for (const c of list) {
    if (processed >= maxIssues) break;
    const left = deadlineMs - (Date.now() - startedAt);
    if (left < 3 * 60 * 1000) {
      console.log(`[dispatch] deadline reached (${Math.round(left / 1000)}s left); deferring ${list.length - processed} candidate(s)`);
      break;
    }
    if (isHandled(c.repo, c.number)) {
      console.log(`[dispatch] skip ${c.repo} #${c.number} (handled/running/pr open)`);
      continue;
    }
    await processIssue(c, left);
    processed++;
  }
  console.log(`[dispatch] done (processed ${processed})`);
}

// Only run when executed directly (keeps this module safely importable/testable).
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error("[dispatch] fatal:", err);
    process.exitCode = 1;
  });
}

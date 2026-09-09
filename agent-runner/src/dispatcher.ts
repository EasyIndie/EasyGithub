import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAsync, runSync } from "./util/exec.ts";

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
 *   - Issue title or body contains the marker `easygh-ai`
 */
const HANDLED = ["ai-running", "ai-pr", "ai-failed", "ai-done"];

interface Candidate {
  repo: string; // owner/name
  number: number;
}

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
    repos = gh(["api", "/installation/repositories", "--jq", ".repositories[].full_name"])
      .split("\n").map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    console.log(`[dispatch] installation repos failed: ${e instanceof Error ? e.message : e}`);
    return [...set.values()];
  }
  const filter = process.env.REPO_FILTER?.split(",").map((s) => s.trim()).filter(Boolean);
  if (filter?.length) repos = repos.filter((r) => filter.includes(r));
  repos = repos.slice(0, maxRepos);
  console.log(`[dispatch] accessible repos: ${repos.length}`);

  for (const repo of repos) {
    let items: Array<{ n: number; t: string; b: string; l: string[] }> = [];
    try {
      const raw = gh(["api", `repos/${repo}/issues?state=open&per_page=100`, "--jq", "[.[] | select(.pull_request == null) | {n:.number,t:(.title // \"\"),b:(.body // \"\"),l:[.labels[].name]}]"], );
      items = JSON.parse(raw) as typeof items;
    } catch (e) {
      console.log(`[dispatch] issues list failed for ${repo}: ${e instanceof Error ? e.message.slice(0, 200) : e}`);
      continue;
    }
    for (const it of items) {
      const labelHit = it.l.includes("ai");
      const markerHit = it.t.includes("easygh-ai") || it.b.includes("easygh-ai");
      if (labelHit || markerHit) set.set(`${repo}#${it.n}`, { repo, number: it.n });
    }
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

async function processIssue(c: Candidate): Promise<void> {
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
  const timeoutMs = Number(process.env.PI_TIMEOUT_MS ?? 40 * 60 * 1000);

  const res = await runAsync("node", [runnerMain], {
    cwd: workDir,
    env: {
      ...process.env,
      GITHUB_REPOSITORY: c.repo,
      ISSUE_NUMBER: String(c.number),
      WORK_DIR: workDir,
      RUNNER_TEMP: runDir,
      DEFAULT_BRANCH: defaultBranch,
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
  const list = candidates();
  console.log(`[dispatch] org=${org} candidates=${list.length} (max ${maxIssues})`);

  let processed = 0;
  for (const c of list) {
    if (processed >= maxIssues) break;
    if (isHandled(c.repo, c.number)) {
      console.log(`[dispatch] skip ${c.repo} #${c.number} (handled/running/pr open)`);
      continue;
    }
    await processIssue(c);
    processed++;
  }
  console.log(`[dispatch] done (processed ${processed})`);
}

main().catch((err) => {
  console.error("[dispatch] fatal:", err);
  process.exitCode = 1;
});

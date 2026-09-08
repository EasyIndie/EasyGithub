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
  gh(["issue", "edit", String(number), "-R", repo, "--add-label", label]);
}

export function removeLabel(repo: string, number: number, label: string): void {
  // Removing a label that does not exist is not an error worth failing on.
  const res = runSync("gh", ["issue", "edit", String(number), "-R", repo, "--remove-label", label]);
  if (res.status !== 0) {
    // label may already be gone
    if (!/could not be found|could not remove|not exist/i.test(res.stderr)) {
      throw new Error(`remove-label ${label} failed: ${res.stderr.trim()}`);
    }
  }
}

export function commentFromFile(repo: string, number: number, bodyFile: string): void {
  gh(["issue", "comment", String(number), "-R", repo, "--body-file", bodyFile]);
}

export function createPr(repo: string, opts: { base: string; head: string; title: string; bodyFile: string }): PrInfo {
  // PR creation may be blocked for the automatic GITHUB_TOKEN by an org policy
  // ("Allow GitHub Actions to create and approve pull requests"). A personal
  // token (EASYGH_PR_TOKEN) is not subject to that restriction; use it when set.
  const env = { ...process.env };
  if (process.env.EASYGH_PR_TOKEN) env.GH_TOKEN = process.env.EASYGH_PR_TOKEN;
  const res = runSync(
    "gh",
    ["pr", "create", "-R", repo, "--base", opts.base, "--head", opts.head, "--title", opts.title, "--body-file", opts.bodyFile],
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

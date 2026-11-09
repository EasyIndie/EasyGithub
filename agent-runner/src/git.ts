import { runSync, type ExecResult } from "./util/exec.ts";

function git(args: string[], cwd: string, allowFail = false): ExecResult {
  const res = runSync("git", args, { cwd });
  if (res.status !== 0 && !allowFail) {
    throw new Error(`git ${args.slice(0, 2).join(" ")} failed (${res.status}): ${res.stderr.trim()}`);
  }
  return res;
}

export function setIdentity(cwd: string, name: string, email: string): void {
  git(["config", "user.name", name], cwd);
  git(["config", "user.email", email], cwd);
}

export function currentBranch(cwd: string): string {
  return git(["rev-parse", "--abbrev-ref", "HEAD"], cwd).stdout.trim();
}

export function createBranch(cwd: string, name: string): void {
  // -B creates the branch or resets an existing one: a retried run must not
  // die on "a branch named ai/issue-N already exists".
  git(["checkout", "-B", name], cwd);
}

/** Any worktree change (tracked or untracked, excluding .gitignore'd files). */
export function hasChanges(cwd: string): boolean {
  return git(["status", "--porcelain"], cwd).stdout.trim().length > 0;
}

/** Staged changes only — what an upcoming commit would actually contain. */
export function hasStagedChanges(cwd: string): boolean {
  const res = runSync("git", ["diff", "--cached", "--quiet"], { cwd });
  if (res.status === 0) return false;
  if (res.status === 1) return true;
  throw new Error(`git diff --cached failed: ${res.stderr.trim()}`);
}

export function deleteRemoteBranchIfExists(cwd: string, name: string): void {
  const exists = git(["ls-remote", "--exit-code", "--heads", "origin", name], cwd, true).status === 0;
  if (exists) {
    git(["push", "origin", "--delete", name], cwd, true);
  }
}

export function stageAll(cwd: string): void {
  git(["add", "-A"], cwd);
}

/** Staged paths (NUL separated, so unusual filenames stay intact). */
export function stagedPaths(cwd: string): string[] {
  const res = git(["diff", "--cached", "--name-only", "-z"], cwd);
  return res.stdout.split("\0").filter((p) => p.length > 0);
}

/** Remove paths from the index (keeps the worktree untouched). */
export function unstage(cwd: string, paths: string[]): void {
  const CHUNK = 100; // keep argv well below platform limits
  for (let i = 0; i < paths.length; i += CHUNK) {
    const chunk = paths.slice(i, i + CHUNK);
    if (chunk.length === 0) continue;
    git(["reset", "-q", "--", ...chunk], cwd);
  }
}

export function commitStaged(cwd: string, message: string): void {
  git(["commit", "-m", message], cwd);
}

export function pushBranch(cwd: string, name: string): void {
  git(["push", "-u", "origin", name], cwd);
}

/**
 * Credential isolation for the agent phase.
 *
 * `actions/checkout` persists a token in `.git/config`
 * (`http.https://github.com/.extraheader`) and the dispatcher clones with the
 * token embedded in the remote URL. Both give the agent the ability to push
 * anywhere, so we hide them while the agent runs and restore them right before
 * the runner pushes. The stash is kept in memory only: persisting it to disk
 * would leave the token readable by the agent for the whole run.
 */
const CREDENTIAL_KEY = "http.https://github.com/.extraheader";

interface CredentialStash {
  url?: string;
  headers: string[];
  helpers: string[];
}

/** cwd -> credentials hidden while the agent runs (never written to disk). */
const hidden = new Map<string, CredentialStash>();

function tokenlessUrl(url: string): string {
  return url.replace(/\/\/[^/@]*@/, "//");
}

export function hideCredentials(cwd: string): void {
  const urlRes = runSync("git", ["remote", "get-url", "origin"], { cwd });
  const url = urlRes.status === 0 ? urlRes.stdout.trim() : "";

  const headerRes = runSync("git", ["config", "--local", "--get-all", CREDENTIAL_KEY], { cwd });
  const headers = headerRes.status === 0 ? headerRes.stdout.split("\n").filter(Boolean) : [];

  const helperRes = runSync("git", ["config", "--local", "--get-all", "credential.helper"], { cwd });
  const helpers = helperRes.status === 0 ? helperRes.stdout.split("\n").filter(Boolean) : [];

  hidden.set(cwd, { url: url || undefined, headers, helpers });

  if (headers.length > 0) git(["config", "--local", "--unset-all", CREDENTIAL_KEY], cwd, true);
  if (url) {
    const clean = tokenlessUrl(url);
    if (clean !== url) git(["remote", "set-url", "origin", clean], cwd);
  }
  // An empty local helper resets the list inherited from global config, so a
  // developer machine's `gh auth setup-git` helper is not used either.
  git(["config", "--local", "--replace-all", "credential.helper", ""], cwd, true);
}

/** Restore credentials hidden by hideCredentials (idempotent, never throws). */
export function restoreCredentials(cwd: string): void {
  const stash = hidden.get(cwd);
  if (!stash) return;
  hidden.delete(cwd);
  if (stash.url) git(["remote", "set-url", "origin", stash.url], cwd, true);
  if (stash.headers.length > 0) {
    git(["config", "--local", "--unset-all", CREDENTIAL_KEY], cwd, true);
    for (const header of stash.headers) git(["config", "--local", "--add", CREDENTIAL_KEY, header], cwd, true);
  }
  git(["config", "--local", "--unset-all", "credential.helper"], cwd, true);
  for (const helper of stash.helpers) {
    git(["config", "--local", "--add", "credential.helper", helper], cwd, true);
  }
}

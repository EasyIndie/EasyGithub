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
  git(["checkout", "-b", name], cwd);
}

export function hasChanges(cwd: string): boolean {
  const res = git(["status", "--porcelain"], cwd);
  return res.stdout.trim().length > 0;
}

export function deleteRemoteBranchIfExists(cwd: string, name: string): void {
  const exists = git(["ls-remote", "--exit-code", "--heads", "origin", name], cwd, true).status === 0;
  if (exists) {
    git(["push", "origin", "--delete", name], cwd, true);
  }
}

export function commitAll(cwd: string, message: string): void {
  git(["add", "-A"], cwd);
  git(["commit", "-m", message], cwd);
}

export function pushBranch(cwd: string, name: string): void {
  git(["push", "-u", "origin", name], cwd);
}

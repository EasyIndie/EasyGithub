import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSync } from "../src/util/exec.ts";
import { commitStaged, createBranch, pushBranch, stageAll, syncWithBase } from "../src/git.ts";

const dirs: string[] = [];

function sh(cwd: string, ...args: string[]): string {
  const res = runSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd });
  assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout.trim();
}

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `easygh-${prefix}-`));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

interface Fixture {
  remote: string;
  seed: string;
  work: string;
}

/** Bare remote + seed clone (pushes base commits) + work clone (the AI branch). */
function fixture(): Fixture {
  const remote = join(temp("remote"), "repo.git");
  sh(temp("init"), "init", "--bare", "--initial-branch=main", remote);

  const seed = temp("seed");
  sh(seed, "init", "--initial-branch=main");
  writeFileSync(join(seed, "a.txt"), "one\n");
  sh(seed, "add", "-A");
  sh(seed, "commit", "-m", "init");
  sh(seed, "remote", "add", "origin", remote);
  sh(seed, "push", "-u", "origin", "main");

  const parent = temp("work");
  sh(parent, "clone", remote, "work");
  return { remote, seed, work: join(parent, "work") };
}

function commitFile(cwd: string, file: string, content: string, message: string): void {
  writeFileSync(join(cwd, file), content);
  stageAll(cwd);
  commitStaged(cwd, message);
}

describe("git.syncWithBase", () => {
  it("does nothing when the base has not moved", () => {
    const { work } = fixture();
    createBranch(work, "ai/issue-1");
    commitFile(work, "b.txt", "b\n", "ai: work");

    const result = syncWithBase(work, "main");
    assert.deepEqual(result, { ok: true, changed: false, conflicts: [] });
  });

  it("rebases the AI branch onto a newer base", () => {
    const { work, seed } = fixture();
    createBranch(work, "ai/issue-1");
    commitFile(work, "b.txt", "b\n", "ai: work");

    commitFile(seed, "a.txt", "one\ntwo\n", "base: move ahead");
    sh(seed, "push", "origin", "main");

    const result = syncWithBase(work, "main");
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.deepEqual(result.conflicts, []);
    assert.equal(sh(work, "rev-list", "--count", "HEAD..origin/main"), "0", "branch is up to date with base");
    assert.equal(sh(work, "log", "-1", "--format=%s"), "ai: work", "AI commit stays on top");
    assert.match(sh(work, "show", "--stat", "--format=", "HEAD"), /b\.txt/);
  });

  it("aborts and reports conflicts instead of leaving a half-rebased branch", () => {
    const { work, seed } = fixture();
    const headBefore = sh(work, "rev-parse", "HEAD");
    createBranch(work, "ai/issue-1");
    commitFile(work, "a.txt", "ai version\n", "ai: edit a");

    writeFileSync(join(seed, "a.txt"), "base version\n");
    sh(seed, "add", "-A");
    sh(seed, "commit", "-m", "base: edit a");
    sh(seed, "push", "origin", "main");

    const result = syncWithBase(work, "main");
    assert.equal(result.ok, false);
    assert.equal(result.changed, false);
    assert.deepEqual(result.conflicts, ["a.txt"]);
    assert.equal(sh(work, "status", "--porcelain"), "", "worktree is clean after --abort");
    assert.notEqual(sh(work, "rev-parse", "HEAD"), headBefore);
    assert.equal(sh(work, "log", "-1", "--format=%s"), "ai: edit a", "AI commit is intact");
  });

  it("reports a warning instead of throwing when the fetch fails", () => {
    const { work } = fixture();
    createBranch(work, "ai/issue-1");
    commitFile(work, "b.txt", "b\n", "ai: work");
    sh(work, "remote", "set-url", "origin", join(tmpdir(), "does-not-exist.git"));

    const result = syncWithBase(work, "main");
    assert.equal(result.ok, true);
    assert.equal(result.changed, false);
    assert.match(result.warning ?? "", /fetch origin main failed/);
  });

  it("needs a force push after rebasing an already pushed branch", () => {
    const { work, seed } = fixture();
    createBranch(work, "ai/issue-1");
    commitFile(work, "b.txt", "b\n", "ai: work");
    pushBranch(work, "ai/issue-1");

    commitFile(seed, "a.txt", "one\ntwo\n", "base: move ahead");
    sh(seed, "push", "origin", "main");

    assert.equal(syncWithBase(work, "main").ok, true);

    // The rebase rewrote the commit that was already pushed.
    const plain = runSync("git", ["push", "--dry-run", "origin", "ai/issue-1"], { cwd: work });
    assert.notEqual(plain.status, 0, "a plain push must be rejected after a rebase");

    pushBranch(work, "ai/issue-1", { force: true });
    assert.equal(
      sh(work, "rev-parse", "HEAD"),
      sh(work, "rev-parse", "origin/ai/issue-1"),
      "force-with-lease publishes the rebased branch",
    );
  });
});

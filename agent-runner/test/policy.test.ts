import { beforeEach, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSync } from "../src/util/exec.ts";
import { auditStagedChanges, describeAudit, stageChanges } from "../src/policy.ts";

let dir = "";

function git(args: string[]): void {
  const res = runSync("git", args, { cwd: dir });
  assert.equal(res.status, 0, `git ${args.join(" ")}: ${res.stderr}`);
}

function write(path: string, content = "x\n"): void {
  const full = join(dir, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

describe("policy audit", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "easygh-policy-"));
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    write("README.md", "init\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "init"]);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("never stages vendored trees or scratch files", () => {
    write("src/a.ts", "export const a = 1\n");
    write("node_modules/pkg/index.js");
    write("coverage/lcov.info");
    write("debug.log");
    write("TASK.md");
    write("EASYGH_BLOCKED.md");
    const ignored = stageChanges(dir).ignored;
    assert.ok(ignored.some((p) => p.startsWith("node_modules/")));
    assert.ok(ignored.some((p) => p.startsWith("coverage/")));
    assert.ok(ignored.includes("debug.log"));
    assert.ok(ignored.includes("TASK.md"));
    assert.ok(ignored.includes("EASYGH_BLOCKED.md"));
    assert.ok(!ignored.includes("src/a.ts"));
  });

  it("blocks workflow, action and license changes", () => {
    write(".github/workflows/ci.yml", "name: x\n");
    write(".github/actions/a/action.yml", "name: a\n");
    write("LICENSE", "evil\n");
    stageChanges(dir);
    const audit = auditStagedChanges(dir);
    assert.equal(audit.ok, false);
    assert.deepEqual(audit.blocked.sort(), [".github/actions/a/action.yml", ".github/workflows/ci.yml", "LICENSE"].sort());
  });

  it("flags runner/CI/installer changes as sensitive but allowed", () => {
    write("agent-runner/src/main.ts", "x\n");
    write("scripts/dev-run.sh", "x\n");
    write("src/feature.ts", "x\n");
    stageChanges(dir);
    const audit = auditStagedChanges(dir);
    assert.equal(audit.ok, true);
    assert.deepEqual(audit.sensitive.sort(), ["agent-runner/src/main.ts", "scripts/dev-run.sh"]);
  });

  it("honours repository-specific rules while keeping the baseline", () => {
    write("Sources/generated/lexer.swift", "x\n");
    write("Sources/App.swift", "x\n");
    write(".github/workflows/ci.yml", "name: x\n");
    stageChanges(dir, { blockedPaths: ["Sources/generated/"] });
    const audit = auditStagedChanges(dir, {
      blockedPaths: ["Sources/generated/"],
      sensitivePaths: ["Sources/"],
    });
    assert.equal(audit.ok, false);
    assert.ok(audit.blocked.includes("Sources/generated/lexer.swift"));
    assert.ok(audit.blocked.includes(".github/workflows/ci.yml"), "baseline stays blocked");
    assert.ok(audit.sensitive.includes("Sources/App.swift"));
  });

  it("detects credentials in added lines", () => {
    write("src/config.ts", "const key = 'sk-abcdefghijklmnopqrstuvwx';\n");
    stageChanges(dir);
    const audit = auditStagedChanges(dir);
    assert.equal(audit.ok, false);
    assert.equal(audit.secrets.length, 1);
    assert.equal(audit.secrets[0]?.file, "src/config.ts");
    assert.ok(!describeAudit(audit).includes("sk-abcdefghijklmnopqrstuvwx"));
  });

  it("ignores credentials that were already committed", () => {
    write("old.ts", "const key = 'ghp_abcdefghijklmnopqrstuvwx';\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "old secret"]);
    write("src/new.ts", "export const ok = true;\n");
    stageChanges(dir);
    assert.equal(auditStagedChanges(dir).ok, true);
  });
});

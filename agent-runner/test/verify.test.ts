import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureVerifySpec, runVerify } from "../src/verify.ts";

let dir = "";
const savedVerifyCmd = process.env.VERIFY_CMD;
const savedVerifyTimeout = process.env.VERIFY_TIMEOUT_MS;

function writePackage(scripts: Record<string, string>): void {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", scripts }, null, 2));
}

describe("verify gate", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "easygh-verify-"));
    // Pretend dependencies are installed: avoids network in tests.
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    delete process.env.VERIFY_CMD;
    delete process.env.VERIFY_TIMEOUT_MS;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (savedVerifyCmd !== undefined) process.env.VERIFY_CMD = savedVerifyCmd;
    if (savedVerifyTimeout !== undefined) process.env.VERIFY_TIMEOUT_MS = savedVerifyTimeout;
  });

  it("resolves and captures the check script", async () => {
    writePackage({ check: "node -e \"process.exit(0)\"" });
    const spec = await captureVerifySpec(dir);
    assert.equal(spec.command, "npm run check");
    assert.equal(spec.scriptBody, "node -e \"process.exit(0)\"");
  });

  it("prefers check over test/lint", async () => {
    writePackage({ test: "false", lint: "false", check: "true" });
    assert.equal((await captureVerifySpec(dir)).command, "npm run check");
  });

  it("honours VERIFY_CMD", async () => {
    writePackage({ check: "false" });
    process.env.VERIFY_CMD = "node -e \"process.exit(0)\"";
    const spec = await captureVerifySpec(dir);
    assert.equal(spec.command, process.env.VERIFY_CMD);
    assert.equal(spec.scriptBody, null);
    const result = await runVerify(dir, spec, 30_000);
    assert.equal(result.ok, true);
    assert.equal(result.verified, true);
  });

  it("passes with an untouched gate", async () => {
    writePackage({ check: "node -e \"process.exit(0)\"" });
    const spec = await captureVerifySpec(dir);
    const result = await runVerify(dir, spec, 30_000);
    assert.equal(result.ok, true);
    assert.equal(result.verified, true);
    assert.equal(result.tampered, false);
  });

  it("detects a weakened gate and does not trust it", async () => {
    writePackage({ check: "node -e \"process.exit(1)\"" });
    const spec = await captureVerifySpec(dir);
    writePackage({ check: "node -e \"process.exit(0)\"" });
    const result = await runVerify(dir, spec, 30_000);
    assert.equal(result.tampered, true);
    assert.equal(result.verified, false);
    // The frozen body fails, even though the new script would pass.
    assert.equal(result.ok, false);
  });

  it("prefers a repository profile command over detection", async () => {
    writePackage({ check: "node -e \"process.exit(0)\"" });
    const spec = await captureVerifySpec(dir, { verify: ["bash scripts/lint.sh"] });
    assert.equal(spec.command, "bash scripts/lint.sh");
    assert.equal(spec.scriptBody, null);
  });

  it("detects additional ecosystems when no profile is set", async () => {
    writeFileSync(join(dir, "Package.swift"), "// swift\n");
    const spec = await captureVerifySpec(dir);
    assert.equal(spec.command, "swift test");
  });

  it("detects a weakened verification script (self-reference hole)", async () => {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts", "check.sh"), "#!/usr/bin/env bash\nexit 0\n");
    const spec = await captureVerifySpec(dir, { verify: ["bash scripts/check.sh"] });
    assert.deepEqual(Object.keys(spec.gateFiles ?? {}), ["scripts/check.sh"]);
    writeFileSync(join(dir, "scripts", "check.sh"), "#!/usr/bin/env bash\n# weakened\nexit 0\n");
    const result = await runVerify(dir, spec, 30_000);
    assert.equal(result.tampered, true);
    assert.equal(result.verified, false);
  });

  it("reports 'no check command' as skipped, never as verified", async () => {
    const empty = mkdtempSync(join(tmpdir(), "easygh-empty-"));
    try {
      const spec = await captureVerifySpec(empty);
      assert.equal(spec.command, null);
      const result = await runVerify(empty, spec, 30_000);
      assert.equal(result.skipped, true);
      assert.equal(result.verified, false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

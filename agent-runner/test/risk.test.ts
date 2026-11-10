import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assessRisk, autoMergeDecision, isDocsOrTestsOnly, parseAutoMergeMode } from "../src/risk.ts";

const verified = { verified: true, tampered: false, skipped: false };

describe("assessRisk", () => {
  it("escalates protected paths to high", () => {
    for (const path of [".github/workflows/ci.yml", "agent-runner/src/main.ts", "scripts/dev-run.sh", "eval/tasks/x.json", "LICENSE"]) {
      const risk = assessRisk({ paths: [path], changedLines: 3, verify: verified });
      assert.equal(risk.level, "high", path);
    }
  });

  it("escalates dependency manifests to high", () => {
    const risk = assessRisk({ paths: ["package.json"], changedLines: 1, verify: verified });
    assert.equal(risk.level, "high");
    assert.match(risk.reasons.join("\n"), /dependency/);
  });

  it("escalates unverified and tampered runs to high", () => {
    const unverified = assessRisk({ paths: ["src/a.ts"], changedLines: 1, verify: { verified: false, tampered: false, skipped: true } });
    assert.equal(unverified.level, "high");
    const tampered = assessRisk({ paths: ["src/a.ts"], changedLines: 1, verify: { verified: false, tampered: true, skipped: false } });
    assert.equal(tampered.level, "high");
    const none = assessRisk({ paths: ["src/a.ts"], changedLines: 1, verify: null });
    assert.equal(none.level, "high");
  });

  it("keeps small verified source changes at low", () => {
    const risk = assessRisk({ paths: ["src/util/math.ts"], changedLines: 12, verify: verified });
    assert.equal(risk.level, "low");
    assert.deepEqual(risk.reasons, ["small, verified, non-protected change"]);
  });

  it("honours repository-specific protected paths and keeps the baseline", () => {
    const config = { protectedPaths: ["Sources/", "OrzMC.xcodeproj/"], dependencyFiles: ["Package.swift"] };
    const sources = assessRisk({ paths: ["Sources/App.swift"], changedLines: 5, verify: verified, ...config });
    assert.equal(sources.level, "high");
    const manifest = assessRisk({ paths: ["Package.swift"], changedLines: 1, verify: verified, ...config });
    assert.equal(manifest.level, "high");
    const workflows = assessRisk({ paths: [".github/workflows/ci.yml"], changedLines: 1, verify: verified, ...config });
    assert.equal(workflows.level, "high", "baseline paths stay protected");
    const readme = assessRisk({ paths: ["README.md"], changedLines: 5, verify: verified, ...config });
    assert.equal(readme.level, "low");
  });

  it("uses medium for bigger diffs", () => {
    const risk = assessRisk({ paths: ["src/a.ts"], changedLines: 250, verify: verified });
    assert.equal(risk.level, "medium");
  });

  it("uses high for very large diffs", () => {
    const risk = assessRisk({ paths: ["src/a.ts"], changedLines: 900, verify: verified });
    assert.equal(risk.level, "high");
  });

  it("treats docs-only changes as probation-safe", () => {
    assert.ok(isDocsOrTestsOnly(["docs/a.md", "README.md"]));
    assert.ok(isDocsOrTestsOnly(["agent-runner/test/risk.test.ts"]));
    assert.ok(!isDocsOrTestsOnly(["src/main.ts"]));
    assert.ok(!isDocsOrTestsOnly([]));
  });
});

describe("autoMergeDecision", () => {
  const lowRisk = assessRisk({ paths: ["src/a.ts"], changedLines: 5, verify: verified });

  it("is off by default", () => {
    assert.equal(parseAutoMergeMode(undefined), "off");
    assert.equal(parseAutoMergeMode(""), "off");
    assert.equal(parseAutoMergeMode("probation"), "probation");
    assert.equal(parseAutoMergeMode("ON"), "on");
    const decision = autoMergeDecision({ mode: "off", risk: lowRisk, verify: verified, paths: ["src/a.ts"] });
    assert.equal(decision.allowed, false);
  });

  it("allows low risk when on", () => {
    const decision = autoMergeDecision({ mode: "on", risk: lowRisk, verify: verified, paths: ["src/a.ts"] });
    assert.equal(decision.allowed, true);
  });

  it("refuses medium/high risk", () => {
    for (const path of [".github/workflows/ci.yml", "package.json"]) {
      const risk = assessRisk({ paths: [path], changedLines: 1, verify: verified });
      assert.equal(autoMergeDecision({ mode: "on", risk, verify: verified, paths: [path] }).allowed, false, path);
    }
  });

  it("refuses untrusted verification", () => {
    for (const verify of [{ verified: false, tampered: true, skipped: false }, { verified: true, tampered: false, skipped: true }]) {
      assert.equal(autoMergeDecision({ mode: "on", risk: lowRisk, verify, paths: ["src/a.ts"] }).allowed, false);
    }
    assert.equal(autoMergeDecision({ mode: "on", risk: lowRisk, verify: null, paths: ["src/a.ts"] }).allowed, false);
  });

  it("restricts probation to docs/tests", () => {
    assert.equal(autoMergeDecision({ mode: "probation", risk: lowRisk, verify: verified, paths: ["src/a.ts"] }).allowed, false);
    assert.equal(autoMergeDecision({ mode: "probation", risk: lowRisk, verify: verified, paths: ["docs/a.md"] }).allowed, true);
  });
});

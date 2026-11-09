import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildReport, signatureOf, type RepoFindings } from "../src/retro.ts";

const issue = (number: number, title: string) => ({
  number,
  title,
  url: `https://example/${number}`,
  updatedAt: "",
});

describe("retro: signatureOf", () => {
  it("extracts the failing command", () => {
    assert.equal(signatureOf("Command: npm run test\n..." ), "check failed: npm run test");
  });

  it("classifies the common failures", () => {
    assert.equal(signatureOf("The run exhausted its 75 minute budget"), "budget exhausted");
    assert.equal(signatureOf("Timed out after 15 minutes."), "agent/check timeout");
    assert.equal(signatureOf("pi exited with code 1."), "agent crash");
    assert.equal(signatureOf("Verification still failing after 3 attempts."), "verification failed");
    assert.equal(signatureOf("AI 改动被流水线策略拒绝"), "policy rejection");
    assert.equal(signatureOf("## 需要人工决策"), "needs human input");
    assert.equal(signatureOf("something else"), "unclassified");
  });
});

describe("retro: buildReport", () => {
  const hub: RepoFindings = {
    repo: "o/hub",
    failed: [{ issue: issue(1, "broken"), signature: "agent crash" }],
    blocked: [issue(2, "unclear")],
    deferred: [],
    merged: [
      { number: 3, title: "[AI] fix: #1", url: "u", mergedAt: new Date().toISOString() },
    ],
  };
  const empty: RepoFindings = { repo: "o/quiet", failed: [], blocked: [], deferred: [], merged: [] };

  it("aggregates totals and per-repo sections", () => {
    const report = buildReport({ days: 7, repos: [hub, empty] });
    assert.match(report, /覆盖仓库：`o\/hub`、`o\/quiet`/);
    assert.match(report, /\| 已合并的 AI PR \| 1 \|/);
    assert.match(report, /\| 失败运行（`ai-failed`） \| 1 \|/);
    assert.match(report, /## o\/hub/);
    assert.match(report, /无活动。/);
    assert.match(report, /agent crash/);
  });

  it("does not crash without repos", () => {
    assert.match(buildReport({ days: 7, repos: [] }), /没有可报告的仓库/);
  });
});

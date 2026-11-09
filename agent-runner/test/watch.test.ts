import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { failingPushRuns, isAiMerge, type RunRow } from "../src/watch.ts";

describe("watch: isAiMerge", () => {
  it("detects the squash-merge subject", () => {
    assert.equal(isAiMerge("[AI] fix: #12 something (#34)\n\nbody", []), true);
  });

  it("detects an associated AI pull request", () => {
    assert.equal(isAiMerge("feat: something (#34)", ["[AI] feat: #12 something"]), true);
  });

  it("ignores human merges", () => {
    assert.equal(isAiMerge("feat: human change (#35)", ["feat: human change"]), false);
    assert.equal(isAiMerge("", []), false);
  });

  it("only looks at the first line", () => {
    assert.equal(isAiMerge("chore: x\n\n[AI] quoted", []), false);
  });
});

describe("watch: failingPushRuns", () => {
  const run = (over: Partial<RunRow>): RunRow => ({
    name: "CI",
    event: "push",
    headSha: "abc1234",
    conclusion: "failure",
    url: "u",
    createdAt: "",
    ...over,
  });

  it("only reports push-triggered failures on the exact commit", () => {
    const runs = [
      run({}),
      run({ event: "schedule", name: "Security Audit" }),
      run({ headSha: "other" }),
      run({ conclusion: "success" }),
      run({ conclusion: null }),
    ];
    const failing = failingPushRuns(runs, "abc1234");
    assert.equal(failing.length, 1);
    assert.equal(failing[0]?.event, "push");
  });

  it("ignores repos with no failing run", () => {
    assert.deepEqual(failingPushRuns([run({ conclusion: "success" })], "abc1234"), []);
  });
});

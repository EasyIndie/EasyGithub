import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handledByLabels } from "../src/dispatcher.ts";

describe("dispatcher: re-armed issues", () => {
  it("treats in-flight and finished labels as handled", () => {
    for (const label of ["ai-running", "ai-pr", "ai-failed", "ai-done"]) {
      assert.equal(handledByLabels(["ai", label]), true, label);
    }
  });

  it("does not treat a freshly armed issue as handled", () => {
    // `ai-decide retry` removes ai-pr/ai-failed/... and re-adds `ai`; the rerun
    // must be allowed even though an (old) PR may still be open.
    assert.equal(handledByLabels(["ai"]), false);
    assert.equal(handledByLabels(["ai", "documentation"]), false);
  });
});

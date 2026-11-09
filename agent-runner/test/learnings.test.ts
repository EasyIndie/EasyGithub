import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSections, renderLearnings, selectLearnings } from "../src/learnings.ts";

const DOC = `# Learnings

## verifier
Always run \`npm run check\` before committing.

## windows paths
Use path.join, never string concatenation.

## docs
Keep README short.
`;

describe("learnings", () => {
  it("parses level-2 sections", () => {
    const sections = parseSections(DOC);
    assert.deepEqual(sections.map((s) => s.heading), ["verifier", "windows paths", "docs"]);
    assert.match(sections[0]?.body ?? "", /npm run check/);
  });

  it("selects the most relevant sections first", () => {
    const picked = selectLearnings(DOC, "fix the verifier gate", 1);
    assert.equal(picked[0]?.heading, "verifier");
  });

  it("falls back to document order", () => {
    const picked = selectLearnings(DOC, "unrelated words here", 2);
    assert.deepEqual(picked.map((s) => s.heading), ["verifier", "windows paths"]);
  });

  it("renders nothing when the file is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "easygh-learn-"));
    try {
      assert.equal(renderLearnings(dir, "anything"), "");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders a bounded block from docs/learnings.md", () => {
    const dir = mkdtempSync(join(tmpdir(), "easygh-learn-"));
    try {
      mkdirSync(join(dir, "docs"), { recursive: true });
      writeFileSync(join(dir, "docs/learnings.md"), DOC);
      const block = renderLearnings(dir, "verifier");
      assert.match(block, /仓库经验/);
      assert.match(block, /npm run check/);
      assert.ok(block.length < 3000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

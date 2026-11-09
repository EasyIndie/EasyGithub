import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { routeAgent } from "../src/router.ts";

describe("routeAgent", () => {
  it("lets an agent:<name> label win over everything", async () => {
    assert.equal(await routeAgent({ labels: ["ai", "agent:Codex"], title: "refactor the parser" }), "codex");
  });

  it("routes by configured label rules", async () => {
    assert.equal(await routeAgent({ labels: ["ai", "refactor"], title: "cleanup" }), "claude");
  });

  it("routes by title rules", async () => {
    assert.equal(await routeAgent({ labels: ["ai"], title: "port to codex" }), "codex");
  });

  it("falls back to the configured default", async () => {
    assert.equal(await routeAgent({ labels: ["ai"], title: "fix a typo" }), "pi");
  });
});

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { agentEnv, withheldSecretNames } from "../src/env.ts";

const ORIGINAL = { ...process.env };

function restore(values: Record<string, string | undefined>): void {
  for (const key of Object.keys(process.env)) if (!(key in values)) delete process.env[key];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("agentEnv", () => {
  afterEach(() => restore(ORIGINAL));

  it("withholds repository credentials", () => {
    process.env.GH_TOKEN = "ghp_notarealtoken";
    process.env.GITHUB_TOKEN = "ghs_notarealtoken";
    process.env.EASYGH_PR_TOKEN = "ghp_other";
    const env = agentEnv();
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.EASYGH_PR_TOKEN, undefined);
  });

  it("keeps provider keys and tool config", () => {
    process.env.DEEPSEEK_API_KEY = "sk-test";
    process.env.ANTHROPIC_AUTH_TOKEN = "sk-ant-test";
    const env = agentEnv();
    assert.equal(env.DEEPSEEK_API_KEY, "sk-test");
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, "sk-ant-test");
  });

  it("drops unrelated variables", () => {
    process.env.SOME_UNRELATED_THING = "x";
    assert.equal(agentEnv().SOME_UNRELATED_THING, undefined);
  });

  it("disables interactive credential prompts", () => {
    const env = agentEnv();
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(env.GCM_INTERACTIVE, "never");
  });

  it("reports withheld names without values", () => {
    process.env.GH_TOKEN = "ghp_supersecretvalue";
    const names = withheldSecretNames();
    assert.ok(names.includes("GH_TOKEN"));
    assert.ok(!names.join(",").includes("supersecretvalue"));
  });
});

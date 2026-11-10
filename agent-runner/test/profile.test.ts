import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { profileFor, resetProfileCache, sanitizeProfile, verifyCommandFromProfile } from "../src/profile.ts";

describe("profile: sanitizeProfile", () => {
  it("keeps known fields and drops unknown/wrong types", () => {
    const cleaned = sanitizeProfile({
      verify: ["npm test", "  ", ""],
      model: " deepseek-v4-pro ",
      verifyContainer: " swift:6.0 ",
      maxAttempts: 2,
      protectedPaths: ["src/generated/"],
      unknownKey: "ignored",
      sensitivePaths: "not-an-array",
      maxPrsPerDay: -1,
    });
    assert.deepEqual(cleaned, {
      verify: ["npm test"],
      model: "deepseek-v4-pro",
      verifyContainer: "swift:6.0",
      maxAttempts: 2,
      protectedPaths: ["src/generated/"],
    });
  });

  it("keeps a valid locale and prompts dir, drops traversal attempts", () => {
    const kept = sanitizeProfile({ locale: "zh_CN", promptsDir: "swift/" });
    assert.equal(kept.locale, "zh-cn");
    assert.equal(kept.promptsDir, "swift");

    const dropped = sanitizeProfile({ locale: "../../etc", promptsDir: "../secrets" });
    assert.equal(dropped.locale, undefined);
    assert.equal(dropped.promptsDir, undefined);
  });

  it("normalises runsOn from a string or a label array", () => {
    assert.deepEqual(sanitizeProfile({ runsOn: "macos-26" }).runsOn, ["macos-26"]);
    assert.deepEqual(sanitizeProfile({ runsOn: ["self-hosted", "macos"] }).runsOn, ["self-hosted", "macos"]);
    assert.equal(sanitizeProfile({ runsOn: ["", "  "] }).runsOn, undefined);
    assert.equal(sanitizeProfile({ runsOn: 42 }).runsOn, undefined);
  });

  it("returns {} for junk", () => {
    assert.deepEqual(sanitizeProfile(null), {});
    assert.deepEqual(sanitizeProfile("x"), {});
    assert.deepEqual(sanitizeProfile([]), {});
  });
});

describe("profile: config/repos.json", () => {
  afterEach(() => resetProfileCache());

  it("applies the OrzMCApp profile", () => {
    const profile = profileFor("OrzMC/OrzMCApp");
    assert.equal(verifyCommandFromProfile(profile), "bash scripts/check-platform-split.sh");
    assert.equal(profile.learningsFile, "docs/iteration-flow.md");
    assert.ok(profile.protectedPaths?.includes("Sources/"));
  });

  it("returns no repository-specific overrides for unknown repositories", () => {
    const unknown = profileFor("nobody/nothing");
    // `_defaults` still applies (e.g. the prompt locale), but nothing from a
    // concrete repository entry leaks in.
    assert.equal(unknown.verify, undefined);
    assert.equal(unknown.learningsFile, undefined);
    assert.equal(verifyCommandFromProfile(unknown), null);
  });

  it("applies _defaults to every repository", () => {
    assert.equal(profileFor("nobody/nothing").locale, "zh-cn");
    assert.equal(profileFor("OrzMC/OrzMCApp").locale, "zh-cn");
  });

  it("joins multiple commands with &&", () => {
    assert.equal(verifyCommandFromProfile({ verify: ["a", "b"] }), "a && b");
    assert.equal(verifyCommandFromProfile({}), null);
  });
});

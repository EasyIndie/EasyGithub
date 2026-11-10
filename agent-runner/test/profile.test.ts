import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { profileFor, resetProfileCache, sanitizeProfile, verifyCommandFromProfile } from "../src/profile.ts";

describe("profile: sanitizeProfile", () => {
  it("keeps known fields and drops unknown/wrong types", () => {
    const cleaned = sanitizeProfile({
      verify: ["npm test", "  ", ""],
      model: " deepseek-v4-pro ",
      maxAttempts: 2,
      protectedPaths: ["src/generated/"],
      unknownKey: "ignored",
      sensitivePaths: "not-an-array",
      maxPrsPerDay: -1,
    });
    assert.deepEqual(cleaned, {
      verify: ["npm test"],
      model: "deepseek-v4-pro",
      maxAttempts: 2,
      protectedPaths: ["src/generated/"],
    });
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

  it("returns no overrides for unknown repositories", () => {
    assert.deepEqual(profileFor("nobody/nothing"), {});
    assert.equal(verifyCommandFromProfile(profileFor("nobody/nothing")), null);
  });

  it("joins multiple commands with &&", () => {
    assert.equal(verifyCommandFromProfile({ verify: ["a", "b"] }), "a && b");
    assert.equal(verifyCommandFromProfile({}), null);
  });
});

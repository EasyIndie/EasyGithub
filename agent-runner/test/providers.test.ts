import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { knownProviders, registerProvider, resolveProvider } from "../src/providers/index.ts";
import type { Provider } from "../src/providers/types.ts";

const noop = () => undefined;

function fakeProvider(name: string): Provider {
  return {
    name,
    capabilities: {
      zeroFileMode: false,
      atomicClaim: false,
      autoMerge: false,
      draftPullRequests: false,
      incidentLatch: false,
    },
    issues: {
      get: () => ({ number: 1, title: "", body: "", url: "", labels: [] }),
      labels: () => [],
      addLabel: noop,
      removeLabel: noop,
      ensureLabel: noop,
      commentFromFile: noop,
      recentHumanComments: () => [],
    },
    pulls: {
      create: () => ({ number: 1, url: "" }),
      armAutoMerge: () => ({ ok: false, detail: "not supported" }),
      countRecent: () => 0,
    },
    locks: {
      acquire: () => "unavailable",
      release: noop,
    },
    incidents: { hasOpen: () => false },
  };
}

describe("provider registry", () => {
  const saved = process.env.EASYGH_PROVIDER;
  afterEach(() => {
    if (saved === undefined) delete process.env.EASYGH_PROVIDER;
    else process.env.EASYGH_PROVIDER = saved;
  });

  it("defaults to github", () => {
    assert.deepEqual(knownProviders(), ["github"]);
    assert.equal(resolveProvider().name, "github");
  });

  it("honours EASYGH_PROVIDER", () => {
    process.env.EASYGH_PROVIDER = "GitHub";
    assert.equal(resolveProvider().name, "github");
  });

  it("fails loudly for a platform that is not implemented", () => {
    assert.throws(() => resolveProvider("gitlab"), /Unknown provider "gitlab"/);
    assert.throws(() => resolveProvider("gitlab"), /src\/providers/);
  });

  it("github advertises the capabilities the runner relies on", () => {
    const caps = resolveProvider("github").capabilities;
    assert.equal(caps.atomicClaim, true);
    assert.equal(caps.autoMerge, true);
    assert.equal(caps.draftPullRequests, true);
    assert.equal(caps.incidentLatch, true);
    assert.equal(caps.zeroFileMode, true);
  });

  it("accepts another implementation through the seam", () => {
    const fake = fakeProvider("fake");
    registerProvider(fake);
    assert.equal(resolveProvider("fake"), fake);
    assert.equal(fake.issues.labels({ repo: "a/b", number: 1 }).length, 0);
    assert.equal(fake.locks.acquire({ repo: "a/b", number: 1 }, { defaultBranch: "main", ttlMs: 1 }), "unavailable");
  });
});

import {
  acquireLock,
  addLabel,
  commentFromFile,
  countRecentAiPrs,
  createPr,
  ensureLabel,
  getIssue,
  hasOpenIncident,
  listLabels,
  mergePrAuto,
  recentHumanComments,
  releaseLock,
  removeLabel,
} from "../github.ts";
import type { Provider } from "./types.ts";

/**
 * GitHub implementation: the `gh` CLI (repo issue/PR APIs) plus the tag-ref
 * claim lock the dispatcher also uses.
 *
 * App-mode discovery, workflow dispatch and rulesets stay in
 * `dispatcher.ts` / `watch.ts` / `.github/workflows` — they are GitHub-only and
 * are advertised through `capabilities.zeroFileMode`.
 */
export const githubProvider: Provider = {
  name: "github",
  capabilities: {
    zeroFileMode: true,
    atomicClaim: true,
    autoMerge: true,
    draftPullRequests: true,
    incidentLatch: true,
  },
  issues: {
    get: (ref) => getIssue(ref.repo, ref.number),
    labels: (ref) => listLabels(ref.repo, ref.number),
    addLabel: (ref, label) => addLabel(ref.repo, ref.number, label),
    removeLabel: (ref, label) => removeLabel(ref.repo, ref.number, label),
    ensureLabel: (repo, label) => ensureLabel(repo, label),
    commentFromFile: (ref, bodyFile) => commentFromFile(ref.repo, ref.number, bodyFile),
    recentHumanComments: (ref, limit) => recentHumanComments(ref.repo, ref.number, limit),
  },
  pulls: {
    create: (spec) =>
      createPr(spec.repo, {
        base: spec.base,
        head: spec.head,
        title: spec.title,
        bodyFile: spec.bodyFile,
        ...(spec.draft ? { draft: true } : {}),
      }),
    armAutoMerge: (repo, prNumber) => mergePrAuto(repo, prNumber),
    countRecent: (repo, hours) => countRecentAiPrs(repo, hours),
  },
  locks: {
    acquire: (ref, opts) => acquireLock(ref.repo, ref.number, opts),
    release: (ref) => releaseLock(ref.repo, ref.number),
  },
  incidents: {
    hasOpen: (repo) => hasOpenIncident(repo),
  },
};

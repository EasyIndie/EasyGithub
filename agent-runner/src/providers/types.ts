/**
 * Platform abstraction.
 *
 * The runner talks to a "provider" for everything that is not plain git:
 * issues, labels, comments, pull requests, auto-merge and the claim lock.
 * `github.ts` is the current implementation; GitLab/Gitea would implement the
 * same interface in `src/providers/<name>.ts` and be selected with
 * `EASYGH_PROVIDER`.
 *
 * Deliberately small and capability-flagged: a provider that cannot do
 * auto-merge or a server-side claim lock advertises that, so the runner can
 * degrade instead of guessing.
 */

export interface IssueRef {
  /** owner/name */
  repo: string;
  number: number;
}

export interface IssueInfo {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
}

export interface HumanComment {
  author: string;
  association: string;
  body: string;
  createdAt: string;
}

export interface PrInfo {
  number: number;
  url: string;
}

export interface CreatePrSpec {
  repo: string;
  base: string;
  head: string;
  title: string;
  bodyFile: string;
  draft?: boolean;
}

export type LockState = "acquired" | "busy" | "unavailable";

export interface LockOptions {
  defaultBranch: string;
  ttlMs: number;
}

/** What a provider can do; the runner degrades gracefully when a flag is false. */
export interface ProviderCapabilities {
  /** discover repositories through an app installation (zero-file mode) */
  zeroFileMode: boolean;
  /** server-side compare-and-swap claim lock */
  atomicClaim: boolean;
  /** arm merge-when-checks-pass without a human click */
  autoMerge: boolean;
  /** create draft pull requests (unmergeable until marked ready) */
  draftPullRequests: boolean;
  /** open incidents latch auto-merge off */
  incidentLatch: boolean;
}

export interface IssueApi {
  get(ref: IssueRef): IssueInfo;
  labels(ref: IssueRef): string[];
  addLabel(ref: IssueRef, label: string): void;
  removeLabel(ref: IssueRef, label: string): void;
  ensureLabel(repo: string, label: string): void;
  commentFromFile(ref: IssueRef, bodyFile: string): void;
  /** trusted (maintainer) comments, oldest first */
  recentHumanComments(ref: IssueRef, limit?: number): HumanComment[];
}

export interface PullRequestApi {
  create(spec: CreatePrSpec): PrInfo;
  armAutoMerge(repo: string, prNumber: number): { ok: boolean; detail: string };
  /** how many pipeline PRs were opened in the last `hours` (quota) */
  countRecent(repo: string, hours: number): number;
}

export interface LockApi {
  acquire(ref: IssueRef, opts: LockOptions): LockState;
  release(ref: IssueRef): void;
}

export interface IncidentApi {
  hasOpen(repo: string): boolean;
}

export interface Provider {
  name: string;
  capabilities: ProviderCapabilities;
  issues: IssueApi;
  pulls: PullRequestApi;
  locks: LockApi;
  incidents: IncidentApi;
}

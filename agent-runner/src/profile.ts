import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Per-repository profile: the project-specific knobs that used to be hardcoded
 * for EasyGithub itself.
 *
 * Profiles live in the HUB (`agent-runner/config/repos.json`), not in the
 * target repository: zero-file (App) targets cannot host pipeline files, and a
 * central, reviewable file is auditable.
 *
 * Precedence (lowest to highest):
 *   built-in defaults -> config/repos.json "_defaults" -> config/repos.json
 *   "<owner>/<repo>" -> legacy config/verify.json -> environment overrides.
 *
 * Lists (protected/blocked/ignored) replace the built-in value when present;
 * a few trust anchors (`.github/`, `.git/`, `LICENSE`) are always kept by the
 * callers regardless of the profile.
 */
export interface RepoProfile {
  /** verification commands, run in order joined by ` && ` */
  verify?: string[];
  verifyTimeoutMs?: number;
  /** Docker image used to run verification (e.g. "swift:6.0", "mcr.microsoft.com/dotnet/sdk:8.0") */
  verifyContainer?: string;
  /**
   * Runner labels for this repository. When set, the dispatcher hands the
   * issue to `.github/workflows/ai-run.yml` on those labels (self-hosted
   * macOS/Windows included) instead of running on the hub's ubuntu runner.
   */
  runsOn?: string[];
  /** path prefixes that make a change high-risk (draft PR + code owner) */
  protectedPaths?: string[];
  protectedFiles?: string[];
  /** path prefixes that the pipeline refuses to commit at all */
  blockedPaths?: string[];
  blockedFiles?: string[];
  /** allowed, but always flagged for human review */
  sensitivePaths?: string[];
  sensitiveFiles?: string[];
  /** never committed (vendored / generated) */
  ignoredPaths?: string[];
  /** dependency manifests: changing them is a supply-chain decision */
  dependencyFiles?: string[];
  /** repository knowledge injected into TASK.md */
  learningsFile?: string;
  agent?: string;
  model?: string;
  maxAttempts?: number;
  maxPrsPerDay?: number;
}

interface ProfileFile {
  _defaults?: RepoProfile;
  repos?: Record<string, RepoProfile>;
}

const CONFIG_URL = new URL("../config/repos.json", import.meta.url);
const LEGACY_VERIFY_URL = new URL("../config/verify.json", import.meta.url);

let cached: ProfileFile | undefined;

function loadFile(): ProfileFile {
  if (cached !== undefined) return cached;
  let file: ProfileFile = {};
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_URL, "utf8")) as unknown;
    if (parsed && typeof parsed === "object") file = parsed as ProfileFile;
  } catch {
    // no profile file -> defaults only
  }
  cached = file;
  return file;
}

/** Reset the cache (tests). */
export function resetProfileCache(): void {
  cached = undefined;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

const LIST_KEYS = [
  "verify",
  "protectedPaths",
  "protectedFiles",
  "blockedPaths",
  "blockedFiles",
  "sensitivePaths",
  "sensitiveFiles",
  "ignoredPaths",
  "dependencyFiles",
] as const;
const STRING_KEYS = ["learningsFile", "agent", "model", "verifyContainer"] as const;
/** Accepts a string or an array of strings. */
const RUNNER_KEYS = ["runsOn"] as const;
const NUMBER_KEYS = ["verifyTimeoutMs", "maxAttempts", "maxPrsPerDay"] as const;

/** Drop unknown keys / wrong types so a typo cannot silently misconfigure a repo. */
export function sanitizeProfile(raw: unknown): RepoProfile {
  if (!raw || typeof raw !== "object") return {};
  const out: RepoProfile = {};
  const source = raw as Record<string, unknown>;
  for (const key of LIST_KEYS) {
    if (isStringArray(source[key])) {
      const values = (source[key] as string[]).map((v) => v.trim()).filter(Boolean);
      if (values.length > 0) out[key] = values;
    }
  }
  for (const key of STRING_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
  }
  for (const key of RUNNER_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) out.runsOn = [value.trim()];
    else if (isStringArray(value)) {
      const labels = value.map((v) => v.trim()).filter(Boolean);
      if (labels.length > 0) out.runsOn = labels;
    }
  }
  for (const key of NUMBER_KEYS) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) out[key] = value;
  }
  return out;
}

function merge(base: RepoProfile, override: RepoProfile): RepoProfile {
  const out: RepoProfile = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/** Legacy `config/verify.json`: { "owner/repo": "cmd" | { cmd, timeout_ms } } */
function legacyVerify(repo: string): RepoProfile {
  try {
    const map = JSON.parse(readFileSync(LEGACY_VERIFY_URL, "utf8")) as Record<string, unknown>;
    const value = map[repo];
    if (typeof value === "string" && value.trim()) return { verify: [value.trim()] };
    if (value && typeof value === "object") {
      const obj = value as { cmd?: unknown; timeout_ms?: unknown };
      const profile: RepoProfile = {};
      if (typeof obj.cmd === "string" && obj.cmd.trim()) profile.verify = [obj.cmd.trim()];
      if (typeof obj.timeout_ms === "number" && obj.timeout_ms > 0) profile.verifyTimeoutMs = obj.timeout_ms;
      return profile;
    }
  } catch {
    // no legacy file -> fine
  }
  return {};
}

/** Resolve the effective profile for a repository (cached per process). */
export function profileFor(repo: string): RepoProfile {
  const file = loadFile();
  const base = sanitizeProfile(file._defaults);
  const repoProfile = sanitizeProfile(file.repos?.[repo]);
  return merge(merge(base, repoProfile), legacyVerify(repo));
}

/** Learnings file the pipeline should read, if the profile overrides it. */
export function learningsFileFor(repo: string): string | undefined {
  return profileFor(repo).learningsFile;
}

/** Flatten configured verify commands into one shell command. */
export function verifyCommandFromProfile(profile: RepoProfile): string | null {
  if (!profile.verify || profile.verify.length === 0) return null;
  return profile.verify.join(" && ");
}

/** Convenience for tests / callers that need the config path (debug logs). */
export function profileConfigPath(): string {
  return join(new URL(".", CONFIG_URL).pathname, "repos.json");
}

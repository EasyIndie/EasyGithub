import { runSync } from "./util/exec.ts";
import { stageAll, stagedPaths, unstage } from "./git.ts";

/**
 * Guardrails applied to the agent's working tree before anything is committed.
 *
 * The agent works on untrusted instructions (an issue body) with write access
 * to a checkout, so the runner — not the prompt — decides what may land:
 *
 *   - BLOCKED paths are removed from the index and fail the run
 *     (pipeline recursion + the license, which must stay human-owned).
 *   - SENSITIVE paths are allowed but always flagged `ai-core` so a human
 *     reviews changes to the runner / CI / installers.
 *   - Vendored or generated trees are never committed, even in repositories
 *     that forget to .gitignore them.
 *   - Added lines are scanned for credential material.
 */

export interface SecretFinding {
  file: string;
  line: number;
  pattern: string;
}

export interface AuditResult {
  ok: boolean;
  /** every staged path (after vendored/scratch files were dropped) */
  paths: string[];
  /** staged paths that must not be committed (run fails) */
  blocked: string[];
  /** staged paths that need human review (allowed, flagged) */
  sensitive: string[];
  /** files removed from the index because they are vendored/generated */
  ignored: string[];
  secrets: SecretFinding[];
}

/** Hard rejections: these would let the agent rewrite its own pipeline. */
const BLOCKED_PREFIXES = [".git/", ".github/workflows/", ".github/actions/"];
const BLOCKED_FILES = ["LICENSE", "LICENCE", "TASK.md"];

/** Always rejected, even when a repository profile narrows the lists. */
const BASELINE_BLOCKED_PREFIXES = [".git/", ".github/workflows/", ".github/actions/"];

/** Allowed, but flagged for mandatory human review. */
const SENSITIVE_PREFIXES = ["agent-runner/", ".github/", "scripts/"];
const SENSITIVE_FILES = ["package.json", "package-lock.json", "tsconfig.json"];

/** Vendored / generated trees that must never be committed by the pipeline. */
const IGNORED_PREFIXES = [
  "node_modules/",
  ".venv/",
  "venv/",
  "target/",
  "dist/",
  "build/",
  ".next/",
  ".cache/",
  "coverage/",
  "vendor/",
  "__pycache__/",
  ".pytest_cache/",
  ".tmp/",
  ".gradle/",
];

/** Generated/scratch files that the pipeline owns and never ships. */
const IGNORED_SUFFIXES = [".log", ".tsbuildinfo"];

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["openai/deepseek key", /\bsk-[A-Za-z0-9_-]{16,}/],
  ["github token", /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  ["github fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ["aws access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["google api key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
];

function normalize(path: string): string {
  return path.replace(/^\.\//, "");
}

interface PathRules {
  blockedPaths?: string[];
  blockedFiles?: string[];
  sensitivePaths?: string[];
  sensitiveFiles?: string[];
  ignoredPaths?: string[];
}

function isBlocked(path: string, rules: PathRules = {}): boolean {
  const p = normalize(path);
  const prefixes = [...BASELINE_BLOCKED_PREFIXES, ...(rules.blockedPaths ?? BLOCKED_PREFIXES)];
  const files = [...BLOCKED_FILES, ...(rules.blockedFiles ?? [])];
  return files.includes(p) || prefixes.some((prefix) => p.startsWith(prefix));
}

function isSensitive(path: string, rules: PathRules = {}): boolean {
  const p = normalize(path);
  const files = [...SENSITIVE_FILES, ...(rules.sensitiveFiles ?? [])];
  const prefixes = [...SENSITIVE_PREFIXES, ...(rules.sensitivePaths ?? [])];
  return files.includes(p) || prefixes.some((prefix) => p.startsWith(prefix));
}

function isIgnored(path: string, rules: PathRules = {}): boolean {
  const p = normalize(path);
  const ignored = [...IGNORED_PREFIXES, ...(rules.ignoredPaths ?? [])];
  return (
    ignored.some((prefix) => p.startsWith(prefix)) ||
    IGNORED_SUFFIXES.some((suffix) => p.endsWith(suffix)) ||
    p === "TASK.md" ||
    p === "EASYGH_BLOCKED.md"
  );
}

/**
 * Stage the working tree for commit, then unstage everything the pipeline
 * refuses to ship (vendored trees, logs, scratch task files).
 */
export function stageChanges(cwd: string, rules: PathRules = {}): { ignored: string[] } {
  stageAll(cwd);
  const staged = stagedPaths(cwd);
  const ignored = staged.filter((path) => isIgnored(path, rules));
  if (ignored.length > 0) unstage(cwd, ignored);
  return { ignored };
}

/** Scan the staged diff for credential material (added lines only). */
export function scanStagedDiff(cwd: string): SecretFinding[] {
  const res = runSync("git", ["diff", "--cached", "-U0", "--no-color"], { cwd });
  if (res.status !== 0) {
    throw new Error(`git diff --cached failed: ${res.stderr.trim()}`);
  }
  // Bound the work on very large diffs (2 MiB is far beyond a reviewable patch).
  const diff = res.stdout.slice(0, 2 * 1024 * 1024);

  const findings: SecretFinding[] = [];
  let file = "";
  let line = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      file = raw.slice(4).replace(/^b\//, "").replace(/^"|"$/g, "");
      line = 0;
      continue;
    }
    if (raw.startsWith("@@")) {
      const match = /\+(\d+)/.exec(raw);
      line = match?.[1] ? Number(match[1]) : 0;
      continue;
    }
    if (raw.startsWith("+")) {
      const content = raw.slice(1);
      for (const [name, pattern] of SECRET_PATTERNS) {
        if (pattern.test(content)) findings.push({ file, line, pattern: name });
      }
      line++;
      continue;
    }
    if (raw.startsWith(" ")) line++;
  }
  return findings;
}

/** Inspect the staged change set before committing. */
export function auditStagedChanges(cwd: string, rules: PathRules = {}): AuditResult {
  const staged = stagedPaths(cwd);
  const blocked = staged.filter((path) => isBlocked(path, rules));
  const sensitive = staged.filter((path) => !isBlocked(path, rules) && isSensitive(path, rules));
  const secrets = scanStagedDiff(cwd);
  return { ok: blocked.length === 0 && secrets.length === 0, paths: staged, blocked, sensitive, ignored: [], secrets };
}

/** Human-readable summary for the issue comment (never includes secret values). */
export function describeAudit(audit: AuditResult): string {
  const lines: string[] = [];
  if (audit.blocked.length > 0) {
    lines.push("被拒绝的路径（流水线不允许 AI 修改）：");
    for (const p of audit.blocked) lines.push(`- \`${p}\``);
  }
  if (audit.secrets.length > 0) {
    lines.push("改动中检测到疑似密钥（值未记录）：");
    for (const s of audit.secrets) lines.push(`- \`${s.file}:${s.line}\` → ${s.pattern}`);
  }
  return lines.join("\n");
}

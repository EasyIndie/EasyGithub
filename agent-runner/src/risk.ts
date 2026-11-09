/**
 * Risk classification for agent-produced changes.
 *
 * The single question this answers: **may a human be skipped?**
 *
 * - `high`   -> draft PR + code owner review (see .github/CODEOWNERS)
 * - `medium` -> ready PR, human reviews at leisure
 * - `low`    -> eligible for auto-merge (still subject to required checks)
 *
 * The rules are deliberately conservative: when in doubt, escalate. Keep
 * HIGH_PREFIXES in sync with .github/CODEOWNERS.
 */

export type RiskLevel = "low" | "medium" | "high";

export interface RiskInput {
  /** staged paths (repo-relative) */
  paths: string[];
  /** added + removed lines in the staged diff */
  changedLines: number;
  verify: { verified: boolean; tampered: boolean; skipped: boolean } | null;
}

export interface RiskAssessment {
  level: RiskLevel;
  reasons: string[];
}

/** Trust boundary + pipeline: humans own these forever. */
const HIGH_PREFIXES = [".github/", "agent-runner/", "scripts/", "eval/"];
const HIGH_FILES = ["LICENSE", "LICENCE", ".github/CODEOWNERS"];

/** Dependency manifests: a new dependency is a supply-chain decision. */
const DEPENDENCY_FILES = [
  "package.json",
  "package-lock.json",
  "Cargo.toml",
  "Cargo.lock",
  "go.mod",
  "go.sum",
  "pyproject.toml",
  "requirements.txt",
  "Gemfile",
  "Gemfile.lock",
];

const MEDIUM_LINE_LIMIT = 200;
const MEDIUM_FILE_LIMIT = 10;
const HIGH_LINE_LIMIT = 500;

function normalize(path: string): string {
  return path.replace(/^\.\//, "");
}

export function assessRisk(input: RiskInput): RiskAssessment {
  const reasons: string[] = [];
  let level: RiskLevel = "low";
  const rank: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };
  const bump = (next: RiskLevel, why: string) => {
    reasons.push(why);
    if (rank[next] > rank[level]) level = next;
  };

  const paths = input.paths.map(normalize);
  const protectedPaths = paths.filter(
    (p) => HIGH_FILES.includes(p) || HIGH_PREFIXES.some((prefix) => p.startsWith(prefix)),
  );
  if (protectedPaths.length > 0) {
    bump("high", `touches protected path(s): ${protectedPaths.slice(0, 4).join(", ")}`);
  }

  const dependencyChanges = paths.filter((p) => DEPENDENCY_FILES.includes(p));
  if (dependencyChanges.length > 0) {
    bump("high", `changes dependency manifest(s): ${dependencyChanges.join(", ")}`);
  }

  if (input.changedLines > HIGH_LINE_LIMIT) {
    bump("high", `large diff (${input.changedLines} lines > ${HIGH_LINE_LIMIT})`);
  } else if (input.changedLines > MEDIUM_LINE_LIMIT) {
    bump("medium", `diff is ${input.changedLines} lines (> ${MEDIUM_LINE_LIMIT})`);
  }

  if (paths.length > MEDIUM_FILE_LIMIT) {
    bump("medium", `touches ${paths.length} files (> ${MEDIUM_FILE_LIMIT})`);
  }

  if (input.verify) {
    if (input.verify.skipped) bump("high", "no repository check was run (unverified)");
    if (input.verify.tampered) bump("high", "the check gate was modified during the run");
    if (!input.verify.verified && !input.verify.skipped) bump("high", "verification did not run on a frozen gate");
  } else {
    bump("high", "no verification result");
  }

  if (reasons.length === 0) reasons.push("small, verified, non-protected change");
  return { level, reasons };
}

export type AutoMergeMode = "off" | "probation" | "on";

export function parseAutoMergeMode(raw: string | undefined): AutoMergeMode {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "on" || value === "true" || value === "1") return "on";
  if (value === "probation") return "probation";
  return "off";
}

/** Docs/tests only: the safe sandbox for the "probation" trust ramp. */
export function isDocsOrTestsOnly(paths: string[]): boolean {
  if (paths.length === 0) return false;
  return paths.every((raw) => {
    const p = normalize(raw);
    return (
      p.endsWith(".md") ||
      p.startsWith("docs/") ||
      p.startsWith("documentation/") ||
      /(^|\/)test\//.test(p) ||
      /\.test\.[cm]?[jt]sx?$/.test(p) ||
      /(^|\/)tests?\//.test(p)
    );
  });
}

export interface AutoMergeDecision {
  allowed: boolean;
  reason: string;
}

/**
 * Auto-merge predicate. `off` is the default everywhere: a repository opts in
 * explicitly via `AI_AUTOMERGE`, and probation only trusts docs/tests.
 */
export function autoMergeDecision(args: {
  mode: AutoMergeMode;
  risk: RiskAssessment;
  verify: { verified: boolean; tampered: boolean; skipped: boolean } | null;
  paths: string[];
}): AutoMergeDecision {
  if (args.mode === "off") return { allowed: false, reason: "auto-merge is off (AI_AUTOMERGE=off)" };
  if (args.risk.level !== "low") return { allowed: false, reason: `risk is ${args.risk.level}` };
  if (!args.verify || !args.verify.verified || args.verify.tampered || args.verify.skipped) {
    return { allowed: false, reason: "verification is not trusted (unverified or gate changed)" };
  }
  if (args.mode === "probation" && !isDocsOrTestsOnly(args.paths)) {
    return { allowed: false, reason: "probation mode only auto-merges docs/tests changes" };
  }
  return { allowed: true, reason: args.mode === "probation" ? "probation: docs/tests only" : "low risk + verified" };
}

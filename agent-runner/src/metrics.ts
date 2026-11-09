import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * One machine-readable record per run.
 *
 * Written to the run directory (uploaded as a workflow artifact, 7 days) and
 * echoed as a single JSON log line so it can be scraped by the weekly retro.
 * Deliberately flat and stable: adding fields is fine, renaming is not.
 */
export interface RunMetrics {
  repo: string;
  issue: number;
  kind: string;
  agent: string;
  provider: string;
  model: string;
  outcome: "pr" | "done" | "failed" | "blocked" | "deferred";
  risk: string;
  riskReasons: string[];
  changedFiles: number;
  changedLines: number;
  verified: boolean;
  tampered: boolean;
  skipped: boolean;
  attempts: number;
  verifyCommand: string;
  automerge: boolean;
  pr?: number;
  durationMs: number;
}

export function writeMetrics(runDir: string, metrics: RunMetrics): string {
  const file = join(runDir, "metrics.json");
  writeFileSync(file, `${JSON.stringify(metrics, null, 2)}\n`, "utf8");
  return file;
}

/** Single-line form for `[runner] metrics ...` logs. */
export function metricsLine(metrics: RunMetrics): string {
  return JSON.stringify(metrics);
}

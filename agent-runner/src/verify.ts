import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runAsync } from "./util/exec.ts";

/**
 * Independent referee: run the repository's own checks on the working tree
 * WITHOUT trusting the agent's self-reported results.
 *
 * Command resolution order:
 *   1. env VERIFY_CMD (explicit override, e.g. "npm run lint && npm test")
 *   2. first existing script among check / verify / test / lint in package.json
 *   3. language heuristics (Cargo.toml -> cargo test, go.mod -> go test ./...)
 *   4. none -> skipped (reported as unverified, NOT as "passed")
 *
 * The gate is captured BEFORE the agent runs (`captureVerifySpec`) and frozen
 * for the rest of the run. Otherwise an agent could edit `package.json` (or the
 * check script) to make its own work pass. If the gate changed, the frozen
 * script body is executed instead, and the result is marked `tampered`.
 */

export interface VerifySpec {
  /** Gate command resolved before the agent ran; null when nothing was found. */
  command: string | null;
  /** Inline npm script body for `npm run <cmd>`, run when the gate was modified. */
  scriptBody: string | null;
  /** Hash of the gate configuration at capture time. */
  fingerprint: string;
}

export interface VerifyResult {
  ok: boolean;
  skipped: boolean;
  /** A real check ran against an unmodified gate. */
  verified: boolean;
  /** The repository's check configuration changed after capture. */
  tampered: boolean;
  command: string;
  /** combined output of dependency install (if any) and the check command */
  output: string;
  timedOut: boolean;
}

const GATE_FILES = ["Cargo.toml", "go.mod", "pytest.ini", "tox.ini"];

interface Gate {
  command: string | null;
  scriptBody: string | null;
}

async function resolveGate(workDir: string): Promise<Gate> {
  const override = process.env.VERIFY_CMD?.trim();
  if (override) return { command: override, scriptBody: null };

  try {
    const pkg = JSON.parse(await readFile(join(workDir, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};
    for (const name of ["check", "verify", "test", "lint"]) {
      const body = scripts[name];
      if (body !== undefined) return { command: `npm run ${name}`, scriptBody: body };
    }
  } catch {
    // no package.json (or unreadable) -> try language heuristics
  }

  // Non-Node repositories: only run a check when the toolchain file is present
  // and the command is self-contained (dependency fetch is part of the command).
  if (existsSync(join(workDir, "Cargo.toml"))) return { command: "cargo test", scriptBody: null };
  if (existsSync(join(workDir, "go.mod"))) return { command: "go test ./...", scriptBody: null };
  if (existsSync(join(workDir, "pytest.ini")) || existsSync(join(workDir, "tox.ini"))) {
    return { command: "python -m pytest -q", scriptBody: null };
  }
  return { command: null, scriptBody: null };
}

/** Backwards-compatible helper: the command only. */
export async function resolveCommand(workDir: string): Promise<string | null> {
  return (await resolveGate(workDir)).command;
}

async function gateFingerprint(workDir: string, command: string | null): Promise<string> {
  const parts: string[] = [`command:${command ?? "(none)"}`, `override:${process.env.VERIFY_CMD ?? ""}`];
  try {
    const pkg = JSON.parse(await readFile(join(workDir, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    parts.push(`scripts:${JSON.stringify(pkg.scripts ?? {})}`);
    parts.push(`dev:${JSON.stringify(pkg.devDependencies ?? {})}`);
    parts.push(`deps:${JSON.stringify(pkg.dependencies ?? {})}`);
  } catch {
    parts.push("package.json:absent");
  }
  for (const file of GATE_FILES) parts.push(`${file}:${existsSync(join(workDir, file))}`);
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

/** Snapshot the gate before the agent is allowed to touch anything. */
export async function captureVerifySpec(workDir: string): Promise<VerifySpec> {
  const gate = await resolveGate(workDir);
  return {
    command: gate.command,
    scriptBody: gate.scriptBody,
    fingerprint: await gateFingerprint(workDir, gate.command),
  };
}

async function ensureDeps(workDir: string, timeoutMs: number): Promise<{ command: string | null; output: string; ok: boolean }> {
  if (existsSync(join(workDir, "node_modules"))) return { command: null, output: "", ok: true };
  if (!existsSync(join(workDir, "package.json"))) return { command: null, output: "", ok: true };
  const hasLock = existsSync(join(workDir, "package-lock.json"));
  // --no-package-lock: the install is a side effect of verification, it must
  // not add a lockfile to the agent's diff.
  const command = hasLock
    ? "npm ci --no-audit --no-fund"
    : "npm install --no-audit --no-fund --no-package-lock";
  let output = "";
  const res = await runAsync("bash", ["-c", command], {
    cwd: workDir,
    timeoutMs,
    onStdout: (s) => (output += s),
    onStderr: (s) => (output += s),
  });
  return { command, output: output.trim(), ok: res.ok && !res.timedOut };
}

function clampTimeout(ms: number): number {
  return Math.max(30_000, Math.min(ms, 60 * 60 * 1000));
}

export async function runVerify(
  workDir: string,
  spec: VerifySpec,
  timeoutMs: number,
): Promise<VerifyResult> {
  if (!spec.command) {
    return {
      ok: true,
      skipped: true,
      verified: false,
      tampered: false,
      command: "",
      output: "(no check/test script found; verification skipped — result is NOT verified)",
      timedOut: false,
    };
  }

  const budgetMs = clampTimeout(timeoutMs);
  const tampered = (await gateFingerprint(workDir, spec.command)) !== spec.fingerprint;

  const deps = await ensureDeps(workDir, budgetMs);
  if (!deps.ok) {
    return {
      ok: false,
      skipped: false,
      verified: false,
      tampered,
      command: deps.command ?? "(dependency install)",
      output: deps.output.slice(0, 6000),
      timedOut: false,
    };
  }

  // Trusted target: normally the frozen command. If the gate was modified, run
  // the script body captured before the agent ran (npm's local bin on PATH).
  const runBody = tampered && spec.scriptBody !== null;
  const target = runBody ? spec.scriptBody as string : spec.command;
  const shellCommand = runBody ? `export PATH="$PWD/node_modules/.bin:$PATH"; ${target}` : target;

  let output = deps.output ? `$ ${deps.command}\n${deps.output}\n` : "";
  output += `$ ${runBody ? `(frozen) ${target}` : target}\n`;
  if (tampered) output += "(gate configuration changed during the run; executing the frozen version)\n";

  const res = await runAsync("bash", ["-c", shellCommand], {
    cwd: workDir,
    timeoutMs: budgetMs,
    onStdout: (s) => (output += s),
    onStderr: (s) => (output += s),
  });

  return {
    ok: res.ok && !res.timedOut,
    skipped: false,
    verified: !tampered,
    tampered,
    command: spec.command,
    output: output.slice(0, 6000),
    timedOut: res.timedOut,
  };
}

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runAsync, runSync } from "./util/exec.ts";
import { verifyCommandFromProfile, type RepoProfile } from "./profile.ts";

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
  /** Content hash of scripts the command invokes (e.g. `bash scripts/check.sh`). */
  gateFiles?: Record<string, string>;
  /** Docker image the verification must run in (profile `verifyContainer`). */
  container?: string;
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

const GATE_FILES = [
  "Cargo.toml",
  "go.mod",
  "pytest.ini",
  "tox.ini",
  "Package.swift",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "gradlew",
  "mix.exs",
];

interface Gate {
  command: string | null;
  scriptBody: string | null;
}

async function resolveGate(workDir: string, profile?: RepoProfile): Promise<Gate> {
  const override = process.env.VERIFY_CMD?.trim();
  if (override) return { command: override, scriptBody: null };

  // Repository profile (hub-side, reviewable) wins over heuristics.
  const configured = profile ? verifyCommandFromProfile(profile) : null;
  if (configured) return { command: configured, scriptBody: null };

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
  // More ecosystems: only when the manifest is present. The toolchain must
  // exist on the runner (Ubuntu for App mode), otherwise use a profile.
  if (existsSync(join(workDir, "Package.swift"))) return { command: "swift test", scriptBody: null };
  if (existsSync(join(workDir, "gradlew"))) return { command: "./gradlew check --console=plain", scriptBody: null };
  if (existsSync(join(workDir, "pom.xml"))) return { command: "mvn -q -B test", scriptBody: null };
  if (existsSync(join(workDir, "mix.exs"))) return { command: "mix test", scriptBody: null };
  return { command: null, scriptBody: null };
}

/** Backwards-compatible helper: the command only. */
export async function resolveCommand(workDir: string, profile?: RepoProfile): Promise<string | null> {
  return (await resolveGate(workDir, profile)).command;
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

/**
 * Files the command depends on (`bash scripts/check.sh`, `python tools/x.py`, …).
 *
 * Without this, an agent could "pass" by weakening the script that judges it —
 * the single most important self-reference hole for script-based projects.
 */
function hashedFiles(workDir: string, command: string | null): Record<string, string> {
  if (!command) return {};
  const out: Record<string, string> = {};
  const tokens = command.split(/[\s;&|()<>]+/);
  let count = 0;
  for (const token of tokens) {
    if (count >= 5) break;
    if (!token || token.startsWith("-") || token.includes("*")) continue;
    if (!/^[\w./-]+$/.test(token)) continue;
    if (!/\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|php|gradle|kts)$/.test(token) && !/Makefile$/.test(token)) continue;
    try {
      const content = readFileSync(join(workDir, token));
      if (content.length > 1024 * 1024) continue;
      out[token] = createHash("sha256").update(content).digest("hex");
      count++;
    } catch {
      // not a file in the worktree -> ignore
    }
  }
  return out;
}

/** Snapshot the gate before the agent is allowed to touch anything. */
export async function captureVerifySpec(workDir: string, profile?: RepoProfile): Promise<VerifySpec> {
  const gate = await resolveGate(workDir, profile);
  const gateFiles = hashedFiles(workDir, gate.command);
  const container = profile?.verifyContainer;
  return {
    command: gate.command,
    scriptBody: gate.scriptBody,
    fingerprint: `${await gateFingerprint(workDir, gate.command)}|scripts:${JSON.stringify(gateFiles)}|container:${container ?? ""}`,
    gateFiles,
    ...(container ? { container } : {}),
  };
}

export interface VerifyInvocation {
  binary: string;
  args: string[];
  /** human-readable form for logs / failure comments */
  display: string;
}

function hasBinary(name: string): boolean {
  return runSync("bash", ["-c", `command -v ${name}`]).status === 0;
}

/**
 * How the frozen gate is executed.
 *
 * A profile can pin a Docker image for toolchains that the runner does not
 * have (Swift, .NET, a specific JDK, …). The worktree is mounted read-write so
 * dependency managers can write caches into it.
 */
export function buildVerifyInvocation(spec: VerifySpec, tampered: boolean, workDir: string): VerifyInvocation {
  const body =
    tampered && spec.scriptBody ? `export PATH="$PWD/node_modules/.bin:$PATH"; ${spec.scriptBody}` : (spec.command ?? "");
  if (spec.container) {
    return {
      binary: "docker",
      args: ["run", "--rm", "-v", `${workDir}:/work`, "-w", "/work", "--entrypoint", "bash", spec.container, "-c", body],
      display: `docker run --rm -v ${workDir}:/work -w /work --entrypoint bash ${spec.container} -c ${JSON.stringify(body)}`,
    };
  }
  return { binary: "bash", args: ["-c", body], display: body };
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
  const fingerprintNow = `${await gateFingerprint(workDir, spec.command)}|scripts:${JSON.stringify(hashedFiles(workDir, spec.command))}|container:${spec.container ?? ""}`;
  const tampered = fingerprintNow !== spec.fingerprint;

  if (spec.container && !hasBinary("docker")) {
    return {
      ok: false,
      skipped: false,
      verified: false,
      tampered,
      command: spec.command,
      output: `verifyContainer is set (${spec.container}) but docker is not available on this runner`,
      timedOut: false,
    };
  }

  // In a container the image owns the toolchain; installing npm deps on the
  // host first would be wrong (binaries may not match).
  const deps = spec.container
    ? { command: null as string | null, output: "", ok: true }
    : await ensureDeps(workDir, budgetMs);
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
  const invocation = buildVerifyInvocation(spec, tampered, workDir);

  let output = deps.output ? `$ ${deps.command}\n${deps.output}\n` : "";
  output += `$ ${invocation.display}\n`;
  if (tampered) output += "(gate configuration changed during the run; executing the frozen version)\n";

  const res = await runAsync(invocation.binary, invocation.args, {
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

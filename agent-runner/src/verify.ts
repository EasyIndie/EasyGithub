import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runAsync } from "./util/exec.ts";

export interface VerifyResult {
  ok: boolean;
  skipped: boolean;
  command: string;
  /** combined output of dependency install (if any) and the check command */
  output: string;
  timedOut: boolean;
}

/**
 * Independent referee: run the repository's own checks on the working tree
 * WITHOUT trusting the agent's self-reported results.
 *
 * Command resolution order:
 *   1. env VERIFY_CMD (explicit override, e.g. "npm run lint && npm test")
 *   2. first existing script among check / verify / test / lint in package.json
 *   3. language heuristics (Cargo.toml -> cargo test, go.mod -> go test ./...)
 *   4. none -> skipped (treated as pass, logged)
 */
export async function resolveCommand(workDir: string): Promise<string | null> {
  const override = process.env.VERIFY_CMD?.trim();
  if (override) return override;
  try {
    const pkg = JSON.parse(await readFile(join(workDir, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};
    for (const name of ["check", "verify", "test", "lint"]) {
      if (scripts[name] !== undefined) return `npm run ${name}`;
    }
  } catch {
    // no package.json (or unreadable) -> try language heuristics
  }
  // Non-Node repositories: only run a check when the toolchain file is present
  // and the command is self-contained (dependency fetch is part of the command).
  if (existsSync(join(workDir, "Cargo.toml"))) return "cargo test";
  if (existsSync(join(workDir, "go.mod"))) return "go test ./...";
  if (existsSync(join(workDir, "pytest.ini")) || existsSync(join(workDir, "tox.ini"))) {
    return "python -m pytest -q";
  }
  return null;
}

async function ensureDeps(workDir: string, timeoutMs: number): Promise<{ command: string | null; output: string; ok: boolean }> {
  if (existsSync(join(workDir, "node_modules"))) return { command: null, output: "", ok: true };
  if (!existsSync(join(workDir, "package.json"))) return { command: null, output: "", ok: true };
  const hasLock = existsSync(join(workDir, "package-lock.json"));
  const command = hasLock ? "npm ci --no-audit --no-fund" : "npm install --no-audit --no-fund";
  let output = "";
  const res = await runAsync("bash", ["-c", command], {
    cwd: workDir,
    timeoutMs,
    onStdout: (s) => (output += s),
    onStderr: (s) => (output += s),
  });
  return { command, output: output.trim(), ok: res.ok && !res.timedOut };
}

export async function runVerify(workDir: string): Promise<VerifyResult> {
  const parsedTimeout = Number(process.env.VERIFY_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 10 * 60 * 1000;
  const deps = await ensureDeps(workDir, timeoutMs);
  if (!deps.ok) {
    return {
      ok: false,
      skipped: false,
      command: deps.command ?? "(dependency install)",
      output: deps.output.slice(0, 6000),
      timedOut: false,
    };
  }

  const command = await resolveCommand(workDir);
  if (!command) {
    return { ok: true, skipped: true, command: "", output: "(no check/test script found; verification skipped)", timedOut: false };
  }

  let output = deps.output ? `$ ${deps.command}\n${deps.output}\n` : "";
  output += `$ ${command}\n`;
  const res = await runAsync("bash", ["-c", command], {
    cwd: workDir,
    timeoutMs,
    onStdout: (s) => (output += s),
    onStderr: (s) => (output += s),
  });

  return {
    ok: res.ok && !res.timedOut,
    skipped: false,
    command,
    output: output.slice(0, 6000),
    timedOut: res.timedOut,
  };
}

import { spawn, spawnSync } from "node:child_process";

export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
}

/** Synchronous runner for `gh`, `git`, `node` etc. */
export function runSync(cmd: string, args: string[], opts: RunOptions = {}): ExecResult {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    input: opts.input,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

export interface RunAsyncOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** string written to the child's stdin (then closed) */
  input?: string;
  timeoutMs: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface RunAsyncResult {
  ok: boolean;
  code: number | null;
  timedOut: boolean;
  /** set when the process could not be spawned (e.g. binary not found) */
  error?: string;
}

/** Async spawn that resolves on exit, capturing stdout/stderr and killing on timeout. */
export function runAsync(
  cmd: string,
  args: string[],
  opts: RunAsyncOptions,
): Promise<RunAsyncResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: [opts.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    let stderrBuf = "";
    let timedOut = false;

    child.stdout?.on("data", (d: Buffer) => {
      const s = d.toString("utf8");
      stdoutBuf += s;
      opts.onStdout?.(s);
    });
    child.stderr?.on("data", (d: Buffer) => {
      const s = d.toString("utf8");
      stderrBuf += s;
      opts.onStderr?.(s);
    });

    if (opts.input !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.write(opts.input);
      child.stdin?.end();
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }, opts.timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, timedOut: false, error: err.message });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, code, timedOut });
    });
  });
}

import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { runAsync } from "../util/exec.ts";
import type { AgentRequest, AgentResult } from "./types.ts";

/**
 * Claude Code adapter. Spawns the `claude` CLI in print mode and feeds the
 * rendered task markdown via stdin.
 *
 * Requirements in the execution environment:
 *   - `claude` CLI installed and authenticated (ANTHROPIC_API_KEY or claude login)
 *   - optional model override via env CLAUDE_MODEL (otherwise CLI default)
 */
export const claudeAgent = {
  name: "claude",
  async run(req: AgentRequest): Promise<AgentResult> {
    const prompt = await readFile(req.taskFile, "utf8");
    const modelFlag = process.env.CLAUDE_MODEL?.trim();
    const args = [
      "-p",
      "--dangerously-skip-permissions",
      "--output-format",
      "text",
      ...(modelFlag ? ["--model", modelFlag] : []),
    ];

    const logStream = createWriteStream(req.logFile, { flags: "a" });
    const write = (s: string) => logStream.write(s);
    let stdoutBuf = "";

    const res = await runAsync("claude", args, {
      cwd: req.workDir,
      env: req.env,
      input: prompt,
      timeoutMs: req.timeoutMs,
      onStdout: (s) => {
        stdoutBuf += s;
        write(s);
      },
      onStderr: (s) => write(`[stderr] ${s}`),
    });
    logStream.end();

    let error: string | undefined;
    if (res.error) error = `Failed to spawn "claude": ${res.error}`;
    else if (res.timedOut) error = `Timed out after ${Math.round(req.timeoutMs / 60000)} minutes.`;
    else if (!res.ok) error = `claude exited with code ${res.code}.`;

    return {
      ok: res.ok,
      summary: stdoutBuf.trim().slice(0, 4000) || (res.ok ? "Task completed by Claude Code." : ""),
      logFile: req.logFile,
      error,
    };
  },
};

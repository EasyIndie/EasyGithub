import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { runAsync } from "../util/exec.ts";
import type { AgentRequest, AgentResult } from "./types.ts";

/**
 * Codex CLI adapter. Spawns `codex exec` with the rendered task markdown as
 * the prompt argument.
 *
 * Requirements in the execution environment:
 *   - `codex` CLI installed and authenticated (OPENAI_API_KEY or ChatGPT login)
 *   - optional model override via env CODEX_MODEL (otherwise CLI default)
 */
export const codexAgent = {
  name: "codex",
  async run(req: AgentRequest): Promise<AgentResult> {
    const prompt = await readFile(req.taskFile, "utf8");
    const modelFlag = process.env.CODEX_MODEL?.trim();
    const args = ["exec", ...(modelFlag ? ["--model", modelFlag] : []), "--json", prompt];

    const logStream = createWriteStream(req.logFile, { flags: "a" });
    const write = (s: string) => logStream.write(s);
    let stdoutBuf = "";

    const res = await runAsync("codex", args, {
      cwd: req.workDir,
      env: req.env,
      timeoutMs: req.timeoutMs,
      onStdout: (s) => {
        stdoutBuf += s;
        write(s);
      },
      onStderr: (s) => write(`[stderr] ${s}`),
    });
    logStream.end();

    let error: string | undefined;
    if (res.error) error = `Failed to spawn "codex": ${res.error}`;
    else if (res.timedOut) error = `Timed out after ${Math.round(req.timeoutMs / 60000)} minutes.`;
    else if (!res.ok) error = `codex exited with code ${res.code}.`;

    return {
      ok: res.ok,
      summary: extractCodexSummary(stdoutBuf) || (res.ok ? "Task completed by Codex." : ""),
      logFile: req.logFile,
      error,
    };
  },
};

/** Best-effort: pull assistant text out of `codex exec --json` output. */
function extractCodexSummary(stdout: string): string {
  const texts: string[] = [];
  const regex = /"output_text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(stdout)) !== null) {
    const g = m[1];
    if (g !== undefined) texts.push(g.replace(/\\n/g, "\n").replace(/\\"/g, '"'));
  }
  return texts.join("\n").trim().slice(0, 4000);
}

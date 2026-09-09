import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { runAsync } from "../util/exec.ts";
import type { AgentRequest, AgentResult } from "./types.ts";

/**
 * Codex CLI adapter. Spawns `codex exec` with the rendered task markdown as
 * the prompt argument. Requires a Codex configuration pointing at DeepSeek
 * (see src/cli.ts provisioning): provider "deepseek", wire_api "responses".
 *
 * Requirements in the execution environment:
 *   - `codex` CLI installed and provisioned (DEEPSEEK_API_KEY)
 *   - optional model override via env CODEX_MODEL (default from config)
 */
export const codexAgent = {
  name: "codex",
  async run(req: AgentRequest): Promise<AgentResult> {
    const prompt = await readFile(req.taskFile, "utf8");
    const modelFlag = process.env.CODEX_MODEL?.trim();
    const args = [
      "exec",
      ...(modelFlag ? ["--model", modelFlag] : []),
      "--json",
      "--sandbox",
      "danger-full-access",
      prompt,
    ];

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

/** Extract the final assistant text from `codex exec --json` event stream. */
function extractCodexSummary(stdout: string): string {
  const texts: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const item = ev?.item;
    if (ev?.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
      if (item.text.trim()) texts.push(item.text.trim());
    }
  }
  return texts.join("\n").slice(0, 4000);
}

import { createWriteStream } from "node:fs";
import { runAsync } from "../util/exec.ts";

/**
 * Pi agent implementation. Spawns the `pi` CLI in JSON event-stream mode,
 * records the stream to a log file, and derives a short summary from the
 * final assistant message.
 */
export const piAgent = {
  name: "pi",
  async run(req: import("./types.ts").AgentRequest): Promise<import("./types.ts").AgentResult> {
    const { taskFile, provider, model, extraArgs, logFile, timeoutMs, workDir, env } = req;

    const args = [
      "--no-session",
      "--mode",
      "json",
      "--provider",
      provider,
      "--model",
      model,
      ...extraArgs,
      `@${taskFile}`,
    ];

    const logStream = createWriteStream(logFile, { flags: "a" });
    const write = (s: string) => {
      logStream.write(s);
    };
    let lastSummary = "";

    const res = await runAsync("pi", args, {
      cwd: workDir,
      env,
      timeoutMs,
      onStdout: (chunk) => write(chunk),
      onStderr: (chunk) => write(`[stderr] ${chunk}`),
    });
    logStream.end();

    if (res.ok) {
      lastSummary = await extractSummary(logFile);
    }

    let error: string | undefined;
    if (res.timedOut) {
      error = `Timed out after ${Math.round(timeoutMs / 60000)} minutes.`;
    } else if (!res.ok) {
      error = `Pi exited with code ${res.code}.`;
    }

    return {
      ok: res.ok,
      summary: lastSummary || (res.ok ? "Task completed by Pi." : ""),
      logFile,
      error,
    };
  },
};

/** Pull the final assistant text out of a `--mode json` event stream log. */
async function extractSummary(logFile: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  try {
    const raw = await readFile(logFile, "utf8");
    let lastText = "";
    for (const line of raw.split("\n")) {
      if (!line.startsWith("{")) continue;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev?.type !== "message_end") continue;
      const msg = ev.message;
      if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
      const text = msg.content
        .filter((b: any) => b?.type === "text" && typeof b.text === "string")
        .map((b: any) => b.text as string)
        .join("\n");
      if (text.trim()) lastText = text.trim();
    }
    return lastText.slice(0, 4000);
  } catch {
    return "";
  }
}

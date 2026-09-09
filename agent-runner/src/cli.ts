import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runSync } from "./util/exec.ts";

const isCI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
const CODEX_SETUP_URL = "https://cdn.deepseek.com/api-docs/codex-deepseek-setup-en.sh";

function hasBin(bin: string): boolean {
  return runSync("bash", ["-c", `command -v "${bin}"`]).status === 0;
}

/**
 * Provision the CLI + provider config for a non-pi agent. Only runs inside
 * CI (GITHUB_ACTIONS). Locally it never touches ~/.codex / ~/.claude.
 * Returns null on success, or an explanatory string if provisioning failed
 * or is intentionally skipped outside CI.
 */
export async function ensureAgentCli(name: string): Promise<string | null> {
  if (name === "pi") return null;

  if (!isCI) {
    return `agent "${name}" requires provisioning that is CI-only; run it in GitHub Actions. (Local: install/configure manually.)`;
  }

  if (name === "claude") {
    if (!hasBin("claude")) {
      console.log("[cli] installing Claude Code…");
      // NOTE: must allow postinstall — the package downloads a native binary.
      const res = runSync("npm", ["install", "-g", "@anthropic-ai/claude-code"]);
      if (res.status !== 0) return `claude install failed: ${res.stderr.trim().slice(0, 500)}`;
    }
    // Auth/model come from ANTHROPIC_* env (set in the workflow).
    return hasBin("claude") ? null : `claude still not on PATH after install`;
  }

  if (name === "codex") {
    if (!hasBin("codex")) {
      console.log("[cli] installing Codex CLI…");
      const res = runSync("npm", ["install", "-g", "@openai/codex"]);
      if (res.status !== 0) return `codex install failed: ${res.stderr.trim().slice(0, 500)}`;
    }

    const home = homedir();
    const codexDir = join(home, ".codex");
    mkdirSync(codexDir, { recursive: true });
    // make sure codex has initialized its config dir
    runSync("codex", ["--version"], { env: { HOME: home } });

    const cfgPath = join(codexDir, "config.toml");
    const configured = existsSync(cfgPath) && readFileSync(cfgPath, "utf8").includes("model_providers.deepseek");
    if (configured) return null;

    if (!process.env.DEEPSEEK_API_KEY) return `codex provisioning needs DEEPSEEK_API_KEY`;
    console.log("[cli] configuring Codex -> DeepSeek (one-click setup)…");
    const setup = runSync("bash", ["-c", `printf '2\\n%s\\n' "$DEEPSEEK_API_KEY" | bash <(curl -fsSL ${CODEX_SETUP_URL})`]);
    if (setup.status !== 0) return `codex DeepSeek setup failed: ${setup.stderr.trim().slice(0, 800) || setup.stdout.trim().slice(-800)}`;
    return null;
  }

  return `no provisioning implemented for agent "${name}"`;
}

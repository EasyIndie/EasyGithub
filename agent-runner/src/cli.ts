import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runSync } from "./util/exec.ts";

const isCI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
const CODEX_SETUP_URL = "https://cdn.deepseek.com/api-docs/codex-deepseek-setup-en.sh";

function hasBin(bin: string): boolean {
  return runSync("bash", ["-c", `command -v "${bin}"`]).status === 0;
}

function npmInstallGlobal(pkg: string, allowScripts: boolean): boolean {
  const args = ["install", "-g", ...(allowScripts ? [] : ["--ignore-scripts"]), pkg];
  return runSync("npm", args).status === 0;
}

/**
 * Make sure the selected agent's CLI is installed and (for codex) configured
 * to talk to DeepSeek. Binary installs run anywhere; the ~/.codex rewrite is
 * CI-only (it never touches a local developer config).
 * Returns null on success, or an explanatory string on failure.
 */
export async function ensureAgentCli(name: string): Promise<string | null> {
  if (name === "pi") {
    if (!hasBin("pi")) {
      console.log("[cli] installing pi…");
      if (!npmInstallGlobal("@earendil-works/pi-coding-agent@0.85.1", false)) {
        return "pi install failed";
      }
    }
    return hasBin("pi") ? null : "pi still not on PATH after install";
  }

  if (name === "claude") {
    if (!hasBin("claude")) {
      console.log("[cli] installing Claude Code…");
      // NOTE: must allow postinstall — the package downloads a native binary.
      if (!npmInstallGlobal("@anthropic-ai/claude-code", true)) {
        return "claude install failed";
      }
    }
    return hasBin("claude") ? null : "claude still not on PATH after install";
  }

  if (name === "codex") {
    if (!hasBin("codex")) {
      console.log("[cli] installing Codex CLI…");
      if (!npmInstallGlobal("@openai/codex", true)) {
        return "codex install failed";
      }
    }

    const home = homedir();
    const codexDir = join(home, ".codex");
    mkdirSync(codexDir, { recursive: true });
    runSync("codex", ["--version"], { env: { HOME: home } });

    const cfgPath = join(codexDir, "config.toml");
    const configured = existsSync(cfgPath) && readFileSync(cfgPath, "utf8").includes("model_providers.deepseek");
    if (configured) return null;

    if (!isCI) {
      return `codex installed but ~/.codex has no DeepSeek provider; local runs need the official one-click setup first (bash <(curl -fsSL ${CODEX_SETUP_URL}))`;
    }
    if (!process.env.DEEPSEEK_API_KEY) return "codex provisioning needs DEEPSEEK_API_KEY";
    console.log("[cli] configuring Codex -> DeepSeek (one-click setup)…");
    const setup = runSync("bash", ["-c", `printf '2\\n%s\\n' "$DEEPSEEK_API_KEY" | bash <(curl -fsSL ${CODEX_SETUP_URL})`]);
    if (setup.status !== 0) {
      return `codex DeepSeek setup failed: ${setup.stderr.trim().slice(0, 800) || setup.stdout.trim().slice(-800)}`;
    }
    return null;
  }

  return `no provisioning implemented for agent "${name}"`;
}

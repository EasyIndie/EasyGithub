/**
 * Environment allow-list for the AI agent child process.
 *
 * The agent (and anything it spawns) must NOT inherit repository write
 * credentials: the runner owns git push / PR creation. Historically the whole
 * `process.env` was forwarded, which handed `GH_TOKEN` / `GITHUB_TOKEN` (and
 * `EASYGH_PR_TOKEN`) to a process that reads untrusted input (the issue body).
 *
 * Provider keys and tool config are kept, everything else is dropped.
 */

/** Variables passed through unchanged. */
const KEEP_EXACT = new Set([
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "LANG",
  "TERM",
  "COLORTERM",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
  "CI",
  "GITHUB_ACTIONS",
  "RUNNER_OS",
  "RUNNER_ARCH",
  "NO_COLOR",
  "FORCE_COLOR",
  "TERM_PROGRAM",
  "HOMEBREW_PREFIX",
]);

/** Prefixes that are safe to forward (provider keys, tool config, locale, npm). */
const KEEP_PREFIXES = [
  "LC_",
  "npm_config_",
  "NPM_CONFIG_",
  "DEEPSEEK_",
  "ANTHROPIC_",
  "OPENAI_",
  "CODEX_",
  "CLAUDE_",
  "XDG_",
];

/**
 * Explicitly dropped even if a prefix would otherwise match. These grant
 * repository/API write access or leak runner internals.
 */
const DROP_EXACT = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "EASYGH_PR_TOKEN",
  "EASYGH_APP_PRIVATE_KEY",
  "GITHUB_ENV",
  "GITHUB_OUTPUT",
  "GITHUB_STATE",
  "GITHUB_PATH",
  "GITHUB_STEP_SUMMARY",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_RUNTIME_TOKEN",
  "SSH_AUTH_SOCK",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
]);

/** Secret-looking variable names, used only for log-safe diagnostics. */
const SECRET_NAME = /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i;

/** Build the environment for the agent child process. */
export function agentEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (DROP_EXACT.has(key)) continue;
    const keep = KEEP_EXACT.has(key) || KEEP_PREFIXES.some((prefix) => key.startsWith(prefix));
    if (!keep) continue;
    out[key] = value;
  }
  // No interactive credential prompts, no credential-manager UI.
  out.GIT_TERMINAL_PROMPT = "0";
  out.GCM_INTERACTIVE = "never";
  out.CI = source.CI || "true";
  return out;
}

/**
 * Names (never values) of secret-looking variables that are withheld from the
 * agent. Safe to log.
 */
export function withheldSecretNames(source: NodeJS.ProcessEnv = process.env): string[] {
  const forwarded = agentEnv(source);
  return Object.keys(source)
    .filter((key) => forwarded[key] === undefined && SECRET_NAME.test(key))
    .sort();
}

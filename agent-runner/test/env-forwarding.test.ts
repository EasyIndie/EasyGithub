import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

/**
 * Guard rail for a bug we hit twice: a new variable works locally, but the
 * workflow `env:` blocks are not updated, so it is silently empty in CI
 * (AI_LOCALE in ghapp-scan.yml, EASYGH_PROVIDER everywhere).
 *
 * `HUB_KNOBS` is the deliberately small list of variables that control the
 * runner and are configured on the hub (repository variables / secrets).
 * Adding a knob means adding it here, which immediately fails the test until
 * every workflow that runs the runner forwards it. The rot check catches the
 * opposite mistake: a knob that no longer exists in the source.
 */
const HUB_KNOBS = [
  "AGENT_BUDGET_MS",
  "AI_AUTOMERGE",
  "AI_LOCALE",
  "AI_MAX_ATTEMPTS",
  "AI_MAX_PRS_PER_DAY",
  "AI_REVIEWER",
  "DEEPSEEK_API_KEY",
  "EASYGH_PROMPTS_DIR",
  "EASYGH_PROVIDER",
  "PI_TIMEOUT_MS",
  "VERIFY_TIMEOUT_MS",
].sort();

interface Workflow {
  file: string;
  text: string;
}

function runnerWorkflows(): Workflow[] {
  const url = new URL("../../.github/workflows/", import.meta.url);
  return readdirSync(url)
    .filter((file) => file.endsWith(".yml"))
    .map((file) => ({ file, text: readFileSync(new URL(file, url), "utf8") }))
    .filter(({ text }) => /agent-runner\/src\/(main|dispatcher)\.ts/.test(text));
}

function forwarded(text: string): Set<string> {
  const names = new Set<string>();
  for (const match of text.matchAll(/^\s+([A-Z][A-Z0-9_]*):/gm)) names.add(match[1] as string);
  for (const match of text.matchAll(/\b([A-Z][A-Z0-9_]{2,})=/g)) names.add(match[1] as string);
  return names;
}

function allSources(): string {
  const dir = new URL("../src/", import.meta.url);
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => readFileSync(new URL(file, dir), "utf8"))
    .join("\n");
}

describe("workflow env forwarding", () => {
  it("covers every workflow that runs the runner", () => {
    const files = runnerWorkflows().map((w) => w.file).sort();
    assert.deepEqual(files, ["ai-agent.yml", "ai-run.yml", "ghapp-scan.yml"]);
  });

  it("forwards every hub knob", () => {
    const problems: string[] = [];
    for (const workflow of runnerWorkflows()) {
      const have = forwarded(workflow.text);
      const missing = HUB_KNOBS.filter((name) => !have.has(name));
      if (missing.length > 0) problems.push(`${workflow.file}: ${missing.join(", ")}`);
    }
    assert.deepEqual(problems, [], `missing env forwarding -> ${problems.join(" | ")}`);
  });

  it("keeps the knob list honest", () => {
    const sources = allSources();
    const stale = HUB_KNOBS.filter((name) => !sources.includes(name));
    assert.deepEqual(stale, [], `listed but unused in src/: ${stale.join(", ")}`);
  });
});

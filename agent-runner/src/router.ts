import { readFile } from "node:fs/promises";

export interface RouteInput {
  labels: string[];
  title: string;
}

interface RouterRule {
  labels?: string[];
  /** regex tested against the issue title (case-insensitive) */
  title?: string;
  agent: string;
}

interface RouterConfig {
  default?: string;
  rules?: RouterRule[];
}

const configUrl = new URL("../config/agents.json", import.meta.url);

/**
 * Pick an agent for an issue. Precedence:
 *   1. explicit issue label `agent:<name>` (e.g. `agent:claude`)
 *   2. repo variable AGENT (env override, handled by caller)
 *   3. first matching rule in agent-runner/config/agents.json
 *   4. configured default ("pi")
 */
export async function routeAgent(input: RouteInput): Promise<string> {
  for (const label of input.labels) {
    const m = /^agent:(.+)$/.exec(label.trim());
    if (m?.[1]) return m[1].trim().toLowerCase();
  }

  let cfg: RouterConfig = {};
  try {
    cfg = JSON.parse(await readFile(configUrl, "utf8")) as RouterConfig;
  } catch {
    // no config file -> defaults below
  }

  const title = input.title.toLowerCase();
  for (const rule of cfg.rules ?? []) {
    const labelsOk = (rule.labels ?? []).some((l) => input.labels.includes(l));
    let titleOk = false;
    if (rule.title) {
      try {
        titleOk = new RegExp(rule.title, "i").test(title);
      } catch {
        titleOk = false;
      }
    }
    if (labelsOk || titleOk) return rule.agent.trim().toLowerCase();
  }

  return (cfg.default ?? "pi").trim().toLowerCase() || "pi";
}

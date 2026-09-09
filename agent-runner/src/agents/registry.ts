import { claudeAgent } from "./claude.ts";
import { codexAgent } from "./codex.ts";
import { piAgent } from "./pi.ts";
import type { CodingAgent } from "./types.ts";

const registry: Record<string, CodingAgent> = {
  pi: piAgent as CodingAgent,
  claude: claudeAgent as CodingAgent,
  codex: codexAgent as CodingAgent,
};

export const knownAgents = Object.keys(registry);

export function selectAgent(name: string): CodingAgent {
  const agent = registry[name];
  if (!agent) throw new Error(`Unknown agent "${name}". Known agents: ${knownAgents.join(", ")}`);
  return agent;
}

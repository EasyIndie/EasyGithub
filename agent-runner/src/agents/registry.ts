import { piAgent } from "./pi.ts";
import type { CodingAgent } from "./types.ts";

const registry: Record<string, CodingAgent> = {
  pi: piAgent as CodingAgent,
};

export function selectAgent(name: string): CodingAgent {
  const agent = registry[name];
  if (!agent) throw new Error(`Unknown agent "${name}". Known agents: ${Object.keys(registry).join(", ")}`);
  return agent;
}

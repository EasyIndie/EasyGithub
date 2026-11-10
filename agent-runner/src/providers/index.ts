import { githubProvider } from "./github.ts";
import type { Provider } from "./types.ts";

export type { Provider } from "./types.ts";

/**
 * Provider registry.
 *
 * Only GitHub is implemented today. Adding GitLab/Gitea means writing
 * `src/providers/<name>.ts` that satisfies `Provider`, registering it here and
 * documenting which capabilities are missing (no app mode, no tag-ref lock, …).
 */
const registry: Record<string, Provider> = {
  github: githubProvider,
};

export const knownProviders = (): string[] => Object.keys(registry);

/** Register an additional provider (tests, or a future platform). */
export function registerProvider(provider: Provider): void {
  registry[provider.name] = provider;
}

/**
 * Resolve the provider named by `EASYGH_PROVIDER` (default `github`).
 * Fails loudly instead of silently falling back to GitHub.
 */
export function resolveProvider(name?: string): Provider {
  const key = (name ?? process.env.EASYGH_PROVIDER ?? "github").trim().toLowerCase() || "github";
  const provider = registry[key];
  if (!provider) {
    throw new Error(
      `Unknown provider "${key}". Implemented: ${knownProviders().join(", ")}. ` +
        `A new platform must implement src/providers/<name>.ts (see docs/portability.md).`,
    );
  }
  return provider;
}

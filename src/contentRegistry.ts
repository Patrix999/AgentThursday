/**
 * ContentHub registry data + pure listing logic.
 *
 * Pure module: no Workers/DO imports. Importable from Node smoke tests
 * (see `scripts/contentHub-smoke.ts`) and from the `ContentHubAgent` DO.
 *
 *  will replace the hardcoded array with dynamic DO state once
 * provider configuration moves out of build-time constants.
 */

import type {
  ContentSource,
  ContentSourceHealth,
  ContentSourceWithHealth,
  ContentSourcesResponse,
} from "./schema";

const AGENT_THURSDAY_GITHUB_SOURCE: ContentSource = {
  id: "agentthursday-github",
  provider: "github",
  label: "AgentThursday GitHub repo (Patrix999/AgentThursday@main)",
  scope: "project",
  access: "read",
  authMode: "secret",
  defaultRef: "main",
  // Allow list = subtrees the agent should be able to read.
  //  enforces this list before each network fetch.
  allowedPaths: [
    "src/",
    "docs/",
    "scripts/",
    "web/",
    "tui/",
    "package.json",
    "wrangler.toml",
  ],
  // Deny list takes precedence: hidden config, secrets, build artifacts must
  // never be readable even if the allow list could match.
  deniedPaths: [
    ".git",
    ".env",
    ".dev.vars",
    ".wrangler",
    "node_modules",
    "dist",
    "web/dist",
  ],
  // explicit capability declaration. GitHub provider
  // supports the full read/list/search/health quad (Cards 108 + 109).
  capabilities: {
    read: true,
    list: true,
    search: true,
    health: true,
  },
};

// Local-fs / static docs ContentSource.
//
//  design (`docs/design/2026-04-28-m7.4-v2-provider-selection.md`)
// chose Local-fs as the v2 first additional provider to validate
// `ContentSourceConnector` abstraction with a non-GitHub I/O / auth /
// revision model. Implementation: hardcoded fixture map shipped in
// `src/localFsContentConnector.ts`. NOT an alias for the agent's Tier 0
// workspace.
//
// `scope:"fixture"` and `authMode:"none"` are the v2 enum extensions.
// No `defaultRef` (no version concept); revisions are content-hash
// snapshots emitted by the connector at read time.
const AGENT_THURSDAY_LOCAL_FIXTURE_SOURCE: ContentSource = {
  id: "agent-thursday-local-fixture",
  provider: "local-fs",
  label: "AgentThursday Local Fixture (v2 abstraction validator)",
  scope: "fixture",
  access: "read",
  authMode: "none",
  // No allowedPaths needed for the fixture (content is fully controlled by
  // the worker source). deniedPaths kept empty since the fixture corpus
  // contains no secrets by construction. Path policy still rejects `..`,
  // `\\`, null bytes via the connector's normalizePath.
  // Local-fs provider supports read + list + health
  // only. Search is explicitly false: `_doSearch` returns a fail-loud
  // "search not implemented for provider: local-fs" error rather than any
  // silent fallback.  fan-out reads this field to skip local-fs.
  capabilities: {
    read: true,
    list: true,
    search: false,
    health: true,
  },
};

export const HARDCODED_REGISTRY: readonly ContentSource[] = [
  AGENT_THURSDAY_GITHUB_SOURCE,
  AGENT_THURSDAY_LOCAL_FIXTURE_SOURCE,
];

/**
 * v1 health is intentionally static —  ships no network call.
 *  replaces this with a real GitHub probe and switches `mode` to
 * `"live"` / `"degraded"`.
 */
export function staticHealth(_source: ContentSource): ContentSourceHealth {
  return {
    ok: true,
    mode: "registry-only",
    checkedAt: Date.now(),
  };
}

export type ListSourcesInput = {
  includeHealth?: boolean;
  sourceId?: string;
};

/**
 * Pure listing function used by `ContentHubAgent.getSources` and by the
 *  smoke test. v1 returns the hardcoded registry.
 *
 * @param input.includeHealth default `true`. Set `false` for cheap listing.
 * @param input.sourceId      optional filter; empty array if unmatched.
 */
export function listSources(input?: ListSourcesInput): ContentSourcesResponse {
  const includeHealth = input?.includeHealth !== false;
  const filter = input?.sourceId;

  const filtered = filter
    ? HARDCODED_REGISTRY.filter(s => s.id === filter)
    : HARDCODED_REGISTRY;

  const sources: ContentSourceWithHealth[] = filtered.map(source =>
    includeHealth
      ? { source, health: staticHealth(source) }
      : { source },
  );

  return { sources };
}

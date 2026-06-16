/**
 *  / 417 — the registry DO instance name (owns
 * `context_active`, agent profiles, provider credentials, and the
 *  discord_bot table). Extracted from `channelHub.ts` so the
 * Discord gateway DO can resolve the same registry without importing
 * the whole ChannelHub module.
 */
export const AGENT_THURSDAY_REGISTRY_INSTANCE_NAME = "agentthursday-dev-fresh-108a-1";

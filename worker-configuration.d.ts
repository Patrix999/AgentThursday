interface Env {
  AgentThursdayAgent: DurableObjectNamespace;
  AI: Ai;
  GITHUB_TOKEN: string;
  LOADER: WorkerLoader;
  // Tier 4: Cloudflare container sandbox DO namespace
  Sandbox: DurableObjectNamespace<import("@cloudflare/sandbox").Sandbox>;
  // M7.1 Card 77 — single-user shared-secret auth.
  // AGENT_THURSDAY_SHARED_SECRET is set in production via `wrangler secret put`.
  // AGENT_THURSDAY_ALLOW_INSECURE_DEV must only ever appear in local `.dev.vars`.
  AGENT_THURSDAY_SHARED_SECRET?: string;
  AGENT_THURSDAY_ALLOW_INSECURE_DEV?: string;
  // M7.1 Card 78 — static SPA assets (web/dist) served via Cloudflare assets.
  ASSETS: Fetcher;
  // M7.2 Card 83 — Browser Rendering binding for Tier 3 headless browser tool.
  // Speaks CDP over WebSocket via `BROWSER.fetch("https://localhost/v1/devtools/browser")`.
  BROWSER: Fetcher;
  // M7.3 Card 85 — separate ChannelHubAgent DO for inbox/outbox/identity/conversation.
  ChannelHubAgent: DurableObjectNamespace;
  // M7.4 Card 107 — separate ContentHubAgent DO for provider-agnostic
  // content source registry / future cache / future audit.
  ContentHubAgent: DurableObjectNamespace;
  // M7.5 Card 115 — Cloudflare-native Discord Gateway runner DO. Holds
  // the outgoing WebSocket to gateway.discord.gg inside CF instead of an
  // external host process. Host-side `scripts/discord-gateway-runner.ts`
  // remains as the documented fallback.
  DiscordGatewayAgent: DurableObjectNamespace;
  // M7.3 Card 86 — AgentThursday-side Discord identity for the OpenClaw bridge inbound.
  // Used to compute DM conversation id and to detect `<@id>` mention in content
  // when the bridge does not pre-flag `mentionsBot`. Optional: missing id
  // produces conservative addressedToAgent:false except DM (per Card 86 §D-19).
  AGENT_THURSDAY_DISCORD_BOT_ID?: string;
  // M7.3 Card 88 — outbound delivery + approval cards.
  //   AGENT_THURSDAY_OPENCLAW_BRIDGE_URL    : optional. If set, deliverPendingOutbound
  //                                  POSTs to this URL. If unset, dry-run mode
  //                                  (logs payload + marks sent without network).
  //   AGENT_THURSDAY_OPENCLAW_BRIDGE_SECRET : optional. Sent as X-AgentThursday-Bridge-Secret on
  //                                  the bridge call so the bridge can verify AgentThursday.
  //   AGENT_THURSDAY_APPROVAL_ALLOW_ALWAYS  : "true" enables the `always` scope on
  //                                  approval cards. Off by default per Card 88
  //                                  §C-13 — the always button is hidden in card
  //                                  text and resolve downgrades it to `session`.
  AGENT_THURSDAY_OPENCLAW_BRIDGE_URL?: string;
  AGENT_THURSDAY_OPENCLAW_BRIDGE_SECRET?: string;
  AGENT_THURSDAY_APPROVAL_ALLOW_ALWAYS?: string;
  // M7.3 Card 91 — direct Discord adapter (no OpenClaw dependency).
  //   DISCORD_BOT_TOKEN          : SECRET, required for direct REST send.
  //                                When set, channel_outbox rows for
  //                                provider="discord" go via Discord REST
  //                                instead of OpenClaw bridge / dry-run.
  //   DISCORD_PUBLIC_KEY         : Application public key (hex). Required
  //                                for verifying signatures on the public
  //                                /discord/interactions endpoint.
  //   DISCORD_APPLICATION_ID     : Non-secret app id (informational).
  //   DISCORD_API_BASE_URL       : Optional override of the Discord REST
  //                                base URL (default https://discord.com/api/v10).
  //                                Use a localhost mock URL for smoke testing.
  //   DISCORD_ALLOWED_USERS      : Comma-separated provider user ids; when
  //                                set, only these users can be ingested.
  //   DISCORD_ALLOWED_CHANNELS   : Comma-separated channel ids; when set,
  //                                only these channels are ingested.
  //   DISCORD_IGNORE_NO_MENTION  : Default "true". When true, guild messages
  //                                without a bot mention are dropped (DMs
  //                                are always addressed by default).
  //   DISCORD_ALLOW_BOTS         : "none" | "mentions" | "all"; default "none".
  DISCORD_BOT_TOKEN?: string;
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_APPLICATION_ID?: string;
  DISCORD_API_BASE_URL?: string;
  DISCORD_ALLOWED_USERS?: string;
  DISCORD_ALLOWED_CHANNELS?: string;
  DISCORD_IGNORE_NO_MENTION?: string;
  DISCORD_ALLOW_BOTS?: string;
}

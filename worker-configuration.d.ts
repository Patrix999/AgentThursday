interface Env {
  AgentThursdayAgent: DurableObjectNamespace;
  AI: Ai;
  GITHUB_TOKEN: string;
  LOADER: WorkerLoader;
  // Tier 4: Cloudflare container sandbox DO namespace
  Sandbox: DurableObjectNamespace<import("@cloudflare/sandbox").Sandbox>;
  //single-user shared-secret auth.
  // AGENT_THURSDAY_SHARED_SECRET is set in production via `wrangler secret put`.
  // AGENT_THURSDAY_ALLOW_INSECURE_DEV must only ever appear in local `.dev.vars`.
  AGENT_THURSDAY_SHARED_SECRET?: string;
  AGENT_THURSDAY_ALLOW_INSECURE_DEV?: string;
  //static SPA assets (web/dist) served via Cloudflare assets.
  ASSETS: Fetcher;
  //Browser Rendering binding for Tier 3 headless browser tool.
  // Speaks CDP over WebSocket via `BROWSER.fetch("https://localhost/v1/devtools/browser")`.
  BROWSER: Fetcher;
  //separate ChannelHubAgent DO for inbox/outbox/identity/conversation.
  ChannelHubAgent: DurableObjectNamespace;
  //separate ContentHubAgent DO for provider-agnostic
  // content source registry / future cache / future audit.
  ContentHubAgent: DurableObjectNamespace;
  //Cloudflare-native Discord Gateway runner DO. Holds
  // the outgoing WebSocket to gateway.discord.gg inside CF instead of an
  // external host process. Host-side `scripts/discord-gateway-runner.ts`
  // remains as the documented fallback.
  DiscordGatewayAgent: DurableObjectNamespace;
  //AgentThursday-side Discord identity for the OpenClaw bridge inbound.
  // Used to compute DM conversation id and to detect `<@id>` mention in content
  // when the bridge does not pre-flag `mentionsBot`. Optional: missing id
  // produces conservative addressedToAgent:false except DM (per §D-19).
  AGENT_THURSDAY_DISCORD_BOT_ID?: string;
  //outbound delivery + approval cards.
  //   AGENT_THURSDAY_OPENCLAW_BRIDGE_URL    : optional. If set, deliverPendingOutbound
  //                                  POSTs to this URL. If unset, dry-run mode
  //                                  (logs payload + marks sent without network).
  //   AGENT_THURSDAY_OPENCLAW_BRIDGE_SECRET : optional. Sent as X-AgentThursday-Bridge-Secret on
  //                                  the bridge call so the bridge can verify AgentThursday.
  //   AGENT_THURSDAY_APPROVAL_ALLOW_ALWAYS  : "true" enables the `always` scope on
  //                                  approval cards. Off by default per
  //                                  §C-13 — the always button is hidden in card
  //                                  text and resolve downgrades it to `session`.
  AGENT_THURSDAY_OPENCLAW_BRIDGE_URL?: string;
  AGENT_THURSDAY_OPENCLAW_BRIDGE_SECRET?: string;
  AGENT_THURSDAY_APPROVAL_ALLOW_ALWAYS?: string;
  //direct Discord adapter (no OpenClaw dependency).
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
  // Discord ingress mode selector + REST polling tunable.
  //   DISCORD_INGRESS_MODE          : "gateway" | "polling" | "disabled".
  //                                   Default "gateway" (backwards-compatible).
  //   DISCORD_POLL_INTERVAL_SECONDS : polling cadence; clamped to [30, 3600].
  //                                   Default 60. Only consulted when mode
  //                                   is "polling".
  // See `src/discordIngressConfig.ts` for the parser and `DEPLOY.md` for
  // the cost / latency / presence / rate-limit tradeoff table.
  DISCORD_INGRESS_MODE?: string;
  DISCORD_POLL_INTERVAL_SECONDS?: string;
  // Comma-separated Discord user ids whose DM channels are
  // polled in `polling` mode. Each id is resolved to a DM channel via
  // REST `POST /users/@me/channels` (idempotent) and polled the same
  // way as a guild channel, but forwarded with `chatType:"dm"` so the
  // direct ingest filter and ChannelHub treat the message as a DM.
  // Non-secret operational config; values are Discord snowflake ids.
  // Empty / unset → no DM polling (gateway mode is the way to receive
  // DMs in that case).
  DISCORD_POLL_DM_USER_IDS?: string;
  // Web UI debug surface gate.
  //   "enable"   (default) Inspect entry, context chip / rail, and debug
  //              action buttons are visible and executable.
  //   "readonly" Inspect visible / browseable; debug action buttons show a
  //              readonly notice instead of hitting the API.
  //   "disable"  Inspect entry + context chip / rail + any debug affordance
  //              hidden; direct `/inspect` shows a disabled notice.
  // Backend endpoints stay auth-gated regardless; this flag is UI-only.
  AGENT_THURSDAY_DEBUG_SURFACE_MODE?: string;
  // / 167 — tool truthfulness gate mode.
  //   "warn"     (default) prepend ⚠️ to user-visible reply on violation
  //   "log-only" record event only; no user-visible warning
  //   "off"      disable detection entirely (avoid in production)
  // Non-secret operational flag; lives in wrangler.toml [vars].
  AGENT_THURSDAY_TRUTHFULNESS_GATE?: string;
}

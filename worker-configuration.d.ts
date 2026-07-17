interface Env {
  AgentThursdayAgent: DurableObjectNamespace;
  AI: Ai;
  // 2026-06-23 — R2 bucket for user-uploaded document markdown (owner-keyed).
  DOCS_BUCKET: R2Bucket;
  GITHUB_TOKEN: string;
  // Anthropic API key for external Claude model dispatch.
  // Set in production via `wrangler secret put ANTHROPIC_API_KEY`.
  ANTHROPIC_API_KEY?: string;
  // CF Agent Memory (private beta) token for the dual-path
  // memory shadow (operator dogfood). `wrangler secret put`; absent →
  // shadow ingest/recall silently disabled (fail-soft).
  CF_AGENT_MEMORY_TOKEN?: string;
  // optional platform-level xAI Grok key (BYO credential is the
  // normal path; this env fallback mirrors ZHIPU_API_KEY).
  GROK_API_KEY?: string;
  ZHIPU_API_KEY?: string;
  LOADER: WorkerLoader;
  // Tier 4: Cloudflare container sandbox DO namespace
  Sandbox: DurableObjectNamespace<import("@cloudflare/sandbox").Sandbox>;
  // single-user shared-secret auth.
  // AGENT_THURSDAY_SHARED_SECRET is set in production via `wrangler secret put`.
  // AGENT_THURSDAY_ALLOW_INSECURE_DEV must only ever appear in local `.dev.vars`.
  AGENT_THURSDAY_SHARED_SECRET?: string;
  AGENT_THURSDAY_ALLOW_INSECURE_DEV?: string;
  // static SPA assets (web/dist) served via Cloudflare assets.
  ASSETS: Fetcher;
  // Browser Rendering binding for Tier 3 headless browser tool.
  // Speaks CDP over WebSocket via `BROWSER.fetch("https://localhost/v1/devtools/browser")`.
  BROWSER: Fetcher;
  // 2026-06-22 — Cloudflare Email Service send binding (welcome email on
  // account approval). agentthursday.com is a verified sender domain. Typed as
  // the runtime `SendEmail`; the call site (welcomeEmail.ts) casts to the
  // structured-send shape because the installed workers-types only knows the
  // legacy `EmailMessage` overload. Optional so non-prod envs without the
  // binding still type-check (the caller null-checks before use).
  EMAIL?: SendEmail;
  // separate ChannelHubAgent DO for inbox/outbox/identity/conversation.
  ChannelHubAgent: DurableObjectNamespace;
  // separate ContentHubAgent DO for provider-agnostic
  // content source registry / future cache / future audit.
  ContentHubAgent: DurableObjectNamespace;
  // Cloudflare-native Discord Gateway runner DO. Holds
  // the outgoing WebSocket to gateway.discord.gg inside CF instead of an
  // external host process. Host-side `scripts/discord-gateway-runner.ts`
  // remains as the documented fallback.
  DiscordGatewayAgent: DurableObjectNamespace;
  // AgentThursday-side Discord identity for the Bridge bridge inbound.
  // Used to compute DM conversation id and to detect `<@id>` mention in content
  // when the bridge does not pre-flag `mentionsBot`. Optional: missing id
  // produces conservative addressedToAgent:false except DM (per an earlier revision §D-19).
  AGENT_THURSDAY_DISCORD_BOT_ID?: string;
  // outbound delivery + approval cards.
  //   AGENT_THURSDAY_BRIDGE_URL    : optional. If set, deliverPendingOutbound
  //                                  POSTs to this URL. If unset, dry-run mode
  //                                  (logs payload + marks sent without network).
  //   AGENT_THURSDAY_BRIDGE_SECRET : optional. Sent as X-AgentThursday-Bridge-Secret on
  //                                  the bridge call so the bridge can verify AgentThursday.
  //   AGENT_THURSDAY_APPROVAL_ALLOW_ALWAYS  : "true" enables the `always` scope on
  //                                  approval cards. Off by default per an earlier revision
  //                                  §C-13 — the always button is hidden in card
  //                                  text and resolve downgrades it to `session`.
  AGENT_THURSDAY_BRIDGE_URL?: string;
  AGENT_THURSDAY_BRIDGE_SECRET?: string;
  AGENT_THURSDAY_APPROVAL_ALLOW_ALWAYS?: string;
  // dedicated HMAC key for M8.5 approval token signing.
  // Preferred over AGENT_THURSDAY_SHARED_SECRET; the shared secret remains a
  // migration / dev fallback (logged on the row via key_id) so existing
  // rows stay verifiable. Set in production via `wrangler secret put`.
  AGENT_THURSDAY_APPROVAL_HMAC_KEY?: string;
  // direct Discord adapter (no Bridge dependency).
  //   DISCORD_BOT_TOKEN          : SECRET, required for direct REST send.
  //                                When set, channel_outbox rows for
  //                                provider="discord" go via Discord REST
  //                                instead of Bridge bridge / dry-run.
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
  // an earlier revision — tool truthfulness gate mode.
  //   "warn"     (default) prepend ⚠️ to user-visible reply on violation
  //   "log-only" record event only; no user-visible warning
  //   "off"      disable detection entirely (avoid in production)
  // Non-secret operational flag; lives in wrangler.toml [vars].
  AGENT_THURSDAY_TRUTHFULNESS_GATE?: string;
  // Cloudflare Workers version metadata binding. Auto-
  // populated by the runtime when [version_metadata] is configured in
  // wrangler.toml. Non-secret. Optional in the type so local `wrangler
  // dev` and any environment without the binding still typecheck;
  // dashboard.version reads it fail-soft.
  //   id        : the Worker version UUID
  //   tag       : optional human-readable version tag (set at deploy)
  //   timestamp : ISO timestamp the version was uploaded
  VERSION_METADATA?: {
    id?: string;
    tag?: string;
    timestamp?: string;
  };
  // fyi.md callable tool secret. Provider-specific binding
  // consumed only by `src/adapters/fyimd.ts` and the
  // `/api/dispatch/fyimd/convert_text` route. Never logged; never
  // returned in evidence. Missing/empty → dispatch returns a structured
  // `blocked / missing_secret` failure and inspect detail downgrades the
  // skill's `capability_class` to `callable_tool_no_secret`.
  FYIMD_API_KEY?: string;
  // `AgentRunWorkflow` binding. Placeholder workflow
  // class with a single `step.do("placeholder", ...)` that returns
  // `{ok: true, profile_id}`. `POST /api/agent-runs` calls
  // `env.AGENT_RUN_WORKFLOW.create(...)` to mint a workflow instance.
  // Real `AgentThursdayAgent` invocation arrives in the card AFTER 345.
  // Params shape is inlined here (not imported from
  // `src/workflows/AgentRunWorkflow`) so the scripts / tui tsconfigs,
  // which don't load `@cloudflare/workers-types`, can still resolve
  // `Env` without pulling the `cloudflare:workers` module into their
  // compilation graph.
  AGENT_RUN_WORKFLOW: Workflow<{ run_id: string; profile_id: string; input: unknown }>;
  // orchestration-as-code executor binding. `POST
  // /api/inspect/workflow-runs/execute` calls
  // `env.WORKFLOW_EXECUTOR.create({ id: run_id, params: { run_id,
  // descriptor } })`. Params shape inlined (not imported) for the same
  // tsconfig-graph reason as AGENT_RUN_WORKFLOW above; the descriptor is
  // an arbitrary validated object, typed `unknown` here.
  WORKFLOW_EXECUTOR: Workflow<{ run_id: string; descriptor: unknown }>;
  // AgentRunWorkflow multi-step orchestration tunables.
  //   AGENT_THURSDAY_AGENT_RUN_WAIT_TIMEOUT : duration string for
  //                                  step.waitForEvent (default
  //                                  "24 hours"; an earlier revision D-1).
  //   AGENT_THURSDAY_AGENT_RUN_FORCE_PAUSE  : dev/test-only env-flag fixture
  //                                  ("true" forces first-turn to
  //                                  return status="awaiting_event"
  //                                  so the sendEvent branch can be
  //                                  exercised; an earlier revision Q1 (a)).
  AGENT_THURSDAY_AGENT_RUN_WAIT_TIMEOUT?: string;
  AGENT_THURSDAY_AGENT_RUN_FORCE_PAUSE?: string;
}

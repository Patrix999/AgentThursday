import { getAgentByName } from "agents";
import { json } from "../httpUtil";
import {
  ChannelMessageEnvelopeSchema,
  ChannelInboundResultSchema,
  ChannelSnapshotSchema,
  ChannelRoutePendingResultSchema,
  EnqueueOutboundTextRequestSchema,
  EnqueueOutboundApprovalRequestSchema,
  EnqueueOutboundResultSchema,
  DeliverPendingResultSchema,
  ApprovalResolveRequestSchema,
  ApprovalResolveResultSchema,
  ChannelCompactSummarySchema,
} from "../schema";
import { ChannelHubAgent } from "../channelHub";
import { OpenClawDiscordInboundSchema, normalizeOpenClawPayload } from "../discordBridge";
import {
  verifyDiscordSignature,
  loadDirectDiscordConfig,
  applyDirectFilters,
  checkDirectAllowlists,
  deriveDirectFilterIsDm,
  DiscordInteractionSchema,
  extractSlashPrompt,
  normalizeSlashInteraction,
  decodeApprovalCustomId,
} from "../discordDirect";
import type { AutoRouteSummary } from "../server";
import {
  CONTINUATION_DEBOUNCE_MS_DEFAULT,
  classifyFilterRejection,
  shouldDeferRoute,
} from "../channelHub/continuation";
import { canBind } from "../channelHub/conversationBindingScope";
import type { RequestIdentity } from "../agent/requestIdentity";

/**
 * `/api/channel/*` + `/discord/interactions` HTTP route
 * handling extracted from `server.ts`.
 *
 * Single entry point: `handleChannel(request, url, deps)`.
 *
 * Behavior-preserving. Each handler is the verbatim body of the
 * original `server.ts` branch, lifted into one dispatch function.
 * Stub resolution stays at the composition root in `server.ts` and is
 * passed in via `ChannelDeps.getChannelStub` so this module never
 * imports `CHANNEL_HUB_INSTANCE`. `autoRouteAfterIngest` stays a
 * server.ts free function and is injected via the same deps surface.
 *
 * Returns `null` when no `/api/channel/*` or `/discord/interactions`
 * branch matches so `server.ts` can fall through to the remaining
 * handlers.
 *
 * Auth:
 *  - `/api/channel/*` routes are gated by the `/api/`/`/cli/`/`/demo/`
 *    `requireSecret` umbrella in `server.ts`. This handler never
 *    re-checks.
 *  - `/discord/interactions` is **PUBLIC** — the umbrella does NOT
 *    fire on the `/discord/` prefix. Authenticity is verified at
 *    request time via Discord's Ed25519 signature using
 *    `env.DISCORD_PUBLIC_KEY` + `verifyDiscordSignature(...)`. Posture
 *    preserved verbatim from the inline route.
 *
 * Status fields and response bodies never include tokens / shared
 * secret / raw Discord JSON.
 *
 * Routes:
 *
 *   /api/channel/inbound                POST  an earlier revision envelope ingest
 *   /api/channel/snapshot               GET   an earlier revision snapshot
 *   /api/channel/summary                GET   an earlier revision compact summary
 *   /api/channel/outbound/text          POST  an earlier revision enqueue text
 *   /api/channel/outbound/approval      POST  an earlier revision enqueue approval
 *   /api/channel/outbound/deliver-pending POST an earlier revision deliver
 *   /api/channel/approval/resolve       POST  an earlier revision approval resolve
 *   /discord/interactions               POST  an earlier revision Discord HTTP Interactions (PUBLIC)
 *   /api/channel/discord/direct         POST  an earlier revision direct ingest (auth-gated)
 *   /api/channel/identity/role          POST  an earlier revision set identity role
 *   /api/channel/route-pending          POST  an earlier revision route pending
 *   /api/channel/discord/openclaw       POST  an earlier revision OpenClaw bridge (legacy)
 */

type ChannelHubStub = Awaited<ReturnType<typeof getAgentByName<Env, ChannelHubAgent>>>;

export interface ChannelDeps {
  env: Env;
  getChannelStub: () => Promise<ChannelHubStub>;
  // registry stub for the stored-bot channel allowlist
  // merge on the direct-ingest path. Optional so existing test
  // harnesses keep working; absent ⇒ env-only allowlist.
  getRegistryStub?: () => Promise<unknown>;
  // M9.2 (2026-06-26) — resolved tenant identity for the user-side
  // conversation-binding owner-scoping. Absent / kind==="admin" ⇒ the
  // operator console (unrestricted, current behavior); kind==="user" ⇒ a
  // gateway-proxied tenant, who may only bind/clear their OWN conversations
  // (channel ∈ their BYO bots) to their OWN agents (canBind kernel).
  identity?: RequestIdentity;
  autoRouteAfterIngest: (
    stub: ChannelHubStub,
    inserted: boolean,
  ) => Promise<AutoRouteSummary | null>;
  /**
   * an earlier revision v2 — Worker `ExecutionContext` (subset). Used to defer
   * the first-chunk `routePending` by ~2s when the inserted anchor is a
   * guild-channel addressed Discord message, so subsequent multipart
   * chunks have a window to merge into the same anchor before routing.
   * Optional so test harnesses can opt into immediate routing.
   */
  ctx?: { waitUntil: (p: Promise<unknown>) => void };
  /**
   * an earlier revision v2 — sleep injection for tests. Defaults to a real
   * `setTimeout`-backed promise. Smoke can pass a synchronous resolver
   * to drive the deferred route on demand without real wall-clock waits.
   */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * M9.2 — the union of the SCOPED caller's BYO-bot channels, for conversation
 * ownership. Returns `null` for the admin/operator console (no `identity` or
 * `kind==="admin"`) ⇒ no ownership restriction (current behavior). For a scoped
 * tenant, returns their channels (empty set ⇒ owns no conversations, fail closed).
 */
async function resolveCallerChannels(deps: ChannelDeps): Promise<Set<string> | null> {
  const identity = deps.identity;
  if (!identity || identity.kind !== "user") return null; // admin / unscoped → unrestricted
  if (!deps.getRegistryStub) return new Set<string>(); // can't resolve bots → owns nothing
  const registry = await deps.getRegistryStub();
  const bots = await (registry as {
    listDiscordBots(identity?: RequestIdentity): Promise<Array<{ allowed_channels: string[] }>>;
  }).listDiscordBots(identity);
  const channels = new Set<string>();
  for (const b of bots) for (const c of b.allowed_channels || []) channels.add(c);
  return channels;
}

export async function handleChannel(
  request: Request,
  url: URL,
  deps: ChannelDeps,
): Promise<Response | null> {
  const { env } = deps;

  // ChannelHub auth-gated stub endpoints.
  if (url.pathname === "/api/channel/inbound" && request.method === "POST") {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ code: "request.invalid-json" }, 400);
    }
    const parsed = ChannelMessageEnvelopeSchema.safeParse(body);
    if (!parsed.success) {
      return json({ code: "request.invalid-shape", issues: parsed.error.issues }, 400);
    }
    const stub = await deps.getChannelStub();
    const result = await stub.ingestInbound(parsed.data);
    const routeSummary = await deps.autoRouteAfterIngest(stub, result.inserted);
    return json({ ...ChannelInboundResultSchema.parse(result), routeSummary });
  }

  if (url.pathname === "/api/channel/snapshot" && request.method === "GET") {
    const stub = await deps.getChannelStub();
    const snapshot = await stub.getSnapshot();
    return json(ChannelSnapshotSchema.parse(snapshot));
  }

  // compact channel summary for default user-layer panel.
  if (url.pathname === "/api/channel/summary" && request.method === "GET") {
    const stub = await deps.getChannelStub();
    const summary = await stub.getCompactSummary();
    return json(ChannelCompactSummarySchema.parse(summary));
  }

  // outbound text enqueue.
  if (url.pathname === "/api/channel/outbound/text" && request.method === "POST") {
    let body: unknown;
    try { body = await request.json(); } catch { return json({ code: "request.invalid-json" }, 400); }
    const parsed = EnqueueOutboundTextRequestSchema.safeParse(body);
    if (!parsed.success) return json({ code: "request.invalid-shape", issues: parsed.error.issues }, 400);
    const stub = await deps.getChannelStub();
    try {
      const result = await stub.enqueueOutboundText(parsed.data);
      return json(EnqueueOutboundResultSchema.parse(result));
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      if (msg.includes("outbound:proactive-not-allowed")) {
        return json({ code: "outbound.proactive-not-allowed" }, 403);
      }
      return json({ code: "internal", message: msg }, 500);
    }
  }

  // approval card enqueue.
  if (url.pathname === "/api/channel/outbound/approval" && request.method === "POST") {
    let body: unknown;
    try { body = await request.json(); } catch { return json({ code: "request.invalid-json" }, 400); }
    const parsed = EnqueueOutboundApprovalRequestSchema.safeParse(body);
    if (!parsed.success) return json({ code: "request.invalid-shape", issues: parsed.error.issues }, 400);
    const stub = await deps.getChannelStub();
    const result = await stub.enqueueOutboundApproval(parsed.data);
    return json(EnqueueOutboundResultSchema.parse(result));
  }

  // deliver pending outbound (bridge or dry-run).
  if (url.pathname === "/api/channel/outbound/deliver-pending" && request.method === "POST") {
    let body: unknown = {};
    try { body = await request.json(); } catch { body = {}; }
    const limit = typeof (body as { limit?: number }).limit === "number" ? (body as { limit?: number }).limit : 10;
    const stub = await deps.getChannelStub();
    const result = await stub.deliverPendingOutbound(limit);
    return json(DeliverPendingResultSchema.parse(result));
  }

  // approval resolve callback (bridge → AgentThursday button click).
  if (url.pathname === "/api/channel/approval/resolve" && request.method === "POST") {
    let body: unknown;
    try { body = await request.json(); } catch { return json({ code: "request.invalid-json" }, 400); }
    const parsed = ApprovalResolveRequestSchema.safeParse(body);
    if (!parsed.success) return json({ code: "request.invalid-shape", issues: parsed.error.issues }, 400);
    const stub = await deps.getChannelStub();
    const result = await stub.resolveApproval(parsed.data);
    return json(ApprovalResolveResultSchema.parse(result));
  }

  // direct Discord adapter: HTTP Interactions endpoint.
  // PUBLIC (no X-AgentThursday-Secret); authenticity comes from Discord's Ed25519
  // signature. CF Worker can't run the Gateway WebSocket, so normal
  // MESSAGE_CREATE arrives via the auth-gated /api/channel/discord/direct
  // path (below) — typically populated by a sidecar gateway runner OR by
  // smoke tests using the an earlier revision OpenClaw payload shape.
  if (url.pathname === "/discord/interactions" && request.method === "POST") {
    const sig = request.headers.get("X-Signature-Ed25519");
    const ts = request.headers.get("X-Signature-Timestamp");
    const pubKey = env.DISCORD_PUBLIC_KEY;
    const rawBody = await request.text();
    if (!sig || !ts || !pubKey) {
      return json({ code: "discord.signature-misconfigured" }, 401);
    }
    const ok = await verifyDiscordSignature({
      rawBody, signatureHex: sig, timestamp: ts, publicKeyHex: pubKey,
    });
    if (!ok) {
      return json({ code: "discord.signature-invalid" }, 401);
    }
    let body: unknown;
    try { body = JSON.parse(rawBody); } catch { return json({ code: "request.invalid-json" }, 400); }
    const parsed = DiscordInteractionSchema.safeParse(body);
    if (!parsed.success) return json({ code: "request.invalid-shape", issues: parsed.error.issues }, 400);
    const interaction = parsed.data;

    // Type 1 = PING handshake
    if (interaction.type === 1) {
      return json({ type: 1 });
    }

    // Type 2 = APPLICATION_COMMAND (slash)
    if (interaction.type === 2) {
      const cfg = loadDirectDiscordConfig(env);
      const author = interaction.member?.user ?? interaction.user;
      if (!author) return json({ type: 4, data: { content: "missing user", flags: 64 } });
      // Apply filter pipeline against slash sender
      const isDm = !interaction.guild_id;
      const filterRes = applyDirectFilters({
        authorId: author.id,
        authorIsBot: author.bot ?? false,
        isDm,
        channelId: interaction.channel_id ?? interaction.channel?.id ?? "",
        mentionsBot: true, // slash command implies addressed
        mentionedUserIds: cfg.botUserId ? [cfg.botUserId] : [],
      }, cfg);
      if (!filterRes.accept) {
        return json({ type: 4, data: { content: `ignored: ${filterRes.reason}`, flags: 64 } });
      }
      const slash = extractSlashPrompt(interaction);
      if (!slash) {
        return json({ type: 4, data: { content: "unsupported command (try /ask <prompt>)", flags: 64 } });
      }
      const envelope = await normalizeSlashInteraction(interaction, slash.prompt, cfg);
      const stub = await deps.getChannelStub();
      const result = await stub.ingestInbound(envelope);
      const routeSummary = await deps.autoRouteAfterIngest(stub, result.inserted);
      const routeNote = routeSummary && routeSummary.processed > 0
        ? " · routed to agent"
        : routeSummary && routeSummary.busySkipped > 0
        ? " · agent busy, will route when free"
        : "";
      // Ephemeral response so other channel members don't see the receipt
      return json({
        type: 4,
        data: {
          content: result.inserted
            ? `received (id ${result.id.slice(0, 8)})${routeNote}`
            : `already received (id ${result.id.slice(0, 8)})`,
          flags: 64,
        },
      });
    }

    // Type 3 = MESSAGE_COMPONENT (button click)
    if (interaction.type === 3) {
      const data = interaction.data as { custom_id?: string } | undefined;
      const customId = typeof data?.custom_id === "string" ? data.custom_id : "";
      const decoded = decodeApprovalCustomId(customId);
      if (!decoded) {
        return json({ type: 4, data: { content: "unrecognized button", flags: 64 } });
      }
      const author = interaction.member?.user ?? interaction.user;
      if (!author) return json({ type: 4, data: { content: "missing user", flags: 64 } });
      const stub = await deps.getChannelStub();
      // Look up the full payload hash from the approval row, then resolve.
      // We sent the button with a 12-char prefix; the resolve API needs the
      // full hash in `payloadHashEcho`. Pull from snapshot-style fetch.
      // Simpler: pass the prefix as the echo and have resolveApproval
      // accept a prefix match — but that weakens the invalidation guarantee.
      // Cleanest: read the row directly via a new minimal callable.
      // For v1: use `lookupApprovalHash(approvalId)` then echo full hash.
      const fullHash = await stub.lookupApprovalHash(decoded.approvalId);
      if (!fullHash) {
        return json({ type: 4, data: { content: `approval ${decoded.approvalId.slice(0, 8)} not found`, flags: 64 } });
      }
      // Sanity: button's hash prefix must agree with row's full hash. If
      // someone hand-crafts a custom_id, the prefix mismatch would surface here.
      if (!fullHash.startsWith(decoded.payloadHashPrefix)) {
        return json({ type: 4, data: { content: "button hash mismatch (payload changed?)", flags: 64 } });
      }
      const resolveResult = await stub.resolveApproval({
        approvalId: decoded.approvalId,
        scope: decoded.scope,
        actorProvider: "discord",
        actorProviderUserId: author.id,
        payloadHashEcho: fullHash,
      });
      // Ephemeral feedback so only the clicker sees it (Card §D-7 — ideal
      // would be to UPDATE the original message disabling buttons; that's
      // an edit via REST and recorded as a TODO below).
      return json({
        type: 4,
        data: {
          content: `${resolveResult.audit}${resolveResult.alreadyResolved ? " (already resolved)" : ""}`,
          flags: 64,
        },
      });
    }

    // Other interaction types not yet handled.
    return json({ type: 4, data: { content: "interaction type not supported", flags: 64 } });
  }

  // auth-gated direct ingest path. Same OpenClaw payload shape
  //  so a sidecar gateway runner can post message-create-shaped events
  // here without renaming the contract. Bridge endpoint /api/channel/discord/openclaw
  // is preserved as a compatibility alias.
  if (url.pathname === "/api/channel/discord/direct" && request.method === "POST") {
    let body: unknown;
    try { body = await request.json(); } catch { return json({ code: "request.invalid-json" }, 400); }
    const parsed = OpenClawDiscordInboundSchema.safeParse(body);
    if (!parsed.success) return json({ code: "request.invalid-shape", issues: parsed.error.issues }, 400);
    // Apply an earlier revision Hermes-inspired filters BEFORE normalization so we don't
    // persist messages we'd just ignore. Bridge path (openclaw) keeps the
    // old behavior — operators can ingest unfiltered there.
    const cfg = loadDirectDiscordConfig(env);
    // stored bots' channels are first-class allowed
    // channels: merge them into the env allowlist before the filter
    // decision. Fail-soft — a registry error leaves the env-only set.
    try {
      if (!deps.getRegistryStub) throw new Error("no registry stub");
      const registry = await deps.getRegistryStub();
      const bots = await (registry as unknown as {
        listDiscordBots(): Promise<Array<{ allowed_channels: string[] }>>;
      }).listDiscordBots();
      for (const b of bots) for (const ch of b.allowed_channels) cfg.allowedChannelIds.add(ch);
    } catch { /* env-only allowlist */ }
    // honour explicit non-DM classification before
    // falling back to the `guildId == null` heuristic. Polling REST
    // payloads carry `isDm: false` + `chatType: "channel"` even
    // though `guildId` is null (REST omits it). Without this
    // precedence the filter would still treat polling channel
    // traffic as DM and bypass `DISCORD_IGNORE_NO_MENTION`.
    const isDm = deriveDirectFilterIsDm(parsed.data);
    const filterRes = applyDirectFilters({
      authorId: parsed.data.authorId,
      authorIsBot: parsed.data.authorIsBot ?? false,
      isDm,
      channelId: parsed.data.channelId,
      mentionsBot: parsed.data.mentionsBot ?? false,
      // accept reply (type=19) whose referenced message was
      // authored by the AgentThursday bot as equivalent to an `@mention` for the
      // guild gate. Without this, reply-to-agent follow-ups that omit an
      // explicit mention were dropped at `applyDirectFilters`.
      replyToBot: parsed.data.replyToBot ?? false,
      mentionedUserIds: [],
    }, cfg);
    if (!filterRes.accept) {
      // an earlier revision — multipart continuation merge. When Discord
      // splits an addressed instruction into multiple messages, only the
      // first carries the `<@bot>` mention; continuations would otherwise
      // drop here. If a recent same-sender same-conversation anchor row
      // is still `received`, append this chunk's text into it so
      // `routePending` builds one merged prompt instead of dropping the
      // tail.
      //
      // Eligible reject reasons live in `CONTINUATION_ELIGIBLE_FILTER_REASONS`
      // and are dispatched via `classifyFilterRejection`. The 244k case
      // (`bot-author without mention (allowBots=mentions)`) fires BEFORE
      // the allowlist gates inside `applyDirectFilters`, so the route
      // handler must re-check allowlists explicitly via
      // `checkDirectAllowlists` before letting an unallowlisted bot's
      // chunk merge into a victim's anchor. The 244j case
      // (`guild message without @mention`) fires AFTER the allowlist
      // gates, so re-check is unnecessary there.
      const dispatch = classifyFilterRejection(filterRes.reason);
      if (dispatch.eligibleForContinuation) {
        if (dispatch.needsAllowlistRecheck) {
          const allowlistRes = checkDirectAllowlists({
            authorId: parsed.data.authorId,
            isDm,
            channelId: parsed.data.channelId,
          }, cfg);
          if (!allowlistRes.ok) {
            console.log(`[agentthursday-channel] channel.ingest.continuation.skipped provider=discord originalFilterReason=${filterRes.reason} allowlistReason=${allowlistRes.reason}`);
            return json({
              ok: false,
              ignored: true,
              reason: filterRes.reason,
              originalFilterReason: filterRes.reason,
              continuationConsidered: true,
              continuationReason: `allowlist-deny:${allowlistRes.reason}`,
            }, 200);
          }
        }
        // Continuation is text-only; we need a conversation id to look up
        // the anchor. Re-derive via `normalizeOpenClawPayload` and then
        // call the merge path with the result.
        const envelope = await normalizeOpenClawPayload(parsed.data, env);
        const stub = await deps.getChannelStub();
        const mergeResult = await stub.tryIngestContinuation({
          provider: "discord",
          conversationId: envelope.conversationId,
          senderProviderUserId: envelope.sender.providerUserId,
          senderDisplayName: envelope.sender.displayName,
          chatType: envelope.chatType,
          providerChannelId: envelope.providerChannelId,
          providerThreadId: envelope.providerThreadId,
          continuationProviderMessageId: envelope.providerMessageId,
          continuationText: envelope.text,
          attachments: envelope.attachments,
          replyToProviderMessageId: envelope.replyToProviderMessageId,
          rawSnippet: envelope.rawRef,
          receivedAt: envelope.receivedAt,
        });
        if (mergeResult.merged || mergeResult.alreadyExisted) {
          // Trace event so operators / verifier can see the merge chain.
          console.log(`[agentthursday-channel] channel.ingest.continuation.merged provider=discord conversation=${envelope.conversationId} anchor=${mergeResult.anchorProviderMessageId ?? "null"} continuation=${envelope.providerMessageId} totalChars=${mergeResult.totalCharsAfterMerge ?? "n/a"} sequence=${mergeResult.mergedSequence ?? "n/a"} originalFilterReason=${filterRes.reason} reason=${mergeResult.reason}`);
          return json({
            ok: true,
            ignored: false,
            merged: mergeResult.merged,
            alreadyExisted: mergeResult.alreadyExisted,
            anchorId: mergeResult.anchorId,
            anchorProviderMessageId: mergeResult.anchorProviderMessageId,
            continuationInboxId: mergeResult.continuationInboxId,
            conversationId: envelope.conversationId,
            totalCharsAfterMerge: mergeResult.totalCharsAfterMerge,
            mergedSequence: mergeResult.mergedSequence,
            reason: mergeResult.reason,
            originalFilterReason: filterRes.reason,
          }, 200);
        }
        // Merge declined (no anchor / cap / status race). Fall through to
        // the original ignore response with merge reason in the trace.
        console.log(`[agentthursday-channel] channel.ingest.continuation.skipped provider=discord conversation=${envelope.conversationId} continuation=${envelope.providerMessageId} originalFilterReason=${filterRes.reason} reason=${mergeResult.reason}`);
        return json({
          ok: false,
          ignored: true,
          reason: filterRes.reason,
          originalFilterReason: filterRes.reason,
          continuationConsidered: true,
          continuationReason: mergeResult.reason,
        }, 200);
      }
      return json({ ok: false, ignored: true, reason: filterRes.reason }, 200);
    }
    const envelope = await normalizeOpenClawPayload(parsed.data, env);
    const stub = await deps.getChannelStub();
    const result = await stub.ingestInbound(envelope);
    // an earlier revision v2 — first-chunk routing debounce. When the inserted
    // anchor is a guild-channel addressed Discord message, defer the
    // `routePending` call by ~2s. The inbox row sits at `status='received'`
    // during the wait, so any continuation chunks that arrive within the
    // window can still merge into the same anchor via the filter-reject
    // branch above. After the timer fires, `routePending` builds one
    // merged prompt for `submitTask`. DMs and non-addressed messages
    // route immediately (existing behavior).
    let routeSummary: AutoRouteSummary | { deferred: true; debounceMs: number } | null;
    if (result.inserted && deps.ctx && shouldDeferRoute({
      provider: "discord",
      chatType: envelope.chatType,
      addressedToAgent: envelope.addressedToAgent,
    })) {
      const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      const debounceMs = CONTINUATION_DEBOUNCE_MS_DEFAULT;
      console.log(`[agentthursday-channel] channel.ingest.route.deferred provider=discord conversation=${envelope.conversationId} providerMessageId=${envelope.providerMessageId} debounceMs=${debounceMs}`);
      deps.ctx.waitUntil((async () => {
        try {
          await sleep(debounceMs);
          const summary = await deps.autoRouteAfterIngest(stub, result.inserted);
          console.log(`[agentthursday-channel] channel.ingest.route.fired provider=discord conversation=${envelope.conversationId} providerMessageId=${envelope.providerMessageId} processed=${summary?.processed ?? 0} busySkipped=${summary?.busySkipped ?? 0} deferred=${summary?.deferred ?? 0}`);
        } catch (e) {
          console.warn("[agentthursday-channel] channel.ingest.route.deferred-fail:", String(e instanceof Error ? e.message : e).slice(0, 200));
        }
      })());
      routeSummary = { deferred: true, debounceMs };
    } else {
      routeSummary = await deps.autoRouteAfterIngest(stub, result.inserted);
    }
    // observability: log the accepted-with-signals decision
    // so multipart anchors / reply-to-bot accepts are visible in trace.
    console.log(`[agentthursday-channel] channel.ingest.accepted provider=discord conversation=${envelope.conversationId} providerMessageId=${envelope.providerMessageId} addressedToAgent=${envelope.addressedToAgent} signals=${envelope.addressedSignals.join(",") || "none"} mentionsBot=${parsed.data.mentionsBot ?? false} replyToBot=${parsed.data.replyToBot ?? false} replyTo=${envelope.replyToProviderMessageId ?? "null"}`);
    return json({
      ok: result.ok,
      inserted: result.inserted,
      id: result.id,
      status: result.status,
      conversationId: envelope.conversationId,
      addressedToAgent: envelope.addressedToAgent,
      addressedSignals: envelope.addressedSignals,
      routeSummary,
    });
  }

  // M7.3 an earlier revision helper — set channel identity role (trusted/unknown).
  if (url.pathname === "/api/channel/identity/role" && request.method === "POST") {
    let body: unknown;
    try { body = await request.json(); } catch { return json({ code: "request.invalid-json" }, 400); }
    const b = body as { provider?: string; providerUserId?: string; role?: string };
    if (
      typeof b.provider !== "string" ||
      typeof b.providerUserId !== "string" ||
      (b.role !== "trusted" && b.role !== "unknown")
    ) {
      return json({ code: "request.invalid-shape" }, 400);
    }
    const stub = await deps.getChannelStub();
    const result = await stub.setIdentityRole({
      provider: b.provider as Parameters<ChannelHubAgent["setIdentityRole"]>[0]["provider"],
      providerUserId: b.providerUserId,
      role: b.role,
    });
    return json(result);
  }

  // route pending inbox rows. Idempotent: only `received`
  // status rows are picked up, others are skipped.
  if (url.pathname === "/api/channel/route-pending" && request.method === "POST") {
    let body: unknown = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const limit = typeof (body as { limit?: number }).limit === "number"
      ? (body as { limit?: number }).limit
      : 10;
    const stub = await deps.getChannelStub();
    const result = await stub.routePending(limit);
    return json(ChannelRoutePendingResultSchema.parse(result));
  }

  // M9.0 conversation → agent live binding.
  // GET reads (returns `activeAgentId: null` for unknown/unbound
  // conversations rather than 404, so the UI has one branch instead of
  // two). POST sets or clears the binding; agent existence + status
  // are validated by RPC against the registry DO inside the callable.
  //
  // POST accepts `agent_id` (new) or `profile_id` (legacy);
  // response carries both `activeAgentId` and `activeProfileId` so
  // clients of either era work. Passing both with conflicting values
  // returns 400.
  // M9.2 — owner-scoped LIST for the user-app binding UI: the caller's
  // conversations (channel ∈ their BYO bots) + current binding. Admin → all.
  if (url.pathname === "/api/channel/conversation-binding/list" && request.method === "GET") {
    const callerChannels = await resolveCallerChannels(deps);
    const stub = await deps.getChannelStub();
    const { conversations } = await stub.listConversationsForChannels({
      channelIds: callerChannels === null ? null : [...callerChannels],
    });
    return json({ conversations });
  }

  if (url.pathname === "/api/channel/conversation-binding" && request.method === "GET") {
    const id = url.searchParams.get("conversation_id") ?? "";
    if (id.length === 0 || id.length > 200) {
      return json({ code: "request.invalid-shape", message: "conversation_id required (1..200 chars)" }, 400);
    }
    const stub = await deps.getChannelStub();
    // M9.2 — a scoped tenant may only read a binding for a conversation they own
    // (else they could probe other tenants' bindings by conversation_id).
    const callerChannels = await resolveCallerChannels(deps);
    if (callerChannels !== null) {
      const { providerChannelId } = await stub.getConversationProviderChannel({ conversationId: id });
      if (!providerChannelId || !callerChannels.has(providerChannelId)) {
        return json({ code: "forbidden", message: "not your conversation" }, 403);
      }
    }
    const result = await stub.getConversationBinding({ conversationId: id });
    return json(result);
  }

  if (url.pathname === "/api/channel/conversation-binding" && request.method === "POST") {
    let body: unknown;
    try { body = await request.json(); } catch { return json({ code: "request.invalid-json" }, 400); }
    const b = body as { conversation_id?: unknown; agent_id?: unknown; profile_id?: unknown };
    if (typeof b.conversation_id !== "string" || b.conversation_id.length === 0) {
      return json({ code: "request.invalid-shape", message: "conversation_id required" }, 400);
    }
    if (
      b.agent_id !== null
      && b.agent_id !== undefined
      && typeof b.agent_id !== "string"
    ) {
      return json({ code: "request.invalid-shape", message: "agent_id must be string or null" }, 400);
    }
    if (
      b.profile_id !== null
      && b.profile_id !== undefined
      && typeof b.profile_id !== "string"
    ) {
      return json({ code: "request.invalid-shape", message: "profile_id must be string or null" }, 400);
    }
    const stub = await deps.getChannelStub();
    // M9.2 — owner-scope a scoped tenant: they may only bind/clear a conversation
    // they OWN (channel ∈ their BYO bots) and only bind it to an agent they OWN.
    // Admin/console (callerChannels === null) keeps today's unrestricted behavior.
    const callerChannels = await resolveCallerChannels(deps);
    if (callerChannels !== null) {
      // callerChannels !== null ⇒ a scoped user; capture their id (fail closed if not).
      const callerId = deps.identity && deps.identity.kind === "user" ? deps.identity.userId : null;
      const rawTarget = b.agent_id !== undefined ? b.agent_id : b.profile_id;
      const targetAgentId = typeof rawTarget === "string" && rawTarget.trim().length > 0 ? rawTarget.trim() : null;
      const clearing = targetAgentId === null;
      let agentOwnedByCaller = false;
      if (!clearing && callerId !== null && deps.getRegistryStub) {
        const registry = await deps.getRegistryStub();
        const profile = await (registry as {
          readAgentProfile(id: string): Promise<{ owner_user_id?: string } | null>;
        }).readAgentProfile(targetAgentId);
        agentOwnedByCaller = profile != null && profile.owner_user_id === callerId;
      }
      const { providerChannelId } = await stub.getConversationProviderChannel({ conversationId: b.conversation_id });
      const decision = canBind({
        callerChannels,
        conversationChannelId: providerChannelId,
        clearing,
        agentOwnedByCaller,
      });
      if (!decision.allow) {
        return json(
          {
            code: "forbidden",
            reason: decision.reason,
            message: decision.reason === "agent_not_owned"
              ? "you can only route a channel to one of your own agents"
              : "this conversation is not in one of your bot's channels",
          },
          403,
        );
      }
    }
    const result = await stub.setConversationBinding({
      conversationId: b.conversation_id,
      agentId: (b.agent_id as string | null | undefined),
      profileId: (b.profile_id as string | null | undefined),
    });
    if (!result.ok) {
      const status = result.code === "agent_missing" || result.code === "agent_archived" ? 404
        : result.code === "validation_failed" ? 502
        : 400;
      return json(result, status);
    }
    return json(result);
  }

  // OpenClaw Discord bridge inbound. Translates the narrow
  // OpenClaw payload into ChannelMessageEnvelope and persists via an earlier revision
  // ingestInbound. Same /api/* auth gate; raw Discord JSON is NOT accepted.
  if (url.pathname === "/api/channel/discord/openclaw" && request.method === "POST") {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ code: "request.invalid-json" }, 400);
    }
    const parsed = OpenClawDiscordInboundSchema.safeParse(body);
    if (!parsed.success) {
      return json({ code: "request.invalid-shape", issues: parsed.error.issues }, 400);
    }
    const envelope = await normalizeOpenClawPayload(parsed.data, env);
    const stub = await deps.getChannelStub();
    const result = await stub.ingestInbound(envelope);
    const routeSummary = await deps.autoRouteAfterIngest(stub, result.inserted);
    // Compact normalization metadata so the bridge can surface decisions
    // without re-parsing the snapshot. No raw Discord JSON in response.
    return json({
      ok: result.ok,
      inserted: result.inserted,
      id: result.id,
      status: result.status,
      conversationId: envelope.conversationId,
      addressedToAgent: envelope.addressedToAgent,
      addressedSignals: envelope.addressedSignals,
      routeSummary,
    });
  }

  return null;
}

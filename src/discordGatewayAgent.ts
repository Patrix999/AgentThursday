/**
 *Cloudflare-native Discord Gateway runner.
 *
 * Migrates `scripts/discord-gateway-runner.ts` (host-side Node WebSocket)
 * into a Durable Object that holds the outgoing Gateway connection inside
 * Cloudflare. The host runner remains shipped as a fallback per §F;
 * see Completion Report for invocation.
 *
 * Lifecycle / billing honesty (§Constraints):
 *   - Discord Gateway is an OUTGOING WebSocket. Cloudflare DO WebSocket
 *     hibernation primarily applies to server-side accepted WebSockets.
 *     We do NOT assume this DO hibernates while the gateway socket is open.
 *     The DO is billed for active duration as long as the gateway is up.
 *   - Reconnect is bounded by `nextBackoffMs`; fatal close codes (4004 +
 *     4010-4014) trip `desiredState=stopped` so the DO doesn't spin on auth
 *     failure.
 *   - Heartbeat ACK watchdog forces reconnect on missed ACK to avoid a fake-
 *     online state that would silently drop messages.
 *
 * Out of scope ():
 *   - no multi-bot fleet manager
 *   - no attachment byte download
 *   - no UI (control via JSON API only)
 *   - no replacement of `/discord/interactions` or
 *     `/api/channel/discord/direct` ingest contract
 */

import { Agent, unstable_callable as callable } from "agents";
import {
  buildIntentsBitfield,
  eventToDirectPayload,
  nextBackoffMs,
  shouldForwardEvent,
  type DiscordMessageCreate,
  type DirectIngestPayload,
} from "./discordGatewayHelpers";
import {
  loadDiscordIngressConfig,
  type DiscordIngressMode,
  type DiscordIngressConfig,
} from "./discordIngressConfig";

export const DISCORD_GATEWAY_INSTANCE = "agent-thursday-dev";

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const DEFAULT_HEARTBEAT_MS = 41250;
// Fatal Discord Gateway close codes that should stop the runner rather than
// bouncing forever. Per Discord docs: 4004 = Authentication failed,
// 4010 = Invalid Shard, 4011 = Sharding Required, 4012 = Invalid API version,
// 4013 = Invalid Intents, 4014 = Disallowed Intent (privileged). All
// indicate operator-level config errors that retry won't fix.
function isFatalCloseCode(code: number): boolean {
  return code === 4004 || (code >= 4010 && code <= 4014);
}

type StatusRow = {
  desired_state: string;
  bot_id: string;
  session_id: string | null;
  resume_url: string | null;
  last_sequence: number | null;
  last_heartbeat_at: number | null;
  last_heartbeat_ack_at: number | null;
  last_ready_at: number | null;
  last_forwarded_at: number | null;
  reconnect_count: number;
  last_error_preview: string | null;
  started_at: number | null;
  // patch — persisted so the alarm-driven watchdog can reconnect
  // after DO hibernation without re-deriving the worker URL from a request.
  worker_origin: string | null;
  // persisted ingress mode (mirrors env config; recorded so
  // the inspect surface can show what the DO believed it was running
  // even if env was changed mid-flight). last_polled_at is the wall
  // clock of the last completed `pollAllChannels` sweep.
  ingress_mode: string | null;
  last_polled_at: number | null;
};

type CursorRow = {
  channel_id: string;
  last_seen_message_id: string | null;
  last_polled_at: number | null;
  last_error_preview: string | null;
};

export type DiscordGatewayStatus = {
  desiredState: "running" | "stopped";
  connected: boolean;
  ready: boolean;
  botId: string | null;
  sessionIdPresent: boolean;
  lastSequence: number | null;
  lastHeartbeatAt: number | null;
  lastHeartbeatAckAt: number | null;
  lastReadyAt: number | null;
  lastForwardedAt: number | null;
  reconnectCount: number;
  lastErrorPreview: string | null;
  startedAt: number | null;
  // ingress-mode-aware status surface. Older clients that
  // only know the legacy fields keep working; the polling block is
  // null in non-polling modes.
  ingressMode: DiscordIngressMode;
  pollIntervalSeconds: number;
  lastPolledAt: number | null;
  pollCursors: Array<{
    channelId: string;
    lastSeenMessageId: string | null;
    lastPolledAt: number | null;
    lastErrorPreview: string | null;
  }>;
};

/**
 * Truncate any string before it lands in audit/status. Covers the worst
 * accidental shape (a raw exception that quotes a token-bearing URL); we
 * also still log nothing token-shaped on purpose.
 */
function preview(s: unknown, max = 240): string | null {
  if (s === undefined || s === null) return null;
  const str = typeof s === "string" ? s : String(s);
  return str.length > max ? str.slice(0, max) : str;
}

// alarm interval as a function of ingress mode. Gateway
// mode keeps the 156p 120s watchdog cadence (hibernation-aware
// fallback for a missed close). Polling mode uses the configured
// poll interval (clamped 30..3600 by `loadDiscordIngressConfig`).
// Disabled mode still arms the alarm at the gateway cadence so the
// DO can pick up an env mode change without external nudging.
function computeAlarmIntervalSeconds(cfg: DiscordIngressConfig): number {
  return cfg.mode === "polling" ? cfg.pollIntervalSeconds : 120;
}

// Compare two Discord snowflake ids (decimal-only strings of up to 20
// digits). Snowflakes are 64-bit; BigInt is the only safe comparison.
// Returns -1 / 0 / 1. Defensive: malformed ids fall back to lexical.
function compareSnowflake(a: string, b: string): number {
  try {
    const ba = BigInt(a);
    const bb = BigInt(b);
    return ba < bb ? -1 : ba > bb ? 1 : 0;
  } catch {
    return a < b ? -1 : a > b ? 1 : 0;
  }
}

export class DiscordGatewayAgent extends Agent<Env, Record<string, never>> {
  // Transient (in-DO-instance, not durable across hibernation) connection
  // state. Persistent fields live in the gateway_state SQLite table so a
  // DO restart can RESUME the Gateway session instead of re-IDENTIFY.
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatIntervalMs = 0;
  private acked = true;
  private reconnectScheduled = false;
  private reconnectAttempt = 0;
  private connectedFlag = false;
  private readyFlag = false;

  async onStart(props?: unknown): Promise<void> {
    await super.onStart(props as Record<string, unknown> | undefined);
    // gateway_state holds exactly one row (rowid pinned to 1). Keeps
    // session_id / resume_url / last_sequence durable across DO restarts so
    // we can RESUME instead of IDENTIFY after a hibernation cycle.
    this.sql`
      CREATE TABLE IF NOT EXISTS gateway_state (
        rowid INTEGER PRIMARY KEY CHECK (rowid = 1),
        desired_state TEXT NOT NULL DEFAULT 'stopped',
        bot_id TEXT NOT NULL DEFAULT '',
        session_id TEXT,
        resume_url TEXT,
        last_sequence INTEGER,
        last_heartbeat_at INTEGER,
        last_heartbeat_ack_at INTEGER,
        last_ready_at INTEGER,
        last_forwarded_at INTEGER,
        reconnect_count INTEGER NOT NULL DEFAULT 0,
        last_error_preview TEXT,
        started_at INTEGER,
        worker_origin TEXT
      )
    `;
    this.sql`INSERT OR IGNORE INTO gateway_state (rowid) VALUES (1)`;
    // patch — idempotent column add for tables created before
    // worker_origin existed in the schema. SQLite throws "duplicate column"
    // when the column already exists; safe to swallow.
    try { this.sql`ALTER TABLE gateway_state ADD COLUMN worker_origin TEXT`; }
    catch { /* column already present */ }
    // additive columns for ingress mode + polling timing.
    try { this.sql`ALTER TABLE gateway_state ADD COLUMN ingress_mode TEXT`; }
    catch { /* column already present */ }
    try { this.sql`ALTER TABLE gateway_state ADD COLUMN last_polled_at INTEGER`; }
    catch { /* column already present */ }
    // per-channel polling cursor. Survives hibernation so a
    // wake-up doesn't replay the channel from the beginning.
    this.sql`
      CREATE TABLE IF NOT EXISTS discord_poll_cursors (
        channel_id TEXT PRIMARY KEY,
        last_seen_message_id TEXT,
        last_polled_at INTEGER,
        last_error_preview TEXT
      )
    `;

    // patch — alarm-driven tick. DO outgoing WebSocket dies
    // silently when the DO hibernates (close handler doesn't fire on the
    // dead instance), so we need an alarm that survives hibernation to
    // notice and reconnect. `scheduleEvery` is idempotent per the Agent
    // base contract; safe to call on every onStart wake.
    //
    // gateway watchdog at 120s as cost/noise tradeoff. The
    // in-socket heartbeat ACK watchdog (Discord's own ~41s heartbeat
    // round-trip path) is the primary signal for live socket health;
    // this alarm only catches the case where the DO hibernated and
    // the close handler never fired.
    //
    // the same alarm slot is reused for polling-mode
    // sweeps. In gateway mode the tick runs every 120s; in polling
    // mode it runs every `DISCORD_POLL_INTERVAL_SECONDS` (clamped
    // 30..3600). `watchdogTick` is mode-aware and dispatches to the
    // right path.
    const cfg = loadDiscordIngressConfig(this.env as unknown as Record<string, unknown>);
    const interval = computeAlarmIntervalSeconds(cfg);
    await this.scheduleEvery(interval, "watchdogTick");
  }

  /**
   * patch / / periodic alarm tick.
   *
   * Mode-aware. Called by the Agent base alarm scheduler on the
   * cadence chosen at `onStart` / `start` time:
   *   - gateway mode: 120s, hibernation-aware reconnect fallback.
   *   - polling mode: `DISCORD_POLL_INTERVAL_SECONDS` (default 60).
   *   - disabled mode: 120s no-op (still armed so an env mode flip
   *     resumes within one tick without external nudging).
   *
   * Must be a PUBLIC method named in `keyof this` so `scheduleEvery`
   * can refer to it. Takes no payload — all state lives in
   * `gateway_state` / `discord_poll_cursors` / env config.
   */
  async watchdogTick(): Promise<void> {
    const row = this.readState();
    if (row.desired_state !== "running") return;
    const cfg = loadDiscordIngressConfig(this.env as unknown as Record<string, unknown>);

    // If the persisted ingress mode disagrees with env, sync it so the
    // status surface reflects what we're actually doing this tick. We
    // never write env back to env; this is just the persisted shadow.
    if (row.ingress_mode !== cfg.mode) {
      this.sql`UPDATE gateway_state SET ingress_mode = ${cfg.mode} WHERE rowid = 1`;
    }

    switch (cfg.mode) {
      case "gateway": {
        if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) return;
        if (!row.worker_origin) {
          // /start hasn't populated worker_origin yet (fresh DO that
          // auto-armed the alarm before any /start request). Wait.
          return;
        }
        this.openGatewaySocket(row.worker_origin);
        return;
      }
      case "polling": {
        // Drop a stale gateway socket if we're in polling mode. Defensive:
        // mode flips mid-flight should not leave a zombie WebSocket open.
        if (this.ws !== null) {
          this.closeSocket(1000, "ingress mode switched to polling");
          this.stopHeartbeat();
        }
        if (!row.worker_origin) return;
        await this.pollAllChannels(cfg, row.worker_origin);
        return;
      }
      case "disabled": {
        if (this.ws !== null) {
          this.closeSocket(1000, "ingress disabled");
          this.stopHeartbeat();
        }
        return;
      }
    }
  }

  // ─── Public RPC API (called from Worker route handlers) ─────────────────

  @callable()
  async start(input: { workerOrigin: string }): Promise<DiscordGatewayStatus> {
    if (!input?.workerOrigin || typeof input.workerOrigin !== "string") {
      throw new Error("start: workerOrigin required");
    }
    const cleanOrigin = input.workerOrigin.replace(/\/+$/, "");
    const cfg = loadDiscordIngressConfig(this.env as unknown as Record<string, unknown>);

    // Validate required env up front. The required set depends on mode:
    //   gateway: token + shared-secret + botId (forwarder needs all three)
    //   polling: token + shared-secret + botId (REST + forwarder)
    //   disabled: nothing (we don't ingest in this mode at all)
    // We never log the token or secret value; only their presence/absence
    // is reported via status.
    const token = (this.env as { DISCORD_BOT_TOKEN?: string }).DISCORD_BOT_TOKEN;
    const sharedSecret = (this.env as { AGENT_THURSDAY_SHARED_SECRET?: string }).AGENT_THURSDAY_SHARED_SECRET;
    const botId = (this.env as { AGENT_THURSDAY_DISCORD_BOT_ID?: string }).AGENT_THURSDAY_DISCORD_BOT_ID;
    if (cfg.mode !== "disabled") {
      if (!token || !sharedSecret || !botId) {
        const missing: string[] = [];
        if (!token) missing.push("DISCORD_BOT_TOKEN");
        if (!sharedSecret) missing.push("AGENT_THURSDAY_SHARED_SECRET");
        if (!botId) missing.push("AGENT_THURSDAY_DISCORD_BOT_ID");
        throw new Error(`start: missing env: ${missing.join(", ")}`);
      }
    }

    this.sql`
      UPDATE gateway_state SET
        desired_state = 'running',
        bot_id = ${botId ?? ""},
        worker_origin = ${cleanOrigin},
        ingress_mode = ${cfg.mode},
        started_at = ${Date.now()},
        last_error_preview = NULL
      WHERE rowid = 1
    `;

    // Re-arm the alarm at the cadence appropriate to the current mode.
    // `scheduleEvery` is idempotent on the same task name, so this also
    // covers env mode flips — gateway → polling switches the cadence
    // without re-creating the DO.
    await this.scheduleEvery(computeAlarmIntervalSeconds(cfg), "watchdogTick");

    if (cfg.mode === "gateway") {
      // Existing behaviour: start (or re-affirm) the WebSocket. If one
      // is already open we just re-stamp desired_state.
      if (this.ws === null) this.openGatewaySocket(cleanOrigin);
    } else if (cfg.mode === "polling") {
      // Drop any stale socket from a previous mode, then kick off an
      // immediate first sweep so the operator sees activity right
      // after /start instead of waiting for the first alarm tick.
      if (this.ws !== null) {
        this.closeSocket(1000, "starting in polling mode");
        this.stopHeartbeat();
      }
      // Fire-and-forget: don't block /start on the REST round-trip.
      // Errors are recorded into per-channel cursor rows.
      void this.pollAllChannels(cfg, cleanOrigin).catch((e) => {
        this.recordError(`initial poll failed: ${preview(e)}`);
      });
    } else {
      // disabled — close any stale socket; alarm continues at the
      // gateway cadence as a no-op so an env flip back to gateway/polling
      // recovers within one tick.
      if (this.ws !== null) {
        this.closeSocket(1000, "ingress disabled");
        this.stopHeartbeat();
      }
    }

    return this.computeStatus();
  }

  /**
   * one-shot poll on a single channel. Used by ChannelHub
   * after a successful Discord outbox send so the polling experience
   * approaches WebSocket immediacy: a reply often surfaces a follow-up
   * user message, and we don't want to wait for the next scheduled
   * tick to ingest it.
   *
   * Cheap no-op when ingress mode is not "polling" — gateway mode
   * already has push delivery and disabled mode is intentionally
   * inert. The caller can RPC unconditionally without checking mode.
   */
  @callable()
  async pollChannelOnce(channelId: string): Promise<{ ok: boolean; mode: DiscordIngressMode; reason?: string; ingested?: number }> {
    if (typeof channelId !== "string" || channelId.length === 0) {
      return { ok: false, mode: "disabled", reason: "channel_id required" };
    }
    const cfg = loadDiscordIngressConfig(this.env as unknown as Record<string, unknown>);
    if (cfg.mode !== "polling") {
      return { ok: true, mode: cfg.mode, reason: `mode=${cfg.mode}: skip` };
    }
    if (!cfg.allowedChannels.includes(channelId)) {
      return { ok: false, mode: cfg.mode, reason: "channel not in DISCORD_ALLOWED_CHANNELS" };
    }
    const row = this.readState();
    if (!row.worker_origin) {
      return { ok: false, mode: cfg.mode, reason: "worker_origin not set; call /start first" };
    }
    const token = (this.env as { DISCORD_BOT_TOKEN?: string }).DISCORD_BOT_TOKEN;
    const sharedSecret = (this.env as { AGENT_THURSDAY_SHARED_SECRET?: string }).AGENT_THURSDAY_SHARED_SECRET;
    if (!token || !sharedSecret) {
      return { ok: false, mode: cfg.mode, reason: "missing env: DISCORD_BOT_TOKEN or AGENT_THURSDAY_SHARED_SECRET" };
    }
    // entry point is for guild channels only — ChannelHub calls
    // it after a successful Discord outbox send to chase a fast follow-up
    // user message. DM polling is driven by the alarm sweep.
    const ingested = await this.pollChannel(channelId, cfg.botId, token, sharedSecret, row.worker_origin, false);
    return { ok: true, mode: cfg.mode, ingested };
  }

  @callable()
  async stop(): Promise<DiscordGatewayStatus> {
    this.sql`UPDATE gateway_state SET desired_state = 'stopped' WHERE rowid = 1`;
    this.closeSocket(1000, "stop requested");
    this.stopHeartbeat();
    this.connectedFlag = false;
    this.readyFlag = false;
    return this.computeStatus();
  }

  @callable()
  async getStatus(): Promise<DiscordGatewayStatus> {
    return this.computeStatus();
  }

  // ─── Internal: connection lifecycle ─────────────────────────────────────

  private openGatewaySocket(workerOrigin: string): void {
    if (this.ws !== null) return;
    const row = this.readState();
    if (row.desired_state !== "running") return;

    const resumeUrl = row.resume_url;
    const url = resumeUrl ? `${resumeUrl}/?v=10&encoding=json` : GATEWAY_URL;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      this.recordError(`connect throw: ${preview(e)}`);
      this.scheduleReconnect(workerOrigin);
      return;
    }
    this.ws = ws;
    this.acked = true;
    this.connectedFlag = false;
    this.readyFlag = false;

    ws.addEventListener("open", () => {
      this.connectedFlag = true;
    });

    ws.addEventListener("message", (ev: MessageEvent) => {
      this.handleFrame(ev.data, workerOrigin);
    });

    ws.addEventListener("close", (ev: CloseEvent) => {
      this.connectedFlag = false;
      this.readyFlag = false;
      this.stopHeartbeat();
      this.ws = null;
      const code = ev.code;
      const reason = preview(ev.reason);
      this.recordError(`socket closed: code=${code} reason=${reason ?? "<none>"}`);

      if (isFatalCloseCode(code)) {
        // Auth or intent error — operator must fix env. Stop the runner so
        // we don't spin on something that retry can't repair.
        this.sql`
          UPDATE gateway_state SET
            desired_state = 'stopped',
            last_error_preview = ${`fatal close ${code}: ${reason ?? "unrecoverable"}`}
          WHERE rowid = 1
        `;
        return;
      }
      this.scheduleReconnect(workerOrigin);
    });

    ws.addEventListener("error", (ev: Event) => {
      this.recordError(`socket error: ${preview((ev as ErrorEvent).message ?? "Event")}`);
      // close handler will follow; don't double-schedule reconnect here.
    });
  }

  private scheduleReconnect(workerOrigin: string): void {
    if (this.reconnectScheduled) return;
    const row = this.readState();
    if (row.desired_state !== "running") return;
    this.reconnectScheduled = true;
    const delay = nextBackoffMs(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.sql`UPDATE gateway_state SET reconnect_count = reconnect_count + 1 WHERE rowid = 1`;
    setTimeout(() => {
      this.reconnectScheduled = false;
      const fresh = this.readState();
      if (fresh.desired_state !== "running") return;
      this.openGatewaySocket(workerOrigin);
    }, delay);
  }

  private closeSocket(code: number, reason: string): void {
    if (!this.ws) return;
    try { this.ws.close(code, reason); } catch { /* ignore */ }
    this.ws = null;
  }

  // ─── Internal: protocol handling ────────────────────────────────────────

  private handleFrame(data: unknown, workerOrigin: string): void {
    const text = typeof data === "string" ? data : (() => { try { return new TextDecoder().decode(data as ArrayBuffer); } catch { return ""; } })();
    if (!text) return;
    let frame: { op: number; t?: string | null; s?: number | null; d?: unknown };
    try { frame = JSON.parse(text); }
    catch (e) { this.recordError(`frame parse: ${preview(e)}`); return; }
    if (typeof frame.s === "number") this.persistSequence(frame.s);

    switch (frame.op) {
      case 10: {
        const d = frame.d as { heartbeat_interval?: number };
        this.heartbeatIntervalMs = d?.heartbeat_interval ?? DEFAULT_HEARTBEAT_MS;
        // First heartbeat after a small jittered delay (Discord recommendation).
        const initialJitter = Math.floor(this.heartbeatIntervalMs * Math.random());
        setTimeout(() => this.sendHeartbeat(), initialJitter);
        this.startHeartbeat();
        const row = this.readState();
        if (row.session_id && row.last_sequence !== null) this.sendResume(row.session_id, row.last_sequence);
        else this.sendIdentify();
        break;
      }
      case 11: {
        this.acked = true;
        this.sql`UPDATE gateway_state SET last_heartbeat_ack_at = ${Date.now()} WHERE rowid = 1`;
        break;
      }
      case 7: {
        this.recordError("gateway requested reconnect");
        this.closeSocket(4000, "reconnect requested");
        break;
      }
      case 9: {
        const resumable = frame.d === true;
        if (!resumable) {
          this.sql`UPDATE gateway_state SET session_id = NULL, last_sequence = NULL, resume_url = NULL WHERE rowid = 1`;
        }
        const delay = 1500 + Math.floor(Math.random() * 3500);
        setTimeout(() => {
          if (!this.ws) return;
          const row = this.readState();
          if (resumable && row.session_id && row.last_sequence !== null) this.sendResume(row.session_id, row.last_sequence);
          else this.sendIdentify();
        }, delay);
        break;
      }
      case 0: {
        const t = frame.t;
        if (t === "READY") {
          const d = frame.d as { session_id?: string; resume_gateway_url?: string; user?: { id?: string; username?: string } };
          // Identity assertion: token must hand back the bot we expected. If
          // DISCORD_BOT_TOKEN belongs to a different application than
          // AGENT_THURSDAY_DISCORD_BOT_ID, the runner could otherwise look "ready" and
          // silently route messages under the wrong bot identity. Treat as a
          // fatal misconfiguration like 4004 — stop, surface error, force the
          // operator to fix env before /start works again.
          const expectedBotId = (this.env as { AGENT_THURSDAY_DISCORD_BOT_ID?: string }).AGENT_THURSDAY_DISCORD_BOT_ID ?? "";
          const actualUserId = d?.user?.id ?? "";
          if (!expectedBotId || actualUserId !== expectedBotId) {
            this.sql`
              UPDATE gateway_state SET
                desired_state = 'stopped',
                last_error_preview = ${`READY user.id mismatch: expected=${expectedBotId || "<unset>"} actual=${actualUserId || "<unset>"}`}
              WHERE rowid = 1
            `;
            this.closeSocket(1000, "ready user.id mismatch");
            this.stopHeartbeat();
            this.connectedFlag = false;
            this.readyFlag = false;
            return;
          }
          const sessionId = d?.session_id ?? null;
          const resumeUrl = d?.resume_gateway_url ?? null;
          this.sql`
            UPDATE gateway_state SET
              session_id = ${sessionId},
              resume_url = ${resumeUrl},
              last_ready_at = ${Date.now()}
            WHERE rowid = 1
          `;
          this.readyFlag = true;
          this.reconnectAttempt = 0;
        } else if (t === "RESUMED") {
          this.readyFlag = true;
          this.reconnectAttempt = 0;
          this.sql`UPDATE gateway_state SET last_ready_at = ${Date.now()} WHERE rowid = 1`;
        } else if (t === "MESSAGE_CREATE") {
          const event = frame.d as DiscordMessageCreate;
          // Fire-and-forget: forwarding errors are logged via recordError but
          // never block the gateway dispatch loop. §D backoff is
          // expressed by Worker-side route returning quickly; if the Worker
          // is genuinely unreachable, the next message logs the same kind of
          // error and we don't tight-loop.
          void this.forwardMessage(workerOrigin, event);
        }
        break;
      }
      default:
        break;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (!this.acked) {
        this.recordError("heartbeat not ACKed, forcing reconnect");
        this.closeSocket(4000, "heartbeat watchdog");
        return;
      }
      this.sendHeartbeat();
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private sendHeartbeat(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.acked = false;
    const row = this.readState();
    this.ws.send(JSON.stringify({ op: 1, d: row.last_sequence }));
    this.sql`UPDATE gateway_state SET last_heartbeat_at = ${Date.now()} WHERE rowid = 1`;
  }

  private sendIdentify(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const token = (this.env as { DISCORD_BOT_TOKEN?: string }).DISCORD_BOT_TOKEN;
    if (!token) {
      this.recordError("IDENTIFY skipped: DISCORD_BOT_TOKEN missing");
      return;
    }
    const intents = buildIntentsBitfield({
      guilds: true,
      guildMessages: true,
      directMessages: true,
      messageContent: true,
    });
    this.ws.send(JSON.stringify({
      op: 2,
      d: {
        token,
        intents,
        properties: {
          os: "linux",
          browser: "agent-thursday-gateway-do",
          device: "agent-thursday-gateway-do",
        },
      },
    }));
  }

  private sendResume(sessionId: string, lastSequence: number): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const token = (this.env as { DISCORD_BOT_TOKEN?: string }).DISCORD_BOT_TOKEN;
    if (!token) {
      this.recordError("RESUME skipped: DISCORD_BOT_TOKEN missing");
      return;
    }
    this.ws.send(JSON.stringify({
      op: 6,
      d: { token, session_id: sessionId, seq: lastSequence },
    }));
  }

  // ─── Internal: forward MESSAGE_CREATE to ChannelHub direct-ingest ───────

  private async forwardMessage(
    workerOrigin: string,
    event: DiscordMessageCreate,
    opts?: { isDmOverride?: boolean },
  ): Promise<void> {
    const botId = (this.env as { AGENT_THURSDAY_DISCORD_BOT_ID?: string }).AGENT_THURSDAY_DISCORD_BOT_ID ?? "";
    const decision = shouldForwardEvent(event, botId);
    if (!decision.forward) return;
    const sharedSecret = (this.env as { AGENT_THURSDAY_SHARED_SECRET?: string }).AGENT_THURSDAY_SHARED_SECRET;
    if (!sharedSecret) {
      this.recordError("forward skipped: AGENT_THURSDAY_SHARED_SECRET missing");
      return;
    }
    // pass DM-override so polling-sourced guild messages
    // (which arrive without `guild_id` over REST) aren't mistaken
    // for DMs. Gateway WS path leaves `opts` undefined so the
    // existing `!event.guild_id` heuristic still drives.
    const payload: DirectIngestPayload = eventToDirectPayload(event, botId, opts);
    try {
      const res = await fetch(`${workerOrigin}/api/channel/discord/direct`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-AgentThursday-Secret": sharedSecret },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const bodyPreview = preview(await res.text().catch(() => ""), 200);
        this.recordError(`forward HTTP ${res.status}: ${bodyPreview}`);
        return;
      }
      this.sql`UPDATE gateway_state SET last_forwarded_at = ${Date.now()} WHERE rowid = 1`;
    } catch (e) {
      this.recordError(`forward exception: ${preview(e)}`);
    }
  }

  // ─── : REST polling path ────────────────────────────────────────

  /**
   * Sweep all `DISCORD_ALLOWED_CHANNELS`, fetching new messages via
   * Discord REST and forwarding through the same `/api/channel/discord/direct`
   * pipeline that the Gateway WebSocket path uses. Per-channel cursors
   * are persisted in `discord_poll_cursors` so a hibernate cycle
   * doesn't replay history. Errors are recorded on the cursor row,
   * never thrown — a single bad channel must not stop the sweep.
   */
  private async pollAllChannels(cfg: DiscordIngressConfig, workerOrigin: string): Promise<void> {
    if (cfg.allowedChannels.length === 0 && cfg.pollDmUserIds.length === 0) {
      this.recordError("polling skipped: DISCORD_ALLOWED_CHANNELS and DISCORD_POLL_DM_USER_IDS both empty");
      return;
    }
    const token = (this.env as { DISCORD_BOT_TOKEN?: string }).DISCORD_BOT_TOKEN;
    const sharedSecret = (this.env as { AGENT_THURSDAY_SHARED_SECRET?: string }).AGENT_THURSDAY_SHARED_SECRET;
    if (!token) { this.recordError("polling skipped: DISCORD_BOT_TOKEN missing"); return; }
    if (!sharedSecret) { this.recordError("polling skipped: AGENT_THURSDAY_SHARED_SECRET missing"); return; }
    for (const channelId of cfg.allowedChannels) {
      try {
        await this.pollChannel(channelId, cfg.botId, token, sharedSecret, workerOrigin, false);
      } catch (e) {
        this.recordCursorError(channelId, `sweep exception: ${preview(e)}`);
      }
    }
    // DM ingress for polling mode. Each configured user id is
    // resolved (idempotent) to a DM channel id via REST and polled like a
    // guild channel, but forwarded with `isDm:true` so direct-ingest /
    // ChannelHub classify it as `chatType:"dm"`. DM channel ids are
    // globally unique snowflakes so they share the same `discord_poll_cursors`
    // keyspace as guild channel ids without collision risk.
    for (const userId of cfg.pollDmUserIds) {
      try {
        const dmChannelId = await this.resolveDmChannelId(userId, token);
        if (!dmChannelId) continue;   // resolveDmChannelId already recorded error
        await this.pollChannel(dmChannelId, cfg.botId, token, sharedSecret, workerOrigin, true);
      } catch (e) {
        // Cursor row may not exist yet for a DM that's never been resolved;
        // best-effort log against the user id slot to keep diagnostics non-secret.
        this.recordCursorError(`dm:${userId}`, `dm sweep exception: ${preview(e)}`);
      }
    }
    this.sql`UPDATE gateway_state SET last_polled_at = ${Date.now()} WHERE rowid = 1`;
  }

  /**
   * resolve a Discord user id to its DM channel id via
   * `POST /users/@me/channels`. The endpoint is idempotent: Discord
   * returns the existing DM channel if one already exists, or
   * creates one. Authorization header is the bot token; never written
   * to logs / status / cursor diagnostics.
   *
   * Returns `null` on any failure (HTTP non-2xx, parse error, missing
   * id field) and records a bounded, non-secret error against the
   * `dm:${userId}` cursor slot so the operator can see what's wrong
   * without exposing the token in `lastErrorPreview`.
   */
  private async resolveDmChannelId(userId: string, token: string): Promise<string | null> {
    const apiBase = ((this.env as { DISCORD_API_BASE_URL?: string }).DISCORD_API_BASE_URL ?? "https://discord.com/api/v10").replace(/\/+$/, "");
    let res: Response;
    try {
      res = await fetch(`${apiBase}/users/@me/channels`, {
        method: "POST",
        headers: {
          "Authorization": `Bot ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "agent-thursday-discord-poll/1",
        },
        body: JSON.stringify({ recipient_id: userId }),
      });
    } catch (e) {
      this.recordCursorError(`dm:${userId}`, `dm-channel resolve fetch throw: ${preview(e)}`);
      return null;
    }
    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      this.recordCursorError(`dm:${userId}`, `dm-channel resolve rate limited: retry-after=${retryAfter ?? "unknown"}`);
      return null;
    }
    if (!res.ok) {
      const bodyPreview = preview(await res.text().catch(() => ""), 200);
      this.recordCursorError(`dm:${userId}`, `dm-channel resolve HTTP ${res.status}: ${bodyPreview}`);
      return null;
    }
    let raw: unknown;
    try { raw = await res.json(); }
    catch (e) {
      this.recordCursorError(`dm:${userId}`, `dm-channel resolve json parse: ${preview(e)}`);
      return null;
    }
    const channelId = (raw as { id?: string } | null)?.id;
    if (typeof channelId !== "string" || channelId.length === 0) {
      this.recordCursorError(`dm:${userId}`, "dm-channel resolve: missing id");
      return null;
    }
    return channelId;
  }

  /**
   * Poll one channel. Returns the count ingested. First call (no
   * cursor) bootstraps the cursor to the latest message id without
   * replaying history — otherwise fresh deploys flood the inbox with
   * pre-deploy messages.
   *
   * Discord REST contract:
   *   GET /channels/{channel.id}/messages?after={X}&limit=N
   *   Returns up to N most-recent messages with id > X, NEWEST FIRST.
   *   429 carries Retry-After (seconds, may be sub-second decimal).
   */
  private async pollChannel(
    channelId: string,
    botId: string,
    token: string,
    sharedSecret: string,
    workerOrigin: string,
    isDm: boolean,
  ): Promise<number> {
    const cursor = this.readCursor(channelId);
    const isBootstrap = !cursor || !cursor.last_seen_message_id;
    const apiBase = ((this.env as { DISCORD_API_BASE_URL?: string }).DISCORD_API_BASE_URL ?? "https://discord.com/api/v10").replace(/\/+$/, "");
    const url = new URL(`${apiBase}/channels/${channelId}/messages`);
    url.searchParams.set("limit", isBootstrap ? "1" : "50");
    if (!isBootstrap && cursor?.last_seen_message_id) {
      url.searchParams.set("after", cursor.last_seen_message_id);
    }

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: { "Authorization": `Bot ${token}`, "User-Agent": "agent-thursday-discord-poll/1" },
      });
    } catch (e) {
      this.recordCursorError(channelId, `fetch throw: ${preview(e)}`);
      return 0;
    }
    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      this.recordCursorError(channelId, `rate limited: retry-after=${retryAfter ?? "unknown"}`);
      return 0;
    }
    if (!res.ok) {
      const bodyPreview = preview(await res.text().catch(() => ""), 200);
      this.recordCursorError(channelId, `HTTP ${res.status}: ${bodyPreview}`);
      return 0;
    }

    let raw: unknown;
    try { raw = await res.json(); }
    catch (e) {
      this.recordCursorError(channelId, `json parse: ${preview(e)}`);
      return 0;
    }
    const messages = Array.isArray(raw) ? (raw as DiscordMessageCreate[]) : [];
    if (messages.length === 0) {
      // No new messages; just stamp last_polled_at.
      this.touchCursor(channelId);
      return 0;
    }

    // Discord returns newest-first; ingest oldest-first so inbox order
    // matches WebSocket push order.
    const ascending = [...messages].sort((a, b) => compareSnowflake(a.id, b.id));
    const newestId = ascending[ascending.length - 1].id;

    if (isBootstrap) {
      // Don't ingest historical messages on first run; just plant the
      // cursor at the most recent so subsequent polls only see truly
      // new traffic.
      this.persistCursor(channelId, newestId);
      return 0;
    }

    let ingested = 0;
    for (const m of ascending) {
      if (!m || typeof m.id !== "string") continue;
      // Re-use the same forward path the WebSocket handler uses, which
      // re-applies `shouldForwardEvent` filtering (self-bot, system
      // message types) and posts the canonical `DirectIngestPayload`.
      // / 170 — `pollChannel` is called for both guild
      // channel ids (`isDm:false`, classify as `chatType:"channel"`)
      // and resolved DM channel ids (`isDm:true`, classify as
      // `chatType:"dm"`). Discord REST's response for either path
      // omits `guild_id` so the heuristic in `eventToDirectPayload`
      // would otherwise mis-classify guild messages as DMs;
      // `isDmOverride` makes the call site authoritative.
      try {
        await this.forwardMessage(workerOrigin, m, { isDmOverride: isDm });
        ingested += 1;
      } catch (e) {
        this.recordCursorError(channelId, `forward throw: ${preview(e)}`);
      }
    }
    this.persistCursor(channelId, newestId);
    return ingested;
  }

  private readCursor(channelId: string): CursorRow | null {
    const rows = this.sql<CursorRow>`
      SELECT channel_id, last_seen_message_id, last_polled_at, last_error_preview
      FROM discord_poll_cursors WHERE channel_id = ${channelId} LIMIT 1
    `;
    return rows[0] ?? null;
  }

  private persistCursor(channelId: string, newestId: string): void {
    const now = Date.now();
    this.sql`
      INSERT INTO discord_poll_cursors (channel_id, last_seen_message_id, last_polled_at, last_error_preview)
      VALUES (${channelId}, ${newestId}, ${now}, NULL)
      ON CONFLICT(channel_id) DO UPDATE SET
        last_seen_message_id = excluded.last_seen_message_id,
        last_polled_at = excluded.last_polled_at,
        last_error_preview = NULL
    `;
  }

  private touchCursor(channelId: string): void {
    const now = Date.now();
    this.sql`
      INSERT INTO discord_poll_cursors (channel_id, last_seen_message_id, last_polled_at, last_error_preview)
      VALUES (${channelId}, NULL, ${now}, NULL)
      ON CONFLICT(channel_id) DO UPDATE SET
        last_polled_at = excluded.last_polled_at
    `;
  }

  private recordCursorError(channelId: string, msg: string): void {
    const truncated = preview(msg);
    const now = Date.now();
    this.sql`
      INSERT INTO discord_poll_cursors (channel_id, last_seen_message_id, last_polled_at, last_error_preview)
      VALUES (${channelId}, NULL, ${now}, ${truncated})
      ON CONFLICT(channel_id) DO UPDATE SET
        last_polled_at = excluded.last_polled_at,
        last_error_preview = excluded.last_error_preview
    `;
  }

  private readAllCursors(): CursorRow[] {
    return this.sql<CursorRow>`
      SELECT channel_id, last_seen_message_id, last_polled_at, last_error_preview
      FROM discord_poll_cursors ORDER BY channel_id ASC
    `;
  }

  // ─── Internal: persistence + status helpers ─────────────────────────────

  private persistSequence(s: number): void {
    this.sql`UPDATE gateway_state SET last_sequence = ${s} WHERE rowid = 1`;
  }

  private recordError(msg: string): void {
    const truncated = preview(msg);
    this.sql`UPDATE gateway_state SET last_error_preview = ${truncated} WHERE rowid = 1`;
  }

  private readState(): StatusRow {
    const rows = this.sql<StatusRow>`SELECT * FROM gateway_state WHERE rowid = 1`;
    return rows[0] ?? {
      desired_state: "stopped",
      bot_id: "",
      session_id: null,
      resume_url: null,
      last_sequence: null,
      last_heartbeat_at: null,
      last_heartbeat_ack_at: null,
      last_ready_at: null,
      last_forwarded_at: null,
      reconnect_count: 0,
      last_error_preview: null,
      started_at: null,
      worker_origin: null,
      ingress_mode: null,
      last_polled_at: null,
    };
  }

  private computeStatus(): DiscordGatewayStatus {
    const row = this.readState();
    const cfg = loadDiscordIngressConfig(this.env as unknown as Record<string, unknown>);
    const cursors = this.readAllCursors();
    return {
      desiredState: (row.desired_state === "running" ? "running" : "stopped"),
      connected: this.connectedFlag,
      ready: this.readyFlag,
      botId: row.bot_id || null,
      sessionIdPresent: !!row.session_id,
      lastSequence: row.last_sequence,
      lastHeartbeatAt: row.last_heartbeat_at,
      lastHeartbeatAckAt: row.last_heartbeat_ack_at,
      lastReadyAt: row.last_ready_at,
      lastForwardedAt: row.last_forwarded_at,
      reconnectCount: row.reconnect_count,
      lastErrorPreview: row.last_error_preview,
      startedAt: row.started_at,
      ingressMode: cfg.mode,
      pollIntervalSeconds: cfg.pollIntervalSeconds,
      lastPolledAt: row.last_polled_at,
      pollCursors: cursors.map(c => ({
        channelId: c.channel_id,
        lastSeenMessageId: c.last_seen_message_id,
        lastPolledAt: c.last_polled_at,
        lastErrorPreview: c.last_error_preview,
      })),
    };
  }
}

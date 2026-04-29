/**
 * Cloudflare-native Discord Gateway runner.
 *
 * Migrates `scripts/discord-gateway-runner.ts` (host-side Node WebSocket)
 * into a Durable Object that holds the outgoing Gateway connection inside
 * Cloudflare. The host runner remains shipped as a fallback per  §F;
 * see Completion Report for invocation.
 *
 * Lifecycle / billing honesty ( §Constraints):
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
  //  patch — persisted so the alarm-driven watchdog can reconnect
  // after DO hibernation without re-deriving the worker URL from a request.
  worker_origin: string | null;
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
    //  patch — idempotent column add for tables created before
    // worker_origin existed in the schema. SQLite throws "duplicate column"
    // when the column already exists; safe to swallow.
    try { this.sql`ALTER TABLE gateway_state ADD COLUMN worker_origin TEXT`; }
    catch { /* column already present */ }

    //  patch — alarm-driven watchdog. DO outgoing WebSocket dies
    // silently when the DO hibernates (close handler doesn't fire on the
    // dead instance), so we need an alarm that survives hibernation to
    // notice and reconnect. `scheduleEvery` is idempotent per the Agent
    // base contract; safe to call on every onStart wake.
    //
    // Picked 20s because:
    //   - Discord heartbeat interval is ~41s; if heartbeat watchdog hasn't
    //     forced a close yet, the alarm catches the rest within ~20s
    //   - Faster than the 30s cap of nextBackoffMs so backoff still matters
    //     for in-DO retry, but slower than a tight loop on auth failure
    //     (fatal close codes already set desired_state='stopped' and skip)
    await this.scheduleEvery(20, "watchdogTick");
  }

  /**
   *  patch — periodic watchdog. Called every 20s by Agent's alarm
   * scheduler (survives DO hibernation). If desired_state is "running" but
   * we don't have a live WebSocket, reconnect.
   *
   * Must be a PUBLIC method named in `keyof this` so `scheduleEvery` can
   * refer to it. Takes no payload — all state lives in gateway_state.
   */
  async watchdogTick(): Promise<void> {
    const row = this.readState();
    if (row.desired_state !== "running") return;
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) return;
    if (!row.worker_origin) {
      // /start hasn't been called since this row was created (e.g. fresh
      // DO that auto-started the alarm before any /start request). Wait
      // for /start to populate worker_origin.
      return;
    }
    this.openGatewaySocket(row.worker_origin);
  }

  // ─── Public RPC API (called from Worker route handlers) ─────────────────

  @callable()
  async start(input: { workerOrigin: string }): Promise<DiscordGatewayStatus> {
    if (!input?.workerOrigin || typeof input.workerOrigin !== "string") {
      throw new Error("start: workerOrigin required");
    }
    const cleanOrigin = input.workerOrigin.replace(/\/+$/, "");

    // Validate required env up front. We never log the token or secret value;
    // only their presence/absence is reported via status.
    const token = (this.env as { DISCORD_BOT_TOKEN?: string }).DISCORD_BOT_TOKEN;
    const sharedSecret = (this.env as { AGENT_THURSDAY_SHARED_SECRET?: string }).AGENT_THURSDAY_SHARED_SECRET;
    const botId = (this.env as { AGENT_THURSDAY_DISCORD_BOT_ID?: string }).AGENT_THURSDAY_DISCORD_BOT_ID;
    if (!token || !sharedSecret || !botId) {
      const missing: string[] = [];
      if (!token) missing.push("DISCORD_BOT_TOKEN");
      if (!sharedSecret) missing.push("AGENT_THURSDAY_SHARED_SECRET");
      if (!botId) missing.push("AGENT_THURSDAY_DISCORD_BOT_ID");
      throw new Error(`start: missing env: ${missing.join(", ")}`);
    }

    this.sql`
      UPDATE gateway_state SET
        desired_state = 'running',
        bot_id = ${botId},
        worker_origin = ${cleanOrigin},
        started_at = ${Date.now()},
        last_error_preview = NULL
      WHERE rowid = 1
    `;
    // If we already have a live socket, calling start() is idempotent — the
    // existing connection keeps running and we just re-affirm the desired
    // state. Otherwise open a fresh connection.
    if (this.ws === null) {
      this.openGatewaySocket(cleanOrigin);
    }
    return this.computeStatus();
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
          // never block the gateway dispatch loop.  §D backoff is
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

  private async forwardMessage(workerOrigin: string, event: DiscordMessageCreate): Promise<void> {
    const botId = (this.env as { AGENT_THURSDAY_DISCORD_BOT_ID?: string }).AGENT_THURSDAY_DISCORD_BOT_ID ?? "";
    const decision = shouldForwardEvent(event, botId);
    if (!decision.forward) return;
    const sharedSecret = (this.env as { AGENT_THURSDAY_SHARED_SECRET?: string }).AGENT_THURSDAY_SHARED_SECRET;
    if (!sharedSecret) {
      this.recordError("forward skipped: AGENT_THURSDAY_SHARED_SECRET missing");
      return;
    }
    const payload: DirectIngestPayload = eventToDirectPayload(event, botId);
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
    };
  }

  private computeStatus(): DiscordGatewayStatus {
    const row = this.readState();
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
    };
  }
}

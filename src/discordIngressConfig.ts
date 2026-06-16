/**
 *  — Discord ingress mode config helper.
 *
 * Pure, no I/O; reads env at call site. Three modes are supported:
 *
 *   gateway   Persistent WebSocket on `DiscordGatewayAgent` DO. Real-time
 *             MESSAGE_CREATE push, bot online/presence visible. Higher
 *             Durable Object duration cost (always-on socket + alarm
 *             watchdog at 120s). This is the legacy default.
 *
 *   polling   No WebSocket. The DO's alarm wakes every
 *             `DISCORD_POLL_INTERVAL_SECONDS` (clamped 30..3600, default
 *             60) and fetches `/channels/{id}/messages?after={cursor}` for
 *             each `DISCORD_ALLOWED_CHANNELS` entry. Per-channel cursor
 *             survives DO hibernation. No bot online/presence; first
 *             message latency = poll interval. Lower duration cost; one
 *             REST call per channel per tick instead of an idle socket.
 *
 *   disabled  No WebSocket, no polling. HTTP-side `/api/channel/discord/direct`
 *             still accepts external bridges / interactions. Useful when
 *             the operator wants to control ingress entirely externally.
 *
 * The 156p watchdog (120s) only matters in `gateway` mode; in `polling`
 * mode the same alarm slot is reused at the polling interval.
 */

export type DiscordIngressMode = "gateway" | "polling" | "disabled";

export type DiscordIngressConfig = {
  mode: DiscordIngressMode;
  pollIntervalSeconds: number;   // clamped to [POLL_INTERVAL_MIN, POLL_INTERVAL_MAX]
  allowedChannels: string[];     // parsed from comma-separated DISCORD_ALLOWED_CHANNELS
  //  — Discord user ids whose DM channels should be polled as part
  // of the same alarm sweep. Polling-mode-only; gateway mode receives DM
  // MESSAGE_CREATE pushes via the WS subscription. Each id resolves to a
  // DM channel via Discord REST `POST /users/@me/channels` (idempotent).
  pollDmUserIds: string[];
  botId: string;                 // AGENT_THURSDAY_DISCORD_BOT_ID; "" if unset
  hasToken: boolean;             // DISCORD_BOT_TOKEN presence (never the value)
  hasSharedSecret: boolean;      // AGENT_THURSDAY_SHARED_SECRET presence
};

export const POLL_INTERVAL_DEFAULT = 60;
export const POLL_INTERVAL_MIN = 30;       // floor — Discord docs warn about excessive REST polling
export const POLL_INTERVAL_MAX = 3600;     // 1h ceiling — anything slower is effectively disabled

type IngressEnv = {
  DISCORD_INGRESS_MODE?: string;
  DISCORD_POLL_INTERVAL_SECONDS?: string | number;
  DISCORD_ALLOWED_CHANNELS?: string;
  DISCORD_POLL_DM_USER_IDS?: string;
  AGENT_THURSDAY_DISCORD_BOT_ID?: string;
  DISCORD_BOT_TOKEN?: string;
  AGENT_THURSDAY_SHARED_SECRET?: string;
};

export function loadDiscordIngressConfig(env: IngressEnv): DiscordIngressConfig {
  const rawMode = String(env.DISCORD_INGRESS_MODE ?? "").toLowerCase().trim();
  const mode: DiscordIngressMode =
    rawMode === "polling" ? "polling"
      : rawMode === "disabled" ? "disabled"
      : "gateway";   // unset / unknown → backwards-compatible default

  const intervalRaw = typeof env.DISCORD_POLL_INTERVAL_SECONDS === "number"
    ? env.DISCORD_POLL_INTERVAL_SECONDS
    : parseInt(String(env.DISCORD_POLL_INTERVAL_SECONDS ?? "").trim(), 10);
  const intervalCandidate = Number.isFinite(intervalRaw) && (intervalRaw as number) > 0
    ? (intervalRaw as number)
    : POLL_INTERVAL_DEFAULT;
  const pollIntervalSeconds = Math.min(POLL_INTERVAL_MAX, Math.max(POLL_INTERVAL_MIN, Math.floor(intervalCandidate)));

  const allowedChannels = String(env.DISCORD_ALLOWED_CHANNELS ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  //  — DM user ids to poll. Same comma-separated parser as
  // allowedChannels; values are Discord snowflake user ids. Empty means
  // "no DM polling" (the default for any deployment that doesn't opt in).
  const pollDmUserIds = String(env.DISCORD_POLL_DM_USER_IDS ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  return {
    mode,
    pollIntervalSeconds,
    allowedChannels,
    pollDmUserIds,
    botId: env.AGENT_THURSDAY_DISCORD_BOT_ID ?? "",
    hasToken: !!env.DISCORD_BOT_TOKEN,
    hasSharedSecret: !!env.AGENT_THURSDAY_SHARED_SECRET,
  };
}

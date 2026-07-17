// dashboard composition helper moved from `src/server.ts`
// (pre-edit lines 633-656). `Env` is declared globally in
// `worker-configuration.d.ts`; no import needed.

// narrow each field independently. Reading
// `env.VERSION_METADATA` could in principle yield a binding that
// doesn't match the documented `{ id, tag, timestamp }` shape (e.g.
// future runtime changes, mocked dev shim, or a typo'd binding). The
// per-field guard keeps the dashboard truthful: if a field is
// non-string we report `null`, never coerce. Never throws.
export function readWorkerVersionMetadata(env: Env): {
  worker_version_id: string | null;
  worker_version_tag: string | null;
  worker_version_timestamp: string | null;
} {
  const empty = {
    worker_version_id: null,
    worker_version_tag: null,
    worker_version_timestamp: null,
  };
  try {
    const meta = (env as { VERSION_METADATA?: unknown }).VERSION_METADATA;
    if (!meta || typeof meta !== "object") return empty;
    const m = meta as Record<string, unknown>;
    return {
      worker_version_id: typeof m.id === "string" && m.id.length > 0 ? m.id : null,
      worker_version_tag: typeof m.tag === "string" && m.tag.length > 0 ? m.tag : null,
      worker_version_timestamp:
        typeof m.timestamp === "string" && m.timestamp.length > 0 ? m.timestamp : null,
    };
  } catch {
    return empty;
  }
}

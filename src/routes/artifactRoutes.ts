import { getAgentByName } from "agents";
import { json } from "../httpUtil";
import type { AgentThursdayAgent } from "../server";

/**
 * `/api/artifact/*` routes extracted from `server.ts`.
 *
 * Single entry point: `handleApiArtifact(stub, request, url)`.
 * Path-parsing, method routing, error-code → HTTP-status mapping
 * preserved verbatim. The stub is resolved at the composition root
 * (canonical active) and passed in.
 *
 * Routes covered:
 *   GET  /api/artifact/<card_id>            → list envelopes
 *   GET  /api/artifact/<card_id>/<filename> → read { envelope, content }
 *   POST /api/artifact/<card_id>/<filename> → write { envelope }
 *
 * Behavior preserved:
 *   - Same path parsing (slice off `/api/artifact/`, decodeURIComponent).
 *   - Same > 2 segment rejection.
 *   - Same empty-cardId rejection.
 *   - Same error-code → status table:
 *       list:  invalid_card_id → 400, else 500.
 *       read:  not_found → 404; invalid_card_id|invalid_filename → 400;
 *              denied_path → 403; else 500.
 *       write: secret_pattern → 422; oversize → 413; denied_path → 403;
 *              else 400.
 *   - Same method-not-allowed fallback → 405.
 *   - No response field echoes server-side secret values; only
 *     user-provided fields and server-computed digests (245c §9.3 /
 *     245b parity).
 *
 * Auth: gated by the `/api/*` umbrella in `server.ts`. This handler
 * never re-checks.
 */

type AgentThursdayAgentStub = Awaited<ReturnType<typeof getAgentByName<Env, AgentThursdayAgent>>>;

export async function handleApiArtifact(
  stub: AgentThursdayAgentStub,
  request: Request,
  url: URL,
): Promise<Response> {
  const tail = url.pathname.slice("/api/artifact/".length);
  const segs = tail.split("/").filter(s => s.length > 0);
  const cardId = segs[0] ? decodeURIComponent(segs[0]) : "";
  const filename = segs[1] ? decodeURIComponent(segs[1]) : "";
  if (segs.length > 2) {
    return json({ error: { code: "invalid_path", message: "expected /api/artifact/<card_id>[/<filename>]" } }, 400);
  }
  if (cardId.length === 0) {
    return json({ error: { code: "invalid_card_id", message: "card_id required" } }, 400);
  }

  if (request.method === "GET" && segs.length === 1) {
    const result = await stub.listArtifacts({ cardId });
    if (!result.ok) {
      const status = result.error.code === "invalid_card_id" ? 400 : 500;
      return json({ error: result.error }, status);
    }
    return json({ card_id: result.card_id, envelopes: result.envelopes });
  }

  if (request.method === "GET" && segs.length === 2) {
    const result = await stub.readArtifact({ cardId, filename });
    if (!result.ok) {
      const code = result.error.code;
      const status =
        code === "not_found"
          ? 404
          : code === "invalid_card_id" || code === "invalid_filename"
            ? 400
            : code === "denied_path"
              ? 403
              : 500;
      return json({ error: result.error }, status);
    }
    return json({ envelope: result.envelope, content: result.content });
  }

  if (request.method === "POST" && segs.length === 2) {
    const raw = (await request.json().catch(() => ({}))) as {
      type?: unknown;
      source_agent?: unknown;
      mime?: unknown;
      notes?: unknown;
      producer_user_id?: unknown;
      content?: unknown;
    };
    const result = await stub.writeArtifact({
      cardId,
      filename,
      type: typeof raw.type === "string" ? raw.type : "",
      sourceAgent: typeof raw.source_agent === "string" ? raw.source_agent : "",
      ...(typeof raw.producer_user_id === "string"
        ? { producerUserId: raw.producer_user_id }
        : {}),
      ...(typeof raw.mime === "string" ? { mime: raw.mime } : {}),
      ...(typeof raw.notes === "string" ? { notes: raw.notes } : {}),
      content: typeof raw.content === "string" ? raw.content : "",
    });
    if (!result.ok) {
      const code = result.error.code;
      const status =
        code === "secret_pattern"
          ? 422
          : code === "oversize"
            ? 413
            : code === "denied_path"
              ? 403
              : 400;
      return json({ error: result.error }, status);
    }
    return json({ envelope: result.envelope }, 200);
  }

  return json({ error: { code: "method_not_allowed", message: `${request.method} ${url.pathname}` } }, 405);
}

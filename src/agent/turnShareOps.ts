/**
 * turn share links: pure ops for the `turn_share` table.
 *
 * A share is a FROZEN SNAPSHOT of one conversation turn, created explicitly
 * by the owner from the web UI and readable BY LINK (crypto-random id, no
 * enumeration). This is a deliberate, narrow opening of the otherwise
 * owner-gated sharing model (shared_file stays owner-gated): the public read
 * exposes exactly the snapshot fields and nothing else. Owner/agent are
 * recorded so a future "manage my shares / revoke" surface has its hook.
 */

export type TurnShareSqlTag = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

export interface TurnShareHost {
  sql: TurnShareSqlTag;
}

const CONTENT_MAX_BYTES = 64_000;
const TITLE_MAX = 200;

export interface TurnShareRow {
  share_id: string;
  owner_user_id: string;
  agent_id: string;
  agent_name: string | null;
  title: string;
  content_md: string;
  created_at: string;
}

function clampUtf8(s: string, maxBytes: number): string {
  const enc = new TextEncoder().encode(s);
  if (enc.length <= maxBytes) return s;
  return new TextDecoder("utf-8").decode(enc.slice(0, maxBytes)).replace(/�+$/, "");
}

export function createTurnShareRow(
  host: TurnShareHost,
  input: {
    ownerUserId: string;
    agentId: string;
    agentName?: string | null;
    title: string;
    contentMd: string;
    nowIso: string;
  },
): { ok: true; share_id: string } | { ok: false; error: string } {
  // an earlier revision (grok review) — validate identity inputs at THIS layer too:
  // a blank owner/agent row would be unreachable by the future revoke/list
  // surface and is always a caller bug.
  if (!String(input.ownerUserId || "").trim()) return { ok: false, error: "missing_owner" };
  if (!String(input.agentId || "").trim()) return { ok: false, error: "missing_agent" };
  const agentName =
    input.agentName == null ? null : String(input.agentName).slice(0, 200).trim() || null;
  const title = String(input.title || "").slice(0, TITLE_MAX).trim() || "Shared turn";
  const content = clampUtf8(String(input.contentMd || ""), CONTENT_MAX_BYTES);
  if (!content.trim()) return { ok: false, error: "empty_content" };
  const shareId = crypto.randomUUID();
  try {
    host.sql`
      INSERT INTO turn_share
        (share_id, owner_user_id, agent_id, agent_name, title, content_md, created_at)
      VALUES
        (${shareId}, ${input.ownerUserId}, ${input.agentId}, ${agentName},
         ${title}, ${content}, ${input.nowIso})
    `;
  } catch {
    // keep the {ok:false} contract instead of throwing through the @callable.
    return { ok: false, error: "insert_failed" };
  }
  return { ok: true, share_id: shareId };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * an earlier revision (grok review) — the PUBLIC projection: snapshot fields ONLY.
 * `owner_user_id`/`agent_id` never leave the ops layer on the by-link path
 * (defense-in-depth: the route already projected them away; now a future
 * caller can't accidentally re-expose them). No owner filter BY DESIGN —
 * possession of the crypto-random link is the credential. Non-UUID ids
 * fail fast without touching the DB.
 */
export interface TurnSharePublic {
  share_id: string;
  agent_name: string | null;
  title: string;
  content_md: string;
  created_at: string;
}

export function readTurnSharePublicRow(host: TurnShareHost, shareId: string): TurnSharePublic | null {
  const id = String(shareId || "").trim();
  if (!UUID_RE.test(id)) return null;
  const rows = host.sql<TurnSharePublic>`
    SELECT share_id, agent_name, title, content_md, created_at
    FROM turn_share WHERE share_id = ${id} LIMIT 1
  `;
  return rows.length > 0 ? rows[0] : null;
}

/** Full row (identity included) — for the future owner-scoped manage/revoke
 * surface ONLY; never wire this into a public path. */
export function readTurnShareRow(host: TurnShareHost, shareId: string): TurnShareRow | null {
  const id = String(shareId || "").trim();
  if (!UUID_RE.test(id)) return null;
  const rows = host.sql<TurnShareRow>`
    SELECT share_id, owner_user_id, agent_id, agent_name, title, content_md, created_at
    FROM turn_share WHERE share_id = ${id} LIMIT 1
  `;
  return rows.length > 0 ? rows[0] : null;
}

/** owner-scoped share management: list newest-first. */
export interface TurnShareListItem {
  share_id: string;
  agent_name: string | null;
  title: string;
  created_at: string;
}

export function listTurnSharesByOwnerRows(host: TurnShareHost, ownerUserId: string): TurnShareListItem[] {
  const owner = String(ownerUserId || "").trim();
  if (!owner) return [];
  return host.sql<TurnShareListItem>`
    SELECT share_id, agent_name, title, created_at
    FROM turn_share WHERE owner_user_id = ${owner}
    ORDER BY created_at DESC LIMIT 200
  `;
}

/** revoke: delete ONLY within the owner's rows (a non-owner
 * delete is a no-op, indistinguishable from not-found — no existence leak). */
export function deleteTurnShareRow(host: TurnShareHost, shareId: string, ownerUserId: string): boolean {
  const id = String(shareId || "").trim();
  const owner = String(ownerUserId || "").trim();
  if (!UUID_RE.test(id) || !owner) return false;
  const before = host.sql<{ n: number }>`
    SELECT COUNT(*) AS n FROM turn_share WHERE share_id = ${id} AND owner_user_id = ${owner}`;
  if (!before.length || Number(before[0].n) === 0) return false;
  host.sql`DELETE FROM turn_share WHERE share_id = ${id} AND owner_user_id = ${owner}`;
  return true;
}

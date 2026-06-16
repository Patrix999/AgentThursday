/**
 *  — pure mapper used by the read-only Skillset UI list view.
 *
 * Takes three independent read-only signals (options, runtime summary,
 * loader detail) and projects them into a single row shape that the UI
 * can render directly. Lives under `src/agent/` so the existing
 * `node:test` runner picks it up — the web tree has no test runner
 * today, and 's `activeAgentResolver` set the precedent.
 *
 * The "selectable for new cloud agents" signal comes from
 * `/api/agent-profiles/options` (). Anything in `options` is
 * offered in the create-agent flow; anything outside `options` is not
 * selectable, even if the loader has it. The runtime summary is what
 * decides loaded / disabled / rejected — operator-disabled state
 * () is reflected here, not just loader status.
 */

export type SkillsetRowStatus =
  | "loaded"
  | "rejected"
  | "disabled"
  | "unknown";

export interface SkillsetRowInputOption {
  id: string;
  name: string;
  description: string;
}

export interface SkillsetRowInputRuntime {
  skillset_ids: {
    loaded: string[];
    disabled: string[];
    rejected: string[];
  };
  disabled: Array<{
    skillset_id: string;
    reason: string | null;
  }>;
}

export interface SkillsetRowInputDetailEntry {
  skillset_id: string;
  skillset_version?: string;
  status: "loaded" | "load_rejected";
  skills: Array<{ tools: string[] }>;
}

export interface SkillsetRow {
  id: string;
  name: string;
  description: string;
  version: string | null;
  status: SkillsetRowStatus;
  /**
   * Operator-supplied reason when `status === "disabled"`. Always
   * null for other states (loader-rejected ids surface their reason
   * via a separate detail-view field).
   */
  disabledReason: string | null;
  /** True when `id` is in the create-agent options closed-list. */
  selectable: boolean;
  /** Skill count from the loader detail entry; 0 when unknown. */
  skillCount: number;
  /** Tool count = sum of `skill.tools.length` for that skillset. */
  toolCount: number;
}

export interface BuildSkillsetRowsArgs {
  options: SkillsetRowInputOption[];
  runtime: SkillsetRowInputRuntime | null;
  detail: { entries: SkillsetRowInputDetailEntry[] } | null;
}

/**
 * Merge the three independent signals into one row per known id. An
 * id is "known" if it appears in any of: options, runtime partitions,
 * or loader detail. Missing fields fall back to safe defaults:
 *
 * - `name` / `description` default to id / "" when only the runtime
 *   or loader knows about it (options is the only canonical name/
 *   description source today).
 * - `status` is decided by runtime first; if the runtime partition is
 *   silent on the id, fall back to loader detail (`loaded` or
 *   `rejected`); else `"unknown"`.
 * - `selectable` reflects presence in `options` only.
 * - `skillCount` / `toolCount` come from loader detail when the entry
 *   is present; 0 otherwise.
 *
 * Rows are sorted by id for stable rendering — the underlying data
 * sources are not guaranteed to agree on ordering.
 */
export function buildSkillsetRows(args: BuildSkillsetRowsArgs): SkillsetRow[] {
  const ids = new Set<string>();
  for (const o of args.options) ids.add(o.id);
  if (args.runtime) {
    for (const id of args.runtime.skillset_ids.loaded) ids.add(id);
    for (const id of args.runtime.skillset_ids.disabled) ids.add(id);
    for (const id of args.runtime.skillset_ids.rejected) ids.add(id);
  }
  if (args.detail) {
    for (const e of args.detail.entries) ids.add(e.skillset_id);
  }

  const optionsById = new Map(args.options.map(o => [o.id, o]));
  const loadedSet = new Set(args.runtime?.skillset_ids.loaded ?? []);
  const disabledSet = new Set(args.runtime?.skillset_ids.disabled ?? []);
  const rejectedSet = new Set(args.runtime?.skillset_ids.rejected ?? []);
  const disabledReasonById = new Map(
    (args.runtime?.disabled ?? []).map(d => [d.skillset_id, d.reason]),
  );
  const detailById = new Map(
    (args.detail?.entries ?? []).map(e => [e.skillset_id, e]),
  );

  const rows: SkillsetRow[] = [];
  for (const id of ids) {
    const opt = optionsById.get(id);
    const detail = detailById.get(id);
    const status = resolveStatus(id, {
      loadedSet,
      disabledSet,
      rejectedSet,
      detail,
    });
    const skillCount = detail?.skills.length ?? 0;
    const toolCount = detail
      ? detail.skills.reduce((sum, s) => sum + s.tools.length, 0)
      : 0;
    rows.push({
      id,
      name: opt?.name ?? id,
      description: opt?.description ?? "",
      version: detail?.skillset_version ?? null,
      status,
      disabledReason: status === "disabled" ? disabledReasonById.get(id) ?? null : null,
      selectable: optionsById.has(id),
      skillCount,
      toolCount,
    });
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));
  return rows;
}

function resolveStatus(
  id: string,
  ctx: {
    loadedSet: Set<string>;
    disabledSet: Set<string>;
    rejectedSet: Set<string>;
    detail: SkillsetRowInputDetailEntry | undefined;
  },
): SkillsetRowStatus {
  if (ctx.disabledSet.has(id)) return "disabled";
  if (ctx.rejectedSet.has(id)) return "rejected";
  if (ctx.loadedSet.has(id)) return "loaded";
  if (ctx.detail) {
    return ctx.detail.status === "loaded" ? "loaded" : "rejected";
  }
  return "unknown";
}

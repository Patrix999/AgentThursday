/**
 * an earlier revision D — canonical `agent-<uuid>` shape recogniser.
 *
 * Lives in its own tiny pure module so both `managerOps.ts` (which
 * pulls `cloudflare:workers` via the agents SDK) and
 * `managerAsyncTaskController.ts` (which deliberately avoids that
 * import for unit-testability) can share the same definition.
 *
 * Used to split missing-target failures into two error codes:
 *   - input looks like an agent_id but isn't registered → `target_not_found`
 *   - input doesn't look like an agent_id at all (caller passed a
 *     display name / skillset name as agent_id) → `agent_not_found`
 */

export function looksLikeAgentId(value: unknown): boolean {
  return typeof value === "string" && /^agent-[a-f0-9-]{8,}$/i.test(value);
}

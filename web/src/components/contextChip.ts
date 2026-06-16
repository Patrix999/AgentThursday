/**
 * shared "active context" label logic for the
 * sticky-header chip on both mobile (`MobileStatusRow`) and desktop
 * (`TopStatusBar`). Extracted so the two surfaces stay semantically
 * identical: same label preference, same shortening rules, same
 * privacy footprint.
 *
 * Behavior:
 *   - prefer `getActiveContextId()` (the `agentthursday.contextId` localStorage
 *     key that drives `X-AgentThursday-Context-Id` routing);
 *   - else fall back to `session.instanceName` (the DO instance name)
 *     with the common `agentthursday-` prefix stripped;
 *   - else "—".
 *
 * Both surfaces accept a `maxLen` for `ctx_<uuid>` ids — mobile keeps
 * the existing tight ~10-char form so the chip fits the
 * `max-w-[8rem]` mobile bound; desktop opts into a longer form
 * (~16 chars) where there's more horizontal space.
 *
 * Privacy: reads only the localStorage active id and the DO instance
 * name. No prompt / SOUL / tool payload involved.
 */
import { getActiveContextId } from "../auth/secret";

export type ContextChipOptions = {
  /**
   * Total visible char budget for `ctx_<uuid>` style ids before
   * appending an ellipsis. The leading `ctx_` (4 chars) counts toward
   * the budget. Mobile default is 10 (= `ctx_` + 6). Desktop usually
   * passes 16 (= `ctx_` + 12) to take advantage of the wider header.
   */
  maxLen?: number;
};

const DEFAULT_MAX_LEN = 10;

export function contextChipLabel(
  instanceName: string | undefined,
  opts: ContextChipOptions = {},
): string {
  const active = getActiveContextId();
  if (active) return shortContextId(active, opts);
  if (instanceName) return shortInstanceName(instanceName);
  return "—";
}

export function shortContextId(id: string, opts: ContextChipOptions = {}): string {
  const max = opts.maxLen ?? DEFAULT_MAX_LEN;
  if (id.startsWith("ctx_") && id.length > max) {
    return `${id.slice(0, max)}…`;
  }
  // Anything else: trim to (max + 2) chars + ellipsis if longer so the
  // non-`ctx_` case still fits under desktop's wider budget without
  // hugging the same hard cap.
  const fallbackMax = max + 2;
  return id.length > fallbackMax ? `${id.slice(0, fallbackMax)}…` : id;
}

export function shortInstanceName(instanceName: string): string {
  // Drop the common `agentthursday-` prefix to save header real estate; the
  // raw form leaks back if the prefix isn't present.
  return instanceName.startsWith("agentthursday-")
    ? instanceName.slice("agentthursday-".length)
    : instanceName;
}

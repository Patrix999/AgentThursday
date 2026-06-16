//  —  persona-weave composition helper.
//
// Pure helper that turns an `AgentProfile.persona` string (already
// persisted by ) into the system-prompt block consumed by the
// per-profile `AgentThursdayAgent` DO's `configureSession` chain. The block
// is added as a separate `.withContext("persona", { provider })` slot
// after the existing `"soul"` block — see  §1 / D-1.
//
// Caller integrates by reading the profile from the registry DO
// (`getAgentByName(env.AgentThursdayAgent, DEMO_INSTANCE).readAgentProfile(this.name)`)
// and passing the result here. This helper is pure: no env, no RPC,
// no logging — the caller wraps it with logEvent for the
// `system_prompt.persona.composed` breadcrumb (D-3).

import type { AgentProfile } from "../schema";

export const PERSONA_BYTE_CAP = 2000;

export const PERSONA_BLOCK_HEADER = "## Persona";

const TRUNCATION_SUFFIX = `\n[... persona truncated to ${PERSONA_BYTE_CAP} bytes]`;

export type PersonaSkipReason = "missing" | "empty";

export type PersonaWeaveResult = {
  text: string;
  personaBytes: number;
  skipReason: PersonaSkipReason | null;
  truncated: boolean;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function utf8ByteLength(s: string): number {
  return encoder.encode(s).length;
}

// Cut a string at `cap` UTF-8 bytes, walking back to a clean UTF-8
// boundary so we never emit a half-encoded code point. The boundary
// check looks for continuation bytes (`0b10xxxxxx`) and steps back
// until the next byte would be a leading byte.
function truncateAtByteCap(s: string, cap: number): string {
  const bytes = encoder.encode(s);
  if (bytes.length <= cap) return s;
  let end = cap;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return decoder.decode(bytes.slice(0, end));
}

export function composePersonaBlock(
  profile: Pick<AgentProfile, "persona"> | null | undefined,
): PersonaWeaveResult {
  if (!profile) {
    return { text: "", personaBytes: 0, skipReason: "missing", truncated: false };
  }
  const raw = (profile.persona ?? "").trim();
  if (raw.length === 0) {
    return { text: "", personaBytes: 0, skipReason: "empty", truncated: false };
  }
  const rawBytes = utf8ByteLength(raw);
  if (rawBytes <= PERSONA_BYTE_CAP) {
    return {
      text: `${PERSONA_BLOCK_HEADER}\n\n${raw}`,
      personaBytes: rawBytes,
      skipReason: null,
      truncated: false,
    };
  }
  const clamped = truncateAtByteCap(raw, PERSONA_BYTE_CAP);
  return {
    text: `${PERSONA_BLOCK_HEADER}\n\n${clamped}${TRUNCATION_SUFFIX}`,
    personaBytes: utf8ByteLength(clamped),
    skipReason: null,
    truncated: true,
  };
}

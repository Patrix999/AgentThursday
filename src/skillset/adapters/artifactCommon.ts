/**
 * narrow agent context surface for artifact adapters.
 *
 * The dynamic-tool dispatch path passes `agentCtx` as the third arg to
 * `DispatchHandler.execute`. We type it as the smallest interface the
 * adapters need — three @callable methods on `AgentThursdayAgent` — so the
 * adapter file has no `as AgentThursdayAgent` cast across the encapsulation
 * boundary and reviewers can see at a glance which DO methods are
 * reachable from the dynamic tool surface.
 */

import type { ArtifactEnvelope } from "../../artifactShare";

export interface AgentArtifactCtx {
  writeArtifact(input: {
    cardId: string;
    filename: string;
    type: string;
    sourceAgent: string;
    producerUserId?: string;
    mime?: string;
    notes?: string;
    content: string;
  }): Promise<
    | { ok: true; envelope: ArtifactEnvelope }
    | {
        ok: false;
        error: {
          code: string;
          message: string;
          pattern?: string;
          cap?: number;
          size?: number;
        };
      }
  >;

  readArtifact(input: {
    cardId: string;
    filename: string;
  }): Promise<
    | { ok: true; envelope: ArtifactEnvelope; content: string }
    | { ok: false; error: { code: string; message: string } }
  >;

  listArtifacts(input: {
    cardId: string;
  }): Promise<
    | { ok: true; card_id: string; envelopes: ArtifactEnvelope[] }
    | { ok: false; error: { code: string; message: string } }
  >;
}

export function requireArtifactCtx(ctx: unknown): AgentArtifactCtx {
  if (
    !ctx ||
    typeof ctx !== "object" ||
    typeof (ctx as { writeArtifact?: unknown }).writeArtifact !== "function" ||
    typeof (ctx as { readArtifact?: unknown }).readArtifact !== "function" ||
    typeof (ctx as { listArtifacts?: unknown }).listArtifacts !== "function"
  ) {
    throw new Error(
      "artifact adapter requires agentCtx with writeArtifact/readArtifact/listArtifacts methods",
    );
  }
  return ctx as AgentArtifactCtx;
}

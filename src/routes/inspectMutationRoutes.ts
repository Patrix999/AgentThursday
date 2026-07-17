import { json } from "../httpUtil";

/**
 * R4 inspect mutation POST routes extracted from `server.ts`.
 *
 * Single entry point: `handleInspectMutations(request, url, deps)`.
 *
 * Scope (five POST routes only):
 *
 *   POST /api/inspect/approvals/request
 *   POST /api/inspect/approvals/decide
 *   POST /api/inspect/approvals/replay-consume
 *   POST /api/inspect/patch-artifacts/propose
 *   POST /api/inspect/patch-artifacts/apply-dry-run
 *
 * Returns `null` when no R4 branch matches so `server.ts` can fall
 * through to subsequent handlers (R5 `DEMO_INSTANCE` codemode-probe,
 * R6 workspace, etc.).
 *
 * Stub resolution stays at the composition root in `server.ts` and is
 * passed in via `InspectMutationDeps.getChannelHubStub` so this module
 * never imports `CHANNEL_HUB_INSTANCE` or `ChannelHubAgent`. Per Card
 * 263a the deps type is a minimal structural interface — the five
 * callable methods only — to avoid pulling the agent class's type
 * graph back into the route-module import tree.
 *
 * Auth: gated by the `/api/*` umbrella in `server.ts`. This handler
 * never re-checks. Behavior at the route boundary is byte-equivalent
 * to the pre-extraction inline branches at
 * `server.ts:9728-9748, 9770-9787, 9808-9827, 9851-9872, 9895-9917`.
 *
 * Status mapping (preserved exactly):
 *   - createApprovalRequest:   !ok → 400
 *   - decideApproval:          error="approval_not_found" → 404, else 400
 *   - consumeApprovalToken:    error="approval_not_found" → 404, else 400
 *   - proposePatchArtifact:    !ok → 400
 *   - applyPatchDryRun:        error in {approval_not_found, artifact_not_found} → 404, else 400
 */

// The five callables all return a discriminated `{ ok }` union. The
// route module only inspects `ok` and (on the !ok branch) `error`;
// everything else is forwarded verbatim to `json()` so the wire shape
// stays byte-equivalent to the inline R4 branches.
type InspectMutationResult = { ok: true } | { ok: false; error: string };

export interface ChannelHubInspectMutationStub {
  createApprovalRequest(args: Record<string, unknown>): Promise<InspectMutationResult>;
  decideApproval(args: Record<string, unknown>): Promise<InspectMutationResult>;
  consumeApprovalToken(args: Record<string, unknown>): Promise<InspectMutationResult>;
  proposePatchArtifact(args: Record<string, unknown>): Promise<InspectMutationResult>;
  applyPatchDryRun(args: Record<string, unknown>): Promise<InspectMutationResult>;
}

export interface InspectMutationDeps {
  getChannelHubStub: () => Promise<ChannelHubInspectMutationStub>;
}

export async function handleInspectMutations(
  request: Request,
  url: URL,
  deps: InspectMutationDeps,
): Promise<Response | null> {
  if (request.method !== "POST") return null;

  // an earlier revision §D — approval request skeleton. Reviewer-grant only;
  // ChannelHub callable re-validates input as defence-in-depth.
  if (url.pathname === "/api/inspect/approvals/request") {
    const stub = await deps.getChannelHubStub();
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const result = await stub.createApprovalRequest({
      agent_id: body.agent_id,
      tool_id: body.tool_id,
      tier: body.tier,
      input: body.input,
      input_hash: body.input_hash,
      summary: body.summary,
      agent_reason: body.agent_reason,
      ttl_seconds: body.ttl_seconds,
    });
    if (!result.ok) return json(result, 400);
    return json(result);
  }

  // reviewer grant/deny mutation. `approval_not_found` → 404.
  if (url.pathname === "/api/inspect/approvals/decide") {
    const stub = await deps.getChannelHubStub();
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const result = await stub.decideApproval({
      token_id: body.token_id,
      decision: body.decision,
      reviewer_id: body.reviewer_id,
      reviewer_signature: body.reviewer_signature,
    });
    if (!result.ok) {
      const status = result.error === "approval_not_found" ? 404 : 400;
      return json(result, status);
    }
    return json(result);
  }

  // replay-consumption skeleton. `approval_not_found` → 404.
  // Raw `token` field is forwarded to the DO callable and never logged.
  if (url.pathname === "/api/inspect/approvals/replay-consume") {
    const stub = await deps.getChannelHubStub();
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const result = await stub.consumeApprovalToken({
      token_id: body.token_id,
      token: body.token,
      agent_id: body.agent_id,
      tool_id: body.tool_id,
      input: body.input,
      input_hash: body.input_hash,
    });
    if (!result.ok) {
      const status = result.error === "approval_not_found" ? 404 : 400;
      return json(result, status);
    }
    return json(result);
  }

  // propose-patch-artifact create. Policy fail → !ok with
  // `policy_failed` and no row insertion (fail-closed). 400 on any !ok.
  if (url.pathname === "/api/inspect/patch-artifacts/propose") {
    const stub = await deps.getChannelHubStub();
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const result = await stub.proposePatchArtifact({
      tool_id: body.tool_id,
      target_paths: body.target_paths,
      patch_text: body.patch_text,
      summary: body.summary,
      agent_id: body.agent_id,
      task_id: body.task_id,
      envelope_id: body.envelope_id,
      conversation_id: body.conversation_id,
      base_sha: body.base_sha,
    });
    if (!result.ok) return json(result, 400);
    return json(result);
  }

  // apply-dry-run (verify_only). `approval_not_found` /
  // `artifact_not_found` → 404; else 400. Raw `token` forwarded to DO,
  // never echoed in the response.
  if (url.pathname === "/api/inspect/patch-artifacts/apply-dry-run") {
    const stub = await deps.getChannelHubStub();
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const result = await stub.applyPatchDryRun({
      artifact_id: body.artifact_id,
      token_id: body.token_id,
      token: body.token,
      agent_id: body.agent_id,
      tool_id: body.tool_id,
      input_hash: body.input_hash,
    });
    if (!result.ok) {
      const status =
        result.error === "approval_not_found"
          || result.error === "artifact_not_found"
          ? 404 : 400;
      return json(result, status);
    }
    return json(result);
  }

  return null;
}

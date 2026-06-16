import { getSandbox } from "@cloudflare/sandbox";
import { json } from "../httpUtil";

/**
 *  — `POST /api/sandbox/exec` admin-smoke route extracted
 * from `src/server.ts`.
 *
 * Body lifted verbatim from the original inline branch (was ):
 * admin smoke endpoint so verifier / operators can call
 * `getSandbox().exec()` directly without going through the model
 * loop, the agent's tool-routing, or the AgentThursdayAgent DO. Mirrors the
 * `sandbox_exec` tool's timeout contract so a smoke result is
 * shape-compatible with the model-side return.
 *
 * Auth: still gated by the composition-root `/api/*` umbrella
 * `requireSecret` check in `src/server.ts` above the delegate. This
 * module never re-checks.
 *
 * Return shape: `Promise<Response | null>` — `null` means
 * path/method-mismatch so `server.ts` falls through to the next
 * route family. We intentionally do NOT return 405 on method
 * mismatch (original inline branch was a `pathname === X && method ===
 * Y` gate that fell through otherwise).
 *
 * Tier 4 logging: command bytes must NOT be echoed into worker logs
 * (only command_preview, handled upstream by the sandbox tool path).
 * This route's body never logs the raw command.
 */
export async function handleSandboxExecRoutes(
  request: Request,
  url: URL,
  env: Env,
): Promise<Response | null> {
  if (url.pathname !== "/api/sandbox/exec" || request.method !== "POST") {
    return null;
  }

  let body: { command?: unknown; sandbox_id?: unknown; timeout_seconds?: unknown };
  try {
    body = (await request.json()) as { command?: unknown; sandbox_id?: unknown; timeout_seconds?: unknown };
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const command = typeof body.command === "string" ? body.command : "";
  if (command.length === 0) return json({ error: "command (string) required" }, 400);
  const sandboxId = typeof body.sandbox_id === "string" && body.sandbox_id.length > 0
    ? body.sandbox_id
    : "agentthursday";
  const requested = typeof body.timeout_seconds === "number"
    ? body.timeout_seconds
    : 120;
  const timeoutSeconds = Math.min(300, Math.max(5, Math.floor(requested)));
  const sandbox = getSandbox(env.Sandbox, sandboxId);
  const TIMEOUT_SENTINEL = Symbol.for("sandbox_exec_timeout");
  const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
    setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutSeconds * 1000);
  });
  let raced: unknown;
  try {
    raced = await Promise.race([sandbox.exec(command), timeoutPromise]);
  } catch (e) {
    return json({
      stdout: "",
      stderr: `sandbox_exec error: ${e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)}`,
      exit_code: 1,
      success: false,
      timed_out: false,
      sandbox_id: sandboxId,
      timeout_seconds: timeoutSeconds,
    });
  }
  if (raced === TIMEOUT_SENTINEL) {
    return json({
      stdout: "",
      stderr: `sandbox_exec timed out after ${timeoutSeconds}s`,
      exit_code: 124,
      success: false,
      timed_out: true,
      sandbox_id: sandboxId,
      timeout_seconds: timeoutSeconds,
    });
  }
  const r = raced as { stdout: string; stderr: string; exitCode: number; success: boolean };
  return json({
    stdout: r.stdout,
    stderr: r.stderr,
    exit_code: r.exitCode,
    success: r.success,
    timed_out: false,
    sandbox_id: sandboxId,
    timeout_seconds: timeoutSeconds,
  });
}

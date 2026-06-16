import { json } from "../httpUtil";
import { DEMO_INSTANCE } from "../demoConstants";

/**
 *  — `/health` route extracted from `server.ts`.
 *
 * Behavior preserved verbatim: same shape, same fields, same default
 * 200 status. Intentionally exempt from auth in the composition root;
 * this module only renders the response.
 */
export function handleHealth(): Response {
  return json({
    ok: true,
    service: "agent-thursday",
    version: "0.1.0",
    agent: "AgentThursdayAgent",
    instance: DEMO_INSTANCE,
    timestamp: Date.now(),
  });
}

/**
 *  §E-15 — dev-time DOM leak scanner.
 *
 * Scans `document.body.innerText` on the user-layer routes (`/`) for inspect
 * blacklist strings. If any match, console.warn with the offending substring
 * and the URL. Runs only when `import.meta.env.DEV` so production bundle is
 * unaffected.
 *
 * The intent is preventive: a + author who accidentally renders
 * `event_payload` to a card surface gets a noisy console warning during dev.
 */

//  inspect-layer terms +  channel-inspect terms. The user-layer
// `/` route should never render these; if a future panel accidentally drops
// `providerMessageId` or `payloadHash` into a card text node, this guard will
// noisily warn during dev.
const BLACKLIST = [
  "event_payload",
  "tool_call_id",
  "recentToolEvents",
  "debugTrace",
  // Channel inspect-only field names ()
  "providerMessageId",
  "provider_message_id",
  "payloadHash",
  "payload_hash",
  "payload_json",
  "addressedSignals",
  "addressed_signals_json",
  "raw_ref",
  "X-AgentThursday-Bridge-Secret",
];

let started = false;

export function startLeakGuard(): void {
  if (started) return;
  if (!import.meta.env.DEV) return;
  started = true;

  function scan() {
    if (location.pathname !== "/") return; // user-layer only
    const text = document.body?.innerText ?? "";
    const hits = BLACKLIST.filter((needle) => text.includes(needle));
    if (hits.length > 0) {
      console.warn(
        "[agent-thursday-leak-guard] inspect-layer fields leaked into default user-layer DOM:",
        hits,
        "at",
        location.href,
      );
    }
  }

  // Initial scan after first paint, then every 5s so polling-driven re-renders
  // get checked too. Cheap on a small DOM tree.
  setTimeout(scan, 1000);
  setInterval(scan, 5000);
}

/**
 *  — message timestamp formatting for the dialog streams.
 * Same-day shows HH:MM; a different calendar day prefixes MM-DD.
 * `now` is injectable for deterministic tests.
 */
export function formatMessageTime(at: number, now: number = Date.now()): string {
  const d = new Date(at);
  const n = new Date(now);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const time = `${hh}:${mm}`;
  const sameDay =
    d.getFullYear() === n.getFullYear()
    && d.getMonth() === n.getMonth()
    && d.getDate() === n.getDate();
  if (sameDay) return time;
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${mo}-${day} ${time}`;
}

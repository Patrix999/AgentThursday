// 2026-06-23 — owner (tenant) labels for the operator console. The console is
// admin and sees every tenant's agents; these show whose agent each row is.
const ADMIN_OWNER = "user-admin";

export function ownerLabel(ownerUserId?: string | null, ownerEmail?: string | null): string {
  if (ownerEmail) return ownerEmail;
  if (!ownerUserId) return "unknown";
  if (ownerUserId === ADMIN_OWNER) return "operator";
  const id = ownerUserId.replace(/^user-/, "");
  return id.length > 8 ? id.slice(0, 8) + "…" : id;
}

export function OwnerBadge({
  ownerUserId,
  ownerEmail,
  className = "",
}: {
  ownerUserId?: string | null;
  ownerEmail?: string | null;
  className?: string;
}) {
  const isOperator = ownerUserId === ADMIN_OWNER;
  return (
    <span
      className={
        "inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded " +
        (isOperator ? "bg-slate-800 text-slate-400" : "bg-indigo-900/50 text-indigo-300") +
        (className ? " " + className : "")
      }
      title={ownerUserId ? `owner: ${ownerUserId}` : "owner unknown"}
    >
      <span aria-hidden>◇</span>
      {ownerLabel(ownerUserId, ownerEmail)}
    </span>
  );
}

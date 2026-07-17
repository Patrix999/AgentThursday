import type { ReactNode } from "react";
import { PageHeader } from "../nav/PageHeader";

/**
 * shared layout shell for the `/agents/*` surface.
 * Header is the unified `PageHeader` (2026-06-15) so the nav bar
 * matches every other route; body is a single readable column.
 */
export function AgentsLayout(props: {
  label: string;
  backTo?: string;
  backLabel?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col h-full bg-slate-950 text-slate-100">
      <PageHeader
        title="Agents"
        subtitle={props.label}
        backTo={props.backTo ?? "/"}
        backLabel={props.backLabel ?? "← Dashboard"}
        actions={props.actions}
      />
      <main className="flex-1 min-h-0 overflow-y-auto px-4 py-4 sm:px-6 sm:py-6">
        <div className="mx-auto w-full max-w-2xl">{props.children}</div>
      </main>
    </div>
  );
}

import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { PrimaryNav } from "./PrimaryNav";

/**
 * Unified page header (2026-06-15, operator) — every route's top nav bar
 * shares one full-width layout, font, and button order:
 *
 *   [← back] TITLE / subtitle        …flex spacer…       [actions] [☰ menu]
 *
 * The collapsible menu button (PrimaryNav) is always rightmost; any
 * page-specific action buttons sit to its left, in order. This is the
 * single source of truth for the header so per-page styling can't drift.
 */
export function PageHeader(props: {
  title: string;
  subtitle?: string;
  backTo?: string;
  backLabel?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-10 flex items-center gap-3 px-4 py-3 bg-slate-900 border-b border-slate-800">
      {props.backTo && (
        <Link
          to={props.backTo}
          className="text-sm text-slate-400 hover:text-slate-100"
          aria-label={props.backLabel ?? "Back"}
        >
          {props.backLabel ?? "← Back"}
        </Link>
      )}
      <span className="text-xs uppercase tracking-wide text-slate-500">{props.title}</span>
      {props.subtitle && <span className="text-xs text-slate-600">/ {props.subtitle}</span>}
      <div className="flex-1" />
      {props.actions}
      <PrimaryNav variant="desktop-bar" />
    </header>
  );
}

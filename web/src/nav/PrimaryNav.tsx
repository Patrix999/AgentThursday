import { useState } from "react";
import { useLocation, Link } from "react-router-dom";
import { NAV_ITEMS } from "./NAV_ITEMS";

type Variant = "desktop-header" | "desktop-bar" | "mobile";

type Props = {
  variant: Variant;
  className?: string;
};

/**
 * unified primary navigation component.
 *
 * 2026-06-15 (the operator) — collapsed by default to save header space. A
 * single toggle button shows the current surface; opening it reveals
 * a dropdown of all nav entries. Picking one (or clicking away)
 * closes it. The same collapsed behaviour is used for every variant;
 * `variant` only tunes the trigger button's sizing.
 */
export function PrimaryNav({ variant, className = "" }: Props) {
  const location = useLocation();
  const pathname = location.pathname;
  const [open, setOpen] = useState(false);

  const active = NAV_ITEMS.find((item) => item.match(pathname));
  const compact = variant !== "desktop-header";

  const triggerClass = compact
    ? "inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-slate-700 text-slate-200 hover:bg-slate-800"
    : "inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded border border-slate-700 text-slate-200 hover:bg-slate-900";

  return (
    <nav aria-label="primary" className={`relative shrink-0 ${className}`}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={triggerClass}
      >
        <span aria-hidden>☰</span>
        <span>{active ? active.label : "Menu"}</span>
      </button>

      {open && (
        <>
          {/* click-away backdrop */}
          <button
            type="button"
            aria-label="Close menu"
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default"
          />
          <div
            role="menu"
            className="absolute right-0 mt-1 z-50 min-w-[10rem] rounded border border-slate-700 bg-slate-900 py-1 shadow-lg"
          >
            {NAV_ITEMS.map((item) => {
              const isActive = item.match(pathname);
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  role="menuitem"
                  onClick={() => setOpen(false)}
                  className={
                    isActive
                      ? "block px-3 py-1.5 text-sm text-sky-200 bg-sky-900/30"
                      : "block px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800"
                  }
                >
                  {item.label}
                </Link>
              );
            })}
          </div>
        </>
      )}
    </nav>
  );
}

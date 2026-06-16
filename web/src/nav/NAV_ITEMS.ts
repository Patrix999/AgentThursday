/**
 *  — unified primary navigation configuration.
 *
 * 2026-06-15 (operator) — Wave 3 (Cards 422/423) deep-merge reverted: the
 * console nav is restored to its pre-renovation surfaces so the
 * Dashboard / Workspace / Runs entries are reachable again. The
 * /activity route still exists by URL but is no longer a nav entry.
 * The menu is rendered collapsed-by-default by PrimaryNav to save space.
 */
export interface NavItem {
  label: string;
  shortLabel: string;
  path: string;
  match: (pathname: string) => boolean;
}

export const NAV_ITEMS: NavItem[] = [
  {
    label: "Dashboard",
    shortLabel: "Dash",
    path: "/",
    match: (p) => p === "/" || p.startsWith("/dashboard"),
  },
  {
    label: "Workspace",
    shortLabel: "Work",
    path: "/workspace",
    match: (p) => p.startsWith("/workspace"),
  },
  {
    label: "Agents",
    shortLabel: "Agents",
    path: "/agents",
    match: (p) => p.startsWith("/agents"),
  },
  {
    label: "Skillsets",
    shortLabel: "Skills",
    path: "/skillsets",
    match: (p) => p.startsWith("/skillsets"),
  },
  {
    label: "Models",
    shortLabel: "Models",
    path: "/models",
    match: (p) => p.startsWith("/models"),
  },
  //  (UX W1) — configuration home: provider keys + Discord bots.
  {
    label: "Settings",
    shortLabel: "Set",
    path: "/settings",
    match: (p) => p.startsWith("/settings"),
  },
  //  — workflow runs were unreachable except by typed URL.
  {
    label: "Runs",
    shortLabel: "Runs",
    path: "/workflow-runs",
    match: (p) => p.startsWith("/workflow-runs") || p.startsWith("/agent-runs"),
  },
  //  — operator manual (multi-agent produced, see provenance).
  {
    label: "Manual",
    shortLabel: "Manual",
    path: "/manual",
    match: (p) => p.startsWith("/manual"),
  },
];

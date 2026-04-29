import { useEffect, type ReactNode } from "react";

type Props = {
  top: ReactNode;       // sticky TopStatusBar
  scroll: ReactNode;    // scrollable cards + summary
  inspect?: ReactNode;  // optional secondary link (InspectEntry)
  bottom: ReactNode;    // MobileComposer — the thumb-reach action surface
};

/**
 * M7.1 Card 80 — mobile thumb-reach shell.
 *
 * Layout (top → bottom):
 *   - top:    sticky header
 *   - scroll: flex-1 scrollable area
 *   - inspect:optional link to /inspect (above the action bar)
 *   - bottom: fixed-position action bar with safe-area + keyboard insets
 *
 * Why fixed position instead of flex column: when the on-screen keyboard
 * opens iOS Safari sometimes resizes the layout viewport unevenly. Anchoring
 * the action bar to the bottom of the visual viewport (via `100dvh` on the
 * page + a `--keyboard-inset` CSS variable from `visualViewport.height`)
 * keeps Send / Approve / Reject reachable even when the keyboard is up.
 */
export function ThumbReachLayout({ top, scroll, inspect, bottom }: Props) {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    function update() {
      const inset = Math.max(0, window.innerHeight - vv!.height);
      document.documentElement.style.setProperty("--keyboard-inset", `${inset}px`);
    }
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      document.documentElement.style.setProperty("--keyboard-inset", "0px");
    };
  }, []);

  return (
    <div className="flex flex-col h-full lg:hidden">
      {top}
      <div className="flex-1 overflow-y-auto pb-2">{scroll}</div>
      {inspect}
      <div
        className="bg-slate-900 border-t border-slate-800"
        style={{
          paddingBottom: "calc(env(safe-area-inset-bottom) + var(--keyboard-inset, 0px))",
        }}
      >
        {bottom}
      </div>
    </div>
  );
}

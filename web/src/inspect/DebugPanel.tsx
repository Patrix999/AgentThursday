import { useState } from "react";
import type { InspectSnapshot } from "../../shared/schema";

export function DebugPanel({ debugRaw }: { debugRaw: InspectSnapshot["debugRaw"] }) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="text-slate-400 hover:text-slate-100 underline-offset-2 hover:underline"
      >
        {collapsed ? "▸ Show debugRaw" : "▾ Hide debugRaw"}
      </button>
      {!collapsed && (
        <pre className="mt-2 p-3 bg-slate-950/80 rounded text-slate-300 whitespace-pre-wrap break-words overflow-x-auto max-h-[60vh] overflow-y-auto">
          {safeStringify(debugRaw)}
        </pre>
      )}
    </div>
  );
}

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

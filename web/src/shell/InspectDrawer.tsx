import { useInspect } from "../hooks/useInspect";
import { InspectContent } from "../inspect/InspectContent";

/**
 * Desktop right drawer. Lazy: useInspect only polls when `open` is true,
 * satisfying  acceptance "drawer 关闭后 useInspect 停止 polling".
 */
export function InspectDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, loading, error } = useInspect(open);

  return (
    <aside
      className={`hidden lg:flex flex-col border-l border-slate-800 bg-slate-900 transition-all ${
        open ? "w-[480px]" : "w-0 overflow-hidden"
      }`}
      aria-hidden={!open}
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
        <span className="text-xs uppercase tracking-wide text-slate-400">Inspect</span>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm">
          Close
        </button>
      </div>
      <div className="flex-1 min-h-0">
        {open && <InspectContent data={data} loading={loading} error={error} />}
      </div>
    </aside>
  );
}

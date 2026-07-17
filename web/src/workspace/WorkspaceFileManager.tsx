import { useEffect, useState } from "react";
import { useWorkspaceFiles, useWorkspaceFileContent } from "../hooks/useWorkspaceFiles";
import type { WorkspaceFileEntry } from "../../shared/schema";

/**
 * Read-only workspace file panel.
 *
 * an earlier revision redesign: switched from a two-column grid (list left, inline
 * preview right) to a single-column FTP / file-explorer style listing
 * with a slide-over drawer for file content.
 *
 *   - Directories and files share one column. Backend returns
 *     directories first then files; the panel preserves that order.
 *   - Non-root listings get a synthetic `..` row that pops up one level.
 *   - Click a directory row → navigate into it (list re-fetches).
 *   - Click a file row → open the right-side drawer with content.
 *   - The drawer overlays the list area; closing it returns to the
 *     full-width listing without losing list scroll position.
 *
 * Behavior preserved from earlier cards:
 *   - an earlier revision: panel default open inside Inspect tab.
 *   - an earlier revision: `agentthursday:workspace:focus-path` custom event still opens
 *     the panel, navigates to the parent dir, and opens the drawer
 *     on the targeted file.
 */
export function WorkspaceFileManager() {
  const [open, setOpen] = useState(true);
  const [path, setPath] = useState("");
  const [previewPath, setPreviewPath] = useState<string | null>(null);

  useEffect(() => {
    function onFocusPath(e: Event) {
      const ce = e as CustomEvent<{ path?: string }>;
      const target = ce.detail?.path;
      if (typeof target !== "string" || target.length === 0) return;
      setOpen(true);
      setPreviewPath(target);
      const lastSlash = target.lastIndexOf("/");
      const parentDir = lastSlash > 0 ? target.slice(0, lastSlash) : "";
      setPath(parentDir);
    }
    window.addEventListener("agentthursday:workspace:focus-path", onFocusPath);
    return () =>
      window.removeEventListener("agentthursday:workspace:focus-path", onFocusPath);
  }, []);

  const list = useWorkspaceFiles(open ? path : "");
  const content = useWorkspaceFileContent(open ? previewPath : null);

  const currentPath = list.data?.path ?? path;
  const parentPath = currentPath === ""
    ? null
    : currentPath.includes("/")
      ? currentPath.slice(0, currentPath.lastIndexOf("/"))
      : "";

  return (
    <section className="rounded border border-slate-800 bg-slate-900/60 m-4">
      <header className="flex items-center justify-between px-4 py-2 border-b border-slate-800">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-xs uppercase tracking-wide text-slate-300 hover:text-slate-100"
        >
          {open ? "▾" : "▸"} Workspace files
        </button>
        {open && (
          <Breadcrumb
            path={currentPath}
            onSelect={(p) => { setPath(p); setPreviewPath(null); }}
          />
        )}
      </header>
      {open && (
        <div className="relative">
          <FileList
            list={list}
            parentPath={parentPath}
            onEnterDir={(p) => { setPath(p); setPreviewPath(null); }}
            onOpenFile={(p) => setPreviewPath(p)}
            previewPath={previewPath}
          />
          {previewPath !== null && (
            <FileDrawer
              content={content.data}
              loading={content.loading}
              error={content.error}
              path={previewPath}
              onClose={() => setPreviewPath(null)}
            />
          )}
        </div>
      )}
    </section>
  );
}

function Breadcrumb({ path, onSelect }: { path: string; onSelect: (p: string) => void }) {
  const segs = path.split("/").filter(Boolean);
  return (
    <nav className="text-xs flex gap-1 items-center min-w-0 overflow-hidden">
      <button
        onClick={() => onSelect("")}
        className={path === "" ? "text-slate-300" : "text-sky-400 hover:underline"}
      >
        /
      </button>
      {segs.map((seg, i) => {
        const target = segs.slice(0, i + 1).join("/");
        const isLast = i === segs.length - 1;
        return (
          <span key={target} className="flex items-center gap-1 min-w-0">
            <span className="text-slate-600">/</span>
            <button
              onClick={() => onSelect(target)}
              className={`truncate ${isLast ? "text-slate-300" : "text-sky-400 hover:underline"}`}
            >
              {seg}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

function FileList({
  list,
  parentPath,
  onEnterDir,
  onOpenFile,
  previewPath,
}: {
  list: ReturnType<typeof useWorkspaceFiles>;
  parentPath: string | null;
  onEnterDir: (p: string) => void;
  onOpenFile: (p: string) => void;
  previewPath: string | null;
}) {
  if (list.loading) return <div className="text-sm text-slate-500 p-3">Loading…</div>;
  if (list.error) return <div className="text-sm text-rose-400 p-3">{list.error}</div>;
  if (!list.data) return null;
  const hasParent = parentPath !== null;
  const isEmpty = list.data.entries.length === 0;
  return (
    <ul className="text-sm divide-y divide-slate-800/60 max-h-[70vh] overflow-y-auto">
      {hasParent && (
        <li>
          <button
            type="button"
            onClick={() => onEnterDir(parentPath!)}
            className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-slate-800/40"
          >
            <span className="shrink-0 w-4 text-center text-slate-500">↩︎</span>
            <span className="flex-1 truncate text-slate-300 font-mono">..</span>
            <span className="text-xs text-slate-500">up</span>
          </button>
        </li>
      )}
      {isEmpty && (
        <li className="text-sm text-slate-500 px-3 py-2">Empty directory.</li>
      )}
      {list.data.entries.map((entry) => (
        <FileRow
          key={entry.path}
          entry={entry}
          selected={entry.path === previewPath}
          onEnterDir={onEnterDir}
          onOpenFile={onOpenFile}
        />
      ))}
    </ul>
  );
}

function FileRow({
  entry,
  selected,
  onEnterDir,
  onOpenFile,
}: {
  entry: WorkspaceFileEntry;
  selected: boolean;
  onEnterDir: (p: string) => void;
  onOpenFile: (p: string) => void;
}) {
  const isDir = entry.kind === "directory";
  return (
    <li>
      <button
        type="button"
        onClick={() => (isDir ? onEnterDir(entry.path) : onOpenFile(entry.path))}
        className={`w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-slate-800/40 ${
          selected ? "bg-slate-800/60" : ""
        }`}
      >
        <span className="shrink-0 w-4 text-center text-slate-500">{isDir ? "📁" : "📄"}</span>
        <span className={`flex-1 truncate ${isDir ? "text-sky-300" : "text-slate-200"}`}>
          {entry.name}
          {isDir && <span className="text-slate-500">/</span>}
        </span>
        {!isDir && entry.size !== null && (
          <span className="text-xs text-slate-500 font-mono shrink-0">{formatBytes(entry.size)}</span>
        )}
      </button>
    </li>
  );
}

/**
 * viewport-level screen-edge file drawer with animation
 * and dismiss affordances.
 *
 * Changed from absolute inside the panel to fixed at the viewport
 * right edge so the preview area is significantly larger.
 * an earlier revision: responsive widths (94vw mobile → 64vw ultra-wide, capped at
 * max-w-6xl). an earlier revision: click-outside dismiss, Escape key dismiss,
 * and slide-in / backdrop-fade transition. Read-only.
 */
function FileDrawer({
  content,
  loading,
  error,
  path,
  onClose,
}: {
  content: ReturnType<typeof useWorkspaceFileContent>["data"];
  loading: boolean;
  error: string | null;
  path: string;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/35 transition-opacity duration-200"
      role="presentation"
      onClick={onClose}
    >
      <aside
        className="absolute inset-y-0 right-0 w-[94vw] sm:w-[88vw] lg:w-[78vw] xl:w-[72vw] 2xl:w-[64vw] max-w-6xl bg-slate-950/95 border-l border-slate-800 shadow-2xl flex flex-col min-h-0 transition-transform duration-200 ease-out translate-x-0"
        role="dialog"
        aria-modal="true"
        aria-label={`File preview: ${path}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-2 px-3 py-2 border-b border-slate-800 shrink-0">
          <div className="min-w-0 flex-1">
            <div className="text-xs text-slate-400 truncate font-mono" title={path}>{path}</div>
            {content && (
              <div className="text-[10px] text-slate-500 mt-0.5 flex items-center gap-2 font-mono">
                <span>{formatBytes(content.size ?? 0)}</span>
                {content.truncated && (
                  <span className="text-amber-300">truncated</span>
                )}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-xs px-2 py-1 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 shrink-0"
            aria-label="Close file preview"
          >
            Close
          </button>
        </header>
        <div className="flex-1 min-h-0 overflow-auto p-3">
          {loading && <div className="text-sm text-slate-500">Loading…</div>}
          {error && <PreviewError code={error} />}
          {content && !loading && !error && (
            <pre className="text-xs rounded bg-slate-900/80 p-2 whitespace-pre-wrap break-words text-slate-300 font-mono">
              {content.text || <span className="text-slate-600">empty file</span>}
            </pre>
          )}
        </div>
      </aside>
    </div>
  );
}

function PreviewError({ code }: { code: string }) {
  const tag = code.replace(/^Error:\s*/, "");
  let msg: string;
  if (tag.includes("file.binary")) msg = "Binary file — preview not supported.";
  else if (tag.includes("file.not-found")) msg = "File not found.";
  else if (tag.includes("file.is-dir")) msg = "That path is a directory.";
  else if (tag.includes("path.")) msg = `Path rejected (${tag}).`;
  else msg = tag;
  return <div className="text-sm text-rose-400">{msg}</div>;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

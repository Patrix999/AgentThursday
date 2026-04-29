import { useState } from "react";
import { useWorkspaceFiles, useWorkspaceFileContent } from "../hooks/useWorkspaceFiles";
import type { WorkspaceFileEntry } from "../../shared/schema";

/**
 * M7.2 Card 82 — read-only workspace file panel.
 *
 * Sits in the user-layer (Workspace route) below MainCardsArea, above
 * SummaryStream. Default open; user can collapse. Mobile shows the same
 * panel inline in the scroll area (does NOT enter the bottom action bar
 * per Card §C-8).
 */
export function WorkspaceFileManager() {
  const [open, setOpen] = useState(true);
  const [path, setPath] = useState("");
  const [previewPath, setPreviewPath] = useState<string | null>(null);

  const list = useWorkspaceFiles(open ? path : "");
  const content = useWorkspaceFileContent(open ? previewPath : null);

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
            path={list.data?.path ?? path}
            onSelect={(p) => { setPath(p); setPreviewPath(null); }}
          />
        )}
      </header>
      {open && (
        <div className="grid lg:grid-cols-2 gap-0 lg:gap-3 p-3">
          <FileList
            list={list}
            onEnterDir={(p) => { setPath(p); setPreviewPath(null); }}
            onOpenFile={(p) => setPreviewPath(p)}
            previewPath={previewPath}
          />
          <FilePreview
            content={content.data}
            loading={content.loading}
            error={content.error}
            path={previewPath}
            onClose={() => setPreviewPath(null)}
          />
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
  onEnterDir,
  onOpenFile,
  previewPath,
}: {
  list: ReturnType<typeof useWorkspaceFiles>;
  onEnterDir: (p: string) => void;
  onOpenFile: (p: string) => void;
  previewPath: string | null;
}) {
  if (list.loading) return <div className="text-sm text-slate-500 p-2">Loading…</div>;
  if (list.error) return <div className="text-sm text-rose-400 p-2">{list.error}</div>;
  if (!list.data) return null;
  if (list.data.entries.length === 0) {
    return <div className="text-sm text-slate-500 p-2">Empty directory.</div>;
  }
  return (
    <ul className="text-sm divide-y divide-slate-800/60 lg:max-h-[60vh] overflow-y-auto">
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
        <span className="flex-1 truncate text-slate-200">{entry.name}</span>
        {!isDir && entry.size !== null && (
          <span className="text-xs text-slate-500 font-mono">{formatBytes(entry.size)}</span>
        )}
      </button>
    </li>
  );
}

function FilePreview({
  content,
  loading,
  error,
  path,
  onClose,
}: {
  content: ReturnType<typeof useWorkspaceFileContent>["data"];
  loading: boolean;
  error: string | null;
  path: string | null;
  onClose: () => void;
}) {
  if (path === null) {
    return (
      <div className="text-sm text-slate-500 p-2 lg:border-l lg:border-slate-800 lg:pl-3">
        Select a file to preview.
      </div>
    );
  }
  return (
    <div className="lg:border-l lg:border-slate-800 lg:pl-3 flex flex-col min-h-0">
      <header className="flex items-center justify-between mb-2">
        <span className="text-xs text-slate-400 truncate" title={path}>{path}</span>
        <button
          onClick={onClose}
          className="text-xs text-slate-400 hover:text-slate-100 shrink-0 ml-2"
        >
          Close
        </button>
      </header>
      {loading && <div className="text-sm text-slate-500">Loading…</div>}
      {error && <PreviewError code={error} path={path} />}
      {content && (
        <>
          {content.truncated && (
            <div className="mb-2 text-xs text-amber-300">
              Truncated to first 256 KB ({formatBytes(content.size ?? 0)} total).
            </div>
          )}
          <pre className="text-xs bg-slate-950/80 rounded p-2 overflow-auto whitespace-pre-wrap break-words text-slate-300 lg:max-h-[60vh]">
            {content.text || <span className="text-slate-600">empty file</span>}
          </pre>
        </>
      )}
    </div>
  );
}

function PreviewError({ code, path }: { code: string; path: string }) {
  // The code arrives as `Error: file.binary` — peel off prefix
  const tag = code.replace(/^Error:\s*/, "");
  let msg: string;
  if (tag.includes("file.binary")) msg = "Binary file — preview not supported.";
  else if (tag.includes("file.not-found")) msg = "File not found.";
  else if (tag.includes("file.is-dir")) msg = "That path is a directory.";
  else if (tag.includes("path.")) msg = `Path rejected (${tag}).`;
  else msg = tag;
  return (
    <div className="text-sm text-rose-400">
      {msg}
      <div className="mt-1 text-xs text-slate-500">{path}</div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

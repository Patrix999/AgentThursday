import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { authHeaders } from "../auth/secret";
import { MarkdownText } from "../components/MarkdownText";

function isMarkdown(filename: string, mime: string): boolean {
  const f = filename.toLowerCase();
  return f.endsWith(".md") || f.endsWith(".markdown") || mime.includes("markdown");
}

/**
 * 2026-06-19 — viewer for a shared workspace file (`/shared/:id`).
 *
 * The `share_file` agent tool returns a relative `/shared/:id` link the agent
 * pastes into chat. A direct `/api/manager/shared-files/:id` link can't work in
 * the console (the SPA router would hijack it, and the worker needs the secret
 * header a browser nav can't supply), so this page does the authenticated fetch
 * itself — `authHeaders()` attaches the operator secret; the backend route is
 * owner-scoped, so a file the caller doesn't own returns 404.
 */
export function SharedFileRoute() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ok"; filename: string; content: string; mime: string }
    | { status: "error"; code: number }
  >({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/manager/shared-files/${encodeURIComponent(id ?? "")}`, {
          headers: { ...authHeaders() },
        });
        if (cancelled) return;
        if (!res.ok) {
          setState({ status: "error", code: res.status });
          return;
        }
        const content = await res.text();
        const mime = res.headers.get("content-type") ?? "text/plain";
        const cd = res.headers.get("content-disposition") ?? "";
        const m = cd.match(/filename="([^"]+)"/);
        setState({ status: "ok", filename: m ? m[1] : (id ?? "file"), content, mime });
      } catch {
        if (!cancelled) setState({ status: "error", code: 0 });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (state.status === "loading") {
    return <div style={{ padding: 24 }}>Loading shared file…</div>;
  }
  if (state.status === "error") {
    return (
      <div style={{ padding: 24 }}>
        Shared file not found or not accessible
        {state.code ? ` (HTTP ${state.code})` : ""}.
      </div>
    );
  }
  const downloadHref = `data:${state.mime};charset=utf-8,${encodeURIComponent(state.content)}`;
  const markdown = isMarkdown(state.filename, state.mime);
  // Standalone (no app nav): a fixed full-viewport surface over the app shell.
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        overflow: "auto",
        background: "#0b0d12",
        color: "#e6e6e6",
        padding: "28px 20px",
      }}
    >
      <div style={{ maxWidth: 880, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 18, wordBreak: "break-word" }}>{state.filename}</h2>
          <a href={downloadHref} download={state.filename} style={{ color: "#7aa2ff", whiteSpace: "nowrap" }}>
            ⬇ Download
          </a>
        </div>
        {markdown ? (
          <div style={{ lineHeight: 1.6 }}>
            <MarkdownText text={state.content} />
          </div>
        ) : (
          <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0 }}>{state.content}</pre>
        )}
      </div>
    </div>
  );
}

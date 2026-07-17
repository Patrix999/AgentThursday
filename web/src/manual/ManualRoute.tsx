import { useEffect, useState } from "react";
import { PageHeader } from "../nav/PageHeader";

/**
 * operator manual page. Renders /operator-manual.md (a
 * static asset produced by the multi-agent manual workflow + agentC's
 * editorial pass; provenance is embedded in the document head).
 * Minimal markdown renderer on purpose — no new dependency for one page.
 */

function renderInline(s: string): string {
  return s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/`([^`]+)`/g, '<code class="rounded bg-slate-900 border border-slate-700 px-1 text-[0.9em]">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function mdToHtml(md: string): string {
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let inCode = false;
  let tableBuf: string[] = [];
  let listOpen = false;

  const flushTable = () => {
    if (tableBuf.length === 0) return;
    const rows = tableBuf.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r));
    const cells = (r: string) => r.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => renderInline(c.trim()));
    let html = '<table class="my-3 w-full border-collapse text-sm">';
    rows.forEach((r, i) => {
      const tag = i === 0 ? "th" : "td";
      html += "<tr>" + cells(r).map((c) => `<${tag} class="border border-slate-700 px-2 py-1 text-left align-top">${c}</${tag}>`).join("") + "</tr>";
    });
    html += "</table>";
    out.push(html);
    tableBuf = [];
  };
  const closeList = () => { if (listOpen) { out.push("</ul>"); listOpen = false; } };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      flushTable(); closeList();
      out.push(inCode ? "</code></pre>" : '<pre class="my-3 overflow-x-auto rounded border border-slate-700 bg-slate-900 p-3 text-xs"><code>');
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") + "\n");
      continue;
    }
    if (/^\s*\|/.test(line)) { closeList(); tableBuf.push(line); continue; }
    flushTable();
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeList();
      const lvl = h[1].length;
      const cls = lvl === 1 ? "text-2xl font-semibold mt-2 mb-4" : lvl === 2 ? "text-xl font-semibold mt-8 mb-3 border-b border-slate-800 pb-1" : lvl === 3 ? "text-base font-semibold mt-5 mb-2" : "text-sm font-semibold mt-4 mb-1";
      out.push(`<h${lvl} class="${cls} text-slate-100">${renderInline(h[2])}</h${lvl}>`);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      closeList();
      out.push(`<blockquote class="my-2 border-l-2 border-sky-700 pl-3 text-sm text-slate-400">${renderInline(line.replace(/^\s*>\s?/, ""))}</blockquote>`);
      continue;
    }
    const li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
    if (li) {
      if (!listOpen) { out.push('<ul class="my-2 list-disc pl-5 text-sm text-slate-300 space-y-1">'); listOpen = true; }
      out.push(`<li>${renderInline(li[1])}</li>`);
      continue;
    }
    closeList();
    if (/^\s*---\s*$/.test(line)) { out.push('<hr class="my-6 border-slate-800" />'); continue; }
    if (line.trim() === "") continue;
    out.push(`<p class="my-2 text-sm text-slate-300 leading-relaxed">${renderInline(line)}</p>`);
  }
  flushTable(); closeList();
  if (inCode) out.push("</code></pre>");
  return out.join("");
}

export function ManualRoute() {
  const [md, setMd] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/operator-manual.md")
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setMd)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <PageHeader title="Manual" subtitle="操作手册" />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 sm:px-6">
        {error !== null && (
          <p className="text-sm text-rose-400">manual load failed: {error}</p>
        )}
        {md === null && error === null && (
          <p className="text-sm text-slate-500">loading…</p>
        )}
        {md !== null && (
          <article dangerouslySetInnerHTML={{ __html: mdToHtml(md) }} />
        )}
      </main>
    </div>
  );
}

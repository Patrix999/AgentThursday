/**
 * zero-dependency safe Markdown renderer for the
 * conversation dialog.
 *
 * the parser + types live in `markdownParser.ts` (JSX-free)
 * so the smoke test in `scripts/` can typecheck without forcing JSX
 * support into the scripts tsconfig. This file is the React render
 * layer only: it walks the AST and produces a typed React tree
 * directly. No `dangerouslySetInnerHTML`, no innerHTML mutation —
 * cross-site scripting via injected HTML is structurally impossible
 * because every rendered character either becomes a React text node
 * (auto-escaped) or a typed element.
 *
 * URL allowlist (`SAFE_URL_RE`) is enforced here at render time;
 * `javascript:` / `data:` / `vbscript:` schemes degrade to plain text
 * (no anchor element produced) so the link content stays visible
 * but is not clickable.
 */
import { type ReactNode } from "react";
import {
  parseBlocks,
  SAFE_URL_RE,
  type Block,
  type InlineNode,
  type TableAlignment,
} from "./markdownParser";

export function MarkdownText({ text, className }: { text: string; className?: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className={className ?? "markdown-text space-y-2"}>
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </div>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "paragraph":
      return (
        <p className="text-slate-200 leading-relaxed whitespace-normal break-words">
          {renderInline(block.inline)}
        </p>
      );
    case "heading": {
      // minimal heading block. Renders as semantic <h1>–<h6>
      // sized via Tailwind so the existing dark chat surface gets a
      // clear visual break before/after content. Inline formatting
      // inside the heading runs through `renderInline` for parity
      // with paragraphs.
      const sizeClass = block.level <= 1
        ? "text-base"
        : block.level === 2
          ? "text-sm"
          : "text-xs";
      const className = `font-semibold text-slate-100 ${sizeClass} mt-1 break-words`;
      const children = renderInline(block.inline);
      switch (block.level) {
        case 1: return <h1 className={className}>{children}</h1>;
        case 2: return <h2 className={className}>{children}</h2>;
        case 3: return <h3 className={className}>{children}</h3>;
        case 4: return <h4 className={className}>{children}</h4>;
        case 5: return <h5 className={className}>{children}</h5>;
        case 6: return <h6 className={className}>{children}</h6>;
      }
    }
    case "code":
      return (
        <pre className="rounded border border-slate-800 bg-slate-950/80 p-2 text-xs text-slate-200 overflow-x-auto max-w-full">
          <code className="font-mono whitespace-pre">{block.text}</code>
        </pre>
      );
    case "ul":
      return (
        <ul className="list-disc pl-5 space-y-1 text-slate-200">
          {block.items.map((item, i) => (
            <li key={i} className="break-words">{renderInline(item)}</li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol className="list-decimal pl-5 space-y-1 text-slate-200">
          {block.items.map((item, i) => (
            <li key={i} className="break-words">{renderInline(item)}</li>
          ))}
        </ol>
      );
    case "table": {
      // table rendering. The outer wrapper is
      // `overflow-x-auto max-w-full` so wide tables scroll inside the
      // message bubble instead of pushing the page out. `min-w-0` on
      // the wrapper lets the flex parent shrink the column.
      // Per-cell alignment comes from the delimiter row.
      return (
        <div className="overflow-x-auto max-w-full min-w-0 rounded border border-slate-800">
          <table className="text-xs text-slate-200 border-collapse">
            <thead className="bg-slate-900/80 text-slate-300">
              <tr>
                {block.headerCells.map((cell, i) => (
                  <th
                    key={i}
                    className={`border border-slate-800 px-2 py-1 font-semibold text-left whitespace-normal break-words ${alignmentClass(block.alignments[i] ?? null)}`}
                  >
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, ri) => (
                <tr key={ri} className="odd:bg-slate-950/50">
                  {row.map((cell, ci) => (
                    <td
                      key={ci}
                      className={`border border-slate-800 px-2 py-1 align-top whitespace-normal break-words ${alignmentClass(block.alignments[ci] ?? null)}`}
                    >
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
  }
}

function alignmentClass(alignment: TableAlignment): string {
  switch (alignment) {
    case "left":
      return "text-left";
    case "center":
      return "text-center";
    case "right":
      return "text-right";
    default:
      return "";
  }
}

function renderInline(nodes: readonly InlineNode[]): ReactNode {
  return nodes.map((n, i) => {
    switch (n.kind) {
      case "text":
        return <span key={i}>{n.text}</span>;
      case "bold":
        return <strong key={i} className="font-semibold text-slate-100">{renderInline(n.children)}</strong>;
      case "italic":
        return <em key={i} className="italic">{renderInline(n.children)}</em>;
      case "code":
        return (
          <code
            key={i}
            className="rounded bg-slate-800/80 px-1 py-0.5 text-[0.85em] font-mono text-amber-200 break-words"
          >
            {n.text}
          </code>
        );
      case "link": {
        if (!SAFE_URL_RE.test(n.url)) {
          // Reject dangerous URL schemes (javascript:, data:, etc.).
          // The link text still renders as plain text so the user sees
          // the original markdown content; just no clickable href.
          return <span key={i}>{n.text}</span>;
        }
        return (
          <a
            key={i}
            href={n.url}
            target="_blank"
            rel="noreferrer noopener"
            className="text-sky-300 underline decoration-dotted underline-offset-2 hover:text-sky-200 break-words"
          >
            {n.text}
          </a>
        );
      }
      case "br":
        return <br key={i} />;
    }
  });
}

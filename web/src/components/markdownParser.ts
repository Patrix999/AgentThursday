/**
 *  / JSX-free markdown parser.
 *
 *  originally lived as part of `MarkdownText.tsx`. The
 * verifier () found that pulling the parser into the
 * `scripts/` typecheck via the smoke harness fails when the smoke
 * script imports a `.tsx` module without `--jsx` enabled. Extracting
 * the parser + types into this JSX-free file lets both the React
 * renderer and the smoke harness import from the same source without
 * the scripts tsconfig dependency on JSX.
 *
 * Security contract preserved from : the parser produces an
 * AST of typed nodes; rendering happens in `MarkdownText.tsx` which
 * builds a React tree directly (no `dangerouslySetInnerHTML`). The
 * `SAFE_URL_RE` allowlist exported here is the canonical source of
 * truth for URL scheme validation.
 */

export type InlineNode =
  | { kind: "text"; text: string }
  | { kind: "bold"; children: InlineNode[] }
  | { kind: "italic"; children: InlineNode[] }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; url: string }
  | { kind: "br" };

export type TableAlignment = "left" | "center" | "right" | null;

export type Block =
  | { kind: "paragraph"; inline: InlineNode[] }
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; inline: InlineNode[] }
  | { kind: "code"; lang: string | null; text: string }
  | { kind: "ul"; items: InlineNode[][] }
  | { kind: "ol"; items: InlineNode[][] }
  | {
      kind: "table";
      alignments: TableAlignment[];
      headerCells: InlineNode[][];
      rows: InlineNode[][][];
    };

export const SAFE_URL_RE = /^(?:https?:\/\/|mailto:)/i;

export function parseBlocks(input: string): Block[] {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block (```optional-lang ... ```)
    if (/^```/.test(line)) {
      const fenceMatch = /^```\s*([A-Za-z0-9_+-]*)\s*$/.exec(line);
      const lang = fenceMatch && fenceMatch[1].length > 0 ? fenceMatch[1] : null;
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      // Skip closing fence (or end of input).
      if (i < lines.length) i++;
      blocks.push({ kind: "code", lang, text: codeLines.join("\n") });
      continue;
    }

    // Blank line — just a separator.
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    // Heading (): `^#{1,6}\s+text`. Each `#` is a level. The
    // line is its own block — never gathered into a paragraph — so a
    // table immediately following a heading without a blank line gets
    // the chance to start a new table block instead of being absorbed
    // into the heading's paragraph.
    const headingMatch = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (headingMatch) {
      const level = headingMatch[1].length as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ kind: "heading", level, inline: parseInline(headingMatch[2]) });
      i++;
      continue;
    }

    // Pipe table (). A header line containing at least one
    // unescaped `|` followed by a delimiter line whose cells are
    // dashes (`---`) optionally bracketed by `:` for alignment, then
    // one or more body rows that look like pipe-separated cells.
    // Falls back to paragraph if any of those conditions fail — the
    // user's literal pipe text remains visible.
    if (looksLikeTableHeader(line) && i + 1 < lines.length && looksLikeTableDelimiter(lines[i + 1])) {
      const headerCells = parseTableRowCells(line).map((c) => parseInline(c));
      const alignments = parseTableAlignments(lines[i + 1]);
      // Pad the alignments array to the header width so render-side
      // indexing is safe even if the delimiter row has fewer cells.
      while (alignments.length < headerCells.length) alignments.push(null);
      const rows: InlineNode[][][] = [];
      let j = i + 2;
      while (j < lines.length && looksLikeTableHeader(lines[j])) {
        const cells = parseTableRowCells(lines[j]).map((c) => parseInline(c));
        rows.push(cells);
        j++;
      }
      // Reject zero-row tables (just header + delimiter, no body) —
      // typically a transcription mistake; treat as paragraph instead
      // so the original text stays visible.
      if (rows.length > 0) {
        blocks.push({ kind: "table", alignments, headerCells, rows });
        i = j;
        continue;
      }
    }

    // Unordered list (consecutive `- ` or `* ` lines)
    if (/^\s{0,3}[-*]\s+/.test(line)) {
      const items: InlineNode[][] = [];
      while (i < lines.length && /^\s{0,3}[-*]\s+/.test(lines[i])) {
        const itemText = lines[i].replace(/^\s{0,3}[-*]\s+/, "");
        items.push(parseInline(itemText));
        i++;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }

    // Ordered list (consecutive `N. ` lines)
    if (/^\s{0,3}\d+\.\s+/.test(line)) {
      const items: InlineNode[][] = [];
      while (i < lines.length && /^\s{0,3}\d+\.\s+/.test(lines[i])) {
        const itemText = lines[i].replace(/^\s{0,3}\d+\.\s+/, "");
        items.push(parseInline(itemText));
        i++;
      }
      blocks.push({ kind: "ol", items });
      continue;
    }

    // Paragraph: gather contiguous non-blank, non-list, non-fence
    // lines.  adds two more stop conditions so paragraph
    // gathering yields control back to the heading / table detectors:
    //   - the next line starts a heading (`# / ## / …`)
    //   - the next line is a table header AND the line after that
    //     is a table delimiter — together they start a table block,
    //     so paragraph stops one line earlier
    const paraLines: string[] = [line];
    i++;
    while (
      i < lines.length
      && !/^\s*$/.test(lines[i])
      && !/^```/.test(lines[i])
      && !/^\s{0,3}[-*]\s+/.test(lines[i])
      && !/^\s{0,3}\d+\.\s+/.test(lines[i])
      && !/^#{1,6}\s+/.test(lines[i])
      && !(
        looksLikeTableHeader(lines[i])
        && i + 1 < lines.length
        && looksLikeTableDelimiter(lines[i + 1])
      )
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    const inline = parseInline(paraLines.join("\n"));
    blocks.push({ kind: "paragraph", inline });
  }
  return blocks;
}

export function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let i = 0;
  let buffer = "";

  function flushBuffer(): void {
    if (buffer.length === 0) return;
    // Convert single newlines inside a paragraph into <br> nodes so
    // the visible layout matches the source. Blank lines never reach
    // this path because parseBlocks consumes them as separators.
    const parts = buffer.split("\n");
    for (let j = 0; j < parts.length; j++) {
      if (parts[j].length > 0) nodes.push({ kind: "text", text: parts[j] });
      if (j < parts.length - 1) nodes.push({ kind: "br" });
    }
    buffer = "";
  }

  while (i < text.length) {
    const ch = text[i];

    // Inline code: `text`
    if (ch === "`") {
      const closeIdx = text.indexOf("`", i + 1);
      if (closeIdx > i) {
        flushBuffer();
        nodes.push({ kind: "code", text: text.slice(i + 1, closeIdx) });
        i = closeIdx + 1;
        continue;
      }
    }

    // Bold: **text**
    if (ch === "*" && text[i + 1] === "*") {
      const closeIdx = text.indexOf("**", i + 2);
      if (closeIdx > i + 1) {
        flushBuffer();
        nodes.push({ kind: "bold", children: parseInline(text.slice(i + 2, closeIdx)) });
        i = closeIdx + 2;
        continue;
      }
    }

    // Italic: *text* (single asterisk, not preceded by another *)
    if (ch === "*" && text[i + 1] !== "*") {
      const closeIdx = findItalicClose(text, i + 1);
      if (closeIdx > i) {
        flushBuffer();
        nodes.push({ kind: "italic", children: parseInline(text.slice(i + 1, closeIdx)) });
        i = closeIdx + 1;
        continue;
      }
    }

    // Link: [text](url)
    if (ch === "[") {
      const closeBracket = text.indexOf("]", i + 1);
      if (closeBracket > i && text[closeBracket + 1] === "(") {
        const closeParen = text.indexOf(")", closeBracket + 2);
        if (closeParen > closeBracket + 1) {
          const linkText = text.slice(i + 1, closeBracket);
          const linkUrl = text.slice(closeBracket + 2, closeParen).trim();
          if (linkText.length > 0 && linkUrl.length > 0) {
            flushBuffer();
            nodes.push({ kind: "link", text: linkText, url: linkUrl });
            i = closeParen + 1;
            continue;
          }
        }
      }
    }

    buffer += ch;
    i++;
  }
  flushBuffer();
  return nodes;
}

function findItalicClose(text: string, start: number): number {
  // Walk forward looking for a single `*` that is not part of `**`.
  // Returns -1 if not found, otherwise the index of the closing `*`.
  let j = start;
  while (j < text.length) {
    if (text[j] === "*" && text[j + 1] !== "*" && text[j - 1] !== "*") {
      return j;
    }
    j++;
  }
  return -1;
}

// ──  table helpers ──────────────────────────────────────────

function looksLikeTableHeader(line: string): boolean {
  // A pipe-table row line contains at least one `|`. Allow leading /
  // trailing pipes (`| a | b |`) or pipe-separated only (`a | b`).
  // Reject lines that are all whitespace + pipes — they only look
  // structural and would never yield cells.
  if (!/\|/.test(line)) return false;
  const stripped = line.replace(/\|/g, "").trim();
  if (stripped.length === 0) return false;
  return true;
}

function looksLikeTableDelimiter(line: string): boolean {
  // Each delimiter cell is `---` optionally bracketed by `:` for
  // alignment. Allow optional spaces. The whole line, after dropping
  // leading/trailing pipes, must split on `|` into at least one cell
  // and every cell must match `^:?-{3,}:?$` (after trim).
  const cells = splitTableCells(line);
  if (cells.length === 0) return false;
  for (const c of cells) {
    if (!/^:?-{3,}:?$/.test(c.trim())) return false;
  }
  return true;
}

function splitTableCells(line: string): string[] {
  // Strip a single leading and trailing pipe if present, then split on
  // unescaped `|`. We don't currently support `\|` escapes — keep v1
  // simple; cells can contain `\\|` literal as plain text.
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|");
}

function parseTableRowCells(line: string): string[] {
  return splitTableCells(line).map((c) => c.trim());
}

function parseTableAlignments(line: string): TableAlignment[] {
  return splitTableCells(line).map((cell) => {
    const trimmed = cell.trim();
    const left = trimmed.startsWith(":");
    const right = trimmed.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
}

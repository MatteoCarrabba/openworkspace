function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Tiny escape-first markdown renderer (headings, lists incl. checkboxes,
 * fenced code, inline code/bold/italic/links) — ported verbatim from the
 * vanilla dashboard so task bodies render identically.
 *
 * DECISION-9: checkbox list items ("- [ ] …" / "- [x] …") render as REAL
 * `<input type="checkbox">` elements (no WYSIWYG library) tagged with
 * `data-checklist-index`, the item's 0-based occurrence order among
 * checkbox lines in the body — the same order `findChecklistItems` counts
 * server-side, so the index round-trips to `toggleChecklistItem` cleanly.
 * The click handler that POSTs the toggle lives in the DetailPane (event
 * delegation over this raw HTML), not here — this stays a pure string
 * renderer.
 */
export function renderMarkdown(src: string): string {
  const lines = src.split(/\r?\n/);
  const out: string[] = [];
  let inCode = false;
  let inList = false;
  let checklistIndex = 0;
  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  const inline = (s: string): string =>
    esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|\W)\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" rel="noopener" target="_blank">$1</a>');

  for (const line of lines) {
    if (/^```/.test(line)) {
      closeList();
      out.push(inCode ? "</pre>" : "<pre>");
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(esc(line));
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      const n = Math.min(h[1]!.length, 3);
      out.push(`<h${n}>${inline(h[2]!)}</h${n}>`);
      continue;
    }
    const li = line.match(/^\s*[-*]\s+(\[[ xX]\]\s+)?(.*)$/);
    if (li) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      if (li[1]) {
        const checked = /[xX]/.test(li[1]);
        const idx = checklistIndex++;
        const box = `<input type="checkbox" class="checklist-box" data-checklist-index="${idx}"${checked ? " checked" : ""}>`;
        out.push("<li>" + box + " " + inline(li[2] ?? "") + "</li>");
      } else {
        out.push("<li>" + inline(li[2] ?? "") + "</li>");
      }
      continue;
    }
    closeList();
    if (line.trim() === "") continue;
    out.push("<p>" + inline(line) + "</p>");
  }
  closeList();
  if (inCode) out.push("</pre>");
  return out.join("\n");
}

/** Same anchoring as the server's checklist scan: only lines that are ALREADY
 *  a `- [ ]`/`- [x]` (or `*`) item count, in top-to-bottom occurrence order. */
const CHECKLIST_LINE_RE = /^([ \t]*[-*][ \t]+\[)([ xX])(\][ \t]*)(.*)$/gm;

/**
 * Client-side mirror of the server's `toggleChecklistItem`, used ONLY to
 * compute the optimistic body patch shown immediately on click — the
 * server's write is still the source of truth once the POST resolves.
 */
export function toggleChecklistLineInBody(body: string, index: number, checked: boolean): string {
  let i = -1;
  return body.replace(CHECKLIST_LINE_RE, (whole, pre: string, _mark: string, post: string, rest: string) => {
    i++;
    if (i !== index) return whole;
    return pre + (checked ? "x" : " ") + post + rest;
  });
}

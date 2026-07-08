function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Tiny escape-first markdown renderer (headings, lists incl. checkboxes,
 * fenced code, inline code/bold/italic/links) — ported verbatim from the
 * vanilla dashboard so task bodies render identically.
 */
export function renderMarkdown(src: string): string {
  const lines = src.split(/\r?\n/);
  const out: string[] = [];
  let inCode = false;
  let inList = false;
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
      const box = li[1] ? (/[xX]/.test(li[1]) ? "☑ " : "☐ ") : "";
      out.push("<li>" + box + inline(li[2] ?? "") + "</li>");
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

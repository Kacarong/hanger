// A note as HTML for the portfolio page (자세히 보기 under an item). Read-only and simple: nesting becomes an indent,
// toggles stay open, Notion-only blocks are left out. Every string is escaped; links must be http(s) or mailto.
import type { Block, Run } from "./blocks";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const safeUrl = (u: string | undefined) => (u && /^(https?:\/\/|mailto:)/i.test(u) ? u : "");

function runs(b: Block): string {
  const list: Run[] = b.rich ?? [{ t: b.text }];
  return list
    .map((r) => {
      let h = esc(r.t).replace(/\n/g, "<br>");
      if (r.c || r.eq) h = `<code>${h}</code>`;
      if (r.b) h = `<strong>${h}</strong>`;
      if (r.i) h = `<em>${h}</em>`;
      if (r.u) h = `<u>${h}</u>`;
      if (r.s) h = `<s>${h}</s>`;
      const href = safeUrl(r.href);
      return href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${h}</a>` : h;
    })
    .join("");
}

// fileUrl: where the page fetches a 파일함 file (the item's public file route).
export function noteHtml(blocks: Block[], fileUrl: (id: number) => string): string {
  const out: string[] = [];
  const nums: number[] = []; // the running number of a numbered list at each depth
  for (const b of blocks) {
    const d = b.d ?? 0;
    const pad = d ? ` style="margin-left:${Math.min(d, 8) * 1.4}em"` : "";
    nums[d] = b.type === "number" ? (nums[d] ?? 0) + 1 : 0;
    nums.length = d + 1; // a list deeper down starts over next time
    const num = nums[d];
    const src = b.fileId ? fileUrl(b.fileId) : safeUrl(b.url);
    const caption = b.text ? `<figcaption>${runs(b)}</figcaption>` : "";
    switch (b.type) {
      case "p":
        out.push(b.text ? `<p${pad}>${runs(b)}</p>` : "");
        break;
      case "h1":
      case "h2":
      case "h3":
        out.push(`<h${Number(b.type[1]) + 3}${pad}>${runs(b)}</h${Number(b.type[1]) + 3}>`);
        break;
      case "bullet":
        out.push(`<p class="nb-li"${pad}><span>•</span>${runs(b)}</p>`);
        break;
      case "number":
        out.push(`<p class="nb-li"${pad}><span>${num}.</span>${runs(b)}</p>`);
        break;
      case "todo":
        out.push(`<p class="nb-li${b.checked ? " done" : ""}"${pad}><span>${b.checked ? "☑" : "☐"}</span>${runs(b)}</p>`);
        break;
      case "toggle":
        out.push(`<p class="nb-li"${pad}><span>▸</span>${runs(b)}</p>`);
        break;
      case "quote":
        out.push(`<blockquote${pad}>${runs(b)}</blockquote>`);
        break;
      case "callout":
        out.push(`<p class="nb-callout"${pad}>${b.icon ? `<span>${esc(b.icon)}</span>` : ""}${runs(b)}</p>`);
        break;
      case "code":
      case "equation":
        out.push(`<pre${pad}><code>${esc(b.text)}</code></pre>`);
        break;
      case "divider":
        out.push("<hr>");
        break;
      case "image":
        if (src) out.push(`<figure${pad}><img src="${esc(src)}" alt="" loading="lazy">${caption}</figure>`);
        break;
      case "video":
        if (b.fileId) out.push(`<figure${pad}><video src="${esc(src)}" controls preload="metadata"></video>${caption}</figure>`);
        else if (src) out.push(`<p${pad}><a class="nb-file" href="${esc(src)}" target="_blank" rel="noopener">${esc(b.text || src)} ↗</a></p>`);
        break;
      case "audio":
        if (b.fileId) out.push(`<figure${pad}><audio src="${esc(src)}" controls preload="metadata"></audio>${caption}</figure>`);
        break;
      case "pdf":
      case "file":
        if (src) out.push(`<p${pad}><a class="nb-file" href="${esc(src)}" target="_blank" rel="noopener">${esc(b.name || b.text || "파일")} ↓</a></p>`);
        break;
      case "bookmark":
      case "embed":
        if (src) out.push(`<p${pad}><a class="nb-file" href="${esc(src)}" target="_blank" rel="noopener">${esc(b.text || src)} ↗</a></p>`);
        break;
      case "page":
      case "db":
      case "link":
        if (b.text) out.push(`<p class="nb-li"${pad}><span>📄</span>${esc(b.text)}</p>`);
        break;
      case "table":
        out.push(
          `<div class="nb-table"${pad}><table>${(b.rows ?? [])
            .map((r, i) => `<tr>${r.cells.map((c, j) => {
              const tag = (b.colHeader && i === 0) || (b.rowHeader && j === 0) ? "th" : "td";
              return `<${tag}>${runs({ ...b, text: c.map((x) => x.t).join(""), rich: c })}</${tag}>`;
            }).join("")}</tr>`)
            .join("")}</table></div>`,
        );
        break;
      // columns, column, synced: their blocks follow as usual; opaque Notion blocks are left out.
    }
  }
  return out.join("\n");
}

// Note blocks: the shape the editor (public/notes.js) and the server share, and Notion's structure
// in a flat list. Nesting is a depth (d) on each block: a block's parent is the nearest block above it
// with depth d - 1, as in Notion where any text block can hold blocks under it.

// A piece of formatted text. Only the marks that are set are present.
// m: a Notion mention kept as Notion gave it (a date, a page, a person, ...); eq: t is an inline equation.
export type Run = { t: string; b?: 1; i?: 1; s?: 1; u?: 1; c?: 1; color?: string; href?: string; m?: Record<string, unknown>; eq?: 1 };
export type Row = { id: string; cells: Run[][] };

export type Block = {
  id: string;
  type: string;
  text: string; // the plain text (caption for media, expression for an equation, title for a page link)
  rich?: Run[]; // only when the text has formatting; its runs join up to text
  d?: number; // depth, 0 when absent
  color?: string; // Notion block color, e.g. "red" or "blue_background"
  checked?: boolean;
  date?: string; // todo: YYYY-MM-DD, makes it a task
  time?: string; // todo: HH:MM
  lang?: string; // code
  icon?: string; // callout emoji
  toggle?: 1; // a heading that folds like a toggle
  fileId?: number; // media: the 파일함 file
  url?: string; // media from elsewhere, bookmark, embed
  name?: string; // media: the file name shown
  page?: string; // page, db, link: the Notion page/database; synced: the block it copies (a copy can't be edited)
  rows?: Row[]; // table
  width?: number; // table columns
  colHeader?: 1;
  rowHeader?: 1;
  nt?: string; // opaque: Notion's block type; link: "database_id" when it links a database
  nd?: string; // opaque: Notion's block data (JSON), to show a label and to create it again if it is moved
};

export const BLOCK_TYPES = [
  "p", "h1", "h2", "h3", "todo", "bullet", "number", "quote", "code", "divider", "toggle", "callout", "equation",
  "image", "video", "audio", "pdf", "file", "bookmark", "embed", "page", "db", "link", "table", "columns", "column", "synced", "opaque",
];
export const TEXT_TYPES = ["p", "h1", "h2", "h3", "todo", "bullet", "number", "quote", "code", "toggle", "callout"];
export const MEDIA_TYPES = ["image", "video", "audio", "pdf", "file"];
export const NOTE_MAX_BLOCKS = 3000;
export const NOTE_MAX_TEXT = 500_000; // characters across all blocks of a note
export const COLORS = ["default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];
const COLOR_RE = new RegExp(`^(${COLORS.slice(1).join("|")})(_background)?$`);
const MENTION_TYPES = ["date", "page", "database", "user", "link_preview", "link_mention", "template_mention", "custom_emoji"];

// Whether a block of this type may hold blocks under it (Notion's rule).
export function canHold(parent: Block | undefined, child: Block): boolean {
  if (!parent) return child.type !== "column";
  if (parent.type === "columns") return child.type === "column";
  if (child.type === "column") return false;
  if (["h1", "h2", "h3"].includes(parent.type)) return !!parent.toggle;
  return ["p", "todo", "bullet", "number", "quote", "toggle", "callout", "column"].includes(parent.type) || (parent.type === "synced" && !parent.page);
}

// Makes depths valid: one more than the block above at most, and only under a block that can hold it.
export function fixDepths(blocks: Block[]): void {
  const stack: Block[] = []; // the open parents: stack[k] is the last block at depth k
  for (const b of blocks) {
    let d = Math.min(b.d ?? 0, stack.length);
    while (d > 0 && !canHold(stack[d - 1], b)) d--;
    stack.length = d;
    stack.push(b);
    if (d) b.d = d;
    else delete b.d;
  }
}

export const plainOf = (runs: Run[]) => runs.map((r) => r.t).join("");

const MARKS = ["b", "i", "s", "u", "c", "eq"] as const;
const sameMarks = (a: Run, b: Run) =>
  MARKS.every((k) => !!a[k] === !!b[k]) && (a.color ?? "") === (b.color ?? "") && (a.href ?? "") === (b.href ?? "") && !a.m && !b.m && !a.eq && !b.eq;
export const isPlain = (r: Run) => MARKS.every((k) => !r[k]) && !r.color && !r.href && !r.m;

// Joins neighbours with the same marks and drops empty runs, so equal text always has equal runs.
export function normalizeRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    if (!r.t) continue;
    const last = out.at(-1);
    if (last && sameMarks(last, r)) last.t += r.t;
    else out.push({ ...r });
  }
  return out;
}

// The runs to store: none when the text has no formatting at all.
export const richOrNone = (runs: Run[]): Run[] | undefined => {
  const n = normalizeRuns(runs);
  return n.some((r) => !isPlain(r)) ? n : undefined;
};

// Validates runs from a request. Returns null when they are malformed.
export function cleanRuns(v: unknown, maxLen = NOTE_MAX_TEXT): Run[] | null {
  if (!Array.isArray(v) || v.length > 5000) return null;
  const out: Run[] = [];
  let len = 0;
  for (const raw of v) {
    const r = (raw ?? {}) as Record<string, unknown>;
    if (typeof r.t !== "string") return null;
    len += r.t.length;
    if (len > maxLen) return null;
    const run: Run = { t: r.t };
    for (const k of ["b", "i", "s", "u", "c", "eq"] as const) if (r[k]) run[k] = 1;
    if (typeof r.color === "string" && COLOR_RE.test(r.color)) run.color = r.color;
    if (typeof r.href === "string" && r.href && r.href.length <= 2000 && /^(https?:|mailto:|\/)/i.test(r.href)) run.href = r.href;
    if (r.m && typeof r.m === "object" && MENTION_TYPES.includes((r.m as { type?: string }).type ?? "") && JSON.stringify(r.m).length <= 2000) run.m = r.m as Record<string, unknown>;
    out.push(run);
  }
  return out;
}

const isTime = (v: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
export function isDate(v: string): boolean {
  const d = new Date(v + "T00:00:00Z");
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
}
const safeUrl = (v: unknown) => (typeof v === "string" && v.length <= 2000 && /^https?:\/\//i.test(v) ? v : undefined);
const shortStr = (v: unknown, max: number) => (typeof v === "string" && v ? v.slice(0, max) : undefined);

// Validates a note's block list from a request and keeps only the fields each type uses.
// The result is canonical: saving the same content always gives the same JSON.
export function cleanBlocks(v: unknown): Block[] | string {
  if (!Array.isArray(v) || v.length > NOTE_MAX_BLOCKS) return "블록 목록이 올바르지 않습니다";
  const ids = new Set<string>();
  const newId = (x: unknown) => typeof x === "string" && /^[\w-]{1,40}$/.test(x) && !ids.has(x) && (ids.add(x), true);
  let total = 0;
  const out: Block[] = [];
  for (const raw of v) {
    const b = (raw ?? {}) as Record<string, unknown>;
    if (!newId(b.id)) return "블록 id가 올바르지 않습니다";
    if (!BLOCK_TYPES.includes(b.type as string)) return "블록 종류가 올바르지 않습니다";
    const type = b.type as string;
    const block: Block = { id: b.id as string, type, text: "" };
    if (type !== "divider" && type !== "columns" && type !== "column") {
      const rich = b.rich === undefined ? undefined : cleanRuns(b.rich);
      if (rich === null) return "글 꾸밈이 올바르지 않습니다";
      if (rich) {
        block.text = plainOf(rich);
        const kept = richOrNone(rich);
        if (kept) block.rich = kept;
      } else block.text = typeof b.text === "string" ? b.text : "";
    }
    if (Number.isInteger(b.d) && (b.d as number) > 0) block.d = Math.min(b.d as number, 60);
    if (typeof b.color === "string" && COLOR_RE.test(b.color)) block.color = b.color;
    if (type === "todo") {
      block.checked = b.checked === true;
      if (typeof b.date === "string" && b.date) {
        if (!isDate(b.date)) return "날짜가 올바르지 않습니다";
        block.date = b.date;
        if (typeof b.time === "string" && b.time) {
          if (!isTime(b.time)) return "시간이 올바르지 않습니다";
          block.time = b.time;
        }
      }
    }
    if (type === "code") block.lang = shortStr(b.lang, 40) ?? "plain text";
    if (type === "callout" && typeof b.icon === "string" && b.icon) block.icon = b.icon.slice(0, 16);
    if (["h1", "h2", "h3"].includes(type) && b.toggle) block.toggle = 1; // whether a toggle is open is only kept on the screen
    if (MEDIA_TYPES.includes(type)) {
      if (Number.isInteger(b.fileId)) block.fileId = b.fileId as number;
      else if (safeUrl(b.url)) block.url = safeUrl(b.url);
      const name = shortStr(b.name, 300);
      if (name) block.name = name;
    }
    if (type === "bookmark" || type === "embed") {
      const url = safeUrl(b.url);
      if (url) block.url = url;
    }
    if (["page", "db", "link", "synced"].includes(type)) {
      const page = shortStr(b.page, 40);
      if (page && /^[\w-]+$/.test(page)) block.page = page;
    }
    if (type === "table") {
      const width = Number(b.width);
      if (!Number.isInteger(width) || width < 1 || width > 50) return "표가 올바르지 않습니다";
      block.width = width;
      if (b.colHeader) block.colHeader = 1;
      if (b.rowHeader) block.rowHeader = 1;
      if (!Array.isArray(b.rows) || b.rows.length > 1000) return "표가 올바르지 않습니다";
      block.rows = [];
      for (const rawRow of b.rows) {
        const r = (rawRow ?? {}) as Record<string, unknown>;
        if (!newId(r.id) || !Array.isArray(r.cells)) return "표가 올바르지 않습니다";
        const cells: Run[][] = [];
        for (let i = 0; i < width; i++) {
          const c = r.cells[i] === undefined ? [] : cleanRuns(r.cells[i], 20000);
          if (c === null) return "표가 올바르지 않습니다";
          cells.push(normalizeRuns(c));
        }
        block.rows.push({ id: r.id as string, cells });
      }
      block.text = block.rows.map((r) => r.cells.map(plainOf).join(" | ")).join("\n");
    }
    if (type === "opaque") {
      const nt = shortStr(b.nt, 60);
      if (!nt) return "블록이 올바르지 않습니다";
      block.nt = nt;
      if (typeof b.nd === "string" && b.nd.length <= 20000) block.nd = b.nd;
    }
    if (type === "link" && b.nt === "database_id") block.nt = "database_id";
    total += block.text.length;
    if (total > NOTE_MAX_TEXT) return "노트가 너무 깁니다";
    out.push(block);
  }
  fixDepths(out);
  return out;
}

// The task title of a todo block: its first line.
export const blockTitle = (b: Block) => b.text.split("\n")[0]!.trim().slice(0, 200);

// The block's content without its id and depth, to tell whether it changed.
export function contentKey(b: Block): string {
  const { id: _id, d: _d, rows, ...rest } = b;
  return JSON.stringify({ ...rest, rows: rows?.map((r) => r.cells) });
}
export const sameBlock = (a: Block, b: Block) => (a.d ?? 0) === (b.d ?? 0) && contentKey(a) === contentKey(b) && JSON.stringify(a.rows?.map((r) => r.id)) === JSON.stringify(b.rows?.map((r) => r.id));
export const sameBlocks = (a: Block[], b: Block[]) => a.length === b.length && a.every((x, i) => x.id === b[i]!.id && sameBlock(x, b[i]!));

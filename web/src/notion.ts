// Two-way sync between notes and the owner's Notion pages (one note per page), through Notion's API
// with the owner's token (stored in settings once given; only pages the token can see take part).
//
// A sync of one page reads the page from Notion (R), merges it with the note (L) using the page as
// last synced (snapshot S): a block changed only on one side takes that side, a block changed on both takes
// the note's. The merged result goes to Notion as block-by-block changes against R, and to the note if it differs.
// Notion has no "move" for blocks, so a moved block is deleted and made again where it now sits; blocks that can't
// be made again (child pages, databases, column layouts, blocks the API can't create) stay where Notion has them.
import { fixDepths, MEDIA_TYPES, NOTE_MAX_BLOCKS, NOTE_MAX_TEXT, plainOf, richOrNone, sameBlock, sameBlocks, stableJson, type Block, type Row, type Run } from "./blocks";
import type { Db, FileRow, NotionPageRow } from "./db";

const NOTION_VERSION = "2022-06-28";
const NOTION_VERSION_NEW = "2026-03-11"; // only for adding blocks: this version can place them at the start of a parent
const MAX_DEPTH = 30; // blocks nested deeper than this are not read, and the note becomes read-only
export const NOTION_MAX_FILE = 50 * 1024 ** 2; // held in memory while copied to the 파일함 (the service has 512MB)
const FRESH_MS = 2 * 60_000; // Notion's edit times are whole minutes: a page edited this recently is read again on each poll
const OPEN_SYNC_MS = 10_000; // an open note is checked against Notion at most this often
const FULL_SYNC_MS = 30 * 60_000; // a full pass also finds deleted pages and retries failed files

type NRich = { type: string; plain_text: string; href?: string | null; annotations?: Record<string, unknown>; text?: { content: string; link?: { url: string } | null }; mention?: Record<string, any>; equation?: { expression: string } };
type Page = { id: string; object: string; url?: string; parent?: { type: string; page_id?: string; database_id?: string; block_id?: string }; created_time: string; last_edited_time: string; archived?: boolean; in_trash?: boolean; icon?: { type: string; emoji?: string } | null; properties: Record<string, any> };
type NBlock = { id: string; type: string; has_children?: boolean; kids?: NBlock[] } & Record<string, any>;

export type NotionStatus = {
  connected: boolean;
  running: boolean; // a full pass is going
  done: number; // pages handled in the current or last full pass
  total: number;
  lastSync: string | null; // ISO time the last full pass ended
  error: string | null;
  failed: string[]; // pages the last full pass could not sync
  partial: string[]; // pages too long or too deep: read-only here
  fileProblems: number; // files that could not be copied from Notion
};

export class NotionError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const seoul = (d: Date, opts: Intl.DateTimeFormatOptions, locale: string) => new Intl.DateTimeFormat(locale, { timeZone: "Asia/Seoul", ...opts }).format(d);
const sqlTime = (iso: string) => new Date(iso).toISOString().slice(0, 19).replace("T", " "); // same form as datetime('now')
const shortDate = (s: string) => s.replace(/T(\d\d:\d\d).*/, " $1");
const plain = (rt: NRich[] | undefined) => (rt ?? []).map((t) => t.plain_text).join("");
const notionUrl = (id: string) => `https://www.notion.so/${id.replace(/-/g, "")}`;

// ---- Notion rich text ⇄ runs

function runsFrom(rt: NRich[] | undefined): Run[] {
  const out: Run[] = [];
  for (const t of rt ?? []) {
    const r: Run = { t: t.type === "equation" ? (t.equation?.expression ?? t.plain_text) : t.plain_text };
    const a = t.annotations ?? {};
    if (a.bold) r.b = 1;
    if (a.italic) r.i = 1;
    if (a.strikethrough) r.s = 1;
    if (a.underline) r.u = 1;
    if (a.code) r.c = 1;
    if (typeof a.color === "string" && a.color !== "default") r.color = a.color;
    if (t.type === "equation") r.eq = 1;
    else if (t.type === "mention" && t.mention) {
      const m = t.mention;
      // Keep what is needed to write the mention back; a person is just their id.
      r.m = m.type === "user" ? { type: "user", user: { id: m.user?.id } } : m.type === "date" ? { type: "date", date: m.date } : m.type === "page" ? { type: "page", page: { id: m.page?.id } } : m.type === "database" ? { type: "database", database: { id: m.database?.id } } : { type: m.type, ...(m.link_preview ? { link_preview: { url: m.link_preview.url } } : {}) };
      if (!r.m.page && !r.m.database && !r.m.date && !r.m.user && t.href) r.href = t.href;
    } else {
      const href = t.text?.link?.url ?? t.href;
      if (href) r.href = href;
    }
    out.push(r);
  }
  return out;
}

// Notion takes at most 100 pieces of up to 2000 characters each.
function runsTo(runs: Run[] | undefined, text: string): NRich[] {
  const src = runs ?? (text ? [{ t: text }] : []);
  const out: any[] = [];
  for (const r of src) {
    const annotations: Record<string, unknown> = {};
    if (r.b) annotations.bold = true;
    if (r.i) annotations.italic = true;
    if (r.s) annotations.strikethrough = true;
    if (r.u) annotations.underline = true;
    if (r.c) annotations.code = true;
    if (r.color) annotations.color = r.color;
    const extra = Object.keys(annotations).length ? { annotations } : {};
    if (r.eq) out.push({ type: "equation", equation: { expression: r.t }, ...extra });
    else if (r.m && ["date", "page", "database", "user"].includes(r.m.type as string)) out.push({ type: "mention", mention: r.m, ...extra });
    else {
      const href = r.href ?? (r.m?.type === "link_preview" ? (r.m.link_preview as { url: string }).url : undefined);
      const link = href ? { url: href.startsWith("/") ? "https://www.notion.so" + href : href } : null;
      for (let i = 0; i < r.t.length; i += 2000) out.push({ type: "text", text: { content: r.t.slice(i, i + 2000), link }, ...extra });
    }
  }
  if (out.length > 100) {
    const rest = out.splice(99).map((x) => x.text?.content ?? x.equation?.expression ?? "").join("");
    for (let i = 0; i < rest.length; i += 2000) out.push({ type: "text", text: { content: rest.slice(i, i + 2000) } });
  }
  return out;
}

function propText(p: any): string {
  const v = p[p.type];
  switch (p.type) {
    case "rich_text":
      return plain(v);
    case "number":
      return v == null ? "" : String(v);
    case "select":
    case "status":
      return v?.name ?? "";
    case "multi_select":
      return v.map((o: any) => o.name).join(", ");
    case "date":
      return v ? shortDate(v.start) + (v.end ? ` ~ ${shortDate(v.end)}` : "") : "";
    case "checkbox":
      return v ? "✓" : "";
    case "url":
    case "email":
    case "phone_number":
      return v ?? "";
    case "people":
      return v.map((u: any) => u.name ?? "").filter(Boolean).join(", ");
    case "files":
      return v.map((f: any) => f.name).join(", ");
    case "formula":
      return v.type === "date" ? (v.date ? shortDate(v.date.start) : "") : v[v.type] == null ? "" : String(v[v.type]);
    case "unique_id":
      return v.number == null ? "" : `${v.prefix ? v.prefix + "-" : ""}${v.number}`;
    default:
      return "";
  }
}

const titleProp = (p: Page) => Object.entries(p.properties ?? {}).find(([, v]: [string, any]) => v.type === "title");
const iconOf = (p: Page) => (p.icon?.type === "emoji" ? p.icon.emoji! : "");
export function pageTitle(p: Page): string {
  const icon = iconOf(p);
  return ((icon ? icon + " " : "") + plain(titleProp(p)?.[1]?.title)).trim().slice(0, 200);
}

// ---- Notion blocks → note blocks

const TEXT_OF: Record<string, string> = { paragraph: "p", heading_1: "h1", heading_2: "h2", heading_3: "h3", to_do: "todo", bulleted_list_item: "bullet", numbered_list_item: "number", quote: "quote", toggle: "toggle", callout: "callout", code: "code" };
const NOTION_OF = Object.fromEntries(Object.entries(TEXT_OF).map(([k, v]) => [v, k])) as Record<string, string>;
const CREATABLE_OPAQUE = ["table_of_contents", "breadcrumb"];

// The blocks that can be made again in Notion (so they may be moved), as opposed to ones that would be lost.
function remakeable(b: Block): boolean {
  if (["page", "db", "columns", "column"].includes(b.type)) return false;
  if (b.type === "synced") return !!b.page;
  if (b.type === "opaque") return CREATABLE_OPAQUE.includes(b.nt ?? "");
  if (MEDIA_TYPES.includes(b.type)) return b.fileId !== undefined || !!b.url;
  return true;
}

// ---- tree helpers over the flat list

type Node = { b: Block; kids: Node[] };
function treeOf(blocks: Block[]): Node[] {
  const root: Node[] = [];
  const stack: Node[] = [];
  for (const b of blocks) {
    const n: Node = { b, kids: [] };
    const d = Math.min(b.d ?? 0, stack.length);
    stack.length = d;
    (d ? stack[d - 1]!.kids : root).push(n);
    stack.push(n);
  }
  return root;
}
const subtreeOk = (n: Node): boolean => remakeable(n.b) && n.kids.every(subtreeOk);
const subtreeSize = (n: Node): number => 1 + n.kids.reduce((s, k) => s + subtreeSize(k), 0);

// Merges the note (local) and Notion (remote) against what they both were (base), block by block.
export function merge3(base: Block[], local: Block[], remote: Block[]): Block[] {
  const B = new Map(base.map((b) => [b.id, b]));
  const L = new Map(local.map((b) => [b.id, b]));
  const R = new Map(remote.map((b) => [b.id, b]));
  const pick = new Map<string, Block>();
  for (const l of local) {
    const b = B.get(l.id);
    const r = R.get(l.id);
    if (!b) pick.set(l.id, l); // new here
    else if (!r) {
      if (!sameBlock(l, b)) pick.set(l.id, l); // deleted in Notion but changed here: keep
    } else pick.set(l.id, sameBlock(l, b) ? r : l);
  }
  for (const r of remote) if (!L.has(r.id) && !B.has(r.id)) pick.set(r.id, r); // new in Notion (deleted here: stays deleted)
  // Order: if the note kept the old order, Notion's order (it may have moved things); else the note's.
  const order = (list: Block[]) => list.map((b) => b.id).filter((id) => B.has(id));
  const baseOrder = order(base);
  const keptOrder = (ids: string[]) => {
    const pos = new Map(baseOrder.map((id, i) => [id, i]));
    return ids.every((id, i) => i === 0 || pos.get(ids[i - 1]!)! < pos.get(id)!);
  };
  const [first, second] = keptOrder(order(local)) ? [remote, local] : [local, remote];
  const out: Block[] = first.filter((b) => pick.has(b.id)).map((b) => pick.get(b.id)!);
  const placed = new Set(out.map((b) => b.id));
  let after: string | null = null;
  for (const b of second) {
    if (pick.has(b.id) && !placed.has(b.id)) {
      const at = after === null ? 0 : out.findIndex((x) => x.id === after) + 1;
      out.splice(at, 0, pick.get(b.id)!);
      placed.add(b.id);
    }
    if (placed.has(b.id)) after = b.id;
  }
  fixDepths(out);
  return out;
}

export function createNotionSync(o: {
  db: Db;
  apiBase: string; // https://api.notion.com
  saveFile: (name: string, mime: string, bytes: Blob) => Promise<FileRow>; // into the 파일함
  fileLink: (fileId: number, name: string) => string; // a link Notion can show a 파일함 file from
  fileOfLink: (url: string) => number | null; // the 파일함 file such a link points to
  today: () => string;
  debounceMs?: number; // after a save, wait this long for more typing before sending to Notion
}) {
  const { db } = o;
  const status: NotionStatus = { connected: !!db.getSetting("notion_token"), running: false, done: 0, total: 0, lastSync: null, error: null, failed: [], partial: [], fileProblems: 0 };
  const token = () => db.getSetting("notion_token") ?? "";

  async function api(method: string, path: string, body?: object, version = NOTION_VERSION): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(o.apiBase + path, {
        method,
        headers: { Authorization: `Bearer ${token()}`, "Notion-Version": version, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body && JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) return res.json();
      // Notion allows about 3 requests a second and says how long to wait.
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        const wait = res.headers.get("Retry-After");
        await Bun.sleep(wait !== null ? Number(wait) * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      if (res.status === 401) throw new NotionError("노션 토큰이 올바르지 않거나 만료되었습니다. 노션 연결에서 토큰을 다시 넣어 주세요.", 401);
      throw new NotionError(`노션 요청 실패 (${res.status}): ${(await res.text()).slice(0, 300)}`, res.status);
    }
  }
  async function all(path: string, body?: object): Promise<any[]> {
    const out: any[] = [];
    let cursor: string | undefined;
    do {
      const r = body
        ? await api("POST", path, { ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) })
        : await api("GET", `${path}?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`);
      out.push(...r.results);
      cursor = r.has_more ? r.next_cursor : undefined;
    } while (cursor);
    return out;
  }

  // Copies a Notion-hosted file (its link expires within the hour) into the 파일함, once per file:
  // the address without its signature stays the same until the file is replaced in Notion.
  async function copyFile(key: string, url: string, name: string): Promise<FileRow> {
    const source = url.split("?")[0]!;
    const had = db.notionFile(key);
    if (had && had.source === source) return had;
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`다운로드 실패 (${res.status})`);
    if (Number(res.headers.get("Content-Length")) > NOTION_MAX_FILE) throw new Error("50MB가 넘음");
    const bytes = await res.blob();
    if (bytes.size > NOTION_MAX_FILE) throw new Error("50MB가 넘음");
    if (!bytes.size) throw new Error("빈 파일");
    const row = await o.saveFile(name, res.headers.get("Content-Type") || "application/octet-stream", bytes);
    db.setNotionFile(key, row.id, source);
    return row;
  }

  // ---- reading a page

  async function children(id: string, depth: number, cut: { deep: boolean }): Promise<NBlock[]> {
    const list = (await all(`/v1/blocks/${id}/children`)) as NBlock[];
    for (const b of list) {
      if (!b.has_children || b.type === "child_page" || b.type === "child_database") continue;
      if (b.type === "synced_block" && b.synced_block?.synced_from) {
        // A copy of a synced block: its content lives in the original, shown here read-only.
        try {
          b.kids = await children(b.synced_block.synced_from.block_id, MAX_DEPTH, cut);
        } catch (e) {
          if (!(e instanceof NotionError && e.status === 404)) throw e; // the original is in a page the token can't see
          b.kids = [];
        }
        continue;
      }
      if (depth >= MAX_DEPTH) {
        cut.deep = true;
        continue;
      }
      b.kids = await children(b.id, depth + 1, cut);
    }
    return list;
  }

  // A page's blocks as note blocks. ids: Notion id → note block id, for blocks made on this site.
  async function convert(page: Page, ids: Map<string, string>) {
    // A block whose own id is the note id of a block made again elsewhere is an old copy left by a failed delete:
    // it gets its own id so the note never has the same id twice (it then shows up as a block of its own).
    const taken = new Set(ids.values());
    const idOf = (nid: string) => ids.get(nid) ?? (taken.has(nid) ? nid.replace(/-/g, "") + "-old" : nid);
    const blocks: Block[] = [];
    const kids: string[] = [];
    const cut = { deep: false };
    let size = 0;
    let full = false;
    let fileFailed = false;
    const push = (b: Block) => {
      if (full) return;
      if (blocks.length >= NOTE_MAX_BLOCKS || size + b.text.length > NOTE_MAX_TEXT) return void (full = true);
      size += b.text.length;
      blocks.push(b);
    };
    const preview = (list: NBlock[] | undefined): string =>
      (list ?? []).map((k) => [plain(k[k.type]?.rich_text), preview(k.kids)].filter(Boolean).join("\n")).filter(Boolean).join("\n");

    async function media(b: NBlock, out: Block) {
      const d = b[b.type] ?? {};
      if (d.type === "external") {
        const url: string = d.external?.url ?? "";
        const fileId = o.fileOfLink(url);
        if (fileId !== null && db.getFile(fileId)) out.fileId = fileId;
        else if (/^https?:\/\//i.test(url)) out.url = url;
        return;
      }
      const url: string = d.file?.url ?? "";
      const name: string = d.name || (url && decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "")) || b.type;
      out.name = name;
      try {
        if (!url) throw new Error("노션 밖으로 받을 수 없는 파일");
        out.fileId = (await copyFile(b.id, url, name)).id;
      } catch (e) {
        fileFailed = true;
        status.fileProblems++;
        out.name = `${name} (가져오지 못함: ${e instanceof Error ? e.message : e})`;
      }
    }

    async function walk(list: NBlock[], depth: number) {
      for (const b of list) {
        const d = b[b.type] ?? {};
        const out: Block = { id: idOf(b.id), type: "opaque", text: "" };
        if (depth) out.d = depth;
        if (typeof d.color === "string" && d.color !== "default") out.color = d.color;
        const setText = (rt: NRich[] | undefined) => {
          const runs = runsFrom(rt);
          out.text = plainOf(runs);
          const rich = richOrNone(runs);
          if (rich) out.rich = rich;
        };
        let walkKids = !!b.kids?.length;
        if (TEXT_OF[b.type]) {
          out.type = TEXT_OF[b.type]!;
          let rt = d.rich_text as NRich[] | undefined;
          if (b.type === "to_do") {
            out.checked = d.checked === true;
            // A date mention in a checkbox becomes its date, so it shows on the today screen and calendar.
            const at = (rt ?? []).findIndex((t) => t.type === "mention" && t.mention?.type === "date");
            const start: string | undefined = at >= 0 ? rt![at]!.mention!.date?.start : undefined;
            if (start && /^\d{4}-\d{2}-\d{2}$/.test(start)) out.date = start;
            else if (start && !Number.isNaN(new Date(start).getTime())) {
              out.date = seoul(new Date(start), {}, "en-CA");
              out.time = seoul(new Date(start), { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }, "en-GB");
            }
            if (out.date) {
              rt = rt!.filter((_, i) => i !== at);
              const last = rt.at(-1);
              if (last?.type === "text") rt = [...rt.slice(0, -1), { ...last, plain_text: last.plain_text.trimEnd() }];
            }
          }
          setText(rt);
          if (b.type.startsWith("heading_") && d.is_toggleable) out.toggle = 1;
          if (b.type === "callout" && d.icon?.type === "emoji") out.icon = d.icon.emoji;
          if (b.type === "code") out.lang = d.language || "plain text";
        } else
          switch (b.type) {
            case "divider":
              out.type = "divider";
              break;
            case "equation":
              out.type = "equation";
              out.text = d.expression ?? "";
              break;
            case "image":
            case "video":
            case "audio":
            case "pdf":
            case "file":
              out.type = b.type;
              setText(d.caption);
              await media(b, out);
              break;
            case "bookmark":
            case "embed":
              out.type = b.type;
              setText(d.caption);
              if (/^https?:\/\//i.test(d.url ?? "")) out.url = d.url;
              break;
            case "child_page":
            case "child_database":
              out.type = b.type === "child_page" ? "page" : "db";
              out.text = d.title ?? "";
              out.page = b.id;
              kids.push((b.type === "child_page" ? "page:" : "db:") + b.id);
              break;
            case "link_to_page":
              out.type = "link";
              out.page = d.page_id ?? d.database_id ?? "";
              if (d.type === "database_id") out.nt = "database_id";
              break;
            case "table": {
              out.type = "table";
              out.width = d.table_width ?? 1;
              if (d.has_column_header) out.colHeader = 1;
              if (d.has_row_header) out.rowHeader = 1;
              out.rows = (b.kids ?? []).filter((r) => r.type === "table_row").map((r): Row => ({
                id: idOf(r.id),
                cells: Array.from({ length: out.width! }, (_, i) => richOrNone(runsFrom(r.table_row?.cells?.[i])) ?? (plain(r.table_row?.cells?.[i]) ? [{ t: plain(r.table_row.cells[i]) }] : [])),
              }));
              out.text = out.rows.map((r) => r.cells.map(plainOf).join(" | ")).join("\n");
              walkKids = false;
              break;
            }
            case "column_list":
              out.type = "columns";
              break;
            case "column":
              out.type = "column";
              break;
            case "synced_block":
              out.type = "synced";
              if (d.synced_from) {
                out.page = d.synced_from.block_id;
                out.text = preview(b.kids).slice(0, 5000);
                walkKids = false;
              }
              break;
            default:
              out.nt = b.type;
              out.nd = JSON.stringify(d).slice(0, 20000);
              walkKids = false; // left as Notion has it
          }
        push(out);
        if (walkKids) await walk(b.kids!, depth + 1);
      }
    }
    await walk(await children(page.id, 0, cut), 0);
    // A database row's other columns, shown above the note read-only.
    const props: [string, string][] = [];
    for (const [k, p] of Object.entries(page.properties ?? {})) if (p.type !== "title" && propText(p)) props.push([k, propText(p)]);
    fixDepths(blocks);
    return { blocks, kids, props, fileFailed, partial: full || cut.deep };
  }

  // ---- writing to Notion

  const linkUrl = (b: Block) => (b.fileId !== undefined ? o.fileLink(b.fileId, db.getFile(b.fileId)?.name ?? b.name ?? "file") : b.url!);

  // The Notion block body for a note block (without children).
  function body(b: Block, forUpdate = false): Record<string, unknown> | null {
    const rich = () => runsTo(b.rich, b.text);
    const color = b.color ?? "default";
    if (NOTION_OF[b.type]) {
      const data: Record<string, unknown> = { rich_text: rich(), color };
      if (b.type === "todo") {
        data.checked = !!b.checked;
        if (b.date) (data.rich_text as unknown[]).push({ type: "mention", mention: { type: "date", date: { start: b.time ? `${b.date}T${b.time}:00.000+09:00` : b.date } } });
      }
      if (b.type.startsWith("h")) data.is_toggleable = !!b.toggle;
      if (b.type === "callout") data.icon = b.icon ? { type: "emoji", emoji: b.icon } : undefined;
      if (b.type === "code") {
        data.language = b.lang ?? "plain text";
        delete data.color;
      }
      return { [NOTION_OF[b.type]!]: data };
    }
    switch (b.type) {
      case "divider":
        return { divider: {} };
      case "equation":
        return { equation: { expression: b.text } };
      case "image":
      case "video":
      case "audio":
      case "pdf":
      case "file": {
        if (b.fileId === undefined && !b.url) return forUpdate ? { [b.type]: { caption: rich() } } : null;
        return { [b.type]: { type: "external", external: { url: linkUrl(b) }, caption: rich() } };
      }
      case "bookmark":
      case "embed":
        return b.url ? { [b.type]: { url: b.url, caption: rich() } } : null;
      case "link":
        return b.page ? { link_to_page: b.nt === "database_id" ? { type: "database_id", database_id: b.page } : { type: "page_id", page_id: b.page } } : null;
      case "table":
        return forUpdate
          ? { table: { has_column_header: !!b.colHeader, has_row_header: !!b.rowHeader } }
          : { table: { table_width: b.width, has_column_header: !!b.colHeader, has_row_header: !!b.rowHeader, children: (b.rows ?? []).map((r) => ({ type: "table_row", table_row: { cells: r.cells.map((c) => runsTo(c, "")) } })) } };
      case "synced":
        return b.page && !forUpdate ? { synced_block: { synced_from: { block_id: b.page } } } : null;
      case "opaque":
        return CREATABLE_OPAQUE.includes(b.nt ?? "") && !forUpdate ? { [b.nt!]: JSON.parse(b.nd || "{}") } : null;
      default:
        return null; // page, db, columns, column: only Notion makes them
    }
  }
  const notionType = (b: Block) => Object.keys(body(b) ?? body(b, true) ?? { x: 1 })[0];

  // Makes Notion's children of `parent` match `want`, given what Notion has now (`have`).
  // nid: note block id → Notion id (filled in for blocks it creates).
  // One push of a note to Notion. Old copies are deleted only at the end (see push), so a move whose new copy could
  // not be made leaves the block where it was instead of losing it.
  type Push = {
    noteId: number;
    orig: ReadonlyMap<string, string>; // note block id → Notion id as Notion has them now (before this push)
    nid: Map<string, string>; // the same, plus the blocks made by this push
    everywhere: Set<string>; // every block id of the whole merged note, so a block moved to another parent is told from a deleted one
    dels: { id: string; needs?: string }[]; // blocks to delete afterwards; needs = only once this block's new copy exists
    made: Set<string>; // note block ids made in this push
  };
  async function push(noteId: number, parent: string, have: Block[], want: Block[], ids: Map<string, string>) {
    const p: Push = { noteId, orig: new Map(ids), nid: new Map(ids), everywhere: new Set(want.flatMap((b) => [b.id, ...(b.rows ?? []).map((r) => r.id)])), dels: [], made: new Set() };
    try {
      await reconcile(p, parent, treeOf(have), treeOf(want));
    } finally {
      for (const d of p.dels) {
        if (d.needs && !p.made.has(d.needs)) continue; // its new copy failed: keep the old one
        const oid = p.orig.get(d.id) ?? d.id;
        await api("DELETE", `/v1/blocks/${oid}`).catch((e) => {
          if (!(e instanceof NotionError && (e.status === 404 || e.status === 400))) throw e; // already gone (e.g. with its parent)
        });
        if ((p.nid.get(d.id) ?? d.id) === oid) db.deleteNotionBlockId(noteId, d.id); // not if a new copy now has the id
      }
    }
  }

  async function reconcile(p: Push, parent: string, have: Node[], want: Node[]) {
    const { noteId, nid, everywhere } = p;
    const haveById = new Map(have.map((n) => [n.b.id, n]));
    const wantIds = new Set(want.map((n) => n.b.id));
    // Blocks that stay where they are: the heaviest common subsequence, where blocks that can't be made again weigh most.
    const common = want.filter((n) => haveById.has(n.b.id));
    const haveOrder = have.filter((n) => wantIds.has(n.b.id));
    const weight = (n: Node) => (subtreeOk(haveById.get(n.b.id)!) ? subtreeSize(n) : 1e6);
    const keep = new Set<string>();
    {
      const a = haveOrder.map((n) => n.b.id);
      const b = common.map((n) => n.b.id);
      const W = common.map(weight);
      const dp = Array.from({ length: a.length + 1 }, () => new Float64Array(b.length + 1));
      for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + W[j - 1]! : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      for (let i = a.length, j = b.length; i && j; ) {
        if (a[i - 1] === b[j - 1]) keep.add(a[--i]!), j--;
        else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) i--;
        else j--;
      }
    }
    // A kept block whose type changed must be made again (Notion can't change a block's type), if it can be.
    const retype = (w: Node, h: Node) => notionType(w.b) !== notionType(h.b) && subtreeOk(h);
    const stays = (w: Node) => {
      const h = haveById.get(w.b.id);
      if (!h) return false;
      if (keep.has(w.b.id)) return !retype(w, h);
      return !subtreeOk(h); // moved, but it can't be made again: it stays where it is in Notion
    };
    // Deleting a block deletes what is under it, so a block that still holds something that can't be made again
    // and is still in the note (a child page moved out of a toggle, say) is left alone.
    const holdsKept = (n: Node): boolean => (!remakeable(n.b) && everywhere.has(n.b.id)) || n.kids.some(holdsKept);
    for (const h of have) {
      const w = want.find((n) => n.b.id === h.b.id);
      if (w && stays(w)) continue;
      if (!w && holdsKept(h)) continue;
      // Moved here or elsewhere in the note (or retyped): delete once the new copy is made. Gone from the note: just delete.
      p.dels.push(w || everywhere.has(h.b.id) ? { id: h.b.id, needs: h.b.id } : { id: h.b.id });
    }
    let prev: string | null = null; // the Notion id of the block the next one goes after
    let batch: Node[] = [];
    const flush = async () => {
      if (!batch.length) return;
      const nodes = batch.filter((n) => body(n.b));
      batch = [];
      for (let i = 0; i < nodes.length; i += 100) {
        const chunk = nodes.slice(i, i + 100);
        const position = prev ? { type: "after_block", after_block: { id: prev } } : { type: "start" };
        const r = await api("PATCH", `/v1/blocks/${parent}/children`, { children: chunk.map((n) => ({ object: "block", type: notionType(n.b), ...body(n.b) })), position }, NOTION_VERSION_NEW);
        // The reply lists the parent's children from the first new one on (Notion's documented shape is the new blocks).
        const made = (r.results as { id: string; type: string }[]).slice(0, chunk.length);
        for (const [k, n] of chunk.entries()) {
          const id = made[k]!.id;
          nid.set(n.b.id, id);
          db.setNotionBlockId(noteId, n.b.id, id);
          p.made.add(n.b.id);
          prev = id;
        }
        for (const n of chunk) {
          if (n.b.type === "table") await mapRows(p, n.b);
          if (n.kids.length) await reconcile(p, nid.get(n.b.id)!, [], n.kids);
        }
      }
    };
    for (const w of want) {
      const h = haveById.get(w.b.id);
      if (!h || !stays(w)) {
        batch.push(w);
        continue;
      }
      await flush();
      const id = nid.get(w.b.id) ?? w.b.id;
      // Same type (a changed type that can't be made again stays the old type in Notion).
      if (!sameContent(w.b, h.b) && notionType(w.b) === notionType(h.b)) {
        const upd = body(w.b, true);
        if (upd) await api("PATCH", `/v1/blocks/${id}`, upd);
        if (w.b.type === "table") await syncRows(p, id, h.b, w.b);
      }
      if (canHoldKids(w.b)) await reconcile(p, id, h.kids, w.kids);
      prev = id;
    }
    await flush();
  }
  const sameContent = (a: Block, b: Block) => sameBlock({ ...a, d: 0 }, { ...b, d: 0 });
  const canHoldKids = (b: Block) => b.type !== "table" && !(b.type === "synced" && b.page) && b.type !== "opaque";

  // Table rows are Notion blocks too: ids for rows of a table just made.
  async function mapRows(p: Push, b: Block) {
    const rows = (await all(`/v1/blocks/${p.nid.get(b.id)}/children`)) as NBlock[];
    (b.rows ?? []).forEach((r, i) => rows[i] && (p.nid.set(r.id, rows[i]!.id), db.setNotionBlockId(p.noteId, r.id, rows[i]!.id), p.made.add(r.id)));
  }
  async function syncRows(p: Push, tableId: string, have: Block, want: Block) {
    const { noteId, nid } = p;
    const old = new Map((have.rows ?? []).map((r) => [r.id, r]));
    const wantIds = new Set((want.rows ?? []).map((r) => r.id));
    const cells = (r: Row) => ({ cells: r.cells.map((c) => runsTo(c, "")) });
    // Rows keep their place unless the order changed; then the rows after the first out-of-place one are made again.
    const oldOrder = (have.rows ?? []).map((r) => r.id).filter((id) => wantIds.has(id));
    const newOrder = (want.rows ?? []).map((r) => r.id).filter((id) => old.has(id));
    const firstMoved = oldOrder.findIndex((id, i) => id !== newOrder[i]);
    const remade = new Set(firstMoved < 0 ? [] : newOrder.slice(firstMoved));
    for (const r of have.rows ?? []) {
      if (!wantIds.has(r.id)) p.dels.push({ id: r.id });
      else if (remade.has(r.id)) p.dels.push({ id: r.id, needs: r.id });
    }
    let prev: string | null = null;
    for (const r of want.rows ?? []) {
      const h = old.get(r.id);
      if (h && !remade.has(r.id)) {
        const id = nid.get(r.id) ?? r.id;
        if (stableJson(h.cells) !== stableJson(r.cells)) await api("PATCH", `/v1/blocks/${id}`, { table_row: cells(r) });
        prev = id;
        continue;
      }
      const position = prev ? { type: "after_block", after_block: { id: prev } } : { type: "start" };
      const res = await api("PATCH", `/v1/blocks/${tableId}/children`, { children: [{ object: "block", type: "table_row", table_row: cells(r) }], position }, NOTION_VERSION_NEW);
      prev = res.results[0].id as string;
      nid.set(r.id, prev);
      db.setNotionBlockId(noteId, r.id, prev);
      p.made.add(r.id);
    }
  }

  // ---- one page

  const locks = new Map<string, Promise<void>>();
  const lastSynced = new Map<string, number>(); // page id → when it was last read
  const fileFailures = new Set<string>(); // pages with a file that could not be copied: tried again on a full pass
  const partialPages = new Set<string>();
  const work = new Set<Promise<unknown>>();
  const track = <T>(p: Promise<T>) => {
    work.add(p);
    p.finally(() => work.delete(p)).catch(() => {});
    return p;
  };

  // Runs one sync of the page at a time; a request while one runs makes one more run after it.
  const queued = new Set<string>();
  function syncPage(pageId: string): Promise<void> {
    if (queued.has(pageId)) return locks.get(pageId)!;
    queued.add(pageId);
    const run = (locks.get(pageId) ?? Promise.resolve()).catch(() => {}).then(() => {
      queued.delete(pageId);
      return syncOnce(pageId);
    });
    locks.set(pageId, run);
    return track(run);
  }

  async function syncOnce(pageId: string, depth = 0): Promise<void> {
    const link = db.notionPage(pageId);
    if (!link) return;
    let note = db.getNote(link.note_id);
    if (!note) return; // deleted here; the delete already went to Notion
    let page: Page;
    try {
      page = await api("GET", `/v1/pages/${pageId}`);
    } catch (e) {
      if (e instanceof NotionError && e.status === 404) return void db.deleteNotionPage(pageId); // the token can't see it any more: the note stays, on this site only
      throw e;
    }
    if (page.archived || page.in_trash) {
      // Deleted in Notion: the note goes too (its child notes move up, and go when their pages are found deleted).
      db.deleteNotionPage(pageId);
      db.deleteNote(link.note_id);
      return;
    }
    const ids = db.notionBlockIds(link.note_id);
    const back = new Map([...ids].map(([k, v]) => [v, k]));
    const remote = await convert(page, back);
    lastSynced.set(pageId, Date.now());
    if (remote.fileFailed) fileFailures.add(pageId);
    else fileFailures.delete(pageId);
    if (remote.partial) partialPages.add(pageId);
    else partialPages.delete(pageId);
    note = db.getNote(link.note_id);
    if (!note) return;
    const rTitle = pageTitle(page);
    const icon = iconOf(page);
    let merged: Block[];
    let title: string;
    const base = link.snapshot;
    if (!base) {
      // First read of this page: Notion's content wins. A note edited here since an old one-way import is kept as its own note.
      if (note.version !== link.version) db.insertNote(`${note.title} (사이트에서 고친 내용)`, note.blocks, o.today());
      merged = remote.blocks;
      title = rTitle;
    } else {
      merged = remote.partial ? remote.blocks : merge3(base.blocks, note.blocks, remote.blocks);
      title = note.title !== base.title ? note.title : rTitle;
    }
    const version = note.version;
    // Send what changed here to Notion.
    let pushed = false;
    if (!remote.partial && !sameBlocks(merged, remote.blocks)) {
      await push(link.note_id, pageId, remote.blocks, merged, ids);
      pushed = true;
    }
    if (title !== rTitle) {
      const plainTitle = icon && title.startsWith(icon + " ") ? title.slice(icon.length + 1) : title;
      const [prop] = titleProp(page) ?? ["title"];
      await api("PATCH", `/v1/pages/${pageId}`, { properties: { [prop]: { title: [{ type: "text", text: { content: plainTitle } }] } } });
      pushed = true;
    }
    if (pushed) page = await api("GET", `/v1/pages/${pageId}`); // for its new edit time
    const kept = merged.length === note.blocks.length && sameBlocks(merged, note.blocks) && title === note.title;
    let newVersion: number | null = version;
    if (!kept) {
      newVersion = db.writeNoteIf(link.note_id, version, title, merged, o.today());
      if (newVersion !== null && !base) db.setNoteTimes(link.note_id, sqlTime(page.created_time), sqlTime(page.last_edited_time));
    }
    db.updateNotionPage(pageId, {
      edited: page.last_edited_time,
      snapshot: { title, blocks: merged },
      version: newVersion ?? version,
      kids: remote.kids,
      title_prop: titleProp(page)?.[0] ?? "title",
      icon,
      props: remote.props,
    });
    if (base === null) {
      // The old import's attachments were the page's files; they are blocks in the note now.
      for (const a of db.notionAttachments(link.note_id)) db.deleteAttachment(a.id);
    }
    // Saved here while this ran: go again so that save reaches Notion too.
    if (newVersion === null && depth < 3) return syncOnce(pageId, depth + 1);
  }

  // ---- finding pages

  // Where each page sits in Notion, so its note can sit under its parent's note.
  const dbParent = new Map<string, string>(); // database id → the page it is in
  async function parentPageOf(p: Page): Promise<string> {
    if (p.parent?.type === "page_id") return p.parent.page_id!;
    if (p.parent?.type === "database_id") {
      const id = p.parent.database_id!;
      if (!dbParent.has(id)) {
        const d = await api("GET", `/v1/databases/${id}`).catch(() => null);
        dbParent.set(id, d?.parent?.type === "page_id" ? d.parent.page_id : "");
      }
      return dbParent.get(id)!;
    }
    return "";
  }

  // A page not linked yet gets a note (under its parent's note when that one is here).
  async function adopt(p: Page): Promise<void> {
    if (db.notionPage(p.id)) return;
    const parent = await parentPageOf(p);
    const note = db.insertNote(pageTitle(p), [], o.today());
    db.setNotionPage(p.id, note.id, "", note.version, []);
    db.updateNotionPage(p.id, { parent });
    const up = parent ? db.notionPage(parent) : null;
    if (up && db.getNote(up.note_id)) db.setNoteParent(note.id, up.note_id);
  }

  // Every page the token can see: search (not exhaustive, says Notion), plus child pages and database rows followed from pages.
  async function fullSync() {
    if (status.running) return;
    Object.assign(status, { running: true, done: 0, total: 0, error: null, failed: [], fileProblems: 0 });
    try {
      const found = new Map<string, Page>();
      const parents = new Map<string, string>();
      const queue: Page[] = [];
      const add = (p: Page, parent?: string) => {
        if (parent) parents.set(p.id, parent);
        if (p.object !== "page" || p.archived || p.in_trash || found.has(p.id)) return;
        found.set(p.id, p);
        queue.push(p);
        status.total = queue.length;
      };
      const followed = new Set<string>();
      const follow = async (kid: string, from: string) => {
        const [kind, id] = kid.split(":") as [string, string];
        if (followed.has(kid)) return;
        followed.add(kid);
        try {
          if (kind === "page") add(await api("GET", `/v1/pages/${id}`), from);
          else {
            dbParent.set(id, from);
            for (const row of await all(`/v1/databases/${id}/query`, {})) add(row, from);
          }
        } catch (e) {
          if (!(e instanceof NotionError && [400, 403, 404].includes(e.status))) throw e; // e.g. a linked view of a database the token can't see
        }
      };
      for (const p of await all("/v1/search", { filter: { property: "object", value: "page" } })) add(p);
      for (const d of await all("/v1/search", { filter: { property: "object", value: "database" } })) {
        if (!d.archived && !d.in_trash) await follow("db:" + d.id, d.parent?.type === "page_id" ? d.parent.page_id : "");
      }
      for (let i = 0; i < queue.length; i++) {
        const p = queue[i]!;
        try {
          const parent = parents.get(p.id) ?? (await parentPageOf(p));
          await adopt(p);
          db.updateNotionPage(p.id, { parent });
          const link = db.notionPage(p.id)!;
          if (link.edited !== p.last_edited_time || !link.snapshot || fileFailures.has(p.id) || isFresh(p)) await syncPage(p.id);
          for (const k of db.notionPage(p.id)?.kids ?? []) await follow(k, p.id);
        } catch (e) {
          if (e instanceof NotionError && e.status === 401) throw e;
          console.error("notion sync:", p.id, e);
          status.failed.push(pageTitle(p) || "제목 없음");
        } finally {
          status.done++;
        }
      }
      // Linked pages not found: deleted in Notion, or no longer shared. syncPage tells which.
      for (const link of db.notionPages()) if (!found.has(link.page_id)) await syncPage(link.page_id).catch((e) => console.error("notion sync:", link.page_id, e));
      placeNotes();
      status.lastSync = new Date().toISOString();
    } catch (e) {
      status.error = e instanceof NotionError ? e.message : "노션과 맞추다가 서버 오류가 났습니다";
      if (!(e instanceof NotionError)) console.error("notion sync:", e);
    } finally {
      status.running = false;
      status.partial = [...partialPages].map((id) => db.notionPage(id)).filter((l) => l && db.getNote(l.note_id)).map((l) => db.getNote(l!.note_id)!.title);
    }
  }
  const isFresh = (p: Page) => Date.now() - new Date(p.last_edited_time).getTime() < FRESH_MS;

  // Each note goes under the note of its nearest Notion ancestor that is still here, else to the top.
  function placeNotes() {
    const links = new Map(db.notionPages().map((l) => [l.page_id, l]));
    for (const l of links.values()) {
      if (!db.getNote(l.note_id)) continue;
      let parent: number | null = null;
      const passed = new Set([l.page_id]);
      for (let up = l.parent; up && !passed.has(up); up = links.get(up)?.parent ?? "") {
        passed.add(up);
        const n = links.get(up)?.note_id;
        if (n && db.getNote(n)) {
          parent = n;
          break;
        }
      }
      db.setNoteParent(l.note_id, parent);
    }
  }

  // Pages edited in Notion since the last look: search sorted by edit time, newest first.
  let watermark = 0;
  async function poll() {
    if (!token() || status.running) return;
    try {
      let cursor: string | undefined;
      let newest = watermark;
      outer: do {
        const r = await api("POST", "/v1/search", { filter: { property: "object", value: "page" }, sort: { timestamp: "last_edited_time", direction: "descending" }, page_size: 50, ...(cursor ? { start_cursor: cursor } : {}) });
        for (const p of r.results as Page[]) {
          const t = new Date(p.last_edited_time).getTime();
          if (t < watermark - FRESH_MS) break outer;
          newest = Math.max(newest, t);
          if (p.archived || p.in_trash) continue;
          const link = db.notionPage(p.id);
          if (!link) {
            await adopt(p);
            await syncPage(p.id);
            placeNotes();
          } else if (link.edited !== p.last_edited_time || isFresh(p)) await syncPage(p.id);
        }
        cursor = r.has_more ? r.next_cursor : undefined;
      } while (cursor && watermark);
      watermark = newest;
      status.error = null;
    } catch (e) {
      status.error = e instanceof NotionError ? e.message : "노션 확인 중 서버 오류가 났습니다";
      if (!(e instanceof NotionError)) console.error("notion poll:", e);
    }
  }

  // ---- notes changed here

  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const background = (p: Promise<unknown>) =>
    p.catch((e) => {
      status.error = e instanceof NotionError ? e.message : "노션에 보내다가 서버 오류가 났습니다";
      if (!(e instanceof NotionError)) console.error("notion sync:", e);
    });

  return {
    status: (): NotionStatus => ({ ...status, connected: !!token() }),
    pageOf: (noteId: number): NotionPageRow | null => db.notionPageOfNote(noteId),
    isPartial: (pageId: string) => partialPages.has(pageId),
    notionUrl,

    // Checks the token with Notion, keeps it, and starts a full pass.
    async connect(t: string) {
      const res = await fetch(o.apiBase + "/v1/users/me", { headers: { Authorization: `Bearer ${t}`, "Notion-Version": NOTION_VERSION }, signal: AbortSignal.timeout(30_000) });
      if (res.status === 401) throw new NotionError("노션 토큰이 올바르지 않습니다. 토큰을 다시 복사해 주세요.", 401);
      if (!res.ok) throw new NotionError(`노션 확인 실패 (${res.status})`, res.status);
      db.setSetting("notion_token", t);
      status.error = null;
      void track(fullSync());
    },
    disconnect() {
      db.raw.query("DELETE FROM settings WHERE key = 'notion_token'").run();
    },
    fullSync: () => track(fullSync()),
    poll: () => track(poll()),

    // After a save here: send it to Notion once the typing pauses.
    noteSaved(noteId: number) {
      const link = db.notionPageOfNote(noteId);
      if (!link || !token()) return;
      clearTimeout(timers.get(link.page_id));
      timers.set(
        link.page_id,
        setTimeout(() => {
          timers.delete(link.page_id);
          void background(syncPage(link.page_id));
        }, o.debounceMs ?? 1500),
      );
    },
    // An open note is brought up to date with Notion now and then.
    noteOpened(noteId: number) {
      const link = db.notionPageOfNote(noteId);
      if (!link || !token() || Date.now() - (lastSynced.get(link.page_id) ?? 0) < OPEN_SYNC_MS || timers.has(link.page_id)) return;
      lastSynced.set(link.page_id, Date.now());
      void background(syncPage(link.page_id));
    },
    syncNote(noteId: number) {
      const link = db.notionPageOfNote(noteId);
      return link && token() ? syncPage(link.page_id) : Promise.resolve();
    },

    // A new note under a Notion page (its parent note's page, or the chosen page for new notes) becomes a Notion page.
    async createPage(noteId: number, parentPage: string) {
      const note = db.getNote(noteId)!;
      const p: Page = await api("POST", "/v1/pages", { parent: { page_id: parentPage }, properties: { title: { title: note.title ? [{ type: "text", text: { content: note.title } }] : [] } } });
      db.setNotionPage(p.id, noteId, p.last_edited_time, note.version, []);
      db.updateNotionPage(p.id, { snapshot: { title: note.title, blocks: [] }, parent: parentPage });
      lastSynced.set(p.id, Date.now());
      if (note.blocks.some((b) => b.text || b.type !== "p")) this.noteSaved(noteId);
      return p.id;
    },
    // A note deleted here goes to Notion's trash (where it can be restored; it then comes back here).
    async archive(pageId: string) {
      clearTimeout(timers.get(pageId));
      timers.delete(pageId);
      await (locks.get(pageId) ?? Promise.resolve()).catch(() => {});
      await api("PATCH", `/v1/pages/${pageId}`, { archived: true }).catch((e) => {
        if (!(e instanceof NotionError && e.status === 404)) throw e;
      });
      db.deleteNotionPage(pageId);
    },

    start(pollMs: number) {
      let n = 0;
      const tick = async () => {
        if (!token()) return;
        n++;
        if (n === 1 || n % Math.round(FULL_SYNC_MS / pollMs) === 0) await track(fullSync());
        else await track(poll());
      };
      void tick();
      return setInterval(() => void tick(), pollMs);
    },
    // Resolves when no sync is waiting or running (for tests).
    async idle() {
      for (;;) {
        if (timers.size) {
          await Bun.sleep(5);
          continue;
        }
        if (!work.size) return;
        await Promise.allSettled([...work]);
      }
    },
  };
}

export type NotionSync = ReturnType<typeof createNotionSync>;

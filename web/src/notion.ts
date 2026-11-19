// Brings the owner's Notion pages into notes, one note per page, through Notion's API
// (an internal integration token; only pages shared with that integration are visible).
// Running it again is safe: a note is updated only when Notion has a newer edit and the note
// was not edited on this site since, and notes deleted here stay deleted.
import { NOTE_MAX_BLOCKS, NOTE_MAX_TEXT, type Block, type Db, type FileRow } from "./db";

const NOTION_VERSION = "2022-06-28";
const MAX_DEPTH = 8; // nested blocks deeper than this are left out
export const NOTION_MAX_FILE = 50 * 1024 ** 2; // held in memory while copied to the 파일함 (the service has 512MB)

// Notion's block and property shapes are many and loose, so most of them stay `any`.
type RichText = { type: string; plain_text: string; href?: string | null; mention?: { type: string; date?: { start: string } } };
type Page = { id: string; object: string; created_time: string; last_edited_time: string; archived?: boolean; in_trash?: boolean; icon?: { type: string; emoji?: string } | null; properties: Record<string, any> };
type NBlock = { id: string; type: string; has_children?: boolean } & Record<string, any>;

export type NotionJob = {
  status: "running" | "done" | "failed";
  total: number; // pages found
  done: number;
  added: number;
  updated: number;
  unchanged: number; // no newer edit in Notion, or the note was deleted here
  skipped: string[]; // newer in Notion but also edited here: left alone
  failed: string[];
  files: number; // files copied to the 파일함
  fileProblems: number; // files that could not be copied
  error?: string;
};

export class NotionError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export const newNotionJob = (): NotionJob => ({ status: "running", total: 0, done: 0, added: 0, updated: 0, unchanged: 0, skipped: [], failed: [], files: 0, fileProblems: 0 });

const seoul = (d: Date, opts: Intl.DateTimeFormatOptions, locale: string) => new Intl.DateTimeFormat(locale, { timeZone: "Asia/Seoul", ...opts }).format(d);
const sqlTime = (iso: string) => new Date(iso).toISOString().slice(0, 19).replace("T", " "); // same form as datetime('now')
const shortDate = (s: string) => s.replace(/T(\d\d:\d\d).*/, " $1");

// Plain text; links keep their address after the text, since the editor has no links.
function plain(rt: RichText[] | undefined): string {
  return (rt ?? []).map((t) => (t.type !== "mention" && t.href && t.href !== t.plain_text ? `${t.plain_text} (${t.href})` : t.plain_text)).join("");
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

export function pageTitle(p: Page): string {
  const t = Object.values(p.properties ?? {}).find((v: any) => v.type === "title");
  const emoji = p.icon?.type === "emoji" ? p.icon.emoji + " " : "";
  return (emoji + plain(t?.title)).trim().slice(0, 200);
}

export async function importNotion(o: {
  token: string;
  apiBase: string; // https://api.notion.com
  db: Db;
  saveFile: (name: string, mime: string, bytes: Blob) => Promise<FileRow>; // into the 파일함
  job: NotionJob; // filled in as it goes
}) {
  const { db, job } = o;

  async function api(path: string, body?: object): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(o.apiBase + path, {
        method: body ? "POST" : "GET",
        headers: { Authorization: `Bearer ${o.token}`, "Notion-Version": NOTION_VERSION, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body && JSON.stringify(body),
      });
      if (res.ok) return res.json();
      // Notion allows about 3 requests a second and says how long to wait.
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        const wait = res.headers.get("Retry-After");
        await Bun.sleep(wait !== null ? Number(wait) * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      if (res.status === 401) throw new NotionError("노션 토큰이 올바르지 않습니다. 통합 시크릿을 다시 복사해 주세요.", 401);
      throw new NotionError(`노션 요청 실패 (${res.status}): ${(await res.text()).slice(0, 200)}`, res.status);
    }
  }

  async function all(path: string, body?: object): Promise<any[]> {
    const out: any[] = [];
    let cursor: string | undefined;
    do {
      const r = body
        ? await api(path, { ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) })
        : await api(`${path}?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`);
      out.push(...r.results);
      cursor = r.has_more ? r.next_cursor : undefined;
    } while (cursor);
    return out;
  }

  // Copies a Notion-hosted file (its link expires within the hour) into the 파일함, once per block.
  async function copyFile(blockId: string, url: string, name: string): Promise<FileRow> {
    const had = db.notionFile(blockId);
    if (had) return had;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`다운로드 실패 (${res.status})`);
    if (Number(res.headers.get("Content-Length")) > NOTION_MAX_FILE) throw new Error("50MB가 넘음");
    const bytes = await res.blob();
    if (bytes.size > NOTION_MAX_FILE) throw new Error("50MB가 넘음");
    if (!bytes.size) throw new Error("빈 파일");
    const row = await o.saveFile(name, res.headers.get("Content-Type") || "application/octet-stream", bytes);
    db.setNotionFile(blockId, row.id);
    job.files++;
    return row;
  }

  // A page's content as note blocks, plus the 파일함 files to attach to the note.
  async function convert(page: Page): Promise<{ blocks: Block[]; files: FileRow[] }> {
    const blocks: Block[] = [];
    const files: FileRow[] = [];
    const ids = new Set<string>();
    let size = 0;
    let full = false;
    const push = (type: string, text: string, extra: Partial<Block>, id: string) => {
      if (full) return;
      if (blocks.length >= NOTE_MAX_BLOCKS - 1 || size + text.length > NOTE_MAX_TEXT - 100) {
        full = true;
        blocks.push({ id: "cut", type: "p", text: "(노션 페이지가 너무 길어 여기까지만 가져왔습니다)" });
        return;
      }
      while (ids.has(id)) id = id.slice(0, 36) + "-" + ids.size.toString(36); // a synced block can repeat its source on one page
      ids.add(id);
      size += text.length;
      blocks.push({ id, type, text, ...extra });
    };

    // Database rows keep their columns as "이름: 값" lines at the top.
    const props = Object.entries(page.properties ?? {})
      .filter(([, p]) => p.type !== "title")
      .map(([k, p]) => [k, propText(p)])
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v}`);
    if (props.length) push("p", props.join("\n"), {}, "props");

    async function walk(list: NBlock[], depth: number) {
      for (const b of list) {
        const d = b[b.type] ?? {};
        const text = plain(d.rich_text);
        const add = (type: string, t: string, extra: Partial<Block> = {}) => push(type, t, extra, b.id);
        switch (b.type) {
          case "paragraph":
            add("p", text);
            break;
          case "heading_1":
          case "heading_2":
          case "heading_3":
            add("h" + b.type.slice(-1), text);
            break;
          case "to_do": {
            // A date mention in a checkbox becomes its date, so it shows on the today screen and calendar.
            const isDate = (t: RichText) => t.type === "mention" && t.mention?.type === "date";
            const start = (d.rich_text as RichText[] | undefined)?.find(isDate)?.mention?.date?.start;
            const when: Partial<Block> = {};
            if (start && /^\d{4}-\d{2}-\d{2}$/.test(start)) when.date = start;
            else if (start && !Number.isNaN(new Date(start).getTime())) {
              when.date = seoul(new Date(start), {}, "en-CA");
              when.time = seoul(new Date(start), { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }, "en-GB");
            }
            add("todo", (when.date ? plain((d.rich_text as RichText[]).filter((t) => !isDate(t))) : text).trim(), { checked: d.checked === true, ...when });
            break;
          }
          case "bulleted_list_item":
            add("bullet", text);
            break;
          case "numbered_list_item":
            add("number", text);
            break;
          case "quote":
            add("quote", text);
            break;
          case "callout":
            add("quote", (d.icon?.type === "emoji" ? d.icon.emoji + " " : "") + text);
            break;
          case "toggle":
            add("p", "▸ " + text);
            break;
          case "code":
            add("code", text);
            break;
          case "equation":
            add("code", d.expression ?? "");
            break;
          case "divider":
            add("divider", "");
            break;
          case "child_page":
            add("p", `📄 ${d.title ?? ""}`);
            break;
          case "child_database":
            add("p", `🗂 ${d.title ?? ""}`);
            break;
          case "link_to_page":
            add("p", "↗ 다른 노션 페이지 링크");
            break;
          case "bookmark":
          case "embed":
          case "link_preview": {
            const caption = plain(d.caption);
            add("p", `🔗 ${caption ? caption + " " : ""}${d.url ?? ""}`);
            break;
          }
          case "table_row":
            add("p", (d.cells as RichText[][]).map(plain).join(" | "));
            break;
          case "image":
          case "file":
          case "pdf":
          case "video":
          case "audio": {
            const emoji = b.type === "image" ? "🖼" : "📎";
            const caption = plain(d.caption);
            if (d.type === "external") {
              add("p", `${emoji} ${caption ? caption + " " : ""}${d.external?.url ?? ""}`);
              break;
            }
            const url: string = d.file?.url ?? "";
            const name = d.name || (url && decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "")) || b.type;
            try {
              if (d.type !== "file" || !url) throw new Error("노션 밖으로 받을 수 없는 파일");
              files.push(await copyFile(b.id, url, name));
              add("p", `${emoji} ${caption || name}`);
            } catch (e) {
              job.fileProblems++;
              add("p", `${emoji} ${caption || name} (가져오지 못함: ${e instanceof Error ? e.message : e})`);
            }
            break;
          }
          // column_list, column, table, synced_block: only their children are content.
          // table_of_contents, breadcrumb, unsupported and the like have none worth keeping.
        }
        if (b.type === "child_page" || b.type === "child_database" || depth >= MAX_DEPTH) continue;
        const source = b.type === "synced_block" ? (d.synced_from?.block_id ?? b.id) : b.id;
        if (!b.has_children && source === b.id) continue;
        try {
          await walk(await all(`/v1/blocks/${source}/children`), depth + 1);
        } catch (e) {
          // The source of a synced block may live in a page not shared with the integration.
          if (!(b.type === "synced_block" && e instanceof NotionError && e.status === 404)) throw e;
        }
      }
    }
    await walk(await all(`/v1/blocks/${page.id}/children`), 0);
    return { blocks, files };
  }

  const pages = (await all("/v1/search", { filter: { property: "object", value: "page" } })).filter((p: Page) => p.object === "page" && !p.archived && !p.in_trash) as Page[];
  job.total = pages.length;
  for (const page of pages) {
    const title = pageTitle(page);
    try {
      const had = db.notionPage(page.id);
      const note = had && db.getNote(had.note_id);
      if (had && (!note || had.edited === page.last_edited_time)) job.unchanged++;
      else if (note && note.version !== had!.version) job.skipped.push(title || "제목 없음");
      else {
        const { blocks, files } = await convert(page);
        // A checked box counts as done on the day the page was last edited, not on import day.
        const doneDay = seoul(new Date(page.last_edited_time), {}, "en-CA");
        let id: number;
        if (note) {
          if (!db.saveNote(note.id, note.version, title, blocks, doneDay)) {
            job.skipped.push(title || "제목 없음"); // edited here while this page was being read
            continue;
          }
          id = note.id;
          job.updated++;
        } else {
          id = db.insertNote(title, blocks, doneDay).id;
          job.added++;
        }
        db.setNoteTimes(id, sqlTime(page.created_time), sqlTime(page.last_edited_time));
        for (const f of files) db.addAttachment("note", id, f.id);
        db.setNotionPage(page.id, id, page.last_edited_time, db.getNote(id)!.version);
      }
    } catch (e) {
      if (e instanceof NotionError && e.status === 401) throw e;
      console.error("notion import:", page.id, e);
      job.failed.push(title || "제목 없음");
    } finally {
      job.done++;
    }
  }
}

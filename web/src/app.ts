import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { cleanBlocks, editRuns, richOrNone } from "./blocks";
import { noteHtml } from "./note-html";
import { ATTACH_TARGETS, CATEGORIES, CLASS_CHANGE_KINDS, COURSE_COLORS, EXAM_COLORS, EXPENSE_KINDS, GRADES, TERMS, SECTION_LAYOUTS, TASK_CATEGORIES, TASK_KINDS, type AttachedFile, type Block, type ClassChangeFields, type CourseFields, type CourseTime, type Db, type ExamFields, type ExpenseFields, type ExpenseRow, type FileRow, type PortfolioFields, type PortfolioItem, type StudyFields, type TaskFields } from "./db";
import { createBackup } from "./backup";
import { eventWhen } from "./gcal";
import { GoogleError, type CalendarEvent, type EventBody, type Google } from "./google";
import { createNotifier } from "./notify";
import { createNotionSync, NotionError } from "./notion";

export const MAX_FILE_SIZE = 1024 ** 3; // files must be under 1GB
const SESSION_DAYS = 30;
const CALENDAR_MAX_DAYS = 62; // longest range /api/calendar serves (a 6-week month grid is 42)
const UPCOMING_DAYS = 3; // 과제 due within this many days show up on the today screen
const EXAM_DAYS = 14; // exams within this many days show up on the today screen
const PUBLIC_DIR = join(import.meta.dir, "..", "public");

export type AppConfig = {
  baseUrl: string; // e.g. https://kacarong.kr
  adminEmail: string; // the only account that can log in (Google)
  dataDir: string;
  googleEnabled: boolean; // false until the OAuth client is configured
  notionApi?: string; // https://api.notion.com unless a test points elsewhere
  notionDebounceMs?: number; // how long after a save the note goes to Notion (tests: 0)
  now?: () => Date; // for tests
};

// YYYY-MM-DD of the given instant in Korea.
export function seoulDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(d);
}

function addDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const isTime = (v: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

function isDate(v: string): boolean {
  const d = new Date(v + "T00:00:00Z");
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
}

// Turns a Google event into the days it covers in Korea (endDate inclusive) and its start time.
function calendarItem(e: CalendarEvent) {
  const hm = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  let startDate: string, endDate: string, time: string | null;
  // end/endTime: where the event really ends, for the edit dialog (endDate is the last day it shows on).
  let end: string, endTime: string | null;
  if (e.start.date) {
    startDate = e.start.date;
    endDate = e.end.date ? addDays(e.end.date, -1) : startDate; // Google's all-day end date is exclusive
    time = null;
    end = endDate;
    endTime = null;
  } else {
    const start = new Date(e.start.dateTime!);
    const until = new Date(e.end.dateTime ?? e.start.dateTime!);
    startDate = seoulDate(start);
    endDate = seoulDate(new Date(until.getTime() - 1)); // ending at 00:00 doesn't touch that day
    time = hm(start);
    end = seoulDate(until);
    endTime = hm(until);
  }
  if (endDate < startDate) endDate = startDate;
  return {
    id: e.id,
    title: e.summary || "(제목 없음)",
    startDate,
    endDate,
    time,
    end,
    endTime,
    location: e.location ?? "",
    description: e.description ?? "",
    link: e.htmlLink ?? "",
    calendar: e.calendar,
    calendarId: e.calendarId,
    editable: e.editable,
    color: /^#[0-9a-f]{6}$/i.test(e.color) ? e.color : "",
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

function cookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.get("Cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// Files a browser may show in place. Anything else (HTML, SVG, scripts, ...) is only ever downloaded,
// so a file in the cloud can never run as a page of this site.
const INLINE_TYPES = /^(image\/(png|jpeg|gif|webp|avif|bmp)|video\/(mp4|webm|ogg|quicktime)|audio\/(mpeg|mp4|ogg|wav|webm|flac|aac|x-m4a)|application\/pdf|text\/plain)$/;
const RASTER = /^image\/(png|jpeg|gif|webp|avif|bmp)$/;

// The name a download gets: the title shown in the cloud, keeping the extension of the uploaded name.
export function downloadName(f: Pick<FileRow, "title" | "name">): string {
  const ext = f.name.match(/\.[\w-]{1,10}$/)?.[0] ?? "";
  return !ext || f.title.toLowerCase().endsWith(ext.toLowerCase()) ? f.title : f.title + ext;
}

function contentDisposition(kind: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// Hash of everything in public/. Static URLs carry it as ?v= so a deploy never pairs new HTML
// with an old /static/ file still sitting in Cloudflare's cache (it keeps them for hours).
function assetVersion(): string {
  const h = createHash("sha256");
  const names = readdirSync(PUBLIC_DIR, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(PUBLIC_DIR, join(e.parentPath, e.name)));
  for (const name of names.sort()) h.update(name).update(readFileSync(join(PUBLIC_DIR, name)));
  return h.digest("hex").slice(0, 10);
}

export function createApp(cfg: AppConfig, db: Db, google: Google) {
  const v = assetVersion();
  const adminHtml = readFileSync(join(PUBLIC_DIR, "admin.html"), "utf8").replace(/"(\/static\/[\w.-]+)"/g, `"$1?v=${v}"`);
  const origin = new URL(cfg.baseUrl).origin;
  const secure = cfg.baseUrl.startsWith("https://") ? "; Secure" : "";
  const thumbDir = join(cfg.dataDir, "thumbs");
  mkdirSync(thumbDir, { recursive: true });

  function setCookie(name: string, value: string, maxAgeSec: number) {
    return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
  }

  // Sessions are only ever created for the owner: the admin Google account, whose email is the subject.
  function session(req: Request): { id: string; subject: string } | null {
    const sid = cookies(req).sid;
    const s = sid ? db.getSession(sid) : null;
    return s ? { id: sid!, subject: s.email } : null;
  }
  const isAdmin = (req: Request) => !!session(req);

  function startSession(subject: string, headers: Headers) {
    db.deleteExpiredSessions();
    const sid = crypto.randomUUID() + crypto.randomUUID();
    db.createSession(sid, subject, Date.now() + SESSION_DAYS * 86400_000);
    headers.append("Set-Cookie", setCookie("sid", sid, SESSION_DAYS * 86400));
  }

  const now = cfg.now ?? (() => new Date());
  const today = () => seoulDate(now());

  // Links Notion can show a 파일함 file from (a block made here points at one): /f/<id>/<signature>/<name>.
  // Only someone with the link can open that file; other files stay private.
  if (!db.getSetting("file_link_secret")) db.setSetting("file_link_secret", randomBytes(32).toString("hex"));
  const linkSig = (id: number) => createHmac("sha256", db.getSetting("file_link_secret")!).update(String(id)).digest("base64url").slice(0, 22);
  const linkOk = (id: number, sig: string) => sig.length === 22 && timingSafeEqual(Buffer.from(sig), Buffer.from(linkSig(id)));
  // Notion copies made before they had their own Drive folder sit in the cloud's folder: move them out, once.
  async function moveNotionCopies() {
    if (!cfg.googleEnabled || !db.getSetting("refresh_token") || db.getSetting("notion_copies_moved")) return;
    const to = await google.notionFolder();
    for (const f of db.notionCopies()) {
      try {
        const from = (await google.getFile(f.drive_id)).parents?.[0];
        if (from && from !== to) await google.move(f.drive_id, from, to);
      } catch (e) {
        if (!(e instanceof GoogleError && e.status === 404)) throw e; // gone from Drive: nothing to move
      }
    }
    db.setSetting("notion_copies_moved", "1");
  }

  const notion = createNotionSync({
    db,
    apiBase: cfg.notionApi ?? "https://api.notion.com",
    saveFile: async (name, mime, bytes) => {
      const d = await google.upload(name, mime, bytes, origin, await google.notionFolder());
      return db.insertFile({ drive_id: d.id, name: d.name, title: d.name, mime: d.mimeType, size: Number(d.size ?? bytes.size), category: "기타", tags: "노션", note: "", origin: "notion" });
    },
    fileLink: (id, name) => `${origin}/f/${id}/${linkSig(id)}/${encodeURIComponent(name.replace(/[\/]/g, "_"))}`,
    fileOfLink: (u) => {
      const m = u.startsWith(origin + "/f/") ? u.slice(origin.length).match(/^\/f\/(\d+)\/([\w-]{22})(\/|$)/) : null;
      return m && linkOk(Number(m[1]), m[2]!) ? Number(m[1]) : null;
    },
    today,
    debounceMs: cfg.notionDebounceMs,
  });
  const notifier = createNotifier({ db, subject: origin, now });
  const backup = createBackup({ db, google, enabled: cfg.googleEnabled, origin, now });

  async function body(req: Request): Promise<Record<string, unknown>> {
    try {
      return (await req.json()) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  function str(v: unknown, max = 500): string {
    return typeof v === "string" ? v.trim().slice(0, max) : "";
  }

  function category(v: unknown): string {
    return CATEGORIES.includes(v as string) ? (v as string) : "기타";
  }

  const folderName = (v: unknown) => str(v, 100).replace(/[\\/]/g, "_");

  // A folder reference from a request: null (or absent) = the top of the cloud, undefined = no such folder.
  function folderRef(v: unknown): number | null | undefined {
    if (v === null || v === undefined || v === "") return null;
    return db.getFolder(Number(v)) ? Number(v) : undefined;
  }

  // The Drive folder that holds a cloud folder's files.
  const driveFolder = (folder: number | null) => (folder === null ? google.rootFolder() : Promise.resolve(db.getFolder(folder)!.drive_id));

  // Validates portfolio item fields from a request body. Only keys present in the body are returned.
  function itemFields(b: Record<string, unknown>): Partial<PortfolioFields> | string {
    const out: Partial<PortfolioFields> = {};
    if ("section_id" in b) {
      if (!db.getSection(Number(b.section_id))) return "섹션을 찾을 수 없습니다";
      out.section_id = Number(b.section_id);
    }
    if ("title" in b) {
      out.title = str(b.title, 200);
      if (!out.title) return "제목을 입력해 주세요";
    }
    if ("period" in b) out.period = str(b.period, 100);
    if ("summary" in b) out.summary = str(b.summary, 300);
    if ("body" in b) out.body = str(b.body, 20000);
    if ("link" in b) {
      out.link = str(b.link, 1000);
      if (out.link && !/^https?:\/\//i.test(out.link)) return "링크는 http:// 나 https:// 로 시작해야 합니다";
    }
    if ("public" in b) out.public = b.public === true ? 1 : 0;
    if ("note_id" in b) {
      if (b.note_id !== null && !db.getNote(Number(b.note_id))) return "노트를 찾을 수 없습니다";
      out.note_id = b.note_id === null ? null : Number(b.note_id);
    }
    return out;
  }

  // Validates task fields from a request body. Only keys present in the body are returned.
  function taskFields(b: Record<string, unknown>): Partial<TaskFields> | string {
    const out: Partial<TaskFields> = {};
    if ("kind" in b) {
      if (!TASK_KINDS.includes(b.kind as string)) return "종류가 올바르지 않습니다";
      out.kind = b.kind as string;
    }
    if ("category" in b) {
      if (b.category !== "" && !TASK_CATEGORIES.includes(b.category as string)) return "카테고리가 올바르지 않습니다";
      out.category = b.category as string;
    }
    if ("title" in b) {
      out.title = str(b.title, 200);
      if (!out.title) return "제목을 입력해 주세요";
    }
    if ("course" in b) out.course = str(b.course, 100);
    if ("note" in b) out.note = str(b.note, 5000);
    if ("due_date" in b) {
      const v = str(b.due_date, 10);
      if (v && !isDate(v)) return "날짜가 올바르지 않습니다";
      out.due_date = v || null;
    }
    if ("due_time" in b) {
      const v = str(b.due_time, 5);
      if (v && !isTime(v)) return "시간이 올바르지 않습니다";
      out.due_time = v || null;
    }
    return out;
  }


  // A Google Calendar event from the event dialog. No start time = all day.
  function eventFields(b: Record<string, unknown>): EventBody | string {
    // Not cut short like other fields: an event made in Google may be long, and editing its date here must keep its text.
    // Too long is refused instead (Google keeps descriptions up to 8192 characters).
    const raw = (v: unknown) => (typeof v === "string" ? v : "");
    const summary = raw(b.title).trim();
    const location = raw(b.location);
    const description = raw(b.description);
    if (!summary) return "제목을 입력해 주세요";
    if (summary.length > 1024 || location.length > 1024) return "제목이나 장소가 너무 깁니다(1024자까지)";
    if (description.length > 8192) return "메모가 너무 깁니다(8192자까지)";
    const date = str(b.date, 10);
    const endDate = str(b.endDate, 10) || date;
    if (!isDate(date) || !isDate(endDate)) return "날짜가 올바르지 않습니다";
    if (endDate < date) return "끝 날짜가 시작 날짜보다 앞입니다";
    const time = str(b.time, 5) || null;
    const endTime = (time && str(b.endTime, 5)) || null;
    if ((time && !isTime(time)) || (endTime && !isTime(endTime))) return "시간이 올바르지 않습니다";
    if (time && endTime && `${endDate}T${endTime}` <= `${date}T${time}`) return "끝나는 때가 시작보다 앞입니다";
    return { summary, location, description, ...eventWhen(date, time, endDate, endTime, 60) };
  }

  // An expense after applying the keys present in a request body to `base`. Fields the kind doesn't use are cleared
  // (정기 has no date and is never "spent"; 예정 has no day of the month).
  function expenseFields(b: Record<string, unknown>, base: ExpenseFields): ExpenseFields | string {
    const e = { ...base };
    if ("kind" in b) {
      if (!EXPENSE_KINDS.includes(b.kind as string)) return "종류가 올바르지 않습니다";
      e.kind = b.kind as string;
    }
    if ("title" in b) e.title = str(b.title, 200);
    if (!e.title) return "이름을 입력해 주세요";
    if ("amount" in b) {
      if (typeof b.amount !== "number" || !Number.isSafeInteger(b.amount) || b.amount < 0 || b.amount > 1e12) return "금액이 올바르지 않습니다";
      e.amount = b.amount;
    }
    if ("day" in b) {
      if (b.day !== null && b.day !== "" && !(Number.isInteger(b.day) && (b.day as number) >= 1 && (b.day as number) <= 31)) return "날짜(1~31일)가 올바르지 않습니다";
      e.day = b.day === null || b.day === "" ? null : (b.day as number);
    }
    if ("date" in b) {
      const v = str(b.date, 10);
      if (v && !isDate(v)) return "날짜가 올바르지 않습니다";
      e.date = v || null;
    }
    if ("note" in b) e.note = str(b.note, 2000);
    if ("done" in b) e.done = b.done === true ? 1 : 0;
    if (e.kind === "정기") Object.assign(e, { date: null, done: 0 });
    else e.day = null;
    return e;
  }

  // A course after applying the keys present in a request body to `base`.
  function courseFields(b: Record<string, unknown>, base: CourseFields): CourseFields | string {
    const c = { ...base };
    if ("semester_id" in b) {
      if (!db.getSemester(Number(b.semester_id))) return "학기를 찾을 수 없습니다";
      c.semester_id = Number(b.semester_id);
    }
    if ("name" in b) c.name = str(b.name, 100);
    if (!c.name) return "과목명을 입력해 주세요";
    if ("professor" in b) c.professor = str(b.professor, 100);
    if ("credits" in b) {
      const n = b.credits;
      if (typeof n !== "number" || !(n >= 0 && n <= 30) || !Number.isInteger(n * 2)) return "학점이 올바르지 않습니다";
      c.credits = n;
    }
    if ("grade" in b) {
      if (!GRADES.includes(b.grade as string)) return "성적이 올바르지 않습니다";
      c.grade = b.grade as string;
    }
    if ("major" in b) c.major = b.major === true ? 1 : 0;
    if ("color" in b) {
      if (b.color !== "" && !COURSE_COLORS.includes(b.color as string)) return "색이 올바르지 않습니다";
      c.color = b.color as string;
    }
    if ("times" in b) {
      if (!Array.isArray(b.times) || b.times.length > 14) return "수업 시간이 올바르지 않습니다";
      const times: CourseTime[] = [];
      for (const t of b.times as Record<string, unknown>[]) {
        const start = str(t?.start, 5), end = str(t?.end, 5);
        if (!(Number.isInteger(t?.day) && (t.day as number) >= 0 && (t.day as number) <= 6) || !isTime(start) || !isTime(end) || start >= end) return "수업 시간이 올바르지 않습니다(요일, 시작 < 끝)";
        times.push({ day: t.day as number, start, end, room: str(t.room, 100) });
      }
      c.times = times;
    }
    return c;
  }

  // A class change after applying the keys present in a request body to `base`. 휴강 has no new time or place.
  function classChangeFields(b: Record<string, unknown>, base: ClassChangeFields): ClassChangeFields | string {
    const c = { ...base };
    if ("course" in b) c.course = str(b.course, 100);
    if (!c.course) return "과목을 입력해 주세요";
    if ("kind" in b) {
      if (!CLASS_CHANGE_KINDS.includes(b.kind as string)) return "종류가 올바르지 않습니다";
      c.kind = b.kind as string;
    }
    if ("date" in b) c.date = str(b.date, 10);
    if ("from_date" in b) c.from_date = str(b.from_date, 10) || null;
    if (!c.date) return "날짜를 입력해 주세요";
    if (!isDate(c.date) || (c.from_date && !isDate(c.from_date))) return "날짜가 올바르지 않습니다";
    for (const k of ["start", "end"] as const) {
      if (!(k in b)) continue;
      const v = str(b[k], 5);
      if (v && !isTime(v)) return "시간이 올바르지 않습니다";
      c[k] = v || null;
    }
    if ("place" in b) c.place = str(b.place, 100);
    if ("note" in b) c.note = str(b.note, 2000);
    if (c.kind === "휴강") Object.assign(c, { start: null, end: null, place: "" });
    if (c.start && c.end && c.start >= c.end) return "끝나는 시간이 시작보다 늦어야 합니다";
    return c;
  }

  // Validates exam fields from a request body. Only keys present in the body are returned.
  function examFields(b: Record<string, unknown>): Partial<ExamFields> | string {
    const out: Partial<ExamFields> = {};
    if ("title" in b) {
      out.title = str(b.title, 200);
      if (!out.title) return "시험 이름을 입력해 주세요";
    }
    if ("course" in b) out.course = str(b.course, 100);
    if ("place" in b) out.place = str(b.place, 200);
    if ("scope" in b) out.scope = str(b.scope, 5000);
    if ("note" in b) out.note = str(b.note, 5000);
    if ("color" in b) {
      out.color = str(b.color, 10);
      if (!EXAM_COLORS.includes(out.color)) return "색이 올바르지 않습니다";
    }
    if ("date" in b) {
      const v = str(b.date, 10);
      if (v && !isDate(v)) return "날짜가 올바르지 않습니다";
      out.date = v || null;
    }
    if ("time" in b) {
      const v = str(b.time, 5);
      if (v && !isTime(v)) return "시간이 올바르지 않습니다";
      out.time = v || null;
    }
    return out;
  }

  // Validates study fields from a request body. Only keys present in the body are returned.
  function studyFields(b: Record<string, unknown>): Partial<StudyFields & { done: number }> | string {
    const out: Partial<StudyFields & { done: number }> = {};
    if ("date" in b) {
      const v = str(b.date, 10);
      if (v && !isDate(v)) return "날짜가 올바르지 않습니다";
      out.date = v || null;
    }
    if ("course" in b) out.course = str(b.course, 100);
    if ("title" in b) {
      out.title = str(b.title, 200);
      if (!out.title) return "공부할 내용을 입력해 주세요";
    }
    if ("done" in b) out.done = b.done ? 1 : 0;
    return out;
  }

  // The portfolio page. mine = the owner's own view (/admin/portfolio): private items too, marked 개인용.
  function renderPortfolio(mine = false): Response {
    const profile = db.profile();
    const photo = db.listAttachments("profile", 0).find((f) => RASTER.test(f.mime));
    const items = db.listItems({ publicOnly: !mine });
    const sections = db
      .listSections()
      .map((s) => ({ ...s, items: items.filter((i) => i.section_id === s.id) }))
      .filter((s) => s.items.length);
    const fileUrl = (f: AttachedFile) => `/portfolio/file/${f.id}`;
    const chips = (it: PortfolioItem) =>
      [mine && !it.public ? "개인용" : "", it.period]
        .filter(Boolean)
        .map((t) => `<span class="chip">${escapeHtml(t)}</span>`)
        .join("");
    let n = 0;
    // A linked note, folded under the item. Its pictures are served like the item's files (see isPublicFile).
    const more = (it: PortfolioItem) => {
      const note = it.note_id ? db.getNote(it.note_id) : null;
      const html = note ? noteHtml(note.blocks, (id) => `/portfolio/file/${id}`) : "";
      return html.trim() ? `<details class="work-more"><summary>자세히 보기</summary><div class="note-body">${html}</div></details>` : "";
    };
    // The first attached file is the cover: the image itself, or Drive's preview of a video or PDF.
    const item = (it: PortfolioItem) => {
      const files = db.listAttachments("portfolio", it.id);
      const [cover, ...rest] = files;
      const num = String(++n).padStart(2, "0");
      const title = it.link ? `<a href="${escapeHtml(it.link)}" target="_blank" rel="noopener">${escapeHtml(it.title)}</a>` : escapeHtml(it.title);
      const extras = rest.length
        ? `<div class="extras">${rest
            .map((f) =>
              RASTER.test(f.mime)
                ? `<a class="extra-img" href="${fileUrl(f)}" target="_blank" rel="noopener"><img src="${fileUrl(f)}" alt="" loading="lazy"></a>`
                : `<a class="extra-file" href="${fileUrl(f)}">${escapeHtml(downloadName(f))} ↓</a>`,
            )
            .join("")}</div>`
        : "";
      const info = `<span class="work-num">${num}</span>
<h3>${title}</h3>
<div class="chips">${chips(it)}</div>
${it.summary ? `<p class="work-summary">${escapeHtml(it.summary)}</p>` : ""}
${it.body ? `<p class="work-note">${escapeHtml(it.body)}</p>` : ""}${extras}
${it.link ? `<a class="work-link" href="${escapeHtml(it.link)}" target="_blank" rel="noopener">LINK ↗</a>` : ""}${more(it)}`;
      const entry = `<li class="reveal"><div>${info}</div></li>`;
      if (!cover) return { cover: false, entry, card: entry, tile: `<article class="tile reveal"><div class="tile-media no-thumb"><span class="work-media-label">${escapeHtml(it.title)}</span></div>${info}</article>` };
      const src = RASTER.test(cover.mime) ? fileUrl(cover) : `/thumb/${cover.id}`;
      const media = (cls: string) =>
        `<a class="${cls}" href="${escapeHtml(it.link || fileUrl(cover))}" target="_blank" rel="noopener"><img src="${src}" alt="" loading="lazy"><span class="work-media-label">${escapeHtml(it.title)}</span></a>`;
      return {
        cover: true,
        entry,
        card: `<article class="work reveal">
${media("work-media")}
<div class="work-info">${info}</div>
</article>`,
        tile: `<article class="tile reveal">${media("tile-media")}${info}</article>`,
      };
    };
    // Each section in its layout: big cards (items without a picture as rows under them), small cards side by side, or rows only.
    const body = sections
      .map((s) => {
        n = 0; // numbers start over in each section
        const rendered = s.items.map(item);
        let inner: string;
        if (s.layout === "grid") inner = `<div class="tiles">${rendered.map((r) => r.tile).join("\n")}</div>`;
        else if (s.layout === "list") inner = `<ul class="entries">${rendered.map((r) => r.entry).join("\n")}</ul>`;
        else {
          const entries = rendered.filter((r) => !r.cover).map((r) => r.entry).join("\n");
          inner = rendered.filter((r) => r.cover).map((r) => r.card).join("\n") + (entries ? `<ul class="entries">${entries}</ul>` : "");
        }
        return `<section class="works layout-${escapeHtml(s.layout)}" id="s${s.id}">
<h2 class="section-title reveal">${escapeHtml(s.title)} <sup>${s.items.length}</sup></h2>
${inner}
</section>`;
      })
      .join("\n");
    const about = profile.about || photo;
    const nav = [about ? `<a href="#about">ABOUT</a>` : "", ...sections.map((s) => `<a href="#s${s.id}">${escapeHtml(s.title)}</a>`), `<a href="#contact">CONTACT</a>`].join("");
    const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(profile.name || "kacarong")} — ${mine ? "내 포트폴리오" : "포트폴리오"}</title>
${mine ? `<meta name="robots" content="noindex">` : ""}<link rel="stylesheet" href="/static/site.css?v=${v}"></head><body>
${mine ? `<p class="mine-bar">내 포트폴리오 — 나만 보는 화면입니다. 개인용 표시가 없는 것만 kacarong.kr에 나옵니다. <a href="/admin#portfolio">고치러 가기</a></p>` : ""}
<header class="top">
<a class="brand" href="/">${escapeHtml((profile.name || "kacarong").toUpperCase())} <span class="spark">✳</span></a>
<nav>${nav}</nav>
<span class="clock" id="clock"></span>
<span class="year">© ${new Date().getFullYear()}</span>
</header>
<section class="hero">
<h1 class="hero-title"><span class="line"><span>${escapeHtml(profile.name || "kacarong")}</span></span><span class="line"><span>portfolio</span></span></h1>
<p class="hero-copy reveal">${profile.headline ? escapeHtml(profile.headline) : "기록하고, 만들고, 남깁니다.<br>작업한 것들을 여기에 모아 둡니다."}</p>
${sections.length ? `<a class="hero-cta" href="#s${sections[0]!.id}">VIEW <span class="spark">✳</span></a>` : ""}
</section>
${about ? `<section class="about" id="about"><h2 class="section-title reveal">ABOUT</h2><div class="about-row reveal">${photo ? `<img class="about-photo" src="${fileUrl(photo)}" alt="">` : ""}${profile.about ? `<p class="about-text">${escapeHtml(profile.about)}</p>` : ""}</div></section>` : ""}
${body || `<section class="works"><p class="empty reveal">${mine ? "아직 포트폴리오에 넣은 항목이 없습니다. 작업공간의 포트폴리오에서 항목을 추가해 보세요." : "아직 공개된 항목이 없습니다."}</p></section>`}
<footer class="foot" id="contact">
<p class="foot-big reveal">LET'S MAKE<br>SOMETHING.</p>
<div class="foot-row"><span>KACARONG.KR</span><a href="/privacy">PRIVACY</a><a href="/admin">WORKSPACE</a></div>
</footer>
<script src="/static/site.js?v=${v}" defer></script>
</body></html>`;
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  // Streams a file from Drive. Only INLINE_TYPES are shown in place; the rest is a download.
  // Ranges pass through so a video can seek. The file is never treated as a page of this site.
  async function sendFile(f: FileRow, req: Request, download: boolean, cache: string): Promise<Response> {
    const inline = !download && INLINE_TYPES.test(f.mime);
    const drive = await google.download(f.drive_id, req.headers.get("Range"));
    const h = new Headers({
      "Content-Type": inline ? (f.mime === "text/plain" ? "text/plain; charset=utf-8" : f.mime) : "application/octet-stream",
      "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", downloadName(f)),
      "Accept-Ranges": "bytes",
      "Cache-Control": cache,
      // Chrome's PDF viewer does not open under a sandbox policy; a PDF can't reach this site's pages anyway.
      "Content-Security-Policy": inline && f.mime === "application/pdf" ? "default-src 'none'; object-src 'self'; style-src 'unsafe-inline'" : "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    });
    for (const k of ["Content-Length", "Content-Range"]) {
      const val = drive.headers.get(k);
      if (val) h.set(k, val);
    }
    return new Response(drive.body, { status: drive.status, headers: h });
  }

  async function thumb(id: number, req: Request): Promise<Response> {
    const f = db.getFile(id);
    const pub = !!f && db.isPublicFile(f.id);
    if (!f || (!pub && !isAdmin(req))) return new Response("not found", { status: 404 });
    const path = join(thumbDir, f.drive_id);
    if (!existsSync(path)) {
      const t = await google.thumbnail(f.drive_id);
      if (!t) return new Response("no thumbnail", { status: 404 }); // Drive may still be generating it
      await Bun.write(path, t.bytes);
    }
    return new Response(Bun.file(path), {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": pub ? "public, max-age=86400" : "private, max-age=86400" },
    });
  }

  async function api(req: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    const method = req.method;

    if (path === "/api/me" && method === "GET") {
      const s = session(req);
      return json({
        admin: !!s,
        googleEnabled: cfg.googleEnabled,
        knownDevice: !!cookies(req).login_hint, // the owner signed in on this browser before, so auto login may try
        driveConnected: !!db.getSetting("refresh_token"),
        calendarConnected: !!db.getSetting("refresh_token") && google.calendarGranted(),
        calendarWrite: !!db.getSetting("refresh_token") && google.calendarWriteGranted(),
        categories: CATEGORIES,
        taskKinds: TASK_KINDS,
        taskCategories: TASK_CATEGORIES,
        maxFileSize: MAX_FILE_SIZE,
      });
    }
    const s = session(req);
    if (!s) return json({ error: "로그인이 필요합니다" }, 401);
    // Session cookies are SameSite=Lax; also refuse state changes that don't come from this site.
    // Browsers always send Origin on POST/PATCH/DELETE from fetch.
    if (method !== "GET" && req.headers.get("Origin") !== origin) {
      return json({ error: "잘못된 요청 출처" }, 403);
    }

    if (path === "/api/today" && method === "GET") {
      const d = today();
      db.queueStudies(d);
      db.promoteLaterTasks(d);
      const open = db.listTasks({ done: false, to: addDays(d, UPCOMING_DAYS) });
      return json({
        date: d,
        overdue: open.filter((t) => t.due_date! < d),
        today: open.filter((t) => t.due_date === d),
        upcoming: open.filter((t) => t.due_date! > d && t.kind === "과제"),
        doneToday: db.listTasks({ done: true, doneOn: d }),
        exams: db.listExams({ from: d, to: addDays(d, EXAM_DAYS) }),
      });
    }

    // Google Calendar events of the days [from, to]. Only Google: 할 일·과제·시험 stay off the calendar (user, 2026-11-24).
    // A Google failure returns google = "error" and the reason.
    if (path === "/api/calendar" && method === "GET") {
      const from = url.searchParams.get("from") ?? "";
      const to = url.searchParams.get("to") ?? "";
      if (!isDate(from) || !isDate(to) || to < from || to > addDays(from, CALENDAR_MAX_DAYS - 1)) return json({ error: "날짜 범위가 올바르지 않습니다" }, 400);
      if (!cfg.googleEnabled || !db.getSetting("refresh_token")) return json({ events: [], google: "off" });
      if (!google.calendarGranted()) return json({ events: [], google: "need_consent" });
      const write = google.calendarWriteGranted(); // events can be made and changed here
      try {
        const cals = await google.calendarList();
        const calendars = cals
          .filter((c) => c.accessRole === "owner" || c.accessRole === "writer")
          .map((c) => ({ id: c.id, name: c.summary ?? c.id, primary: !!c.primary }));
        const events = (await google.events(`${from}T00:00:00+09:00`, `${addDays(to, 1)}T00:00:00+09:00`, cals))
          .map(calendarItem)
          .filter((e) => e.endDate >= from && e.startDate <= to);
        return json({ events, google: "ok", write, calendars });
      } catch (e) {
        if (!(e instanceof GoogleError)) throw e;
        return json({ events: [], google: "error", error: e.message, write, calendars: [] });
      }
    }

    // 알림: what to be told about, the devices that get Web Push, and the notifications pages show themselves.
    if (path === "/api/notify" && method === "GET") {
      return json({ settings: notifier.settings(), publicKey: notifier.publicKey(), devices: db.pushSubs().length });
    }
    if (path === "/api/notify" && method === "PUT") {
      const b = await body(req);
      const morning = str(b.morning, 5);
      if (morning && !isTime(morning)) return json({ error: "시간이 올바르지 않습니다" }, 400);
      notifier.setSettings({ morning, homework: b.homework === true, exam: b.exam === true, classes: b.classes === true });
      return json(notifier.settings());
    }
    if (path === "/api/notify/test" && method === "POST") {
      await notifier.deliver({ title: "kacarong 알림 테스트", body: "이 기기에서 알림을 받을 수 있습니다.", url: "/admin" });
      return json({ ok: true });
    }
    if (path === "/api/push/subscribe" && method === "POST") {
      const b = await body(req);
      const endpoint = str(b.endpoint, 1000);
      const keys = (b.keys ?? {}) as Record<string, unknown>;
      const p256dh = str(keys.p256dh, 200);
      const auth = str(keys.auth, 100);
      // Push services are https; plain http only on this machine (tests).
      const ep = URL.canParse(endpoint) ? new URL(endpoint) : null;
      if (!ep || !(ep.protocol === "https:" || (ep.protocol === "http:" && ["localhost", "127.0.0.1"].includes(ep.hostname))) || Buffer.from(p256dh, "base64url").length !== 65 || Buffer.from(auth, "base64url").length !== 16) {
        return json({ error: "알림 구독 정보가 올바르지 않습니다" }, 400);
      }
      db.addPushSub({ endpoint, p256dh, auth });
      return json({ ok: true }, 201);
    }
    if (path === "/api/push/unsubscribe" && method === "POST") {
      db.deletePushSub(str((await body(req)).endpoint, 1000));
      return json({ ok: true });
    }
    // Pages that show notifications themselves (the PC program) ask for the ones after the last they saw.
    if (path === "/api/notifications" && method === "GET") {
      const after = Number(url.searchParams.get("after") ?? "-1");
      return json(db.notificationsAfter(Number.isInteger(after) ? after : -1));
    }

    // Making, changing and deleting Google Calendar events from the calendar screen.
    if (path.startsWith("/api/calendar/") && !(cfg.googleEnabled && db.getSetting("refresh_token") && google.calendarWriteGranted())) {
      return json({ error: "구글 캘린더 쓰기 권한이 없습니다. 캘린더 화면에서 권한을 받아 주세요." }, 403);
    }
    if (path === "/api/calendar/events" && method === "POST") {
      const b = await body(req);
      const f = eventFields(b);
      if (typeof f === "string") return json({ error: f }, 400);
      const calendarId = str(b.calendarId, 300);
      if (!calendarId) return json({ error: "캘린더를 골라 주세요" }, 400);
      return json({ id: await google.insertEvent(calendarId, f) }, 201);
    }
    const ev = path.match(/^\/api\/calendar\/events\/([^/]+)$/);
    if (ev && (method === "PATCH" || method === "DELETE")) {
      const calendarId = url.searchParams.get("calendar") ?? "";
      if (!calendarId) return json({ error: "캘린더를 골라 주세요" }, 400);
      const eventId = decodeURIComponent(ev[1]!);
      if (method === "DELETE") {
        await google.deleteEvent(calendarId, eventId);
        return json({ ok: true });
      }
      const f = eventFields(await body(req));
      if (typeof f === "string") return json({ error: f }, 400);
      await google.patchEvent(calendarId, eventId, f);
      return json({ ok: true });
    }

    if (path === "/api/tasks" && method === "GET") {
      const q = url.searchParams;
      const done = q.get("done");
      const from = q.get("from") ?? "";
      const to = q.get("to") ?? "";
      if ((from && !isDate(from)) || (to && !isDate(to))) return json({ error: "날짜가 올바르지 않습니다" }, 400);
      db.queueStudies(today());
      db.promoteLaterTasks(today());
      return json(db.listTasks({ done: done === null ? undefined : done === "1", from, to, kind: q.get("kind") ?? undefined }));
    }

    if (path === "/api/tasks" && method === "POST") {
      const f = taskFields(await body(req));
      if (typeof f === "string") return json({ error: f }, 400);
      if (!f.title) return json({ error: "제목을 입력해 주세요" }, 400);
      return json(db.insertTask({ kind: "할 일", category: "", course: "", due_date: null, due_time: null, note: "", ...f, title: f.title }), 201);
    }

    // 시험: every exam (soonest first; the client splits off past ones).
    if (path === "/api/exams" && method === "GET") return json({ date: today(), exams: db.listExams() });

    if (path === "/api/exams" && method === "POST") {
      const f = examFields(await body(req));
      if (typeof f === "string") return json({ error: f }, 400);
      if (!f.title) return json({ error: "시험 이름을 입력해 주세요" }, 400);
      return json(db.insertExam({ course: "", date: null, time: null, place: "", scope: "", note: "", color: "", ...f, title: f.title }), 201);
    }

    const em = path.match(/^\/api\/exams\/(\d+)$/);
    if (em) {
      const exam = db.getExam(Number(em[1]));
      if (!exam) return json({ error: "시험을 찾을 수 없습니다" }, 404);
      if (method === "PATCH") {
        const f = examFields(await body(req));
        if (typeof f === "string") return json({ error: f }, 400);
        db.updateExam(exam.id, f);
        return json(db.getExam(exam.id));
      }
      if (method === "DELETE") {
        db.deleteExam(exam.id);
        return json({ ok: true });
      }
    }

    // 지출: money that goes out every month (정기) and money to spend later (예정). The client sorts and sums.
    if (path === "/api/expenses" && method === "GET") return json({ date: today(), expenses: db.listExpenses() });

    if (path === "/api/expenses" && method === "POST") {
      const e = expenseFields(await body(req), { kind: "정기", title: "", amount: 0, day: null, date: null, note: "", done: 0 });
      if (typeof e === "string") return json({ error: e }, 400);
      return json(db.insertExpense(e), 201);
    }

    const xm = path.match(/^\/api\/expenses\/(\d+)$/);
    if (xm) {
      const cur: ExpenseRow | null = db.getExpense(Number(xm[1]));
      if (!cur) return json({ error: "지출을 찾을 수 없습니다" }, 404);
      if (method === "PATCH") {
        const e = expenseFields(await body(req), cur);
        if (typeof e === "string") return json({ error: e }, 400);
        return json(db.updateExpense(cur.id, e));
      }
      if (method === "DELETE") {
        db.deleteExpense(cur.id);
        return json({ ok: true });
      }
    }

    // 시간표·학점 계산기: every semester and course at once (a handful); the client lays them out and does the math.
    // The semester going on now is always there (3~8월 = 1학기, 9~2월 = 2학기).
    if (path === "/api/timetable" && method === "GET") {
      const d = today();
      const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7));
      const current = m >= 3 && m <= 8 ? { year: y, term: "1" } : { year: m <= 2 ? y - 1 : y, term: "2" };
      db.insertSemester(current.year, current.term);
      return json({ date: d, current, semesters: db.listSemesters(), courses: db.listCourses() });
    }
    if (path === "/api/semesters" && method === "POST") {
      const b = await body(req);
      if (!(Number.isInteger(b.year) && (b.year as number) >= 2000 && (b.year as number) <= 2100) || !TERMS.includes(b.term as string)) return json({ error: "학기가 올바르지 않습니다" }, 400);
      const s = db.insertSemester(b.year as number, b.term as string);
      return s ? json(s, 201) : json({ error: "이미 있는 학기입니다" }, 409);
    }
    const sem = path.match(/^\/api\/semesters\/(\d+)$/);
    if (sem && method === "DELETE") {
      if (!db.getSemester(Number(sem[1]))) return json({ error: "학기를 찾을 수 없습니다" }, 404);
      db.deleteSemester(Number(sem[1]));
      return json({ ok: true });
    }
    if (path === "/api/courses" && method === "POST") {
      const b = await body(req);
      if (!("semester_id" in b)) return json({ error: "학기를 찾을 수 없습니다" }, 400);
      const c = courseFields(b, { semester_id: 0, name: "", professor: "", credits: 3, grade: "", major: 0, color: "", times: [] });
      if (typeof c === "string") return json({ error: c }, 400);
      return json(db.insertCourse(c), 201);
    }
    const cm = path.match(/^\/api\/courses\/(\d+)$/);
    if (cm) {
      // The body first: the row is read after the last await, so a save that landed meanwhile is not undone.
      const b = method === "PATCH" ? await body(req) : {};
      const cur = db.getCourse(Number(cm[1]));
      if (!cur) return json({ error: "과목을 찾을 수 없습니다" }, 404);
      if (method === "PATCH") {
        const c = courseFields(b, cur);
        if (typeof c === "string") return json({ error: c }, 400);
        return json(db.updateCourse(cur.id, c));
      }
      if (method === "DELETE") {
        db.deleteCourse(cur.id);
        return json({ ok: true });
      }
    }

    // 수업일정: classes that moved, were added or cancelled. Notified the evening before (src/notify.ts).
    if (path === "/api/class-changes" && method === "GET") return json({ date: today(), changes: db.listClassChanges() });
    if (path === "/api/class-changes" && method === "POST") {
      const c = classChangeFields(await body(req), { course: "", kind: "변경", date: "", start: null, end: null, place: "", from_date: null, note: "" });
      if (typeof c === "string") return json({ error: c }, 400);
      return json(db.insertClassChange(c), 201);
    }
    const ccm = path.match(/^\/api\/class-changes\/(\d+)$/);
    if (ccm) {
      // The body first: the row is read after the last await, so a save that landed meanwhile is not undone.
      const b = method === "PATCH" ? await body(req) : {};
      const cur = db.getClassChange(Number(ccm[1]));
      if (!cur) return json({ error: "수업일정을 찾을 수 없습니다" }, 404);
      if (method === "PATCH") {
        const c = classChangeFields(b, cur);
        if (typeof c === "string") return json({ error: c }, 400);
        return json(db.updateClassChange(cur.id, c));
      }
      if (method === "DELETE") {
        db.deleteClassChange(cur.id);
        return json({ ok: true });
      }
    }

    // 공부: each course's list of what to study, each line with the day to do it (or none yet). Not tasks, so the
    // calendar never sees it; on its day it also becomes a 오늘 할 일 task in 할 일·과제 (db.queueStudies, run
    // when that list or the today screen is read).
    // Courses taken off the 공부 tab (시간표 courses that need no study); writing a line for one brings it back.
    const hiddenCourses = (): string[] => JSON.parse(db.getSetting("study_hidden_courses") ?? "[]");
    const setHiddenCourses = (list: string[]) => db.setSetting("study_hidden_courses", JSON.stringify(list));
    if (path === "/api/studies" && method === "GET") return json({ date: today(), studies: db.listStudies(), hidden: hiddenCourses() });

    if (path === "/api/studies" && method === "POST") {
      const f = studyFields(await body(req));
      if (typeof f === "string") return json({ error: f }, 400);
      if (!f.title) return json({ error: "공부할 내용을 입력해 주세요" }, 400);
      const study = db.insertStudy({ course: "", date: null, ...f, title: f.title }, today());
      setHiddenCourses(hiddenCourses().filter((c) => c !== study.course));
      return json(study, 201);
    }

    // 과목 삭제: the course's lines go (and their 할 일 with them) and its card stays off the tab.
    if (path === "/api/studies/course" && method === "DELETE") {
      const course = str((await body(req)).course, 100);
      for (const s of db.listStudies()) if (s.course === course) db.deleteStudy(s.id);
      if (course && !hiddenCourses().includes(course)) setHiddenCourses([...hiddenCourses(), course]);
      return json({ ok: true });
    }

    const stm = path.match(/^\/api\/studies\/(\d+)$/);
    if (stm) {
      const study = db.getStudy(Number(stm[1]));
      if (!study) return json({ error: "공부를 찾을 수 없습니다" }, 404);
      if (method === "PATCH") {
        const f = studyFields(await body(req));
        if (typeof f === "string") return json({ error: f }, 400);
        db.updateStudy(study.id, f, today());
        if (f.course !== undefined) setHiddenCourses(hiddenCourses().filter((c) => c !== f.course));
        return json(db.getStudy(study.id));
      }
      if (method === "DELETE") {
        db.deleteStudy(study.id);
        return json({ ok: true });
      }
    }

    const tm = path.match(/^\/api\/tasks\/(\d+)$/);
    if (tm) {
      const t = db.getTask(Number(tm[1]));
      if (!t) return json({ error: "할 일을 찾을 수 없습니다" }, 404);
      if (method === "PATCH") {
        const b = await body(req);
        const f = taskFields(b);
        if (typeof f === "string") return json({ error: f }, 400);
        const patch: Parameters<Db["updateTask"]>[1] = f;
        if ("done" in b) {
          const done = b.done === true;
          patch.done = done ? 1 : 0;
          if (done !== !!t.done) patch.done_at = done ? today() : null;
        }
        db.updateTask(t.id, patch);
        if (t.study_id && patch.done !== undefined) db.updateStudy(t.study_id, { done: patch.done }, today()); // checked off on the 공부 tab too
        const after = db.getTask(t.id)!;
        // A task from a note is its todo block: write the change back to the block. Taking the
        // date off turns it back into a plain checkbox in the note, and the task goes away.
        if (after.note_id && after.block_id) {
          db.editNoteBlock(after.note_id, after.block_id, (bl) => {
            const rest = bl.text.split("\n").slice(1);
            const next: Block = { ...bl, text: [after.title, ...rest].join("\n"), checked: !!after.done };
            // A formatted block keeps its runs in step with the new title (formatting of the unchanged part stays).
            delete next.rich;
            const rich = bl.rich && richOrNone(editRuns(bl.rich, bl.text, next.text));
            if (rich) next.rich = rich;
            delete next.date;
            delete next.time;
            if (after.due_date) next.date = after.due_date;
            if (after.due_date && after.due_time) next.time = after.due_time;
            return next;
          }, today());
          notion.noteSaved(after.note_id);
        }
        return json(db.getTask(t.id) ?? { ...after, due_date: null, due_time: null });
      }
      if (method === "DELETE") {
        if (t.note_id && t.block_id) {
          db.editNoteBlock(t.note_id, t.block_id, () => null, today()); // also removes the task
          notion.noteSaved(t.note_id);
        }
        db.deleteTask(t.id);
        return json({ ok: true });
      }
    }

    if (path === "/api/notes" && method === "GET") {
      return json(db.listNotes(url.searchParams.get("q")?.trim() || undefined));
    }

    if (path === "/api/notes" && method === "POST") {
      const b = await body(req);
      const parent = b.parent_id === undefined || b.parent_id === null ? null : db.getNote(Number(b.parent_id));
      if (b.parent_id !== undefined && b.parent_id !== null && !parent) return json({ error: "상위 노트를 찾을 수 없습니다" }, 404);
      // Under a Notion page (the parent note's page, or the page chosen for new notes) it becomes a Notion page too.
      const notionParent = parent ? notion.pageOf(parent.id)?.page_id : db.getSetting("notion_root");
      const n = db.insertNote(str(b.title, 200), [{ id: crypto.randomUUID().slice(0, 8), type: "p", text: "" }], today());
      if (parent) db.setNoteParent(n.id, parent.id);
      let warning: string | undefined;
      if (notionParent && notion.status().connected) {
        try {
          await notion.createPage(n.id, notionParent);
        } catch (e) {
          if (!(e instanceof NotionError)) throw e;
          warning = "노션에 페이지를 만들지 못해 이 사이트에만 있는 노트로 만들었습니다: " + e.message;
        }
      }
      return json({ ...db.getNote(n.id)!, warning }, 201);
    }

    const nm = path.match(/^\/api\/notes\/(\d+)$/);
    if (nm) {
      const n = db.getNote(Number(nm[1]));
      if (!n) return json({ error: "노트를 찾을 수 없습니다" }, 404);
      const link = notion.pageOf(n.id);
      if (method === "GET") {
        notion.noteOpened(n.id);
        // Where the page and the pages its blocks point to are, so the editor can link to them.
        const pages = new Map(db.notionPages().map((l) => [l.page_id, l.note_id]));
        const links: Record<string, { id: number; title: string }> = {};
        const add = (page: string | undefined) => {
          const id = page && pages.get(page);
          const target = id ? db.getNote(id) : null;
          if (target) links[page!] = { id: target.id, title: target.title };
        };
        for (const bl of n.blocks) {
          add(bl.page);
          for (const r of bl.rich ?? []) add((r.m?.page as { id?: string } | undefined)?.id);
        }
        return json({ ...n, links, notion: link ? { url: notion.notionUrl(link.page_id), props: link.props, readOnly: notion.isPartial(link.page_id) } : null });
      }
      if (method === "PUT") {
        const b = await body(req);
        const blocks = cleanBlocks(b.blocks);
        if (typeof blocks === "string") return json({ error: blocks }, 400);
        if (!Number.isInteger(b.version)) return json({ error: "노트 버전이 없습니다" }, 400);
        if (!db.saveNote(n.id, b.version as number, str(b.title, 200), blocks, today())) {
          return json({ error: "다른 곳에서 이 노트가 바뀌었습니다", version: n.version }, 409);
        }
        notion.noteSaved(n.id);
        const saved = db.getNote(n.id)!;
        return json({ ok: true, version: saved.version, updated_at: saved.updated_at });
      }
      if (method === "DELETE") {
        // A Notion page goes to Notion's trash with the pages under it, so their notes go too.
        if (link && notion.status().connected) {
          try {
            await notion.archive(link.page_id);
          } catch (e) {
            if (!(e instanceof NotionError)) throw e;
            return json({ error: "노션에서 지우지 못해 노트를 그대로 두었습니다: " + e.message }, 502);
          }
          for (const id of db.noteDescendants(n.id).reverse()) {
            const l = notion.pageOf(id);
            if (l) db.deleteNotionPage(l.page_id);
            db.deleteNote(id);
          }
        }
        db.deleteNote(n.id);
        return json({ ok: true });
      }
    }

    // Notion: GET = connected or not and how the sync goes; PUT { token } connects (the token is kept to keep syncing),
    // DELETE disconnects (notes stay); POST /api/notion/sync runs a full pass now; PUT /api/notion/root { pageId } picks
    // the Notion page new top-level notes are made under (null = new top-level notes stay on this site).
    if (path === "/api/notion" && method === "GET") {
      const root = db.getSetting("notion_root");
      const tops = db.notionPages().filter((l) => !l.parent && db.getNote(l.note_id)).map((l) => ({ id: l.page_id, title: db.getNote(l.note_id)!.title || "제목 없음" }));
      return json({ ...notion.status(), root, pages: tops });
    }
    if (path === "/api/notion" && method === "PUT") {
      const token = str((await body(req)).token, 300);
      if (!token) return json({ error: "노션 토큰을 넣어 주세요" }, 400);
      try {
        await notion.connect(token);
      } catch (e) {
        if (!(e instanceof NotionError)) throw e;
        return json({ error: e.message }, e.status === 401 ? 400 : 502);
      }
      return json(notion.status());
    }
    if (path === "/api/notion" && method === "DELETE") {
      notion.disconnect();
      return json(notion.status());
    }
    if (path === "/api/notion/sync" && method === "POST") {
      if (!notion.status().connected) return json({ error: "노션이 연결되어 있지 않습니다" }, 400);
      void notion.fullSync();
      return json(notion.status(), 202);
    }
    if (path === "/api/notion/root" && method === "PUT") {
      const id = (await body(req)).pageId;
      if (id === null) db.raw.query("DELETE FROM settings WHERE key = 'notion_root'").run();
      else if (typeof id === "string" && db.notionPage(id)) db.setSetting("notion_root", id);
      else return json({ error: "노션 페이지를 찾을 수 없습니다" }, 404);
      return json({ root: db.getSetting("notion_root") });
    }

    // Cloud files attached to a note, a task or a portfolio item: ?note=ID, ?task=ID, ?portfolio=ID,
    // or the portfolio profile: ?profile=0 (POST: { note | task | portfolio | profile, fileId }).
    if (path === "/api/attachments" && (method === "GET" || method === "POST")) {
      const b = method === "POST" ? await body(req) : Object.fromEntries(url.searchParams);
      const target = ATTACH_TARGETS.find((t) => t in b);
      const targetId = Number(target && b[target]);
      if (!target || !Number.isInteger(targetId)) return json({ error: "붙일 곳을 지정해 주세요" }, 400);
      const found = { note: () => db.getNote(targetId), task: () => db.getTask(targetId), portfolio: () => db.getItem(targetId), profile: () => targetId === 0 }[target]();
      if (!found) return json({ error: { note: "노트", task: "할 일", portfolio: "포트폴리오 항목", profile: "프로필" }[target] + "을(를) 찾을 수 없습니다" }, 404);
      if (method === "GET") return json(db.listAttachments(target, targetId));
      const file = db.getFile(Number(b.fileId));
      if (!file) return json({ error: "파일을 찾을 수 없습니다" }, 404);
      if (!db.addAttachment(target, targetId, file.id)) return json({ error: "이미 붙인 파일입니다" }, 409);
      return json(db.listAttachments(target, targetId), 201);
    }

    const am = path.match(/^\/api\/attachments\/(\d+)$/);
    if (am && method === "DELETE") {
      if (!db.deleteAttachment(Number(am[1]))) return json({ error: "첨부를 찾을 수 없습니다" }, 404);
      return json({ ok: true });
    }

    // folder=ID or root lists one folder; without it, every file (the picker). A search always looks everywhere.
    if (path === "/api/files" && method === "GET") {
      const q = url.searchParams.get("q") ?? undefined;
      const fp = url.searchParams.get("folder");
      const folder = q || fp === null ? undefined : fp === "root" ? null : Number(fp);
      if (typeof folder === "number" && !db.getFolder(folder)) return json({ error: "폴더를 찾을 수 없습니다" }, 404);
      return json(db.listFiles({ q, category: url.searchParams.get("category") ?? undefined, folder }));
    }

    // What the cloud uses (its own files only) and how much room the Drive behind it has.
    if (path === "/api/quota" && method === "GET") {
      return json({ ...db.usage(), drive: await google.quota() });
    }

    if (path === "/api/folders" && method === "GET") return json(db.listFolders());

    if (path === "/api/folders" && method === "POST") {
      const b = await body(req);
      const name = folderName(b.name);
      const parent = folderRef(b.parentId);
      if (!name) return json({ error: "폴더 이름을 넣어 주세요" }, 400);
      if (parent === undefined) return json({ error: "상위 폴더를 찾을 수 없습니다" }, 404);
      if (db.folderNameTaken(parent, name)) return json({ error: "같은 이름의 폴더가 이미 있습니다" }, 409);
      const driveId = await google.createFolder(name, await driveFolder(parent));
      return json(db.insertFolder(name, parent, driveId), 201);
    }

    const fm = path.match(/^\/api\/folders\/(\d+)$/);
    if (fm) {
      const folder = db.getFolder(Number(fm[1]));
      if (!folder) return json({ error: "폴더를 찾을 수 없습니다" }, 404);
      if (method === "PATCH") {
        const b = await body(req);
        const name = "name" in b ? folderName(b.name) : folder.name;
        const parent = "parentId" in b ? folderRef(b.parentId) : folder.parent_id;
        if (!name) return json({ error: "폴더 이름을 넣어 주세요" }, 400);
        if (parent === undefined) return json({ error: "옮길 폴더를 찾을 수 없습니다" }, 404);
        if (parent !== null && db.folderTree(folder.id).includes(parent)) return json({ error: "폴더를 자기 안으로 옮길 수 없습니다" }, 400);
        if (db.folderNameTaken(parent, name, folder.id)) return json({ error: "같은 이름의 폴더가 이미 있습니다" }, 409);
        if (name !== folder.name) await google.rename(folder.drive_id, name);
        if (parent !== folder.parent_id) await google.move(folder.drive_id, await driveFolder(folder.parent_id), await driveFolder(parent));
        db.updateFolder(folder.id, name, parent);
        return json(db.getFolder(folder.id));
      }
      // Everything inside goes to the Drive trash with the folder (30 days to get it back there).
      if (method === "DELETE") {
        await google.trash(folder.drive_id);
        for (const f of db.deleteFolders(db.folderTree(folder.id))) rmSync(join(thumbDir, f.drive_id), { force: true });
        return json({ ok: true });
      }
    }

    if (path === "/api/uploads" && method === "POST") {
      const b = await body(req);
      const name = str(b.name, 255);
      const size = Number(b.size);
      const folder = folderRef(b.folderId);
      if (!name) return json({ error: "파일 이름이 없습니다" }, 400);
      if (!Number.isInteger(size) || size <= 0) return json({ error: "파일 크기가 올바르지 않습니다" }, 400);
      if (size >= MAX_FILE_SIZE) return json({ error: "1GB 미만 파일만 올릴 수 있습니다" }, 413);
      if (folder === undefined) return json({ error: "폴더를 찾을 수 없습니다" }, 404);
      const uploadUrl = await google.startUpload({ name, size, mimeType: str(b.mimeType, 255), origin, parent: await driveFolder(folder) });
      return json({ uploadUrl });
    }

    if (path === "/api/uploads/status" && method === "POST") {
      const b = await body(req);
      const size = Number(b.size);
      if (!Number.isInteger(size) || size <= 0) return json({ error: "파일 크기가 올바르지 않습니다" }, 400);
      return json(await google.uploadStatus(str(b.uploadUrl, 2000), size));
    }

    if (path === "/api/files" && method === "POST") {
      const b = await body(req);
      const driveId = str(b.driveId, 200);
      const folder = folderRef(b.folderId);
      if (!driveId) return json({ error: "driveId가 없습니다" }, 400);
      if (folder === undefined) return json({ error: "폴더를 찾을 수 없습니다" }, 404);
      if (db.getFileByDriveId(driveId)) return json({ error: "이미 등록된 파일입니다" }, 409);
      const d = await google.getFile(driveId);
      if (d.trashed || !d.parents?.includes(await driveFolder(folder))) return json({ error: "파일함 폴더의 파일이 아닙니다" }, 400);
      const row = db.insertFile({
        drive_id: d.id,
        name: d.name,
        title: str(b.title, 200) || d.name,
        mime: d.mimeType,
        size: Number(d.size ?? 0),
        category: category(b.category),
        tags: str(b.tags),
        note: str(b.note, 2000),
        folder_id: folder,
      });
      return json(row, 201);
    }

    const m = path.match(/^\/api\/files\/(\d+)(\/content)?$/);
    if (m) {
      const f = db.getFile(Number(m[1]));
      if (!f) return json({ error: "파일을 찾을 수 없습니다" }, 404);

      // Opens (images, video, audio, PDF, plain text) or downloads the file through this site.
      if (m[2] && method === "GET") return sendFile(f, req, url.searchParams.has("download"), "private, no-store");

      if (!m[2] && method === "PATCH") {
        const b = await body(req);
        const patch: Parameters<Db["updateFile"]>[1] = {};
        if ("title" in b) patch.title = str(b.title, 200) || f.name;
        if ("category" in b) patch.category = category(b.category);
        if ("tags" in b) patch.tags = str(b.tags);
        if ("note" in b) patch.note = str(b.note, 2000);
        if ("folderId" in b) {
          const folder = folderRef(b.folderId);
          if (folder === undefined) return json({ error: "옮길 폴더를 찾을 수 없습니다" }, 404);
          if (folder !== f.folder_id) await google.move(f.drive_id, await driveFolder(f.folder_id), await driveFolder(folder));
          patch.folder_id = folder;
        }
        if (patch.title !== undefined && patch.title !== f.title) await google.rename(f.drive_id, downloadName({ title: patch.title, name: f.name }));
        db.updateFile(f.id, patch);
        return json(db.getFile(f.id));
      }

      if (!m[2] && method === "DELETE") {
        await google.trash(f.drive_id);
        db.deleteFile(f.id);
        rmSync(join(thumbDir, f.drive_id), { force: true });
        return json({ ok: true });
      }
    }

    // Portfolio: the profile, sections and items. Files go on items and the profile through /api/attachments.
    if (path === "/api/portfolio" && method === "GET") {
      const items = db.listItems();
      return json({
        profile: db.profile(),
        photo: db.listAttachments("profile", 0),
        sections: db.listSections().map((s) => ({
          ...s,
          items: items.filter((i) => i.section_id === s.id).map((i) => ({ ...i, files: db.listAttachments("portfolio", i.id) })),
        })),
      });
    }

    if (path === "/api/portfolio/profile" && method === "PUT") {
      const b = await body(req);
      db.setProfile({ name: str(b.name, 100), headline: str(b.headline, 200), about: str(b.about, 5000) });
      return json(db.profile());
    }

    if (path === "/api/portfolio/sections" && method === "POST") {
      const title = str((await body(req)).title, 100);
      if (!title) return json({ error: "섹션 이름을 넣어 주세요" }, 400);
      return json(db.insertSection(title), 201);
    }

    const sm = path.match(/^\/api\/portfolio\/(sections|items)\/(\d+)(\/move)?$/);
    if (sm) {
      const kind = sm[1] === "sections" ? "section" : "item";
      const id = Number(sm[2]);
      if (!(kind === "section" ? db.getSection(id) : db.getItem(id))) return json({ error: kind === "section" ? "섹션을 찾을 수 없습니다" : "항목을 찾을 수 없습니다" }, 404);
      if (sm[3] && method === "POST") {
        const dir = (await body(req)).dir;
        if (dir !== -1 && dir !== 1) return json({ error: "dir은 -1이나 1" }, 400);
        return json({ moved: db.move(kind, id, dir) });
      }
      if (!sm[3] && method === "PATCH") {
        const b = await body(req);
        if (kind === "section") {
          if ("layout" in b) {
            if (!SECTION_LAYOUTS.includes(b.layout as string)) return json({ error: "보기 방식이 올바르지 않습니다" }, 400);
            db.setSectionLayout(id, b.layout as string);
          }
          if ("title" in b) {
            const title = str(b.title, 100);
            if (!title) return json({ error: "섹션 이름을 넣어 주세요" }, 400);
            db.renameSection(id, title);
          }
          return json(db.getSection(id));
        }
        const f = itemFields(b);
        if (typeof f === "string") return json({ error: f }, 400);
        db.updateItem(id, f);
        return json(db.getItem(id));
      }
      if (!sm[3] && method === "DELETE") {
        if (kind === "section") db.deleteSection(id);
        else db.deleteItem(id);
        return json({ ok: true });
      }
    }

    if (path === "/api/portfolio/items" && method === "POST") {
      const f = itemFields(await body(req));
      if (typeof f === "string") return json({ error: f }, 400);
      if (f.section_id === undefined) return json({ error: "섹션을 골라 주세요" }, 400);
      if (!f.title) return json({ error: "제목을 입력해 주세요" }, 400);
      return json(db.insertItem({ period: "", summary: "", body: "", link: "", public: 0, ...f, section_id: f.section_id, title: f.title }), 201);
    }

    return json({ error: "없는 API" }, 404);
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/" && req.method === "GET") return renderPortfolio();
    if (path === "/admin/portfolio" && req.method === "GET") return isAdmin(req) ? renderPortfolio(true) : new Response(null, { status: 302, headers: { Location: "/admin" } });

    // Files of the portfolio: open to anyone when on the profile or a public item, otherwise only to the owner.
    const pf = path.match(/^\/portfolio\/file\/(\d+)$/);
    if (pf && req.method === "GET") {
      const f = db.getFile(Number(pf[1]));
      const pub = !!f && db.isPublicFile(f.id);
      if (!f || (!pub && !isAdmin(req))) return new Response("not found", { status: 404 });
      return sendFile(f, req, !RASTER.test(f.mime), pub ? "public, max-age=600" : "private, no-store");
    }
    // A 파일함 file by a signed link (see fileLink): what Notion shows for a picture or file put in a note here.
    const fl = path.match(/^\/f\/(\d+)\/([\w-]{22})(\/[^/]*)?$/);
    if (fl && req.method === "GET") {
      const f = db.getFile(Number(fl[1]));
      if (!f || !linkOk(f.id, fl[2]!)) return new Response("not found", { status: 404 });
      return sendFile(f, req, false, "private, max-age=3600");
    }
    if (path === "/admin" && req.method === "GET") return new Response(adminHtml, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    if (path === "/privacy" && req.method === "GET") return new Response(Bun.file(join(PUBLIC_DIR, "privacy.html")));
    // The service worker that shows Web Push notifications. It must sit at the top to cover /admin, and never be cached long.
    if (path === "/sw.js" && req.method === "GET") return new Response(Bun.file(join(PUBLIC_DIR, "sw.js")), { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" } });
    // The Android app (android/) opens full screen only if this lists its signing key.
    if (path === "/.well-known/assetlinks.json" && req.method === "GET") return new Response(Bun.file(join(PUBLIC_DIR, "assetlinks.json")));

    const t = path.match(/^\/thumb\/(\d+)$/);
    if (t && req.method === "GET") return thumb(Number(t[1]), req);

    if (path.startsWith("/static/") && req.method === "GET") {
      const name = path.slice("/static/".length);
      // Subfolders (vendor/) are fine, but no part may start with "." (so no "..").
      if (!/^[\w-][\w.-]*(\/[\w-][\w.-]*)*$/.test(name)) return new Response("not found", { status: 404 });
      const file = Bun.file(join(PUBLIC_DIR, name));
      return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
    }

    if (path.startsWith("/auth/") && path !== "/auth/logout" && !cfg.googleEnabled) return new Response("not found", { status: 404 });

    if (path === "/auth/login" && req.method === "GET") {
      const state = crypto.randomUUID();
      return new Response(null, {
        status: 302,
        headers: {
          // Ask for the full grant only when none is saved or it lacks a scope (e.g. calendar, added later).
          // The account hint comes only from this browser's own cookie (set after the owner signed in here),
          // never from ADMIN_EMAIL, so a stranger opening /admin never sees the owner's email.
          Location: google.authRedirect(state, !db.getSetting("refresh_token") || !google.calendarGranted() || !google.calendarWriteGranted(), cookies(req).login_hint ?? ""),
          // One cookie per attempt, so two tabs signing in at once don't overwrite each other's state.
          "Set-Cookie": setCookie(`oauth_state_${state}`, "1", 600),
        },
      });
    }

    if (path === "/auth/callback" && req.method === "GET") {
      const state = url.searchParams.get("state") ?? "";
      const stateCookie = `oauth_state_${state}`;
      const validState = /^[0-9a-f-]{36}$/.test(state) && cookies(req)[stateCookie] === "1";
      const headers = new Headers({ Location: "/admin" });
      if (validState) headers.append("Set-Cookie", setCookie(stateCookie, "", 0));
      // Cancelled on Google's page, an unknown or expired attempt, or a used link opened again:
      // no session from it, back to /admin (the login screen, or the workspace if already signed in).
      const code = url.searchParams.get("code");
      if (url.searchParams.get("error") || !validState || !code) return new Response(null, { status: 302, headers });
      const r = await google.exchangeCode(code);
      if (!r.emailVerified || !cfg.adminEmail || r.email !== cfg.adminEmail) return new Response("관리자 계정이 아닙니다.", { status: 403 });
      // A plain sign-in gets no refresh token; keep the saved grant then.
      if (r.tokens.refresh_token) google.saveTokens(r.tokens);
      startSession(r.email, headers);
      headers.append("Set-Cookie", setCookie("login_hint", r.email, 365 * 86400));
      return new Response(null, { status: 302, headers });
    }

    if (path === "/auth/logout" && req.method === "POST") {
      const sid = cookies(req).sid;
      if (sid) db.deleteSession(sid);
      // Logging out also forgets the account hint, so a shared computer doesn't keep the email.
      const headers = new Headers();
      headers.append("Set-Cookie", setCookie("sid", "", 0));
      headers.append("Set-Cookie", setCookie("login_hint", "", 0));
      return new Response(null, { status: 204, headers });
    }

    if (path.startsWith("/api/")) return api(req, url);
    return new Response("not found", { status: 404 });
  }

  // Only our own files may run or load; the browser talks to nothing but this site and Google's upload endpoint.
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' https: data: blob:", // pictures in notes may come from anywhere Notion links to; blob: for 파일 편집기 previews
    "media-src 'self' https:",
    `connect-src 'self' ${google.apiOrigin}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");

  function withSecurityHeaders(res: Response, path: string): Response {
    const h = res.headers;
    if (!h.has("Content-Security-Policy")) h.set("Content-Security-Policy", csp); // a served file brings a stricter one
    h.set("X-Frame-Options", "DENY");
    h.set("X-Content-Type-Options", "nosniff");
    h.set("Referrer-Policy", "strict-origin-when-cross-origin");
    h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (secure) h.set("Strict-Transport-Security", "max-age=31536000");
    // Private pages and data must never sit in Cloudflare's or the browser's cache.
    if (path === "/admin" || path.startsWith("/admin/") || path.startsWith("/api/") || path.startsWith("/auth/")) h.set("Cache-Control", "no-store");
    return res;
  }

  return Object.assign(async function fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    try {
      const res = await handle(req);
      return withSecurityHeaders(res, path);
    } catch (e) {
      if (e instanceof GoogleError) return withSecurityHeaders(json({ error: e.message }, e.status === 401 || e.status === 400 ? e.status : 502), path);
      console.error(e);
      return withSecurityHeaders(json({ error: "서버 오류" }, 500), path);
    }
  }, { notion, moveNotionCopies, notifier, backup });
}

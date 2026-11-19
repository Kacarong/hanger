import { createHash } from "node:crypto";
import { mkdirSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ATTACH_TARGETS, BLOCK_TYPES, CATEGORIES, TASK_KINDS, type Block, type Db, type FileRow, type TaskFields } from "./db";
import { GoogleError, type CalendarEvent, type Google } from "./google";
import { passwordProblem } from "./password";

export const MAX_FILE_SIZE = 1024 ** 3; // files must be under 1GB
const SESSION_DAYS = 30;
const CALENDAR_MAX_DAYS = 62; // longest range /api/calendar serves (a 6-week month grid is 42)
const UPCOMING_DAYS = 3; // 과제 due within this many days show up on the today screen
const NOTE_MAX_BLOCKS = 3000;
const NOTE_MAX_TEXT = 500_000; // characters across all blocks of a note
const LOGIN_FAIL_LIMIT = 5; // password failures allowed per LOGIN_FAIL_WINDOW
const LOGIN_FAIL_WINDOW = 15 * 60_000;
const PUBLIC_DIR = join(import.meta.dir, "..", "public");

export type AppConfig = {
  baseUrl: string; // e.g. https://kacarong.kr
  adminEmail: string; // only used by Google login
  dataDir: string;
  googleEnabled: boolean; // false until the OAuth client is configured
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
  if (e.start.date) {
    startDate = e.start.date;
    endDate = e.end.date ? addDays(e.end.date, -1) : startDate; // Google's all-day end date is exclusive
    time = null;
  } else {
    const start = new Date(e.start.dateTime!);
    startDate = seoulDate(start);
    endDate = seoulDate(new Date(new Date(e.end.dateTime ?? e.start.dateTime!).getTime() - 1)); // ending at 00:00 doesn't touch that day
    time = hm(start);
  }
  if (endDate < startDate) endDate = startDate;
  return { id: e.id, title: e.summary || "(제목 없음)", startDate, endDate, time, link: e.htmlLink ?? "", calendar: e.calendar, color: /^#[0-9a-f]{6}$/i.test(e.color) ? e.color : "" };
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

function publicView(f: FileRow) {
  return { id: f.id, title: f.title, category: f.category, tags: f.tags, note: f.note, mime: f.mime, link: f.web_view_link };
}

// Hash of everything in public/. Static URLs carry it as ?v= so a deploy never pairs new HTML
// with an old /static/ file still sitting in Cloudflare's cache (it keeps them for hours).
function assetVersion(): string {
  const h = createHash("sha256");
  for (const name of readdirSync(PUBLIC_DIR).sort()) h.update(name).update(readFileSync(join(PUBLIC_DIR, name)));
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

  // Sessions are only ever created for the owner (password or the admin Google account).
  // The subject is "password" or the Google email.
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
  let loginFailures: number[] = [];

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

  // Validates task fields from a request body. Only keys present in the body are returned.
  function taskFields(b: Record<string, unknown>): Partial<TaskFields> | string {
    const out: Partial<TaskFields> = {};
    if ("kind" in b) {
      if (!TASK_KINDS.includes(b.kind as string)) return "종류가 올바르지 않습니다";
      out.kind = b.kind as string;
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

  // Validates a note's block list and keeps only the fields each block type uses.
  function noteBlocks(v: unknown): Block[] | string {
    if (!Array.isArray(v) || v.length > NOTE_MAX_BLOCKS) return "블록 목록이 올바르지 않습니다";
    const ids = new Set<string>();
    let total = 0;
    const out: Block[] = [];
    for (const raw of v) {
      const b = (raw ?? {}) as Record<string, unknown>;
      if (typeof b.id !== "string" || !/^[\w-]{1,40}$/.test(b.id) || ids.has(b.id)) return "블록 id가 올바르지 않습니다";
      if (!BLOCK_TYPES.includes(b.type as string)) return "블록 종류가 올바르지 않습니다";
      const text = b.type === "divider" || typeof b.text !== "string" ? "" : b.text;
      total += text.length;
      if (total > NOTE_MAX_TEXT) return "노트가 너무 깁니다";
      ids.add(b.id);
      const block: Block = { id: b.id, type: b.type as string, text };
      if (b.type === "todo") {
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
      out.push(block);
    }
    return out;
  }

  async function renderPublic(): Promise<Response> {
    const items = db.listFiles({ publicOnly: true });
    const num = (i: number) => String(i + 1).padStart(2, "0");
    const chips = (f: FileRow) =>
      [f.category, ...f.tags.split(",")]
        .map((t) => t.trim())
        .filter(Boolean)
        .map((t) => `<span class="chip">${escapeHtml(t)}</span>`)
        .join("");
    const works = items
      .map(
        (f, i) => `<article class="work reveal">
<a class="work-media" href="${escapeHtml(f.web_view_link)}" target="_blank" rel="noopener">
<img src="/thumb/${f.id}" alt="" loading="lazy"><span class="work-media-label">${escapeHtml(f.title)}</span></a>
<div class="work-info"><span class="work-num">${num(i)}</span>
<h3><a href="${escapeHtml(f.web_view_link)}" target="_blank" rel="noopener">${escapeHtml(f.title)}</a></h3>
<div class="chips">${chips(f)}</div>
${f.note ? `<p class="work-note">${escapeHtml(f.note)}</p>` : ""}</div>
</article>`,
      )
      .join("\n");
    const index = items
      .map(
        (f, i) => `<li class="reveal"><span class="idx-num">${"✳".repeat(Math.min(i + 1, 4))}</span>
<div><h3>${escapeHtml(f.title)}</h3><div class="chips">${chips(f)}</div></div></li>`,
      )
      .join("\n");
    const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>kacarong — 포트폴리오</title>
<link rel="stylesheet" href="/static/site.css?v=${v}"></head><body>
<header class="top">
<a class="brand" href="/">KACARONG <span class="spark">✳</span></a>
<nav><a href="#work">WORK</a><a href="#index">INDEX</a><a href="#contact">CONTACT</a></nav>
<span class="clock" id="clock"></span>
<span class="year">© ${new Date().getFullYear()}</span>
</header>
<section class="hero">
<h1 class="hero-title"><span class="line"><span>kacarong</span></span><span class="line"><span>portfolio</span></span></h1>
<p class="hero-copy reveal">기록하고, 만들고, 남깁니다.<br>작업한 것들을 여기에 모아 둡니다.</p>
<a class="hero-cta" href="#work">VIEW WORK <span class="spark">✳</span></a>
</section>
<section class="works" id="work">
<h2 class="section-title reveal">SELECTED<br>WORK <sup>${items.length}</sup></h2>
${items.length ? works : `<p class="empty reveal">아직 공개된 작업이 없습니다.</p>`}
</section>
${items.length ? `<section class="index" id="index"><h2 class="section-title reveal">INDEX</h2><ul>${index}</ul></section>` : ""}
<footer class="foot" id="contact">
<p class="foot-big reveal">LET'S MAKE<br>SOMETHING.</p>
<div class="foot-row"><span>KACARONG.KR</span><a href="/privacy">PRIVACY</a><a href="/admin">WORKSPACE</a></div>
</footer>
<script src="/static/site.js?v=${v}" defer></script>
</body></html>`;
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  async function thumb(id: number, req: Request): Promise<Response> {
    const f = db.getFile(id);
    if (!f || (!f.public && !isAdmin(req))) return new Response("not found", { status: 404 });
    const path = join(thumbDir, f.drive_id);
    if (!existsSync(path)) {
      const t = await google.thumbnail(f.drive_id);
      if (!t) return new Response("no thumbnail", { status: 404 }); // Drive may still be generating it
      await Bun.write(path, t.bytes);
    }
    return new Response(Bun.file(path), {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": f.public ? "public, max-age=86400" : "private, max-age=86400" },
    });
  }

  async function api(req: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    const method = req.method;

    if (path === "/api/me" && method === "GET") {
      const s = session(req);
      return json({
        admin: !!s,
        loginMethod: s ? (s.subject === "password" ? "password" : "google") : null,
        googleEnabled: cfg.googleEnabled,
        driveConnected: !!db.getSetting("refresh_token"),
        calendarConnected: !!db.getSetting("refresh_token") && google.calendarGranted(),
        categories: CATEGORIES,
        taskKinds: TASK_KINDS,
        maxFileSize: MAX_FILE_SIZE,
      });
    }
    if (path === "/api/public" && method === "GET") {
      return json(db.listFiles({ publicOnly: true }).map(publicView));
    }

    const s = session(req);
    if (!s) return json({ error: "로그인이 필요합니다" }, 401);
    // Session cookies are SameSite=Lax; also refuse state changes that don't come from this site.
    // Browsers always send Origin on POST/PATCH/DELETE from fetch.
    if (method !== "GET" && req.headers.get("Origin") !== origin) {
      return json({ error: "잘못된 요청 출처" }, 403);
    }

    // Changing the password logs out every other session. A password session must prove the
    // current password; a Google session already proved who it is.
    if (path === "/api/password" && method === "POST") {
      const hashBefore = db.getSetting("password_hash"); // read before any await, see the re-check below
      const b = await body(req);
      const next = typeof b.password === "string" ? b.password : "";
      const problem = passwordProblem(next);
      if (problem) return json({ error: problem }, 400);
      if (s.subject === "password") {
        const current = typeof b.current === "string" ? b.current : "";
        if (!hashBefore || !current || !(await Bun.password.verify(current, hashBefore))) return json({ error: "지금 비밀번호가 틀렸습니다" }, 403);
      }
      const newHash = await Bun.password.hash(next);
      // While we were hashing, another device may have changed the password and logged this one out.
      // Check again and write with no await in between, so a stale request can't undo that change.
      if (!db.getSession(s.id)) return json({ error: "로그인이 풀렸습니다. 다시 로그인해 주세요." }, 401);
      if (db.getSetting("password_hash") !== hashBefore) return json({ error: "다른 곳에서 비밀번호가 방금 바뀌었습니다. 다시 시도해 주세요." }, 409);
      db.setSetting("password_hash", newHash);
      db.deleteOtherSessions(s.id);
      return json({ ok: true });
    }

    if (path === "/api/today" && method === "GET") {
      const d = today();
      const open = db.listTasks({ done: false, to: addDays(d, UPCOMING_DAYS) });
      return json({
        date: d,
        overdue: open.filter((t) => t.due_date! < d),
        today: open.filter((t) => t.due_date === d),
        upcoming: open.filter((t) => t.due_date! > d && t.kind === "과제"),
        doneToday: db.listTasks({ done: true, doneOn: d }),
      });
    }

    // Tasks with a date in [from, to] plus Google Calendar events of those days.
    // A Google failure still returns the tasks, with google = "error" and the reason.
    if (path === "/api/calendar" && method === "GET") {
      const from = url.searchParams.get("from") ?? "";
      const to = url.searchParams.get("to") ?? "";
      if (!isDate(from) || !isDate(to) || to < from || to > addDays(from, CALENDAR_MAX_DAYS - 1)) return json({ error: "날짜 범위가 올바르지 않습니다" }, 400);
      const tasks = db.listTasks({ from, to });
      if (!cfg.googleEnabled || !db.getSetting("refresh_token")) return json({ tasks, events: [], google: "off" });
      if (!google.calendarGranted()) return json({ tasks, events: [], google: "need_consent" });
      try {
        const events = await google.events(`${from}T00:00:00+09:00`, `${addDays(to, 1)}T00:00:00+09:00`);
        return json({ tasks, events: events.map(calendarItem).filter((e) => e.endDate >= from && e.startDate <= to), google: "ok" });
      } catch (e) {
        if (!(e instanceof GoogleError)) throw e;
        return json({ tasks, events: [], google: "error", error: e.message });
      }
    }

    if (path === "/api/tasks" && method === "GET") {
      const q = url.searchParams;
      const done = q.get("done");
      const from = q.get("from") ?? "";
      const to = q.get("to") ?? "";
      if ((from && !isDate(from)) || (to && !isDate(to))) return json({ error: "날짜가 올바르지 않습니다" }, 400);
      return json(db.listTasks({ done: done === null ? undefined : done === "1", from, to, kind: q.get("kind") ?? undefined }));
    }

    if (path === "/api/tasks" && method === "POST") {
      const f = taskFields(await body(req));
      if (typeof f === "string") return json({ error: f }, 400);
      if (!f.title) return json({ error: "제목을 입력해 주세요" }, 400);
      return json(db.insertTask({ kind: "할 일", course: "", due_date: null, due_time: null, note: "", ...f, title: f.title }), 201);
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
        const after = db.getTask(t.id)!;
        // A task from a note is its todo block: write the change back to the block. Taking the
        // date off turns it back into a plain checkbox in the note, and the task goes away.
        if (after.note_id && after.block_id) {
          db.editNoteBlock(after.note_id, after.block_id, (bl) => {
            const rest = bl.text.split("\n").slice(1);
            const next: Block = { ...bl, text: [after.title, ...rest].join("\n"), checked: !!after.done };
            delete next.date;
            delete next.time;
            if (after.due_date) next.date = after.due_date;
            if (after.due_date && after.due_time) next.time = after.due_time;
            return next;
          }, today());
        }
        return json(db.getTask(t.id) ?? { ...after, due_date: null, due_time: null });
      }
      if (method === "DELETE") {
        if (t.note_id && t.block_id) db.editNoteBlock(t.note_id, t.block_id, () => null, today()); // also removes the task
        db.deleteTask(t.id);
        return json({ ok: true });
      }
    }

    if (path === "/api/notes" && method === "GET") {
      return json(db.listNotes(url.searchParams.get("q")?.trim() || undefined));
    }

    if (path === "/api/notes" && method === "POST") {
      const b = await body(req);
      return json(db.insertNote(str(b.title, 200), [{ id: crypto.randomUUID().slice(0, 8), type: "p", text: "" }], today()), 201);
    }

    const nm = path.match(/^\/api\/notes\/(\d+)$/);
    if (nm) {
      const n = db.getNote(Number(nm[1]));
      if (!n) return json({ error: "노트를 찾을 수 없습니다" }, 404);
      if (method === "GET") return json(n);
      if (method === "PUT") {
        const b = await body(req);
        const blocks = noteBlocks(b.blocks);
        if (typeof blocks === "string") return json({ error: blocks }, 400);
        if (!Number.isInteger(b.version)) return json({ error: "노트 버전이 없습니다" }, 400);
        if (!db.saveNote(n.id, b.version as number, str(b.title, 200), blocks, today())) {
          return json({ error: "다른 곳에서 이 노트가 바뀌었습니다", version: n.version }, 409);
        }
        const saved = db.getNote(n.id)!;
        return json({ ok: true, version: saved.version, updated_at: saved.updated_at });
      }
      if (method === "DELETE") {
        db.deleteNote(n.id);
        return json({ ok: true });
      }
    }

    // Cloud files attached to a note or a task: ?note=ID or ?task=ID (POST: { note | task, fileId }).
    if (path === "/api/attachments" && (method === "GET" || method === "POST")) {
      const b = method === "POST" ? await body(req) : Object.fromEntries(url.searchParams);
      const target = ATTACH_TARGETS.find((t) => t in b);
      const targetId = Number(target && b[target]);
      if (!target || !Number.isInteger(targetId)) return json({ error: "노트나 할 일을 지정해 주세요" }, 400);
      if (!(target === "note" ? db.getNote(targetId) : db.getTask(targetId))) return json({ error: target === "note" ? "노트를 찾을 수 없습니다" : "할 일을 찾을 수 없습니다" }, 404);
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

    if (path === "/api/files" && method === "GET") {
      return json(db.listFiles({ q: url.searchParams.get("q") ?? undefined, category: url.searchParams.get("category") ?? undefined }));
    }

    if (path === "/api/quota" && method === "GET") {
      return json(await google.quota());
    }

    if (path === "/api/uploads" && method === "POST") {
      const b = await body(req);
      const name = str(b.name, 255);
      const size = Number(b.size);
      if (!name) return json({ error: "파일 이름이 없습니다" }, 400);
      if (!Number.isInteger(size) || size <= 0) return json({ error: "파일 크기가 올바르지 않습니다" }, 400);
      if (size >= MAX_FILE_SIZE) return json({ error: "1GB 미만 파일만 올릴 수 있습니다" }, 413);
      const uploadUrl = await google.startUpload({ name, size, mimeType: str(b.mimeType, 255), origin });
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
      if (!driveId) return json({ error: "driveId가 없습니다" }, 400);
      if (db.getFileByDriveId(driveId)) return json({ error: "이미 등록된 파일입니다" }, 409);
      const d = await google.getFile(driveId);
      const root = await google.rootFolder();
      if (d.trashed || !d.parents?.includes(root)) return json({ error: "파일함 폴더의 파일이 아닙니다" }, 400);
      const row = db.insertFile({
        drive_id: d.id,
        name: d.name,
        title: str(b.title, 200) || d.name,
        mime: d.mimeType,
        size: Number(d.size ?? 0),
        category: category(b.category),
        tags: str(b.tags),
        note: str(b.note, 2000),
        web_view_link: d.webViewLink ?? "",
        web_content_link: d.webContentLink ?? "",
      });
      return json(row, 201);
    }

    const m = path.match(/^\/api\/files\/(\d+)(\/share|\/public)?$/);
    if (m) {
      const f = db.getFile(Number(m[1]));
      if (!f) return json({ error: "파일을 찾을 수 없습니다" }, 404);
      const action = m[2];

      if (!action && method === "PATCH") {
        const b = await body(req);
        const patch: Parameters<Db["updateFile"]>[1] = {};
        if ("title" in b) patch.title = str(b.title, 200) || f.name;
        if ("category" in b) patch.category = category(b.category);
        if ("tags" in b) patch.tags = str(b.tags);
        if ("note" in b) patch.note = str(b.note, 2000);
        db.updateFile(f.id, patch);
        return json(db.getFile(f.id));
      }

      if (!action && method === "DELETE") {
        await google.trash(f.drive_id);
        db.deleteFile(f.id);
        rmSync(join(thumbDir, f.drive_id), { force: true });
        return json({ ok: true });
      }

      if (action === "/share" && method === "POST") {
        const on = (await body(req)).shared === true;
        if (on) {
          await google.share(f.drive_id);
          db.updateFile(f.id, { shared: 1 });
        } else {
          await google.unshare(f.drive_id);
          db.updateFile(f.id, { shared: 0, public: 0 });
        }
        return json(db.getFile(f.id));
      }

      if (action === "/public" && method === "POST") {
        const on = (await body(req)).public === true;
        if (on && !f.shared) await google.share(f.drive_id); // public page links need anyone-with-link access
        db.updateFile(f.id, on ? { shared: 1, public: 1 } : { public: 0 });
        return json(db.getFile(f.id));
      }
    }

    return json({ error: "없는 API" }, 404);
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/" && req.method === "GET") return renderPublic();
    if (path === "/admin" && req.method === "GET") return new Response(adminHtml, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    if (path === "/privacy" && req.method === "GET") return new Response(Bun.file(join(PUBLIC_DIR, "privacy.html")));

    const t = path.match(/^\/thumb\/(\d+)$/);
    if (t && req.method === "GET") return thumb(Number(t[1]), req);

    if (path.startsWith("/static/") && req.method === "GET") {
      const name = path.slice("/static/".length);
      if (!/^[\w.-]+$/.test(name)) return new Response("not found", { status: 404 });
      const file = Bun.file(join(PUBLIC_DIR, name));
      return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
    }

    if (path === "/auth/password" && req.method === "POST") {
      if (req.headers.get("Origin") !== origin) return json({ error: "잘못된 요청 출처" }, 403);
      const t = Date.now();
      loginFailures = loginFailures.filter((x) => x > t - LOGIN_FAIL_WINDOW);
      if (loginFailures.length >= LOGIN_FAIL_LIMIT) return json({ error: "비밀번호를 여러 번 틀렸습니다. 15분 뒤에 다시 시도해 주세요." }, 429);
      // Count the attempt as a failure before any await, so parallel requests can't all slip past the limit.
      loginFailures.push(t);
      const hash = db.getSetting("password_hash");
      const password = (await body(req)).password;
      if (!hash || typeof password !== "string" || !password || !(await Bun.password.verify(password, hash))) {
        return json({ error: hash ? "비밀번호가 틀렸습니다" : "비밀번호가 아직 설정되지 않았습니다" }, 401);
      }
      // Right password, but one that is public or too short (the old default): don't let it in.
      if (passwordProblem(password)) {
        const how = cfg.googleEnabled ? "구글 계정으로 로그인한 뒤 왼쪽 아래 \"비밀번호 바꾸기\"에서" : "서버에서 bun run set-password로";
        return json({ error: `이 비밀번호는 안전하지 않아 더는 쓸 수 없습니다. ${how} 새 비밀번호를 정해 주세요.` }, 403);
      }
      // The password may have been changed while we were verifying; the old one must not open a session.
      if (db.getSetting("password_hash") !== hash) return json({ error: "비밀번호가 방금 바뀌었습니다. 새 비밀번호로 로그인해 주세요." }, 401);
      const i = loginFailures.indexOf(t);
      if (i >= 0) loginFailures.splice(i, 1); // it succeeded after all
      const headers = new Headers();
      startSession("password", headers);
      return new Response(null, { status: 204, headers });
    }

    if (path.startsWith("/auth/") && path !== "/auth/logout" && !cfg.googleEnabled) return new Response("not found", { status: 404 });

    if (path === "/auth/login" && req.method === "GET") {
      const state = crypto.randomUUID();
      return new Response(null, {
        status: 302,
        headers: {
          // Ask for the full grant only when none is saved or it lacks a scope (e.g. calendar, added later).
          Location: google.authRedirect(state, !db.getSetting("refresh_token") || !google.calendarGranted(), cfg.adminEmail),
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
      return new Response(null, { status: 302, headers });
    }

    if (path === "/auth/logout" && req.method === "POST") {
      const sid = cookies(req).sid;
      if (sid) db.deleteSession(sid);
      return new Response(null, { status: 204, headers: { "Set-Cookie": setCookie("sid", "", 0) } });
    }

    if (path.startsWith("/api/")) return api(req, url);
    return new Response("not found", { status: 404 });
  }

  // Only our own files may run or load; the browser talks to nothing but this site and Google's upload endpoint.
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self'",
    `connect-src 'self' ${google.apiOrigin}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");

  function withSecurityHeaders(res: Response, path: string): Response {
    const h = res.headers;
    h.set("Content-Security-Policy", csp);
    h.set("X-Frame-Options", "DENY");
    h.set("X-Content-Type-Options", "nosniff");
    h.set("Referrer-Policy", "strict-origin-when-cross-origin");
    h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (secure) h.set("Strict-Transport-Security", "max-age=31536000");
    // Private pages and data must never sit in Cloudflare's or the browser's cache.
    if (path === "/admin" || path.startsWith("/api/") || path.startsWith("/auth/")) h.set("Cache-Control", "no-store");
    return res;
  }

  return async function fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    try {
      return withSecurityHeaders(await handle(req), path);
    } catch (e) {
      if (e instanceof GoogleError) return withSecurityHeaders(json({ error: e.message }, e.status === 401 || e.status === 400 ? e.status : 502), path);
      console.error(e);
      return withSecurityHeaders(json({ error: "서버 오류" }, 500), path);
    }
  };
}

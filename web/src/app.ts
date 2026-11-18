import { mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CATEGORIES, TASK_KINDS, type Db, type FileRow, type TaskFields } from "./db";
import { GoogleError, type Google } from "./google";

export const MAX_FILE_SIZE = 1024 ** 3; // files must be under 1GB
const SESSION_DAYS = 30;
const UPCOMING_DAYS = 3; // 과제 due within this many days show up on the today screen
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

function isDate(v: string): boolean {
  const d = new Date(v + "T00:00:00Z");
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
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

export function createApp(cfg: AppConfig, db: Db, google: Google) {
  const origin = new URL(cfg.baseUrl).origin;
  const secure = cfg.baseUrl.startsWith("https://") ? "; Secure" : "";
  const thumbDir = join(cfg.dataDir, "thumbs");
  mkdirSync(thumbDir, { recursive: true });

  function setCookie(name: string, value: string, maxAgeSec: number) {
    return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
  }

  // Sessions are only ever created for the owner (password or the admin Google account).
  function isAdmin(req: Request): boolean {
    const sid = cookies(req).sid;
    return !!sid && !!db.getSession(sid);
  }

  function startSession(subject: string, headers: Headers) {
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
      if (v && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) return "시간이 올바르지 않습니다";
      out.due_time = v || null;
    }
    return out;
  }

  async function renderPublic(): Promise<Response> {
    const items = db.listFiles({ publicOnly: true });
    const cards = items
      .map(
        (f) => `<li><a href="${escapeHtml(f.web_view_link)}" target="_blank" rel="noopener">
<img src="/thumb/${f.id}" alt="" loading="lazy" onerror="this.remove()">
<strong>${escapeHtml(f.title)}</strong></a>
<div>${escapeHtml(f.category)}${f.tags ? " · " + escapeHtml(f.tags) : ""}</div>
${f.note ? `<p>${escapeHtml(f.note)}</p>` : ""}</li>`,
      )
      .join("\n");
    const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>kacarong 포트폴리오</title>
<link rel="stylesheet" href="/static/base.css"></head><body>
<h1>포트폴리오</h1>
${items.length ? `<ul class="grid">${cards}</ul>` : "<p>아직 공개된 작업이 없습니다.</p>"}
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
      return json({
        admin: isAdmin(req),
        googleEnabled: cfg.googleEnabled,
        driveConnected: !!db.getSetting("refresh_token"),
        categories: CATEGORIES,
        taskKinds: TASK_KINDS,
        maxFileSize: MAX_FILE_SIZE,
      });
    }
    if (path === "/api/public" && method === "GET") {
      return json(db.listFiles({ publicOnly: true }).map(publicView));
    }

    if (!isAdmin(req)) return json({ error: "로그인이 필요합니다" }, 401);
    // Session cookies are SameSite=Lax; also refuse state changes from other origins.
    if (method !== "GET" && req.headers.get("Origin") && req.headers.get("Origin") !== origin) {
      return json({ error: "잘못된 요청 출처" }, 403);
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
        return json(db.getTask(t.id));
      }
      if (method === "DELETE") {
        db.deleteTask(t.id);
        return json({ ok: true });
      }
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
    if (path === "/admin" && req.method === "GET") return new Response(Bun.file(join(PUBLIC_DIR, "admin.html")));

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
          Location: google.authRedirect(state, !db.getSetting("refresh_token")),
          "Set-Cookie": setCookie("oauth_state", state, 600),
        },
      });
    }

    if (path === "/auth/callback" && req.method === "GET") {
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      if (!state || state !== cookies(req).oauth_state || !code) return new Response("로그인 요청이 올바르지 않습니다. 다시 시도해 주세요.", { status: 400 });
      const r = await google.exchangeCode(code);
      if (!r.emailVerified || !cfg.adminEmail || r.email !== cfg.adminEmail) return new Response("관리자 계정이 아닙니다.", { status: 403 });
      google.saveTokens(r.tokens);
      const headers = new Headers({ Location: "/admin" });
      startSession(r.email, headers);
      headers.append("Set-Cookie", setCookie("oauth_state", "", 0));
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

  return async function fetch(req: Request): Promise<Response> {
    try {
      return await handle(req);
    } catch (e) {
      if (e instanceof GoogleError) return json({ error: e.message }, e.status === 401 || e.status === 400 ? e.status : 502);
      console.error(e);
      return json({ error: "서버 오류" }, 500);
    }
  };
}

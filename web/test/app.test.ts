import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { openDb } from "../src/db";
import { createGoogle } from "../src/google";

// A small stand-in for the Google OAuth + Drive endpoints the app uses.
type FakeFile = { id: string; name: string; mimeType: string; parents: string[]; trashed: boolean; anyone: boolean; bytes: number };
const drive = new Map<string, FakeFile>();
const uploads = new Map<string, { name: string; mimeType: string; parents: string[]; size: number; received: number; origin: string | null; fileId?: string }>();
let foldersCreated = 0;
let loginEmail = "owner@example.com";
const FULL_SCOPE = "openid email https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/calendar.readonly";
let grantedScope = FULL_SCOPE; // what the fake consent screen lets through
let lastPrompt: string | null = null; // like Google, a refresh token comes only from a consent screen
let calendarFails = false;
let grantRevoked = false; // the refresh token was revoked or expired at Google
const eventQueries: URLSearchParams[] = [];
let nextId = 1;
let fake: ReturnType<typeof Bun.serve>;

function idToken(email: string) {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc({ email, email_verified: true })}.sig`;
}

function fileJson(f: FakeFile) {
  return {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    size: String(f.bytes),
    parents: f.parents,
    trashed: f.trashed,
    webViewLink: `https://drive.example/view/${f.id}`,
    webContentLink: `https://drive.example/dl/${f.id}`,
    thumbnailLink: `${fake.url}thumbs/${f.id}`,
  };
}

beforeAll(() => {
  fake = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;
      if (p === "/token") {
        const form = new URLSearchParams(await req.text());
        if (form.get("grant_type") === "authorization_code" && form.get("code") !== "good-code") return new Response("bad code", { status: 400 });
        if (form.get("grant_type") === "refresh_token" && grantRevoked) return Response.json({ error: "invalid_grant" }, { status: 400 });
        const refresh = form.get("grant_type") === "authorization_code" && lastPrompt === "consent" ? { refresh_token: "rt" } : {};
        return Response.json({ access_token: "at", expires_in: 3600, ...refresh, id_token: idToken(loginEmail), scope: grantedScope });
      }
      if (p.startsWith("/thumbs/")) {
        if (req.headers.get("Authorization") !== "Bearer at") return new Response("no", { status: 403 });
        return new Response("PNGDATA", { headers: { "Content-Type": "image/png" } });
      }
      // Upload session URI, same shape as Google's: /upload/drive/v3/files?uploadType=resumable&upload_id=...
      if (p === "/upload/drive/v3/files" && req.method === "PUT") {
        const u = uploads.get(url.searchParams.get("upload_id")!)!;
        u.received += (await req.arrayBuffer()).byteLength;
        if (u.received < u.size) {
          // Google omits Range when it has no bytes yet.
          return new Response(null, { status: 308, headers: u.received ? { Range: `bytes=0-${u.received - 1}` } : {} });
        }
        if (!u.fileId) {
          const f: FakeFile = { id: `f${nextId++}`, name: u.name, mimeType: u.mimeType, parents: u.parents, trashed: false, anyone: false, bytes: u.size };
          drive.set(f.id, f);
          u.fileId = f.id;
        }
        return Response.json(fileJson(drive.get(u.fileId)!));
      }
      if (req.headers.get("Authorization") !== "Bearer at") return new Response("unauthorized", { status: 401 });

      if (p === "/upload/drive/v3/files" && req.method === "POST") {
        const meta = await req.json();
        const sid = `s${nextId++}`;
        uploads.set(sid, {
          name: meta.name,
          mimeType: req.headers.get("X-Upload-Content-Type")!,
          parents: meta.parents,
          size: Number(req.headers.get("X-Upload-Content-Length")),
          received: 0,
          origin: req.headers.get("Origin"),
        });
        return new Response(null, { headers: { Location: `${fake.url}upload/drive/v3/files?uploadType=resumable&upload_id=${sid}` } });
      }
      if (p === "/drive/v3/files" && req.method === "POST") {
        const meta = await req.json();
        foldersCreated++;
        await Bun.sleep(20); // widen the window for concurrent first uploads
        const f: FakeFile = { id: `folder${nextId++}`, name: meta.name, mimeType: meta.mimeType, parents: [], trashed: false, anyone: false, bytes: 0 };
        drive.set(f.id, f);
        return Response.json({ id: f.id });
      }
      if (p === "/calendar/v3/users/me/calendarList") {
        return Response.json({
          items: [
            { id: "me@example.com", summary: "내 캘린더", backgroundColor: "#9fe1e7", primary: true },
            { id: "ko#holiday@group.v.calendar.google.com", summary: "대한민국의 휴일", backgroundColor: "red;x", selected: true },
            { id: "hidden", summary: "꺼 둔 캘린더", backgroundColor: "#000000", selected: false },
          ],
        });
      }
      const cal = p.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events$/);
      if (cal) {
        if (calendarFails) return new Response("Calendar API has not been used in project", { status: 403 });
        eventQueries.push(url.searchParams);
        const id = decodeURIComponent(cal[1]!);
        const items =
          id === "me@example.com"
            ? [
                { id: "e1", summary: "새벽 회의", start: { dateTime: "2026-11-18T15:30:00Z" }, end: { dateTime: "2026-11-18T16:30:00Z" }, htmlLink: "https://cal.example/e1" },
                { id: "e2", summary: "전시 준비", start: { date: "2026-11-20" }, end: { date: "2026-11-23" } },
                { id: "e3", summary: "자정에 끝남", start: { dateTime: "2026-11-20T23:00:00+09:00" }, end: { dateTime: "2026-11-21T00:00:00+09:00" } },
                { id: "e4", summary: "취소됨", status: "cancelled", start: { date: "2026-11-19" }, end: { date: "2026-11-20" } },
              ]
            : id === "ko#holiday@group.v.calendar.google.com"
              ? [{ id: "h1", start: { date: "2026-11-25" }, end: { date: "2026-11-26" } }]
              : [{ id: "x", summary: "보이면 안 됨", start: { date: "2026-11-19" }, end: { date: "2026-11-20" } }];
        return Response.json({ items });
      }
      if (p === "/drive/v3/about") return Response.json({ storageQuota: { limit: String(400 * 1024 ** 3), usage: "1024", usageInDriveTrash: "0" } });

      const m = p.match(/^\/drive\/v3\/files\/([^/]+)(\/permissions(?:\/(.+))?)?$/);
      const f = m && drive.get(m[1]!);
      if (!f) return new Response("not found", { status: 404 });
      if (m![2] && req.method === "POST") {
        const body = await req.json();
        if (body.type !== "anyone" || body.role !== "reader") return new Response("bad", { status: 400 });
        f.anyone = true;
        return Response.json({ id: "anyoneWithLink" });
      }
      if (m![3] === "anyoneWithLink" && req.method === "DELETE") {
        if (!f.anyone) return new Response("not found", { status: 404 });
        f.anyone = false;
        return new Response(null, { status: 204 });
      }
      if (req.method === "PATCH") {
        Object.assign(f, await req.json());
        return Response.json(fileJson(f));
      }
      return Response.json(fileJson(f));
    },
  });
});

afterAll(() => fake.stop(true));

function makeApp(opts: { googleEnabled?: boolean; now?: () => Date; notionApi?: string } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "folio-test-"));
  const db = openDb(join(dataDir, "t.db"));
  const google = createGoogle(
    {
      clientId: "cid",
      clientSecret: "secret",
      redirectUri: "https://kacarong.kr/auth/callback",
      authUrl: `${fake.url}auth`,
      tokenUrl: `${fake.url}token`,
      apiBase: fake.url.toString().replace(/\/$/, ""),
    },
    db,
  );
  const fetch = createApp(
    { baseUrl: "https://kacarong.kr", adminEmail: "owner@example.com", dataDir, googleEnabled: opts.googleEnabled ?? true, now: opts.now, notionApi: opts.notionApi },
    db,
    google,
  );
  const call = (path: string, init: RequestInit & { cookie?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (init.cookie) headers.set("Cookie", init.cookie);
    return fetch(new Request("https://kacarong.kr" + path, { ...init, headers }));
  };
  return { call, db, cleanup: () => rmSync(dataDir, { recursive: true, force: true }) };
}

async function login(call: ReturnType<typeof makeApp>["call"], code = "good-code") {
  const start = await call("/auth/login");
  expect(start.status).toBe(302);
  const redirect = new URL(start.headers.get("Location")!);
  lastPrompt = redirect.searchParams.get("prompt");
  // The full grant only when none is saved yet; after that just "who is this", so Google skips its unverified-app warning.
  const full = lastPrompt === "consent";
  expect(redirect.searchParams.get("scope")).toBe(full ? FULL_SCOPE : "openid email");
  expect(redirect.searchParams.get("access_type")).toBe(full ? "offline" : "online");
  expect(redirect.searchParams.get("include_granted_scopes")).toBe(full ? "true" : null); // else the saved calendar grant comes back in
  expect(redirect.searchParams.get("login_hint")).toBe("owner@example.com"); // Google picks the owner account by itself
  const state = redirect.searchParams.get("state")!;
  const res = await call(`/auth/callback?state=${state}&code=${code}`, { cookie: `oauth_state_${state}=1` });
  const sid = res.headers.getSetCookie().find((c) => c.startsWith("sid="))?.split(";")[0];
  return { res, cookie: sid };
}

test("관리자 로그인 → 업로드 → 공유/공개 → 공개 페이지 → 휴지통", async () => {
  loginEmail = "owner@example.com";
  const { call, cleanup } = makeApp();
  try {
    expect((await call("/api/files")).status).toBe(401);

    const { res, cookie } = await login(call);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin");
    expect(cookie).toBeTruthy();
    expect(await (await call("/api/me", { cookie })).json()).toMatchObject({ admin: true, driveConnected: true });

    // Upload: server opens a resumable session, the "browser" sends two chunks straight to the session URL.
    const size = 300_000;
    const init = await call("/api/uploads", {
      method: "POST",
      cookie,
      headers: { "Content-Type": "application/json", Origin: "https://kacarong.kr" },
      body: JSON.stringify({ name: "작품.png", size, mimeType: "image/png" }),
    });
    expect(init.status).toBe(200);
    const { uploadUrl } = (await init.json()) as { uploadUrl: string };
    const session = uploads.get(new URL(uploadUrl).searchParams.get("upload_id")!)!;
    expect(session.origin).toBe("https://kacarong.kr");
    const rootId = session.parents[0]!;
    expect(drive.get(rootId)?.mimeType).toBe("application/vnd.google-apps.folder");

    const status = (u = uploadUrl) =>
      call("/api/uploads/status", { method: "POST", cookie, headers: JSON_ORIGIN, body: JSON.stringify({ uploadUrl: u, size }) });
    expect(await (await status()).json()).toEqual({ next: 0 });

    const first = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Range": `bytes 0-262143/${size}` }, body: new Uint8Array(262144) });
    expect(first.status).toBe(308);
    // What the browser asks for when CORS hides the Range header.
    expect(await (await status()).json()).toEqual({ next: 262144 });
    // Only Drive upload session URLs are queried.
    expect((await status("http://192.168.10.1/admin?upload_id=x")).status).toBe(400);
    expect((await status(`${fake.url}drive/v3/files?upload_id=x`)).status).toBe(400);
    const done = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Range": `bytes 262144-${size - 1}/${size}` }, body: new Uint8Array(size - 262144) });
    const driveFile = (await done.json()) as { id: string };
    // A status query after completion returns the finished file, so a lost final reply is recoverable.
    expect(((await (await status()).json()) as { file: { id: string } }).file.id).toBe(driveFile.id);

    const reg = await call("/api/files", {
      method: "POST",
      cookie,
      headers: JSON_ORIGIN,
      body: JSON.stringify({ driveId: driveFile.id, category: "포트폴리오", tags: "로고,브랜딩", note: "2026 작업" }),
    });
    expect(reg.status).toBe(201);
    const row = (await reg.json()) as { id: number; title: string; size: number };
    expect(row).toMatchObject({ title: "작품.png", size });

    // Search
    const found = (await (await call("/api/files?q=브랜딩", { cookie })).json()) as unknown[];
    expect(found).toHaveLength(1);
    expect(await (await call("/api/files?q=없는말", { cookie })).json()).toHaveLength(0);

    // Not public yet: hidden from the public page and its thumbnail.
    expect(await (await call("/")).text()).not.toContain("작품.png");
    expect((await call(`/thumb/${row.id}`)).status).toBe(404);

    // Publishing also turns on anyone-with-link sharing on Drive.
    const pub = await call(`/api/files/${row.id}/public`, { method: "POST", cookie, headers: JSON_ORIGIN, body: JSON.stringify({ public: true }) });
    expect(await pub.json()).toMatchObject({ shared: 1, public: 1 });
    expect(drive.get(driveFile.id)!.anyone).toBe(true);
    const page = await (await call("/")).text();
    expect(page).toContain("작품.png");
    expect(page).toContain(`https://drive.example/view/${driveFile.id}`);
    const thumb = await call(`/thumb/${row.id}`);
    expect(thumb.status).toBe(200);
    expect(await thumb.text()).toBe("PNGDATA");

    // Turning sharing off makes it private on Drive and drops it from the public page.
    const off = await call(`/api/files/${row.id}/share`, { method: "POST", cookie, headers: JSON_ORIGIN, body: JSON.stringify({ shared: false }) });
    expect(await off.json()).toMatchObject({ shared: 0, public: 0 });
    expect(drive.get(driveFile.id)!.anyone).toBe(false);
    expect(await (await call("/")).text()).not.toContain("작품.png");

    // Delete moves the Drive file to trash.
    expect((await call(`/api/files/${row.id}`, { method: "DELETE", cookie, headers: JSON_ORIGIN })).status).toBe(200);
    expect(drive.get(driveFile.id)!.trashed).toBe(true);
    expect(await (await call("/api/files", { cookie })).json()).toHaveLength(0);
  } finally {
    cleanup();
  }
});

test("다른 구글 계정은 관리자 로그인 불가, 토큰도 저장 안 함", async () => {
  loginEmail = "someone@example.com";
  const { call, db, cleanup } = makeApp();
  try {
    const { res, cookie } = await login(call);
    expect(res.status).toBe(403);
    expect(cookie).toBeUndefined();
    expect(db.getSetting("refresh_token")).toBeNull();
  } finally {
    cleanup();
  }
});

test("state 불일치, 1GB 이상, 파일함 밖 파일, 다른 출처 요청은 거부", async () => {
  loginEmail = "owner@example.com";
  const { call, cleanup } = makeApp();
  try {
    const noSession = (r: Response) => {
      expect(r.status).toBe(302); // back to /admin, no session from it
      expect(r.headers.get("Location")).toBe("/admin");
      expect(r.headers.getSetCookie().some((c) => c.startsWith("sid="))).toBe(false);
    };
    const stateOf = async () => new URL((await call("/auth/login")).headers.get("Location")!).searchParams.get("state")!;
    const [s1, s2] = [await stateOf(), await stateOf()];
    noSession(await call(`/auth/callback?state=${s1}&code=good-code`, { cookie: `oauth_state_${s2}=1` })); // someone else's state
    noSession(await call(`/auth/callback?state=${s1}&error=access_denied`, { cookie: `oauth_state_${s1}=1` })); // cancelled on Google's page
    // Two tabs signing in at the same time: both attempts are accepted.
    const both = `oauth_state_${s1}=1; oauth_state_${s2}=1`;
    for (const s of [s2, s1]) {
      const r = await call(`/auth/callback?state=${s}&code=good-code`, { cookie: both });
      expect(r.headers.getSetCookie().some((c) => c.startsWith("sid="))).toBe(true);
      expect(r.headers.getSetCookie()).toContain(`oauth_state_${s}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`);
    }
    noSession(await call(`/auth/callback?state=${s1}&code=good-code`)); // the used link opened again
    const { cookie } = await login(call);
    const json = JSON_ORIGIN;

    const big = await call("/api/uploads", { method: "POST", cookie, headers: json, body: JSON.stringify({ name: "a.zip", size: 1024 ** 3, mimeType: "" }) });
    expect(big.status).toBe(413);

    const outside: FakeFile = { id: "outside1", name: "x", mimeType: "text/plain", parents: ["other"], trashed: false, anyone: false, bytes: 1 };
    drive.set(outside.id, outside);
    expect((await call("/api/files", { method: "POST", cookie, headers: json, body: JSON.stringify({ driveId: "outside1" }) })).status).toBe(400);

    const cross = await call("/api/uploads", { method: "POST", cookie, headers: { ...json, Origin: "https://evil.example" }, body: JSON.stringify({ name: "a", size: 1 }) });
    expect(cross.status).toBe(403);
    const noOrigin = await call("/api/uploads", { method: "POST", cookie, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "a", size: 1 }) });
    expect(noOrigin.status).toBe(403);
  } finally {
    cleanup();
  }
});

test("공개 페이지는 제목·메모를 HTML 이스케이프", async () => {
  const { call, db, cleanup } = makeApp();
  try {
    const row = db.insertFile({ drive_id: "x1", name: "n", title: "<script>alert(1)</script>", mime: "", size: 1, category: "포트폴리오", tags: "", note: "", web_view_link: "https://drive.example/view/x1", web_content_link: "" });
    db.updateFile(row.id, { shared: 1, public: 1 });
    const html = await (await call("/")).text();
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  } finally {
    cleanup();
  }
});

test("개인정보처리방침 페이지가 열리고 공개 페이지에서 링크됨", async () => {
  const { call, cleanup } = makeApp();
  try {
    const res = await call("/privacy");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(await res.text()).toContain("개인정보처리방침");
    expect(await (await call("/")).text()).toContain('href="/privacy"');
  } finally {
    cleanup();
  }
});

test("첫 업로드를 동시에 여러 개 시작해도 드라이브 폴더는 하나만 생성", async () => {
  loginEmail = "owner@example.com";
  const { call, db, cleanup } = makeApp();
  try {
    const { cookie } = await login(call);
    const before = foldersCreated;
    const start = () =>
      call("/api/uploads", { method: "POST", cookie, headers: JSON_ORIGIN, body: JSON.stringify({ name: "a.txt", size: 10, mimeType: "text/plain" }) });
    const results = await Promise.all([start(), start(), start()]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(foldersCreated - before).toBe(1);
    const parents = await Promise.all(
      results.map(async (r) => uploads.get(new URL(((await r.json()) as { uploadUrl: string }).uploadUrl).searchParams.get("upload_id")!)!.parents[0]),
    );
    expect(new Set(parents)).toEqual(new Set([db.getSetting("root_folder_id")!]));
  } finally {
    cleanup();
  }
});

const JSON_ORIGIN = { "Content-Type": "application/json", Origin: "https://kacarong.kr" };

async function passwordLogin(call: ReturnType<typeof makeApp>["call"], password: string) {
  const res = await call("/auth/password", { method: "POST", headers: JSON_ORIGIN, body: JSON.stringify({ password }) });
  return { res, cookie: res.headers.getSetCookie().find((c) => c.startsWith("sid="))?.split(";")[0] };
}

test("비밀번호 로그인: 구글 없이 로그인, 틀리면 거부, 5번 틀리면 잠금", async () => {
  const { call, db, cleanup } = makeApp({ googleEnabled: false });
  try {
    expect((await passwordLogin(call, "anything")).res.status).toBe(401); // not set yet
    db.setSetting("password_hash", await Bun.password.hash("correct horse battery"));

    expect((await call("/auth/login")).status).toBe(404); // Google login is off
    expect(await (await call("/api/me")).json()).toMatchObject({ admin: false, googleEnabled: false });

    const cross = await call("/auth/password", { method: "POST", headers: { ...JSON_ORIGIN, Origin: "https://evil.example" }, body: JSON.stringify({ password: "correct horse battery" }) });
    expect(cross.status).toBe(403);

    const { res, cookie } = await passwordLogin(call, "correct horse battery");
    expect(res.status).toBe(204);
    expect(await (await call("/api/me", { cookie })).json()).toMatchObject({ admin: true });
    // Drive isn't connected, so file storage says so instead of crashing.
    expect((await call("/api/quota", { cookie })).status).toBe(401);

    // The attempt before the password was set already counts as 1 failure.
    for (let i = 0; i < 3; i++) expect((await passwordLogin(call, "wrong")).res.status).toBe(401);
    expect((await passwordLogin(call, "wrong")).res.status).toBe(401); // 5th failure
    expect((await passwordLogin(call, "correct horse battery")).res.status).toBe(429); // locked even with the right one

    expect((await call("/auth/logout", { method: "POST", cookie })).status).toBe(204);
    expect((await call("/api/me", { cookie })).status).toBe(200);
    expect(await (await call("/api/me", { cookie })).json()).toMatchObject({ admin: false });
  } finally {
    cleanup();
  }
});

test("할 일·과제: 추가 → 오늘 화면 분류 → 완료 → 수정·삭제", async () => {
  // 2026-11-19 00:30 in Korea is still 11-18 in UTC; the today screen must use Korean dates.
  let clock = new Date("2026-11-18T15:30:00Z");
  const { call, db, cleanup } = makeApp({ googleEnabled: false, now: () => clock });
  try {
    db.setSetting("password_hash", await Bun.password.hash("correct horse battery"));
    const { cookie } = await passwordLogin(call, "correct horse battery");
    expect((await call("/api/tasks")).status).toBe(401);

    const add = async (b: object) => {
      const r = await call("/api/tasks", { method: "POST", cookie, headers: JSON_ORIGIN, body: JSON.stringify(b) });
      return { status: r.status, task: (await r.json()) as { id: number; error?: string } & Record<string, unknown> };
    };
    const late = (await add({ title: "지난 할 일", due_date: "2026-11-17" })).task;
    const todayTodo = (await add({ title: "장보기", due_date: "2026-11-19", due_time: "18:00" })).task;
    const soon = (await add({ kind: "과제", title: "레포트", course: "디자인사", due_date: "2026-11-22", due_time: "23:59" })).task;
    await add({ kind: "과제", title: "먼 과제", due_date: "2026-11-30" });
    await add({ title: "먼 할 일", due_date: "2026-11-21" }); // 할 일 only shows on its own day
    await add({ title: "날짜 없는 할 일" });
    expect(todayTodo).toMatchObject({ kind: "할 일", due_time: "18:00", done: 0 });
    expect(soon).toMatchObject({ kind: "과제", course: "디자인사" });

    expect((await add({ title: "" })).status).toBe(400);
    expect((await add({ title: "x", kind: "숙제" })).status).toBe(400);
    expect((await add({ title: "x", due_date: "2026-02-30" })).status).toBe(400);
    expect((await add({ title: "x", due_date: "2026-11-19", due_time: "25:00" })).status).toBe(400);

    const todayView = async () => (await (await call("/api/today", { cookie })).json()) as Record<string, { title: string }[]> & { date: string };
    let t = await todayView();
    expect(t.date).toBe("2026-11-19");
    expect(t.overdue!.map((x) => x.title)).toEqual(["지난 할 일"]);
    expect(t.today!.map((x) => x.title)).toEqual(["장보기"]);
    expect(t.upcoming!.map((x) => x.title)).toEqual(["레포트"]);
    expect(t.doneToday).toEqual([]);

    const patch = (id: number, b: object) => call(`/api/tasks/${id}`, { method: "PATCH", cookie, headers: JSON_ORIGIN, body: JSON.stringify(b) });
    expect(await (await patch(todayTodo.id, { done: true })).json()).toMatchObject({ done: 1, done_at: "2026-11-19" });
    t = await todayView();
    expect(t.today).toEqual([]);
    expect(t.doneToday!.map((x) => x.title)).toEqual(["장보기"]);
    expect(await (await patch(todayTodo.id, { done: false })).json()).toMatchObject({ done: 0, done_at: null });

    expect(await (await patch(late.id, { title: "미룬 할 일", due_date: "" })).json()).toMatchObject({ title: "미룬 할 일", due_date: null });
    expect((await patch(late.id, { title: "" })).status).toBe(400);
    expect((await call("/api/tasks/9999", { method: "PATCH", cookie, headers: JSON_ORIGIN, body: "{}" })).status).toBe(404);

    // Two days later the 과제 is due today, and the 할 일 from 11-21 appears.
    clock = new Date("2026-11-21T03:00:00Z");
    t = await todayView();
    expect(t.today!.map((x) => x.title)).toEqual(["먼 할 일"]);
    expect(t.overdue!.map((x) => x.title)).toEqual(["장보기"]);
    expect(t.upcoming!.map((x) => x.title)).toEqual(["레포트"]);

    // Range query for the calendar, plus filters.
    const range = (await (await call("/api/tasks?from=2026-11-19&to=2026-11-30", { cookie })).json()) as { title: string }[];
    expect(range.map((x) => x.title)).toEqual(["장보기", "먼 할 일", "레포트", "먼 과제"]);
    const assignments = (await (await call("/api/tasks?kind=과제&done=0", { cookie })).json()) as unknown[];
    expect(assignments).toHaveLength(2);
    const all = (await (await call("/api/tasks", { cookie })).json()) as { title: string }[];
    expect(all.at(-1)?.title).toBe("날짜 없는 할 일"); // undated last
    expect((await call("/api/tasks?from=2026-13-01", { cookie })).status).toBe(400);

    expect((await call(`/api/tasks/${soon.id}`, { method: "DELETE", cookie, headers: JSON_ORIGIN })).status).toBe(200);
    expect(db.getTask(soon.id)).toBeNull();
  } finally {
    cleanup();
  }
});

test("캘린더: 권한 없으면 다시 동의 요청, 구글 일정 + 할 일을 한국 날짜로", async () => {
  loginEmail = "owner@example.com";
  const { call, cleanup } = makeApp();
  try {
    // A grant without the calendar scope (old token, or unticked on the consent screen).
    grantedScope = "openid email https://www.googleapis.com/auth/drive.file";
    const { cookie } = await login(call);
    expect(await (await call("/api/me", { cookie })).json()).toMatchObject({ driveConnected: true, calendarConnected: false });
    let r = (await (await call("/api/calendar?from=2026-11-15&to=2026-11-30", { cookie })).json()) as Record<string, unknown>;
    expect(r.google).toBe("need_consent");
    const again = new URL((await call("/auth/login")).headers.get("Location")!);
    expect(again.searchParams.get("prompt")).toBe("consent"); // refresh token exists, but a new grant is needed
    expect(again.searchParams.get("scope")).toContain("calendar.readonly");

    grantedScope = FULL_SCOPE;
    await login(call);
    expect(await (await call("/api/me", { cookie })).json()).toMatchObject({ calendarConnected: true });
    expect(new URL((await call("/auth/login")).headers.get("Location")!).searchParams.get("prompt")).toBeNull();

    // A plain sign-in (no refresh token, narrower scope in the reply) keeps the saved grant.
    grantedScope = "openid email";
    const plain = await login(call);
    expect(plain.res.status).toBe(302);
    expect(await (await call("/api/me", { cookie: plain.cookie })).json()).toMatchObject({ admin: true, driveConnected: true, calendarConnected: true });
    grantedScope = FULL_SCOPE;

    await call("/api/tasks", { method: "POST", cookie, headers: JSON_ORIGIN, body: JSON.stringify({ kind: "과제", title: "레포트", due_date: "2026-11-22" }) });
    await call("/api/tasks", { method: "POST", cookie, headers: JSON_ORIGIN, body: JSON.stringify({ title: "범위 밖", due_date: "2026-12-05" }) });
    await call("/api/tasks", { method: "POST", cookie, headers: JSON_ORIGIN, body: JSON.stringify({ title: "날짜 없음" }) });

    eventQueries.length = 0;
    r = (await (await call("/api/calendar?from=2026-11-15&to=2026-11-30", { cookie })).json()) as Record<string, unknown>;
    expect(r.google).toBe("ok");
    expect((r.tasks as { title: string }[]).map((t) => t.title)).toEqual(["레포트"]);
    expect(eventQueries).toHaveLength(2); // the calendar switched off in Google is skipped
    expect(eventQueries[0]!.get("timeMin")).toBe("2026-11-15T00:00:00+09:00");
    expect(eventQueries[0]!.get("timeMax")).toBe("2026-12-01T00:00:00+09:00");
    expect(eventQueries[0]!.get("singleEvents")).toBe("true");
    const byId = Object.fromEntries((r.events as { id: string }[]).map((e) => [e.id, e]));
    expect(Object.keys(byId).sort()).toEqual(["e1", "e2", "e3", "h1"]);
    // 15:30 UTC on 11-18 is 00:30 on 11-19 in Korea.
    expect(byId.e1).toMatchObject({ title: "새벽 회의", startDate: "2026-11-19", endDate: "2026-11-19", time: "00:30", link: "https://cal.example/e1", calendar: "내 캘린더", color: "#9fe1e7" });
    expect(byId.e2).toMatchObject({ startDate: "2026-11-20", endDate: "2026-11-22", time: null }); // all-day end is exclusive
    expect(byId.e3).toMatchObject({ startDate: "2026-11-20", endDate: "2026-11-20", time: "23:00" });
    expect(byId.h1).toMatchObject({ title: "(제목 없음)", calendar: "대한민국의 휴일", color: "" }); // odd color dropped

    // Google trouble still shows the tasks.
    calendarFails = true;
    r = (await (await call("/api/calendar?from=2026-11-15&to=2026-11-30", { cookie })).json()) as Record<string, unknown>;
    calendarFails = false;
    expect(r.google).toBe("error");
    expect(String(r.error)).toContain("403");
    expect(r.tasks).toHaveLength(1);

    for (const q of ["from=2026-11-30&to=2026-11-01", "from=2026-11-01&to=2027-01-02", "from=2026-11-01", "from=2026-11-01&to=2026-11-31"]) {
      expect((await call(`/api/calendar?${q}`, { cookie })).status).toBe(400);
    }
    expect((await call("/api/calendar?from=2026-11-01&to=2027-01-01", { cookie })).status).toBe(200); // exactly 62 days
  } finally {
    grantedScope = FULL_SCOPE;
    calendarFails = false;
    cleanup();
  }
});

test("구글에서 권한이 끊기면 다음 로그인에서 전체 권한을 다시 요청", async () => {
  const { call, db, cleanup } = makeApp();
  try {
    db.setSetting("password_hash", await Bun.password.hash("correct horse battery"));
    db.setSetting("refresh_token", "old-rt");
    db.setSetting("granted_scopes", FULL_SCOPE);
    expect(new URL((await call("/auth/login")).headers.get("Location")!).searchParams.get("prompt")).toBeNull();
    const { cookie } = await passwordLogin(call, "correct horse battery");
    grantRevoked = true;
    const r = (await (await call("/api/calendar?from=2026-11-15&to=2026-11-30", { cookie })).json()) as Record<string, unknown>;
    expect(r.google).toBe("error");
    expect(new URL((await call("/auth/login")).headers.get("Location")!).searchParams.get("prompt")).toBe("consent");
  } finally {
    grantRevoked = false;
    cleanup();
  }
});

test("정적 파일 주소에 버전이 붙고, 그 주소로 파일이 열림", async () => {
  const { call, cleanup } = makeApp({ googleEnabled: false });
  try {
    const admin = await (await call("/admin")).text();
    const js = admin.match(/src="(\/static\/admin\.js\?v=[0-9a-f]{10})"/)?.[1];
    expect(js).toBeTruthy();
    expect(admin).toMatch(/href="\/static\/admin\.css\?v=[0-9a-f]{10}"/);
    expect(await (await call(js!)).text()).toContain("loadCalendar");
    expect(await (await call("/")).text()).toMatch(/\/static\/site\.css\?v=[0-9a-f]{10}"[\s\S]*\/static\/site\.js\?v=[0-9a-f]{10}"/);
  } finally {
    cleanup();
  }
});

test("공개된 옛 기본 비밀번호·짧은 비밀번호는 맞아도 로그인 거부", async () => {
  const { call, db, cleanup } = makeApp();
  try {
    for (const weak of ["kacarong", "kacarong2026!!", "short1!"]) {
      db.setSetting("password_hash", await Bun.password.hash(weak));
      const { res, cookie } = await passwordLogin(call, weak);
      expect(res.status).toBe(403);
      expect(cookie).toBeUndefined();
      expect(((await res.json()) as { error: string }).error).toContain("비밀번호 바꾸기");
    }
  } finally {
    cleanup();
  }
});

test("비밀번호 바꾸기: 비밀번호 로그인은 지금 비밀번호 확인, 바꾸면 다른 로그인은 모두 해제", async () => {
  loginEmail = "owner@example.com";
  const { call, db, cleanup } = makeApp();
  try {
    db.setSetting("password_hash", await Bun.password.hash("correct horse battery"));
    const a = (await passwordLogin(call, "correct horse battery")).cookie!;
    const b = (await passwordLogin(call, "correct horse battery")).cookie!;
    expect(await (await call("/api/me", { cookie: a })).json()).toMatchObject({ admin: true, loginMethod: "password" });
    const change = (cookie: string | undefined, body: object, headers: Record<string, string> = JSON_ORIGIN) =>
      call("/api/password", { method: "POST", cookie, headers, body: JSON.stringify(body) });

    expect((await change(undefined, { password: "a brand new secret" })).status).toBe(401);
    expect((await change(a, { current: "correct horse battery", password: "a brand new secret" }, { "Content-Type": "application/json" })).status).toBe(403); // no Origin
    expect((await change(a, { password: "a brand new secret" })).status).toBe(403); // current missing
    expect((await change(a, { current: "wrong wrong wrong", password: "a brand new secret" })).status).toBe(403);
    expect((await change(a, { current: "correct horse battery", password: "too short" })).status).toBe(400);
    expect((await change(a, { current: "correct horse battery", password: "my kacarong password" })).status).toBe(400);

    expect((await change(a, { current: "correct horse battery", password: "a brand new secret" })).status).toBe(200);
    expect((await call("/api/tasks", { cookie: a })).status).toBe(200); // this device stays logged in
    expect((await call("/api/tasks", { cookie: b })).status).toBe(401); // others are logged out
    expect((await passwordLogin(call, "correct horse battery")).res.status).toBe(401);
    expect((await passwordLogin(call, "a brand new secret")).res.status).toBe(204);

    // A Google login can set it without the current one (e.g. when the old one was the public default).
    const g = (await login(call)).cookie!;
    expect(await (await call("/api/me", { cookie: g })).json()).toMatchObject({ loginMethod: "google" });
    expect((await change(g, { password: "set from google login" })).status).toBe(200);
    expect((await passwordLogin(call, "set from google login")).res.status).toBe(204);
    expect((await call("/api/tasks", { cookie: a })).status).toBe(401);
  } finally {
    cleanup();
  }
});

test("비밀번호 경합: 검증·해싱 도중 비밀번호가 바뀌면 옛 요청은 로그인도 변경도 못 함", async () => {
  const { call, db, cleanup } = makeApp();
  try {
    db.setSetting("password_hash", await Bun.password.hash("correct horse battery"));
    const sid = (c: string) => decodeURIComponent(c.slice("sid=".length));
    // Hash everything up front: the "other device" writes below must not await, or the pending request could finish first.
    const [elsewhere, winner, winner2] = await Promise.all(["changed elsewhere 1", "winner from device b", "second winner value"].map((p) => Bun.password.hash(p)));

    // Login with the old password is still verifying when the password changes.
    const pending = passwordLogin(call, "correct horse battery"); // runs until its first await
    db.setSetting("password_hash", elsewhere);
    const late = await pending;
    expect(late.res.status).toBe(401);
    expect(late.cookie).toBeUndefined();

    // A change is hashing when another device changes the password and logs this session out.
    db.setSetting("password_hash", await Bun.password.hash("correct horse battery"));
    const a = (await passwordLogin(call, "correct horse battery")).cookie!;
    const b = (await passwordLogin(call, "correct horse battery")).cookie!;
    const change = (cookie: string, body: object) => call("/api/password", { method: "POST", cookie, headers: JSON_ORIGIN, body: JSON.stringify(body) });
    const stale = change(a, { current: "correct horse battery", password: "stale request value" });
    db.setSetting("password_hash", winner); // what device b's finished change does
    db.deleteOtherSessions(sid(b));
    expect((await stale).status).toBe(401);
    expect(db.getSetting("password_hash")).toBe(winner);
    expect((await call("/api/tasks", { cookie: b })).status).toBe(200); // b was not logged out by the stale request

    // Same race while this session stays valid: refused because the password moved on.
    const c = (await passwordLogin(call, "winner from device b")).cookie!;
    const stale2 = change(c, { current: "winner from device b", password: "stale request value" });
    db.setSetting("password_hash", winner2);
    expect((await stale2).status).toBe(409);
    expect(db.getSetting("password_hash")).toBe(winner2);
  } finally {
    cleanup();
  }
});

test("보안 헤더: CSP·프레임 금지·nosniff·HSTS, 개인 데이터는 캐시 금지", async () => {
  const { call, cleanup } = makeApp({ googleEnabled: false });
  try {
    for (const path of ["/", "/admin", "/api/me", "/privacy", "/nope"]) {
      const h = (await call(path)).headers;
      expect(h.get("Content-Security-Policy")).toContain("script-src 'self';");
      expect(h.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
      expect(h.get("X-Frame-Options")).toBe("DENY");
      expect(h.get("X-Content-Type-Options")).toBe("nosniff");
      expect(h.get("Strict-Transport-Security")).toContain("max-age=");
    }
    expect((await call("/")).headers.get("Content-Security-Policy")).toContain(`connect-src 'self' ${fake.url.origin}`);
    expect((await call("/admin")).headers.get("Cache-Control")).toBe("no-store");
    expect((await call("/api/me")).headers.get("Cache-Control")).toBe("no-store");
    expect((await call("/")).headers.get("Cache-Control")).toBeNull();
    expect(await (await call("/")).text()).not.toContain("onerror="); // inline handlers would be blocked by the CSP
  } finally {
    cleanup();
  }
});

test("캘린더: 구글이 꺼져 있으면 할 일만", async () => {
  const { call, db, cleanup } = makeApp({ googleEnabled: false });
  try {
    db.setSetting("password_hash", await Bun.password.hash("correct horse battery"));
    const { cookie } = await passwordLogin(call, "correct horse battery");
    expect((await call("/api/calendar?from=2026-11-01&to=2026-11-30")).status).toBe(401);
    await call("/api/tasks", { method: "POST", cookie, headers: JSON_ORIGIN, body: JSON.stringify({ title: "장보기", due_date: "2026-11-19" }) });
    const r = (await (await call("/api/calendar?from=2026-11-01&to=2026-11-30", { cookie })).json()) as Record<string, unknown>;
    expect(r).toMatchObject({ google: "off", events: [] });
    expect(r.tasks).toHaveLength(1);
  } finally {
    cleanup();
  }
});

test("비밀번호 로그인: 병렬 요청도 5번까지만 검증", async () => {
  const { call, db, cleanup } = makeApp({ googleEnabled: false });
  try {
    db.setSetting("password_hash", await Bun.password.hash("correct horse battery"));
    const results = await Promise.all(Array.from({ length: 20 }, () => passwordLogin(call, "wrong")));
    const statuses = results.map((r) => r.res.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(15);
    expect((await passwordLogin(call, "correct horse battery")).res.status).toBe(429);
  } finally {
    cleanup();
  }
});

test("비밀번호 로그인: 성공한 시도는 실패 횟수에 남지 않음", async () => {
  const { call, db, cleanup } = makeApp({ googleEnabled: false });
  try {
    db.setSetting("password_hash", await Bun.password.hash("correct horse battery"));
    for (let i = 0; i < 4; i++) expect((await passwordLogin(call, "wrong")).res.status).toBe(401);
    expect((await passwordLogin(call, "correct horse battery")).res.status).toBe(204);
    expect((await passwordLogin(call, "correct horse battery")).res.status).toBe(204);
  } finally {
    cleanup();
  }
});

test("노트: 블록 저장, 날짜 있는 체크박스는 할 일이 되어 오늘·캘린더에 나오고 양쪽이 서로 맞춰짐", async () => {
  const clock = new Date("2026-11-19T03:00:00Z");
  const { call, db, cleanup } = makeApp({ googleEnabled: false, now: () => clock });
  try {
    db.setSetting("password_hash", await Bun.password.hash("correct horse battery"));
    const { cookie } = await passwordLogin(call, "correct horse battery");
    expect((await call("/api/notes")).status).toBe(401);
    const req = (path: string, method: string, b?: object) => call(path, { method, cookie, headers: JSON_ORIGIN, body: b ? JSON.stringify(b) : undefined });

    const note = (await (await req("/api/notes", "POST", { title: "수업 메모" })).json()) as { id: number; blocks: { type: string }[] };
    expect(note.blocks).toHaveLength(1);
    const version = async () => ((await (await req(`/api/notes/${note.id}`, "GET")).json()) as { version: number }).version;
    const save = async (blocks: object[], title = "수업 메모", v?: number) => req(`/api/notes/${note.id}`, "PUT", { title, blocks, version: v ?? (await version()) });
    const blocks = [
      { id: "a", type: "h1", text: "디자인사", checked: true, date: "2026-11-19" }, // extra fields on non-todo blocks are dropped
      { id: "b", type: "todo", text: "레포트 초안\n3쪽 이상", date: "2026-11-19", time: "18:00" },
      { id: "c", type: "todo", text: "날짜 없는 체크", checked: false },
      { id: "d", type: "todo", text: "전시 보기", date: "2026-11-25" },
      { id: "e", type: "divider", text: "무시됨" },
    ];
    expect((await save(blocks)).status).toBe(200);
    const saved = (await (await req(`/api/notes/${note.id}`, "GET")).json()) as { blocks: object[] };
    expect(saved.blocks[0]).toEqual({ id: "a", type: "h1", text: "디자인사" });
    expect(saved.blocks[4]).toEqual({ id: "e", type: "divider", text: "" });

    // Only dated todos become tasks; the task title is the first line.
    let today = (await (await req("/api/today", "GET")).json()) as { today: { id: number; title: string; due_time: string; note_id: number; note_title: string }[] };
    expect(today.today).toHaveLength(1);
    expect(today.today[0]).toMatchObject({ title: "레포트 초안", due_time: "18:00", note_id: note.id, note_title: "수업 메모" });
    const cal = (await (await req("/api/calendar?from=2026-11-01&to=2026-11-30", "GET")).json()) as { tasks: { title: string }[] };
    expect(cal.tasks.map((t) => t.title)).toEqual(["레포트 초안", "전시 보기"]);
    const taskId = today.today[0]!.id;

    // Checking it off on the today screen checks the box in the note; the kind set on the task stays.
    await req(`/api/tasks/${taskId}`, "PATCH", { done: true, kind: "과제", title: "레포트 완성" });
    let n = (await (await req(`/api/notes/${note.id}`, "GET")).json()) as { blocks: Record<string, unknown>[] };
    expect(n.blocks[1]).toMatchObject({ id: "b", checked: true, text: "레포트 완성\n3쪽 이상", date: "2026-11-19", time: "18:00" });
    expect(db.getTask(taskId)).toMatchObject({ done: 1, done_at: "2026-11-19", kind: "과제" });

    // Saving the note again keeps the same task (same id, done date, kind).
    n.blocks[1]!.text = "레포트 완성본\n3쪽 이상";
    await save(n.blocks);
    expect(db.getTask(taskId)).toMatchObject({ title: "레포트 완성본", done: 1, done_at: "2026-11-19", kind: "과제" });

    // Taking the date off in the task dialog leaves a plain checkbox and removes the task.
    const dated = db.listTasks({}).find((t) => t.title === "전시 보기")!;
    expect((await req(`/api/tasks/${dated.id}`, "PATCH", { due_date: "" })).status).toBe(200);
    expect(db.getTask(dated.id)).toBeNull();
    n = (await (await req(`/api/notes/${note.id}`, "GET")).json()) as { blocks: Record<string, unknown>[] };
    expect(n.blocks[3]).toEqual({ id: "d", type: "todo", text: "전시 보기", checked: false });

    // Deleting the task removes its block; removing a block from the note removes its task.
    await req(`/api/tasks/${taskId}`, "DELETE");
    n = (await (await req(`/api/notes/${note.id}`, "GET")).json()) as { blocks: Record<string, unknown>[] };
    expect(n.blocks.map((b) => b.id)).toEqual(["a", "c", "d", "e"]);
    await save([...n.blocks, { id: "f", type: "todo", text: "새 할 일", date: "2026-11-20" }]);
    expect(db.listTasks({}).map((t) => t.title)).toEqual(["새 할 일"]);
    await save(n.blocks);
    expect(db.listTasks({})).toEqual([]);

    // Search covers titles and block text.
    await save(n.blocks, "다른 제목");
    expect(((await (await req("/api/notes?q=날짜 없는", "GET")).json()) as unknown[]).length).toBe(1);
    expect(((await (await req("/api/notes?q=없는말", "GET")).json()) as unknown[]).length).toBe(0);

    // A save from a copy older than a task-side change is refused and changes nothing, so checking
    // a task off in one tab can't be undone by typing in a stale note in another tab.
    await save([{ id: "h", type: "todo", text: "충돌 확인", date: "2026-11-21" }]);
    const stale = await version();
    const conflictTask = db.listTasks({}).find((t) => t.title === "충돌 확인")!;
    await req(`/api/tasks/${conflictTask.id}`, "PATCH", { done: true });
    const conflict = await save([{ id: "h", type: "todo", text: "충돌 확인 고침", date: "2026-11-21" }], "수업 메모", stale);
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { version: number }).version).toBe(stale + 1);
    expect(db.getTask(conflictTask.id)).toMatchObject({ title: "충돌 확인", done: 1 });
    const ok = await save([{ id: "h", type: "todo", text: "충돌 확인 고침", checked: true, date: "2026-11-21" }], "수업 메모", stale + 1);
    expect(((await ok.json()) as { version: number }).version).toBe(stale + 2);
    expect((await req(`/api/notes/${note.id}`, "PUT", { title: "x", blocks: [] })).status).toBe(400); // no version

    // Bad input is refused.
    expect((await save([{ id: "a", type: "p", text: "" }, { id: "a", type: "p", text: "" }])).status).toBe(400);
    expect((await save([{ id: "a", type: "script", text: "" }])).status).toBe(400);
    expect((await save([{ id: "a b", type: "p", text: "" }])).status).toBe(400);
    expect((await save([{ id: "a", type: "todo", text: "x", date: "2026-02-30" }])).status).toBe(400);
    expect((await save([{ id: "a", type: "todo", text: "x", date: "2026-11-20", time: "24:00" }])).status).toBe(400);
    expect((await save([{ id: "a", type: "p", text: "x".repeat(500_001) }])).status).toBe(400);
    expect((await call(`/api/notes/${note.id}`, { method: "PUT", cookie, headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: "{}" })).status).toBe(403);

    // Deleting the note deletes its tasks.
    await save([{ id: "g", type: "todo", text: "마지막", date: "2026-11-21" }]);
    expect(db.listTasks({})).toHaveLength(1);
    await req(`/api/notes/${note.id}`, "DELETE");
    expect((await req(`/api/notes/${note.id}`, "GET")).status).toBe(404);
    expect(db.listTasks({})).toEqual([]);
  } finally {
    cleanup();
  }
});

test("클라우드 첨부: 노트·할 일에 파일함 파일을 붙이고 떼기, 지우면 첨부도 사라짐", async () => {
  loginEmail = "owner@example.com";
  const clock = new Date("2026-11-19T03:00:00Z");
  const { call, db, cleanup } = makeApp({ now: () => clock });
  try {
    const { cookie } = await login(call);
    const req = (path: string, method: string, b?: object) => call(path, { method, cookie, headers: JSON_ORIGIN, body: b ? JSON.stringify(b) : undefined });
    const addFile = (name: string) => {
      const id = `att${nextId++}`;
      drive.set(id, { id, name, mimeType: "application/pdf", parents: [], trashed: false, anyone: false, bytes: 10 });
      return db.insertFile({ drive_id: id, name, title: name, mime: "application/pdf", size: 10, category: "과제", tags: "", note: "", web_view_link: `https://drive.example/view/${id}`, web_content_link: "" });
    };
    const a = addFile("강의자료.pdf");
    const b = addFile("레포트.pdf");
    const note = (await (await req("/api/notes", "POST", { title: "유체역학" })).json()) as { id: number };
    const task = (await (await req("/api/tasks", "POST", { title: "레포트 제출", kind: "과제" })).json()) as { id: number };

    expect((await call(`/api/attachments?note=${note.id}`)).status).toBe(401);
    const list = async (q: string) => (await (await req(`/api/attachments?${q}`, "GET")).json()) as { attachment_id: number; title: string; web_view_link: string }[];

    // Attach: the reply is the new list. The same file can go on a note and a task, but only once on each.
    const added = await req("/api/attachments", "POST", { note: note.id, fileId: a.id });
    expect(added.status).toBe(201);
    expect(((await added.json()) as { title: string }[]).map((f) => f.title)).toEqual(["강의자료.pdf"]);
    expect((await req("/api/attachments", "POST", { note: note.id, fileId: b.id })).status).toBe(201);
    expect((await req("/api/attachments", "POST", { note: note.id, fileId: a.id })).status).toBe(409);
    expect((await req("/api/attachments", "POST", { task: task.id, fileId: a.id })).status).toBe(201);
    expect((await list(`note=${note.id}`)).map((f) => f.title)).toEqual(["강의자료.pdf", "레포트.pdf"]);
    expect((await list(`task=${task.id}`))[0]).toMatchObject({ title: "강의자료.pdf", web_view_link: `https://drive.example/view/${a.drive_id}` });
    // Task lists say how many files a task has.
    expect(((await (await req("/api/tasks", "GET")).json()) as { files: number }[])[0]!.files).toBe(1);

    // Bad targets and files are refused, and so are other sites.
    expect((await req("/api/attachments", "POST", { note: 9999, fileId: a.id })).status).toBe(404);
    expect((await req("/api/attachments", "POST", { task: task.id, fileId: 9999 })).status).toBe(404);
    expect((await req("/api/attachments", "POST", { fileId: a.id })).status).toBe(400);
    expect((await req("/api/attachments?folder=1", "GET")).status).toBe(400);
    expect((await call("/api/attachments", { method: "POST", cookie, headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: JSON.stringify({ note: note.id, fileId: b.id }) })).status).toBe(403);

    // Detaching keeps the file in the 파일함.
    const first = (await list(`note=${note.id}`))[0]!;
    expect((await req(`/api/attachments/${first.attachment_id}`, "DELETE")).status).toBe(200);
    expect((await req(`/api/attachments/${first.attachment_id}`, "DELETE")).status).toBe(404);
    expect((await list(`note=${note.id}`)).map((f) => f.title)).toEqual(["레포트.pdf"]);
    expect(db.getFile(a.id)).not.toBeNull();

    // Trashing a file takes it off everything it was attached to.
    expect((await req(`/api/files/${a.id}`, "DELETE")).status).toBe(200);
    expect(await list(`task=${task.id}`)).toEqual([]);

    // Deleting a note or task drops its attachments, including a note task that a note save removes.
    await req("/api/attachments", "POST", { task: task.id, fileId: b.id });
    await req(`/api/tasks/${task.id}`, "DELETE");
    const count = () => (db.raw.query("SELECT COUNT(*) AS n FROM attachments").get() as { n: number }).n;
    expect(count()).toBe(1); // 레포트.pdf on the note
    expect((await req(`/api/notes/${note.id}`, "PUT", { title: "유체역학", version: 1, blocks: [{ id: "t", type: "todo", text: "실험 보고서", date: "2026-11-20" }] })).status).toBe(200);
    const noteTask = db.listTasks({}).find((t) => t.note_id === note.id)!;
    expect((await req("/api/attachments", "POST", { task: noteTask.id, fileId: b.id })).status).toBe(201);
    expect(count()).toBe(2);
    expect((await req(`/api/notes/${note.id}`, "PUT", { title: "유체역학", version: 2, blocks: [] })).status).toBe(200);
    expect(count()).toBe(1);
    await req(`/api/notes/${note.id}`, "DELETE");
    expect(db.raw.query("SELECT COUNT(*) AS n FROM attachments").get()).toEqual({ n: 0 });
    expect(db.getFile(b.id)).not.toBeNull();
  } finally {
    cleanup();
  }
});

test("노션 가져오기: 페이지·데이터베이스 행은 노트로, 파일은 파일함으로, 다시 돌리면 노션에서 바뀐 것만 갱신", async () => {
  loginEmail = "owner@example.com";
  const uid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
  const rt = (text: string, extra: object = {}) => ({ type: "text", plain_text: text, href: null, ...extra });
  const children = new Map<string, object[]>();
  let n = 100;
  const blk = (type: string, data: object, kids?: object[], id = uid(n++)) => {
    if (kids) children.set(id, kids);
    return { object: "block", id, type, has_children: !!kids, [type]: data };
  };
  // A (in search) → child page SUB (in search) and HIDDEN (not in search), and database DB whose row ROW2 is not in search.
  const [A, SUB, ROW, OLD, HIDDEN, DB, ROW2] = [1, 2, 3, 4, 5, 6, 7].map(uid) as [string, string, string, string, string, string, string];
  const title = (t: string) => ({ 이름: { type: "title", title: [rt(t)] } });
  const page = (id: string, t: string, edited: string, extra: object = {}): Record<string, unknown> => ({
    object: "page", id, created_time: "2026-09-01T00:00:00.000Z", last_edited_time: edited, properties: title(t), ...extra,
  });
  let notion: ReturnType<typeof Bun.serve>;
  const fileUrl = (name: string) => `${notion!.url}files/${name}?X-Amz-Signature=${n++}`; // the signature changes on every read, like Notion's
  const pages: Record<string, unknown>[] = [
    page(A, "강의 노트", "2026-11-10T01:00:00.000Z", { icon: { type: "emoji", emoji: "📚" } }),
    page(SUB, "하위 페이지", "2026-11-05T00:00:00.000Z"),
    page(ROW, "회의", "2026-11-12T00:00:00.000Z", {
      properties: {
        ...title("회의"),
        날짜: { id: "d1", type: "date", date: { start: "2026-11-21", end: null } },
        태그: { id: "t1", type: "multi_select", multi_select: [{ name: "학교" }, { name: "팀" }] },
        상태: { id: "s1", type: "status", status: { name: "진행 중" } },
        메모: { id: "m1", type: "rich_text", rich_text: [] },
      },
    }),
    page(OLD, "지운 페이지", "2026-01-01T00:00:00.000Z", { archived: true }),
  ];
  const hidden = [
    page(HIDDEN, "검색에 안 나오는 페이지", "2026-11-03T00:00:00.000Z"),
    page(ROW2, "자료 행", "2026-11-04T00:00:00.000Z", {
      parent: { type: "database_id", database_id: DB },
      properties: { ...title("자료 행"), 파일: { id: "f%3A", type: "files", files: [{ name: "slides.pdf", type: "file", file: { url: "" } }, { name: "외부", type: "external", external: { url: "https://x.example/a" } }] } },
    }),
  ];
  const byId = () => new Map([...pages, ...hidden].map((p) => [p.id as string, p]));
  let throttled = false;
  let missingFails = true; // a file that fails on the first run only
  let childCalls = 0;
  notion = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/files/missing.png" && missingFails) return new Response("gone", { status: 503 });
      if (url.pathname.startsWith("/files/")) return new Response(`BYTES-${url.pathname}`, { headers: { "Content-Type": "application/octet-stream" } });
      if (req.headers.get("Authorization") !== "Bearer ntn_good") return Response.json({ code: "unauthorized" }, { status: 401 });
      if (req.headers.get("Notion-Version") !== "2022-06-28") return new Response("version", { status: 400 });
      const slice = (list: unknown[], cursor: string | null | undefined, size: number) => {
        const i = Number(cursor ?? 0);
        const more = i + size < list.length;
        return Response.json({ results: list.slice(i, i + size), has_more: more, next_cursor: more ? String(i + size) : null });
      };
      if (url.pathname === "/v1/search" && req.method === "POST") {
        if (!throttled) return ((throttled = true), new Response("slow down", { status: 429, headers: { "Retry-After": "0" } }));
        const b = await req.json();
        if (b.filter?.value === "database") return slice([], undefined, 1);
        if (b.filter?.value !== "page") return new Response("filter", { status: 400 });
        return slice(pages, b.start_cursor, 2);
      }
      const pg = url.pathname.match(/^\/v1\/pages\/([^/]+)$/);
      if (pg) return byId().has(pg[1]!) ? Response.json(byId().get(pg[1]!)) : new Response("not found", { status: 404 });
      const dq = url.pathname.match(/^\/v1\/databases\/([^/]+)\/query$/);
      if (dq && req.method === "POST") {
        if (dq[1] !== DB) return new Response("not found", { status: 404 });
        // Row file links are signed fresh on every read.
        (hidden[1]!.properties as any).파일.files[0].file.url = fileUrl("slides.pdf");
        return slice([pages[2], hidden[1]], (await req.json()).start_cursor, 1);
      }
      const m = url.pathname.match(/^\/v1\/blocks\/([^/]+)\/children$/);
      const list = m && children.get(m[1]!);
      if (!list) return new Response("not found", { status: 404 });
      childCalls++;
      // File links are signed fresh on every read.
      for (const b of list as any[]) if (b.image?.type === "file") b.image.file.url = fileUrl(b.image.file.name);
      return slice(list, url.searchParams.get("start_cursor"), 4);
    },
  });
  const file = (name: string) => ({ type: "file", file: { name, url: "" }, caption: [] });
  // 35 toggles inside each other: the import goes 30 levels below the top and says the rest is missing.
  let deep: object = blk("paragraph", { rich_text: [rt("바닥")] });
  for (let i = 35; i >= 1; i--) deep = blk("toggle", { rich_text: [rt(`단계 ${i}`)] }, [deep]);
  children.set(A, [
    blk("heading_1", { rich_text: [rt("1주차")] }),
    blk("paragraph", { rich_text: [rt("굵게 "), rt("링크", { href: "https://example.com" })] }),
    blk("to_do", { checked: false, rich_text: [rt("과제 제출 "), { type: "mention", plain_text: "2026년 11월 20일", mention: { type: "date", date: { start: "2026-11-20T09:00:00.000+09:00" } } }] }),
    blk("to_do", { checked: true, rich_text: [rt("끝난 일")] }),
    blk("bulleted_list_item", { rich_text: [rt("항목")] }, [blk("bulleted_list_item", { rich_text: [rt("하위 항목")] })]),
    blk("table", { table_width: 2 }, [blk("table_row", { cells: [[rt("a")], [rt("b")]] }), blk("table_row", { cells: [[rt("1")], [rt("2")]] })]),
    blk("image", file("board.png")),
    blk("image", file("missing.png")),
    blk("image", { type: "external", external: { url: "https://img.example/x.png" }, caption: [rt("외부 그림")] }),
    blk("child_page", { title: "하위 페이지" }, undefined, SUB),
    blk("child_page", { title: "검색에 안 나오는 페이지" }, undefined, HIDDEN),
    blk("child_database", { title: "자료" }, undefined, DB),
    blk("code", { rich_text: [rt("print(1)")], language: "python" }),
    blk("divider", {}),
    blk("callout", { rich_text: [rt("주의")], icon: { type: "emoji", emoji: "💡" } }),
    blk("column_list", {}, [blk("column", {}, [blk("paragraph", { rich_text: [rt("왼쪽")] })])]),
    blk("unsupported", {}),
  ]);
  children.set(SUB, [blk("paragraph", { rich_text: [rt("하위 내용")] })]);
  children.set(HIDDEN, [deep]);
  children.set(ROW, []);
  children.set(ROW2, []);

  const { call, db, cleanup } = makeApp({ notionApi: notion.url.toString().replace(/\/$/, "") });
  try {
    const { cookie } = await login(call);
    const req = (path: string, method: string, b?: object) => call(path, { method, cookie, headers: JSON_ORIGIN, body: b ? JSON.stringify(b) : undefined });
    const status = async () => (await (await req("/api/notion/import", "GET")).json()) as Record<string, unknown>;
    const finish = async () => {
      for (let i = 0; i < 1000; i++) {
        const j = await status();
        if (j.status !== "running") return j;
        await Bun.sleep(5);
      }
      throw new Error("가져오기가 끝나지 않음");
    };
    const run = async () => {
      expect((await req("/api/notion/import", "POST", { token: "ntn_good" })).status).toBe(202);
      return finish();
    };
    const attached = async (noteId: number) =>
      ((await (await req(`/api/attachments?note=${noteId}`, "GET")).json()) as { title: string; drive_id: string; tags: string }[]).map((f) => f.title);

    expect((await call("/api/notion/import", { method: "POST", headers: JSON_ORIGIN, body: JSON.stringify({ token: "ntn_good" }) })).status).toBe(401);
    expect(await status()).toEqual({ status: "idle" });
    expect((await req("/api/notion/import", "POST", {})).status).toBe(400);
    expect((await req("/api/notion/import", "POST", { token: "ntn_bad" })).status).toBe(202);
    const bad = await finish();
    expect(bad.status).toBe("failed");
    expect(bad.error).toContain("토큰");

    // One run at a time; Notion's "slow down" (429) is waited out.
    expect((await req("/api/notion/import", "POST", { token: "ntn_good" })).status).toBe(202);
    expect((await req("/api/notion/import", "POST", { token: "ntn_good" })).status).toBe(409);
    // Pages search missed are found through the page and the database that hold them.
    expect(await finish()).toMatchObject({
      status: "done", total: 5, done: 5, added: 5, updated: 0, unchanged: 0, skipped: [], failed: [], partial: ["검색에 안 나오는 페이지"], files: 2, fileProblems: 1,
    });

    // Notes keep Notion's titles (with the page icon) and edit times, so the list is in Notion's order.
    const list = (await (await req("/api/notes", "GET")).json()) as { id: number; title: string; updated_at: string }[];
    expect(list.map((x) => [x.title, x.updated_at])).toEqual([
      ["회의", "2026-11-12 00:00:00"],
      ["📚 강의 노트", "2026-11-10 01:00:00"],
      ["하위 페이지", "2026-11-05 00:00:00"],
      ["자료 행", "2026-11-04 00:00:00"],
      ["검색에 안 나오는 페이지", "2026-11-03 00:00:00"],
    ]);
    const [rowId, aId, subId, row2Id, hiddenId] = list.map((x) => x.id) as [number, number, number, number, number];
    const a = db.getNote(aId)!;
    expect(a.blocks.map((b) => [b.type, b.text])).toEqual([
      ["h1", "1주차"],
      ["p", "굵게 링크 (https://example.com)"],
      ["todo", "과제 제출"],
      ["todo", "끝난 일"],
      ["bullet", "항목"],
      ["bullet", "하위 항목"],
      ["p", "a | b"],
      ["p", "1 | 2"],
      ["p", "🖼 board.png"],
      ["p", "🖼 missing.png (가져오지 못함: 다운로드 실패 (503))"],
      ["p", "🖼 외부 그림 https://img.example/x.png"],
      ["p", "📄 하위 페이지"],
      ["p", "📄 검색에 안 나오는 페이지"],
      ["p", "🗂 자료"],
      ["code", "print(1)"],
      ["divider", ""],
      ["quote", "💡 주의"],
      ["p", "왼쪽"],
    ]);
    // A dated checkbox is a task on the today screen and calendar; a checked one stays checked.
    expect(a.blocks[2]).toMatchObject({ checked: false, date: "2026-11-20", time: "09:00" });
    expect(a.blocks[3]).toMatchObject({ checked: true });
    const task = db.listTasks({}).find((t) => t.note_id === aId)!;
    expect(task).toMatchObject({ title: "과제 제출", due_date: "2026-11-20", due_time: "09:00", done: 0 });
    // Database columns become lines at the top of the row's note, and files in a column are copied and attached.
    expect(db.getNote(rowId)!.blocks.map((b) => b.text)).toEqual(["날짜: 2026-11-21\n태그: 학교, 팀\n상태: 진행 중"]);
    expect(db.getNote(row2Id)!.blocks.map((b) => b.text)).toEqual(["파일: slides.pdf, 외부 https://x.example/a"]);
    expect(await attached(row2Id)).toEqual(["slides.pdf"]);
    expect(db.getNote(subId)!.blocks.map((b) => b.text)).toEqual(["하위 내용"]);
    // The top level plus 30 nested levels come in, then a line says the rest is missing (the page is listed as partial above).
    const deepNote = db.getNote(hiddenId)!.blocks.map((b) => b.text);
    expect(deepNote.length).toBe(32);
    expect(deepNote[30]).toBe("▸ 단계 31");
    expect(deepNote[31]).toBe("(이 아래 더 깊이 들어간 내용은 가져오지 못했습니다)");

    // The Notion-hosted image is copied into the 파일함 and attached to its note.
    const files = (await (await req(`/api/attachments?note=${aId}`, "GET")).json()) as { title: string; tags: string; drive_id: string }[];
    expect(files.map((f) => [f.title, f.tags])).toEqual([["board.png", "노션"]]);
    expect(drive.get(files[0]!.drive_id)).toMatchObject({ name: "board.png", bytes: "BYTES-/files/board.png".length });

    // A file that failed is tried again on the next run even though Notion has no newer edit.
    missingFails = false;
    expect(await run()).toMatchObject({ status: "done", added: 0, updated: 1, unchanged: 4, files: 1, fileProblems: 0 });
    expect(await attached(aId)).toEqual(["board.png", "missing.png"]);
    expect(db.getNote(aId)!.blocks[9]!.text).toBe("🖼 missing.png");

    // Imported notes save normally from the editor. Editing one here...
    const row = db.getNote(rowId)!;
    expect((await req(`/api/notes/${rowId}`, "PUT", { title: "회의", version: row.version, blocks: [...row.blocks, { id: "mine", type: "p", text: "사이트에서 쓴 글" }] })).status).toBe(200);
    // ...and deleting one.
    await req(`/api/notes/${subId}`, "DELETE");

    // Nothing new in Notion: no page content is read again and nothing is copied again (fresh signatures don't count as new files).
    const calls = childCalls;
    expect(await run()).toMatchObject({ status: "done", total: 5, added: 0, updated: 0, unchanged: 5, skipped: [], files: 0 });
    expect(childCalls).toBe(calls);

    // Edited in Notion: the image is replaced and the other file block removed, so the note's import attachments follow;
    // the note edited here and the deleted one stay as they are.
    for (const p of [...pages, ...hidden]) p.last_edited_time = "2026-11-15T00:00:00.000Z";
    const aKids = children.get(A)! as any[];
    aKids.find((b) => b.image?.file?.name === "board.png").image.file.name = "board-v2.png";
    aKids.splice(aKids.findIndex((b) => b.image?.file?.name === "missing.png"), 1);
    aKids.push(blk("paragraph", { rich_text: [rt("추가한 글")] }));
    expect(await run()).toMatchObject({ status: "done", added: 0, updated: 3, unchanged: 1, skipped: ["회의"], failed: [], files: 1, fileProblems: 0 });
    expect(db.getNote(aId)!.blocks.at(-1)).toMatchObject({ type: "p", text: "추가한 글" });
    expect(await attached(aId)).toEqual(["board-v2.png"]);
    expect(await attached(row2Id)).toEqual(["slides.pdf"]);
    expect(db.getNote(rowId)!.blocks.at(-1)).toMatchObject({ text: "사이트에서 쓴 글" });
    expect(db.getNote(subId)).toBeNull();
    expect(db.listTasks({}).find((t) => t.note_id === aId)!.id).toBe(task.id);
  } finally {
    notion.stop(true);
    cleanup();
  }
});

// A small fake Notion for the tests below: pages by id, what search returns, block children and database rows.
async function notionSetup() {
  const pages = new Map<string, Record<string, unknown>>();
  const search = { page: [] as string[], database: [] as { id: string; title: string }[] };
  const children = new Map<string, object[]>();
  const rows = new Map<string, string[]>();
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/files/")) return new Response(`BYTES-${url.pathname}`);
      if (req.headers.get("Authorization") !== "Bearer ntn_good") return Response.json({}, { status: 401 });
      const all = (results: unknown[]) => Response.json({ results, has_more: false, next_cursor: null });
      if (url.pathname === "/v1/search") {
        const v = (await req.json()).filter.value as "page" | "database";
        return all(v === "page" ? search.page.map((id) => pages.get(id)) : search.database.map((d) => ({ object: "database", id: d.id, title: [{ type: "text", plain_text: d.title }] })));
      }
      const pg = url.pathname.match(/^\/v1\/pages\/([^/]+)$/);
      if (pg) return pages.has(pg[1]!) ? Response.json(pages.get(pg[1]!)) : new Response("no", { status: 404 });
      const dq = url.pathname.match(/^\/v1\/databases\/([^/]+)\/query$/);
      if (dq) return rows.has(dq[1]!) ? all(rows.get(dq[1]!)!.map((id) => pages.get(id))) : new Response("no", { status: 404 });
      const ch = url.pathname.match(/^\/v1\/blocks\/([^/]+)\/children$/);
      if (ch) return children.has(ch[1]!) ? all(children.get(ch[1]!)!) : new Response("no", { status: 404 });
      return new Response("no", { status: 404 });
    },
  });
  let n = 0;
  const id = () => `11111111-0000-0000-0000-${String(++n).padStart(12, "0")}`;
  const page = (title: string, edited = "2026-11-10T00:00:00.000Z") => {
    const pid = id();
    pages.set(pid, { object: "page", id: pid, created_time: "2026-11-01T00:00:00.000Z", last_edited_time: edited, properties: { 이름: { type: "title", title: [{ type: "text", plain_text: title }] } } });
    children.set(pid, []);
    return pid;
  };
  const block = (type: string, data: object, blockId = id(), kids?: object[]) => {
    if (kids) children.set(blockId, kids);
    return { object: "block", id: blockId, type, has_children: !!kids, [type]: data };
  };
  const { call, db, cleanup } = makeApp({ notionApi: server.url.toString().replace(/\/$/, "") });
  const { cookie } = await login(call);
  const req = (path: string, method: string, b?: object) => call(path, { method, cookie, headers: JSON_ORIGIN, body: b ? JSON.stringify(b) : undefined });
  const run = async () => {
    expect((await req("/api/notion/import", "POST", { token: "ntn_good" })).status).toBe(202);
    for (let i = 0; i < 1000; i++) {
      const j = (await (await req("/api/notion/import", "GET")).json()) as Record<string, unknown>;
      if (j.status !== "running") return j;
      await Bun.sleep(5);
    }
    throw new Error("가져오기가 끝나지 않음");
  };
  const noteOf = (title: string) => db.listNotes().find((x) => x.title === title);
  const fileUrl = (name: string) => `${server.url}files/${name}?X-Amz-Signature=${++n}`;
  return { pages, search, children, rows, page, block, id, fileUrl, db, req, run, noteOf, done: () => (server.stop(true), cleanup()) };
}

test("노션 가져오기: 통합에 바로 연결한 최상위 데이터베이스의 행도, 검색에 안 나와도 가져옴", async () => {
  loginEmail = "owner@example.com";
  const t = await notionSetup();
  try {
    const db = t.id();
    const row = t.page("DB에만 있는 행");
    t.rows.set(db, [row]);
    t.search.database.push({ id: db, title: "메모 DB" }, { id: t.id(), title: "링크된 보기" }); // the second can't be queried
    expect(await t.run()).toMatchObject({ status: "done", total: 1, added: 1, partial: ["🗂 링크된 보기"] });
    expect(t.noteOf("DB에만 있는 행")).toBeDefined();
  } finally {
    t.done();
  }
});

test("노션 가져오기: 사이트에서 고친 부모 아래에 노션에서 새로 만든 하위 페이지도 가져옴", async () => {
  loginEmail = "owner@example.com";
  const t = await notionSetup();
  try {
    const parent = t.page("부모");
    t.search.page.push(parent);
    expect(await t.run()).toMatchObject({ status: "done", added: 1 });
    const note = t.db.getNote(t.noteOf("부모")!.id)!;
    expect((await t.req(`/api/notes/${note.id}`, "PUT", { title: "부모", version: note.version, blocks: [{ id: "mine", type: "p", text: "여기서 고침" }] })).status).toBe(200);
    // In Notion: a new child page, inside a toggle, that search does not return.
    const child = t.page("새 하위 페이지");
    t.children.set(parent, [t.block("toggle", { rich_text: [] }, t.id(), [t.block("child_page", { title: "새 하위 페이지" }, child)])]);
    t.pages.get(parent)!.last_edited_time = "2026-11-15T00:00:00.000Z";
    expect(await t.run()).toMatchObject({ status: "done", added: 1, skipped: ["부모"] });
    expect(t.noteOf("새 하위 페이지")).toBeDefined();
    expect(t.db.getNote(note.id)!.blocks.map((b) => b.text)).toEqual(["여기서 고침"]);
  } finally {
    t.done();
  }
});

test("노션 가져오기: 노션 사본 파일이라도 직접 붙인 첨부는 다시 가져와도 떼지 않음", async () => {
  loginEmail = "owner@example.com";
  const t = await notionSetup();
  try {
    const a = t.page("그림 있는 페이지");
    const b = t.page("다른 페이지");
    t.search.page.push(a, b);
    t.children.set(a, [t.block("image", { type: "file", file: { url: t.fileUrl("pic.png") }, caption: [], name: "pic.png" })]);
    t.children.set(b, [t.block("paragraph", { rich_text: [] })]);
    expect(await t.run()).toMatchObject({ status: "done", added: 2, files: 1 });
    const aId = t.noteOf("그림 있는 페이지")!.id;
    const bId = t.noteOf("다른 페이지")!.id;
    const pic = t.db.listAttachments("note", aId)[0]!;
    // The owner attaches that Notion copy to the other note from the 파일함.
    expect((await t.req("/api/attachments", "POST", { note: bId, fileId: pic.id })).status).toBe(201);
    // Both pages change in Notion; the image leaves page A.
    for (const id of [a, b]) t.pages.get(id)!.last_edited_time = "2026-11-15T00:00:00.000Z";
    t.children.set(a, []);
    expect(await t.run()).toMatchObject({ status: "done", updated: 2 });
    expect(t.db.listAttachments("note", aId)).toEqual([]); // the import's own attachment comes off
    expect(t.db.listAttachments("note", bId).map((f) => f.title)).toEqual(["pic.png"]); // the owner's stays
  } finally {
    t.done();
  }
});

test("노션 가져오기: 깊이 제한에 걸린 노트도 편집기에서 그대로 저장됨", async () => {
  loginEmail = "owner@example.com";
  const t = await notionSetup();
  try {
    const p = t.page("깊은 페이지");
    t.search.page.push(p);
    let deep: object = t.block("paragraph", { rich_text: [{ type: "text", plain_text: "바닥" }] });
    for (let i = 0; i < 35; i++) deep = t.block("toggle", { rich_text: [] }, t.id(), [deep]);
    t.children.set(p, [deep]);
    expect(await t.run()).toMatchObject({ status: "done", added: 1, partial: ["깊은 페이지"] });
    const note = t.db.getNote(t.noteOf("깊은 페이지")!.id)!;
    expect(note.blocks.at(-1)!.text).toBe("(이 아래 더 깊이 들어간 내용은 가져오지 못했습니다)");
    expect((await t.req(`/api/notes/${note.id}`, "PUT", { title: note.title, version: note.version, blocks: note.blocks })).status).toBe(200);
  } finally {
    t.done();
  }
});

test("노션 가져오기: 노션의 상위·하위 페이지 구조를 노트 목록에서도 그대로 둠", async () => {
  loginEmail = "owner@example.com";
  const t = await notionSetup();
  try {
    // 개인 페이지 TODO LIST 밑에 하위 페이지(토글 안 포함)와 데이터베이스가 있고, 하위 페이지 밑에 또 페이지가 있다.
    const top = t.page("TODO LIST");
    const sub = t.page("하위");
    const inToggle = t.page("토글 안 하위");
    const grand = t.page("손자");
    const other = t.page("ETC");
    const db = t.id();
    const row = t.page("DB 행");
    t.pages.get(row)!.parent = { type: "database_id", database_id: db };
    t.rows.set(db, [row]);
    t.children.set(top, [
      t.block("child_page", { title: "하위" }, sub),
      t.block("toggle", { rich_text: [] }, t.id(), [t.block("child_page", { title: "토글 안 하위" }, inToggle)]),
      t.block("child_database", { title: "DB" }, db),
    ]);
    t.children.set(sub, [t.block("child_page", { title: "손자" }, grand)]);
    t.search.page.push(grand, row, sub, top, other); // search lists children before their parents
    t.search.database.push({ id: db, title: "DB" });
    expect(await t.run()).toMatchObject({ status: "done", added: 6, failed: [] });
    const parentOf = (title: string) => {
      const p = t.noteOf(title)!.parent_id;
      return p === null ? null : t.db.getNote(p)!.title;
    };
    expect(["TODO LIST", "하위", "토글 안 하위", "손자", "DB 행", "ETC"].map(parentOf)).toEqual([null, "TODO LIST", "TODO LIST", "하위", "TODO LIST", null]);

    // Notes imported flat before this change get their parents on the next run, even with nothing new in Notion.
    for (const n of t.db.listNotes()) t.db.setNoteParent(n.id, null);
    expect(await t.run()).toMatchObject({ status: "done", unchanged: 6 });
    expect(parentOf("손자")).toBe("하위");

    // Deleting a note here moves the notes under it up one level instead of deleting them, and the next import keeps them there.
    await t.req(`/api/notes/${t.noteOf("하위")!.id}`, "DELETE");
    expect(parentOf("손자")).toBe("TODO LIST");
    expect(await t.run()).toMatchObject({ status: "done" });
    expect(t.noteOf("하위")).toBeUndefined();
    expect(parentOf("손자")).toBe("TODO LIST");
    expect(parentOf("토글 안 하위")).toBe("TODO LIST");
  } finally {
    t.done();
  }
});

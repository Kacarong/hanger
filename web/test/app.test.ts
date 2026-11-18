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
        return Response.json({ access_token: "at", expires_in: 3600, refresh_token: "rt", id_token: idToken(loginEmail) });
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

function makeApp(opts: { googleEnabled?: boolean; now?: () => Date } = {}) {
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
    { baseUrl: "https://kacarong.kr", adminEmail: "owner@example.com", dataDir, googleEnabled: opts.googleEnabled ?? true, now: opts.now },
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
  expect(redirect.searchParams.get("scope")).toContain("drive.file");
  expect(redirect.searchParams.get("access_type")).toBe("offline");
  const state = redirect.searchParams.get("state")!;
  const res = await call(`/auth/callback?state=${state}&code=${code}`, { cookie: `oauth_state=${state}` });
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
      call("/api/uploads/status", { method: "POST", cookie, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ uploadUrl: u, size }) });
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
      headers: { "Content-Type": "application/json" },
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
    const pub = await call(`/api/files/${row.id}/public`, { method: "POST", cookie, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ public: true }) });
    expect(await pub.json()).toMatchObject({ shared: 1, public: 1 });
    expect(drive.get(driveFile.id)!.anyone).toBe(true);
    const page = await (await call("/")).text();
    expect(page).toContain("작품.png");
    expect(page).toContain(`https://drive.example/view/${driveFile.id}`);
    const thumb = await call(`/thumb/${row.id}`);
    expect(thumb.status).toBe(200);
    expect(await thumb.text()).toBe("PNGDATA");

    // Turning sharing off makes it private on Drive and drops it from the public page.
    const off = await call(`/api/files/${row.id}/share`, { method: "POST", cookie, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shared: false }) });
    expect(await off.json()).toMatchObject({ shared: 0, public: 0 });
    expect(drive.get(driveFile.id)!.anyone).toBe(false);
    expect(await (await call("/")).text()).not.toContain("작품.png");

    // Delete moves the Drive file to trash.
    expect((await call(`/api/files/${row.id}`, { method: "DELETE", cookie })).status).toBe(200);
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
    expect((await call("/auth/callback?state=a&code=good-code", { cookie: "oauth_state=b" })).status).toBe(400);
    const { cookie } = await login(call);
    const json = { "Content-Type": "application/json" };

    const big = await call("/api/uploads", { method: "POST", cookie, headers: json, body: JSON.stringify({ name: "a.zip", size: 1024 ** 3, mimeType: "" }) });
    expect(big.status).toBe(413);

    const outside: FakeFile = { id: "outside1", name: "x", mimeType: "text/plain", parents: ["other"], trashed: false, anyone: false, bytes: 1 };
    drive.set(outside.id, outside);
    expect((await call("/api/files", { method: "POST", cookie, headers: json, body: JSON.stringify({ driveId: "outside1" }) })).status).toBe(400);

    const cross = await call("/api/uploads", { method: "POST", cookie, headers: { ...json, Origin: "https://evil.example" }, body: JSON.stringify({ name: "a", size: 1 }) });
    expect(cross.status).toBe(403);
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

test("첫 업로드를 동시에 여러 개 시작해도 드라이브 폴더는 하나만 생성", async () => {
  loginEmail = "owner@example.com";
  const { call, db, cleanup } = makeApp();
  try {
    const { cookie } = await login(call);
    const before = foldersCreated;
    const start = () =>
      call("/api/uploads", { method: "POST", cookie, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "a.txt", size: 10, mimeType: "text/plain" }) });
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

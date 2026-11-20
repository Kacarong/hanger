import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { openDb } from "../src/db";
import { createGoogle } from "../src/google";

// A small stand-in for the Google OAuth + Drive endpoints the app uses.
type FakeFile = { id: string; name: string; mimeType: string; parents: string[]; trashed: boolean; bytes: number; content?: string };
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
          const f: FakeFile = { id: `f${nextId++}`, name: u.name, mimeType: u.mimeType, parents: u.parents, trashed: false, bytes: u.size };
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
        const f: FakeFile = { id: `folder${nextId++}`, name: meta.name, mimeType: meta.mimeType, parents: meta.parents ?? [], trashed: false, bytes: 0 };
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

      const m = p.match(/^\/drive\/v3\/files\/([^/]+)$/);
      const f = m && drive.get(m[1]!);
      if (!f) return new Response("not found", { status: 404 });
      if (req.method === "PATCH") {
        Object.assign(f, await req.json());
        const add = url.searchParams.get("addParents");
        const remove = url.searchParams.get("removeParents");
        if (add || remove) {
          if (!remove || !f.parents.includes(remove)) return new Response("not a parent", { status: 400 });
          f.parents = [...f.parents.filter((x) => x !== remove), add!];
        }
        return Response.json(fileJson(f));
      }
      if (url.searchParams.get("alt") === "media") {
        const bytes = Buffer.from(f.content ?? "x".repeat(f.bytes));
        const r = req.headers.get("Range")?.match(/^bytes=(\d+)-(\d*)$/);
        if (!r) return new Response(bytes, { headers: { "Content-Type": f.mimeType, "Content-Length": String(bytes.length) } });
        const start = Number(r[1]);
        const end = r[2] ? Number(r[2]) : bytes.length - 1;
        if (start >= bytes.length) return new Response("range", { status: 416, headers: { "Content-Range": `bytes */${bytes.length}` } });
        return new Response(bytes.subarray(start, end + 1), { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${bytes.length}`, "Content-Length": String(end - start + 1) } });
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
    { baseUrl: "https://kacarong.kr", adminEmail: "owner@example.com", dataDir, googleEnabled: opts.googleEnabled ?? true, now: opts.now, notionApi: opts.notionApi, notionDebounceMs: 0 },
    db,
    google,
  );
  const call = (path: string, init: RequestInit & { cookie?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (init.cookie) headers.set("Cookie", init.cookie);
    return fetch(new Request("https://kacarong.kr" + path, { ...init, headers }));
  };
  return { call, db, notion: fetch.notion, moveNotionCopies: fetch.moveNotionCopies, cleanup: () => rmSync(dataDir, { recursive: true, force: true }) };
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

test("클라우드: 로그인 → 업로드 → 사이트에서 열기·받기 → 폴더(드라이브에도 같은 구조) → 휴지통", async () => {
  loginEmail = "owner@example.com";
  const { call, db, cleanup } = makeApp();
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

    // Not in any portfolio: nobody else can see it or its thumbnail, and the public page doesn't show it.
    expect(await (await call("/")).text()).not.toContain("작품.png");
    expect((await call(`/thumb/${row.id}`)).status).toBe(404);
    expect((await call(`/portfolio/file/${row.id}`)).status).toBe(404);
    expect((await call(`/api/files/${row.id}/content`)).status).toBe(401);

    // Opening and downloading go through this site, not Google's pages. A PNG opens in place, sandboxed.
    drive.get(driveFile.id)!.content = "PNG-BYTES";
    const open = await call(`/api/files/${row.id}/content`, { cookie });
    expect(open.status).toBe(200);
    expect(await open.text()).toBe("PNG-BYTES");
    expect(open.headers.get("Content-Type")).toBe("image/png");
    expect(open.headers.get("Content-Disposition")).toStartWith("inline;");
    expect(open.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(open.headers.get("Cache-Control")).toBe("no-store");
    const dl = await call(`/api/files/${row.id}/content?download=1`, { cookie });
    expect(dl.headers.get("Content-Disposition")).toBe(`attachment; filename="__.png"; filename*=UTF-8''${encodeURIComponent("작품.png")}`);
    expect(dl.headers.get("Content-Type")).toBe("application/octet-stream");
    // Ranges pass through, so a video can seek.
    const part = await call(`/api/files/${row.id}/content`, { cookie, headers: { Range: "bytes=4-8" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("Content-Range")).toBe("bytes 4-8/9");
    expect(await part.text()).toBe("BYTES");
    // A file that could run as a page here (HTML, SVG, ...) is only ever downloaded.
    const html = db.insertFile({ drive_id: "html1", name: "x.html", title: "x.html", mime: "text/html", size: 5, category: "기타", tags: "", note: "" });
    drive.set("html1", { id: "html1", name: "x.html", mimeType: "text/html", parents: [rootId], trashed: false, bytes: 5, content: "<b>x" });
    const page = await call(`/api/files/${html.id}/content`, { cookie });
    expect(page.headers.get("Content-Disposition")).toStartWith("attachment;");
    expect(page.headers.get("Content-Type")).toBe("application/octet-stream");

    // Renaming keeps the extension for downloads, and the Drive copy gets the same name.
    const req = (path: string, method: string, b?: object) => call(path, { method, cookie, headers: JSON_ORIGIN, body: b ? JSON.stringify(b) : undefined });
    expect(await (await req(`/api/files/${row.id}`, "PATCH", { title: "로고 시안" })).json()).toMatchObject({ title: "로고 시안" });
    expect(drive.get(driveFile.id)!.name).toBe("로고 시안.png");

    // Folders live here and are mirrored in Drive under the cloud's top folder.
    const folder = async (name: string, parentId: number | null = null) => (await req("/api/folders", "POST", { name, parentId })).json() as Promise<{ id: number; drive_id: string }>;
    const works = await folder("작업");
    const y2026 = await folder("2026", works.id);
    expect(drive.get(works.drive_id)).toMatchObject({ name: "작업", mimeType: "application/vnd.google-apps.folder", parents: [rootId] });
    expect(drive.get(y2026.drive_id)!.parents).toEqual([works.drive_id]);
    expect((await req("/api/folders", "POST", { name: "작업" })).status).toBe(409); // same name in the same place
    expect((await req("/api/folders", "POST", { name: "x", parentId: 9999 })).status).toBe(404);

    // Moving a file moves its Drive copy; each folder lists only its own files.
    expect(await (await req(`/api/files/${row.id}`, "PATCH", { folderId: y2026.id })).json()).toMatchObject({ folder_id: y2026.id });
    expect(drive.get(driveFile.id)!.parents).toEqual([y2026.drive_id]);
    const inFolder = async (f: string) => ((await (await call(`/api/files?folder=${f}`, { cookie })).json()) as { id: number }[]).map((x) => x.id);
    expect(await inFolder(String(y2026.id))).toEqual([row.id]);
    expect(await inFolder("root")).toEqual([html.id]);
    expect((await call("/api/files?folder=9999", { cookie })).status).toBe(404);
    expect(((await (await call("/api/files?q=로고", { cookie })).json()) as unknown[]).length).toBe(1); // a search looks in every folder

    // Uploading straight into a folder.
    const intoFolder = await req("/api/uploads", "POST", { name: "b.txt", size: 3, mimeType: "text/plain", folderId: works.id });
    const up2 = uploads.get(new URL(((await intoFolder.json()) as { uploadUrl: string }).uploadUrl).searchParams.get("upload_id")!)!;
    expect(up2.parents).toEqual([works.drive_id]);

    // Renaming and moving a folder do the same in Drive. A folder can't go inside itself.
    expect((await req(`/api/folders/${works.id}`, "PATCH", { parentId: y2026.id })).status).toBe(400);
    expect(await (await req(`/api/folders/${y2026.id}`, "PATCH", { name: "2026년", parentId: null })).json()).toMatchObject({ name: "2026년", parent_id: null });
    expect(drive.get(y2026.drive_id)).toMatchObject({ name: "2026년", parents: [rootId] });

    // Deleting a folder sends it (and so everything in it) to the Drive trash, and drops its files and subfolders here.
    const inner = await folder("안쪽", y2026.id);
    expect((await req(`/api/folders/${y2026.id}`, "DELETE")).status).toBe(200);
    expect(drive.get(y2026.drive_id)!.trashed).toBe(true);
    expect(db.getFile(row.id)).toBeNull();
    expect(db.getFolder(inner.id)).toBeNull();
    expect(((await (await call("/api/folders", { cookie })).json()) as { name: string }[]).map((f) => f.name)).toEqual(["작업"]);

    // The cloud's own use, and the room left in Drive.
    expect(await (await call("/api/quota", { cookie })).json()).toMatchObject({ files: 1, bytes: 5, drive: { usage: "1024" } });

    // Deleting a file moves the Drive file to trash.
    expect((await req(`/api/files/${html.id}`, "DELETE")).status).toBe(200);
    expect(drive.get("html1")!.trashed).toBe(true);
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

    const outside: FakeFile = { id: "outside1", name: "x", mimeType: "text/plain", parents: ["other"], trashed: false, bytes: 1 };
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
    // CSS가 가리키는 웹폰트가 실제로 열리고, nosniff 아래에서도 쓰이도록 폰트 형식으로 나간다.
    const fonts = [...(await (await call("/static/admin.css")).text()).matchAll(/url\("(\/static\/[\w.-]+\.woff2)"\)/g)].map((m) => m[1]);
    expect(fonts.length).toBe(5);
    for (const f of fonts) {
      const res = await call(f);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("font/woff2");
    }
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
      drive.set(id, { id, name, mimeType: "application/pdf", parents: [], trashed: false, bytes: 10 });
      return db.insertFile({ drive_id: id, name, title: name, mime: "application/pdf", size: 10, category: "과제", tags: "", note: "" });
    };
    const a = addFile("강의자료.pdf");
    const b = addFile("레포트.pdf");
    const note = (await (await req("/api/notes", "POST", { title: "유체역학" })).json()) as { id: number };
    const task = (await (await req("/api/tasks", "POST", { title: "레포트 제출", kind: "과제" })).json()) as { id: number };

    expect((await call(`/api/attachments?note=${note.id}`)).status).toBe(401);
    const list = async (q: string) => (await (await req(`/api/attachments?${q}`, "GET")).json()) as { attachment_id: number; title: string }[];

    // Attach: the reply is the new list. The same file can go on a note and a task, but only once on each.
    const added = await req("/api/attachments", "POST", { note: note.id, fileId: a.id });
    expect(added.status).toBe(201);
    expect(((await added.json()) as { title: string }[]).map((f) => f.title)).toEqual(["강의자료.pdf"]);
    expect((await req("/api/attachments", "POST", { note: note.id, fileId: b.id })).status).toBe(201);
    expect((await req("/api/attachments", "POST", { note: note.id, fileId: a.id })).status).toBe(409);
    expect((await req("/api/attachments", "POST", { task: task.id, fileId: a.id })).status).toBe(201);
    expect((await list(`note=${note.id}`)).map((f) => f.title)).toEqual(["강의자료.pdf", "레포트.pdf"]);
    expect((await list(`task=${task.id}`))[0]).toMatchObject({ title: "강의자료.pdf", id: a.id });
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

test("포트폴리오: 소개·섹션·항목을 자유롭게 고치고, 공개는 kacarong.kr에, 개인용은 내 포트폴리오에만", async () => {
  loginEmail = "owner@example.com";
  const { call, db, cleanup } = makeApp();
  try {
    const { cookie } = await login(call);
    const req = (path: string, method: string, b?: object) => call(path, { method, cookie, headers: JSON_ORIGIN, body: b ? JSON.stringify(b) : undefined });
    const get = async () => (await (await call("/api/portfolio", { cookie })).json()) as { profile: { name: string }; sections: { id: number; title: string; items: { id: number; title: string; public: number; files: { id: number }[] }[] }[] };
    const page = async () => (await call("/")).text();
    const mine = async () => (await call("/admin/portfolio", { cookie })).text();

    // A new portfolio starts with the usual sections. Nothing is shown until there are items.
    expect((await get()).sections.map((s) => s.title)).toEqual(["업적", "작품", "특기", "취미", "내 정보"]);
    expect(await page()).toContain("아직 공개된 항목이 없습니다.");
    expect((await call("/api/portfolio")).status).toBe(401);

    // Profile.
    expect(await (await req("/api/portfolio/profile", "PUT", { name: "카카롱", headline: "만들고 기록합니다", about: "안녕하세요.\n디자인을 공부합니다." })).json()).toEqual({ name: "카카롱", headline: "만들고 기록합니다", about: "안녕하세요.\n디자인을 공부합니다." });
    expect(await page()).toMatch(/카카롱[\s\S]*만들고 기록합니다[\s\S]*디자인을 공부합니다/);

    // Sections: add, rename, reorder, delete.
    const hobby = (await (await req("/api/portfolio/sections", "POST", { title: "봉사" })).json()) as { id: number };
    expect((await req("/api/portfolio/sections", "POST", { title: " " })).status).toBe(400);
    expect(await (await req(`/api/portfolio/sections/${hobby.id}`, "PATCH", { title: "봉사 활동" })).json()).toMatchObject({ title: "봉사 활동" });
    expect(await (await req(`/api/portfolio/sections/${hobby.id}/move`, "POST", { dir: -1 })).json()).toEqual({ moved: true });
    expect((await get()).sections.map((s) => s.title)).toEqual(["업적", "작품", "특기", "취미", "봉사 활동", "내 정보"]);
    expect(await (await req(`/api/portfolio/sections/${(await get()).sections[0]!.id}/move`, "POST", { dir: -1 })).json()).toEqual({ moved: false });
    const [award, work] = (await get()).sections;

    // Items: public ones are on kacarong.kr; private ones only on the owner's page, marked 개인용.
    const add = async (b: object) => (await (await req("/api/portfolio/items", "POST", b)).json()) as { id: number; sort: number };
    const prize = await add({ section_id: award!.id, title: "공모전 대상", period: "2025.10", summary: "교내 디자인 공모전", public: true });
    const diary = await add({ section_id: award!.id, title: "비공개 기록", body: "나만 볼 내용", public: false });
    const logo = await add({ section_id: work!.id, title: "로고 작업", link: "https://example.com/logo", public: true });
    expect((await req("/api/portfolio/items", "POST", { section_id: 9999, title: "x" })).status).toBe(400);
    expect((await req("/api/portfolio/items", "POST", { section_id: award!.id, title: "" })).status).toBe(400);
    expect((await req("/api/portfolio/items", "POST", { section_id: award!.id, title: "x", link: "javascript:alert(1)" })).status).toBe(400);
    let html = await page();
    expect(html).toContain("공모전 대상");
    expect(html).toContain("교내 디자인 공모전");
    expect(html).toContain('href="https://example.com/logo"');
    expect(html).not.toContain("비공개 기록");
    expect(html).not.toContain("봉사 활동"); // a section without public items is left out
    html = await mine();
    expect(html).toMatch(/비공개 기록[\s\S]*<span class="chip">개인용<\/span>/);
    expect(html).toContain("나만 볼 내용");

    // Reorder within a section, move to another section (goes to its end), switch visibility, edit.
    await req(`/api/portfolio/items/${diary.id}/move`, "POST", { dir: -1 });
    expect((await get()).sections[0]!.items.map((i) => i.title)).toEqual(["비공개 기록", "공모전 대상"]);
    await req(`/api/portfolio/items/${prize.id}`, "PATCH", { section_id: work!.id });
    expect((await get()).sections[1]!.items.map((i) => i.title)).toEqual(["로고 작업", "공모전 대상"]);
    await req(`/api/portfolio/items/${diary.id}`, "PATCH", { public: true, title: "이제 공개" });
    expect(await page()).toContain("이제 공개");
    await req(`/api/portfolio/items/${logo.id}`, "PATCH", { public: false });
    expect(await page()).not.toContain("로고 작업");

    // Files from the cloud: the first is the cover. Anyone may fetch the files of public items, nobody else those of private ones.
    const addFile = (name: string, mime: string) => {
      const id = `pf${nextId++}`;
      drive.set(id, { id, name, mimeType: mime, parents: [], trashed: false, bytes: 3, content: "IMG" });
      return db.insertFile({ drive_id: id, name, title: name, mime, size: 3, category: "포트폴리오", tags: "", note: "" });
    };
    const cover = addFile("대상.jpg", "image/jpeg");
    const pdf = addFile("상장.pdf", "application/pdf");
    const secret = addFile("시안.png", "image/png");
    const photo = addFile("나.jpg", "image/jpeg");
    expect((await req("/api/attachments", "POST", { portfolio: prize.id, fileId: cover.id })).status).toBe(201);
    expect((await req("/api/attachments", "POST", { portfolio: prize.id, fileId: pdf.id })).status).toBe(201);
    expect((await req("/api/attachments", "POST", { portfolio: logo.id, fileId: secret.id })).status).toBe(201);
    expect((await req("/api/attachments", "POST", { profile: 0, fileId: photo.id })).status).toBe(201);
    expect((await req("/api/attachments", "POST", { profile: 1, fileId: photo.id })).status).toBe(404);
    expect((await req("/api/attachments", "POST", { portfolio: 9999, fileId: photo.id })).status).toBe(404);
    html = await page();
    expect(html).toContain(`<img src="/portfolio/file/${cover.id}"`);
    expect(html).toContain(`href="/portfolio/file/${pdf.id}">상장.pdf ↓</a>`);
    expect(html).toContain(`class="about-photo" src="/portfolio/file/${photo.id}"`);
    const img = await call(`/portfolio/file/${cover.id}`);
    expect(img.status).toBe(200);
    expect(await img.text()).toBe("IMG");
    expect(img.headers.get("Content-Disposition")).toStartWith("inline;");
    expect(img.headers.get("Cache-Control")).toBe("public, max-age=600");
    expect((await call(`/portfolio/file/${pdf.id}`)).headers.get("Content-Disposition")).toStartWith("attachment;"); // not an image: a download
    expect((await call(`/portfolio/file/${photo.id}`)).status).toBe(200);
    expect((await call(`/portfolio/file/${secret.id}`)).status).toBe(404);
    expect((await call(`/thumb/${secret.id}`)).status).toBe(404);
    expect((await call(`/portfolio/file/${secret.id}`, { cookie })).status).toBe(200); // the owner sees it on their own page
    expect(await mine()).toContain(`/portfolio/file/${secret.id}`);

    // Deleting an item or a section takes their attachments off, the files stay in the cloud.
    await req(`/api/portfolio/items/${logo.id}`, "DELETE");
    await req(`/api/portfolio/sections/${work!.id}`, "DELETE");
    expect((await get()).sections.some((s) => s.id === work!.id)).toBe(false);
    expect(db.getItem(prize.id)).toBeNull();
    expect(db.raw.query("SELECT COUNT(*) AS n FROM attachments WHERE target = 'portfolio'").get()).toEqual({ n: 0 });
    expect(db.getFile(cover.id)).not.toBeNull();
    expect((await call(`/portfolio/file/${cover.id}`)).status).toBe(404);
  } finally {
    cleanup();
  }
});

test("포트폴리오 페이지는 소개·섹션·항목을 HTML 이스케이프", async () => {
  const { call, db, cleanup } = makeApp();
  try {
    db.setProfile({ name: "<b>이름</b>", headline: "<i>h</i>", about: "<script>alert(1)</script>" });
    const s = db.insertSection("<u>s</u>");
    db.insertItem({ section_id: s.id, title: "<script>alert(2)</script>", period: '"><x', summary: "", body: "<img src=x onerror=alert(3)>", link: 'https://e.com/"onmouseover="x', public: 1 });
    const html = await (await call("/")).text();
    expect(html).not.toMatch(/<script>alert|<b>이름|<i>h|<u>s|<img src=x|"onmouseover="/);
    expect(html).toContain("&lt;script&gt;alert(2)");
  } finally {
    cleanup();
  }
});

test("예전 노션 사본은 드라이브에서도 클라우드 폴더 밖(노션 파일 폴더)으로 한 번 옮겨짐", async () => {
  loginEmail = "owner@example.com";
  const { call, db, moveNotionCopies, cleanup } = makeApp();
  try {
    const { cookie } = await login(call);
    const file = (id: string, parents: string[]) => drive.set(id, { id, name: id, mimeType: "image/png", parents, trashed: false, bytes: 3 });
    file("mvroot", []);
    db.setSetting("root_folder_id", "mvroot");
    file("mvn1", ["mvroot"]);
    file("mvu1", ["mvroot"]);
    const add = (drive_id: string, origin: string) => db.insertFile({ drive_id, name: "a.png", title: "a.png", mime: "image/png", size: 3, category: "기타", tags: "", note: "", origin });
    add("mvn1", "notion");
    add("mvgone", "notion"); // no longer in Drive: skipped
    const mine = add("mvu1", "");
    expect((await (await call("/api/files", { cookie })).json()).map((f: { id: number }) => f.id)).toEqual([mine.id]);

    await moveNotionCopies();
    const notionFolder = db.getSetting("notion_folder_id")!;
    expect(drive.get(notionFolder)!.name).toBe("kacarong.kr 노션 파일");
    expect(drive.get("mvn1")!.parents).toEqual([notionFolder]);
    expect(drive.get("mvu1")!.parents).toEqual(["mvroot"]); // the cloud's own file stays
    expect(db.getSetting("notion_copies_moved")).toBe("1");
  } finally {
    cleanup();
  }
});

test("시험: 일정 → 날짜별 공부 계획(오늘·캘린더·할 일에도) → 과목을 바꾸면 계획도 → 시험을 지우면 계획도", async () => {
  const { call, db, cleanup } = makeApp({ googleEnabled: false, now: () => new Date("2026-11-20T03:00:00Z") });
  try {
    db.setSetting("password_hash", await Bun.password.hash("correct horse battery"));
    const { cookie } = await passwordLogin(call, "correct horse battery");
    expect((await call("/api/exams")).status).toBe(401);
    const req = async (path: string, method: string, b?: object) => {
      const r = await call(path, { method, cookie, headers: JSON_ORIGIN, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: (await r.json()) as any };
    };

    const mid = (await req("/api/exams", "POST", { title: "토질역학 중간고사", course: "토질역학", date: "2026-11-30", time: "10:00", place: "공학관 301", scope: "1~5장" })).body;
    expect(mid).toMatchObject({ title: "토질역학 중간고사", course: "토질역학", date: "2026-11-30", time: "10:00", place: "공학관 301", scope: "1~5장", note: "" });
    await req("/api/exams", "POST", { title: "토익", date: "2026-12-20" }); // more than two weeks away
    await req("/api/exams", "POST", { title: "날짜 미정 시험" });
    await req("/api/exams", "POST", { title: "지난 퀴즈", date: "2026-11-10" });
    expect((await req("/api/exams", "POST", { title: "" })).status).toBe(400);
    expect((await req("/api/exams", "POST", { title: "x", date: "2026-02-30" })).status).toBe(400);
    expect((await req("/api/exams", "POST", { title: "x", time: "24:00" })).status).toBe(400);

    // A study plan day is a task of kind 공부 with the exam's course.
    const day1 = (await req("/api/tasks", "POST", { exam_id: mid.id, title: "1장 복습", due_date: "2026-11-20" })).body;
    const day2 = (await req("/api/tasks", "POST", { exam_id: mid.id, title: "2장 문제풀이", due_date: "2026-11-21", kind: "할 일" })).body;
    expect(day1).toMatchObject({ kind: "공부", course: "토질역학", exam_id: mid.id, exam_title: "토질역학 중간고사" });
    expect(day2).toMatchObject({ kind: "공부" });
    expect((await req("/api/tasks", "POST", { exam_id: 9999, title: "x" })).status).toBe(404);

    let list = (await req("/api/exams", "GET")).body;
    expect(list.date).toBe("2026-11-20");
    expect(list.exams.map((e: any) => e.title)).toEqual(["지난 퀴즈", "토질역학 중간고사", "토익", "날짜 미정 시험"]);
    expect(list.exams[1].plan.map((t: any) => t.title)).toEqual(["1장 복습", "2장 문제풀이"]);

    // The today screen shows today's plan day and exams within two weeks; the calendar shows both.
    const today = (await req("/api/today", "GET")).body;
    expect(today.today.map((t: any) => t.title)).toEqual(["1장 복습"]);
    expect(today.exams.map((e: any) => e.title)).toEqual(["토질역학 중간고사"]);
    const cal = (await req("/api/calendar?from=2026-11-01&to=2026-11-30", "GET")).body;
    expect(cal.exams.map((e: any) => e.title)).toEqual(["지난 퀴즈", "토질역학 중간고사"]);
    expect(cal.tasks.map((t: any) => t.title)).toEqual(["1장 복습", "2장 문제풀이"]);

    // Checked off from the today screen, it is done on the 시험 tab too.
    await req(`/api/tasks/${day1.id}`, "PATCH", { done: true });
    expect((await req("/api/exams", "GET")).body.exams[1].plan[0]).toMatchObject({ done: 1, done_at: "2026-11-20" });

    expect((await req(`/api/exams/${mid.id}`, "PATCH", { course: "토질역학1", date: "2026-12-01", time: "" })).body).toMatchObject({ course: "토질역학1", date: "2026-12-01", time: null, title: "토질역학 중간고사" });
    expect(db.getTask(day2.id)).toMatchObject({ course: "토질역학1" });
    expect((await req(`/api/exams/${mid.id}`, "PATCH", { title: " " })).status).toBe(400);
    expect((await req("/api/exams/9999", "PATCH", { title: "x" })).status).toBe(404);

    expect((await req(`/api/exams/${mid.id}`, "DELETE")).status).toBe(200);
    expect([db.getTask(day1.id), db.getTask(day2.id)]).toEqual([null, null]);
    list = (await req("/api/exams", "GET")).body;
    expect(list.exams.map((e: any) => e.title)).toEqual(["지난 퀴즈", "토익", "날짜 미정 시험"]);
  } finally {
    cleanup();
  }
});

test("origin 칸이 없던 DB: 예전 가져오기가 붙인 노션 사본만 노션 사본으로, 직접 올린 파일은 노션 태그여도 클라우드에", () => {
  const dir = mkdtempSync(join(tmpdir(), "folio-test-"));
  try {
    const path = join(dir, "old.db");
    const raw = new Database(path);
    raw.exec(`
      CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, drive_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, title TEXT NOT NULL, mime TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0, category TEXT NOT NULL DEFAULT '기타', tags TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', shared INTEGER NOT NULL DEFAULT 0, public INTEGER NOT NULL DEFAULT 0, web_view_link TEXT NOT NULL DEFAULT '', web_content_link TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')), folder_id INTEGER);
      CREATE TABLE attachments (id INTEGER PRIMARY KEY AUTOINCREMENT, target TEXT NOT NULL CHECK (target IN ('note', 'task', 'portfolio', 'profile')), target_id INTEGER NOT NULL, file_id INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), by_import INTEGER NOT NULL DEFAULT 0, UNIQUE (target, target_id, file_id));
      INSERT INTO files (drive_id, name, title, tags) VALUES ('i1', 'imported.png', 'imported.png', '노션'), ('m1', 'mine.png', 'mine.png', '노션');
      INSERT INTO attachments (target, target_id, file_id, by_import) VALUES ('note', 1, 1, 1), ('note', 1, 2, 0);
    `);
    raw.close();
    const db = openDb(path);
    expect([db.getFile(1)!.origin, db.getFile(2)!.origin]).toEqual(["notion", ""]);
    expect(db.listFiles({}).map((f) => f.title)).toEqual(["mine.png"]);
    db.raw.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("첨부를 노트·할 일에만 붙이던 DB를 열면 첨부는 그대로, 포트폴리오에도 붙일 수 있음", () => {
  const dir = mkdtempSync(join(tmpdir(), "folio-test-"));
  try {
    const path = join(dir, "old.db");
    // The attachments table as it was before (narrower check, by_import added later), with one attachment in it.
    const raw = new Database(path);
    raw.exec(`
      CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, drive_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, title TEXT NOT NULL, mime TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0, category TEXT NOT NULL DEFAULT '기타', tags TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', shared INTEGER NOT NULL DEFAULT 0, public INTEGER NOT NULL DEFAULT 0, web_view_link TEXT NOT NULL DEFAULT '', web_content_link TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE attachments (id INTEGER PRIMARY KEY AUTOINCREMENT, target TEXT NOT NULL CHECK (target IN ('note', 'task')), target_id INTEGER NOT NULL, file_id INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (target, target_id, file_id));
      CREATE TRIGGER attachments_file_gone AFTER DELETE ON files BEGIN DELETE FROM attachments WHERE file_id = old.id; END;
      INSERT INTO files (drive_id, name, title) VALUES ('d1', 'a.pdf', 'a.pdf');
      INSERT INTO files (drive_id, name, title, tags) VALUES ('d2', 'Untitled.png', 'Untitled.png', '노션');
      INSERT INTO files (drive_id, name, title, tags) VALUES ('d3', '노션 정리.pdf', '노션 정리.pdf', '노션');
      INSERT INTO files (drive_id, name, title, tags) VALUES ('d4', 'old.png', 'old.png', '노션');
      CREATE TABLE notion_files (block_id TEXT PRIMARY KEY, file_id INTEGER NOT NULL);
      INSERT INTO notion_files (block_id, file_id) VALUES ('b1', 2);
      INSERT INTO attachments (target, target_id, file_id) VALUES ('note', 7, 1);
    `);
    raw.close();
    const db = openDb(path);
    expect(db.listAttachments("note", 7).map((f) => f.title)).toEqual(["a.pdf"]);
    expect(db.getFile(1)!.folder_id).toBeNull();
    // A copy the Notion import made is no longer one of the cloud's files; an upload the owner tagged 노션 still is.
    expect([1, 2, 3, 4].map((id) => db.getFile(id)!.origin)).toEqual(["", "notion", "", ""]);
    expect(db.listFiles({}).map((f) => f.title)).toEqual(["old.png", "노션 정리.pdf", "a.pdf"]);
    expect(db.usage().files).toBe(3);
    const s = db.insertSection("작품");
    const item = db.insertItem({ section_id: s.id, title: "t", period: "", summary: "", body: "", link: "", public: 1 });
    expect(db.addAttachment("portfolio", item.id, 1)).toBe(true);
    expect(db.isPublicFile(1)).toBe(true);
    db.deleteFile(1); // the triggers came back with the new table
    expect(db.raw.query("SELECT COUNT(*) AS n FROM attachments").get()).toEqual({ n: 0 });
    db.raw.close();
    expect(openDb(path).listSections().map((x) => x.title)).toEqual(["업적", "작품", "특기", "취미", "내 정보", "작품"]); // seeded once only
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Notion two-way sync, against a small in-memory Notion: pages, a block tree, databases.
type NB = { object: "block"; id: string; type: string; has_children: boolean; archived: boolean; parent: string } & Record<string, any>;
function fakeNotion() {
  let n = 0;
  let minute = 0;
  const clock = () => new Date(Date.UTC(2026, 10, 10, 0, minute)).toISOString();
  const id = () => `22222222-0000-0000-0000-${String(++n).padStart(12, "0")}`;
  const pages = new Map<string, Record<string, any>>();
  const blocks = new Map<string, NB>();
  const kids = new Map<string, string[]>();
  const dbs = new Map<string, { parent: string; title: string; rows: string[] }>();
  const calls: string[] = [];
  const ctl = { failNext: null as RegExp | null, skip: 0 }; // the next request matching this (after `skip` of them) fails once
  const plainOf = (rt: any[]) => rt.map((t) => (t.type === "text" ? t.text.content : t.type === "equation" ? t.equation.expression : t.mention.type === "date" ? `@${t.mention.date.start}` : "@멘션")).join("");
  // Fills rich text in the way Notion answers it.
  const rich = (rt: any[] = []) =>
    rt.map((t) => ({ ...t, annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default", ...t.annotations }, plain_text: plainOf([t]), href: t.text?.link?.url ?? null }));
  const pageOf = (blockOrPage: string): string => (pages.has(blockOrPage) ? blockOrPage : pageOf(blocks.get(blockOrPage)!.parent));
  const touch = (where: string) => {
    minute++;
    const p = pages.get(pageOf(where));
    if (p) p.last_edited_time = clock();
  };
  const store = (parent: string, raw: any): NB => {
    const bid = id();
    const { children, object: _o, type, ...rest } = raw;
    const data = { ...(rest[type] ?? {}) };
    const inner = data.children;
    delete data.children;
    for (const k of ["rich_text", "caption"]) if (data[k]) data[k] = rich(data[k]);
    if (type === "table_row") data.cells = data.cells.map((c: any[]) => rich(c));
    if (data.type === "external") data.external = { url: data.external.url };
    const b: NB = { object: "block", id: bid, type, has_children: false, archived: false, parent, [type]: data };
    blocks.set(bid, b);
    kids.set(bid, []);
    for (const k of inner ?? children ?? []) insert(bid, [k], null);
    return b;
  };
  function insert(parent: string, list: any[], after: string | null | "start" = null): NB[] {
    const arr = kids.get(parent)!;
    let at = after === null ? arr.length : after === "start" ? 0 : arr.indexOf(after) + 1;
    const made = list.map((raw) => store(parent, raw));
    for (const b of made) arr.splice(at++, 0, b.id);
    const pb = blocks.get(parent);
    if (pb) pb.has_children = arr.length > 0;
    return made;
  }
  const page = (title: string, parent: { type: string; page_id?: string; database_id?: string } = { type: "workspace" }, extra: Record<string, any> = {}) => {
    const pid = id();
    pages.set(pid, { object: "page", id: pid, parent, created_time: clock(), last_edited_time: clock(), archived: false, icon: null, properties: { title: { id: "title", type: "title", title: rich([{ type: "text", text: { content: title } }]) } }, ...extra });
    kids.set(pid, []);
    if (parent.type === "page_id") {
      const b = store(parent.page_id!, { type: "child_page", child_page: { title } });
      blocks.delete(b.id);
      blocks.set(pid, { ...b, id: pid });
      kids.get(parent.page_id!)!.push(pid);
      touch(parent.page_id!);
    }
    return pid;
  };
  const tree = (pid: string): any[] => kids.get(pid)!.map((k) => {
    const b = blocks.get(k)!;
    const d = b[b.type];
    const text = d.rich_text ? d.rich_text.map((t: any) => t.plain_text).join("") : d.cells ? d.cells.map((c: any[]) => c.map((t) => t.plain_text).join("")).join("|") : d.title ?? d.expression ?? d.external?.url ?? "";
    const sub = b.type === "child_page" ? [] : tree(k);
    return sub.length ? [b.type, text, sub] : [b.type, text];
  });
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;
      if (p.startsWith("/files/")) return new Response(`BYTES-${p}`, { headers: { "Content-Type": "image/png" } });
      if (req.headers.get("Authorization") !== "Bearer ntn_good") return Response.json({ message: "unauthorized" }, { status: 401 });
      const version = req.headers.get("Notion-Version");
      calls.push(`${req.method} ${p}`);
      if (ctl.failNext?.test(`${req.method} ${p}`) && ctl.skip-- <= 0) {
        ctl.failNext = null;
        ctl.skip = 0;
        return new Response("injected failure", { status: 400 });
      }
      const body = req.method === "GET" || req.method === "DELETE" ? {} : await req.json();
      const list = (results: unknown[]) => Response.json({ object: "list", results, has_more: false, next_cursor: null });
      if (p === "/v1/users/me") return Response.json({ object: "user", id: "me" });
      if (p === "/v1/search") {
        if (body.filter.value === "database") return list([...dbs].map(([did, d]) => ({ object: "database", id: did, title: rich([{ type: "text", text: { content: d.title } }]), parent: d.parent ? { type: "page_id", page_id: d.parent } : { type: "workspace" } })));
        const all = [...pages.values()].filter((x) => !x.archived).sort((a, b) => b.last_edited_time.localeCompare(a.last_edited_time));
        return list(all);
      }
      let m = p.match(/^\/v1\/pages\/([^/]+)$/);
      if (m) {
        const pg = pages.get(m[1]!);
        if (!pg) return new Response("{}", { status: 404 });
        if (req.method === "PATCH") {
          if (body.archived) {
            pg.archived = true;
            const parent = pg.parent.page_id;
            if (parent) kids.set(parent, kids.get(parent)!.filter((k) => k !== pg.id));
          }
          for (const [k, v] of Object.entries(body.properties ?? {}) as [string, any][]) pg.properties[k] = { ...pg.properties[k], title: rich(v.title) };
          minute++;
          pg.last_edited_time = clock();
        }
        return Response.json(pg);
      }
      if (p === "/v1/pages" && req.method === "POST") {
        const pid = page(plainOf(body.properties.title.title), { type: "page_id", page_id: body.parent.page_id });
        return Response.json(pages.get(pid));
      }
      m = p.match(/^\/v1\/blocks\/([^/]+)\/children$/);
      if (m) {
        const parent = m[1]!;
        if (!kids.has(parent)) return new Response("{}", { status: 404 });
        if (req.method === "GET") return list(kids.get(parent)!.map((k) => blocks.get(k)));
        if (body.position && version !== "2026-03-11") return new Response("position needs 2026-03-11", { status: 400 });
        if (body.after) return new Response("after is gone in 2026-03-11", { status: 400 });
        const pos = body.position?.type === "start" ? "start" : body.position?.type === "after_block" ? body.position.after_block.id : null;
        if (pos !== null && pos !== "start" && !kids.get(parent)!.includes(pos)) return new Response("no such sibling", { status: 400 });
        const made = insert(parent, body.children, pos);
        touch(parent);
        return list(made);
      }
      m = p.match(/^\/v1\/blocks\/([^/]+)$/);
      if (m) {
        const b = blocks.get(m[1]!);
        if (!b || b.archived) return new Response("{}", { status: 404 });
        if (req.method === "DELETE") {
          b.archived = true;
          kids.set(b.parent, kids.get(b.parent)!.filter((k) => k !== b.id));
          if (b.type === "child_page") pages.get(b.id)!.archived = true;
          touch(b.parent);
          return Response.json(b);
        }
        const [type] = Object.keys(body);
        if (type !== b.type) return new Response(`can't change ${b.type} to ${type}`, { status: 400 });
        const data = { ...body[type!] };
        for (const k of ["rich_text", "caption"]) if (data[k]) data[k] = rich(data[k]);
        if (type === "table_row") data.cells = data.cells.map((c: any[]) => rich(c));
        b[type!] = { ...b[type!], ...data };
        touch(b.parent);
        return Response.json(b);
      }
      m = p.match(/^\/v1\/databases\/([^/]+)(\/query)?$/);
      if (m) {
        const d = dbs.get(m[1]!);
        if (!d) return new Response("{}", { status: 404 });
        if (m[2]) return list(d.rows.map((r) => pages.get(r)));
        return Response.json({ object: "database", id: m[1], parent: { type: "page_id", page_id: d.parent } });
      }
      return new Response("unknown", { status: 404 });
    },
  });
  const edit = (bid: string, data: Record<string, any>) => {
    const b = blocks.get(bid)!;
    for (const k of ["rich_text", "caption"]) if (data[k]) data[k] = rich(data[k]);
    b[b.type] = { ...b[b.type], ...data };
    touch(b.parent);
  };
  const txt = (content: string, annotations?: object, link?: string) => ({ type: "text", text: { content, link: link ? { url: link } : null }, ...(annotations ? { annotations } : {}) });
  return { server, url: server.url.toString().replace(/\/$/, ""), pages, blocks, kids, dbs, calls, ctl, page, insert, tree, edit, txt, touch, id };
}

async function notionApp() {
  const nt = fakeNotion();
  const app = makeApp({ notionApi: nt.url });
  const { cookie } = await login(app.call);
  const req = (path: string, method: string, b?: object) => app.call(path, { method, cookie, headers: JSON_ORIGIN, body: b ? JSON.stringify(b) : undefined });
  const getNote = async (id: number) => (await (await req(`/api/notes/${id}`, "GET")).json()) as { id: number; title: string; version: number; blocks: any[]; links: Record<string, { id: number; title: string }>; notion: { url: string; props: [string, string][] } | null };
  const noteOf = (title: string) => app.db.listNotes().find((x) => x.title === title)!;
  const save = async (id: number, blocks: object[], title?: string) => {
    const n = await getNote(id);
    const r = await req(`/api/notes/${id}`, "PUT", { title: title ?? n.title, blocks, version: n.version });
    expect(r.status).toBe(200);
    await app.notion.idle();
    return (await r.json()) as { version: number };
  };
  return { nt, ...app, req, getNote, noteOf, save, done: () => (nt.server.stop(true), app.cleanup()) };
}

test("노션 연동: 연결하면 페이지를 서식·들여쓰기·토글·표·사진 그대로 노트로, 하위 페이지·DB 행은 트리로", async () => {
  loginEmail = "owner@example.com";
  const t = await notionApp();
  try {
    const { nt } = t;
    const A = nt.page("강의 노트", undefined, { icon: { type: "emoji", emoji: "📚" } });
    nt.insert(A, [
      { type: "paragraph", paragraph: { rich_text: [nt.txt("굵게", { bold: true }), nt.txt(" 그리고 "), nt.txt("링크", undefined, "https://example.com")], color: "blue" } },
      { type: "bulleted_list_item", bulleted_list_item: { rich_text: [nt.txt("항목")], children: [{ type: "bulleted_list_item", bulleted_list_item: { rich_text: [nt.txt("안쪽 항목")] } }] } },
      { type: "toggle", toggle: { rich_text: [nt.txt("접는 글")], children: [{ type: "paragraph", paragraph: { rich_text: [nt.txt("숨은 내용")] } }] } },
      { type: "to_do", to_do: { checked: false, rich_text: [nt.txt("과제 제출 "), { type: "mention", mention: { type: "date", date: { start: "2026-11-21" } } }] } },
      { type: "callout", callout: { rich_text: [nt.txt("알림")], icon: { type: "emoji", emoji: "💡" }, color: "gray_background" } },
      { type: "table", table: { table_width: 2, has_column_header: true, has_row_header: false, children: [{ type: "table_row", table_row: { cells: [[nt.txt("이름")], [nt.txt("값")]] } }, { type: "table_row", table_row: { cells: [[nt.txt("a")], [nt.txt("1", { bold: true })]] } }] } },
      { type: "image", image: { type: "file", file: { url: `${nt.url}/files/photo.png?X-Amz-Signature=1` }, caption: [nt.txt("사진 설명")] } },
      { type: "button", button: {} },
    ]);
    const SUB = nt.page("하위 페이지", { type: "page_id", page_id: A });
    nt.insert(SUB, [{ type: "paragraph", paragraph: { rich_text: [nt.txt("하위 내용")] } }]);
    const DB = nt.id();
    nt.dbs.set(DB, { parent: A, title: "회의록", rows: [] });
    const ROW = nt.page("회의", { type: "database_id", database_id: DB }, {});
    nt.pages.get(ROW)!.properties.상태 = { id: "s", type: "status", status: { name: "진행 중" } };
    nt.dbs.get(DB)!.rows.push(ROW);
    nt.insert(A, [{ type: "child_database", child_database: { title: "회의록" } }]);

    // A wrong token is refused; the right one is kept and a full pass starts.
    expect((await t.req("/api/notion", "PUT", { token: "ntn_bad" })).status).toBe(400);
    expect(await (await t.req("/api/notion", "GET")).json()).toMatchObject({ connected: false });
    expect((await t.req("/api/notion", "PUT", { token: "ntn_good" })).status).toBe(200);
    await t.notion.idle();
    expect(t.db.getSetting("notion_token")).toBe("ntn_good");
    expect(await (await t.req("/api/notion", "GET")).json()).toMatchObject({ connected: true, running: false, error: null, failed: [] });

    const a = await t.getNote(t.noteOf("📚 강의 노트").id);
    const types = a.blocks.map((b) => [b.type, b.text, b.d ?? 0]);
    expect(types).toEqual([
      ["p", "굵게 그리고 링크", 0],
      ["bullet", "항목", 0],
      ["bullet", "안쪽 항목", 1],
      ["toggle", "접는 글", 0],
      ["p", "숨은 내용", 1],
      ["todo", "과제 제출", 0],
      ["callout", "알림", 0],
      ["table", "이름 | 값\na | 1", 0],
      ["image", "사진 설명", 0],
      ["opaque", "", 0],
      ["page", "하위 페이지", 0],
      ["db", "회의록", 0],
    ]);
    expect(a.blocks[0]).toMatchObject({ color: "blue", rich: [{ t: "굵게", b: 1 }, { t: " 그리고 " }, { t: "링크", href: "https://example.com" }] });
    expect(a.blocks[5]).toMatchObject({ date: "2026-11-21", checked: false });
    expect(a.blocks[6]).toMatchObject({ icon: "💡", color: "gray_background" });
    expect(a.blocks[7]).toMatchObject({ width: 2, colHeader: 1, rows: [{ cells: [[{ t: "이름" }], [{ t: "값" }]] }, { cells: [[{ t: "a" }], [{ t: "1", b: 1 }]] }] });
    expect(a.blocks[9]).toMatchObject({ nt: "button" });
    // The Notion-hosted picture is copied into the 파일함 and shown from there.
    const photo = t.db.getFile(a.blocks[8].fileId)!;
    expect(photo).toMatchObject({ title: "photo.png", origin: "notion" });
    // The copy sits in its own Drive folder and is not one of the cloud's files (list, picker, usage).
    expect(drive.get(photo.drive_id)!.parents).toEqual([t.db.getSetting("notion_folder_id")!]);
    expect(await (await t.req("/api/files", "GET")).json()).toEqual([]);
    expect(await (await t.req("/api/files?folder=root", "GET")).json()).toEqual([]);
    expect(await (await t.req("/api/quota", "GET")).json()).toMatchObject({ files: 0, bytes: 0 });
    expect((await t.req(`/api/files/${photo.id}/content`, "GET")).status).toBe(200); // the note still shows it
    // A dated checkbox is a task for the today screen and the calendar.
    expect(t.db.listTasks({ from: "2026-11-21", to: "2026-11-21" }).map((x) => x.title)).toEqual(["과제 제출"]);
    // Child pages and database rows sit under their page; the page block links to its note; a row shows its columns.
    const sub = t.noteOf("하위 페이지");
    const row = t.noteOf("회의");
    expect([sub.parent_id, row.parent_id]).toEqual([a.id, a.id]);
    expect(a.links[SUB]).toEqual({ id: sub.id, title: "하위 페이지" });
    expect((await t.getNote(row.id)).notion).toMatchObject({ props: [["상태", "진행 중"]] });
    expect(a.notion!.url).toBe(`https://www.notion.so/${A.replace(/-/g, "")}`);

    // A full pass again with nothing new in Notion reads no page content and changes no note.
    const versions = t.db.listNotes().map((x) => t.db.getNote(x.id)!.version);
    nt.calls.length = 0;
    await t.req("/api/notion/sync", "POST");
    await t.notion.idle();
    expect(nt.calls.filter((c) => c.includes("/children"))).toEqual([]);
    expect(t.db.listNotes().map((x) => t.db.getNote(x.id)!.version)).toEqual(versions);
  } finally {
    t.done();
  }
});

test("노션 연동: 여기서 고치면 블록 단위로 노션에 반영(서식·추가·맨 앞·들여쓰기·삭제·옮기기·제목·사진), 다시 읽어도 노트는 그대로", async () => {
  loginEmail = "owner@example.com";
  const t = await notionApp();
  try {
    const { nt } = t;
    const A = nt.page("메모");
    const [b1, b2, b3] = nt.insert(A, [
      { type: "paragraph", paragraph: { rich_text: [nt.txt("첫 줄 "), nt.txt("굵게", { bold: true })] } },
      { type: "bulleted_list_item", bulleted_list_item: { rich_text: [nt.txt("목록")] } },
      { type: "paragraph", paragraph: { rich_text: [nt.txt("지울 줄")] } },
    ]);
    await t.req("/api/notion", "PUT", { token: "ntn_good" });
    await t.notion.idle();
    const note = t.noteOf("메모");
    const before = await t.getNote(note.id);
    const ids = before.blocks.map((b) => b.id);
    expect(ids).toEqual([b1!.id, b2!.id, b3!.id]);

    // Typing in the middle keeps the bold part; a new first line, a nested item, a deleted line, a new title.
    nt.calls.length = 0;
    const saved = await t.save(
      note.id,
      [
        { id: "new1", type: "h2", text: "새 제목줄" },
        { id: b1!.id, type: "p", text: "첫 줄 고침 굵게", rich: [{ t: "첫 줄 고침 " }, { t: "굵게", b: 1 }] },
        { id: b2!.id, type: "bullet", text: "목록" },
        { id: "new2", type: "bullet", text: "안쪽", d: 1, rich: [{ t: "안쪽", i: 1, color: "red" }] },
      ],
      "메모 (고침)",
    );
    expect(nt.tree(A)).toEqual([
      ["heading_2", "새 제목줄"],
      ["paragraph", "첫 줄 고침 굵게"],
      ["bulleted_list_item", "목록", [["bulleted_list_item", "안쪽"]]],
    ]);
    expect(nt.blocks.get(b1!.id)!.paragraph.rich_text.map((x: any) => [x.plain_text, x.annotations.bold])).toEqual([["첫 줄 고침 ", false], ["굵게", true]]);
    const inner = nt.blocks.get(nt.kids.get(b2!.id)![0]!)!;
    expect(inner.bulleted_list_item.rich_text[0].annotations).toMatchObject({ italic: true, color: "red" });
    expect(nt.blocks.get(b3!.id)!.archived).toBe(true);
    expect(nt.pages.get(A)!.properties.title.title[0].plain_text).toBe("메모 (고침)");
    // Only the changed blocks were touched (no rewrite of the whole page), and the note was not rewritten by reading it back.
    expect(nt.calls.filter((c) => c.startsWith("PATCH /v1/blocks/") && !c.endsWith("/children"))).toEqual([`PATCH /v1/blocks/${b1!.id}`]);
    let after = await t.getNote(note.id);
    expect(after.version).toBe(saved.version);
    expect(after.blocks.map((b) => b.id)).toEqual(["new1", b1!.id, b2!.id, "new2"]);

    // Moving a block: it is made again in its new place, and keeps its id in the note.
    // A picture from the cloud goes to Notion as a signed link to this site.
    const pic = t.db.insertFile({ drive_id: "pic1", name: "그림.png", title: "그림", mime: "image/png", size: 5, category: "기타", tags: "", note: "" });
    drive.set("pic1", { id: "pic1", name: "그림.png", mimeType: "image/png", parents: [], trashed: false, bytes: 5, content: "PNG!!" });
    const cur = after.blocks;
    await t.save(note.id, [cur[1], cur[0], cur[2], cur[3], { id: "img1", type: "image", text: "캡션", fileId: pic.id }]);
    expect(nt.tree(A).map((x) => x[0])).toEqual(["paragraph", "heading_2", "bulleted_list_item", "image"]);
    const img = nt.blocks.get(nt.kids.get(A)!.at(-1)!)!;
    const link = img.image.external.url as string;
    expect(link).toMatch(new RegExp(`^https://kacarong.kr/f/${pic.id}/[\\w-]{22}/`));
    const served = await t.call(link.replace("https://kacarong.kr", ""));
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("PNG!!");
    expect((await t.call(`/f/${pic.id}/${"x".repeat(22)}/a.png`)).status).toBe(404);
    after = await t.getNote(note.id);
    expect(after.blocks.map((b) => b.id)).toEqual([b1!.id, "new1", b2!.id, "new2", "img1"]);
    expect(after.blocks[4]).toMatchObject({ type: "image", fileId: pic.id }); // read back as the same cloud file
    // Changing a block's type makes it again too (Notion can't change types).
    await t.save(note.id, after.blocks.map((b) => (b.id === "new1" ? { ...b, type: "quote" } : b)));
    expect(nt.tree(A).map((x) => x[0])).toEqual(["paragraph", "quote", "bulleted_list_item", "image"]);
    expect((await t.getNote(note.id)).blocks.map((b) => b.id)).toEqual([b1!.id, "new1", b2!.id, "new2", "img1"]);
  } finally {
    t.done();
  }
});

test("노션 연동: 노션에서 고친 것은 노트로, 양쪽에서 다른 블록을 고치면 둘 다 남고, 페이지 추가·삭제도 맞춰짐", async () => {
  loginEmail = "owner@example.com";
  const t = await notionApp();
  try {
    const { nt } = t;
    const A = nt.page("공유 메모");
    const [x, y] = nt.insert(A, [
      { type: "paragraph", paragraph: { rich_text: [nt.txt("엑스")] } },
      { type: "paragraph", paragraph: { rich_text: [nt.txt("와이")] } },
    ]);
    await t.req("/api/notion", "PUT", { token: "ntn_good" });
    await t.notion.idle();
    const note = t.noteOf("공유 메모");

    // Edited in Notion: the poll brings it in.
    nt.edit(x!.id, { rich_text: [nt.txt("엑스 (노션에서)")] });
    await t.notion.poll();
    await t.notion.idle();
    expect((await t.getNote(note.id)).blocks.map((b) => b.text)).toEqual(["엑스 (노션에서)", "와이"]);

    // Both sides at once: Notion changes x, this site (from the old version) changes y. Both stay, on both sides.
    const old = await t.getNote(note.id);
    nt.edit(x!.id, { rich_text: [nt.txt("엑스 2")] });
    const r = await t.req(`/api/notes/${note.id}`, "PUT", { title: old.title, version: old.version, blocks: [old.blocks[0], { ...old.blocks[1], text: "와이 (여기서)" }] });
    expect(r.status).toBe(200);
    await t.notion.idle();
    expect((await t.getNote(note.id)).blocks.map((b) => b.text)).toEqual(["엑스 2", "와이 (여기서)"]);
    expect(nt.tree(A)).toEqual([["paragraph", "엑스 2"], ["paragraph", "와이 (여기서)"]]);

    // A page added in Notion comes in on the next poll, under its parent's note.
    const NEW = nt.page("노션에서 만든 페이지", { type: "page_id", page_id: A });
    await t.notion.poll();
    await t.notion.idle();
    expect(t.noteOf("노션에서 만든 페이지").parent_id).toBe(note.id);
    expect((await t.getNote(note.id)).blocks.at(-1)).toMatchObject({ type: "page", page: NEW });

    // A note made here under a Notion note becomes a Notion page under that page.
    const made = (await (await t.req("/api/notes", "POST", { title: "여기서 만든 하위", parent_id: note.id })).json()) as { id: number; blocks: any[] };
    const madePage = [...nt.pages.values()].find((p) => p.properties.title.title[0]?.plain_text === "여기서 만든 하위")!;
    expect(madePage.parent).toEqual({ type: "page_id", page_id: A });
    await t.save(made.id, [{ id: made.blocks[0].id, type: "p", text: "내용" }]);
    expect(nt.tree(madePage.id)).toEqual([["paragraph", "내용"]]);
    // New top-level notes stay on this site until a Notion page is picked for them.
    const local = (await (await t.req("/api/notes", "POST", { title: "사이트 노트" })).json()) as { id: number };
    expect(t.db.notionPageOfNote(local.id)).toBeNull();
    expect((await t.req("/api/notion/root", "PUT", { pageId: A })).status).toBe(200);
    const rooted = (await (await t.req("/api/notes", "POST", { title: "새 최상위" })).json()) as { id: number };
    expect(t.db.notionPageOfNote(rooted.id)).not.toBeNull();

    // Deleted in Notion: the note goes on the next sync. Deleted here: the page goes to Notion's trash, with the pages under it.
    nt.pages.get(NEW)!.archived = true;
    await t.req("/api/notion/sync", "POST");
    await t.notion.idle();
    expect(t.db.listNotes().some((n) => n.title === "노션에서 만든 페이지")).toBe(false);
    expect((await t.req(`/api/notes/${note.id}`, "DELETE")).status).toBe(200);
    expect(nt.pages.get(A)!.archived).toBe(true);
    expect(t.db.listNotes().map((n) => n.title)).toEqual(["사이트 노트"]);
  } finally {
    t.done();
  }
});

test("노션 연동: 예전 가져오기로 만든 노트는 첫 동기화 때 노션 내용으로 바뀌고 가져오기 첨부는 떼어짐", async () => {
  loginEmail = "owner@example.com";
  const t = await notionApp();
  try {
    const { nt } = t;
    const A = nt.page("옛 노트");
    nt.insert(A, [{ type: "toggle", toggle: { rich_text: [nt.txt("토글")], children: [{ type: "paragraph", paragraph: { rich_text: [nt.txt("안")] } }] } }]);
    // As the one-way import left it: flattened text, and the page's file attached to the note.
    const old = t.db.insertNote("옛 노트", [{ id: "x", type: "p", text: "▸ 토글" }, { id: "y", type: "p", text: "안" }], "2026-11-19");
    t.db.setNotionPage(A, old.id, "2026-11-01T00:00:00.000Z", old.version, []);
    const f = t.db.insertFile({ drive_id: "old1", name: "a.png", title: "a.png", mime: "image/png", size: 1, category: "기타", tags: "노션", note: "" });
    t.db.addAttachment("note", old.id, f.id, true);
    const mine = t.db.insertFile({ drive_id: "old2", name: "b.png", title: "b.png", mime: "image/png", size: 1, category: "기타", tags: "", note: "" });
    t.db.addAttachment("note", old.id, mine.id);
    await t.req("/api/notion", "PUT", { token: "ntn_good" });
    await t.notion.idle();
    const n = await t.getNote(old.id);
    expect(n.blocks.map((b) => [b.type, b.text, b.d ?? 0])).toEqual([["toggle", "토글", 0], ["p", "안", 1]]);
    expect(t.db.listAttachments("note", old.id).map((x) => x.id)).toEqual([mine.id]);
    expect(t.db.listNotes()).toHaveLength(1);
  } finally {
    t.done();
  }
});

test("노션 연동: 다른 부모 아래로 옮긴 블록은 새 사본을 지우지 않고, 옮기다 실패해도 내용이 남았다가 다음에 마저 옮겨짐", async () => {
  loginEmail = "owner@example.com";
  const t = await notionApp();
  try {
    const { nt } = t;
    const P = nt.page("옮기기");
    const [a, b] = nt.insert(P, [
      { type: "bulleted_list_item", bulleted_list_item: { rich_text: [nt.txt("에이")] } },
      { type: "bulleted_list_item", bulleted_list_item: { rich_text: [nt.txt("비")], children: [{ type: "paragraph", paragraph: { rich_text: [nt.txt("씨")] } }] } },
    ]);
    const c = nt.kids.get(b!.id)![0]!;
    await t.req("/api/notion", "PUT", { token: "ntn_good" });
    await t.notion.idle();
    const note = t.noteOf("옮기기");
    const n0 = await t.getNote(note.id);
    expect(n0.blocks.map((x) => [x.id, x.d ?? 0])).toEqual([[a!.id, 0], [b!.id, 0], [c, 1]]);

    // A, B(C) → A(C), B: C is made again under A and the old C goes; the new one stays.
    await t.save(note.id, [n0.blocks[0], { ...n0.blocks[2], d: 1 }, n0.blocks[1]]);
    expect(nt.tree(P)).toEqual([["bulleted_list_item", "에이", [["paragraph", "씨"]]], ["bulleted_list_item", "비"]]);
    const newC = nt.kids.get(a!.id)![0]!;
    expect(nt.blocks.get(newC)!.archived).toBe(false);
    expect(t.db.notionBlockIds(note.id).get(c)).toBe(newC);
    const n1 = await t.getNote(note.id);
    expect(n1.blocks.map((x) => [x.id, x.d ?? 0])).toEqual([[a!.id, 0], [c, 1], [b!.id, 0]]);
    // Read again with nothing changed: still the same.
    await t.notion.syncNote(note.id);
    expect((await t.getNote(note.id)).version).toBe(n1.version);

    // Swap A and B, but making the new copy fails: nothing is deleted in Notion, the note keeps both.
    nt.ctl.failNext = /^PATCH \/v1\/blocks\/[^/]+\/children$/;
    const r = await t.req(`/api/notes/${note.id}`, "PUT", { title: n1.title, version: n1.version, blocks: [n1.blocks[2], n1.blocks[0], n1.blocks[1]] });
    expect(r.status).toBe(200);
    await t.notion.idle();
    expect((await (await t.req("/api/notion", "GET")).json()).error).toContain("injected failure");
    expect(nt.tree(P).map((x) => x[1])).toEqual(["에이", "비"]);
    expect((await t.getNote(note.id)).blocks.map((x) => x.text)).toEqual(["비", "에이", "씨"]);
    // The next sync finishes the move.
    await t.notion.syncNote(note.id);
    expect(nt.tree(P)).toEqual([["bulleted_list_item", "비"], ["bulleted_list_item", "에이", [["paragraph", "씨"]]]]);
    expect((await t.getNote(note.id)).blocks.map((x) => x.text)).toEqual(["비", "에이", "씨"]);
  } finally {
    t.done();
  }
});

test("노션 연동: 꾸민 체크박스는 다른 블록만 고치면 건드리지 않고, 할 일 화면에서 제목을 바꾸면 꾸밈까지 맞춰 노션에 보냄", async () => {
  loginEmail = "owner@example.com";
  const t = await notionApp();
  try {
    const { nt } = t;
    const P = nt.page("할 일 노트");
    const [todo, para] = nt.insert(P, [
      { type: "to_do", to_do: { checked: false, rich_text: [nt.txt("보고서", { bold: true }), nt.txt(" 쓰기 "), { type: "mention", mention: { type: "date", date: { start: "2026-11-21" } } }] } },
      { type: "paragraph", paragraph: { rich_text: [nt.txt("메모")] } },
    ]);
    await t.req("/api/notion", "PUT", { token: "ntn_good" });
    await t.notion.idle();
    const note = t.noteOf("할 일 노트");
    const n0 = await t.getNote(note.id);
    expect(n0.blocks[0]).toMatchObject({ text: "보고서 쓰기", rich: [{ t: "보고서", b: 1 }, { t: " 쓰기" }], date: "2026-11-21" });

    // Only the paragraph changes: the checkbox (read from Notion with its fields in another order) is not sent.
    nt.calls.length = 0;
    await t.save(note.id, [n0.blocks[0], { ...n0.blocks[1], text: "메모 고침" }]);
    expect(nt.calls.filter((c) => c.startsWith("PATCH /v1/blocks/") && !c.endsWith("/children"))).toEqual([`PATCH /v1/blocks/${para!.id}`]);

    // Renamed on the task side: the block's text and runs agree, and Notion gets the new title.
    const task = t.db.listTasks({}).find((x) => x.note_id === note.id)!;
    expect((await t.req(`/api/tasks/${task.id}`, "PATCH", { title: "보고서 제출하기" })).status).toBe(200);
    await t.notion.idle();
    const b = (await t.getNote(note.id)).blocks[0];
    expect(b.text).toBe("보고서 제출하기");
    expect(b.rich.map((x: { t: string }) => x.t).join("")).toBe("보고서 제출하기");
    expect(b.rich[0]).toEqual({ t: "보고서", b: 1 });
    expect(nt.tree(P)[0]).toEqual(["to_do", "보고서 제출하기@2026-11-21"]);
  } finally {
    t.done();
  }
});

test("노션 연동: 새 사본의 하위 블록을 만들다 실패하면 옛 블록과 하위가 노션·노트에 남고, 다음 동기화에서 마저 바뀜", async () => {
  loginEmail = "owner@example.com";
  const t = await notionApp();
  try {
    const { nt } = t;
    const P = nt.page("하위 실패");
    const [a] = nt.insert(P, [
      { type: "paragraph", paragraph: { rich_text: [nt.txt("에이")], children: [{ type: "paragraph", paragraph: { rich_text: [nt.txt("씨")] } }] } },
      { type: "toggle", toggle: { rich_text: [nt.txt("비")], children: [{ type: "paragraph", paragraph: { rich_text: [nt.txt("디")] } }, { type: "paragraph", paragraph: { rich_text: [nt.txt("이")] } }] } },
    ]);
    await t.req("/api/notion", "PUT", { token: "ntn_good" });
    await t.notion.idle();
    const note = t.noteOf("하위 실패");
    const appendFailsForKid = () => {
      nt.ctl.failNext = /^PATCH \/v1\/blocks\/[^/]+\/children$/;
      nt.ctl.skip = 1; // the parent's new copy is made, the child under it fails
    };
    const saveRaw = async (blocks: object[]) => {
      const n = await t.getNote(note.id);
      expect((await t.req(`/api/notes/${note.id}`, "PUT", { title: n.title, version: n.version, blocks })).status).toBe(200);
      await t.notion.idle();
    };
    const texts = async () => (await t.getNote(note.id)).blocks.map((x) => [x.type, x.text, x.d ?? 0]);
    const original = [["paragraph", "에이", [["paragraph", "씨"]]], ["toggle", "비", [["paragraph", "디"], ["paragraph", "이"]]]];

    // 1) A (with C under it) becomes a quote.
    let n = await t.getNote(note.id);
    appendFailsForKid();
    await saveRaw(n.blocks.map((x) => (x.id === a!.id ? { ...x, type: "quote" } : x)));
    expect((await (await t.req("/api/notion", "GET")).json()).error).toContain("injected failure");
    expect(nt.tree(P)).toEqual(original); // nothing lost, no half-made copy left
    expect(await texts()).toEqual([["quote", "에이", 0], ["p", "씨", 1], ["toggle", "비", 0], ["p", "디", 1], ["p", "이", 1]]);
    await t.notion.syncNote(note.id);
    expect(nt.tree(P)).toEqual([["quote", "에이", [["paragraph", "씨"]]], original[1]]);
    expect(await texts()).toEqual([["quote", "에이", 0], ["p", "씨", 1], ["toggle", "비", 0], ["p", "디", 1], ["p", "이", 1]]);

    // 2) A (with C) moves below B: B is heavier, so A is the one made again.
    n = await t.getNote(note.id);
    const moved = [...n.blocks.slice(2), ...n.blocks.slice(0, 2)];
    appendFailsForKid();
    await saveRaw(moved);
    expect(nt.tree(P)).toEqual([["quote", "에이", [["paragraph", "씨"]]], original[1]]);
    expect(await texts()).toEqual([["toggle", "비", 0], ["p", "디", 1], ["p", "이", 1], ["quote", "에이", 0], ["p", "씨", 1]]);
    await t.notion.syncNote(note.id);
    expect(nt.tree(P)).toEqual([original[1], ["quote", "에이", [["paragraph", "씨"]]]]);
    const after = await t.getNote(note.id);
    expect(after.blocks.map((x) => x.text)).toEqual(["비", "디", "이", "에이", "씨"]);
    expect(new Set(after.blocks.map((x) => x.id)).size).toBe(5);
  } finally {
    t.done();
  }
});

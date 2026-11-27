import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { openDb } from "../src/db";
import { createGoogle } from "../src/google";

// A small stand-in for the Google OAuth + Drive endpoints the app uses.
type FakeFile = { id: string; name: string; mimeType: string; parents: string[]; trashed: boolean; bytes: number; content?: string; raw?: Buffer; createdTime?: string };
const drive = new Map<string, FakeFile>();
const uploads = new Map<string, { name: string; mimeType: string; parents: string[]; size: number; received: number; origin: string | null; fileId?: string; parts: Buffer[] }>();
let foldersCreated = 0;
let driveDeleteFails = false;
let uploadFails = false; // starting an upload session fails, like a Drive outage
let loginEmail = "owner@example.com";
const READ_SCOPE = "openid email https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/calendar.readonly";
const FULL_SCOPE = `${READ_SCOPE} https://www.googleapis.com/auth/calendar.events`;
// Events made through the API, by calendar id (the fixed ones below are always listed too).
type FakeEvent = { id: string; status?: string; summary?: string; location?: string; description?: string; start: Record<string, string>; end: Record<string, string>; extendedProperties?: { private: Record<string, string> } };
const madeEvents = new Map<string, Map<string, FakeEvent>>();
const calEvents = (id: string) => madeEvents.get(id) ?? madeEvents.set(id, new Map()).get(id)!;
// Like Google's list: deleted ("cancelled") events are left out, and so are events that end before timeMin.
const eventEnd = (e: FakeEvent) => new Date(e.end.dateTime ?? `${e.end.date}T00:00:00+09:00`).getTime();
let grantedScope = FULL_SCOPE; // what the fake consent screen lets through
let lastPrompt: string | null = null; // like Google, a refresh token comes only from a consent screen
let calendarFails = false;
let grantRevoked = false; // the refresh token was revoked or expired at Google
const eventQueries: URLSearchParams[] = [];
let nextId = 1;
// A stand-in push service: what each POST /push/<name> brought (name "gone" answers 410 like an expired subscription).
const pushes: { name: string; headers: Headers; body: Buffer }[] = [];
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
      if (p.startsWith("/push/") && req.method === "POST") {
        const name = p.slice(6);
        pushes.push({ name, headers: req.headers, body: Buffer.from(await req.arrayBuffer()) });
        return new Response(null, { status: name === "gone" ? 410 : 201 });
      }
      if (p.startsWith("/thumbs/")) {
        if (req.headers.get("Authorization") !== "Bearer at") return new Response("no", { status: 403 });
        return new Response("PNGDATA", { headers: { "Content-Type": "image/png" } });
      }
      // Upload session URI, same shape as Google's: /upload/drive/v3/files?uploadType=resumable&upload_id=...
      if (p === "/upload/drive/v3/files" && req.method === "PUT") {
        const u = uploads.get(url.searchParams.get("upload_id")!)!;
        const part = Buffer.from(await req.arrayBuffer());
        u.parts.push(part);
        u.received += part.byteLength;
        if (u.received < u.size) {
          // Google omits Range when it has no bytes yet.
          return new Response(null, { status: 308, headers: u.received ? { Range: `bytes=0-${u.received - 1}` } : {} });
        }
        if (!u.fileId) {
          const f: FakeFile = { id: `f${nextId}`, name: u.name, mimeType: u.mimeType, parents: u.parents, trashed: false, bytes: u.size, raw: Buffer.concat(u.parts), createdTime: new Date(Date.UTC(2026, 0, 1) + nextId++ * 1000).toISOString() };
          drive.set(f.id, f);
          u.fileId = f.id;
        }
        return Response.json(fileJson(drive.get(u.fileId)!));
      }
      if (req.headers.get("Authorization") !== "Bearer at") return new Response("unauthorized", { status: 401 });

      if (p === "/upload/drive/v3/files" && req.method === "POST") {
        if (uploadFails) return new Response("backend error", { status: 503 });
        const meta = await req.json();
        const sid = `s${nextId++}`;
        uploads.set(sid, {
          name: meta.name,
          mimeType: req.headers.get("X-Upload-Content-Type")!,
          parents: meta.parents,
          size: Number(req.headers.get("X-Upload-Content-Length")),
          received: 0,
          origin: req.headers.get("Origin"),
          parts: [],
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
            { id: "me@example.com", summary: "내 캘린더", backgroundColor: "#9fe1e7", primary: true, accessRole: "owner" },
            { id: "ko#holiday@group.v.calendar.google.com", summary: "대한민국의 휴일", backgroundColor: "red;x", selected: true, accessRole: "reader" },
            { id: "hidden", summary: "꺼 둔 캘린더", backgroundColor: "#000000", selected: false, accessRole: "writer" },
          ],
        });
      }
      const one = p.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events\/([^/]+)$/);
      if (one) {
        const list = calEvents(decodeURIComponent(one[1]!));
        const e = list.get(decodeURIComponent(one[2]!));
        if (!e) return new Response("gone", { status: 410 });
        if (req.method === "DELETE") {
          list.delete(e.id);
          return new Response(null, { status: 204 });
        }
        // PATCH merges one level down; null clears a key, like Google. A cancelled event can still be patched.
        const patch = (await req.json()) as Record<string, unknown>;
        for (const [k, v] of Object.entries(patch)) {
          if (v && typeof v === "object" && !Array.isArray(v)) {
            const cur = ((e as Record<string, unknown>)[k] ?? {}) as Record<string, unknown>;
            for (const [k2, v2] of Object.entries(v)) if (v2 === null) delete cur[k2]; else cur[k2] = v2;
            (e as Record<string, unknown>)[k] = cur;
          } else if (v === null) delete (e as Record<string, unknown>)[k];
          else (e as Record<string, unknown>)[k] = v;
        }
        return Response.json({ id: e.id, status: e.status ?? "confirmed" });
      }
      const cal = p.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events$/);
      if (cal && req.method === "POST") {
        const e = { ...((await req.json()) as FakeEvent), id: `ev${nextId++}` };
        calEvents(decodeURIComponent(cal[1]!)).set(e.id, e);
        return Response.json({ id: e.id });
      }
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
        const timeMin = url.searchParams.get("timeMin");
        const made = [...calEvents(id).values()].filter((e) => e.status !== "cancelled" && (!timeMin || eventEnd(e) > new Date(timeMin).getTime()));
        return Response.json({ items: [...items, ...made] });
      }
      if (p === "/drive/v3/files" && req.method === "GET") {
        const parent = url.searchParams.get("q")!.match(/^'([^']+)' in parents and trashed = false$/)![1];
        return Response.json({ files: [...drive.values()].filter((f) => f.parents.includes(parent!) && !f.trashed).map((f) => ({ id: f.id, name: f.name, size: String(f.bytes), createdTime: f.createdTime })) });
      }
      if (p === "/drive/v3/about") return Response.json({ storageQuota: { limit: String(400 * 1024 ** 3), usage: "1024", usageInDriveTrash: "0" } });

      const m = p.match(/^\/drive\/v3\/files\/([^/]+)$/);
      const f = m && drive.get(m[1]!);
      if (!f) return new Response("not found", { status: 404 });
      if (req.method === "DELETE") {
        if (driveDeleteFails) return new Response("backend error", { status: 500 });
        drive.delete(f.id);
        return new Response(null, { status: 204 });
      }
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

function makeApp(opts: { googleEnabled?: boolean; now?: () => Date; notionApi?: string; baseUrl?: string } = {}) {
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
  const start = () =>
    createApp(
      { baseUrl: opts.baseUrl ?? "https://kacarong.kr", adminEmail: "owner@example.com", dataDir, googleEnabled: opts.googleEnabled ?? true, now: opts.now, notionApi: opts.notionApi, notionDebounceMs: 0 },
      db,
      google,
    );
  const caller = (app: ReturnType<typeof start>) => (path: string, init: RequestInit & { cookie?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (init.cookie) headers.set("Cookie", init.cookie);
    return app(new Request("https://kacarong.kr" + path, { ...init, headers }));
  };
  const fetch = start();
  const call = caller(fetch);
  return { call, db, notion: fetch.notion, notifier: fetch.notifier, backup: fetch.backup, moveNotionCopies: fetch.moveNotionCopies, cleanup: () => rmSync(dataDir, { recursive: true, force: true }) };
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
  expect(redirect.searchParams.get("login_hint")).toBeNull(); // no login_hint cookie yet: the owner's email is never handed out
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

test("클라우드 순서: 새 것은 맨 앞, 끌어 놓은 순서(폴더·파일 섞어서)를 저장, 다른 폴더로 옮기면 거기 맨 앞", async () => {
  loginEmail = "owner@example.com";
  const { call, db, cleanup } = makeApp();
  try {
    const { cookie } = await login(call);
    const req = (path: string, method: string, b?: object) => call(path, { method, cookie, headers: JSON_ORIGIN, body: b ? JSON.stringify(b) : undefined });
    const folder = async (name: string, parentId: number | null = null) => (await req("/api/folders", "POST", { name, parentId })).json() as Promise<{ id: number; drive_id: string }>;
    const a = await folder("A");
    const rootId = drive.get(a.drive_id)!.parents[0]!;
    const addFile = async (name: string, folderId: number | null = null) => {
      const id = `ord${nextId++}`;
      drive.set(id, { id, name, mimeType: "text/plain", parents: [folderId === null ? rootId : db.getFolder(folderId)!.drive_id], trashed: false, bytes: 1 });
      return db.insertFile({ drive_id: id, name, title: name, mime: "text/plain", size: 1, category: "기타", tags: "", note: "", folder_id: folderId });
    };
    const f1 = await addFile("1.txt");
    const b = await folder("B");
    const f2 = await addFile("2.txt");

    // What the screen shows for a folder: its folders and files merged by sort.
    const view = async (f: number | null) => {
      const fs = ((await (await req("/api/folders", "GET")).json()) as { id: number; name: string; parent_id: number | null; sort: number }[]).filter((x) => x.parent_id === f);
      const files = (await (await req(`/api/files?folder=${f ?? "root"}`, "GET")).json()) as { title: string; sort: number }[];
      return [...fs.map((x) => ({ n: x.name, s: x.sort })), ...files.map((x) => ({ n: x.title, s: x.sort }))].sort((x, y) => x.s - y.s).map((x) => x.n);
    };
    expect(await view(null)).toEqual(["2.txt", "B", "1.txt", "A"]); // newest first

    // The owner's order, folders and files mixed.
    const order = (folderId: number | null, items: [string, number][]) => req("/api/cloud/order", "PUT", { folderId, items: items.map(([type, id]) => ({ type, id })) });
    expect((await order(null, [["folder", a.id], ["file", f1.id], ["folder", b.id], ["file", f2.id]])).status).toBe(200);
    expect(await view(null)).toEqual(["A", "1.txt", "B", "2.txt"]);
    // The listing a file is in (one folder) follows it; a search across folders stays newest first.
    expect(((await (await req("/api/files?folder=root", "GET")).json()) as { title: string }[]).map((x) => x.title)).toEqual(["1.txt", "2.txt"]);
    expect(((await (await req("/api/files?q=.txt", "GET")).json()) as { title: string }[]).map((x) => x.title)).toEqual(["2.txt", "1.txt"]);

    // An order from an out-of-date screen (missing, extra, twice, wrong folder) changes nothing.
    expect((await order(null, [["folder", a.id], ["file", f1.id], ["folder", b.id]])).status).toBe(409);
    expect((await order(null, [["folder", a.id], ["file", f1.id], ["folder", b.id], ["file", f2.id], ["file", 9999]])).status).toBe(409);
    expect((await order(null, [["folder", a.id], ["file", f1.id], ["file", f1.id], ["file", f2.id]])).status).toBe(409);
    expect((await order(a.id, [["file", f1.id]])).status).toBe(409);
    expect((await order(9999, [])).status).toBe(404);
    expect((await order(null, [["note", 1]] as [string, number][])).status).toBe(400);
    expect(await view(null)).toEqual(["A", "1.txt", "B", "2.txt"]);

    // Moving goes first in the other folder and keeps the rest of the old one in order; Drive follows.
    const f3 = await addFile("3.txt", a.id);
    expect(await view(a.id)).toEqual(["3.txt"]);
    expect((await req(`/api/files/${f2.id}`, "PATCH", { folderId: a.id })).status).toBe(200);
    expect((await req(`/api/folders/${b.id}`, "PATCH", { parentId: a.id })).status).toBe(200);
    expect(await view(a.id)).toEqual(["B", "2.txt", "3.txt"]);
    expect(await view(null)).toEqual(["A", "1.txt"]);
    expect(drive.get(f2.drive_id)!.parents).toEqual([a.drive_id]);
    expect(drive.get(b.drive_id)!.parents).toEqual([a.drive_id]);
    // Saving a file's details or renaming a folder in place doesn't move it.
    expect((await req(`/api/files/${f3.id}`, "PATCH", { title: "3번", folderId: a.id })).status).toBe(200);
    expect((await req(`/api/folders/${b.id}`, "PATCH", { name: "B2" })).status).toBe(200);
    expect(await view(a.id)).toEqual(["B2", "2.txt", "3번"]);
  } finally {
    cleanup();
  }
});

test("순서 칸이 없던 DB를 열면 폴더마다 예전처럼 폴더(이름순) 다음 파일(최신순)", () => {
  const dir = mkdtempSync(join(tmpdir(), "folio-test-"));
  try {
    const path = join(dir, "old.db");
    const raw = new Database(path);
    raw.exec(`
      CREATE TABLE folders (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, parent_id INTEGER, drive_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, drive_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, title TEXT NOT NULL, mime TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0, category TEXT NOT NULL DEFAULT '기타', tags TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', shared INTEGER NOT NULL DEFAULT 0, public INTEGER NOT NULL DEFAULT 0, web_view_link TEXT NOT NULL DEFAULT '', web_content_link TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')), folder_id INTEGER, origin TEXT NOT NULL DEFAULT '');
      INSERT INTO folders (name, parent_id, drive_id) VALUES ('나', NULL, 'd1'), ('가', NULL, 'd2'), ('안', 1, 'd3');
      INSERT INTO files (drive_id, name, title, folder_id) VALUES ('x1', 'old.txt', 'old.txt', NULL), ('x2', 'new.txt', 'new.txt', NULL), ('x3', 'in.txt', 'in.txt', 1);
    `);
    raw.close();
    const db = openDb(path);
    const top = [...db.listFolders().filter((f) => f.parent_id === null), ...db.listFiles({ folder: null })].sort((x, y) => x.sort - y.sort);
    expect(top.map((x) => ("title" in x ? x.title : x.name))).toEqual(["가", "나", "new.txt", "old.txt"]);
    const inner = [...db.listFolders().filter((f) => f.parent_id === 1), ...db.listFiles({ folder: 1 })].sort((x, y) => x.sort - y.sort);
    expect(inner.map((x) => ("title" in x ? x.title : x.name))).toEqual(["안", "in.txt"]);
    db.raw.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
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

// A signed-in owner, as a Google login leaves it (the login itself is tested with login() above).
function ownerSession(db: ReturnType<typeof makeApp>["db"]) {
  const sid = crypto.randomUUID();
  db.createSession(sid, "owner@example.com", Date.now() + 86400_000);
  return `sid=${sid}`;
}

test("로그인은 구글뿐: 비밀번호 로그인 없음, 로그아웃", async () => {
  const { call, db, cleanup } = makeApp();
  try {
    const pw = await call("/auth/password", { method: "POST", headers: JSON_ORIGIN, body: JSON.stringify({ password: "correct horse battery" }) });
    expect(pw.status).toBe(404);
    expect(pw.headers.getSetCookie().some((c) => c.startsWith("sid="))).toBe(false);
    expect(await (await call("/api/me")).json()).toMatchObject({ admin: false, googleEnabled: true });

    const google = ownerSession(db);
    expect((await call("/api/tasks", { cookie: google })).status).toBe(200);

    expect((await call("/auth/logout", { method: "POST", cookie: google })).status).toBe(204);
    expect(await (await call("/api/me", { cookie: google })).json()).toMatchObject({ admin: false });
  } finally {
    cleanup();
  }
});

test("구글 로그인 창의 이메일은 그 브라우저에서 로그인한 적 있을 때만 채워짐", async () => {
  loginEmail = "owner@example.com";
  const { call, cleanup } = makeApp();
  try {
    // A stranger: no email in Google's login page, and no automatic jump to it.
    expect(new URL((await call("/auth/login")).headers.get("Location")!).searchParams.get("login_hint")).toBeNull();
    expect(await (await call("/api/me")).json()).toMatchObject({ admin: false, knownDevice: false });

    // The owner signs in once on this browser; from then on Google picks the account by itself.
    const { res, cookie } = await login(call);
    const hint = res.headers.getSetCookie().find((c) => c.startsWith("login_hint="))!.split(";")[0];
    expect(hint).toBe(`login_hint=${encodeURIComponent("owner@example.com")}`);
    expect(new URL((await call("/auth/login", { cookie: hint })).headers.get("Location")!).searchParams.get("login_hint")).toBe("owner@example.com");
    expect(await (await call("/api/me", { cookie: hint })).json()).toMatchObject({ admin: false, knownDevice: true });

    // Logging out forgets it.
    const out = await call("/auth/logout", { method: "POST", cookie: `${cookie}; ${hint}` });
    expect(out.headers.getSetCookie().some((c) => c.startsWith("login_hint=;") && c.includes("Max-Age=0"))).toBe(true);
  } finally {
    cleanup();
  }
});

test("구글이 꺼져 있으면 아무 로그인도 안 됨", async () => {
  const { call, cleanup } = makeApp({ googleEnabled: false });
  try {
    expect((await call("/auth/login")).status).toBe(404);
    expect((await call("/auth/password", { method: "POST", headers: JSON_ORIGIN, body: "{}" })).status).toBe(404);
    expect(await (await call("/api/me")).json()).toMatchObject({ admin: false, googleEnabled: false });
  } finally {
    cleanup();
  }
});

test("할 일·과제: 추가 → 오늘 화면 분류 → 완료 → 수정·삭제", async () => {
  // 2026-11-19 00:30 in Korea is still 11-18 in UTC; the today screen must use Korean dates.
  let clock = new Date("2026-11-18T15:30:00Z");
  const { call, db, cleanup } = makeApp({ googleEnabled: false, now: () => clock });
  try {
    const cookie = ownerSession(db);
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
    expect(todayTodo.category).toBe(""); // no category unless one is picked
    const daily = (await add({ title: "운동", category: "꾸준히 할 일" })).task;
    expect(daily.category).toBe("꾸준히 할 일");
    expect((await add({ title: "x", category: "언젠가" })).status).toBe(400);

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
    expect(await (await patch(daily.id, { category: "나중에 할 일" })).json()).toMatchObject({ category: "나중에 할 일", title: "운동" });
    expect(await (await patch(daily.id, { category: "" })).json()).toMatchObject({ category: "" });
    expect((await patch(daily.id, { category: "오늘" })).status).toBe(400);
    expect((await call(`/api/tasks/${daily.id}`, { method: "DELETE", cookie, headers: JSON_ORIGIN })).status).toBe(200);
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

test("캘린더: 권한 없으면 다시 동의 요청, 구글 일정만 한국 날짜로(할 일은 안 나옴)", async () => {
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
    expect(r.tasks).toBeUndefined(); // 할 일·과제 stay off the calendar
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

    // Google trouble: the reason, no events.
    calendarFails = true;
    r = (await (await call("/api/calendar?from=2026-11-15&to=2026-11-30", { cookie })).json()) as Record<string, unknown>;
    calendarFails = false;
    expect(r.google).toBe("error");
    expect(String(r.error)).toContain("403");
    expect(r.events).toEqual([]);

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
    db.setSetting("refresh_token", "old-rt");
    db.setSetting("granted_scopes", FULL_SCOPE);
    expect(new URL((await call("/auth/login")).headers.get("Location")!).searchParams.get("prompt")).toBeNull();
    const cookie = ownerSession(db);
    grantRevoked = true;
    const r = (await (await call("/api/calendar?from=2026-11-15&to=2026-11-30", { cookie })).json()) as Record<string, unknown>;
    expect(r.google).toBe("error");
    expect(new URL((await call("/auth/login")).headers.get("Location")!).searchParams.get("prompt")).toBe("consent");
  } finally {
    grantRevoked = false;
    cleanup();
  }
});

test("구글 캘린더 쓰기: 일정 만들기·고치기·지우기", async () => {
  loginEmail = "owner@example.com";
  madeEvents.clear();
  const { call, cleanup } = makeApp({ now: () => new Date("2026-11-22T03:00:00Z") });
  try {
    // A grant from before writing came in: reading works, writing asks for a new consent.
    grantedScope = READ_SCOPE;
    const { cookie } = await login(call);
    expect(await (await call("/api/me", { cookie })).json()).toMatchObject({ calendarConnected: true, calendarWrite: false });
    let r = (await (await call("/api/calendar?from=2026-11-15&to=2026-11-30", { cookie })).json()) as Record<string, any>;
    expect(r).toMatchObject({ google: "ok", write: false });
    const post = (path: string, b: object, method = "POST") => call(path, { method, cookie, headers: JSON_ORIGIN, body: JSON.stringify(b) });
    expect((await post("/api/calendar/events", { calendarId: "me@example.com", title: "x", date: "2026-11-24" })).status).toBe(403);
    expect(new URL((await call("/auth/login")).headers.get("Location")!).searchParams.get("prompt")).toBe("consent");
    grantedScope = FULL_SCOPE;
    await login(call);

    r = (await (await call("/api/calendar?from=2026-11-15&to=2026-11-30", { cookie })).json()) as Record<string, any>;
    expect(r.write).toBe(true);
    expect(r.calendars).toEqual([
      { id: "me@example.com", name: "내 캘린더", primary: true },
      { id: "hidden", name: "꺼 둔 캘린더", primary: false },
    ]); // the holiday calendar is read-only
    expect(r.events.find((e: any) => e.id === "e1")).toMatchObject({ calendarId: "me@example.com", editable: true, end: "2026-11-19", endTime: "01:30" });
    expect(r.events.find((e: any) => e.id === "h1")).toMatchObject({ editable: false });

    // An all-day event over three days, then a timed one, then switching it to all-day.
    let res = await post("/api/calendar/events", { calendarId: "me@example.com", title: "답사", date: "2026-11-24", endDate: "2026-11-26", location: "부산", description: "준비물" });
    expect(res.status).toBe(201);
    const allDay = calEvents("me@example.com").get(((await res.json()) as { id: string }).id)!;
    expect(allDay).toMatchObject({ summary: "답사", location: "부산", description: "준비물", start: { date: "2026-11-24" }, end: { date: "2026-11-27" } });
    expect(allDay.start.dateTime).toBeUndefined();
    res = await post("/api/calendar/events", { calendarId: "me@example.com", title: "면담", date: "2026-11-25", time: "14:00" });
    const timed = calEvents("me@example.com").get(((await res.json()) as { id: string }).id)!;
    expect(timed.start).toEqual({ dateTime: "2026-11-25T05:00:00.000Z", timeZone: "Asia/Seoul" });
    expect(timed.end.dateTime).toBe("2026-11-25T06:00:00.000Z"); // an hour when no end time is given
    r = (await (await call("/api/calendar?from=2026-11-15&to=2026-11-30", { cookie })).json()) as Record<string, any>;
    expect(r.events.find((e: any) => e.id === timed.id)).toMatchObject({ title: "면담", startDate: "2026-11-25", time: "14:00", end: "2026-11-25", endTime: "15:00", editable: true });
    res = await post(`/api/calendar/events/${timed.id}?calendar=me%40example.com`, { title: "면담(옮김)", date: "2026-11-27", endDate: "2026-11-27" }, "PATCH");
    expect(res.status).toBe(200);
    expect(timed).toMatchObject({ summary: "면담(옮김)", start: { date: "2026-11-27" }, end: { date: "2026-11-28" } });
    expect(timed.start.dateTime).toBeUndefined();
    expect(timed.start.timeZone).toBeUndefined();
    // A long description (made in Google) stays whole when only the date is changed here; too long is refused, not cut.
    const long = "  메모 " + "가".repeat(6000) + "  ";
    res = await post("/api/calendar/events", { calendarId: "me@example.com", title: "긴 메모", date: "2026-11-24", description: long });
    const longEv = calEvents("me@example.com").get(((await res.json()) as { id: string }).id)!;
    expect(longEv.description).toBe(long);
    await post(`/api/calendar/events/${longEv.id}?calendar=me%40example.com`, { title: "긴 메모", date: "2026-11-25", description: long }, "PATCH");
    expect(longEv).toMatchObject({ description: long, start: { date: "2026-11-25" } });
    expect((await post("/api/calendar/events", { calendarId: "me@example.com", title: "x", date: "2026-11-24", description: "가".repeat(8193) })).status).toBe(400);
    for (const bad of [{ title: "", date: "2026-11-24" }, { title: "x", date: "2026-11-31" }, { title: "x", date: "2026-11-24", endDate: "2026-11-23" }, { title: "x", date: "2026-11-24", time: "10:00", endTime: "09:00" }]) {
      expect((await post("/api/calendar/events", { calendarId: "me@example.com", ...bad })).status).toBe(400);
    }
    expect((await call(`/api/calendar/events/${timed.id}?calendar=me%40example.com`, { method: "DELETE", cookie, headers: JSON_ORIGIN })).status).toBe(200);
    expect(calEvents("me@example.com").has(timed.id)).toBe(false);
  } finally {
    grantedScope = FULL_SCOPE;
    madeEvents.clear();
    cleanup();
  }
});

// The receiving browser's side of RFC 8291, to check what the push service got.
function decryptPush(body: Buffer, ua: ReturnType<typeof createECDH>, auth: Buffer): unknown {
  const hmac = (k: Buffer, d: Buffer) => createHmac("sha256", k).update(d).digest();
  const salt = body.subarray(0, 16);
  const idlen = body[20]!;
  const asPublic = body.subarray(21, 21 + idlen);
  const ikm = hmac(hmac(auth, ua.computeSecret(asPublic)), Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const decipher = createDecipheriv("aes-128-gcm", hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16), hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12));
  const rest = body.subarray(21 + idlen);
  decipher.setAuthTag(rest.subarray(rest.length - 16));
  const plain = Buffer.concat([decipher.update(rest.subarray(0, rest.length - 16)), decipher.final()]);
  expect(plain[plain.length - 1]).toBe(2); // last-record padding delimiter
  return JSON.parse(plain.subarray(0, -1).toString());
}

test("알림: 기기 구독 → 아침 요약·과제 마감 전·시험 전날을 제때 한 번씩, 웹 푸시는 VAPID 서명 + 암호화", async () => {
  let clock = new Date("2026-11-22T07:59:00+09:00");
  const { call, db, notifier, cleanup } = makeApp({ now: () => clock, googleEnabled: false });
  pushes.length = 0;
  try {
    const cookie = ownerSession(db);
    const req = (path: string, method = "GET", b?: object) => call(path, { method, cookie, headers: JSON_ORIGIN, body: b ? JSON.stringify(b) : undefined });
    const info = (await (await req("/api/notify")).json()) as { settings: object; publicKey: string; devices: number };
    expect(info).toMatchObject({ settings: { morning: "08:00", homework: true, exam: true }, devices: 0 });
    expect(Buffer.from(info.publicKey, "base64url")).toHaveLength(65);

    // A browser subscribes (its own key pair and auth secret).
    const ua = createECDH("prime256v1");
    ua.generateKeys();
    const auth = randomBytes(16);
    const sub = { endpoint: `${fake.url}push/phone`, keys: { p256dh: ua.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } };
    expect((await req("/api/push/subscribe", "POST", { ...sub, endpoint: "http://insecure.example/x" })).status).toBe(400);
    expect((await req("/api/push/subscribe", "POST", { ...sub, keys: { ...sub.keys, auth: "short" } })).status).toBe(400);
    expect((await req("/api/push/subscribe", "POST", sub)).status).toBe(201);
    expect((await req("/api/push/subscribe", "POST", { endpoint: `${fake.url}push/gone`, keys: sub.keys })).status).toBe(201);

    await req("/api/tasks", "POST", { title: "운동", due_date: "2026-11-22" });
    await req("/api/tasks", "POST", { kind: "과제", course: "수리학", title: "레포트", due_date: "2026-11-23", due_time: "23:00" });
    await req("/api/tasks", "POST", { title: "지난 일", due_date: "2026-11-20" });
    await req("/api/exams", "POST", { title: "중간고사", course: "토질역학", date: "2026-11-23", time: "10:00", place: "301호" });

    await notifier.tick();
    expect(pushes).toHaveLength(0); // 07:59: nothing yet
    clock = new Date("2026-11-22T08:00:30+09:00");
    await notifier.tick();
    await notifier.tick(); // only once
    expect(pushes.map((p) => p.name).sort()).toEqual(["gone", "phone"]);
    expect(db.pushSubs().map((s) => s.endpoint)).toEqual([sub.endpoint]); // the 410 one is dropped
    const phone = pushes.find((p) => p.name === "phone")!;
    expect(phone.headers.get("Content-Encoding")).toBe("aes128gcm");
    expect(Number(phone.headers.get("TTL"))).toBeGreaterThan(0);
    const morning = decryptPush(phone.body, ua, auth) as { id: number; title: string; body: string; url: string };
    expect(morning).toMatchObject({ title: "오늘 할 일 1개 · 지난 일 1개", url: "/admin#today" });
    expect(morning.body).toContain("· 운동");
    expect(morning.body).toContain("시험 D-1 · 토질역학");
    expect(morning.body).toContain("내일 마감 과제 1개");
    // VAPID: a JWT for the push service's origin, signed with the key the browser subscribed with.
    const m = phone.headers.get("Authorization")!.match(/^vapid t=([^,]+), k=(.+)$/)!;
    expect(m[2]).toBe(info.publicKey);
    const [h, pl, sig] = m[1]!.split(".");
    expect(JSON.parse(Buffer.from(pl!, "base64url").toString())).toMatchObject({ aud: new URL(fake.url).origin, sub: "https://kacarong.kr" });
    const pub = Buffer.from(info.publicKey, "base64url");
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") }, format: "jwk" });
    expect(verify("sha256", Buffer.from(`${h}.${pl}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(sig!, "base64url"))).toBe(true);

    // Pages that show notifications themselves read the same list.
    expect(((await (await req("/api/notifications")).json()) as { id: number }[]).map((n) => n.id)).toEqual([morning.id]);
    expect(await (await req(`/api/notifications?after=${morning.id - 1}`)).json()).toMatchObject([{ title: morning.title }]);
    expect(await (await req(`/api/notifications?after=${morning.id}`)).json()).toEqual([]);

    // 20:00 the evening before: the 과제 due tomorrow and tomorrow's exam.
    pushes.length = 0;
    clock = new Date("2026-11-22T20:01:00+09:00");
    await notifier.tick();
    const evening = pushes.map((p) => decryptPush(p.body, ua, auth) as { title: string; body: string });
    expect(evening.map((n) => n.title).sort()).toEqual(["내일 마감 과제 1개", "내일 시험 · 토질역학"]);
    expect(evening.find((n) => n.title.startsWith("내일 시험"))!.body).toContain("토질역학 중간고사 · 10:00 · 301호");
    // An hour before a deadline with a time.
    pushes.length = 0;
    clock = new Date("2026-11-23T22:00:00+09:00");
    await notifier.tick();
    expect(pushes.map((p) => (decryptPush(p.body, ua, auth) as { body: string }).body)).toEqual(["[수리학] 레포트 · 23:00까지"]);
    // Long past its time (server was down): skipped.
    pushes.length = 0;
    clock = new Date("2026-11-24T10:30:00+09:00");
    await notifier.tick();
    expect(pushes).toHaveLength(0);

    // A long one is shortened to fit one push record (3993 bytes of plaintext at most); the site keeps it whole.
    await req("/api/push/subscribe", "POST", sub);
    for (let i = 0; i < 7; i++) await req("/api/tasks", "POST", { kind: "과제", title: `${i}번 ` + "긴".repeat(198), due_date: "2026-11-25" });
    pushes.length = 0;
    clock = new Date("2026-11-24T20:00:00+09:00");
    await notifier.tick();
    expect(pushes).toHaveLength(1);
    const big = decryptPush(pushes[0]!.body, ua, auth) as { id: number; title: string; body: string };
    expect(big.title).toBe("내일 마감 과제 7개");
    expect(big.body.endsWith("…")).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(big))).toBeLessThanOrEqual(3800);
    const kept = ((await (await req(`/api/notifications?after=${big.id - 1}`)).json()) as { body: string }[])[0]!;
    expect(Buffer.byteLength(kept.body)).toBeGreaterThan(4000);
    pushes.length = 0;

    // Turned off: nothing; the test button still goes out.
    expect((await req("/api/notify", "PUT", { morning: "25:00" })).status).toBe(400);
    expect(await (await req("/api/notify", "PUT", { morning: "", homework: false, exam: false })).json()).toEqual({ morning: "", homework: false, exam: false, classes: false });
    clock = new Date("2026-11-25T08:00:00+09:00");
    await notifier.tick();
    expect(pushes).toHaveLength(0);
    await req("/api/notify/test", "POST");
    expect(pushes).toHaveLength(1);
    await req("/api/push/unsubscribe", "POST", { endpoint: sub.endpoint });
    expect(db.pushSubs()).toEqual([]);

    const sw = await call("/sw.js");
    expect(sw.headers.get("Content-Type")).toContain("javascript");
    expect(await sw.text()).toContain("showNotification");
  } finally {
    pushes.length = 0;
    cleanup();
  }
});

test("포트폴리오: 섹션 보기 방식(큰 카드·격자·목록), 항목에 노트를 붙이면 공개 페이지에 자세히 보기 + 노트 사진도 공개", async () => {
  const { call, db, cleanup } = makeApp({ googleEnabled: false });
  try {
    const cookie = ownerSession(db);
    const req = (path: string, method = "GET", b?: object) => call(path, { method, cookie, headers: JSON_ORIGIN, body: b ? JSON.stringify(b) : undefined });
    const pic = db.insertFile({ drive_id: "d-note-pic", name: "shot.png", title: "shot.png", mime: "image/png", size: 10, category: "기타", tags: "", note: "" });
    const note = db.insertNote(
      "작업 기록",
      [
        { id: "a", type: "h1", text: "만든 과정" },
        { id: "b", type: "p", text: "굵게 링크 <script>x</script>", rich: [{ t: "굵게", b: 1 }, { t: " " }, { t: "링크", href: "https://example.com/a" }, { t: " " }, { t: "나쁜", href: "javascript:alert(1)" }, { t: " <script>x</script>" }] },
        { id: "c", type: "number", text: "첫째" },
        { id: "d", type: "number", text: "둘째", d: 1 },
        { id: "e", type: "image", text: "완성 사진", fileId: pic.id },
        { id: "f", type: "table", text: "", width: 2, colHeader: 1, rows: [{ id: "r1", cells: [[{ t: "항목" }], [{ t: "값" }]] }, { id: "r2", cells: [[{ t: "기간" }], [{ t: "3주" }]] }] },
      ],
      "2026-11-22",
    );
    const { sections } = (await (await req("/api/portfolio")).json()) as { sections: { id: number; title: string; layout: string }[] };
    expect(sections.every((x) => x.layout === "cards")).toBe(true); // the default
    const work = sections.find((x) => x.title === "작품")!;
    expect((await req(`/api/portfolio/sections/${work.id}`, "PATCH", { layout: "mosaic" })).status).toBe(400);
    expect(await (await req(`/api/portfolio/sections/${work.id}`, "PATCH", { layout: "grid" })).json()).toMatchObject({ title: "작품", layout: "grid" });
    expect((await req("/api/portfolio/items", "POST", { section_id: work.id, title: "x", note_id: 999 })).status).toBe(400);
    const item = (await (await req("/api/portfolio/items", "POST", { section_id: work.id, title: "다리 모형", public: true, note_id: note.id })).json()) as { id: number; note_id: number };
    expect(item.note_id).toBe(note.id);

    let html = await (await call("/")).text();
    expect(html).toContain(`class="works layout-grid"`);
    expect(html).toContain(`<article class="tile reveal">`);
    expect(html).toContain("<summary>자세히 보기</summary>");
    expect(html).toContain("<h4>만든 과정</h4>");
    expect(html).toContain("<strong>굵게</strong>");
    expect(html).toContain(`<a href="https://example.com/a" target="_blank" rel="noopener">링크</a>`);
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<script>x");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).toContain(`<p class="nb-li" style="margin-left:1.4em"><span>1.</span>둘째</p>`); // numbering under a different depth starts over
    expect(html).toContain(`<img src="/portfolio/file/${pic.id}" alt="" loading="lazy"><figcaption>완성 사진</figcaption>`);
    expect(html).toContain("<th>항목</th><th>값</th></tr><tr><td>기간</td><td>3주</td>");
    expect(db.isPublicFile(pic.id)).toBe(true); // the note's picture opens for anyone while the item is public

    await req(`/api/portfolio/sections/${work.id}`, "PATCH", { layout: "list" });
    html = await (await call("/")).text();
    expect(html).toContain(`class="works layout-list"`);
    expect(html).not.toContain(`class="tile reveal"`);

    // Private item or no note: the picture is private again, and no 자세히 보기.
    await req(`/api/portfolio/items/${item.id}`, "PATCH", { public: false });
    expect(db.isPublicFile(pic.id)).toBe(false);
    await req(`/api/portfolio/items/${item.id}`, "PATCH", { public: true, note_id: null });
    expect(db.isPublicFile(pic.id)).toBe(false);
    expect(await (await call("/")).text()).not.toContain("자세히 보기");
  } finally {
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
    // 파일 편집기 라이브러리는 vendor/ 아래에 있다. 점으로 시작하는 부분("..")과 폴더 자체는 열리지 않는다.
    for (const f of ["/static/pdftools.js", "/static/vendor/pdf-lib.min.js", "/static/vendor/pdf.worker.min.js"]) {
      const res = await call(f);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/javascript");
    }
    expect((await call("/static/vendor/cmaps/UniKS-UCS2-H.bcmap")).status).toBe(200);
    for (const bad of ["/static/vendor", "/static/vendor/", "/static/.well-known", "/static/vendor/..%2f..%2fsrc%2fapp.ts", "/static/vendor/.x"]) expect((await call(bad)).status).toBe(404);
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
    // App install: the manifest is linked from the workspace, and the Android app's key is published.
    expect(await (await call("/admin")).text()).toContain('rel="manifest"');
    expect((await (await call("/static/manifest.webmanifest")).json()).start_url).toBe("/admin");
    const links = await call("/.well-known/assetlinks.json");
    expect(links.headers.get("Content-Type")).toContain("application/json");
    expect((await links.json())[0].target.package_name).toBe("kr.kacarong.workspace");
  } finally {
    cleanup();
  }
});

test("캘린더: 구글이 꺼져 있으면 비어 있음(할 일·시험은 안 나옴)", async () => {
  const { call, db, cleanup } = makeApp({ googleEnabled: false });
  try {
    const cookie = ownerSession(db);
    expect((await call("/api/calendar?from=2026-11-01&to=2026-11-30")).status).toBe(401);
    await call("/api/tasks", { method: "POST", cookie, headers: JSON_ORIGIN, body: JSON.stringify({ title: "장보기", due_date: "2026-11-19" }) });
    await call("/api/exams", { method: "POST", cookie, headers: JSON_ORIGIN, body: JSON.stringify({ title: "중간고사", date: "2026-11-20" }) });
    const r = (await (await call("/api/calendar?from=2026-11-01&to=2026-11-30", { cookie })).json()) as Record<string, unknown>;
    expect(r).toEqual({ google: "off", events: [] });
  } finally {
    cleanup();
  }
});

test("노트: 블록 저장, 날짜 있는 체크박스는 할 일이 되어 오늘·캘린더에 나오고 양쪽이 서로 맞춰짐", async () => {
  const clock = new Date("2026-11-19T03:00:00Z");
  const { call, db, cleanup } = makeApp({ googleEnabled: false, now: () => clock });
  try {
    const cookie = ownerSession(db);
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

test("시험: 일정 적기·고치기·지우기, 오늘 화면에는 2주 안 시험만, 캘린더에는 안 나옴", async () => {
  const { call, db, cleanup } = makeApp({ googleEnabled: false, now: () => new Date("2026-11-20T03:00:00Z") });
  try {
    const cookie = ownerSession(db);
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

    let list = (await req("/api/exams", "GET")).body;
    expect(list.date).toBe("2026-11-20");
    expect(list.exams.map((e: any) => e.title)).toEqual(["지난 퀴즈", "토질역학 중간고사", "토익", "날짜 미정 시험"]);

    // The today screen counts exams within two weeks; the calendar shows none.
    expect((await req("/api/today", "GET")).body.exams.map((e: any) => e.title)).toEqual(["토질역학 중간고사"]);
    const cal = (await req("/api/calendar?from=2026-11-01&to=2026-11-30", "GET")).body;
    expect(cal.exams).toBeUndefined();
    expect(cal.tasks).toBeUndefined();

    expect((await req(`/api/exams/${mid.id}`, "PATCH", { course: "토질역학1", date: "2026-12-01", time: "" })).body).toMatchObject({ course: "토질역학1", date: "2026-12-01", time: null, title: "토질역학 중간고사" });
    expect((await req(`/api/exams/${mid.id}`, "PATCH", { title: " " })).status).toBe(400);
    expect((await req("/api/exams/9999", "PATCH", { title: "x" })).status).toBe(404);
    // Card color: starts with none, takes one of the fixed colors, nothing else.
    expect(mid.color).toBe("");
    expect((await req(`/api/exams/${mid.id}`, "PATCH", { color: "purple" })).body).toMatchObject({ color: "purple", title: "토질역학 중간고사" });
    expect((await req(`/api/exams/${mid.id}`, "PATCH", { color: "#ff0000" })).status).toBe(400);
    expect((await req("/api/exams", "POST", { title: "x", color: "gold" })).status).toBe(400);
    expect((await req(`/api/exams/${mid.id}`, "PATCH", { color: "" })).body).toMatchObject({ color: "" });

    expect((await req(`/api/exams/${mid.id}`, "DELETE")).status).toBe(200);
    list = (await req("/api/exams", "GET")).body;
    expect(list.exams.map((e: any) => e.title)).toEqual(["지난 퀴즈", "토익", "날짜 미정 시험"]);
  } finally {
    cleanup();
  }
});

test("공부: 과목마다 공부할 것을 적고(날짜는 나중에 붙여도 됨) 체크·수정·삭제, 캘린더에는 안 나옴", async () => {
  const { call, db, cleanup } = makeApp({ googleEnabled: false, now: () => new Date("2026-11-20T03:00:00Z") });
  try {
    const cookie = ownerSession(db);
    expect((await call("/api/studies")).status).toBe(401);
    const req = async (path: string, method: string, b?: object) => {
      const r = await call(path, { method, cookie, headers: JSON_ORIGIN, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: (await r.json()) as any };
    };

    const a = (await req("/api/studies", "POST", { date: "2026-11-21", course: "토질역학", title: "3장 복습" })).body;
    expect(a).toMatchObject({ date: "2026-11-21", course: "토질역학", title: "3장 복습", done: 0 });
    await req("/api/studies", "POST", { date: "2026-11-20", title: "영단어 50개" });
    const u = (await req("/api/studies", "POST", { course: "토질역학", title: "4장 정리" })).body; // no day yet
    expect(u).toMatchObject({ date: null, course: "토질역학", title: "4장 정리", done: 0 });
    expect((await req("/api/studies", "POST", { course: "수학", date: "", title: "미적분 문제" })).body.date).toBeNull();
    expect((await req("/api/studies", "POST", { date: "2026-02-30", title: "x" })).status).toBe(400);
    expect((await req("/api/studies", "POST", { date: "2026-11-20", title: " " })).status).toBe(400);

    // In the order they were written (the tab groups them by course).
    let list = (await req("/api/studies", "GET")).body;
    expect(list.date).toBe("2026-11-20");
    expect(list.studies.map((s: any) => [s.date, s.course, s.title])).toEqual([["2026-11-21", "토질역학", "3장 복습"], ["2026-11-20", "", "영단어 50개"], [null, "토질역학", "4장 정리"], [null, "수학", "미적분 문제"]]);

    // The calendar never sees it, not even once today's are in 할 일·과제 (see the next test). One without a day isn't a task.
    expect((await req("/api/tasks", "GET")).body.map((t: any) => t.title)).toEqual(["영단어 50개"]);
    expect((await req("/api/calendar?from=2026-11-01&to=2026-11-30", "GET")).body.tasks).toBeUndefined();

    expect((await req(`/api/studies/${a.id}`, "PATCH", { done: true })).body).toMatchObject({ done: 1 });
    expect((await req(`/api/studies/${a.id}`, "PATCH", { date: "2026-11-22", course: "", title: "4장 복습" })).body).toMatchObject({ date: "2026-11-22", course: "", title: "4장 복습", done: 1 });
    expect((await req(`/api/studies/${a.id}`, "PATCH", { title: "" })).status).toBe(400);
    expect((await req(`/api/studies/${a.id}`, "PATCH", { date: "2026-13-01" })).status).toBe(400);
    expect((await req(`/api/studies/${a.id}`, "PATCH", { date: "" })).body).toMatchObject({ date: null, title: "4장 복습" }); // the day taken off again
    expect((await req("/api/studies/9999", "PATCH", { title: "x" })).status).toBe(404);

    expect((await req(`/api/studies/${a.id}`, "DELETE")).status).toBe(200);
    list = (await req("/api/studies", "GET")).body;
    expect(list.studies.map((s: any) => s.title)).toEqual(["영단어 50개", "4장 정리", "미적분 문제"]);
  } finally {
    cleanup();
  }
});

test("공부 과목 삭제: 그 과목 공부와 할 일이 지워지고 과목은 숨겨지며, 다시 적으면 돌아옴", async () => {
  const { call, db, cleanup } = makeApp({ googleEnabled: false, now: () => new Date("2026-11-20T03:00:00Z") });
  try {
    const cookie = ownerSession(db);
    const req = async (path: string, method: string, b?: object) => {
      const r = await call(path, { method, cookie, headers: JSON_ORIGIN, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: (await r.json()) as any };
    };
    await req("/api/studies", "POST", { date: "2026-11-20", course: "부경인성세미나", title: "소감문" }); // today → also a 할 일
    await req("/api/studies", "POST", { course: "부경인성세미나", title: "발표 준비" });
    await req("/api/studies", "POST", { course: "토질역학", title: "3장 복습" });
    expect((await req("/api/tasks", "GET")).body.map((t: any) => t.title)).toEqual(["소감문"]);
    expect((await req("/api/studies", "GET")).body.hidden).toEqual([]);

    expect((await req("/api/studies/course", "DELETE", { course: "부경인성세미나" })).status).toBe(200);
    expect((await req("/api/studies/course", "DELETE", { course: "항공우주학개론" })).status).toBe(200); // a 시간표 course with no lines
    let list = (await req("/api/studies", "GET")).body;
    expect(list.studies.map((s: any) => s.title)).toEqual(["3장 복습"]);
    expect(list.hidden).toEqual(["부경인성세미나", "항공우주학개론"]);
    expect((await req("/api/tasks", "GET")).body).toEqual([]);

    await req("/api/studies", "POST", { course: "항공우주학개론", title: "1장" }); // written again → back on the tab
    expect((await req("/api/studies", "GET")).body.hidden).toEqual(["부경인성세미나"]);
  } finally {
    cleanup();
  }
});

test("나중에 할 일: 마감일이 되면 오늘 할 일로 옮겨지고, 날짜 없는 것·끝낸 것·아직 먼 것은 그대로", async () => {
  let clock = new Date("2026-11-22T14:59:00Z"); // 11-22 23:59 KST
  const { call, db, cleanup } = makeApp({ googleEnabled: false, now: () => clock });
  try {
    const cookie = ownerSession(db);
    const req = async (path: string, method: string, b?: object) => {
      const r = await call(path, { method, cookie, headers: JSON_ORIGIN, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: (await r.json()) as any };
    };
    const later = (title: string, due_date: string | null) => req("/api/tasks", "POST", { category: "나중에 할 일", title, due_date });
    await later("마감 11-23", "2026-11-23");
    await later("마감 11-25", "2026-11-25");
    await later("날짜 없음", null);
    const done = (await later("끝낸 것", "2026-11-23")).body;
    await req(`/api/tasks/${done.id}`, "PATCH", { done: true });
    const cats = async () => Object.fromEntries([...(await req("/api/tasks", "GET")).body].map((t: any) => [t.title, t.category]));
    expect(await cats()).toEqual({ "마감 11-23": "나중에 할 일", "마감 11-25": "나중에 할 일", "날짜 없음": "나중에 할 일", "끝낸 것": "나중에 할 일" });

    clock = new Date("2026-11-22T15:00:00Z"); // 11-23 00:00 KST
    expect(await cats()).toEqual({ "마감 11-23": "오늘 할 일", "마감 11-25": "나중에 할 일", "날짜 없음": "나중에 할 일", "끝낸 것": "나중에 할 일" });

    // Nobody looked on 11-25: by 11-26 the passed one has moved too, the first time anything is read (here the today screen).
    clock = new Date("2026-11-25T15:00:00Z"); // 11-26 00:00 KST
    expect((await req("/api/today", "GET")).body.overdue.map((t: any) => [t.title, t.category])).toEqual([["마감 11-23", "오늘 할 일"], ["마감 11-25", "오늘 할 일"]]);
  } finally {
    cleanup();
  }
});

test("공부: 그날 0시가 되면 할 일·과제의 오늘 할 일에 들어가고, 어느 쪽에서 체크해도 같이 체크", async () => {
  let clock = new Date("2026-11-22T14:59:00Z"); // 11-22 23:59 KST
  const { call, db, cleanup } = makeApp({ googleEnabled: false, now: () => clock });
  try {
    const cookie = ownerSession(db);
    const req = async (path: string, method: string, b?: object) => {
      const r = await call(path, { method, cookie, headers: JSON_ORIGIN, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: (await r.json()) as any };
    };
    const a = (await req("/api/studies", "POST", { date: "2026-11-23", course: "토질역학", title: "3장 복습" })).body;
    const b = (await req("/api/studies", "POST", { date: "2026-11-23", title: "영단어 50개" })).body;
    await req("/api/studies", "POST", { date: "2026-11-24", title: "내일 것" });
    await req("/api/studies", "POST", { date: "2026-11-21", title: "지난 기록" }); // a day already gone: never a task
    const n = (await req("/api/studies", "POST", { course: "수학", title: "날짜는 나중에" })).body; // no day: waits for one
    expect((await req("/api/tasks", "GET")).body).toEqual([]);

    clock = new Date("2026-11-22T15:00:00Z"); // 11-23 00:00 KST
    let tasks = (await req("/api/tasks", "GET")).body;
    expect(tasks.map((t: any) => [t.kind, t.category, t.course, t.title, t.due_date, t.done])).toEqual([
      ["공부", "오늘 할 일", "토질역학", "3장 복습", "2026-11-23", 0],
      ["공부", "오늘 할 일", "", "영단어 50개", "2026-11-23", 0],
    ]);
    expect((await req("/api/today", "GET")).body.today.map((t: any) => t.title)).toEqual(["3장 복습", "영단어 50개"]);
    expect((await req("/api/calendar?from=2026-11-01&to=2026-11-30", "GET")).body.tasks).toBeUndefined();
    const [ta, tb] = tasks;

    // Checked in 할 일·과제 → checked on the 공부 tab, and the other way round.
    await req(`/api/tasks/${ta.id}`, "PATCH", { done: true });
    expect((await req("/api/studies", "GET")).body.studies.find((s: any) => s.id === a.id).done).toBe(1);
    await req(`/api/studies/${b.id}`, "PATCH", { done: true });
    expect((await req(`/api/tasks?done=1`, "GET")).body.map((t: any) => [t.id, t.done_at])).toEqual([[ta.id, "2026-11-23"], [tb.id, "2026-11-23"]]);
    await req(`/api/studies/${a.id}`, "PATCH", { done: false, title: "3~4장 복습" });
    expect((await req("/api/tasks?done=0", "GET")).body.map((t: any) => [t.title, t.done_at])).toEqual([["3~4장 복습", null]]);

    // Deleted in 할 일·과제: stays deleted, the study stays. Moved to tomorrow: off today, back tomorrow.
    await req(`/api/tasks/${tb.id}`, "DELETE");
    expect((await req("/api/tasks", "GET")).body.map((t: any) => t.title)).toEqual(["3~4장 복습"]);
    expect((await req("/api/studies", "GET")).body.studies.length).toBe(5);
    await req(`/api/studies/${a.id}`, "PATCH", { date: "2026-11-24" });
    expect((await req("/api/tasks", "GET")).body).toEqual([]);
    // Given a day later (the day after): goes in on that day like the rest.
    await req(`/api/studies/${n.id}`, "PATCH", { date: "2026-11-24" });

    clock = new Date("2026-11-23T15:00:00Z"); // 11-24 00:00 KST
    expect((await req("/api/tasks", "GET")).body.map((t: any) => [t.title, t.due_date])).toEqual([["3~4장 복습", "2026-11-24"], ["내일 것", "2026-11-24"], ["날짜는 나중에", "2026-11-24"]]);
    // Its day taken off: off 할 일·과제 until it gets one again. Deleting the study takes its task with it.
    await req(`/api/studies/${n.id}`, "PATCH", { date: "" });
    await req(`/api/studies/${a.id}`, "DELETE");
    expect((await req("/api/tasks", "GET")).body.map((t: any) => t.title)).toEqual(["내일 것"]);
  } finally {
    cleanup();
  }
});

test("공부 날짜가 꼭 있어야 하던 DB를 열면 공부는 그대로, 날짜 없이도 적히고 지우면 할 일도 같이 지워짐", () => {
  const dir = mkdtempSync(join(tmpdir(), "folio-test-"));
  try {
    const path = join(dir, "old.db");
    const raw = new Database(path);
    raw.exec(`
      CREATE TABLE studies (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, course TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), queued INTEGER NOT NULL DEFAULT 0);
      INSERT INTO studies (date, course, title, done, queued) VALUES ('2026-11-23', '구조역학', '2장, 3장 공부', 1, 1);
    `);
    raw.close();
    let db = openDb(path);
    db.insertTask({ kind: "공부", category: "오늘 할 일", title: "2장, 3장 공부", course: "구조역학", due_date: "2026-11-23", due_time: null, note: "" });
    db.raw.query("UPDATE tasks SET study_id = 1").run();
    db.raw.close();
    db = openDb(path); // opening again leaves it as it is
    expect(db.listStudies().map((s) => [s.id, s.date, s.course, s.title, s.done, s.queued])).toEqual([[1, "2026-11-23", "구조역학", "2장, 3장 공부", 1, 1]]);
    expect(db.insertStudy({ date: null, course: "구조역학", title: "4장" }, "2026-11-24")).toMatchObject({ id: 2, date: null, queued: 0 });
    db.deleteStudy(1);
    expect(db.listTasks({}).length).toBe(0);
    db.raw.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("없앤 기능이 남긴 것(시험 공부 계획 칸, 구글로 보내기 표·설정, 공부 기간)은 DB를 열 때 치우고, 할 일·시험·다른 설정은 그대로", () => {
  const dir = mkdtempSync(join(tmpdir(), "folio-test-"));
  try {
    const path = join(dir, "old.db");
    let db = openDb(path);
    // What the old code left: a plan day tied to an exam, its index and trigger, the push table and settings.
    db.raw.exec(`
      ALTER TABLE tasks ADD COLUMN exam_id INTEGER;
      CREATE INDEX tasks_exam ON tasks (exam_id);
      CREATE TRIGGER tasks_exam_gone AFTER DELETE ON exams BEGIN DELETE FROM tasks WHERE exam_id = old.id; END;
      CREATE TABLE gcal_links (key TEXT PRIMARY KEY, event_id TEXT NOT NULL, hash TEXT NOT NULL);
      INSERT INTO settings (key, value) VALUES ('gcal_push_error', ''), ('study_range', '{"from":"2026-11-23","to":"2026-12-17"}'), ('backup_last', '2026-11-25');
    `);
    const exam = db.insertExam({ title: "중간고사", course: "토질역학", date: "2026-11-30", time: null, place: "", scope: "", note: "", color: "" });
    const task = db.insertTask({ kind: "공부", category: "", title: "1장 복습", course: "토질역학", due_date: "2026-11-20", due_time: null, note: "" });
    db.raw.query("UPDATE tasks SET exam_id = ? WHERE id = ?").run(exam.id, task.id);
    db.raw.close();

    db = openDb(path);
    const objects = (db.raw.query("SELECT name FROM sqlite_master").all() as { name: string }[]).map((o) => o.name);
    expect(objects).not.toContain("gcal_links");
    expect(objects).not.toContain("tasks_exam");
    expect(objects).not.toContain("tasks_exam_gone");
    expect((db.raw.query("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name)).not.toContain("exam_id");
    expect([db.getSetting("gcal_push_error"), db.getSetting("study_range"), db.getSetting("backup_last")]).toEqual([null, null, "2026-11-25"]);
    expect(db.getTask(task.id)).toMatchObject({ title: "1장 복습", course: "토질역학", due_date: "2026-11-20" });
    db.deleteExam(exam.id); // the task no longer goes with the exam
    expect(db.getTask(task.id)).not.toBeNull();
    db.raw.close();
    db = openDb(path); // opening again leaves it as it is
    expect(db.getTask(task.id)).not.toBeNull();
    db.raw.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
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

test("백업: 하루 한 번(새벽 2~7시 빼고) folio.db 사본을 드라이브 'kacarong.kr 백업'에, 최근 14일 치만 남김", async () => {
  loginEmail = "owner@example.com";
  let clock = new Date("2026-11-23T01:30:00+09:00");
  const { call, db, backup, cleanup } = makeApp({ now: () => clock });
  const backups = () => {
    const folder = db.getSetting("backup_folder_id");
    return [...drive.values()].filter((f) => folder && f.parents.includes(folder)).map((f) => f.name).sort();
  };
  try {
    await backup.tick(); // Drive not connected yet: nothing to do
    expect(db.getSetting("backup_folder_id")).toBeNull();

    const { cookie } = await login(call);
    const made = await call("/api/tasks", { method: "POST", cookie, headers: JSON_ORIGIN, body: JSON.stringify({ kind: "과제", title: "백업될 과제", due_date: "2026-11-30" }) });
    expect(made.status).toBe(201);
    await backup.tick();
    const folder = drive.get(db.getSetting("backup_folder_id")!)!;
    expect(folder.name).toBe("kacarong.kr 백업");
    expect(backups()).toEqual(["folio-2026-11-23.db"]);
    // The copy is a whole database, with what was just saved (still in the WAL) in it: put back as folio.db it opens as is.
    const file = [...drive.values()].find((f) => f.name === "folio-2026-11-23.db")!;
    const restoreDir = mkdtempSync(join(tmpdir(), "folio-restore-"));
    try {
      writeFileSync(join(restoreDir, "folio.db"), file.raw!);
      const copy = openDb(join(restoreDir, "folio.db"));
      expect(copy.listTasks({}).map((t) => t.title)).toContain("백업될 과제");
      expect(copy.getSetting("refresh_token")).toBe("rt");
      copy.raw.close();
    } finally {
      rmSync(restoreDir, { recursive: true, force: true });
    }

    await backup.tick(); // same day: no second copy
    expect(backups()).toEqual(["folio-2026-11-23.db"]);

    clock = new Date("2026-11-24T03:00:00+09:00"); // quiet hours
    await backup.tick();
    expect(backups()).toHaveLength(1);
    clock = new Date("2026-11-24T07:00:00+09:00");
    await backup.tick();
    expect(backups()).toEqual(["folio-2026-11-23.db", "folio-2026-11-24.db"]);

    // A file of the user's own in the folder is left alone.
    drive.set("mine", { id: "mine", name: "메모.txt", mimeType: "text/plain", parents: [folder.id], trashed: false, bytes: 1 });
    for (let day = 25; day <= 37; day++) {
      clock = new Date(new Date("2026-11-01T12:00:00+09:00").getTime() + (day - 1) * 86400_000);
      await backup.tick();
    }
    expect(backups()).toHaveLength(15); // 14 days + the user's file
    expect(backups()).not.toContain("folio-2026-11-23.db");

    // A day whose prune fails: the copy is up, the oldest stays, and the next hour prunes without a second upload.
    clock = new Date("2026-12-08T12:00:00+09:00");
    driveDeleteFails = true;
    await backup.tick();
    driveDeleteFails = false;
    expect(backups()).toHaveLength(16);
    expect(backups()).toContain("folio-2026-12-08.db");
    clock = new Date("2026-12-08T13:00:00+09:00");
    await backup.tick();
    const left = backups();
    expect(left.filter((n) => n === "folio-2026-12-08.db")).toHaveLength(1);
    expect(left).toHaveLength(15);
    expect(left).toContain("메모.txt");
    expect(left.filter((n) => n.startsWith("folio-"))[0]).toBe("folio-2026-11-25.db"); // the 23rd and 24th went
    expect(left.filter((n) => n.startsWith("folio-"))).toHaveLength(14);
    expect(left).toContain("folio-2026-12-08.db");
  } finally {
    cleanup();
  }
});

test("지출: 매달 나가는 돈(정기)·앞으로 쓸 돈(예정) 만들기·고치기·썼음·지우기, 종류에 안 맞는 칸은 비움", async () => {
  const { call, db, cleanup } = makeApp({ googleEnabled: false, now: () => new Date("2026-11-23T03:00:00Z") });
  try {
    const cookie = ownerSession(db);
    expect((await call("/api/expenses")).status).toBe(401);
    const send = async (path: string, method: string, b: object) => {
      const r = await call(path, { method, cookie, headers: JSON_ORIGIN, body: JSON.stringify(b) });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };

    const phone = await send("/api/expenses", "POST", { kind: "정기", title: "통신비", amount: 55000, day: 25, date: "2026-12-01", note: "알뜰폰" });
    expect(phone.status).toBe(201);
    expect(phone.body).toMatchObject({ kind: "정기", title: "통신비", amount: 55000, day: 25, date: null, done: 0, note: "알뜰폰" });
    const laptop = await send("/api/expenses", "POST", { kind: "예정", title: "노트북", amount: 1500000, day: 3, date: "2026-12-20" });
    expect(laptop.body).toMatchObject({ kind: "예정", amount: 1500000, day: null, date: "2026-12-20", done: 0 });

    for (const bad of [{ title: "" }, { kind: "매년" }, { amount: -1 }, { amount: 1.5 }, { amount: "55000" }, { day: 32 }, { date: "2026-13-01" }]) {
      expect((await send("/api/expenses", "POST", { kind: "정기", title: "x", amount: 1, ...bad })).status).toBe(400);
    }

    // Spent, then moved to 정기: a monthly one is never "spent" and has no date.
    expect((await send(`/api/expenses/${laptop.body.id}`, "PATCH", { done: true })).body).toMatchObject({ done: 1, title: "노트북", amount: 1500000 });
    expect((await send(`/api/expenses/${laptop.body.id}`, "PATCH", { kind: "정기", day: 10 })).body).toMatchObject({ kind: "정기", day: 10, date: null, done: 0 });
    expect((await send(`/api/expenses/${phone.body.id}`, "PATCH", { amount: 33000, day: null })).body).toMatchObject({ amount: 33000, day: null, title: "통신비" });
    expect((await send("/api/expenses/999", "PATCH", { amount: 1 })).status).toBe(404);

    const list = (await (await call("/api/expenses", { cookie })).json()) as { date: string; expenses: { title: string }[] };
    expect(list.date).toBe("2026-11-23");
    expect(list.expenses.map((x) => x.title)).toEqual(["통신비", "노트북"]);
    expect((await call(`/api/expenses/${phone.body.id}`, { method: "DELETE", cookie, headers: JSON_ORIGIN })).status).toBe(200);
    expect(((await (await call("/api/expenses", { cookie })).json()) as { expenses: unknown[] }).expenses).toHaveLength(1);
  } finally {
    cleanup();
  }
});

test("시간표: 지금 학기는 늘 있고, 학기 추가·과목(시간·강의실·학점·성적·전공) 만들기·고치기·지우기, 학기를 지우면 과목도", async () => {
  const { call, db, cleanup } = makeApp({ googleEnabled: false, now: () => new Date("2026-11-23T03:00:00Z") });
  try {
    const cookie = ownerSession(db);
    expect((await call("/api/timetable")).status).toBe(401);
    const send = async (path: string, method: string, b?: object) => {
      const r = await call(path, { method, cookie, headers: JSON_ORIGIN, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: (await r.json()) as Record<string, any> };
    };

    const first = (await send("/api/timetable", "GET")).body;
    expect(first.current).toEqual({ year: 2026, term: "2" });
    expect(first.semesters).toMatchObject([{ year: 2026, term: "2" }]);
    const now = first.semesters[0].id;
    expect((await send("/api/timetable", "GET")).body.semesters).toHaveLength(1); // not twice

    // A past and a future semester; listed in order.
    expect((await send("/api/semesters", "POST", { year: 2027, term: "1" })).status).toBe(201);
    const past = (await send("/api/semesters", "POST", { year: 2026, term: "1" })).body;
    expect((await send("/api/semesters", "POST", { year: 2026, term: "1" })).status).toBe(409);
    expect((await send("/api/semesters", "POST", { year: 2026, term: "3" })).status).toBe(400);
    await send("/api/semesters", "POST", { year: 2026, term: "여름" });
    expect((await send("/api/timetable", "GET")).body.semesters.map((s: any) => `${s.year}-${s.term}`)).toEqual(["2026-1", "2026-여름", "2026-2", "2027-1"]);

    const c = await send("/api/courses", "POST", {
      semester_id: now, name: "수리학및실험", professor: "오정은", credits: 3, grade: "B+", major: true, color: "pink",
      times: [{ day: 3, start: "11:00", end: "12:50", room: "A23-206" }, { day: 1, start: "16:00", end: "17:50", room: "A15-204" }],
    });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ semester_id: now, name: "수리학및실험", credits: 3, grade: "B+", major: 1, color: "pink", times: [{ day: 3, room: "A23-206" }, { day: 1, start: "16:00" }] });
    const online = (await send("/api/courses", "POST", { semester_id: now, name: "부경인성세미나", credits: 0.5 })).body;
    expect(online).toMatchObject({ credits: 0.5, grade: "", major: 0, times: [] });

    for (const bad of [
      { name: "" }, { semester_id: 999 }, { credits: 1.3 }, { credits: -1 }, { credits: "3" }, { grade: "A" }, { color: "black" },
      { times: [{ day: 7, start: "09:00", end: "10:00" }] }, { times: [{ day: 0, start: "10:00", end: "09:00" }] }, { times: [{ day: 0, start: "9:00", end: "10:00" }] }, { times: "월 9시" },
    ]) {
      expect((await send("/api/courses", "POST", { semester_id: now, name: "x", ...bad })).status).toBe(400);
    }
    expect((await send("/api/courses", "POST", { name: "x" })).status).toBe(400);

    // Grade, major and moving it to another semester; the other fields stay.
    expect((await send(`/api/courses/${c.body.id}`, "PATCH", { grade: "A+", major: false })).body).toMatchObject({ grade: "A+", major: 0, name: "수리학및실험", times: [{ day: 3 }, { day: 1 }] });
    expect((await send(`/api/courses/${online.id}`, "PATCH", { semester_id: past.id, grade: "P" })).body).toMatchObject({ semester_id: past.id, grade: "P", name: "부경인성세미나" });
    expect((await send("/api/courses/999", "PATCH", { grade: "A0" })).status).toBe(404);

    const list = (await send("/api/timetable", "GET")).body;
    expect(list.courses.map((x: any) => x.name)).toEqual(["수리학및실험", "부경인성세미나"]);
    expect((await send(`/api/semesters/${past.id}`, "DELETE")).status).toBe(200);
    expect((await send("/api/timetable", "GET")).body.courses.map((x: any) => x.name)).toEqual(["수리학및실험"]);
    expect((await send(`/api/courses/${c.body.id}`, "DELETE")).status).toBe(200);
    expect((await send("/api/timetable", "GET")).body.courses).toEqual([]);
  } finally {
    cleanup();
  }
});

test("수업일정: 바뀐 수업(변경·보강·휴강)을 적으면 그 수업 전날 저녁 8시에 알림, 그날 밤 늦게 적어도 알림, 날짜를 바꾸면 새 날짜 전날에 다시", async () => {
  let clock = new Date("2026-11-23T10:00:00+09:00");
  const { call, db, notifier, cleanup } = makeApp({ now: () => clock, googleEnabled: false });
  try {
    const cookie = ownerSession(db);
    const send = async (path: string, method: string, b?: object) => {
      const r = await call(path, { method, cookie, headers: JSON_ORIGIN, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: (await r.json()) as Record<string, any> };
    };
    const notes = async () => db.raw.query("SELECT title, body FROM notifications ORDER BY id").all() as { title: string; body: string }[];
    db.setSetting("notify_settings", JSON.stringify({ morning: "" })); // only class changes in this test

    const moved = await send("/api/class-changes", "POST", { course: "구조역학", kind: "변경", date: "2026-11-25", start: "15:00", end: "17:50", place: "A23-215", from_date: "2026-11-24", note: "교수님 출장" });
    expect(moved.status).toBe(201);
    expect(moved.body).toMatchObject({ course: "구조역학", kind: "변경", date: "2026-11-25", start: "15:00", end: "17:50", place: "A23-215", from_date: "2026-11-24" });
    const off = await send("/api/class-changes", "POST", { course: "교통공학", kind: "휴강", date: "2026-11-24", start: "09:00", place: "A23-215" });
    expect(off.body).toMatchObject({ kind: "휴강", start: null, end: null, place: "" }); // 휴강 has no time or place
    for (const bad of [{ course: "" }, { date: "" }, { date: "2026-02-30" }, { kind: "취소" }, { start: "25:00" }, { start: "15:00", end: "14:00" }]) {
      expect((await send("/api/class-changes", "POST", { course: "x", kind: "보강", date: "2026-11-26", ...bad })).status).toBe(400);
    }
    expect((await send("/api/class-changes", "GET")).body.changes.map((c: any) => c.course)).toEqual(["교통공학", "구조역학"]); // by date

    // 11/23 20:00: tomorrow (11/24) is the 휴강.
    clock = new Date("2026-11-23T19:59:00+09:00");
    await notifier.tick();
    expect(await notes()).toEqual([]);
    clock = new Date("2026-11-23T20:00:30+09:00");
    await notifier.tick();
    await notifier.tick(); // once
    expect(await notes()).toMatchObject([{ title: "내일 휴강 · 교통공학", body: "11월 24일 (화)" }]);

    // Written down late on the evening before: still told that night.
    clock = new Date("2026-11-23T23:10:00+09:00");
    await send("/api/class-changes", "POST", { course: "토질공학및실험", kind: "보강", date: "2026-11-24", start: "18:00", end: "19:50", place: "A23-215" });
    await notifier.tick();
    expect((await notes()).map((n) => n.title)).toEqual(["내일 휴강 · 교통공학", "내일 보강 · 토질공학및실험"]);

    // 11/24 20:00: the moved class on 11/25, with where it came from and the note.
    clock = new Date("2026-11-24T20:00:00+09:00");
    await notifier.tick();
    expect((await notes())[2]).toEqual(expect.objectContaining({ title: "내일 수업 변경 · 구조역학", body: "11월 25일 (수) 15:00~17:50 · A23-215\n원래 11월 24일 (화) 수업\n교수님 출장" }));

    // Moved again to 11/27: told again the evening before the new day; deleted ones are not.
    await send(`/api/class-changes/${moved.body.id}`, "PATCH", { date: "2026-11-27" });
    await send(`/api/class-changes/${off.body.id}`, "PATCH", { date: "2026-11-27" });
    await send(`/api/class-changes/${off.body.id}`, "DELETE");
    expect((await send(`/api/class-changes/${off.body.id}`, "PATCH", { note: "x" })).status).toBe(404);
    clock = new Date("2026-11-26T20:30:00+09:00");
    await notifier.tick();
    expect((await notes()).slice(3).map((n) => n.title)).toEqual(["내일 수업 변경 · 구조역학"]);

    // Turned off: nothing.
    await send("/api/class-changes", "POST", { course: "교통공학", kind: "보강", date: "2026-11-28" });
    await send("/api/notify", "PUT", { morning: "", homework: true, exam: true, classes: false });
    clock = new Date("2026-11-27T20:00:00+09:00");
    await notifier.tick();
    expect(await notes()).toHaveLength(4);
  } finally {
    cleanup();
  }
});

test("시간표·수업일정: 본문이 늦게 오는 PATCH 가 그사이 저장된 다른 칸을 옛 값으로 되돌리지 않음", async () => {
  const { call, db, cleanup } = makeApp({ googleEnabled: false, now: () => new Date("2026-11-23T03:00:00Z") });
  try {
    const cookie = ownerSession(db);
    const send = async (path: string, method: string, b: object) => (await call(path, { method, cookie, headers: JSON_ORIGIN, body: JSON.stringify(b) })).json() as Promise<Record<string, any>>;
    // A PATCH whose body arrives only when release() is called.
    const slow = (path: string, b: object) => {
      let release!: () => void;
      const stream = new ReadableStream({ start: (c) => void (release = () => (c.enqueue(new TextEncoder().encode(JSON.stringify(b))), c.close())) });
      const res = call(path, { method: "PATCH", cookie, headers: JSON_ORIGIN, body: stream, duplex: "half" } as RequestInit);
      return { res, release };
    };
    const tick = () => new Promise((ok) => setTimeout(ok, 20));

    const sem = ((await (await call("/api/timetable", { cookie })).json()) as any).semesters[0].id;
    const c = await send("/api/courses", "POST", { semester_id: sem, name: "구조역학", credits: 3 });
    const grade = slow(`/api/courses/${c.id}`, { grade: "A+" });
    await tick();
    await send(`/api/courses/${c.id}`, "PATCH", { credits: 4 });
    grade.release();
    await grade.res;
    expect(db.getCourse(c.id)).toMatchObject({ credits: 4, grade: "A+" });

    const cc = await send("/api/class-changes", "POST", { course: "교통공학", kind: "보강", date: "2026-11-26" });
    const note = slow(`/api/class-changes/${cc.id}`, { note: "A23-215" });
    await tick();
    await send(`/api/class-changes/${cc.id}`, "PATCH", { start: "10:00" });
    note.release();
    await note.res;
    expect(db.getClassChange(cc.id)).toMatchObject({ start: "10:00", note: "A23-215" });
  } finally {
    cleanup();
  }
});

test("전체 검색: 노트(본문 포함)·할 일·과제·시험·공부·지출·클라우드 파일을 한꺼번에, 대소문자 무시, 노션 사본은 빼고", async () => {
  const { call, db, cleanup } = makeApp({ googleEnabled: false, now: () => new Date("2026-11-27T03:00:00Z") });
  try {
    const cookie = ownerSession(db);
    expect((await call("/api/search?q=x")).status).toBe(401);
    const req = async (path: string, method: string, b: object) => (await call(path, { method, cookie, headers: JSON_ORIGIN, body: JSON.stringify(b) })).json() as Promise<{ id: number; version: number }>;
    const note = await req("/api/notes", "POST", { title: "수업 메모" });
    const v = ((await (await call(`/api/notes/${note.id}`, { cookie })).json()) as { version: number }).version;
    await req(`/api/notes/${note.id}`, "PUT", { title: "수업 메모", version: v, blocks: [{ id: "a", type: "p", text: "오늘은 Fluid 역학의\n베르누이 정리를 배웠다" }] });
    await req("/api/notes", "POST", { title: "관계없는 노트" });
    await req("/api/tasks", "POST", { kind: "과제", title: "유체역학 레포트", course: "유체역학", due_date: "2026-11-30" });
    await req("/api/tasks", "POST", { kind: "할 일", title: "장보기", note: "fluid 세제" });
    await req("/api/exams", "POST", { title: "기말고사", course: "유체역학", date: "2026-12-15" });
    await req("/api/studies", "POST", { course: "유체역학", title: "3장 문제" });
    await req("/api/expenses", "POST", { kind: "정기", title: "통신비", amount: 33000, day: 25, note: "FLUID 요금제" });
    db.insertFile({ drive_id: "s1", name: "fluid.pdf", title: "유체 강의자료", mime: "application/pdf", size: 10, category: "강의", tags: "", note: "" });
    db.insertFile({ drive_id: "s2", name: "fluid.png", title: "노션 사진", mime: "image/png", size: 10, category: "기타", tags: "", note: "", origin: "notion" });

    type Hits = Record<"notes" | "tasks" | "exams" | "studies" | "expenses" | "files", { title: string; snippet?: string }[]>;
    const search = async (q: string) => (await (await call("/api/search?" + new URLSearchParams({ q }), { cookie })).json()) as Hits;
    const titles = (h: Hits) => Object.fromEntries(Object.entries(h).map(([k, list]) => [k, list.map((x) => x.title)]));

    expect(titles(await search("  FLUID "))).toEqual({ notes: ["수업 메모"], tasks: ["장보기"], exams: [], studies: [], expenses: ["통신비"], files: ["유체 강의자료"] });
    expect((await search("베르누이")).notes[0]!.snippet).toBe("오늘은 Fluid 역학의 베르누이 정리를 배웠다");
    expect(titles(await search("유체역학"))).toEqual({ notes: [], tasks: ["유체역학 레포트"], exams: ["기말고사"], studies: ["3장 문제"], expenses: [], files: [] });
    expect(titles(await search(" "))).toEqual({ notes: [], tasks: [], exams: [], studies: [], expenses: [], files: [] });

    // Long note text: the snippet starts a little before the hit; only 20 of each kind come back.
    const long = await req("/api/notes", "POST", { title: "긴 노트" });
    const lv = ((await (await call(`/api/notes/${long.id}`, { cookie })).json()) as { version: number }).version;
    await req(`/api/notes/${long.id}`, "PUT", { title: "긴 노트", version: lv, blocks: [{ id: "a", type: "p", text: "가".repeat(200) + "찾는말" + "나".repeat(200) }] });
    expect((await search("찾는말")).notes[0]!.snippet).toBe("…" + "가".repeat(30) + "찾는말" + "나".repeat(67));
    for (let i = 0; i < 25; i++) await req("/api/tasks", "POST", { kind: "할 일", title: `반복 ${i}` });
    expect((await search("반복")).tasks).toHaveLength(20);
  } finally {
    cleanup();
  }
});

test("백업 상태: 마지막 백업 시각·실패 이유·드라이브의 백업 목록을 보여 주고, 지금 백업(같은 날은 새 사본만 남김)·받기", async () => {
  loginEmail = "owner@example.com";
  let clock = new Date("2026-11-27T13:00:00+09:00");
  const { call, db, backup, cleanup } = makeApp({ now: () => clock });
  type Status = { on: boolean; late: boolean; keep: number; last: string | null; at: string | null; error: { at: string; message: string } | null; files: { id: string; name: string; size: number }[]; listError: string | null };
  try {
    const { cookie } = await login(call);
    const status = async () => (await (await call("/api/backup", { cookie })).json()) as Status;
    const now = () => call("/api/backup", { method: "POST", cookie, headers: JSON_ORIGIN });
    expect(await status()).toMatchObject({ on: true, keep: 14, last: null, at: null, error: null, files: [], listError: null });

    await backup.tick();
    let s = await status();
    expect(s).toMatchObject({ last: "2026-11-27", at: "2026-11-27T04:00:00.000Z", error: null });
    expect(s.files.map((f) => f.name)).toEqual(["folio-2026-11-27.db"]);
    expect(s.files[0]!.size).toBe(db.raw.serialize().byteLength);
    const first = s.files[0]!.id;

    // 지금 백업 on a day already copied: a new copy goes up and only it stays.
    clock = new Date("2026-11-27T15:30:00+09:00");
    const r = await now();
    expect(r.status).toBe(200);
    s = (await r.json()) as Status;
    expect(s.at).toBe("2026-11-27T06:30:00.000Z");
    expect(s.files.map((f) => f.name)).toEqual(["folio-2026-11-27.db"]);
    expect(s.files[0]!.id).not.toBe(first);
    expect(drive.has(first)).toBe(false);

    // A failure is shown until the next backup goes through.
    driveDeleteFails = true;
    clock = new Date("2026-11-28T09:00:00+09:00");
    await backup.tick(); // the 28th goes up and nothing needs removing, so nothing fails yet
    expect((await status()).error).toBeNull();
    const failed = await now(); // a second copy of the 28th: removing the older one fails
    driveDeleteFails = false;
    expect(failed.status).toBe(502);
    s = await status();
    expect(s.error).toMatchObject({ at: "2026-11-28T00:00:00.000Z" });
    expect(s.error!.message).toContain("드라이브에서 지우기");
    // The day was done before 지금 백업 failed; the next hourly look still finishes it (prunes) and clears the error.
    clock = new Date("2026-11-28T10:00:00+09:00");
    const uploads = [...drive.values()].length;
    await backup.tick();
    s = await status();
    expect(s.error).toBeNull();
    expect([...drive.values()].length).toBe(uploads - 1); // no new upload, the older copy of the 28th removed
    expect(s.files.map((f) => f.name)).toEqual(["folio-2026-11-28.db", "folio-2026-11-27.db"]);
    expect((await now()).status).toBe(200);

    // A failed upload in 지금 백업 (the day already has a copy, and the data changed since): the next hourly look
    // uploads again, and the error clears only once that upload is through.
    const before = (await status()).files[0]!.id;
    const at = (await status()).at;
    const made = await call("/api/tasks", { method: "POST", cookie, headers: JSON_ORIGIN, body: JSON.stringify({ kind: "할 일", title: "백업 뒤에 적은 일" }) });
    expect(made.status).toBe(201);
    uploadFails = true;
    clock = new Date("2026-11-28T11:00:00+09:00");
    expect((await now()).status).toBe(502);
    expect((await status()).error!.message).toContain("업로드");
    clock = new Date("2026-11-28T12:00:00+09:00");
    await backup.tick(); // still failing: the error stays, the last good copy is still the one shown
    s = await status();
    expect(s.error!.at).toBe("2026-11-28T03:00:00.000Z");
    expect(s.at).toBe(at);
    uploadFails = false;
    clock = new Date("2026-11-28T13:00:00+09:00");
    await backup.tick();
    s = await status();
    expect(s.error).toBeNull();
    expect(s.at).toBe("2026-11-28T04:00:00.000Z");
    expect(s.files.map((f) => f.name)).toEqual(["folio-2026-11-28.db", "folio-2026-11-27.db"]);
    expect(s.files[0]!.id).not.toBe(before);
    const restoreDir = mkdtempSync(join(tmpdir(), "folio-restore-"));
    try {
      writeFileSync(join(restoreDir, "folio.db"), drive.get(s.files[0]!.id)!.raw!);
      const copy = openDb(join(restoreDir, "folio.db"));
      expect(copy.listTasks({}).map((t) => t.title)).toContain("백업 뒤에 적은 일");
      copy.raw.close();
    } finally {
      rmSync(restoreDir, { recursive: true, force: true });
    }
    await backup.tick(); // done for the day: nothing more goes up
    expect((await status()).files[0]!.id).toBe(s.files[0]!.id);

    // late: today's copy is due from 08:00, not 24 hours after the last one.
    expect(s.late).toBe(false);
    clock = new Date("2026-11-29T07:30:00+09:00"); // last copy yesterday, today's not due yet
    expect((await status()).late).toBe(false);
    clock = new Date("2026-11-29T08:00:00+09:00");
    expect((await status()).late).toBe(true);
    clock = new Date("2026-11-30T03:00:00+09:00"); // last copy two days ago
    expect((await status()).late).toBe(true);

    // 받기: only a copy in the backup folder.
    s = await status();
    const got = await call(`/api/backup/${s.files[0]!.id}`, { cookie });
    expect(got.status).toBe(200);
    expect(got.headers.get("Content-Disposition")).toContain('filename="folio-2026-11-28.db"');
    expect((await got.arrayBuffer()).byteLength).toBe(s.files[0]!.size);
    expect((await call(`/api/backup/${db.getSetting("backup_folder_id")}`, { cookie })).status).toBe(404);
    expect((await call(`/api/backup/${s.files[0]!.id}`)).status).toBe(401);
  } finally {
    cleanup();
  }
});

test("백업 상태: 드라이브가 연결되지 않았으면 꺼짐, 지금 백업은 거절", async () => {
  const { call, db, cleanup } = makeApp({ googleEnabled: false });
  try {
    const cookie = ownerSession(db);
    expect(await (await call("/api/backup", { cookie })).json()).toMatchObject({ on: false, files: [], error: null });
    expect((await call("/api/backup", { method: "POST", cookie, headers: JSON_ORIGIN })).status).toBe(409);
  } finally {
    cleanup();
  }
});

test("PC 프로그램 업데이트: DATA_DIR/desktop 의 latest.json(캐시 안 함)과 설치 파일만 로그인 없이 받음", async () => {
  const { call, db, cleanup } = makeApp({ googleEnabled: false });
  try {
    const dir = join(db.raw.filename, "..", "desktop");
    expect((await call("/desktop/latest.json")).status).toBe(404);
    mkdirSync(dir);
    writeFileSync(join(dir, "latest.json"), '{"version":"1.3.0"}');
    writeFileSync(join(dir, "kacarong-Setup-1.3.0.exe"), "MZ-setup");
    writeFileSync(join(dir, "other.txt"), "x");
    const latest = await call("/desktop/latest.json");
    expect(latest.status).toBe(200);
    expect(latest.headers.get("Cache-Control")).toBe("no-store");
    expect(await latest.json()).toEqual({ version: "1.3.0" });
    const exe = await call("/desktop/kacarong-Setup-1.3.0.exe");
    expect(exe.status).toBe(200);
    expect(exe.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(await exe.text()).toBe("MZ-setup");
    for (const p of ["/desktop/other.txt", "/desktop/kacarong-Setup-1.4.0.exe", "/desktop/..%2Ft.db", "/desktop/"]) expect((await call(p)).status).toBe(404);
  } finally {
    cleanup();
  }
});

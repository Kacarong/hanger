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

function makeApp() {
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
  const fetch = createApp({ baseUrl: "https://kacarong.kr", adminEmail: "owner@example.com", dataDir }, db, google);
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

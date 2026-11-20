import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "./app";
import { openDb } from "./db";
import { createGoogle } from "./google";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`환경변수 ${name} 가 필요합니다`);
  return v;
}

const baseUrl = need("BASE_URL").replace(/\/$/, "");
const dataDir = process.env.DATA_DIR ?? join(import.meta.dir, "..", "data");
mkdirSync(dataDir, { recursive: true });

// Google login and Drive stay off until the OAuth client and admin email are all set.
const adminEmail = (process.env.ADMIN_EMAIL ?? "").toLowerCase();
const googleEnabled = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && adminEmail);

const db = openDb(join(dataDir, "folio.db"));
if (!db.getSetting("password_hash")) console.warn("비밀번호가 없습니다. `bun run set-password` 로 설정하세요.");
const google = createGoogle(
  {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    redirectUri: `${baseUrl}/auth/callback`,
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    apiBase: "https://www.googleapis.com",
  },
  db,
);
const fetch = createApp({ baseUrl, adminEmail, dataDir, googleEnabled }, db, google);

fetch.moveNotionCopies().catch((e) => console.error("노션 사본 옮기기 실패(다음 시작 때 다시):", e));
fetch.notion.start(60_000); // look for edits in Notion every minute (and a full pass every half hour)

const server = Bun.serve({
  hostname: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 2992),
  fetch,
});
console.log(`kacarong-folio listening on ${server.url}`);

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
if (!googleEnabled) console.warn("구글 설정(GOOGLE_CLIENT_ID·GOOGLE_CLIENT_SECRET·ADMIN_EMAIL)이 없어 아무도 로그인할 수 없습니다.");
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
fetch.notifier.start(60_000); // 알림: look every minute for notifications that are due
fetch.backup.start(60 * 60_000); // once a day, a copy of folio.db to Drive (looked at every hour)
fetch.scholarship.start(15 * 60_000); // 장학금: 6시간마다 다시 모으고, 15분마다 알릴 것을 본다

const server = Bun.serve({
  hostname: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 2992),
  idleTimeout: 60, // 장학금 출처 더하기는 그 게시판을 한 번 읽어 보느라 10초(기본값)를 넘길 수 있다
  fetch,
});
console.log(`kacarong-folio listening on ${server.url}`);

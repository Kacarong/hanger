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

const db = openDb(join(dataDir, "folio.db"));
const google = createGoogle(
  {
    clientId: need("GOOGLE_CLIENT_ID"),
    clientSecret: need("GOOGLE_CLIENT_SECRET"),
    redirectUri: `${baseUrl}/auth/callback`,
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    apiBase: "https://www.googleapis.com",
  },
  db,
);
const fetch = createApp({ baseUrl, adminEmail: need("ADMIN_EMAIL").toLowerCase(), dataDir }, db, google);

const server = Bun.serve({
  hostname: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 2992),
  fetch,
});
console.log(`kacarong-folio listening on ${server.url}`);

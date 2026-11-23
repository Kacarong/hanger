// 변환 서버(deploy/kacarong-convert.service): 127.0.0.1에서 사이트의 변환 요청만 받는다. 한 번에 하나씩 변환한다.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CONVERT_MAX, convertFile } from "./convert";

const token = process.env.CONVERT_TOKEN;
if (!token) throw new Error("환경변수 CONVERT_TOKEN 이 필요합니다");
const dir = process.env.CONVERT_DIR ?? join(import.meta.dir, "..", "convert-data");
mkdirSync(dir, { recursive: true });

let queue: Promise<unknown> = Promise.resolve();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.CONVERT_PORT ?? 2994),
  maxRequestBodySize: CONVERT_MAX,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/convert") return new Response("not found", { status: 404 });
    if (req.headers.get("Authorization") !== `Bearer ${token}`) return new Response("forbidden", { status: 403 });
    const name = url.searchParams.get("name") ?? "";
    const input = new Uint8Array(await req.arrayBuffer());
    const job = queue.then(() => convertFile(input, name, dir));
    queue = job.catch(() => {});
    try {
      return new Response(await job, { headers: { "Content-Type": "application/octet-stream" } });
    } catch (e) {
      console.error("변환 실패:", name, e);
      return Response.json({ error: (e as Error).message }, { status: 422 });
    }
  },
});
console.log(`kacarong-convert listening on ${server.url}`);

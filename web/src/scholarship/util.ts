import { createHash } from "node:crypto";

// 장학금 한 건. 출처마다 칸이 조금씩 달라서 필수 칸만 이름을 붙이고 나머지는 열어 둔다.
export type Item = {
  id: string; // 같은 장학금의 같은 회차면 같은 id
  series: string; // 회차가 달라도 같은 장학금이면 같은 series — 관심 표시는 이 단위로 한다
  org: string;
  name: string;
  start?: string; // YYYY-MM-DD, 모르면 ""
  end?: string;
  [key: string]: any;
};

// 원본(unifi-site 파이썬)과 같은 열쇠: sha1("a|b|c") 앞 12자리. 같은 장학금이면 어디서 왔든 같은 id·series.
export function key(...parts: string[]): string {
  return createHash("sha1").update(parts.map((p) => p.trim()).join("|")).digest("hex").slice(0, 12);
}

// 날짜는 "YYYY-MM-DD" 글자로 다룬다. 날짜가 아니면 null.
export function parseDate(text: string | null | undefined): string | null {
  const s = (text ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s) ? s : null;
}

// 연·월·일 → "YYYY-MM-DD", 없는 날짜(2월 30일)면 null.
export function ymd(y: number, m: number, d: number): string | null {
  if (!(y >= 1 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  return parseDate(`${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
}

// b - a (일)
export function days(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400_000);
}

export function addDays(date: string, n: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// 한 해 뒤 같은 날. 2월 29일은 28일로.
export function plusYear(date: string): string {
  const y = Number(date.slice(0, 4)) + 1;
  return ymd(y, Number(date.slice(5, 7)), Number(date.slice(8, 10))) ?? ymd(y, Number(date.slice(5, 7)), 28)!;
}

// HTML 엔티티 풀기 — 게시판·포털 글자에 나오는 것들.
const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", hellip: "…", ndash: "–", mdash: "—",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", times: "×", copy: "©", reg: "®", trade: "™", laquo: "«", raquo: "»",
  sim: "∼", rarr: "→", larr: "←", uarr: "↑", darr: "↓", deg: "°", plusmn: "±", cent: "¢", pound: "£", yen: "¥", euro: "€", sect: "§",
};
export function unescapeHtml(s: string): string {
  return s.replace(/&(#\d{1,7}|#[xX][\da-fA-F]{1,6}|[a-zA-Z]{2,8});?/g, (all, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
    }
    return NAMED[e] ?? NAMED[e.toLowerCase()] ?? all;
  });
}

// 태그를 걷어 낸 글자 한 줄.
export function text(fragment: string): string {
  return unescapeHtml(fragment.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

// 받는 쪽 오류를 한 종류로 묶는다.
export class SourceError extends Error {}

export const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";

// fetch + 시간 제한. 응답이 2xx 가 아니면 SourceError.
export async function get(url: string, init: RequestInit = {}, timeoutMs = 30_000, what = "응답"): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { "User-Agent": UA, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new SourceError(`${what}을 읽지 못했습니다: ${(e as Error).message}`);
  }
  if (!res.ok) {
    await res.arrayBuffer().catch(() => {});
    throw new SourceError(`${what}을 읽지 못했습니다: HTTP ${res.status}`);
  }
  return res;
}

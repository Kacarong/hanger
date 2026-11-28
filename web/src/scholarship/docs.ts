// 공고 원문(HTML 본문·첨부 HWP/HWPX/PDF/ZIP)에서 글자를 뽑고 신청 기간을 읽는다.
// 재단 공고는 본문이 이미지 한 장이고 날짜는 첨부 공고문에만 있는 경우가 많다. 사람이 파일을 내려받아 열어 봐야 알던 것을 여기서 대신 한다.
//   textOf(data, name)        파일 바이트 → 글자 (HWP5·HWPX·PDF·ZIP 안의 그것들)
//   findPeriod(text, posted)  글자 → [시작일, 마감일]. 연도가 빠진 날짜는 게시일로 채운다.
import { inflateRawSync } from "node:zlib";
import { days, unescapeHtml, ymd } from "./util";

export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 공고문은 보통 1MB 안쪽. 큰 건 이미지 묶음이라 읽어도 소용없다.

// ---------------------------------------------------------------------------
// ZIP (HWPX 도 ZIP 이다) — 중앙 디렉터리만 읽는 작은 읽개. 저장(0)·deflate(8)만.
// ---------------------------------------------------------------------------
type ZipEntry = { name: string; size: number; method: number; offset: number; compSize: number };

export function zipEntries(buf: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("ZIP 이 아님");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("ZIP 목록이 깨짐");
    const flags = buf.readUInt16LE(p + 8), nameLen = buf.readUInt16LE(p + 28);
    const raw = buf.subarray(p + 46, p + 46 + nameLen);
    // UTF-8 표시가 없으면 한글 이름은 CP949 다
    const name = new TextDecoder(flags & 0x800 ? "utf-8" : "euc-kr").decode(raw);
    out.push({ name, method: buf.readUInt16LE(p + 10), compSize: buf.readUInt32LE(p + 20), size: buf.readUInt32LE(p + 24), offset: buf.readUInt32LE(p + 42) });
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}

export function zipRead(buf: Buffer, e: ZipEntry): Buffer {
  if (buf.readUInt32LE(e.offset) !== 0x04034b50) throw new Error("ZIP 항목이 깨짐");
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
  const data = buf.subarray(start, start + e.compSize);
  if (e.method === 0) return Buffer.from(data);
  if (e.method === 8) return inflateRawSync(data, { maxOutputLength: MAX_FILE_BYTES + 1 });
  throw new Error("모르는 ZIP 압축");
}

// ---------------------------------------------------------------------------
// OLE 복합 문서(CFB) — HWP5 가 이 안에 들어 있다. 스트림 하나를 이름으로 꺼내는 데 필요한 만큼만.
// ---------------------------------------------------------------------------
function cfb(buf: Buffer) {
  const sectorSize = 1 << buf.readUInt16LE(0x1e);
  const miniSize = 1 << buf.readUInt16LE(0x20);
  const cutoff = buf.readUInt32LE(0x38);
  const END = 0xfffffffe;
  const sector = (n: number) => buf.subarray((n + 1) * sectorSize, (n + 2) * sectorSize);
  // FAT 섹터 번호: 머리의 109개 + DIFAT 섹터 사슬
  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i++) fatSectors.push(buf.readUInt32LE(0x4c + i * 4));
  for (let d = buf.readUInt32LE(0x44), guard = 0; d < END && guard < 10_000; guard++) {
    const s = sector(d);
    for (let i = 0; i < sectorSize / 4 - 1; i++) fatSectors.push(s.readUInt32LE(i * 4));
    d = s.readUInt32LE(sectorSize - 4);
  }
  const fat: number[] = [];
  for (const f of fatSectors) {
    if (f >= END) continue;
    const s = sector(f);
    for (let i = 0; i < sectorSize / 4; i++) fat.push(s.readUInt32LE(i * 4));
  }
  const chain = (start: number, table: number[]) => {
    const out: number[] = [];
    for (let n = start; n < END && out.length <= table.length; n = table[n] ?? END) out.push(n);
    return out;
  };
  const readChain = (start: number) => Buffer.concat(chain(start, fat).map(sector));
  const dir = readChain(buf.readUInt32LE(0x30));
  type Entry = { name: string; type: number; left: number; right: number; child: number; start: number; size: number };
  const entries: Entry[] = [];
  for (let p = 0; p + 128 <= dir.length; p += 128) {
    const len = dir.readUInt16LE(p + 0x40);
    entries.push({
      name: dir.subarray(p, p + Math.max(0, len - 2)).toString("utf16le"),
      type: dir[p + 0x42]!,
      left: dir.readUInt32LE(p + 0x44),
      right: dir.readUInt32LE(p + 0x48),
      child: dir.readUInt32LE(p + 0x4c),
      start: dir.readUInt32LE(p + 0x74),
      size: dir.readUInt32LE(p + 0x78),
    });
  }
  const root = entries[0]!;
  const miniFat: number[] = [];
  const mf = readChain(buf.readUInt32LE(0x3c));
  for (let i = 0; i + 4 <= mf.length; i += 4) miniFat.push(mf.readUInt32LE(i));
  let mini: Buffer | null = null;
  // 저장소 하나의 아이들(이름 → 항목). 형제는 이진 나무로 이어져 있다.
  const children = (e: Entry) => {
    const out = new Map<string, Entry>();
    const stack = [e.child];
    while (stack.length && out.size < entries.length) {
      const i = stack.pop()!;
      const c = entries[i];
      if (i >= END || !c || out.has(c.name)) continue;
      out.set(c.name, c);
      stack.push(c.left, c.right);
    }
    return out;
  };
  const read = (e: Entry) => {
    if (e.size < cutoff) {
      mini ??= readChain(root.start);
      return Buffer.concat(chain(e.start, miniFat).map((n) => mini!.subarray(n * miniSize, (n + 1) * miniSize))).subarray(0, e.size);
    }
    return readChain(e.start).subarray(0, e.size);
  };
  return { root, children, read };
}

const HWPTAG_PARA_TEXT = 67;
// 문단 글자 안의 제어 문자. 이 번호들은 뒤에 7글자(14바이트)를 더 차지한다.
const HWP_WIDE_CTRL = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);

function hwpPara(raw: Buffer): string {
  const units: number[] = [];
  const n = Math.floor(raw.length / 2);
  for (let i = 0; i < n; ) {
    const ch = raw.readUInt16LE(i * 2);
    if (ch < 32) {
      if (HWP_WIDE_CTRL.has(ch)) {
        i += 8;
        continue;
      }
      if (ch === 10 || ch === 13) units.push(10);
      i++;
      continue;
    }
    units.push(ch);
    i++;
  }
  let s = "";
  for (let i = 0; i < units.length; i += 4096) s += String.fromCharCode(...units.slice(i, i + 4096));
  return s;
}

// HWP5(한글 97 이후 바이너리). OLE 안의 BodyText/SectionN 레코드에서 문단 글자만 꺼낸다.
function hwpText(data: Buffer): string {
  const doc = cfb(data);
  const top = doc.children(doc.root);
  const header = doc.read(top.get("FileHeader")!);
  const flags = header.readUInt32LE(36);
  if (flags & 0x2) return ""; // 암호가 걸린 문서
  const compressed = !!(flags & 0x1);
  const body = top.get("BodyText");
  if (!body) return "";
  const sections = [...doc.children(body).values()]
    .filter((e) => e.name.startsWith("Section"))
    .sort((a, b) => (Number(a.name.slice(7)) || 0) - (Number(b.name.slice(7)) || 0));
  const parts: string[] = [];
  for (const s of sections) {
    let buf = doc.read(s);
    if (compressed) buf = inflateRawSync(buf, { maxOutputLength: 4 * MAX_FILE_BYTES });
    for (let pos = 0; pos + 4 <= buf.length; ) {
      const h = buf.readUInt32LE(pos);
      pos += 4;
      const tag = h & 0x3ff;
      let size = h >>> 20;
      if (size === 0xfff) {
        size = buf.readUInt32LE(pos);
        pos += 4;
      }
      if (tag === HWPTAG_PARA_TEXT) parts.push(hwpPara(buf.subarray(pos, pos + size)));
      pos += size;
    }
  }
  return parts.join("\n");
}

function hwpxText(buf: Buffer, entries: ZipEntry[]): string {
  return entries
    .filter((e) => /^Contents\/section\d+\.xml$/.test(e.name))
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((e) => unescapeHtml(zipRead(buf, e).toString("utf8").replace(/<\/hp:p>/g, "\n").replace(/<[^>]+>/g, "")))
    .join("\n");
}

// PDF 는 poppler 의 pdftotext 로 읽는다. -layout: 표의 한 행이 한 줄로 나와 '접수기간 … 날짜' 가 붙어 있다.
async function pdfText(data: Buffer): Promise<string> {
  const p = Bun.spawn(["pdftotext", "-q", "-layout", "-enc", "UTF-8", "-", "-"], { stdin: new Uint8Array(data), stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => p.kill(), 30_000);
  try {
    const out = await new Response(p.stdout).text();
    return (await p.exited) === 0 ? out : "";
  } finally {
    clearTimeout(timer);
  }
}

export function kindOf(data: Buffer, name = ""): string {
  const head = data.subarray(0, 8);
  if (head.subarray(0, 4).toString("latin1") === "%PDF") return "pdf";
  if (head.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))) return "hwp";
  if (head.subarray(0, 2).toString("latin1") === "PK") {
    try {
      return zipEntries(data).some((e) => e.name.startsWith("Contents/section")) ? "hwpx" : "zip";
    } catch {
      return "";
    }
  }
  if (/\.html?$/i.test(name) || head.toString("latin1").trimStart().startsWith("<")) return "html";
  return "";
}

export function htmlText(page: string): string {
  page = page.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  page = page.replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d|td|th)>/gi, "\n");
  page = unescapeHtml(page.replace(/<[^>]+>/g, " "));
  return page.replace(/[ \t\xa0]+/g, " ");
}

// 읽을 수 없는 형식(이미지 등)이면 빈 글자. 깨진 파일 하나 때문에 전체가 멈추면 안 된다.
export async function textOf(data: Buffer, name = "", depth = 0): Promise<string> {
  if (!data.length || data.length > MAX_FILE_BYTES) return "";
  try {
    const kind = kindOf(data, name);
    if (kind === "pdf") return await pdfText(data);
    if (kind === "hwp") return hwpText(data);
    if (kind === "html") return htmlText(data.toString("utf8"));
    if (kind === "hwpx" || kind === "zip") {
      const entries = zipEntries(data);
      if (kind === "hwpx") return hwpxText(data, entries);
      if (depth) return "";
      // 공고문을 먼저 — 신청서 양식에도 날짜 칸이 있어서 헷갈린다
      const rank = (e: ZipEntry) => (/공고|요강|안내/.test(e.name) ? 0 : 1);
      const names = [...entries].sort((a, b) => rank(a) - rank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const out: string[] = [];
      for (const e of names.slice(0, 10)) {
        if (e.name.endsWith("/") || e.size > MAX_FILE_BYTES) continue;
        if (/\.(pdf|hwp|hwpx)$/i.test(e.name)) out.push(await textOf(zipRead(data, e), e.name, depth + 1));
      }
      return out.join("\n");
    }
  } catch {
    return "";
  }
  return "";
}

// ---------------------------------------------------------------------------
// 글자 → 신청 기간
// ---------------------------------------------------------------------------
// 신청 기간을 말하는 낱말. 이 낱말 뒤 가까이에 있는 날짜를 읽는다.
const LABEL = /(?:접수|모집|신청|지원|제출|원서)\s*(?:기간|기한|일정|일시|마감)|(?:온라인|서류|인터넷)\s*(?:접수|신청|제출)|(?:신청|접수)\s*방법|접\s*수|신\s*청\s*기\s*간/g;
const NOT_PERIOD = /선발\s*(?:기간|일정)|결과\s*발표|발표|면접|수여|지급|활동\s*기간|사업\s*기간|교육\s*기간/;
// 2026. 10. 19.(월) / 2026-10-19 / 2026년 10월 19일 / 10. 19.(월) / 10월 19일 / 10/19
const DATE_SRC =
  "(?:(?<y>20\\d\\d|\\d\\d)\\s*(?:[.\\-/]|년)\\s*)?" +
  "(?<m>1[0-2]|0?[1-9])\\s*(?:[.\\-/]|월)\\s*(?<d>3[01]|[12]\\d|0?[1-9])(?!\\d)\\s*(?:일|\\.)?" +
  "(?:\\s*\\(?\\s*[월화수목금토일]\\s*\\(?\\s*\\)?)?" + // (월) — PDF 에선 '일월(   )' 처럼 흩어지기도 한다
  "(?:\\s*(?:\\d{1,2}\\s*[:시]\\s*\\d{0,2}\\s*분?|오[전후]\\s*\\d{1,2}\\s*시))?";
const RANGE_SEP = /^\s*(?:~|∼|〜|-|–|부터|까지\s*~)\s*/;
const UNTIL = /^\s*(?:까지|限|마감)/;

type DateMatch = { y?: string; m: string; d: string; start: number; end: number };
function datesIn(s: string): DateMatch[] {
  return [...s.matchAll(new RegExp(DATE_SRC, "g"))].map((m) => ({ y: m.groups!.y, m: m.groups!.m!, d: m.groups!.d!, start: m.index!, end: m.index! + m[0].length }));
}

function mk(y: number | null, m: number, d: number, ref: string): string | null {
  if (y !== null && y < 100) y += 2000;
  return ymd(y || Number(ref.slice(0, 4)), m, d);
}

const year = (d: string) => Number(d.slice(0, 4));
function withYear(d: string, y: number): string {
  return ymd(y, Number(d.slice(5, 7)), Number(d.slice(8, 10))) ?? ymd(y, Number(d.slice(5, 7)), 28)!;
}

// 게시일 기준으로 말이 안 되는 연도를 고친다.
// - 연도 없음: 게시일보다 두 달 넘게 앞서면 다음 해다(12월 게시 '1/9 마감').
// - 연도 오타: 게시일보다 반년 넘게 앞서면 한 해 올린다(2026년 1월 게시 '2025.1.2').
function fixYear(d: string, y: number | null, ref: string): string {
  const limit = y === null ? 60 : 180;
  while (days(d, ref) > limit) d = withYear(d, year(d) + 1);
  return d;
}

const todaySeoul = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());

// 신청 기간을 찾는다. 못 찾으면 [null, null], 마감일만 있으면 [null, 마감일].
// posted 는 연도가 빠진 날짜를 채우고, 연도 오타('2025.1.2~1.18' 을 2026년 1월에 올림)를 바로잡는 데 쓴다.
export function findPeriod(text: string, posted: string | null = null): [string | null, string | null] {
  if (!text) return [null, null];
  const ref = posted ?? todaySeoul();
  // 게시일을 모르면 연도 오타를 고칠 기준이 없다. 적힌 연도를 그대로 믿는다(작년 공고가 올해 공고로 둔갑하지 않게).
  const fix = (d: string, y: number | null) => (posted === null && y !== null ? d : fixYear(d, y, ref));
  let best: [string | null, string | null] | null = null;
  for (const lab of text.matchAll(LABEL)) {
    const labStart = lab.index!, labEnd = labStart + lab[0].length;
    // '선발 일정' 표 안의 '서류 접수' 처럼 라벨 앞에 다른 일정 낱말이 있으면 건너뛴다.
    const lineStart = text.lastIndexOf("\n", labStart - 1) + 1;
    if (NOT_PERIOD.test(text.slice(lineStart, labStart))) continue;
    const found = datesIn(text.slice(labEnd, labEnd + 160));
    if (!found.length) continue;
    const m1 = found[0]!;
    const y1 = m1.y ? Number(m1.y) : null;
    let d1 = mk(y1, Number(m1.m), Number(m1.d), ref);
    if (!d1) continue;
    const end1 = labEnd + m1.end;
    const rest = text.slice(end1, end1 + 12);
    let d2: string | null = null;
    if (RANGE_SEP.test(rest) && found.length > 1) {
      const m2 = found[1]!;
      const y2 = m2.y ? Number(m2.y) : null;
      d2 = mk(y2 || year(d1), Number(m2.m), Number(m2.d), ref);
      if (d2 && d2 < d1 && !m2.y) d2 = mk(year(d1) + 1, Number(m2.m), Number(m2.d), ref); // 12/20 ~ 1/10
    } else if (UNTIL.test(rest) || /[~\-]\s*$/.test(text.slice(labEnd, labEnd + m1.start)) || /기한|마감/.test(lab[0])) {
      // '~2026.1.15', '8월 11일까지', '접수기한 2026.10.11' — 마감일만
      if (!best || best[0] === null) best = [startBefore(text, labStart, fix(d1, y1), ref, fix), fix(d1, y1)];
      continue;
    }
    if (d2) {
      if (!y1) {
        d1 = fix(d1, null);
        d2 = fix(d2, null);
        if (d2 < d1) d2 = withYear(d2, year(d2) + 1);
      } else {
        d1 = fix(d1, y1);
        d2 = fix(d2, y1);
      }
      const span = days(d1, d2);
      if (span >= 0 && span <= 200) return [d1, d2];
    }
  }
  return best ?? [null, null];
}

// 마감일만 라벨 뒤에 있을 때, 표의 같은 행에서 라벨 앞에 놓인 시작일.
// PDF 표는 '2026년 1월 2일(금) … 지원서 접수 - 1월 13일(화) 마감' 처럼 읽힌다.
function startBefore(text: string, pos: number, end: string, ref: string, fix: (d: string, y: number | null) => string): string | null {
  const found = datesIn(text.slice(Math.max(0, pos - 80), pos));
  const m = found.at(-1);
  if (!m) return null;
  const y = m.y ? Number(m.y) : null;
  let d = mk(y, Number(m.m), Number(m.d), ref);
  if (d) d = fix(d, y);
  if (d && days(d, end) > 0 && days(d, end) <= 120) return d;
  return null;
}

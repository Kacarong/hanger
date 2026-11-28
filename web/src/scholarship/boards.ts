// 공고 게시판 — 대한토목학회·재단·부경대·부산 구·군 장학회 홈페이지에 올라온 장학생 모집 글.
//
// 한국장학재단 자료에는 늦게 올라오거나 아예 안 올라오는 공고가 있다. 게시판 목록에서 '장학 + 모집/선발' 제목을 고르고,
// 글 본문에서 신청 기간을 읽는다. 본문에 없으면 첨부 공고문(HWP/HWPX/PDF/ZIP)을 내려받아 그 안에서 읽는다(docs.ts).
// 게시판마다 HTML 이 달라서 목록은 넓게 읽는다: 표의 한 행(<tr>)이나 목록의 한 칸(<li>) 안에 글 링크와 날짜가 같이 있으면 글 하나로 본다.
// 인스타그램·페이스북은 로그인 없이는 글을 볼 수 없어 넣지 않았다.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import * as docs from "./docs";
import { GRAD_ONLY } from "./dreamspon";
import { days, key, text, UA, ymd, type Item } from "./util";

export type Board = {
  id: string;
  label: string;
  org: string;
  url: string;
  bracket_org?: boolean; // '[엔지니어링인재육성재단] …' — 외부 기관 공고를 대신 올린다
  loose?: boolean; // 검색어('장학')로 이미 걸러진 게시판: '모집·선발' 낱말이 없어도 받는다(대신 게시일이 있는 글만)
  want?: string; // 제목에 '장학' 이 없는 모집 글을 올리는 게시판의 주제 낱말
  link?: [string, string]; // 글 주소가 onclick 에만 있는 게시판: (정규식, 주소 틀)
  region?: string; // 구·군 장학회 — 그 구·군에 사는(보호자가 사는) 학생만 뽑는다
};

// org 는 한국장학재단 자료의 기관명과 맞춰 둔다 — 같은 기관의 장학금으로 묶는 데 쓴다(logic.merge).
export const BOARDS: Board[] = [
  { id: "ksce_news", label: "대한토목학회 토목계소식", org: "대한토목학회", bracket_org: true, url: "https://www.ksce.or.kr/not/default.asp?gbn=10&htop=MN0031&ctop=MN0096&ptop=MN0031&sfield=2&gtxt=%EC%9E%A5%ED%95%99" },
  { id: "ksce_notice", label: "대한토목학회 공지사항", org: "대한토목학회", bracket_org: true, url: "https://www.ksce.or.kr/not/default.asp?gbn=6&htop=MN0031&ctop=MN0048&ptop=MN0031&sfield=2&gtxt=%EC%9E%A5%ED%95%99" },
  { id: "pknu_civil", label: "부경대 토목공학과", org: "부경대학교 토목공학과", loose: true, url: "https://civil.pknu.ac.kr/civil/5346?pageIndex=1&bbsId=2402698&searchCondition=title&searchKeyword=%EC%9E%A5%ED%95%99" },
  { id: "pknu_main", label: "부경대 등록·장학 공지", org: "부경대학교", loose: true, url: "https://www.pknu.ac.kr/main/163?cd=10004" },
  { id: "yonkang", label: "두산연강재단", org: "두산연강재단", url: "https://www.yonkang.org/kr/support/information/" },
  { id: "daeeun", label: "대은강완석장학재단", org: "대은강완석장학재단", url: "http://shop.daeeunsf.org/bbs/board.php?bo_table=notice" },
  { id: "miraenanum", label: "미래나눔재단", org: "미래나눔재단", url: "http://www.miraenanum.org/bbs/board.php?bo_table=notice" },
  { id: "wooyang", label: "재단법인 우양", org: "재단법인 우양", url: "https://www.wooyang.org/News" },
  { id: "inseok", label: "인석장학회", org: "인석장학회", url: "https://www.inseok.org/board5/bbs/board.php?bo_table=notice_1" },
  { id: "pknu_civil_notice", label: "부경대 토목공학과 공지", org: "부경대학교 토목공학과", loose: true, url: "https://civil.pknu.ac.kr/civil/5345?pageIndex=1&bbsId=2402699&searchCondition=title&searchKeyword=%EC%9E%A5%ED%95%99" },
  { id: "pknu_coe", label: "부경대 공과대학 공지", org: "부경대학교 공과대학", loose: true, url: "https://coe.pknu.ac.kr/?mode=1&menucode=0406010000&kind=title&keyword=%EC%9E%A5%ED%95%99" },
  { id: "kosffl", label: "한국지도자육성장학재단", org: "(재)한국지도자육성장학재단", url: "https://www.kosffl.or.kr/news/notice" },
  // https 는 인증서 체인이 덜 갖춰져 있어 열리지 않는다. '인재림(人材林) 제7기 지원자 모집' 처럼 '장학' 없는 모집 글이 있다.
  { id: "kfas", label: "한국고등교육재단", org: "(재)한국고등교육재단", want: "장학|지원자\\s*모집", url: "http://www.kfas.or.kr/bbs/board.php?bo_table=kfas_2028_ntc_latest&sca=%EA%B3%B5%EC%A7%80%EC%82%AC%ED%95%AD" },
  // 모든 행의 href 가 같고 글 번호는 onclick="fnDetail(11306)" 에만 있다
  { id: "asan", label: "아산사회복지재단", org: "아산사회복지재단", url: "https://www.asanfoundation.or.kr/af/foundation/notice/afFoundationNoticeList.do?noticeTypeClsf=N", link: ["fnDetail\\((\\d+)\\)", "https://www.asanfoundation.or.kr/af/foundation/notice/afFoundationNoticeDetail.do?idx={}&noticeTypeClsf=N"] },
  { id: "postf", label: "포스코청암재단", org: "포스코청암재단", url: "https://www.postf.org/news/notice" },
  // 부산 구·군 장학회 — region 으로 지역을 붙인다.
  { id: "suyeong", label: "수영구장학재단", org: "재단법인 수영구장학재단", region: "부산광역시 수영구", url: "https://www.suyeong.go.kr/janghak/board/list.suyeong?boardId=BBS_0000140&menuCd=DOM_000002802001000000&contentsSid=2261" },
  { id: "namgu", label: "부산 남구장학회", org: "(재)부산광역시 남구장학회", region: "부산광역시 남구", url: "https://www.bsnamgu.go.kr/board/list.namgu?boardId=BBS_0000128&menuCd=DOM_000000102010009000&contentsSid=1229" },
  { id: "bukgu", label: "부산 북구청 새소식", org: "(재)부산북구장학회", region: "부산광역시 북구", loose: true, url: "https://www.bsbukgu.go.kr/board/list.bsbukgu?boardId=BBS_0000023&menuCd=DOM_000000105001001000&contentsSid=368&searchType=DATA_TITLE&keyword=%EC%9E%A5%ED%95%99" },
  { id: "gijang", label: "기장군 알림사항", org: "부산광역시 기장군", region: "부산광역시 기장군", loose: true, url: "https://www.gijang.go.kr/board/list.gijang?boardId=BBS_0000002&menuCd=DOM_000000101001001000&contentsSid=44&searchType=DATA_TITLE&searchOperation=OR&keyword=%EC%9E%A5%ED%95%99" },
];

export type Source = Board & { builtin: boolean; enabled: boolean };
export type CustomSource = { id: string; label: string; org: string; url: string; loose: boolean };

// 기본 게시판 + 사용자가 더한 게시판. 각각 enabled·builtin 표시를 붙인다.
export function allSources(state: { sources_off: string[]; custom_sources: CustomSource[] }): Source[] {
  const off = new Set(state.sources_off);
  const list: (Board & { builtin: boolean })[] = [
    ...BOARDS.map((b) => ({ ...b, builtin: true })),
    ...state.custom_sources.map((c) => ({ ...c, org: c.org || c.label, builtin: false })),
  ];
  return list.map((b) => ({ ...b, enabled: !off.has(b.id) }));
}

// 파이썬 정규식의 \b 는 한글도 낱말 글자로 본다. 영문·숫자·한글 뒤의 낱말 끝을 같은 뜻으로 쓴다.
const WB = "(?![0-9A-Za-z_\\u3131-\\u318e\\uac00-\\ud7a3])";

// 제목 고르기
const WANT = "장학";
const RECRUIT = /모집|선발|공고|공모|추천|신청/;
const SKIP = /결과|발표|합격|명단|수여식|증서|기부금|후기|수기|간담회|워크숍|연구|논문|채용|입찰|지급|납부|분할|서식|양식|변경사항|반환|환수|정정|연장 안내|만족도|설문|소감문|연수\s*교육|면접\s*(?:심사|일정)/;

const DATE_IN_ROW = /(20\d\d)\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{1,2})/;
// 구청 게시판은 연도를 두 자리로 적는다('26.09.18'). 네 자리 날짜가 없을 때만 본다.
const SHORT_DATE_IN_ROW = /(?<![\d.\-])([12]\d)\s*[.\-]\s*(\d\d)\s*[.\-]\s*(\d\d)(?![\d.\-])/;
const DOWNLOAD = new RegExp(`download|file_?down|filedown|fileDown|down\\.php|/file/down|atchFile|\\.(?:hwp|hwpx|pdf|zip)${WB}`, "i");

export const RECENT_DAYS = 150; // 이보다 오래된 글은 지난 회차라 보지 않는다
const MAX_POSTS = 8; // 게시판 하나에서 열어 보는 글 수
const CLOSED_KEEP_DAYS = 180; // 마감이 이보다 오래 지난 공고는 버린다 ('최근 마감' 탭과 같은 기간)
const MAX_FILES = 4; // 글 하나에서 받아 보는 첨부 수

export class BlockedURL extends Error {}

// IPv4/IPv6 주소가 인터넷 주소인가(사설망·루프백·링크로컬·문서용·멀티캐스트가 아님).
export function isGlobalIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split(".").map(Number) as [number, number, number];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  const low = ip.toLowerCase();
  const mapped = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isGlobalIp(mapped[1]!);
  if (low === "::" || low === "::1" || /^(fc|fd|fe[89ab]|ff)/.test(low) || low.startsWith("2001:db8") || low.startsWith("64:ff9b") || low.startsWith("::ffff:")) return false;
  return isIP(ip) === 6;
}

// 사용자가 넣은 게시판 주소로 서버 안쪽(127.0.0.1, 사설망)을 찌르지 못하게 한다.
export async function checkPublicUrl(url: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new BlockedURL("http(s) 주소만 넣을 수 있습니다");
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname) throw new BlockedURL("http(s) 주소만 넣을 수 있습니다");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  let addrs: { address: string }[];
  try {
    addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  } catch {
    throw new BlockedURL(`주소를 찾을 수 없습니다: ${host}`);
  }
  if (!addrs.length || addrs.some((a) => !isGlobalIp(a.address))) throw new BlockedURL("내부망 주소는 넣을 수 없습니다");
}

export type Fetcher = { get(url: string, referer?: string): Promise<[Buffer, string, string]> };

// 쿠키를 기억하는 받기 도구. 글을 먼저 열어야 첨부가 받아지는 게시판(그누보드)이 있다.
// 공개 주소만 받는다 — 게시판은 사이트에서 사용자가 더할 수 있다. 넘겨주기(redirect)도 하나씩 확인한다.
export function makeFetcher(timeoutMs = 25_000): Fetcher {
  const jar = new Map<string, Map<string, string>>(); // 도메인 → 이름 → 값
  const cookieFor = (host: string) =>
    [...jar].filter(([d]) => host === d || host.endsWith("." + d)).flatMap(([, m]) => [...m].map(([k, v]) => `${k}=${v}`)).join("; ");
  return {
    async get(url, referer = "") {
      let cur = new URL(url).href; // 한글이 섞인 주소('&gtxt=장학')도 보낼 수 있게 퍼센트 인코딩한다
      for (let hop = 0; hop < 10; hop++) {
        await checkPublicUrl(cur);
        const host = new URL(cur).hostname;
        const headers: Record<string, string> = { "User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9" };
        if (referer) headers.Referer = referer;
        const cookie = cookieFor(host);
        if (cookie) headers.Cookie = cookie;
        const res = await fetch(cur, { headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
        for (const sc of res.headers.getSetCookie()) {
          const [pair, ...attrs] = sc.split(";");
          const i = pair!.indexOf("=");
          if (i <= 0) continue;
          const domain = attrs.map((a) => a.trim().match(/^domain=\.?(.+)$/i)?.[1]).find(Boolean)?.toLowerCase() ?? host;
          (jar.get(domain) ?? jar.set(domain, new Map()).get(domain)!).set(pair!.slice(0, i).trim(), pair!.slice(i + 1).trim());
        }
        const loc = res.headers.get("Location");
        if (res.status >= 300 && res.status < 400 && loc) {
          await res.arrayBuffer().catch(() => {});
          cur = new URL(loc, cur).href;
          continue;
        }
        if (!res.ok) {
          await res.arrayBuffer().catch(() => {});
          throw new Error(`HTTP Error ${res.status}`);
        }
        // 공고문은 MAX_FILE_BYTES 까지만 받는다(그보다 큰 건 읽지도 않는다)
        const parts: Uint8Array[] = [];
        let size = 0;
        for await (const chunk of res.body ?? []) {
          parts.push(chunk);
          size += chunk.length;
          if (size > docs.MAX_FILE_BYTES) break;
        }
        return [Buffer.concat(parts), cur, res.headers.get("Content-Type") ?? ""];
      }
      throw new Error("넘겨주기가 너무 많습니다");
    },
  };
}

export function decodeHtml(data: Buffer, contentType = ""): string {
  const m = (contentType || "").match(/charset=([\w-]+)/i) ?? data.subarray(0, 4000).toString("latin1").match(/<meta[^>]+charset=["']?([\w-]+)/i);
  try {
    return new TextDecoder((m?.[1] ?? "utf-8").toLowerCase()).decode(data); // euc-kr·ks_c_5601-1987·x-windows-949 는 모두 CP949 로 읽는다
  } catch {
    return new TextDecoder("utf-8").decode(data);
  }
}

// html 풀기는 '&gtxt=' 를 '>xt=' 로 바꿀 수 있다(세미콜론 없는 옛 엔티티). 주소는 &amp; 만 푼다.
const unescapeUrl = (href: string) => href.replace(/&(?:amp|#0*38);/g, "&");

function rowDate(t: string): string | null {
  let m = t.match(DATE_IN_ROW);
  if (m) return ymd(Number(m[1]), Number(m[2]), Number(m[3]));
  m = t.match(SHORT_DATE_IN_ROW);
  if (m) return ymd(2000 + Number(m[1]), Number(m[2]), Number(m[3]));
  return null;
}

const join = (base: string, href: string) => {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
};

export type Post = { title: string; url: string; posted: string | null };

// 목록 HTML → [{title, url, posted}]. 같은 주소는 한 번만.
// link: 글 주소가 onclick 에만 있는 게시판용 (정규식, 주소 틀) — onclick 의 번호를 주소 틀의 {} 에 넣는다.
export function listPosts(page: string, baseUrl: string, link?: [string, string]): Post[] {
  page = page.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const seen = new Set<string>();
  const out: Post[] = [];
  for (const [chunk] of page.matchAll(/<tr[\s>][\s\S]*?<\/tr>|<li[\s>][\s\S]*?<\/li>|<article[\s>][\s\S]*?<\/article>/gi)) {
    if (chunk.length > 6000) continue; // 메뉴 전체를 감싼 바깥 <li>
    let best: [string, string] | null = null;
    for (const a of chunk.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      const attrs = a[1]!, inner = a[2]!;
      const title = text(inner) || text(attrs.match(/title="([^"]*)"/)?.[1] ?? "");
      if (title.length < 6) continue;
      let href = "";
      const lm = link ? attrs.match(new RegExp(link[0])) : null;
      if (lm) href = link![1].replace("{}", lm[1] ?? "");
      const m = href ? null : attrs.match(/href\s*=\s*"([^"]*)"/i) ?? attrs.match(/href\s*=\s*'([^']*)'/i);
      if (m && !/^(javascript|#)/i.test(m[1]!)) href = unescapeUrl(m[1]!);
      if (!href) continue;
      if (!best || title.length > best[0].length) best = [title, href];
    }
    if (!best) continue;
    const url = join(baseUrl, best[1]);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ title: best[0], url, posted: rowDate(text(chunk)) });
  }
  return out;
}

const POSTED_IN_PAGE = /(?:작성일|등록일|게시일|작성일시|등록일시)\S*\s*[:：]?\s*((?:20)?\d\d)\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{1,2})/;

// 글 화면의 '작성일 25-12-26 11:39'. 목록에 날짜가 없는 게시판이 있다.
export function postedInPage(t: string): string | null {
  const m = t.match(POSTED_IN_PAGE);
  if (!m) return null;
  const y = Number(m[1]);
  return ymd(y < 100 ? y + 2000 : y, Number(m[2]), Number(m[3]));
}

const TITLE_TAIL = new RegExp(`\\s+(?:신청|접수|모집)기간${WB}|\\s+(?:NEW|UPDATED|new)${WB}|\\s+20\\d\\d[.\\-/]\\d\\d?[.\\-/]\\d\\d?${WB}|\\s+(?:[HN]\\s+)?인기글(?![가-힣])`);

// 'applying 2027년 … 선발 안내 신청기간 2026-10-14 ~ …' 처럼 목록 칸이 같이 붙은 제목을 다듬는다.
export function cleanTitle(title: string): string {
  title = title.trim().replace(/^[a-z]+\s+/, "");
  title = title.replace(/^(?:공지|NOTICE|\d{1,6})\s+/, ""); // 번호·공지 칸
  title = title.split(TITLE_TAIL)[0]!; // 그누보드 '… H 인기글 (본문 미리보기)'
  const twice = title.trim().match(/^(.{6,}?)\s+\1$/); // 같은 제목을 두 칸에 적은 목록
  return (twice ? twice[1]! : title).trim();
}

export function wanted(title: string, loose = false, want = ""): boolean {
  if (!new RegExp(want || WANT).test(title) || SKIP.test(title)) return false;
  return loose || RECRUIT.test(title);
}

// 글 HTML → [[주소, 이름]]. 공고문처럼 보이는 이름을 앞에 둔다.
export function attachments(page: string, baseUrl: string): [string, string][] {
  const out: [string, string][] = [];
  for (const a of page.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = a[1]!, inner = a[2]!;
    const m = attrs.match(/href\s*=\s*"([^"]*)"/i) ?? attrs.match(/href\s*=\s*'([^']*)'/i);
    if (!m) continue;
    let href = unescapeUrl(m[1]!);
    if (href.toLowerCase().startsWith("javascript")) {
      // javascript:file_download('/download?db=1&id=5350&no=0', '공고문.pdf') — 안의 주소를 쓴다
      const js = href.match(/['"]((?:\/|https?:\/\/)[^'"]+)['"]/);
      if (!js) continue;
      href = js[1]!;
    }
    const name = text(inner);
    if (!(DOWNLOAD.test(href) || new RegExp(`\\.(hwp|hwpx|pdf|zip)${WB}`, "i").test(name))) continue;
    if (new RegExp(`\\.(jpe?g|png|gif)${WB}`, "i").test(href + " " + name)) continue;
    const url = join(baseUrl, href);
    if (url && out.every(([u]) => u !== url)) out.push([url, name]);
  }
  const rank = ([, n]: [string, string]) => (/공고|요강|안내|모집/.test(n) ? 0 : 2) + (/신청서|양식|서식|동의서/.test(n) ? 1 : 0);
  return out.sort((a, b) => rank(a) - rank(b));
}

const AMOUNT = /\d[\d,]*\s*만\s*원|\d{1,3}(?:,\d{3})+\s*원|생활비|생활\s*지원|학업\s*장려|등록금/;
const LIVING_LINE = /생활비|생활\s*지원|생활\s*장학|학업\s*장려|생활안정/;

// 지원 내용으로 보일 줄 몇 개 — 목록 요약과 '지원 용도'(생활비·등록금) 판정에 쓴다.
// 금액이나 용도 낱말이 든 짧은 줄만 고르고, 생활비를 말하는 줄을 앞에 둔다.
export function excerpt(t: string): string {
  const living: string[] = [], other: string[] = [];
  for (let ln of t.split(/\r\n|\r|\n/)) {
    ln = ln.replace(/\s+/g, " ").trim();
    if (!(ln.length >= 4 && ln.length <= 90) || /중지|환수|제외|불가/.test(ln) || SECTION_JUNK.test(ln)) continue;
    if (LIVING_LINE.test(ln)) living.push("○ " + ln);
    else if (AMOUNT.test(ln)) other.push("○ " + ln);
  }
  return [...living.slice(0, 2), ...other].slice(0, 3).join("\n");
}

// ---------------------------------------------------------------------------
// 공고 상세 — 지원 자격·선발 인원·선발 방법·제출 서류·신청 방법
// 공고문은 '1. 선발 인원 : 총 90명', '□ 지원자격', '가. 제출서류' 처럼 항목 제목을 줄 앞에 두고 그 아래에 내용을 적는다.
// 제목 줄을 찾아 다음 제목이 나올 때까지(최대 8줄) 모은다. 한국장학재단 자료의 같은 칸에 넣어 화면이 똑같이 보인다.
// ---------------------------------------------------------------------------
const SECTION_LABELS: [string, string][] = [
  ["special", "(?:지원|신청|응모|선발|추천|장학생)\\s*자격|(?:지원|선발|신청|모집|장학)\\s*대상(?:자)?|자격\\s*(?:요건|기준|조건)"],
  ["quota", "선발\\s*(?:인원|규모|예정\\s*인원)|모집\\s*인원|지원\\s*규모"],
  ["selection", "선발\\s*(?:방법|절차|기준)|심사\\s*(?:방법|기준|절차)|전형\\s*(?:방법|절차)"],
  ["documents", "제출\\s*서류|구비\\s*서류|신청\\s*서류"],
  ["how", "신청\\s*방법|접수\\s*방법|신청\\s*경로|제출\\s*방법|신청\\s*절차"],
];
// 줄 앞 번호·기호만 — '가.' '나)' 처럼 뒤에 점·괄호가 붙은 글자 하나만 번호로 본다.
const BULLET = "(?:[\\s\\d.)(\\[\\]Ⅰ-Ⅹ□■▢○◎●◦▶▷◆◇※\\-–·•❍◈◾➊-➓①-⑳]|[가-힣](?=\\s*[.)])|[ㅇㅁ](?=\\s))*";
const SECTION_HEAD = new RegExp(
  "^" + BULLET + "(?:장학금\\s*|장학생\\s*)?(?:" + SECTION_LABELS.map(([k, v]) => `(?<${k}>${v})`).join("|") + ")\\s*(?:\\([^)]{0,20}\\))?\\s*(?<rest>[:：].*|\\s.{0,80}|)$",
);
// 두 항목을 한 제목에 묶은 줄('지원자격 및 제출서류', '지원자격, 심사방법 등은 붙임 참조')
const JOINED_HEAD = /^(?:및|,|·|\/|등)/;
const SECTION_STOP = /^(?:이전\s*글|다음\s*글|목록\s*보기|목록|첨부\s*파일)(?![가-힣])|^(?:이전|다음)$/;
const SECTION_JUNK = new RegExp(`\\.(?:hwpx?|pdf|zip|docx?|jpe?g|png)${WB}|·{4,}|\\.{6,}|^\\[?붙임`, "i");
const SECTION_LINES = 8;
const SECTION_CHARS = 500;

// 줄 앞 번호의 종류와 깊이. '1.' 아래에 '가.', 그 아래에 '1)', '가)' 를 쓰는 공문 관례를 따른다.
const MARKS: [string, number, RegExp][] = [
  ["roman", 0, /^\s*([Ⅰ-Ⅹ])/],
  ["num.", 1, /^\s*(\d{1,2})\s*\.(?!\d)/],
  ["box", 1, /^\s*[□■]/],
  ["kor.", 2, /^\s*([가-하])\s*\./],
  ["num)", 3, /^\s*\(?(\d{1,2})\)/],
  ["kor)", 3, /^\s*\(?([가-하])\)/],
];

// [종류, 깊이, 번호] — 번호가 없는 표시(□)는 null.
function mark(line: string): [string, number, number | null] | null {
  for (const [kind, level, re] of MARKS) {
    const m = line.match(re);
    if (m) {
      const g = m[1];
      return [kind, level, g ? (/^\d+$/.test(g) ? Number(g) : g.codePointAt(0)!) : null];
    }
  }
  return null;
}

// 공고 글자 → {special, quota, selection, documents, how} 중 찾은 것만.
// 제목 줄 다음부터 다음 항목 제목, 또는 제목과 같거나 얕은 번호 줄('3.') 앞까지 모은다.
// 내용이 '1. … 2. …' 처럼 제목과 같은 깊이의 번호 목록이면 번호가 이어지는 동안은 계속 모은다.
export function details(t: string): Record<string, string> {
  const lines = (t || "").split(/\r\n|\r|\n/).map((ln) => ln.replace(/\s+/g, " ").trim()).filter((ln) => ln && !SECTION_JUNK.test(ln));
  const out: Record<string, string> = {};
  let i = 0;
  while (i < lines.length) {
    const m = lines[i]!.length <= 120 ? lines[i]!.match(SECTION_HEAD) : null;
    if (!m) {
      i++;
      continue;
    }
    const k = SECTION_LABELS.find(([name]) => m.groups![name])![0];
    let rest = (m.groups!.rest ?? "").trim().replace(/^[:：]\s*/, "");
    if (JOINED_HEAD.test(rest)) rest = "";
    const body = rest ? [rest] : [];
    const head = mark(lines[i]!);
    const level = head ? head[1] : 2;
    let run: [string, number | null] | null = null; // 내용이 번호 목록일 때 [종류, 마지막 번호]
    let j = i + 1;
    while (j < lines.length && body.length < SECTION_LINES) {
      const ln = lines[j]!;
      if (SECTION_STOP.test(ln) || SECTION_HEAD.test(ln)) break;
      const mk = mark(ln);
      if (mk && mk[1] <= level) {
        const listed = (!body.length && mk[2] === 1 && mk[0] !== "roman") || (run && run[0] === mk[0] && run[1] !== null && mk[2] === run[1] + 1);
        if (!listed) break;
        run = [mk[0], mk[2]];
      }
      body.push(ln);
      j++;
    }
    let got = body.join("\n").trim();
    if ((got.match(/[가-힣0-9]/g) ?? []).length >= 2 && !(k in out)) {
      if (got.length > SECTION_CHARS) {
        const cut = got.slice(0, SECTION_CHARS);
        got = (cut.includes("\n") ? cut.slice(0, cut.lastIndexOf("\n")) : cut) + "\n…";
      }
      out[k] = got;
    }
    i = j;
  }
  return out;
}

const CONTENT_END = /^(?:이전\s*글|다음\s*글|목록\s*보기)(?![가-힣])/;

// 글 화면 글자에서 메뉴·이전글/다음글을 덜어 낸 본문 — 글 제목 줄부터 '이전글/다음글' 앞까지.
// 제목 줄은 제목만 적힌 짧은 줄이다. 여러 번 나오면 뒤의 것부터 보되, 이전글/다음글 바로 뒤의 제목과 본문이 거의 없는 곳은 건너뛴다.
export function contentOf(body: string, title: string): string {
  const head = cleanTitle(title).replace(/\s+/g, " ").slice(0, 15);
  const lines = body.split(/\r\n|\r|\n/);
  const flat = lines.map((ln) => ln.replace(/\s+/g, " ").trim());
  if (head.length >= 6) {
    const limit = cleanTitle(title).length + 30;
    const hits = flat.flatMap((ln, i) => (ln.includes(head) && ln.length <= limit && !flat.slice(Math.max(0, i - 2), i).some((x) => CONTENT_END.test(x)) ? [i] : []));
    for (const start of hits.reverse()) {
      let end = flat.length;
      for (let i = start + 1; i < flat.length; i++) {
        if (CONTENT_END.test(flat[i]!)) {
          end = i;
          break;
        }
      }
      const part = lines.slice(start, end).join("\n");
      if ((part.match(/[가-힣]/g) ?? []).length >= 80) return part;
    }
  }
  return body;
}

function orgFromTitle(title: string, fallback: string): string {
  const m = title.match(/^\s*\[\s*([^\]]{2,40})\s*\]/);
  if (m && !/공지|안내|알림|모집|장학/.test(m[1]!)) return m[1]!.trim();
  return fallback;
}

type Read = { start: string | null; end: string | null; where: string; excerpt: string; posted: string | null; details: Record<string, string> };

// 글을 열어 신청 기간과 상세(자격·인원·서류…)를 읽는다. 본문 → 첨부 순서.
export async function readPost(f: Fetcher, post: { title: string; url: string; posted: string | null }): Promise<Read> {
  const [data, finalUrl, ctype] = await f.get(post.url);
  const page = decodeHtml(data, ctype);
  const body = docs.htmlText(page);
  const content = contentOf(body, post.title ?? "");
  // 게시일을 모르면 null 로 둔다 — 오늘을 기준으로 연도를 고치면 지난 회차가 올해로 둔갑한다
  const ref = post.posted ?? postedInPage(body);
  let [start, end] = docs.findPeriod(body, ref);
  let where = "본문";
  const texts = [content]; // 지원 내용 요약·상세를 뽑을 글자 — 본문, 그리고 읽은 공고문
  const files = attachments(page, finalUrl).slice(0, MAX_FILES);
  let opened = 0;
  const detailOnly: string[] = []; // 날짜는 없었지만 연 공고문 — 상세 칸에만 쓴다
  if (!(start && end)) {
    for (const [url, name] of files) {
      let blob: Buffer;
      try {
        [blob] = await f.get(url, finalUrl);
      } catch {
        continue; // 첨부 하나 실패는 넘어간다
      }
      opened++;
      const ftext = await docs.textOf(blob, name);
      const [s2, e2] = docs.findPeriod(ftext, ref);
      if (s2 && e2) {
        [start, end, where] = [s2, e2, `첨부 ${name || "공고문"}`];
        texts.push(ftext);
        break;
      }
      if (e2 && !end) {
        [end, where] = [e2, `첨부 ${name || "공고문"}`];
        texts.push(ftext);
      } else detailOnly.push(ftext);
    }
  }
  let info = details(content);
  for (const t of [...texts.slice(1), ...detailOnly]) info = { ...details(t), ...info }; // 본문에 적힌 것을 먼저, 빈 칸만 공고문에서
  if (Object.keys(info).length < 3 && files.length && !opened) {
    // 본문에 날짜만 있고 자세한 것은 공고문에 있는 글이 많다 — 첫 공고문 하나만 더 읽는다.
    // 상세 칸만 채운다. 지원 내용 요약(생활비 판정)에는 넣지 않는다 — 긴 문서의 '생활비 대출' 줄이 생활비 장학금으로 잘못 읽힌다.
    const [url, name] = files[0]!;
    try {
      const [blob] = await f.get(url, finalUrl);
      info = { ...details(await docs.textOf(blob, name)), ...info };
    } catch {
      /* 첨부를 못 받으면 본문 것만 */
    }
  }
  return { start, end, where, excerpt: excerpt(texts.join("\n")), posted: ref, details: info };
}

// 학적 — 공고 제목·자격 칸에 적힌 대상. 학교·구청 게시판에는 중·고등학생 공고와 대학원 공고가 섞인다.
const SCHOOL_KID = /초등|중학|고등학|고교/;
const COLLEGE = /대학|학부|전문대/;
const GRAD = /대학원|석사|박사/;
const UNDERGRAD = /대학생|학부|대학\s*장학생|대학교/;

// 대학생·대학원생이 받을 수 있는 공고인가. 초·중·고만 적고 대학을 한 번도 말하지 않는 공고만 아니라고 본다.
export function forCollege(item: Item): boolean {
  const target = `${item.notice_title || item.name || ""}\n${item.special ?? ""}`;
  return !(SCHOOL_KID.test(target) && !COLLEGE.test(target));
}

// 제목이 대학원만 말하면 대학원 과정으로(학부 재학생의 '내 조건' 에서 빠지게). 그 밖에는 모름([]).
export const gradesOf = (title: string) => (GRAD.test(title) && !UNDERGRAD.test(title) ? [...GRAD_ONLY] : []);

export function pick(board: Partial<Board>, posts: Post[], today: string): Post[] {
  const loose = !!board.loose;
  return posts
    .filter((p) => wanted(cleanTitle(p.title), loose, board.want ?? "") && ((p.posted === null && !loose) || (!!p.posted && days(p.posted, today) <= RECENT_DAYS)))
    .slice(0, MAX_POSTS);
}

export type Stat = { posts: number; picked: number; items: number; error: string };

// 게시판들을 돌며 최근 모집 공고를 장학금 항목 모양으로 돌려준다. stats 에 게시판마다 {posts, picked, items, error} 를 채운다.
export async function collect(boards: Board[], today: string, stats: Record<string, Stat> = {}, fetcher?: Fetcher): Promise<Item[]> {
  const out: Item[] = [];
  for (const board of boards) {
    const f = fetcher ?? makeFetcher();
    const stat: Stat = { posts: 0, picked: 0, items: 0, error: "" };
    stats[board.id] = stat;
    let posts: Post[];
    try {
      const [data, finalUrl, ctype] = await f.get(board.url);
      posts = listPosts(decodeHtml(data, ctype), finalUrl, board.link);
    } catch (e) {
      stat.error = String((e as Error).message).slice(0, 200);
      console.warn(`게시판 ${board.id} 목록을 못 읽음: ${stat.error}`);
      continue;
    }
    const picked = pick(board, posts, today);
    stat.posts = posts.length;
    stat.picked = picked.length;
    for (const post of picked) {
      let got: Read;
      try {
        got = await readPost(f, post);
      } catch (e) {
        console.warn(`공고 ${post.url} 를 못 읽음: ${(e as Error).message}`);
        continue;
      }
      const posted = got.posted;
      if (posted && days(posted, today) > RECENT_DAYS) continue; // 목록엔 날짜가 없었지만 글을 열어 보니 오래된 글
      // 마감일을 못 읽었으면 시작일도 비운다 — 게시일을 시작일로 넣으면 '신청 가능' 처럼 보인다
      const start = got.start ?? (got.end ? posted : null);
      const end = got.end;
      if (end && days(end, today) > CLOSED_KEEP_DAYS) continue; // 오래 지난 회차
      if (!end && (!posted || days(posted, today) > 60)) continue; // 마감일을 못 읽은 오래된 글은 살아 있는지 알 수 없다
      const title = cleanTitle(post.title);
      const org = board.bracket_org ? orgFromTitle(title, board.org) : board.org;
      const item: Item = {
        id: key(board.id, post.url),
        series: key(org, title),
        org,
        name: title,
        org_type: "",
        product: "장학금",
        // 구·군 장학회 게시판은 그 지역 주민 자녀만 뽑는다 — 지역 판정(logic.place)에 쓴다
        category: board.region ? "지역연고" : "",
        region: board.region ?? "",
        schools: [],
        grades: gradesOf(title),
        fields: [],
        url: post.url,
        start: start ?? "",
        end: end ?? "",
        support: got.excerpt,
        source: board.label,
        source_id: board.id,
        school_board: !!board.loose,
        notice_title: title,
        posted: posted ?? "",
        period_from: got.where,
        ...got.details,
      };
      if (!forCollege(item)) continue; // 초·중·고 전용 공고
      out.push(item);
      stat.items++;
    }
  }
  return out;
}

// 게시판 주소를 더하기 전에 한 번 읽어 본다 — 글 목록을 찾았는지, 장학 글이 몇 개인지.
export async function probe(url: string, today: string, fetcher: Fetcher = makeFetcher()) {
  const [data, finalUrl, ctype] = await fetcher.get(url);
  const page = decodeHtml(data, ctype);
  const posts = listPosts(page, finalUrl);
  const title = page.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return {
    posts: posts.filter((p) => p.posted).length,
    scholarship: pick({ loose: true }, posts, today).map((p) => cleanTitle(p.title)).slice(0, 5),
    title: title ? text(title[1]!).slice(0, 60) : "",
  };
}

// 드림스폰(dreamspon.com) '일반 장학금' 모집중 목록.
// 여러 기관의 장학 공고를 사람이 모아 올리는 곳이라 한국장학재단에 등록하지 않은 작은 재단·기업·학회 장학금이 꽤 있다.
// 목록과 글의 신청기간·선발인원·장학혜택 요약은 로그인 없이 보이고, 자격·원문 링크는 로그인해야 보인다.
// 그래서 기관·이름·신청기간·혜택 요약까지 받고, 링크는 드림스폰 글로 건다.
//   목록  /scholarship/list.html?ordby=1&sch_type=keyword&sch_key=대학생&page=N  (모집중, 쪽당 15건)
//   글    /scholarship/view.html?idx=N
// 대상 해시태그는 목록에 앞의 3개만 보여서 키워드 검색으로 '대학생'·'대학원생' 태그가 붙은 글만 받고,
// 대학원생에만 걸린 글은 대학원 전용으로 둔다. 광고·후기·대출이자·이사비 같은 글이 섞여 있어 '장학'이 들어간 것만 받는다.
import * as regions from "./regions";
import { get, key, SourceError, text, ymd, type Item } from "./util";

export const SOURCE = "드림스폰";
const BASE = "https://www.dreamspon.com";
const listUrl = (level: string, no: number) => `${BASE}/scholarship/list.html?ordby=1&sch_type=keyword&sch_key=${encodeURIComponent(level)}&page=${no}`;
export const viewUrl = (idx: string) => `${BASE}/scholarship/view.html?idx=${idx}`;

const MAX_PAGES = 10; // 모집중은 보통 3쪽 안팎
const LEVELS = ["대학생", "대학원생"]; // 이 태그가 붙은 글만 받는다
export const GRAD_ONLY = ["석사신입생(1학기)", "석사2학기이상", "박사과정"]; // source.GRADE_VOCAB 의 대학원 낱말

const SKIP_NAME = /꿀팁|인터뷰|MOU|후기|합격자\s*발표|할인/;

export type Row = { idx: string; name: string; org: string; tags: string[] };
export type Detail = { start: string; end: string; quota: string; benefit: string };

export function parseList(page: string): Row[] {
  const rows: Row[] = [];
  for (const tr of page.matchAll(/<tr class="[^"]*">([\s\S]*?)<\/tr>/g)) {
    const m = tr[1]!.match(/scholarship\/view\.html\?idx=(\d+)"[^>]*>([\s\S]*?)<\/a>/);
    const tds = [...tr[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((t) => t[1]!);
    if (!m || tds.length < 2) continue;
    rows.push({ idx: m[1]!, name: text(m[2]!), org: text(tds[1]!), tags: [...tr[1]!.matchAll(/<span>#([^<]*)<\/span>/g)].map((t) => text(t[1]!)) });
  }
  return rows;
}

export const hasNext = (page: string, no: number) => page.includes(`page=${no + 1}&`) || page.includes(`page=${no + 1}"`);

const DATE = /(20\d\d)\s*\.\s*(\d{1,2})\s*\.\s*(\d{1,2})/g;

// '• 신청기간' 제목 다음 <p> 한 칸. 마지막 칸은 글자 수로 잘려 </p> 없이 </dd> 로 끝난다.
function field(block: string, label: string): string {
  const m = block.match(new RegExp(`•\\s*${label}[\\s\\S]*?</p>\\s*<p>([\\s\\S]*?)(?:</p>|</dd>|$)`));
  return m ? text(m[1]!) : "";
}

// 글 → {start, end, quota, benefit}. 로그인 없이 보이는 요약 칸만 읽는다.
export function parseDetail(page: string): Detail {
  const i = page.indexOf('class="scholarship04"');
  const block = i >= 0 ? page.slice(i, page.indexOf("</dl>", i) < 0 ? undefined : page.indexOf("</dl>", i)) : "";
  const dates = [...field(block, "신청기간").matchAll(DATE)].map((m) => ymd(Number(m[1]), Number(m[2]), Number(m[3]))).filter((d): d is string => !!d);
  // 요약 칸이 글자 수로 잘려 '(생">' 처럼 끝난다 — 잘린 꼬리를 떼어 낸다
  const quota = field(block, "선발인원").replace(/^선발인원\s*/, "");
  const benefit = field(block, "장학혜택").replace(/\s*\([^)]*$|"?>?$/, "").trim();
  return {
    start: dates.length > 1 ? dates[0]! : "",
    end: dates.at(-1) ?? "",
    quota: /^(?:총\s*0+\s*명|.*미정.*)$/.test(quota) ? "" : quota,
    benefit,
  };
}

export function wanted(row: Row): boolean {
  if (row.org === SOURCE || SKIP_NAME.test(row.name)) return false;
  return row.name.includes("장학") || row.tags.includes("장학금");
}

// levels: 이 글이 걸린 대상 검색('대학생'·'대학원생').
export function toItem(row: Row, det: Detail, levels: Set<string> = new Set(["대학생"])): Item {
  const { org, name, tags } = row;
  // 지역: '#지역기준' 이 붙었거나 기관·이름에 지명이 있으면 지역 장학금으로 본다.
  const [a, b] = regions.find(`${org} ${name}`);
  const regional = tags.includes("지역기준") || a.size > 0 || b.size > 0;
  const support = ([["장학혜택", det.benefit], ["선발인원", det.quota]] as const).filter(([, v]) => v).map(([l, v]) => `○ ${l} ${v}`);
  if (tags.length) support.push("○ " + tags.map((t) => "#" + t).join(" "));
  return {
    id: key("dreamspon", row.idx, det.end),
    series: key(org, name),
    org,
    name,
    org_type: "",
    product: tags.includes("대출지원") ? "학자금" : "장학금",
    category: regional ? "지역연고" : "",
    region: regional ? `${org} ${name}` : "",
    schools: [],
    grades: levels.has("대학생") ? [] : [...GRAD_ONLY],
    fields: [],
    url: viewUrl(row.idx),
    start: det.start,
    end: det.end,
    support: support.join("\n"),
    source: SOURCE,
    aggregator: true,
  };
}

const fetchList = async (level: string, no: number) => (await get(listUrl(level, no), {}, 30_000, "드림스폰 응답")).text();
const fetchDetail = async (idx: string) => parseDetail(await (await get(viewUrl(idx), {}, 30_000, "드림스폰 응답")).text());

// 대학생·대학원생 대상 모집중 장학금. 신청기간을 못 읽은 글은 넣지 않는다(지금 받는지 알 수 없다).
export async function collect(
  today: string,
  listPage: (level: string, no: number) => Promise<string> = fetchList,
  detail: (idx: string) => Promise<Detail> = fetchDetail,
): Promise<Item[]> {
  const rows = new Map<string, Row>();
  const levels = new Map<string, Set<string>>();
  for (const level of LEVELS) {
    for (let no = 1; no <= MAX_PAGES; no++) {
      const page = await listPage(level, no);
      const got = parseList(page);
      if (level === LEVELS[0] && no === 1 && !got.length) throw new SourceError("드림스폰 목록을 읽지 못했습니다 (화면 형식이 바뀐 것 같습니다)");
      for (const r of got) {
        if (!rows.has(r.idx)) rows.set(r.idx, r);
        (levels.get(r.idx) ?? levels.set(r.idx, new Set()).get(r.idx)!).add(level);
      }
      if (!got.length || !hasNext(page, no)) break;
    }
  }
  const out: Item[] = [];
  for (const [idx, row] of rows) {
    if (!wanted(row)) continue;
    let det: Detail;
    try {
      det = await detail(idx);
    } catch (e) {
      console.warn(`드림스폰 글 ${idx} 를 못 읽음: ${(e as Error).message}`);
      continue;
    }
    if (!det.end || det.end < today) continue;
    out.push(toItem(row, det, levels.get(idx)));
  }
  return out;
}

// 한국장학재단 학생지원 포털의 '학자금 지원정보 통합검색(대학생)' — 실시간 목록.
// 공공데이터포털 CSV(source.ts)와 같은 원본인데 CSV 는 한 달에 한 번 나온다. 포털은 재단이 등록하는 즉시 보이므로,
// 최근 등록순 몇 쪽만 읽어 CSV 에 아직 없는 장학금을 채운다. 로그인·쿠키 없이 POST 한 번이면 된다.
//   목록  getItgnSrchCstmDsgnGoodsList (sorting=05 최근등록일순, 쪽당 10건)
//   상세  getCstmDsgnGoodsDtl (cstmDsgnGoodsCd) — CSV 와 같은 항목(신청기간·지원금액·자격…)
import { rowItem } from "./source";
import { days, get, parseDate, unescapeHtml, type Item } from "./util";

const URL_ = "https://portal.kosaf.go.kr/CO/jspAction.do";
const BASE = { beanName: "PTSMCstmDsgnGoodsSVC", forwardOnlyFlag: "N", ignoreSession: "Y", innerFlag: "Y" };

const MAX_PAGES = 15;
const STOP_AFTER_KNOWN_PAGES = 2; // CSV 에 다 있는 쪽이 이만큼 이어지면 그 뒤는 CSV 가 갖고 있다

async function post(params: Record<string, string>): Promise<string> {
  const res = await get(URL_, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...BASE, ...params }),
  }, 60_000, "한국장학재단 포털 응답");
  return new TextDecoder("utf-8").decode(await res.arrayBuffer());
}

function cell(fragment: string): string {
  fragment = fragment.replace(/<\/li>|<br\s*\/?>/gi, "\n");
  const t = unescapeHtml(fragment.replace(/<[^>]+>/g, " "));
  return t.split(/\r?\n/).map((ln) => ln.replace(/[ \t\r\xa0]+/g, " ").trim()).filter(Boolean).join("\n");
}

export type ListRow = { code: string; org: string; name: string; end: string };

export function parseList(page: string): ListRow[] {
  const rows: ListRow[] = [];
  for (const tr of page.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const m = tr[1]!.match(/fn_goDtl\('(\d+)'\)/);
    if (!m) continue;
    const tds = [...tr[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((t) => cell(t[1]!));
    if (tds.length < 7) continue;
    rows.push({ code: m[1]!, org: tds[1]!, name: tds[2]!, end: tds[6]!.slice(0, 10) });
  }
  return rows;
}

export async function fetchList(no: number): Promise<ListRow[]> {
  return parseList(await post({
    methodName: "getItgnSrchCstmDsgnGoodsList",
    inputVOName: "kr.go.kosaf.portal.pt.sm.cstmdsgngoods.svc.PTSMCstmDsgnGoodsSVO",
    forwardPage: "pt/sm/cstmdsgngoods/PTSMCstmDsgnGoods_10M",
    no: String(no),
    sorting: "05",
  }));
}

// 상세 화면의 칸 이름 → CSV 열 이름. 같은 이름으로 맞춰 두면 source.ts 의 정리 규칙을 그대로 쓴다.
const LABELS: Record<string, string> = {
  상품구분: "상품구분",
  운영기관구분: "운영기관구분",
  운영기관명: "운영기관명",
  홈페이지주소: "홈페이지 주소",
  대학구분: "대학구분",
  학년구분: "학년구분",
  학과구분: "학과구분",
  성적기준: "성적기준 상세내용",
  소득기준: "소득기준 상세내용",
  지원금액: "지원내역 상세내용",
  특정자격: "특정자격 상세내용",
  지역거주구분: "지역거주여부 상세내용",
  신청기간: "신청기간",
  선발방법: "선발방법 상세내용",
  선발인원: "선발인원 상세내용",
  자격제한: "자격제한 상세내용",
  추천필요여부: "추천필요여부 상세내용",
  "제출처 및 제출서류": "제출서류 상세내용",
};

// 상세 화면 → CSV 한 행과 같은 모양.
export function parseDetail(page: string): Record<string, string> {
  const start = page.indexOf('id="content_wrap"');
  const block = start >= 0 ? page.slice(start, page.indexOf("</table>", start) < 0 ? undefined : page.indexOf("</table>", start)) : "";
  const title = block.match(/<h4 class="bg_title"><span>([\s\S]*?)<\/span>/);
  const cells = [...block.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((c) => cell(c[1]!));
  const row: Record<string, string> = { 상품명: title ? cell(title[1]!) : "" };
  for (let i = 0; i < cells.length - 1; i++) {
    const col = LABELS[cells[i]!];
    if (col && !(col in row)) row[col] = cells[i + 1]!;
  }
  // 목록형 칸(대학·학년·학과)은 줄마다 하나 — CSV 처럼 붙여 두면 같은 어휘 분리기가 먹는다
  for (const col of ["대학구분", "학년구분", "학과구분"]) row[col] = (row[col] ?? "").replace(/\n/g, "");
  const period = (row["신청기간"] ?? "").match(/\d{4}-\d{2}-\d{2}/g) ?? [];
  delete row["신청기간"];
  row["모집시작일"] = period[0] ?? "";
  row["모집종료일"] = period.at(-1) ?? "";
  return row;
}

export async function fetchDetail(code: string): Promise<Record<string, string>> {
  return parseDetail(await post({
    methodName: "getCstmDsgnGoodsDtl",
    inputVOName: "kr.go.kosaf.portal.pt.sm.cstmdsgngoods.svc.PTSMCstmDsgnGoodsDtlSVO",
    forwardPage: "pt/sm/cstmdsgngoods/PTSMCstmDsgnGoods_02M",
    cstmDsgnGoodsCd: code,
  }));
}

// CSV 에 아직 없는 최근 장학금. known 은 CSV 의 "기관|이름|마감일".
// cache 는 상세를 이미 받아 둔 것("code|마감일" → item) — 갱신마다 다시 받지 않는다. 제자리에서 고친다.
export async function collect(
  known: Set<string>,
  cache: Record<string, Item>,
  today: string,
  listPage: (no: number) => Promise<ListRow[]> = fetchList,
  detail: (code: string) => Promise<Record<string, string>> = fetchDetail,
): Promise<Item[]> {
  const out: Item[] = [];
  const seen = new Set<string>();
  let knownRun = 0;
  for (let no = 1; no <= MAX_PAGES; no++) {
    const rows = await listPage(no);
    if (!rows.length) break;
    const fresh = rows.filter((r) => !known.has(`${r.org}|${r.name}|${r.end}`));
    knownRun = fresh.length ? 0 : knownRun + 1;
    if (knownRun >= STOP_AFTER_KNOWN_PAGES) break;
    for (const r of fresh) {
      const k = `${r.code}|${r.end}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const end = parseDate(r.end);
      if (end && days(end, today) > 180) continue; // '최근 마감' 탭보다 오래 지난 것은 굳이 상세를 받지 않는다
      if (!(k in cache)) {
        const item = rowItem(await detail(r.code));
        if (!item) continue;
        item.source = "한국장학재단 포털";
        cache[k] = item;
      }
      out.push(cache[k]!);
    }
  }
  return out;
}

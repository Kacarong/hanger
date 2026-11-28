// 장학금 원본 — 공공데이터포털 '한국장학재단_학자금지원정보(대학생)' (https://www.data.go.kr/data/15028252/fileData.do).
//
// 한국장학재단이 정부·지자체·공공기관·민간 재단·대학의 장학금 공고를 모아 매달 CSV 로 올린다. 키·로그인 없이 받는다.
//   1. selectFileDataDownload.do 에 데이터셋 번호를 주면 이번 달 파일 번호(atchFileId)와 수정일이 나온다.
//   2. 그 파일 번호로 fileDownload.do 를 부르면 CSV(CP949)가 온다.
// 1단계는 가벼워서 자주 불러도 된다. 파일 번호가 그대로면 2단계를 건너뛴다.
import { get, key, SourceError, type Item } from "./util";

const DATASET_PK = "15028252";
const DATASET_DETAIL_PK = "uddi:146a2f2a-3571-4768-9113-8dd47d67338b";
export const PAGE_URL = `https://www.data.go.kr/data/${DATASET_PK}/fileData.do`;
const META_URL = "https://www.data.go.kr/tcs/dss/selectFileDataDownload.do";
const FILE_URL = "https://www.data.go.kr/cmm/cmm/fileDownload.do";

export type Meta = { file_id: string; file_sn: string; name: string; updated: string };

// 이번 달 파일 번호와 수정일. 바뀌었을 때만 CSV 를 다시 받으면 된다.
export async function fetchMeta(): Promise<Meta> {
  const res = await get(META_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ publicDataPk: DATASET_PK, publicDataDetailPk: DATASET_DETAIL_PK, atchFileId: "", fileDetailSn: "1", publicDataTyCode: "PR0051" }),
  }, 30_000, "공공데이터포털 응답");
  let data: any;
  try {
    data = await res.json();
  } catch (e) {
    throw new SourceError(`공공데이터포털 응답을 읽지 못했습니다: ${(e as Error).message}`);
  }
  if (!data?.status || !data?.atchFileId) throw new SourceError(`공공데이터포털이 파일 정보를 주지 않았습니다: ${String(data?.error ?? "").slice(0, 200)}`);
  const info = data.dataSetFileDetailInfo ?? {};
  return { file_id: String(data.atchFileId), file_sn: String(data.fileDetailSn || "1"), name: String(info.dataNm ?? ""), updated: String(info.updtDt ?? "").slice(0, 19) };
}

export async function fetchCsv(meta: Meta): Promise<Uint8Array> {
  const qs = new URLSearchParams({ atchFileId: meta.file_id, fileDetailSn: meta.file_sn });
  const res = await get(`${FILE_URL}?${qs}`, {}, 120_000, "장학금 CSV");
  const raw = new Uint8Array(await res.arrayBuffer());
  if (raw.length < 1000) throw new SourceError("장학금 CSV 가 비어 있습니다");
  return raw;
}

// ---------------------------------------------------------------------------
// 파싱
// 대학구분·학년구분·학과구분은 여러 값이 구분자 없이 붙어서 온다("대학2학기대학3학기…대학신입생"). 아래 어휘로 잘라 목록으로 바꾼다.
// ---------------------------------------------------------------------------
export const SCHOOL_VOCAB = ["4년제(5~6년제포함)", "전문대(2~3년제)", "일반대학원", "전문대학원", "기술대학", "원격대학", "학점은행제 대학", "해외대학", "특정대학", "제한없음", "해당없음"];
const GRADE_VOCAB = [
  "대학신입생",
  ...[2, 3, 4, 5, 6, 7].map((i) => `대학${i}학기`),
  "대학8학기이상", "석사신입생(1학기)", "석사2학기이상", "박사과정", "연령제한", "제한없음", "해당없음",
];
export const FIELD_VOCAB = ["공학계열", "교육계열", "사회계열", "예체능계열", "의약계열", "인문계열", "자연계열", "특정학과", "제한없음", "해당없음"];

function splitter(vocab: string[]) {
  const re = new RegExp([...vocab].sort((a, b) => b.length - a.length).map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  return (text: string) => [...(text || "").matchAll(re)].map((m) => m[0]);
}
const splitSchool = splitter(SCHOOL_VOCAB);
const splitGrade = splitter(GRADE_VOCAB);
const splitField = splitter(FIELD_VOCAB);

// CSV 열 이름 → 우리 이름
export const TEXT_COLUMNS: Record<string, string> = {
  "성적기준 상세내용": "grade_req",
  "소득기준 상세내용": "income",
  "지원내역 상세내용": "support",
  "특정자격 상세내용": "special",
  "지역거주여부 상세내용": "region",
  "선발방법 상세내용": "selection",
  "선발인원 상세내용": "quota",
  "자격제한 상세내용": "restriction",
  "추천필요여부 상세내용": "recommend",
  "제출서류 상세내용": "documents",
};

// 원문은 항목마다 '○' 를 붙여 한 줄로 이어 놓았다. 줄을 나눠 읽기 좋게.
export const clean = (t: string) => (t || "").trim().replace(/\s*(?=[○※])/g, "\n").trim();

function url(t: string): string {
  t = (t || "").trim();
  if (!t || t === "해당없음") return "";
  return /^https?:\/\//.test(t) ? t : "http://" + t;
}

export function decode(raw: Uint8Array): string {
  try {
    return new TextDecoder("euc-kr", { fatal: true }).decode(raw); // WHATWG 의 euc-kr 은 CP949 다
  } catch {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(raw); // BOM 은 알아서 뗀다
    } catch {
      throw new SourceError("CSV 인코딩을 알 수 없습니다");
    }
  }
}

// RFC 4180 CSV — 따옴표 안의 쉼표·줄바꿈·"" 를 읽는다.
export function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// CSV 한 행(열 이름 → 값) → 장학금. 포털 상세도 같은 모양으로 만들어 여기로 태운다(같은 장학금이면 같은 id).
export function rowItem(row: Record<string, string>): Item | null {
  const g = (k: string) => (row[k] ?? "").trim();
  const org = g("운영기관명"), name = g("상품명");
  const start = g("모집시작일").slice(0, 10), end = g("모집종료일").slice(0, 10);
  if (!org || !name) return null;
  const item: Item = {
    // 행 번호는 달마다 바뀌므로 쓰지 않는다. 같은 장학금의 같은 회차면 같은 id.
    id: key(org, name, start),
    series: key(org, name),
    org,
    name,
    org_type: g("운영기관구분"),
    product: g("상품구분"),
    category: g("학자금유형구분"),
    schools: splitSchool(row["대학구분"] ?? ""),
    grades: splitGrade(row["학년구분"] ?? ""),
    fields: splitField(row["학과구분"] ?? ""),
    url: url(row["홈페이지 주소"] ?? ""),
    start,
    end,
  };
  for (const [col, k] of Object.entries(TEXT_COLUMNS)) item[k] = clean(row[col] ?? "");
  return item;
}

export function parse(raw: Uint8Array): Item[] {
  const rows = csvRows(decode(raw));
  const head = rows[0] ?? [];
  if (rows.length < 2 || !head.includes("상품명")) throw new SourceError("CSV 형식이 바뀌었습니다 (상품명 열이 없음)");
  const items = new Map<string, Item>();
  for (const cells of rows.slice(1)) {
    if (cells.length === 1 && !cells[0]) continue; // 빈 줄
    const row: Record<string, string> = {};
    head.forEach((h, i) => (row[h] = cells[i] ?? ""));
    const it = rowItem(row);
    if (it) items.set(it.id, it);
  }
  return [...items.values()];
}

// 장학금 — 네트워크 없이 파싱·조건 판정·출처 합치기·알림 고르기를 확인한다(unifi-site 의 테스트를 옮긴 것).
// 알리미는 틀리면 조용히 망가진다. 알림이 안 오면 마감을 넘기고, 쏟아지면 꺼 버리게 된다.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { openDb } from "../src/db";
import { createScholarship } from "../src/scholarship";
import * as boards from "../src/scholarship/boards";
import * as docs from "../src/scholarship/docs";
import * as dreamspon from "../src/scholarship/dreamspon";
import * as kosaf from "../src/scholarship/kosaf";
import * as logic from "../src/scholarship/logic";
import * as source from "../src/scholarship/source";
import { key, type Item } from "../src/scholarship/util";

const TODAY = "2026-11-03";
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function item(org: string, name: string, start: string, end: string, kw: Partial<Item> = {}): Item {
  return {
    id: key(org, name, start), series: key(org, name), org, name, category: "기타", region: "해당없음",
    grades: ["제한없음"], schools: ["제한없음"], fields: ["제한없음"], start, end, support: "○ 100만원", url: "", ...kw,
  };
}

// 저장 방식(0)만 쓰는 작은 ZIP — HWPX·ZIP 첨부를 흉내 낸다.
function zip(files: Record<string, string | Buffer>): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const n = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const hwpx = (text: string) =>
  zip({ mimetype: "application/hwp+zip", "Contents/section0.xml": `<?xml version="1.0"?><hs:sec>${text.split("\n").map((ln) => `<hp:p><hp:run><hp:t>${ln}</hp:t></hp:run></hp:p>`).join("")}</hs:sec>` });

// 주소에 들어 있는 낱말로 응답을 고르는 가짜 받기 도구(앞에서부터 맞춰 본다).
function fakeFetcher(pages: Record<string, string | Buffer>) {
  const asked: string[] = [];
  const f: boards.Fetcher = {
    async get(url) {
      asked.push(url);
      for (const [k, data] of Object.entries(pages)) if (url.includes(k)) return [Buffer.isBuffer(data) ? data : Buffer.from(data), url, "text/html; charset=utf-8"];
      throw new Error(`없는 주소 ${url}`);
    },
  };
  return { f, asked };
}

describe("CSV 파싱", () => {
  const HEADER = "번호,운영기관명,상품명,운영기관구분,상품구분,학자금유형구분,대학구분,학년구분,학과구분,성적기준 상세내용,소득기준 상세내용,지원내역 상세내용,특정자격 상세내용,지역거주여부 상세내용,선발방법 상세내용,선발인원 상세내용,자격제한 상세내용,추천필요여부 상세내용,제출서류 상세내용,홈페이지 주소,모집시작일,모집종료일";
  const row = (no: number, org: string, name: string, category: string, schools: string, grades: string, fields: string, region: string, start: string, end: string) =>
    [String(no), org, name, "기타", "장학금", category, schools, grades, fields, "해당없음", "해당없음", "○ 100만원", "해당없음", region, "해당없음", "해당없음", "해당없음", "해당없음", "○ 신청서○ 재학증명서", "www.example.org", start, end].map((c) => `"${c}"`).join(",");
  const csv = [HEADER, row(1, "부산장학회", "부산 인재", "지역연고", "4년제(5~6년제포함)전문대(2~3년제)", "대학2학기대학3학기대학8학기이상대학신입생", "공학계열자연계열", "○ 부산 1년 이상 거주", "2026-10-20", "2026-11-10"), row(2, "전국재단", "꿈 장학생", "성적우수", "제한없음", "해당없음", "제한없음", "해당없음", "2026-10-01", "2026-11-05")].join("\n") + "\n" + "x".repeat(1000);
  // CP949 로 적힌 파일: 한글을 euc-kr 바이트로 바꿔 넣는다
  const cp949 = (s: string) => {
    const table = new Map<string, number[]>();
    const dec = new TextDecoder("euc-kr");
    for (let a = 0xb0; a <= 0xc8; a++) for (let b = 0xa1; b <= 0xfe; b++) table.set(dec.decode(new Uint8Array([a, b])), [a, b]);
    for (let a = 0xa1; a <= 0xac; a++) for (let b = 0xa1; b <= 0xfe; b++) table.set(dec.decode(new Uint8Array([a, b])), [a, b]);
    return new Uint8Array([...s].flatMap((ch) => (ch.charCodeAt(0) < 128 ? [ch.charCodeAt(0)] : table.get(ch) ?? [0x3f])));
  };
  test("CP949 를 읽고, 붙어서 오는 학교·학년·계열을 자르고, 줄을 나눈다", () => {
    const items = source.parse(cp949(csv));
    expect(items.length).toBe(2);
    const first = items.find((it) => it.org === "부산장학회")!;
    expect(first.schools).toEqual(["4년제(5~6년제포함)", "전문대(2~3년제)"]);
    expect(first.grades).toEqual(["대학2학기", "대학3학기", "대학8학기이상", "대학신입생"]);
    expect(first.fields).toEqual(["공학계열", "자연계열"]);
    expect(first.documents).toBe("○ 신청서\n○ 재학증명서");
    expect(first.url).toBe("http://www.example.org");
    // 행 번호가 바뀌어도 id 는 그대로 (원본 파이썬과 같은 sha1 열쇠)
    expect(new Set(source.parse(cp949(csv.replace('"1"', '"77"'))).map((it) => it.id))).toEqual(new Set(items.map((it) => it.id)));
    expect(first.id).toBe(key("부산장학회", "부산 인재", "2026-10-20"));
  });
  test("따옴표 안의 쉼표·줄바꿈", () => {
    expect(source.csvRows('a,"b,1\n2","c""d"\r\ne,f')).toEqual([["a", "b,1\n2", 'c"d'], ["e", "f"]]);
  });
});

describe("내 조건", () => {
  const me = { regions: "부산, 해운대구", level: "재학생", school: "전문대(2~3년제)", field: "공학계열" };
  test("지역·과정·학교·계열", () => {
    expect(logic.matches(me, item("부산장학회", "a", "2026-10-01", "2026-11-30", { category: "지역연고", region: "○ 부산 거주" }))).toBe(true);
    expect(logic.matches(me, item("서대문구청", "b", "2026-10-01", "2026-11-30", { category: "지역연고", region: "○ 서대문구 거주" }))).toBe(false);
    expect(logic.matches(me, item("성적재단", "c", "2026-10-01", "2026-11-30", { category: "성적우수", region: "○ 강원도에 1년 이상 거주" }))).toBe(false);
    expect(logic.matches(me, item("전국재단", "d", "2026-10-01", "2026-11-30", { region: "※ 기관확인필요" }))).toBe(true);
    expect(logic.matches({ regions: "" }, item("서대문구청", "b", "2026-10-01", "2026-11-30", { category: "지역연고", region: "○ 서대문구 거주" }))).toBe(true);
    expect(logic.matches(me, item("x", "e", "2026-10-01", "2026-11-30", { grades: ["대학신입생"] }))).toBe(false);
    const grad = item("x", "f", "2026-10-01", "2026-11-30", { grades: ["석사2학기이상", "박사과정"] });
    expect(logic.matches(me, grad)).toBe(false);
    expect(logic.matches({ level: "대학원" }, grad)).toBe(true);
    expect(logic.matches(me, item("x", "g", "2026-10-01", "2026-11-30", { schools: ["4년제(5~6년제포함)"] }))).toBe(false);
    expect(logic.matches(me, item("x", "h", "2026-10-01", "2026-11-30", { schools: ["특정대학"] }))).toBe(true);
    expect(logic.matches(me, item("x", "i", "2026-10-01", "2026-11-30", { fields: ["의약계열"] }))).toBe(false);
    expect(logic.matches(me, item("x", "j", "2026-10-01", "2026-11-30", { fields: ["특정학과"] }))).toBe(true);
  });

  test("지역 판정: 시·도와 시·군·구 두 단계", () => {
    const v = (region: string, org = "어느장학회", profile: object = { regions: "부산, 해운대구" }) => logic.regionVerdict(profile, item(org, region, "2026-10-01", "2026-11-30", { category: "지역연고", region }));
    expect(v("○ 전국")).toBe("na");
    expect(v("○ 전국", "부산은행장학재단")).toBe("na");
    expect(v("○ 군산시에 주민등록을 두고 있는 전국 대학생")).toBe("no");
    expect(v("○ 부산 수영구 거주")).toBe("no");
    expect(v("○ 해운대구에 1년 이상 거주")).toBe("ok");
    expect(v("○ 부산 거주")).toBe("ok");
    expect(v("○ 서대문구 거주", undefined, { regions: "서울" })).toBe("ok");
    expect(v("○ 대구 동구에 주민등록", undefined, { regions: "부산, 동구" })).toBe("no");
    expect(v("○ 동구 관내 거주", "(재)대구동구교육재단", { regions: "부산, 동구" })).toBe("no");
    expect(v("○ 관내 거주", "경상북도 의성군청")).toBe("no");
    expect(v("○ 경기도 광주시 거주", undefined, { regions: "광주" })).toBe("no");
    expect(v("○ 광주광역시 남구 거주", undefined, { regions: "광주, 남구" })).toBe("ok");
    expect(v("○ 서울 강남구 거주", undefined, { regions: "부산, 남구" })).toBe("no");
    expect(v("○ 1년 이상 계속하여 횡성에 주소", "횡성인재육성장학회", { regions: "강원, 횡성군" })).toBe("ok");
    const seoulOnly = item("서울미래인재재단", "서울 장학", "2026-10-01", "2026-11-30", { special: "○ 대한민국 국적자\n○ 서울 소재 4년제 대학 정규학기 학부생" });
    expect(logic.regionVerdict({ regions: "부산" }, seoulOnly)).toBe("no");
    expect(logic.regionVerdict({ regions: "부산" }, item("전국재단", "자격만", "2026-10-01", "2026-11-30", { special: "○ 서울대학교 재학생 중 성적 우수자" }))).toBe("na");
    const eup = item("금왕장학회", "읍", "2026-10-01", "2026-11-30", { category: "지역연고", region: "○ 금왕읍에 1년 이상 거주" });
    expect(logic.regionVerdict({ regions: "부산" }, eup)).toBe("unknown");
    expect(logic.matches({ regions: "부산" }, eup)).toBe(false);
    expect(logic.regionVerdict({ regions: "금왕읍" }, eup)).toBe("ok");
  });

  test("지원 용도와 대출", () => {
    const sup = (support: string, name = "장학생", product = "장학금") => item("재단", name, "2026-10-01", "2026-11-30", { support, product });
    expect(logic.purpose(sup("○ 200만원(생활비) ※등록금지원 장학금과 중복수혜 가능"))).toBe("living");
    expect(logic.purpose(sup("○ 학기당 학업장려금 400만원"))).toBe("living");
    expect(logic.purpose(sup("○ (26년 시급단가) 교내근로 10320원", "국가근로장학금"))).toBe("living");
    expect(logic.purpose(sup("○ 등록금 전액(학기당 최대 500만원)"))).toBe("tuition");
    expect(logic.purpose(sup("○ 100만원"))).toBe("unclear");
    expect(logic.purpose(sup("○ 등록금 범위 내 지원", "학업장려 장학금"))).toBe("tuition");
    expect(logic.purpose(sup("○ 100만원", "생활비 장학금"))).toBe("living");
    expect(logic.purpose(sup("○ 등록금 300만원 ※ 생활비 지원 불가"))).toBe("tuition");
    expect(logic.purpose(sup("○ 대출 이자 (생활비 제외)"))).toBe("unclear");
    expect(logic.matches({ purpose: "living" }, sup("○ 100만원"))).toBe(false);
    expect(logic.matches({ purpose: "no_tuition" }, sup("○ 100만원"))).toBe(true);
    expect(logic.matches({ purpose: "no_tuition" }, sup("○ 등록금 전액"))).toBe(false);
    const loan = sup("○ 연 200만 원", "AI학업장려 학자금대출", "학자금");
    expect(logic.isLoan(loan)).toBe(true);
    expect(logic.isLoan(sup("○ 대출이자 전액", "대학생학자금대출이자지원", "학자금"))).toBe(true);
    expect(logic.matches({}, loan)).toBe(false);
    expect(logic.matches({ exclude_loans: false }, loan)).toBe(true);
    // 관심 표시해도 대출·지원 용도로 뺀 것은 알림이 안 간다
    const soonLoan = item("재단", "관심 대출", "2026-11-01", "2026-11-05", { product: "학자금" });
    const soonTuition = item("재단", "관심 등록금", "2026-11-01", "2026-11-05", { support: "○ 등록금 전액" });
    const notes = logic.planNotifications([soonLoan, soonTuition], { profile: { exclude_loans: true, purpose: "living" }, settings: { reminder_days: [7, 3, 1] }, stars: [soonLoan.series, soonTuition.series], knownIds: new Set(), sent: new Set(), today: TODAY });
    expect(notes).toEqual([]);
  });

  test("연중 사업·작년 일정 참고·최근 마감", () => {
    const work = item("(재)한국장학재단", "국가근로장학금", "2026-03-01", "2027-02-28");
    expect([logic.status(work, TODAY), logic.status(item("(재)한국장학재단", "캠프", "2026-11-01", "2026-12-31"), TODAY)]).toEqual(["year_round", "open"]);
    expect(logic.status(work, "2027-03-01")).toBe("closed");
    expect(logic.planNotifications([work], { profile: {}, settings: { reminder_days: [7, 3, 1] }, stars: [work.series], knownIds: new Set([work.id]), sent: new Set(), today: "2027-02-25" })).toEqual([]);

    const doneThisYear = item("재단D", "올해 끝남", "2026-09-01", "2026-09-20");
    const got = logic.forecast([
      item("재단A", "가을 장학", "2025-11-10", "2025-11-30"),
      item("재단B", "작년엔 지금 모집", "2025-10-20", "2025-11-15"),
      item("재단C", "봄 장학", "2025-03-02", "2025-03-20"),
      doneThisYear,
      item("재단D", "올해 끝남", "2025-11-05", "2025-11-25"),
      item("재단E", "모집 중", "2026-10-20", "2026-11-20"),
      item("재단E", "모집 중", "2025-10-20", "2025-11-20"),
    ], TODAY);
    expect(got.map((f) => [f.org, f.started])).toEqual([["재단A", false], ["재단B", true]]);
    expect([got[0]!.expected_start, got[0]!.expected_end]).toEqual(["2026-11-10", "2026-11-30"]);
    const closed = logic.recentlyClosed([doneThisYear, item("재단E", "모집 중", "2026-10-20", "2026-11-20"), item("재단F", "10월 마감", "2026-10-01", "2026-10-30")], TODAY);
    expect(closed.map((f) => f.org)).toEqual(["재단F", "재단D"]);
  });
});

describe("공고문에서 신청 기간 읽기", () => {
  const f = docs.findPeriod;
  test("여러 날짜 모양", () => {
    expect(f("신청기간 ○ 2026-10-19 ~ 2026-11-13", "2026-10-20")).toEqual(["2026-10-19", "2026-11-13"]);
    expect(f("1) 지원서 접수 : 2026년 10월 19일월(   ) 12시 ~ 11월 13일금(   ) 18시", "2026-10-27")).toEqual(["2026-10-19", "2026-11-13"]);
    expect(f("모집기간: 12. 20.(금) ~ 1. 10.(금)", "2026-12-18")).toEqual(["2026-12-20", "2027-01-10"]);
    expect(f("신청기간: 2025.1.2~1.18", "2026-01-02")).toEqual(["2026-01-02", "2026-01-18"]);
    expect(f("○ 접수 기간 : 2025.12.26 ~ 2026.01.09 18시", null)).toEqual(["2025-12-26", "2026-01-09"]);
    expect(f("지원 마감 기한 : ~2026.1.15", "2025-11-17")).toEqual([null, "2026-01-15"]);
    expect(f("접수기한 2026.10.11", "2026-09-15")).toEqual([null, "2026-10-11"]);
    expect(f("신청방법: 8월 11일(월)까지 학과장 추천", "2026-07-16")).toEqual([null, "2026-08-11"]);
    expect(f("결과 발표: 12월 1일\n접수기간: 11월 3일 ~ 11월 20일", "2026-11-01")).toEqual(["2026-11-03", "2026-11-20"]);
    expect(f("2026년 1월 2일(금)  ※ 온라인\n   지원서 접수\n  - 1월 13일(화) 17:00 마감", "2025-12-01")).toEqual(["2026-01-02", "2026-01-13"]);
    expect(f("장학생을 아래와 같이 선발합니다", TODAY)).toEqual([null, null]);
  });
  test("첨부 파일에서 글자 꺼내기 (HWPX, ZIP 안의 공고문)", async () => {
    const doc = hwpx("1. 모집 개요\n접수기간: 2026. 11. 10.(화) ~ 11. 24.(화)");
    expect(docs.kindOf(doc)).toBe("hwpx");
    expect(await docs.textOf(doc)).toContain("접수기간: 2026. 11. 10.(화) ~ 11. 24.(화)");
    const bundle = zip({ "apply_form.hwpx": hwpx("신청서 작성일 2026. 1. 1."), "notice.hwpx": doc, "photo.jpg": Buffer.from([0xff, 0xd8]) });
    expect(docs.findPeriod(await docs.textOf(bundle), TODAY)).toEqual(["2026-11-10", "2026-11-24"]);
    expect(await docs.textOf(Buffer.from("\xff\xd8\xff\xe0 jpeg", "latin1"))).toBe("");
    expect(await docs.textOf(Buffer.from("\xd0\xcf\x11\xe0broken", "latin1"))).toBe("");
  });
});

const LIST_PAGE = `
<ul class="menu"><li><a href="/about">재단소개 및 장학사업 안내</a></li></ul>
<table><tbody>
<tr><td>3</td><td class="tit"><a href="/not/default.asp?page=1&bidx=56512&sfield=2&gtxt=장학&gbn=10&amp;bgbn=R">[엔지니어링인재육성재단] 제2기 장학생 모집 안내</a></td><td class="date">2026.10.27</td></tr>
<tr><td>2</td><td class="tit"><a href="/not/default.asp?bidx=55000">2026 장학생 선발 결과 발표</a></td><td class="date">2026.10.20</td></tr>
<tr><td>1</td><td class="tit"><a href="/not/default.asp?bidx=40000">2025년도 장학생 모집 공고</a></td><td class="date">2025.03.02</td></tr>
</tbody></table>`;
const POST_PAGE = `
<div class="board_view"><p><img src="/upload/poster.jpg"></p>
<span>작성일 26-10-27 10:00</span>
<div class="view_file_box"><a href="/lib/file_down.asp?filename=notice.hwpx&furl=16">[공고문] 제2기 장학생 선발.hwpx</a>
<a href="/lib/file_down.asp?filename=form.hwpx&furl=16">신청서 양식.hwpx</a></div></div>`;

describe("공고 게시판", () => {
  test("목록·제목·첨부 읽기", () => {
    const posts = boards.listPosts(LIST_PAGE, "https://www.ksce.or.kr/not/default.asp?gbn=10");
    expect(posts.filter((p) => boards.wanted(p.title)).map((p) => p.title)).toEqual(["[엔지니어링인재육성재단] 제2기 장학생 모집 안내", "2025년도 장학생 모집 공고"]);
    expect(decodeURI(posts[1]!.url)).toContain("&gtxt=장학&gbn=10&bgbn=R"); // '&gtxt=' 를 '>xt=' 로 망가뜨리지 않음
    expect(posts[1]!.posted).toBe("2026-10-27");
    expect(boards.wanted("2026 장학생 선발 결과 발표")).toBe(false);
    expect(boards.wanted("제30기 (2026년 하반기) 대학생 장학금 신청과 관련하여")).toBe(true);
    expect(boards.cleanTitle("applying 2027년 두산연강 대학 장학생 선발 안내 신청기간 2026-10-14 ~ 2026-11-13")).toBe("2027년 두산연강 대학 장학생 선발 안내");
    expect(boards.cleanTitle("공지 2027년도 한국지도자육성장학재단 일반장학생 신청 안내 UPDATED 학생과 2026-10-16 1,193")).toBe("2027년도 한국지도자육성장학재단 일반장학생 신청 안내");
    expect(boards.cleanTitle("인재림(人材林) 제7기 지원자 모집 H 인기글 인재림(人材林) 제7기 지원자 모집 중~! 장학 프로그램")).toBe("인재림(人材林) 제7기 지원자 모집");
    expect(boards.cleanTitle("부산지역인재 장학금 공고 부산지역인재 장학금 공고")).toBe("부산지역인재 장학금 공고");
    expect(boards.postedInPage("작성일 25-12-26 11:39")).toBe("2025-12-26");
    expect(boards.attachments(POST_PAGE, "https://www.ksce.or.kr/not/default.asp").map(([, n]) => n)).toEqual(["[공고문] 제2기 장학생 선발.hwpx", "신청서 양식.hwpx"]);
    expect(boards.attachments(`<a href="javascript:file_download('/download?db=1&id=5350&no=0', '안내문.pdf');">붙임1) 추천 안내문.pdf (115.2K)</a>`, "https://www.kosffl.or.kr/news/notice?page=view&id=5350").map(([u]) => u)).toEqual(["https://www.kosffl.or.kr/download?db=1&id=5350&no=0"]);
    const gijang = boards.listPosts('<table><tr><td><a href="/v?n=1">2026년도 하반기 기장군 장학금 신청 알림</a></td><td>051-709-4000</td><td>26.09.18</td></tr></table>', "https://www.gijang.go.kr/l");
    expect(gijang[0]!.posted).toBe("2026-09-18");
    const asan = boards.listPosts(
      '<table><tr><td><a href="/af/Detail.do" onclick="fnDetail(11306); return false;">2027년 아산장학생 선발 안내</a></td><td>2026.10.01</td></tr><tr><td><a href="/af/Detail.do" onclick="fnDetail(11305); return false;">2027년 북한이탈청소년장학생 선발 안내</a></td><td>2026.10.01</td></tr></table>',
      "https://www.asanfoundation.or.kr/af/List.do", ["fnDetail\\((\\d+)\\)", "https://x.example/Detail.do?idx={}"],
    );
    expect(asan.map((r) => r.url)).toEqual(["https://x.example/Detail.do?idx=11306", "https://x.example/Detail.do?idx=11305"]);
  });

  test("고르기: 학교 게시판은 '모집' 없어도, 장학 재단은 주제 낱말로", () => {
    const school = [
      { title: "2026학년도 부경 더채움 장학금", posted: "2026-10-11", url: "a" },
      { title: "2026-2학기 국가장학금Ⅰ유형 장학금 지급 안내(2차)", posted: "2026-10-26", url: "b" },
      { title: "「부경 더채움 장학금」서식 변경사항 안내", posted: "2026-10-07", url: "c" },
      { title: "맞춤형 장학검색", posted: null, url: "d" },
    ];
    expect(boards.pick({ loose: true }, school, TODAY).map((p) => p.url)).toEqual(["a"]);
    expect(boards.pick({ want: "장학|지원자\\s*모집" }, [
      { title: "인재림(人材林) 제7기 지원자 모집 H 인기글", posted: "2026-10-07", url: "a" },
      { title: "드림렉처 학교 신청 접수 H 인기글 재단의 장학프로그램을 통해", posted: "2026-08-21", url: "b" },
    ], TODAY).map((p) => p.url)).toEqual(["a"]);
  });

  test("모으기: 본문에 날짜가 없으면 첨부 공고문에서, 오래된 글은 열지 않음", async () => {
    const { f, asked } = fakeFetcher({
      "notice.hwpx": hwpx("○ 장학금: 학기당 생활지원금 300만원 지급\n지원서 접수 : 2026년 10월 19일 ~ 11월 13일"),
      "bidx=56512": POST_PAGE,
      "bidx=40000": "<p>작성일 2025-03-02</p><p>접수기간 2025.3.2 ~ 2025.3.20</p>",
      "gbn=10": LIST_PAGE,
    });
    const board = { id: "ksce_news", label: "대한토목학회 토목계소식", org: "대한토목학회", bracket_org: true, url: "https://www.ksce.or.kr/not/default.asp?gbn=10" };
    const got = await boards.collect([board], TODAY, {}, f);
    expect(got.map((g) => [g.org, g.start, g.end])).toEqual([["엔지니어링인재육성재단", "2026-10-19", "2026-11-13"]]);
    expect(got[0]!.period_from).toBe("첨부 [공고문] 제2기 장학생 선발.hwpx");
    expect(logic.purpose(got[0]!)).toBe("living");
    expect(asked.some((u) => u.includes("bidx=40000"))).toBe(false);
  });

  test("내부망 주소는 받지 않는다", async () => {
    const stats: Record<string, boards.Stat> = {};
    await boards.collect([{ id: "bad", label: "x", org: "x", url: "http://127.0.0.1:8090/" }], TODAY, stats);
    expect(stats.bad!.error).toBe("내부망 주소는 넣을 수 없습니다");
    expect(["10.0.0.1", "192.168.10.9", "172.20.1.1", "169.254.1.1", "::1", "fd00::1", "::ffff:127.0.0.1"].map(boards.isGlobalIp)).toEqual(Array(7).fill(false));
    expect(["8.8.8.8", "2606:4700::1111"].map(boards.isGlobalIp)).toEqual([true, true]);
  });

  test("공고 상세 읽기", async () => {
    const got = boards.details(`
2027년도 제2기 장학생 선발 공고
1. 선발 인원 : 총 90 명
   1   대 학 생        50명    총 5,000,000 원
2. 선발 대상
 가. 지원 자격 : 엔지니어링 및 에너지 관련 학과 재학생
    1) 국내 4 년제 대학 3학기 이상 재학 중인 자
    2) 평균 평점 3.0 이상인 자
3. 선발 절차
 가. 서류 전형
4. 제출 서류
             1. 장학금 지원서(재단 양식) 1 부
             2. 재학증명서 및 성적증명서 각 1 부
5. 신청 방법 : 재단 이메일 접수
□ 지원자격 및 제출서류(학부).hwp
`);
    expect(got.quota!.split("\n")[0]).toBe("총 90 명");
    expect(got.special).toBe("엔지니어링 및 에너지 관련 학과 재학생\n1) 국내 4 년제 대학 3학기 이상 재학 중인 자\n2) 평균 평점 3.0 이상인 자");
    expect(got.documents).toBe("1. 장학금 지원서(재단 양식) 1 부\n2. 재학증명서 및 성적증명서 각 1 부");
    expect(got.how).toBe("재단 이메일 접수");
    expect(boards.details("○ 다음 사항에 해당할 시, 서류심사를 진행하지 않음\n- 필수 제출 서류 누락\n- 허위 기재\n3. 제출 서류\n○ (필수) 온라인 지원서 1부, 대학교 성적증명서\n4. 유의 사항\n○ 기타").documents).toBe("○ (필수) 온라인 지원서 1부, 대학교 성적증명서");

    const page = ["등록금안내", "장학제도", "등록금안내", "2026 푸른등대 기부장학금 선발 안내", "학생복지과", "2026 푸른등대 기부장학금 선발 안내",
      "한국장학재단에서 2026년 2학기 푸른등대 기부장학금 신규장학생을 아래와 같이 선발하오니 많은 신청 바랍니다. 저소득층 대학생에게 학기당 생활비 250만 원을 지원합니다. 신청은 재단 누리집에서 받습니다.",
      "- 신청방법: 한국장학재단 누리집", "이전글", "등록금안내 장학 일정"].join("\n");
    const body = boards.contentOf(page, "2026 푸른등대 기부장학금 선발 안내");
    expect([body.includes("등록금안내"), body.includes("신청방법")]).toEqual([false, true]);
    expect(boards.excerpt(body)).not.toContain("등록금안내");
    expect(boards.contentOf(page, "다른 글 제목입니다")).toBe(page);

    const post = "<h3>2026 정효택 장학생 선발 계획</h3><p>작성일 2026-10-14</p><p>신청기간: 2026. 10. 14. ~ 10. 19.</p>" +
      "<p>지원자격, 제출서류 등 세부사항은 붙임 모집공고 참조 바랍니다. 학과 사무실로 문의하세요. 장학생 선발 계획을 안내드리니 많은 신청 바랍니다.</p>".repeat(3) +
      '<a href="/down.php?f=1">모집공고.hwpx</a>';
    const { f } = fakeFetcher({ "down.php": hwpx("○ 선발인원: 8명\n○ 지원자격: 학부 3, 4학년 재학생\n○ 제출서류: 지원서 1부\n○ 장학금액: 2,000,000원(생활비지원)"), view: post });
    const read = await boards.readPost(f, { title: "2026 정효택 장학생 선발 계획", url: "https://x.example/view", posted: "2026-10-14" });
    expect([read.end, read.details.quota, read.details.special]).toEqual(["2026-10-19", "8명", "학부 3, 4학년 재학생"]);
    expect(read.excerpt).not.toContain("생활비"); // 상세만 보려고 연 공고문은 생활비 판정에 안 씀
  });

  test("학적: 대학원 공고, 초·중·고 공고", async () => {
    expect(boards.gradesOf("2027년 의생명과학분야 대학원 장학생 선발 안내")).toEqual(["석사신입생(1학기)", "석사2학기이상", "박사과정"]);
    expect(boards.gradesOf("2027년 의생명과학분야 대학 장학생 선발 안내")).toEqual([]);
    expect(boards.forCollege({ id: "", series: "", org: "", name: "", notice_title: "남구장학회 해외역사문화체험 장학생 선발계획 공고", special: "- 남구에 3년 이상 거주하는 중학교 2학년 재학생" })).toBe(false);
    expect(boards.forCollege({ id: "", series: "", org: "", name: "", notice_title: "기장군 장학금 신청 알림", special: "고등학생 및 대학생" })).toBe(true);
    const { f } = fakeFetcher({ "list": '<table><tr><td><a href="/b?no=1">2026 부경 장학생 선발 안내</a></td><td>2026-10-30</td></tr></table>', "no=1": '<p>작성일 2026-10-30</p><p><img src="/poster.jpg"></p>' });
    const got = await boards.collect([{ id: "pknu_civil", label: "부경대 토목공학과", org: "부경대학교 토목공학과", url: "https://civil.pknu.ac.kr/list", loose: true }], TODAY, {}, f);
    expect(got.map((g) => [g.start, g.end, g.posted])).toEqual([["", "", "2026-10-30"]]); // 이미지뿐인 공고
    expect(logic.status(got[0]!, TODAY)).toBe("unknown");
    expect(logic.planNotifications(got, { profile: {}, settings: { reminder_days: [7] }, stars: [got[0]!.series], knownIds: new Set(), sent: new Set(), today: TODAY })).toEqual([]);
  });
});

describe("한국장학재단 포털·드림스폰", () => {
  test("포털 목록·상세 → CSV 와 같은 모양, CSV 에 다 있는 쪽이 이어지면 멈춤", async () => {
    const listRow = (code: string, org: string, name: string, end: string) => `<tr><td class="hide_m">1</td><td class="hide_m">${org}</td><td>${name}</td><td>기타</td><td>장학금</td><td>○ 02-000-0000</td><td class="hide_m">${end}</td><td><a href="javascript:fn_goDtl('${code}');">상세보기</a></td></tr>`;
    expect(kosaf.parseList("<table><tbody>" + listRow("2704367001", "사랑의달팽이", "꿈 Dream 장학금", "2026-11-13") + "</tbody></table>")).toEqual([{ code: "2704367001", org: "사랑의달팽이", name: "꿈 Dream 장학금", end: "2026-11-13" }]);
    const detail = `<div id="content_wrap" class="width_1200 portal"><div><h4 class="bg_title"><span>꿈 Dream 장학금</span></h4><table><tbody>
<tr><th>상품구분</th><th>장학금</th><th>운영기관구분</th><th>기타</th><th>운영기관명</th><th>사랑의달팽이</th></tr>
<tr><td>대학구분</td><td><ul><li>4년제(5~6년제포함)</li><li>제한없음</li></ul></td></tr>
<tr><td>학년구분</td><td><ul><li>대학신입생</li><li>대학2학기</li></ul></td></tr>
<tr><td>지원금액</td><td>○ 학습 장학금 200만원 지원</td></tr>
<tr><td>신청기간</td><td>○ 2026-10-19 ~ 2026-11-13</td></tr></tbody></table></div></div>`;
    const it = source.rowItem(kosaf.parseDetail(detail))!;
    expect([it.org, it.name, it.start, it.end, it.grades]).toEqual(["사랑의달팽이", "꿈 Dream 장학금", "2026-10-19", "2026-11-13", ["대학신입생", "대학2학기"]]);
    expect(it.id).toBe(key("사랑의달팽이", "꿈 Dream 장학금", "2026-10-19")); // CSV 에 같은 장학금이 오면 같은 id(알림 두 번 안 감)

    const pages: Record<number, kosaf.ListRow[]> = {
      1: [{ code: "1", org: "새재단", name: "새 장학금", end: "2026-11-20" }, { code: "2", org: "옛재단", name: "옛 장학금", end: "2026-10-30" }],
      2: [{ code: "2", org: "옛재단", name: "옛 장학금", end: "2026-10-30" }],
      3: [{ code: "3", org: "옛재단2", name: "장학금", end: "2026-10-01" }],
      4: [{ code: "9", org: "안읽음", name: "장학금", end: "2026-12-01" }],
    };
    const asked: string[] = [];
    const det = async (code: string) => (asked.push(code), { 운영기관명: "새재단", 상품명: "새 장학금", 모집시작일: "2026-11-01", 모집종료일: "2026-11-20" });
    const known = new Set(["옛재단|옛 장학금|2026-10-30", "옛재단2|장학금|2026-10-01"]);
    const cache = {};
    const got = await kosaf.collect(known, cache, TODAY, async (no) => pages[no] ?? [], det);
    expect(got.map((g) => g.name)).toEqual(["새 장학금"]);
    expect(asked).toEqual(["1"]);
    await kosaf.collect(known, cache, TODAY, async (no) => pages[no] ?? [], det);
    expect(asked).toEqual(["1"]); // 받아 둔 상세는 다시 받지 않음
  });

  const dsRow = (idx: string, name: string, org: string, tags: string[]) =>
    `<tr class=""><td class="td_subject"><p class="title"><a href="/scholarship/view.html?idx=${idx}">${name}</a></p><div class="hashtag">${tags.map((t) => `<span>#${t}</span>`).join("")}</div></td><td>${org}</td><td class="td_day">D-2</td><td class="hit">1</td></tr>`;
  const DS_DETAIL = `<dl class="scholarship04"><dt style='display:none;'></dt><dd><p><span><strong>• 신청기간</strong></span></p><p><b>2026. 10. 19. ~ 2026. 11. 06. </b></p><br><br><p><span><strong>• 선발인원</strong></span></p><p><b>총 2명</b></p><br><br><p><span><strong>• 장학혜택</strong></span></p><p><b>[장학금지급] 최대 200 만원 (생"></dd></dl>`;
  test("드림스폰 목록·글·대상", async () => {
    const page = "<table><tbody>" + dsRow("9264", "신주장학재단 대학생 생활비 장학", "신주장학재단", ["장학금", "대학생", "추천서"]) + dsRow("9263", "양평군장학회 학자금대출 이자지원", "양평군장학회", ["대출지원", "대학생"]) +
      dsRow("8853", "의왕시 청년 이사비지원", "의왕시", ["기타지원", "청년", "지역기준"]) + dsRow("5134", "첫번째 장학금 받는 꿀팁1", "드림스폰", []) + dsRow("9271", "서귀포시 남원읍 인재양성 꿈 장학 (2026년)", "서귀포시 남원읍", ["장학금", "중학생"]) + "</tbody></table>";
    const rows = dreamspon.parseList(page);
    expect(rows[0]).toEqual({ idx: "9264", name: "신주장학재단 대학생 생활비 장학", org: "신주장학재단", tags: ["장학금", "대학생", "추천서"] });
    expect(rows.filter(dreamspon.wanted).map((r) => r.idx)).toEqual(["9264", "9263", "9271"]);
    const det = dreamspon.parseDetail(DS_DETAIL);
    expect(det).toEqual({ start: "2026-10-19", end: "2026-11-06", quota: "총 2명", benefit: "[장학금지급] 최대 200 만원" });
    const grad = "<table>" + dsRow("9266", "한국여성재단 실천여성학 펠로우십 장학", "한국여성재단", ["장학금", "대학원생"]) + "</table>";
    const hidden = "<table>" + dsRow("9999", "고창군장학재단 장학 (2026년)", "고창군장학재단", ["장학금", "초등학생", "중학생"]) + "</table>";
    const pages: Record<string, string> = { "대학생|1": page.replace(dsRow("9271", "서귀포시 남원읍 인재양성 꿈 장학 (2026년)", "서귀포시 남원읍", ["장학금", "중학생"]), "") + hidden, "대학원생|1": grad };
    const dets: Record<string, dreamspon.Detail> = { 9264: det, 9263: det, 9271: { ...det, end: "2026-11-01" }, 9266: det, 9999: det };
    const got = await dreamspon.collect(TODAY, async (lv, no) => pages[`${lv}|${no}`] ?? "", async (idx) => dets[idx]!);
    expect(got.map((g) => g.url.split("=").at(-1))).toEqual(["9264", "9263", "9999", "9266"]);
    const [shinju, loan, gochang, gradItem] = got as [Item, Item, Item, Item];
    expect(logic.matches({ level: "재학생" }, gochang)).toBe(true);
    expect([logic.matches({ level: "재학생" }, gradItem), logic.matches({ level: "대학원" }, gradItem)]).toEqual([false, true]);
    const got2 = await dreamspon.collect(TODAY, async (lv, no) => (lv === "대학생" && no === 1 ? page : ""), async (idx) => dets[idx]!);
    expect(got2.map((g) => g.url.split("=").at(-1))).toEqual(["9264", "9263"]); // 마감 지난 글은 뺌
    expect(dreamspon.collect(TODAY, async () => "<html>바뀐 화면</html>", async () => det)).rejects.toThrow("드림스폰 목록을 읽지 못했습니다");
    const profile = { regions: "부산", purpose: "living", exclude_loans: true };
    expect([logic.purpose(shinju), logic.matches(profile, shinju)]).toEqual(["living", true]);
    expect(logic.isLoan(loan)).toBe(true);
    expect(logic.regionVerdict(profile, dreamspon.toItem(rows[4]!, det))).toBe("no");
  });
});

describe("출처 합치기", () => {
  test("CSV·포털·게시판 공고를 한 번만", () => {
    const base = [item("(재)두산연강재단", "장학생", "2025-10-15", "2025-11-14"), item("(재)엔지니어링인재육성재단", "장학생", "2026-10-19", "2026-11-13"), item("재단A", "장학금", "2026-10-01", "2026-10-31")];
    const notice = { ...item("두산연강재단", "2027년 두산연강 대학 장학생 선발 안내", "2026-10-14", "2026-11-13"), notice_title: "2027년 두산연강 대학 장학생 선발 안내", source: "두산연강재단" };
    const same = { ...item("엔지니어링인재육성재단", "[엔지니어링인재육성재단] 제2기 장학생 모집 안내", "2026-10-19", "2026-11-13"), notice_title: "[엔지니어링인재육성재단] 제2기 장학생 모집 안내", source: "대한토목학회 토목계소식", period_from: "첨부 공고문.pdf", url: "https://www.ksce.or.kr/not/default.asp?bidx=56512" };
    const out = logic.merge(base, [notice, same, { ...item("재단A", "장학금", "2026-10-01", "2026-10-31"), source: "한국장학재단 포털" }, { ...item("재단B", "장학금", "2026-11-01", "2026-11-30"), source: "한국장학재단 포털" }]);
    expect(out.length).toBe(5);
    expect(out.find((x) => (x.notice_title ?? "").startsWith("2027년 두산"))!.series).toBe(base[0]!.series);
    const eng = out.filter((x) => logic.orgCore(x.org) === "엔지니어링인재육성재단");
    expect([eng.length, eng[0]!.notice_url, eng[0]!.period_from]).toEqual([1, same.url, "첨부 공고문.pdf"]);
    expect(logic.forecast(out, "2026-10-01").map((f) => f.org)).toEqual([]);
    const repost = { ...item("부경대학교", "2026년 부산지역인재 장학금 하반기 생활장학금 지원 신청 공고", "2026-10-14", "2026-10-28"), notice_title: "2026년 부산지역인재 장학금 하반기 생활장학금 지원 신청 공고<~10. 28.>", url: "https://www.pknu.ac.kr/main/163?action=view&no=1", source: "부경대 등록·장학 공지" };
    const out2 = logic.merge([item("부산광역시청", "부산지역인재 장학금", "2026-10-14", "2026-10-28")], [repost]);
    expect([out2.length, out2[0]!.notice_url]).toEqual([1, repost.url]);
  });

  test("드림스폰은 아무 데도 없는 것만, 이름이 다르면 둘 다", () => {
    const det = dreamspon.parseDetail(`<dl class="scholarship04"><dd><p><span><strong>• 신청기간</strong></span></p><p><b>2026. 10. 19. ~ 2026. 11. 06. </b></p></dd></dl>`);
    const ds = (org: string, name: string, end: string) => dreamspon.toItem({ idx: name, name, org, tags: ["장학금"] }, { ...det, end });
    const profile = { regions: "부산", purpose: "living", exclude_loans: true };
    const base = [item("재단법인 신주장학재단", "대학생 장학금", "2025-10-01", "2025-10-31"), item("(재)두산연강재단", "장학생", "2026-10-14", "2026-11-13")];
    const board = { ...item("대한환경공학회", "에코니티 장학 공고", "2026-10-19", "2026-11-20"), notice_title: "에코니티 장학 공고", source_id: "x", source: "게시판" };
    const out = logic.merge(base, [ds("두산연강재단", "두산연강재단 장학 (2027년)", "2026-11-13"), ds("대한환경공학회", "에코니티·대한환경공학회 우수학생 장학", "2026-11-20"), ds("신주장학재단", "신주장학재단 대학생 생활비 장학", "2026-11-06"), board]);
    expect(out.map((x) => x.source ?? "csv").sort()).toEqual(["csv", "csv", "게시판", "드림스폰"]);
    const fresh = out.find((x) => x.source === "드림스폰")!;
    expect(fresh.series).toBe(base[0]!.series);
    expect([fresh.name, logic.matches(profile, fresh)]).toEqual(["신주장학재단 대학생 생활비 장학", true]);
    const notes = logic.planNotifications(out, { profile, settings: { notify_new: true }, stars: [], knownIds: new Set(base.map((x) => x.id)), sent: new Set(), today: TODAY });
    expect(notes.map((n) => [n.kind, n.items.map((i) => i.name)])).toEqual([["new", ["신주장학재단 대학생 생활비 장학"]]]);
    const two = logic.merge([item("가나재단", "A 장학금", "2026-10-01", "2026-11-20")], [ds("가나재단", "가나재단 B 장학", "2026-11-20"), ds("가나재단", "가나재단 A 장학 (2026년)", "2026-11-20")]);
    expect(two.map((x) => x.name).sort()).toEqual(["A 장학금", "가나재단 B 장학"]);
    const sameOrgEnd = logic.merge([item("가나재단", "인재육성 등록금 장학금", "2026-10-01", "2026-11-20"), item("(재)한국장학재단", "푸른등대 기부장학금(한국가스공사)", "2026-10-22", "2026-11-12")],
      [ds("가나재단", "인재육성 생활비 장학금", "2026-11-20"), ds("한국장학재단", "푸른등대 기부장학금(키움증권)", "2026-11-12"), ds("한국장학재단", "푸른등대 기부장학금 (2026년 2학기)", "2026-11-12")]);
    expect(sameOrgEnd.filter((x) => x.source === "드림스폰").map((x) => x.name)).toEqual(["인재육성 생활비 장학금", "푸른등대 기부장학금(키움증권)"]);
    const gn = logic.merge([item("경상남도장학회", "도내 대학 해외교환 장학생", "2026-04-06", "2026-12-18"), item("(재)한국장학재단", "푸른등대 키움증권 기부장학금", "2026-10-22", "2026-11-12")],
      [ds("경상남도장학회", "경상남도 대학 해외 교환장학생 모집", "2026-12-18"), ds("한국장학재단", "푸른등대 한국가스공사 기부장학금", "2026-11-12")]);
    expect(gn.filter((x) => x.source === "드림스폰").map((x) => x.name)).toEqual(["푸른등대 한국가스공사 기부장학금"]);
  });

  test("학교 게시판 공고끼리는 합치지 않는다", () => {
    const notice = (title: string, start: string, end: string, org = "부경대학교 토목공학과") => {
      const it = item(org, title, start, end);
      return { ...it, notice_title: title, url: `https://civil.pknu.ac.kr/${it.id}`, posted: "2026-10-01", source: "부경대 토목공학과", source_id: "pknu_civil", school_board: true };
    };
    const a = notice("2026학년도 부경 더채움 장학금", "2026-09-01", "2026-12-31");
    const b = notice("푸른등대 기부장학금 선발 안내", "2026-10-22", "2026-12-31");
    const out = logic.merge([item("부경대학교 토목공학과", "동문회 장학금", "2026-09-01", "2026-12-31")], [a, b]);
    expect(out.map((x) => x.notice_title ?? x.name).sort()).toEqual(["2026학년도 부경 더채움 장학금", "동문회 장학금", "푸른등대 기부장학금 선발 안내"]);
    const school = (title: string) => notice(title, "2026-10-15", "2026-11-30", "부경대학교");
    const out2 = logic.merge([item("부경대학교", "동문회 장학금", "2026-10-01", "2026-11-30")], [school("부경대학교 더채움 장학금 안내"), school("부경대학교 푸른등대 기부장학금 안내")]);
    expect([out2.length, out2[0]!.notice_url]).toEqual([3, undefined]);
    const r1 = { ...school("2026년 부산지역인재 장학금 생활장학금 신청 공고"), end: "2026-10-28" };
    const r2 = { ...school("부산광역시청 부산지역인재 장학금 추가 안내"), end: "2026-10-28" };
    const out3 = logic.merge([item("부산광역시청", "부산지역인재 장학금", "2026-10-14", "2026-10-28")], [r1, r2]);
    expect([out3.length, out3[0]!.notice_url]).toEqual([2, r1.url]);
  });
});

// 서버에 붙은 모습 그대로: 저장, 알림, /api/scholarship
function makeApp(now: { t: Date }) {
  const dir = mkdtempSync(join(tmpdir(), "sch-"));
  dirs.push(dir);
  const db = openDb(join(dir, "folio.db"));
  const sent: { title: string; body: string; url: string }[] = [];
  const s = createScholarship({ db, dataDir: dir, now: () => now.t, deliver: async (n) => void sent.push(n) });
  return { s, sent, db, dir };
}
const at = (day: string, hour = 10) => new Date(`${day}T${String(hour).padStart(2, "0")}:00:00+09:00`);
const call = async (s: ReturnType<typeof createScholarship>, path: string, init: RequestInit & { json?: unknown } = {}) => {
  const req = new Request(`http://x/api/scholarship${path}`, { ...init, body: init.json === undefined ? undefined : JSON.stringify(init.json) });
  const res = await s.api(req, new URL(req.url));
  return { status: res.status, body: (await res.json()) as any };
};

describe("알림", () => {
  test("기준선, 내 조건 묶음, 마감 D-7·D-1, 관심 새 회차, 밤에는 아침까지", async () => {
    const now = { t: at(TODAY) };
    const { s, sent } = makeApp(now);
    const old = item("전국재단", "있던 것", "2026-10-01", "2026-11-30");
    s.replaceBase([old]);
    expect(await s.check(at(TODAY))).toEqual([]); // 첫 확인은 기준선만
    expect(await s.check(at(TODAY))).toEqual([]);

    s.update({ profile: { ...s.state().profile, regions: "부산" } });
    const fresh = item("전국재단2", "새 장학", "2026-11-01", "2026-11-20");
    const other = item("서대문구청", "구 장학", "2026-11-01", "2026-11-20", { category: "지역연고", region: "○ 서대문구 거주" });
    s.replaceBase([old, fresh, other, item("전국재단3", "끝난 것", "2026-10-01", "2026-10-20")]);
    expect(await s.check(at(TODAY))).toEqual(["new"]);
    expect(sent.at(-1)!.title).toBe("내 조건에 맞는 새 장학금 1건");
    expect(sent.at(-1)!.url).toBe("/admin#scholarship");
    expect(await s.check(at(TODAY))).toEqual([]);

    s.update({ stars: [fresh.series] });
    expect(await s.check(at(TODAY))).toEqual([]); // D-17
    expect(await s.check(at("2026-11-13"))).toEqual(["due"]); // D-7
    expect(await s.check(at("2026-11-14"))).toEqual([]);
    expect(await s.check(at("2026-11-19"))).toEqual(["due"]); // 며칠 건너뛰면 가장 가까운 것 하나만
    expect(sent.at(-1)!.title).toBe("관심 장학금 마감 D-1");
    expect(await s.check(at("2026-11-20"))).toEqual([]);

    s.update({ stars: [fresh.series, other.series] });
    const next = item("서대문구청", "구 장학", "2027-02-01", "2027-02-20", { category: "지역연고", region: "○ 서대문구 거주" });
    s.replaceBase([old, fresh, other, next]);
    expect(await s.check(at("2026-11-21"))).toEqual(["star_new"]); // 관심 장학금 새 회차는 내 조건 밖이어도

    s.replaceBase([old, fresh, next, item("전국재단4", "밤에 올라옴", "2026-11-21", "2026-12-20")]);
    expect(await s.check(at("2026-11-21", 23))).toEqual([]);
    expect(await s.check(at("2026-11-22", 8))).toEqual(["new"]);
  });
});

describe("/api/scholarship", () => {
  test("내 조건·관심·목록·상세·출처", async () => {
    const now = { t: at(TODAY) };
    const { s } = makeApp(now);
    const busan = item("부산장학회", "부산 인재", "2026-10-20", "2026-11-10", { category: "지역연고", region: "○ 부산 1년 이상 거주", support: "○ 생활비 100만원" });
    const seoul = item("서대문구청", "구 장학", "2026-11-01", "2026-11-20", { category: "지역연고", region: "○ 서대문구 거주", support: "○ 생활비 50만원" });
    const closed = item("전국재단", "끝난 것", "2026-10-01", "2026-10-20");
    s.replaceBase([busan, seoul, closed]);

    expect((await call(s, "/profile", { method: "PATCH", json: { purpose: "nope" } })).status).toBe(400);
    const p = await call(s, "/profile", { method: "PATCH", json: { regions: " 부산 ", purpose: "living" } });
    expect(p.body).toEqual({ regions: "부산", level: "", school: "", field: "", purpose: "living", exclude_loans: true });

    let r = await call(s, "/items?view=open");
    expect(r.body.items.map((x: Item) => x.name)).toEqual(["부산 인재"]);
    expect(r.body.counts).toMatchObject({ open: 1, closed: 0, starred: 0 });
    expect(r.body.items[0]).toMatchObject({ status: "open", dday: 7, mine: true, purpose: "living", regional: true, support: "생활비 100만원" });
    r = await call(s, "/items?view=open&mine=false");
    expect(r.body.items.map((x: Item) => x.name)).toEqual(["부산 인재", "구 장학"]);
    expect((await call(s, "/items?view=all&mine=false&q=서대문")).body.items.map((x: Item) => x.name)).toEqual(["구 장학"]);
    expect((await call(s, "/items?view=bad")).status).toBe(400);

    // 관심은 조건 밖이어도 보이고, 상세에는 원문 칸이 다 있다
    expect((await call(s, "/stars/000000000000", { method: "PUT", json: { on: true } })).status).toBe(404);
    expect((await call(s, `/stars/${seoul.series}`, { method: "PUT", json: { on: true } })).body.stars).toEqual([seoul.series]);
    r = await call(s, "/items?view=starred");
    expect(r.body.items.map((x: Item) => [x.name, x.starred, x.mine])).toEqual([["구 장학", true, false]]);
    const d = await call(s, `/items/${busan.id}`);
    expect(d.body).toMatchObject({ name: "부산 인재", region: "○ 부산 1년 이상 거주", support: "○ 생활비 100만원", rounds: [{ id: busan.id, start: "2026-10-20", end: "2026-11-10" }] });

    // 설정: 마감 며칠 전은 0~60일, 큰 것부터
    expect((await call(s, "/settings", { method: "PATCH", json: { reminder_days: [1, 3, 99, 3, -1], notify_new: false } })).body).toEqual({ notify_new: false, notify_starred: true, reminder_days: [3, 1] });

    // 출처: 끄기, 직접 더한 것만 지우기, 내부망 주소는 거절
    const src = await call(s, "/sources");
    expect(src.body.sources.length).toBe(boards.BOARDS.length);
    r = await call(s, "/sources/ksce_news", { method: "PATCH", json: { enabled: false } });
    expect(r.body.sources.find((x: any) => x.id === "ksce_news").enabled).toBe(false);
    expect((await call(s, "/sources/ksce_news", { method: "DELETE" })).status).toBe(400);
    r = await call(s, "/sources", { method: "POST", json: { url: "http://127.0.0.1:2992/" } });
    expect([r.status, r.body.error]).toEqual([400, "내부망 주소는 넣을 수 없습니다"]);

    const st = await call(s, "/status");
    expect(st.body).toMatchObject({ count: 3, open: 2, stars: 1 }); // open: 조건과 상관없이 지금 받는 것
  });

  test("다시 모으기: 한쪽이 실패해도 나머지는 남기고, 이번에 못 본 공고도 지우지 않는다", async () => {
    const now = { t: at(TODAY) };
    const dir = mkdtempSync(join(tmpdir(), "sch-"));
    dirs.push(dir);
    const notice = (title: string, end: string, sid = "pknu_civil") => ({ ...item("부경대학교 토목공학과", title, "2026-10-01", end), notice_title: title, source_id: sid, source: "부경대 토목공학과", school_board: true, posted: "2026-10-01" });
    let boardRun: Item[] = [notice("더채움 장학금", "2026-12-31"), notice("우양 공고", "2026-11-20", "wooyang")];
    const s = createScholarship({
      db: openDb(join(dir, "folio.db")), dataDir: dir, now: () => now.t, deliver: async () => {},
      fetchers: {
        csv: async () => ({ meta: { file_id: "F1", file_sn: "1", name: "x_20261014", updated: "" }, items: [item("재단", "장학금", "2026-10-01", "2026-11-30")] }),
        portal: async () => { throw new Error("한국장학재단 포털 응답을 읽지 못했습니다: HTTP 500"); },
        dreamspon: async () => [],
        boards: async (list) => boardRun.filter((it) => list.some((b) => b.id === it.source_id)),
      },
    });
    let r = await call(s, "/sync", { method: "POST" });
    expect([r.status, r.body.syncing]).toEqual([202, true]); // 기다리지 않고 바로 답한다
    await s.sync(); // 돌고 있는 것을 같이 기다린다
    await s.syncExtra();
    r = await call(s, "/status");
    expect(r.body).toMatchObject({ count: 3, syncing: false, extra_error: "한국장학재단 포털 응답을 읽지 못했습니다: HTTP 500" });
    // 게시판 첫 쪽에서 밀려나 이번엔 못 봤어도 남기고, 끈 게시판(우양) 것만 뺀다
    await call(s, "/sources/wooyang", { method: "PATCH", json: { enabled: false } });
    boardRun = [];
    expect((await call(s, "/sources/refresh", { method: "POST" })).status).toBe(202);
    await s.syncExtra();
    expect(s.items().map((x) => x.name).sort()).toEqual(["더채움 장학금", "장학금"]);
  });
});

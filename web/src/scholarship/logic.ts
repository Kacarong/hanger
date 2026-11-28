// 판정 로직 — 네트워크·파일 없이 돌아가는 순수 함수만 둔다(테스트 대상).
// 모집 상태와 D-day, 내 조건에 맞는지, 작년 일정 참고, 출처 합치기, 보낼 알림 고르기.
import * as regions from "./regions";
import { days, parseDate, plusYear, addDays, type Item } from "./util";

export const OPEN_TOKENS = new Set(["제한없음", "해당없음"]);
export const LEVELS = ["신입생", "재학생", "대학원"];

export type Profile = {
  regions: string; // 쉼표로 구분한 지역 낱말 — "부산, 해운대구"
  level: string; // "" | 신입생 | 재학생 | 대학원
  school: string; // "" | SCHOOL_VOCAB 중 하나
  field: string; // "" | FIELD_VOCAB 중 하나
  purpose: string; // "" | living(생활비라고 적힌 것만) | no_tuition(등록금 전용만 빼기)
  exclude_loans: boolean; // 학자금 대출·대출이자 지원은 장학금이 아니다
};

// 지역 칸이 이렇게만 적혀 있으면 지역 조건이 없는 것으로 본다
const NO_REGION = /^\s*(해당없음|제한없음|※\s*기관\s*확인\s*필요)?\s*$/;

// 공고 기간이 이만큼 길면 '신청 기간' 이 아니라 사업 기간일 때가 많다(국가근로장학금 3/1~다음 해 2/28).
// 이런 건 '신청 가능' 으로 단정하지 않고 '연중 사업' 으로 따로 보여 준다.
export const YEAR_ROUND_DAYS = 300;

export type Status = "upcoming" | "open" | "year_round" | "closed" | "unknown";

// unknown: 마감일을 모른다(본문이 이미지뿐인 게시판 공고 등). '신청 가능' 에도 알림에도 넣지 않는다.
export function status(item: Item, today: string): Status {
  const start = parseDate(item.start), end = parseDate(item.end);
  if (!end) return "unknown";
  if (start && today < start) return "upcoming";
  if (today > end) return "closed";
  if (start && days(start, end) >= YEAR_ROUND_DAYS) return "year_round";
  return "open";
}

export function dday(item: Item, today: string): number | null {
  const end = parseDate(item.end);
  return end ? days(today, end) : null;
}

// ---------------- 내 조건 ----------------
export function regionWords(profile: Partial<Profile>): string[] {
  return (profile.regions || "").split(/[,\s]+/).map((w) => w.trim()).filter(Boolean);
}

// 자격 칸에서 지역 조건으로 읽을 문장 — 지명 옆에 이런 말이 있어야 한다
const RESIDENCY = /소재|거주|주민등록|시민|도민|군민|구민|출신|관내|주소/;

const union = <T>(a: Set<T>, b: Iterable<T>) => {
  for (const x of b) a.add(x);
  return a;
};
const meets = <T>(a: Set<T>, b: Set<T>) => [...a].some((x) => b.has(x));

// '서울 소재 대학 재학생' 처럼 지역 조건을 자격 칸에 적은 공고가 꽤 있다.
function specialPlaces(item: Item): [Set<string>, Set<string>] {
  const sido = new Set<string>(), sigungu = new Set<string>();
  for (const line of (item.special || "").split("\n")) {
    if (RESIDENCY.test(line)) {
      const [a, b] = regions.find(line);
      union(sido, a);
      union(sigungu, b);
    }
  }
  return [sido, sigungu];
}

// 장학금의 거주 조건 → [종류, 시·도, 시·군·구]. national(지역 무관) / places(어디인지 앎) / unknown(어디인지 모름).
// 읽는 순서: 지역 칸 → (전국이라고 적혀 있으면 지역 무관) → 자격 칸의 '○○ 소재·거주' → 기관명.
// 기관명은 지역 칸에 조건이 있거나 유형이 지역연고일 때만 본다('부산은행 장학재단' 이 전국을 뽑을 수 있다).
export function place(item: Item): ["national" | "places" | "unknown", Set<string>, Set<string>] {
  const text: string = item.region || "";
  const regional = item.category === "지역연고" || !NO_REGION.test(text);
  const [orgSido, orgSigungu] = regions.find(item.org || "");
  let [sido, sigungu] = regions.find(text);
  if (sido.size || sigungu.size) {
    if (!sido.size) sido = new Set(orgSido); // '동구 관내 거주' + '(재)대구동구교육재단'
  } else if (text.includes("전국")) {
    return ["national", new Set(), new Set()];
  } else {
    [sido, sigungu] = specialPlaces(item);
    if (!sido.size && !sigungu.size && regional) [sido, sigungu] = [orgSido, orgSigungu];
  }
  union(sido, regions.sidoOf(sigungu));
  if (sido.size || sigungu.size) return ["places", sido, sigungu];
  return [regional ? "unknown" : "national", new Set(), new Set()];
}

export const isRegional = (item: Item) => place(item)[0] !== "national";

// ok(내 지역) / no(다른 지역) / unknown(지역 장학금인데 판단 못 함) / na(지역 무관·지역 미입력).
export function regionVerdict(profile: Partial<Profile>, item: Item): "ok" | "no" | "unknown" | "na" {
  const words = regionWords(profile);
  const [kind, sido, sigungu] = place(item);
  if (!words.length || kind === "national") return "na";

  const mySido = new Set<string>(), mySigungu = new Set<string>();
  const free: string[] = [];
  for (const w of words) {
    const [level, value] = regions.classifyWord(w);
    if (level === "sido") mySido.add(value);
    else if (level === "sigungu") mySigungu.add(value);
    else free.push(value);
  }
  union(mySido, regions.sidoOf(mySigungu));

  const hay = `${item.org ?? ""} ${item.region ?? ""}`;
  if (free.some((w) => hay.includes(w))) return "ok";
  if (kind === "unknown") {
    // '횡성에 주소' 처럼 시·군을 줄여 적은 공고는 내 시·군 이름 앞부분으로 한 번 더 본다.
    const stems = [...mySigungu].filter((n) => (n.endsWith("시") || n.endsWith("군")) && n.length >= 3).map((n) => n.slice(0, -1));
    return stems.some((st) => hay.includes(st)) ? "ok" : "unknown";
  }
  // 공고가 적은 단계마다 내 것과 맞아야 한다. '부산 수영구' 는 '부산, 해운대구' 와 안 맞는다.
  if (sido.size && mySido.size && !meets(sido, mySido)) return "no";
  if (sigungu.size && mySigungu.size && !meets(sigungu, mySigungu)) return "no";
  if (meets(sido, mySido) || meets(sigungu, mySigungu)) return "ok";
  return "unknown";
}

function levelOk(level: string, grades: string[]): boolean {
  if (!level || !grades.length || grades.some((g) => OPEN_TOKENS.has(g)) || grades.every((g) => g === "연령제한")) return true;
  if (level === "신입생") return grades.includes("대학신입생");
  if (level === "재학생") return grades.some((g) => g.startsWith("대학") && g.endsWith("학기") || g.startsWith("대학") && g.endsWith("학기이상"));
  if (level === "대학원") return grades.some((g) => g.startsWith("석사") || g.startsWith("박사"));
  return true;
}

// 학교·계열. '특정대학/특정학과' 는 우리가 판단할 수 없으니 통과시킨다.
function pickOk(choice: string, tokens: string[], unknown: string): boolean {
  if (!choice || !tokens.length) return true;
  return tokens.includes(choice) || tokens.some((t) => OPEN_TOKENS.has(t) || t === unknown);
}

// ---------------- 지원 용도 / 대출 ----------------
// 지원 내용에 이런 말이 있으면 생활비로 쓰는 돈이다. 근로·멘토링 장학금은 시급으로 받는다.
const LIVING_SRC =
  "생활비|생활\\s*장학|생활\\s*지원|생활안정|생활보조|생활자금|생계|주거|월세|교통비|자기계발|도서구입" +
  "|학업장려|학업보조|학습장려|장려금|활동비|활동지원금|시급";
const LIVING = new RegExp(LIVING_SRC);
const TUITION = /등록금|수업료|입학금|학비/;
const LOAN = /대출|대부|융자/;
// '생활비 지원 불가', '생활비는 제외' 처럼 부정하는 말은 생활비로 세지 않는다
const NEGATED = new RegExp(`(?:${LIVING_SRC})[^○※\\n]{0,12}?(?:불가|제외|미지원|불포함|지원\\s*안|지원하지\\s*않|해당\\s*없|아님)`, "g");

// living(생활비가 들어 있음) / tuition(등록금 전용) / unclear(금액만 적힘).
// 지원 내용을 기준으로 본다. 이름('학업장려 장학금')은 지원 내용에 용도가 전혀 안 적혀 있을 때만 본다.
export function purpose(item: Item): "living" | "tuition" | "unclear" {
  const support = (item.support || "").replace(NEGATED, " ");
  if (LIVING.test(support)) return "living";
  if (TUITION.test(support)) return "tuition";
  const name = (item.name || "").replace(NEGATED, " ");
  if (LIVING.test(name)) return "living";
  if (TUITION.test(name)) return "tuition";
  return "unclear";
}

// 한국장학재단은 대출·대출이자 지원을 상품구분 '학자금' 으로 따로 둔다.
export const isLoan = (item: Item) => item.product === "학자금" || LOAN.test(item.name || "");

function purposeOk(choice: string, item: Item): boolean {
  if (choice === "living") return purpose(item) === "living";
  if (choice === "no_tuition") return purpose(item) !== "tuition";
  return true;
}

// 대출·지원 용도는 사용자가 '이건 아예 안 받겠다' 고 정한 것이다. 관심 표시와 상관없이 목록에서도 알림에서도 뺀다.
export function excluded(profile: Partial<Profile>, item: Item): boolean {
  if ((profile.exclude_loans ?? true) && isLoan(item)) return true;
  return !purposeOk(profile.purpose ?? "", item);
}

// 내 조건에 맞는가. 지역은 내 지역이거나 전국인 것만 — 어느 읍·면 것인지 모르는 장학금은 뺀다.
export function matches(profile: Partial<Profile>, item: Item): boolean {
  if (excluded(profile, item)) return false;
  const r = regionVerdict(profile, item);
  if (r === "no" || r === "unknown") return false;
  return (
    levelOk(profile.level ?? "", item.grades ?? []) &&
    pickOk(profile.school ?? "", item.schools ?? [], "특정대학") &&
    pickOk(profile.field ?? "", item.fields ?? [], "특정학과")
  );
}

// ---------------- 출처 합치기 ----------------
const ORG_NOISE = /\(\s*(?:재|사|주)\s*\)|재단법인|사단법인|주식회사|\s+/g;

// '(재)엔지니어링인재육성재단' → '엔지니어링인재육성재단'. 출처끼리 같은 기관인지 볼 때 쓴다.
export const orgCore = (org: string) => (org || "").replace(ORG_NOISE, "");
const nospace = (s: string) => (s || "").replace(/\s+/g, "");

// CSV 목록에 포털·게시판에서 모은 것을 더한다. 이미 있는 장학금은 다시 넣지 않는다.
// - 같은 회차(id)거나, 같은 장학금(series)에 마감일이 같으면 이미 있는 것.
// - 드림스폰(aggregator)은 같은 장학금(마감일이 같고 기관·이름이 맞음)이 이미 있으면 버린다.
// - 게시판 공고는 이름이 공고 제목이다. 그 기관의 장학금이 하나뿐이면 그 장학금의 새 회차로 붙인다.
//   기관이 같고 마감일까지 같으면 같은 공고로 보고, 원래 항목에 공고 원문 주소만 붙인다.
export function merge(base: Item[], extras: Item[]): Item[] {
  const out = [...base];
  // 기관 → 그 기관의 장학금들. 하나뿐이면 게시판 공고를 그 장학금의 새 회차로 본다.
  const seriesOf = new Map<string, Map<string, string>>(); // org core → series → name
  for (const it of base) {
    const k = orgCore(it.org ?? "");
    (seriesOf.get(k) ?? seriesOf.set(k, new Map()).get(k)!).set(`${it.series}\u0000${it.name}`, it.name);
  }
  const onlyOf = (org: string): [string, string] | null => {
    const m = seriesOf.get(orgCore(org));
    if (!m || m.size !== 1) return null;
    const [k, name] = [...m][0]!;
    return [k.split("\u0000")[0]!, name];
  };
  const ids = new Set(out.map((it) => it.id));
  const rounds = new Set(out.map((it) => `${it.series}|${it.end ?? ""}`));
  // 공고와 견줄 대상은 구조화된 자료(CSV·포털)뿐이다. 게시판 공고끼리는 합치지 않는다.
  const byOrgEnd = new Map<string, number>();
  const byEnd = new Map<string, number[]>();
  const index = (i: number, it: Item) => {
    if (it.notice_title && it.source_id) return;
    const k = `${orgCore(it.org ?? "")}|${it.end ?? ""}`;
    if (!byOrgEnd.has(k)) byOrgEnd.set(k, i);
    const e = it.end ?? "";
    (byEnd.get(e) ?? byEnd.set(e, []).get(e)!).push(i);
  };
  out.forEach((it, i) => index(i, it));
  const attached = new Set<number>(); // 이번 병합에서 이미 공고가 붙은 항목

  // 이미 있는 장학금을 다시 알린 공고인가.
  // - 재단·학회 게시판: 기관과 마감일이 같으면 같은 공고.
  // - 학교 게시판은 기관이 늘 학교라 기관으로는 못 가린다. 마감이 같고 제목에 원래 장학금 이름이나 기관명이 있어야 같은 공고.
  const sameNotice = (it: Item): number | null => {
    if (!it.end) return null;
    const mine = orgCore(it.org ?? "");
    if (!it.school_board) {
      const hit = byOrgEnd.get(`${mine}|${it.end}`);
      if (hit !== undefined && !attached.has(hit)) return hit;
    }
    const title = nospace(it.notice_title ?? "");
    for (const i of byEnd.get(it.end) ?? []) {
      if (attached.has(i)) continue; // 한 장학금에는 공고 하나만
      const name = nospace(out[i]!.name ?? ""), org = orgCore(out[i]!.org ?? "");
      if (name.length >= 5 && title.includes(name)) return i;
      // 기관명으로 보는 건 학교가 '다른' 기관의 공고를 다시 올렸을 때만.
      if (org !== mine && org.length >= 4 && title.includes(org)) return i;
    }
    return null;
  };
  // 포털(구조화된 자료)을 게시판보다 먼저 — 같은 공고면 포털 쪽을 남긴다. 드림스폰은 맨 끝에, 아무 데도 없는 것만.
  const order = (x: Item) => (x.aggregator ? 2 : 0) + (x.notice_title ? 1 : 0);
  for (let it of [...extras].sort((a, b) => order(a) - order(b))) {
    if (it.aggregator) {
      if (out.some((o) => sameScholarship(it, o))) continue;
      const only = onlyOf(it.org ?? "");
      // 그 기관의 장학금이 하나이고 이름이 어긋나지 않으면 그 장학금의 새 회차로(☆ 가 이어진다). 이름은 드림스폰 것을 그대로 둔다.
      if (only && namesMatch(it.name ?? "", it.org ?? "", only[1], it.org ?? "")) it = { ...it, series: only[0] };
      const r = `${it.series}|${it.end ?? ""}`;
      if (!rounds.has(r)) {
        out.push(it);
        rounds.add(r);
      }
      continue;
    }
    if (ids.has(it.id)) continue;
    const hit = it.notice_title ? sameNotice(it) : null;
    if (hit !== null) {
      attached.add(hit);
      out[hit] = { ...out[hit]!, notice_url: it.url, notice_title: it.notice_title, period_from: it.period_from ?? "" };
      continue;
    }
    const only = onlyOf(it.org ?? "");
    if (it.notice_title && !it.school_board && only) it = { ...it, series: only[0], name: only[1] };
    const r = `${it.series}|${it.end ?? ""}`;
    if (rounds.has(r)) continue;
    out.push(it);
    ids.add(it.id);
    rounds.add(r);
    index(out.length - 1, it);
  }
  return out;
}

// 괄호 안이 연도·학기·회차·마감뿐일 때만 지운다 — '(2027년)', '(2026년 2학기)', '(2차)', '(~11.12.)'.
const DATE_PAREN = /\((?:\s*(?:\d+\s*(?:년도?|학년도|학기|차)|[~.\d\s]+|하반기|상반기)\s*)+\)/g;
// 장학금을 가르지 못하는 낱말. 지원 용도(생활비·등록금)나 고유명은 지우지 않는다.
const GENERIC_NAME = /\d+\s*(?:년도?|학년도|학기|차)|장학금|장학생|장학|모집|선발|공고|안내|신규|대학생|하반기|상반기|도내|시내|군내|구내|관내|[()\[\]·,\s]+/g;
const ORG_SUFFIX = /(?:인재육성재단|장학재단|장학회|장학관|교육재단|재단|학회|협회|진흥원|공제조합)$/;

// 이름에서 기관명·연도·'장학' 같은 낱말을 뺀 나머지. 기관명은 '경상남도장학회' 와 앞부분 '경상남도' 둘 다 뺀다.
function nameCore(name: string, org: string): string {
  let n = nospace(name).replace(DATE_PAREN, "");
  const core = orgCore(org);
  const stem = core.replace(ORG_SUFFIX, ""); // '한국장학재단' → '한국' 처럼 너무 짧은 앞부분은 쓰지 않는다
  const parts = [...new Set([nospace(org), core, stem.length >= 3 ? stem : ""])].sort((a, b) => b.length - a.length);
  for (const o of parts) if (o.length >= 2) n = n.replaceAll(o, "");
  return n.replace(GENERIC_NAME, "");
}

// 같은 기관의 두 이름이 같은 장학금인가. 한쪽이 기관명·'장학' 같은 낱말뿐이거나 한쪽이 다른 쪽에 통째로 들어 있을 때만.
// 양쪽에 서로 다른 말이 남으면(생활비↔등록금, 키움증권↔한국가스공사) 다른 장학금 — 애매하면 둘 다 남긴다.
function namesMatch(a: string, aOrg: string, b: string, bOrg: string): boolean {
  const ca = nameCore(a, aOrg), cb = nameCore(b, bOrg);
  return !ca || !cb || cb.includes(ca) || ca.includes(cb);
}

// 드림스폰 항목이 이미 있는 장학금과 같은가. 마감일이 같아야 하고, 같은 기관이면 이름도 맞아야 한다.
// 기관이 달라도(학교가 다시 올린 공고) 드림스폰 이름이 상대 제목에 통째로 들어 있으면 같은 것.
function sameScholarship(agg: Item, other: Item): boolean {
  if (!agg.end || agg.end !== other.end) return false;
  const title: string = other.notice_title || other.name || "";
  if (orgCore(agg.org ?? "") === orgCore(other.org ?? "")) return namesMatch(agg.name ?? "", agg.org ?? "", title, other.org ?? "");
  const core = nospace(agg.name ?? "").replace(DATE_PAREN, "");
  return core.length >= 5 && nospace(title).includes(core);
}

// ---------------- 작년 일정 참고 (올해 모집 미확인) ----------------
// 장학금(series)마다 가장 최근 회차.
export function latestRounds(items: Iterable<Item>): Map<string, Item> {
  const latest = new Map<string, Item>();
  for (const it of items) {
    const cur = latest.get(it.series);
    if (!cur || (it.start ?? "") > (cur.start ?? "")) latest.set(it.series, it);
  }
  return latest;
}

// 작년 일정으로 본 장학금(올해 회차는 아직 목록에 없는 것). 둘 다 올해 모집이 확인된 것은 아니다.
//   - 앞으로 horizon 일 안에 시작할 것 (started=false)
//   - 작년 기준이면 최근 lookback 일 안에 이미 시작했을 것 (started=true) — '올해 공고 확인 필요'
export function forecast(items: Iterable<Item>, today: string, horizon = 60, lookback = 45): Item[] {
  const out: Item[] = [];
  for (const it of latestRounds(items).values()) {
    const start = parseDate(it.start), end = parseDate(it.end);
    if (!start || !end || end >= today) continue; // 지금 회차가 살아 있거나 날짜가 없다
    if (days(start, today) < 300) continue; // 올해 회차가 이미 끝난 것 — 다음은 내년
    const expStart = plusYear(start), expEnd = plusYear(end);
    if (expStart <= addDays(today, -lookback) || expStart > addDays(today, horizon)) continue;
    out.push({ ...it, expected_start: expStart, expected_end: expEnd, started: expStart <= today });
  }
  // 앞으로 열릴 것을 먼저(빠른 순), 이미 시작했을 것은 뒤에(최근에 시작했을 것부터)
  const ahead = out.filter((x) => !x.started).sort((a, b) => cmp(a.expected_start, b.expected_start));
  const behind = out.filter((x) => x.started).sort((a, b) => cmp(b.expected_start, a.expected_start));
  return [...ahead, ...behind];
}

// 최근 마감된 회차 — 지난 공고도 남겨 두어 내년 일정을 가늠하게 한다(최근 마감 순).
export function recentlyClosed(items: Iterable<Item>, today: string, keep = 180): Item[] {
  const rows: Item[] = [];
  for (const it of items) {
    const end = parseDate(it.end);
    if (end && end < today && days(end, today) <= keep && status(it, today) === "closed") rows.push(it);
  }
  return rows.sort((a, b) => cmp(b.end, a.end));
}

export const cmp = (a: unknown, b: unknown) => {
  const x = String(a ?? ""), y = String(b ?? "");
  return x < y ? -1 : x > y ? 1 : 0;
};

// ---------------- 알림 고르기 ----------------
export type NotifyPrefs = { notify_new: boolean; notify_starred: boolean; reminder_days: number[] };
export type Plan = { kind: "star_new" | "new" | "due"; keys: string[]; items: Item[]; dday?: number };

// 보낼 알림 목록.
// - star_new: 관심 장학금에 새 회차가 올라왔다(지역·학년 조건과 상관없이, 단 대출·지원 용도로 뺀 것은 관심이어도 안 보냄)
// - new: 내 조건에 맞는 새 장학금 묶음(한 번에 하나)
// - due: 관심 장학금 마감 임박
// keys 는 보낸 뒤 sent 에 넣어 다시 보내지 않게 하는 표식이다.
export function planNotifications(
  items: Item[],
  o: { profile: Partial<Profile>; settings: Partial<NotifyPrefs>; stars: string[]; knownIds: Set<string>; sent: Set<string>; today: string },
): Plan[] {
  const { profile, settings, today, sent } = o;
  const starSet = new Set(o.stars);
  const out: Plan[] = [];
  // 마감을 모르는 공고(unknown)는 알리지 않는다 — 이미 끝났을 수 있다
  const live = items.filter((it) => !["closed", "unknown"].includes(status(it, today)) && !excluded(profile, it));
  const fresh = live.filter((it) => !o.knownIds.has(it.id));

  let starredNew: Item[] = [];
  if (settings.notify_starred ?? true) {
    starredNew = fresh.filter((it) => starSet.has(it.series) && !sent.has(`star_new:${it.id}`));
    for (const it of starredNew) out.push({ kind: "star_new", keys: [`star_new:${it.id}`], items: [it] });
  }
  if (settings.notify_new ?? true) {
    const taken = new Set(starredNew.map((it) => it.id));
    const batch = fresh.filter((it) => !taken.has(it.id) && !sent.has(`new:${it.id}`) && matches(profile, it));
    if (batch.length) {
      batch.sort((a, b) => cmp(a.end, b.end));
      out.push({ kind: "new", keys: batch.map((it) => `new:${it.id}`), items: batch });
    }
  }
  if (settings.notify_starred ?? true) {
    const thresholds = [...new Set((settings.reminder_days ?? []).map(Math.trunc).filter((d) => d >= 0))].sort((a, b) => a - b);
    for (const it of live) {
      if (!starSet.has(it.series) || status(it, today) !== "open") continue;
      const left = dday(it, today);
      const hit = thresholds.filter((t) => left !== null && left <= t);
      if (!hit.length) continue;
      if (sent.has(`due:${it.id}:${hit[0]}`)) continue;
      // 며칠 건너뛰었으면 가장 가까운 것 하나만 보내고 큰 것들은 같이 지운다.
      out.push({ kind: "due", keys: hit.map((t) => `due:${it.id}:${t}`), items: [it], dday: left! });
    }
  }
  return out;
}

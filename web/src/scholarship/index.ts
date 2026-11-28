// 장학금 — 대학생 장학금 모음 + 관심 장학금 마감·새 회차 알림. (unifi-site 의 '장학금 알리미' 를 옮겨 온 것)
//
// 모으는 곳: 공공데이터포털 '한국장학재단_학자금지원정보(대학생)' CSV(월 1회), 한국장학재단 실시간 포털, 드림스폰,
// 공고 게시판(학회·재단·부경대·부산 구·군 장학회). 내 조건(지역·과정·학교·계열·지원 용도)으로 거르고, ☆ 한 장학금은
// 마감이 다가오거나 다음 모집이 올라오면 이 사이트의 알림(폰·PC)으로 알려 준다.
//
// 저장: 목록(크고 다시 받을 수 있음)은 DATA_DIR/scholarship/*.json, 내 조건·관심·알림 기록은 DB settings 'scholarship'.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Db } from "../db";
import * as boards from "./boards";
import * as dreamspon from "./dreamspon";
import * as kosaf from "./kosaf";
import * as logic from "./logic";
import * as source from "./source";
import { addDays, days, parseDate, type Item } from "./util";

const SYNC_EVERY_MS = 6 * 3600_000; // CSV 는 6시간마다 파일 번호만 보고 바뀌었을 때만 받는다
const EXTRA_EVERY_MS = 6 * 3600_000; // 포털·드림스폰·게시판도 6시간마다
const QUIET_HOURS = [22, 8]; // 22시부터 다음날 8시 전까지는 알리지 않고 아침에 보낸다
const KEEP_DAYS = 180; // 모아 둔 공고는 마감이 이만큼 지날 때까지 남긴다('최근 마감' 탭과 같은 기간)
const MAX_SENT = 2000;
const VIEWS = ["open", "year_round", "soon", "closed", "unknown", "starred", "all"] as const;
type View = (typeof VIEWS)[number];

export type State = {
  profile: logic.Profile;
  settings: logic.NotifyPrefs;
  stars: string[]; // series 목록
  known_ids: string[]; // 지금까지 본 회차 id — 새 장학금 판정용
  baselined: boolean;
  sent: string[]; // 이미 보낸 알림 표식
  meta: Partial<source.Meta>;
  last_sync_at: number; // ms
  last_error: string; // CSV 갱신 실패
  last_extra_at: number;
  extra_error: string;
  sources_off: string[];
  custom_sources: boards.CustomSource[];
  source_stats: Record<string, boards.Stat & { at: number }>;
  last_check_at: number;
};

const DEFAULT_PROFILE: logic.Profile = { regions: "", level: "", school: "", field: "", purpose: "", exclude_loans: true };
const DEFAULT_SETTINGS: logic.NotifyPrefs = { notify_new: true, notify_starred: true, reminder_days: [7, 3, 1] };

function blank(): State {
  return {
    profile: { ...DEFAULT_PROFILE },
    settings: { ...DEFAULT_SETTINGS },
    stars: [],
    known_ids: [],
    baselined: false,
    sent: [],
    meta: {},
    last_sync_at: 0,
    last_error: "",
    last_extra_at: 0,
    extra_error: "",
    sources_off: [],
    custom_sources: [],
    source_stats: {},
    last_check_at: 0,
  };
}

const seoul = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(d);
const seoulHour = (d: Date) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", hourCycle: "h23" }).format(d));

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

export type Deliver = (n: { title: string; body: string; url: string }) => Promise<unknown>;

export function createScholarship(opts: {
  db: Db;
  dataDir: string;
  now: () => Date;
  deliver: Deliver;
  // 테스트가 바꿔 끼운다
  fetchers?: Partial<{
    csv: (force: boolean, current: Partial<source.Meta>) => Promise<{ meta: source.Meta; items: Item[] | null }>;
    portal: (known: Set<string>, cache: Record<string, Item>, today: string) => Promise<Item[]>;
    dreamspon: (today: string) => Promise<Item[]>;
    boards: (list: boards.Board[], today: string, stats: Record<string, boards.Stat>) => Promise<Item[]>;
    probe: (url: string, today: string) => Promise<{ posts: number; scholarship: string[]; title: string }>;
  }>;
}) {
  const { db } = opts;
  const dir = join(opts.dataDir, "scholarship");
  mkdirSync(dir, { recursive: true });
  const file = (name: string) => join(dir, name);
  const today = () => seoul(opts.now());

  // ---------------- 저장 ----------------
  function state(): State {
    const s = blank();
    try {
      const loaded = JSON.parse(db.getSetting("scholarship") ?? "{}");
      Object.assign(s, loaded);
      s.profile = { ...DEFAULT_PROFILE, ...(loaded.profile ?? {}) };
      s.settings = { ...DEFAULT_SETTINGS, ...(loaded.settings ?? {}) };
    } catch {
      /* 깨졌으면 처음부터 */
    }
    return s;
  }
  function update(patch: Partial<State>) {
    db.setSetting("scholarship", JSON.stringify({ ...state(), ...patch }));
  }

  function readList<T>(name: string, empty: T): T {
    try {
      return JSON.parse(readFileSync(file(name), "utf8")) as T;
    } catch {
      return empty;
    }
  }
  function write(name: string, data: unknown) {
    writeFileSync(file(name) + ".tmp", JSON.stringify(data));
    renameSync(file(name) + ".tmp", file(name));
  }
  let base: Item[] | null = null; // CSV
  let extras: Item[] | null = null; // 포털·드림스폰·게시판에서 모은 것(합치기 전)
  let merged: Item[] | null = null;
  const baseItems = () => (base ??= readList<Item[]>("items.json", []));
  const extraItems = () => (extras ??= readList<Item[]>("extras.json", []));
  const items = () => (merged ??= logic.merge(baseItems(), extraItems()));
  function replaceBase(list: Item[]) {
    write("items.json", list);
    base = list;
    merged = null;
  }
  function replaceExtras(list: Item[]) {
    write("extras.json", list);
    extras = list;
    merged = null;
  }

  // ---------------- 원본 동기화 ----------------
  const csv =
    opts.fetchers?.csv ??
    (async (force: boolean, current: Partial<source.Meta>) => {
      const meta = await source.fetchMeta();
      const changed = force || meta.file_id !== current.file_id || !baseItems().length;
      return { meta, items: changed ? source.parse(await source.fetchCsv(meta)) : null };
    });

  // 파일 번호가 바뀌었을 때만 CSV 를 다시 받는다. force 면 무조건 받는다.
  async function sync(force = false) {
    try {
      const got = await csv(force, state().meta);
      if (got.items) replaceBase(got.items);
      update({ meta: got.meta, last_sync_at: opts.now().getTime(), last_error: "" });
      return { changed: !!got.items, count: items().length };
    } catch (e) {
      update({ last_error: String((e as Error).message), last_sync_at: opts.now().getTime() });
      throw e;
    }
  }

  function stillRelevant(it: Item, d: string): boolean {
    const end = parseDate(it.end);
    if (end) return days(end, d) <= KEEP_DAYS;
    const posted = parseDate(it.posted);
    return !!posted && days(posted, d) <= boards.RECENT_DAYS;
  }

  // 이번에 다시 못 본 공고도 지우지 않는다. 게시판 첫 쪽에서 밀려났거나, 사이트가 잠깐 안 열렸을 뿐이다. 다시 본 것은 새 내용으로.
  function keepPrevious(prev: Item[], fresh: Item[], d: string, allowed: (it: Item) => boolean = () => true): Item[] {
    const ids = new Set(fresh.map((it) => it.id));
    return [...fresh, ...prev.filter((it) => !ids.has(it.id) && allowed(it) && stillRelevant(it, d))];
  }

  // CSV 에 아직 없는 장학금을 포털·드림스폰·게시판에서 모은다. 한쪽이 실패해도 다른 쪽은 남긴다.
  async function syncExtra() {
    const d = today();
    const known = new Set(baseItems().map((it) => `${it.org}|${it.name}|${it.end ?? ""}`));
    const errors: string[] = [];
    const prev = extraItems();
    const prevDream = prev.filter((it) => it.aggregator);
    const prevPortal = prev.filter((it) => !it.notice_title && !it.aggregator);
    const prevNotices = prev.filter((it) => it.notice_title);

    const cache = readList<Record<string, Item>>("kosaf_cache.json", {});
    let portal: Item[] = [];
    try {
      portal = await (opts.fetchers?.portal ?? kosaf.collect)(known, cache, d);
      // 캐시는 최근 것만 남긴다 — 마감이 오래 지난 것은 다시 볼 일이 없다
      const cutoff = addDays(d, -KEEP_DAYS);
      write("kosaf_cache.json", Object.fromEntries(Object.entries(cache).filter(([, v]) => (v.end || "9") >= cutoff)));
    } catch (e) {
      errors.push(String((e as Error).message));
    }
    portal = keepPrevious(prevPortal, portal, d);

    let dream: Item[] = [];
    try {
      dream = await (opts.fetchers?.dreamspon ?? dreamspon.collect)(d);
    } catch (e) {
      errors.push(String((e as Error).message));
    }
    dream = keepPrevious(prevDream, dream, d);

    const s = state();
    const all = boards.allSources(s);
    const active = all.filter((b) => b.enabled);
    const activeIds = new Set(active.map((b) => b.id));
    const labelToId = new Map(all.map((b) => [b.label, b.id]));
    // 끄거나 지운 게시판의 공고, 초·중·고 전용으로 판정된 공고는 남기지 않는다
    const fromActive = (it: Item) => activeIds.has(it.source_id || labelToId.get(it.source)) && boards.forCollege(it);
    let notices: Item[] = [];
    try {
      const stats: Record<string, boards.Stat> = {};
      notices = await (opts.fetchers?.boards ?? ((list, dd, st) => boards.collect(list, dd, st)))(active, d, stats);
      const at = opts.now().getTime();
      update({ source_stats: Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, { ...v, at }])) });
    } catch (e) {
      errors.push(`공고 게시판: ${(e as Error).message}`);
    }
    notices = keepPrevious(prevNotices, notices, d, fromActive);

    replaceExtras([...portal, ...dream, ...notices]);
    update({ last_extra_at: opts.now().getTime(), extra_error: errors.join(" / ") });
    return { portal: portal.length, dreamspon: dream.length, boards: notices.length, errors };
  }

  // 같은 일을 겹쳐 돌리지 않는다. 돌고 있으면 그 결과를 같이 기다린다.
  const running = new Map<string, Promise<unknown>>();
  function once<T>(name: string, job: () => Promise<T>): Promise<T> {
    const cur = running.get(name) as Promise<T> | undefined;
    if (cur) return cur;
    const p = job().finally(() => running.delete(name));
    running.set(name, p);
    return p;
  }
  const runSync = (force = false) => once("sync", () => sync(force));
  const runExtra = () => once("extra", syncExtra);

  // ---------------- 알림 ----------------
  const md = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
  function line(it: Item, d: string): string {
    const st = logic.status(it, d);
    const left = logic.dday(it, d);
    let when = it.end ? `~${md(it.end)} 마감` : "마감일 미정";
    if (left !== null && left >= 0) when += left ? ` (D-${left})` : " (오늘 마감)";
    if (st === "upcoming") when = `${md(it.start!)} 모집 시작`;
    else if (st === "year_round") when = `연중 사업(~${it.end!.replaceAll("-", "/")}) · 신청 시기는 공고 확인`;
    return `· ${it.org} · ${it.notice_title || it.name}\n  ${when}`;
  }
  function message(note: logic.Plan, d: string) {
    let title: string;
    if (note.kind === "new") title = `내 조건에 맞는 새 장학금 ${note.items.length}건`;
    else if (note.kind === "star_new") title = "관심 장학금 모집이 올라왔어요";
    else title = note.dday === 0 ? "관심 장학금 오늘 마감" : `관심 장학금 마감 D-${note.dday}`;
    const shown = note.items.slice(0, 5);
    let body = shown.map((it) => line(it, d)).join("\n");
    if (note.items.length > shown.length) body += `\n그 밖에 ${note.items.length - shown.length}건`;
    return { title, body, url: "/admin#scholarship" };
  }

  // 알림을 골라 보낸다. 보낸 알림 종류를 돌려준다.
  async function check(now = opts.now()): Promise<string[]> {
    const list = items();
    if (!list.length) return [];
    const s = state();
    const currentIds = list.map((it) => it.id);
    // 처음에는 기준선만 잡는다. 이미 올라와 있던 장학금까지 '새 장학금' 으로 알리면 켜자마자 수십 건이 쏟아진다.
    if (!s.baselined) {
      update({ known_ids: currentIds, baselined: true, last_check_at: now.getTime() });
      return [];
    }
    const h = seoulHour(now);
    if (h >= QUIET_HOURS[0]! || h < QUIET_HOURS[1]!) return [];
    const d = seoul(now);
    const notes = logic.planNotifications(list, { profile: s.profile, settings: s.settings, stars: s.stars, knownIds: new Set(s.known_ids), sent: new Set(s.sent), today: d });
    const done: string[] = [];
    for (const note of notes) {
      await opts.deliver(message(note, d));
      const sent = state().sent;
      for (const k of note.keys) if (!sent.includes(k)) sent.push(k);
      update({ sent: sent.slice(-MAX_SENT) });
      done.push(note.kind);
    }
    update({ known_ids: currentIds, last_check_at: now.getTime() });
    return done;
  }

  // 깨어날 때마다(15분): 6시간 지났으면 원본·추가 출처를 다시 보고, 알림을 고른다.
  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const t = opts.now().getTime();
      if (t - state().last_sync_at >= SYNC_EVERY_MS) await runSync().catch((e) => console.warn("장학금 원본 갱신 실패:", (e as Error).message));
      if (t - state().last_extra_at >= EXTRA_EVERY_MS) await runExtra().catch((e) => console.error("장학금 추가 출처 실패:", e));
      await check();
    } catch (e) {
      console.error("장학금 확인 실패:", e);
    } finally {
      busy = false;
    }
  }

  // ---------------- 화면에 줄 것 ----------------
  function slim(it: Item, d: string, stars: Set<string>, profile: logic.Profile) {
    const support = (it.support || "").split("\n").map((ln: string) => ln.replace(/^[○ ]+/, "").trim()).filter(Boolean);
    const out: Record<string, unknown> = {};
    for (const k of ["id", "series", "org", "name", "org_type", "category", "start", "end", "url", "expected_start", "expected_end", "started", "source", "posted", "period_from", "notice_url", "notice_title"]) {
      if (k in it) out[k] = it[k];
    }
    return {
      ...out,
      status: logic.status(it, d),
      dday: logic.dday(it, d),
      starred: stars.has(it.series),
      mine: logic.matches(profile, it),
      regional: logic.isRegional(it),
      region_check: logic.regionVerdict(profile, it) === "unknown",
      purpose: logic.purpose(it),
      loan: logic.isLoan(it),
      support: support.join(" · ").slice(0, 140),
    };
  }

  function search(list: Item[], q: string): Item[] {
    const words = q.split(/\s+/).filter(Boolean);
    if (!words.length) return list;
    const fields = ["org", "name", "support", "special", "region", "category", "notice_title"];
    return list.filter((it) => words.every((w) => fields.some((f) => String(it[f] ?? "").includes(w))));
  }

  function view(v: View, list: Item[], d: string, stars: Set<string>): Item[] {
    const by = (k: string, desc = false) => (a: Item, b: Item) => (desc ? -1 : 1) * logic.cmp(a[k], b[k]);
    const st = (s: string) => list.filter((it) => logic.status(it, d) === s);
    if (v === "open") return [...st("open").sort(by("end")), ...st("upcoming").sort(by("start"))]; // 지금 받는 것(마감 가까운 순) 다음에 곧 시작할 것
    if (v === "year_round") return st("year_round").sort(by("end"));
    if (v === "soon") return logic.forecast(list, d);
    if (v === "closed") return logic.recentlyClosed(list, d);
    if (v === "unknown") return st("unknown").sort(by("posted", true));
    if (v === "starred") {
      const order: Record<string, number> = { open: 0, year_round: 1, upcoming: 2, unknown: 3, closed: 4 };
      return [...logic.latestRounds(list.filter((it) => stars.has(it.series))).values()].sort(
        (a, b) => order[logic.status(a, d)]! - order[logic.status(b, d)]! || logic.cmp(a.end, b.end),
      );
    }
    return [...list].sort(by("start", true));
  }

  function status() {
    const s = state();
    const list = items();
    const d = today();
    return {
      count: list.length,
      open: list.filter((it) => logic.status(it, d) === "open").length,
      meta: s.meta,
      source_page: source.PAGE_URL,
      last_sync_at: s.last_sync_at,
      last_error: s.last_error,
      last_extra_at: s.last_extra_at,
      extra_error: s.extra_error,
      extra_count: list.filter((it) => it.source).length,
      last_check_at: s.last_check_at,
      stars: s.stars.length,
      syncing: running.size > 0,
    };
  }

  function sourcesView() {
    const s = state();
    return boards.allSources(s).map((b) => ({ id: b.id, label: b.label, url: b.url, builtin: b.builtin, enabled: b.enabled, stat: s.source_stats[b.id] ?? null }));
  }

  async function body(req: Request): Promise<Record<string, unknown>> {
    try {
      return (await req.json()) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");

  // /api/scholarship/… — 로그인·요청 출처 확인은 app.ts 가 먼저 한다.
  async function api(req: Request, url: URL): Promise<Response> {
    const path = url.pathname.slice("/api/scholarship".length);
    const method = req.method;
    const d = today();

    if (path === "/status" && method === "GET") return json(status());
    // 다시 받기는 1~2분 걸려 응답을 기다리지 않는다(요청이 그만큼 열려 있으면 끊긴다). 화면은 status.syncing 이 꺼질 때까지 본다.
    // 실패는 last_error·extra_error 로 남는다.
    if (path === "/sync" && method === "POST") {
      void runSync(true)
        .catch(() => {})
        .then(() => runExtra());
      return json(status(), 202);
    }
    if (path === "/options" && method === "GET") {
      return json({
        levels: logic.LEVELS,
        schools: source.SCHOOL_VOCAB.filter((x) => !["제한없음", "해당없음", "특정대학"].includes(x)),
        fields: source.FIELD_VOCAB.filter((x) => !["제한없음", "해당없음", "특정학과"].includes(x)),
        categories: [...new Set(items().map((it) => it.category || ""))].filter(Boolean).sort(),
      });
    }

    // 내 조건 / 알림
    if (path === "/profile" && method === "GET") return json(state().profile);
    if (path === "/profile" && method === "PATCH") {
      const b = await body(req);
      const p = { ...state().profile };
      for (const k of ["regions", "level", "school", "field", "purpose"] as const) if (typeof b[k] === "string") p[k] = str(b[k]);
      if (typeof b.exclude_loans === "boolean") p.exclude_loans = b.exclude_loans;
      if (!["", "living", "no_tuition"].includes(p.purpose)) return json({ error: "지원 용도가 올바르지 않습니다" }, 400);
      if (p.level && !logic.LEVELS.includes(p.level)) return json({ error: "과정이 올바르지 않습니다" }, 400);
      update({ profile: p });
      return json(p);
    }
    if (path === "/settings" && method === "GET") return json(state().settings);
    if (path === "/settings" && method === "PATCH") {
      const b = await body(req);
      const s = { ...state().settings };
      if (typeof b.notify_new === "boolean") s.notify_new = b.notify_new;
      if (typeof b.notify_starred === "boolean") s.notify_starred = b.notify_starred;
      if (Array.isArray(b.reminder_days)) s.reminder_days = [...new Set(b.reminder_days.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 60))].sort((a, z) => z - a);
      update({ settings: s });
      return json(s);
    }

    // 목록
    if (path === "/items" && method === "GET") {
      const v = (url.searchParams.get("view") ?? "open") as View;
      if (!VIEWS.includes(v)) return json({ error: "보기가 올바르지 않습니다" }, 400);
      const s = state();
      const stars = new Set(s.stars);
      let pool = search(items(), (url.searchParams.get("q") ?? "").trim());
      const category = url.searchParams.get("category") ?? "";
      if (category) pool = pool.filter((it) => it.category === category);
      if (url.searchParams.get("mine") !== "false") {
        // 관심 표시한 것은 지역·학년 조건과 상관없이 보인다. 대출·지원 용도로 뺀 것은 관심이어도 뺀다.
        pool = pool.filter((it) => !logic.excluded(s.profile, it) && (stars.has(it.series) || logic.matches(s.profile, it)));
      }
      const counts = Object.fromEntries(VIEWS.map((x) => [x, view(x, pool, d, stars).length]));
      const rows = view(v, pool, d, stars);
      const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || 30));
      return json({ total: rows.length, counts, items: rows.slice(offset, offset + limit).map((it) => slim(it, d, stars, s.profile)) });
    }
    const im = path.match(/^\/items\/([0-9a-f]{12})$/);
    if (im && method === "GET") {
      const list = items();
      const it = list.find((x) => x.id === im[1]);
      if (!it) return json({ error: "장학금을 찾지 못했습니다" }, 404);
      const s = state();
      const rounds = list
        .filter((x) => x.series === it.series)
        .map((x) => ({ id: x.id, start: x.start ?? "", end: x.end ?? "" }))
        .sort((a, b) => logic.cmp(b.start, a.start));
      // 목록용 요약(지원 내용 140자)이 원문을 덮지 않게 원문을 나중에 펼친다
      return json({ ...slim(it, d, new Set(s.stars), s.profile), ...it, rounds });
    }
    const sm = path.match(/^\/stars\/([0-9a-f]{12})$/);
    if (sm && method === "PUT") {
      const on = (await body(req)).on !== false;
      if (on && !items().some((it) => it.series === sm[1])) return json({ error: "장학금을 찾지 못했습니다" }, 404);
      const stars = state().stars.filter((x) => x !== sm[1]);
      if (on) stars.push(sm[1]!);
      update({ stars });
      return json({ stars });
    }

    // 공고 게시판 출처
    if (path === "/sources" && method === "GET") return json({ sources: sourcesView() });
    if (path === "/sources" && method === "POST") {
      // 먼저 읽어 보고, 날짜가 붙은 글 목록을 못 찾으면 더하지 않는다.
      const b = await body(req);
      const u = str(b.url, 1000);
      let got: Awaited<ReturnType<typeof boards.probe>>;
      try {
        got = await (opts.fetchers?.probe ?? ((x, dd) => boards.probe(x, dd)))(u, d);
      } catch (e) {
        if (e instanceof boards.BlockedURL) return json({ error: e.message }, 400);
        return json({ error: `게시판을 열지 못했습니다: ${(e as Error).message}` }, 502);
      }
      if (!got.posts) return json({ error: "이 주소에서 날짜가 붙은 글 목록을 찾지 못했습니다. 게시판 목록 화면의 주소인지 확인해 주세요" }, 422);
      const id = "custom_" + createHash("sha1").update(u).digest("hex").slice(0, 10);
      const label = str(b.label, 40) || got.title || u.slice(0, 40);
      const s = state();
      // 사용자가 고른 게시판은 대개 장학 게시판이거나 '장학' 검색 결과라 제목 조건을 느슨하게 둔다
      if (!s.custom_sources.some((c) => c.id === id)) update({ custom_sources: [...s.custom_sources, { id, label, org: label, url: u, loose: true }] });
      return json({ sources: sourcesView(), probe: got }, 201);
    }
    if (path === "/sources/refresh" && method === "POST") {
      void runExtra(); // 출처를 바꾼 뒤 바로 다시 모은다(1분 남짓) — /sync 처럼 기다리지 않는다
      return json(status(), 202);
    }
    const srcm = path.match(/^\/sources\/([\w-]+)$/);
    if (srcm) {
      const id = srcm[1]!;
      const s = state();
      if (!boards.allSources(s).some((b) => b.id === id)) return json({ error: "출처를 찾지 못했습니다" }, 404);
      if (method === "PATCH") {
        const on = (await body(req)).enabled !== false;
        update({ sources_off: on ? s.sources_off.filter((x) => x !== id) : [...new Set([...s.sources_off, id])] });
        return json({ sources: sourcesView() });
      }
      if (method === "DELETE") {
        if (!s.custom_sources.some((c) => c.id === id)) return json({ error: "직접 더한 출처만 지울 수 있습니다" }, 400);
        const { [id]: _, ...stats } = s.source_stats;
        update({ custom_sources: s.custom_sources.filter((c) => c.id !== id), source_stats: stats });
        return json({ sources: sourcesView() });
      }
    }
    return json({ error: "not found" }, 404);
  }

  return {
    api,
    check,
    tick,
    sync: runSync,
    syncExtra: runExtra,
    state,
    update,
    items,
    replaceBase,
    replaceExtras,
    keepPrevious,
    start(intervalMs: number) {
      setTimeout(() => void tick(), 5_000); // 켜자마자 한 번(처음이면 원본부터 받는다)
      setInterval(() => void tick(), intervalMs);
    },
  };
}

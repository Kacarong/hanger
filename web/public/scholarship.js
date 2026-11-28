// 장학금: 한국장학재단·드림스폰·공고 게시판에서 모은 대학생 장학금을 내 조건으로 걸러 보여 준다.
// ☆ 한 장학금은 마감이 다가오거나 다음 모집이 올라오면 알림이 간다(서버 scholarship/index.ts 가 고른다).
const API = "/api/scholarship";
const PAGE = 30;
const VIEWS = [
  ["open", "신청 가능"],
  ["year_round", "연중 사업"],
  ["soon", "작년 일정 참고"],
  ["closed", "최근 마감"],
  ["unknown", "일정 미확인"],
  ["starred", "관심"],
  ["all", "전체"],
];
const VIEW_HINT = {
  open: "지금 신청할 수 있는 장학금입니다(마감이 가까운 순서). 그 아래는 공고가 나왔고 곧 접수를 시작하는 것입니다. 학교 추천을 거치는 장학금은 학교 마감이 더 빠를 수 있습니다.",
  year_round: "공고 기간이 1년 가까이 잡힌 사업입니다. 국가근로·멘토링 장학금처럼 실제 신청은 학기마다 짧게 따로 받는 경우가 많아서, 지금 신청할 수 있는지는 기관 공고에서 꼭 확인하세요.",
  soon: "작년 일정으로 본 장학금인데 올해 공고는 아직 목록에 없습니다. 위쪽은 작년엔 두 달 안에 시작했던 것, 아래쪽('확인 필요')은 작년 기준이면 이미 모집을 시작했을 것입니다. ☆ 해 두면 올해 모집이 올라올 때 알려 드립니다.",
  closed: "최근 6개월 안에 마감된 회차입니다. 내년 일정을 가늠하거나 놓친 장학금의 다음 모집을 ☆ 해 둘 때 쓰세요.",
  unknown: "게시판에서 가져왔지만 본문이 이미지뿐이거나 첨부에서도 신청 기간을 읽지 못한 공고입니다. 신청 가능 목록과 알림에서는 뺐습니다. 공고 원문을 열어 확인하세요.",
  starred: "관심 표시한 장학금입니다. 내 조건과 상관없이 늘 보입니다.",
  all: "받아 둔 장학금 전부입니다(지난 회차 포함). 최근에 모집한 순서.",
};
const DETAIL_SECTIONS = [
  ["support", "지원 내용"],
  ["grade_req", "성적 기준"],
  ["income", "소득 기준"],
  ["special", "특정 자격"],
  ["region", "지역 조건"],
  ["restriction", "자격 제한"],
  ["selection", "선발 방법"],
  ["quota", "선발 인원"],
  ["recommend", "추천 필요"],
  ["how", "신청 방법"],
  ["documents", "제출 서류"],
];
const PURPOSE = { "": "상관없음", living: "생활비 장학금만 (생활비라고 적힌 것)", no_tuition: "등록금 전용만 빼기 (용도 안 적힌 것 포함)" };
const md = (iso) => (iso ? `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}` : "?");
const fmtTs = (ms) => (ms ? new Date(ms).toLocaleString("ko-KR", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "아직 없음");

// 원본은 '대학2학기, 대학3학기, … 공학계열, 교육계열, …' 처럼 값을 전부 늘어놓는다. 세 줄로 줄인다.
const noLimit = (list, all) => list.includes("제한없음") || list.length >= all;
function gradeText(grades) {
  if (grades.includes("제한없음")) return "제한 없음";
  const parts = [];
  if (grades.includes("대학신입생")) parts.push("신입생");
  const sems = grades.map((g) => g.match(/^대학(\d)학기/)?.[1]).filter(Boolean).map(Number);
  if (sems.length) parts.push(Math.min(...sems) <= 2 ? "재학생" : `재학생(${Math.min(...sems)}학기 이상)`);
  if (grades.some((g) => g.startsWith("석사") || g === "박사과정")) parts.push("대학원생");
  if (grades.includes("연령제한")) parts.push("나이 제한 있음");
  return parts.join(", ");
}
function targetText(d) {
  const clean = (list) => (list || []).filter((t) => t !== "해당없음");
  const [schools, grades, fields] = [clean(d.schools), clean(d.grades), clean(d.fields)];
  return [
    schools.length && `학교: ${noLimit(schools, 8) ? "제한 없음" : schools.join(", ")}`,
    grades.length && `과정: ${gradeText(grades)}`,
    fields.length && `계열: ${noLimit(fields, 7) ? "제한 없음" : fields.join(", ")}`,
  ].filter(Boolean).join("\n");
}

export function mount(root, { icon, call, el, showError, searchText }) {
  let view = localStorage.getItem("schView") || "open";
  let offset = 0;
  let seq = 0;
  let options = null;
  let profile = null;

  const stats = el("div", { className: "stats" });
  const segBox = el("div", { className: "seg sch-views" });
  const category = el("select", { className: "input sm", ariaLabel: "유형" }, el("option", { value: "", textContent: "모든 유형" }));
  const mine = el("input", { type: "checkbox", checked: localStorage.getItem("schMine") !== "0" });
  const hint = el("p", { className: "foot-note sch-hint" });
  const list = el("tbody");
  const more = el("button", { className: "btn", type: "button", textContent: "더 보기", hidden: true, onclick: () => load(true).catch(showError) });
  const foot = el("p", { className: "foot-note" });
  root.replaceChildren(
    stats,
    el("div", { className: "toolbar" }, segBox, el("span", { className: "grow" }), category, el("label", { className: "sch-check" }, mine, "내 조건만")),
    hint,
    el("table", { className: "table sch-table" }, el("thead", {}, el("tr", {}, el("th", { className: "w1" }), el("th", { textContent: "장학금" }), el("th", { textContent: "일정" }))), list),
    el("div", { className: "sch-more" }, more),
    foot,
  );
  category.onchange = () => load().catch(showError);
  mine.onchange = () => {
    localStorage.setItem("schMine", mine.checked ? "1" : "0");
    Promise.all([load(), loadStatus()]).catch(showError);
  };

  function query(extra = {}) {
    const p = new URLSearchParams({ view, mine: String(mine.checked), q: searchText(), category: category.value, offset: String(offset), limit: String(PAGE), ...extra });
    return `${API}/items?${p}`;
  }

  function showCounts(counts) {
    segBox.replaceChildren(
      ...VIEWS.map(([v, label]) =>
        el("button", { type: "button", className: v === view ? "on" : "", onclick: () => ((view = v), localStorage.setItem("schView", v), load().catch(showError)) }, label, el("b", { className: "sch-count", textContent: String(counts?.[v] ?? "") })),
      ),
    );
  }

  // 일정 칸: 큰 글자(날짜)와 옆의 작은 글자(D-day·상태)
  function when(it) {
    const cell = (main, note, cls) => el("td", { className: "sch-when" }, el("span", { className: "date-main", textContent: main }), note ? el("span", { className: `date-note ${cls}`, textContent: note }) : null);
    if (it.expected_start) return cell(`작년 ${md(it.start)}~${md(it.end)}`, it.started ? "작년 기준 이미 시작 · 올해 공고 확인" : "올해 모집 미확인", it.started ? "warn" : "soon");
    if (it.status === "unknown") return cell("일정 미확인", it.posted ? `${md(it.posted)} 게시 · 원문 확인` : "원문 확인", "warn");
    if (it.status === "open") return cell(`${md(it.end)} 마감`, it.dday === 0 ? "오늘 마감" : `D-${it.dday}`, it.dday <= 3 ? "warn" : it.dday <= 7 ? "soon" : "ok");
    if (it.status === "upcoming") return cell(`${md(it.start)} 시작`, `~${md(it.end)} 마감`, "ok");
    if (it.status === "year_round") return cell(`연중 (~${it.end.slice(0, 4)}.${md(it.end)})`, "신청 시기 확인", "soon");
    return el("td", { className: "sch-when muted", textContent: `마감 · ${it.start ? `${it.start.slice(0, 4)}.${md(it.start)}~` : ""}${md(it.end)}` });
  }

  function tags(it) {
    const p = (text, color = "gray") => el("span", { className: `pill ${color}`, textContent: text });
    return el(
      "span",
      { className: "sch-tags" },
      it.category && it.category !== "해당없음" ? p(it.category) : null,
      it.region_check ? p("지역 확인 필요", "amber") : it.regional ? p("지역") : null,
      it.loan ? p("대출", "orange") : it.purpose === "living" ? p("생활비", "blue") : it.purpose === "tuition" ? p("등록금") : null,
      it.mine ? null : p("조건 밖"),
      it.source ? p(it.source === "한국장학재단 포털" ? "새로 올라옴 · 포털" : it.source) : null,
      (it.period_from || "").startsWith("첨부") ? p("일정은 첨부 공고문에서 읽음", "blue") : null,
    );
  }

  function starBtn(it) {
    const b = el("button", { type: "button", className: "btn ghost sm sch-star" + (it.starred ? " on" : "") }, icon("star"));
    const paint = (on) => {
      b.classList.toggle("on", on);
      b.title = b.ariaLabel = on ? "관심 해제" : "관심 표시 — 마감 임박·다음 모집을 알려 드립니다";
    };
    paint(it.starred);
    b.onclick = async (ev) => {
      ev.stopPropagation();
      const on = !b.classList.contains("on");
      b.disabled = true;
      try {
        await call(`${API}/stars/${it.series}`, { method: "PUT", body: { on } });
        // 관심은 장학금(series) 단위라 같은 장학금의 다른 회차도 같이 바꾼다
        for (const s of list.querySelectorAll(`.sch-star[data-series="${it.series}"]`)) s.paint(on);
        refreshCounts();
      } catch (e) {
        showError(e);
      } finally {
        b.disabled = false;
      }
    };
    b.dataset.series = it.series;
    b.paint = paint;
    return b;
  }

  async function toggleDetail(tr, it) {
    const next = tr.nextElementSibling;
    if (next?.classList.contains("sch-detail")) return next.remove();
    const box = el("div", { className: "sch-body", textContent: "불러오는 중…" });
    tr.after(el("tr", { className: "sch-detail" }, el("td"), el("td", { colSpan: 2 }, box)));
    try {
      const d = await call(`${API}/items/${it.id}`);
      const sec = (label, text) => el("div", { className: "sch-sec" }, el("span", { className: "muted", textContent: label }), el("p", { textContent: text }));
      const meta = [d.org_type, d.category, d.product].filter((x) => x && x !== "해당없음").join(" · ");
      box.replaceChildren(
        meta ? el("p", { className: "muted", textContent: meta }) : "",
        d.notice_title ? el("p", { className: "muted", textContent: `공고: ${d.notice_title}${d.posted ? ` (${d.posted} 게시)` : ""}${d.period_from ? ` — 신청 기간은 ${d.period_from}에서 읽었습니다` : ""}. 자동으로 읽은 날짜라 원문으로 한 번 더 확인해 주세요.` }) : "",
        targetText(d) ? sec("대상", targetText(d)) : "",
        ...DETAIL_SECTIONS.filter(([k]) => (d[k] || "").trim() && d[k].trim() !== "해당없음").map(([k, label]) => sec(label, d[k].trim())),
        d.rounds?.length > 1 ? sec("모집 기록", d.rounds.map((r) => `${r.start || "?"} ~ ${r.end || "?"}`).join("\n")) : "",
        el(
          "div",
          { className: "sch-links" },
          d.notice_url ? el("a", { className: "btn sm", href: d.notice_url, target: "_blank", rel: "noopener", textContent: "공고 원문 열기 ↗" }) : null,
          d.url ? el("a", { className: "btn sm", href: d.url, target: "_blank", rel: "noopener", textContent: d.notice_title && !d.notice_url ? "공고 원문 열기 ↗" : "기관 홈페이지 열기 ↗" }) : null,
        ),
      );
    } catch (e) {
      box.textContent = "자세한 내용을 불러오지 못했습니다: " + e.message;
    }
  }

  function row(it) {
    const tr = el(
      "tr",
      { className: "sch-row" },
      el("td", {}, starBtn(it)),
      el("td", {}, el("span", { className: "title", textContent: it.notice_title || it.name }), el("span", { className: "sub", textContent: it.org }), tags(it), it.support ? el("span", { className: "sub sch-support", textContent: it.support }) : null),
      when(it),
    );
    tr.onclick = (ev) => {
      if (!ev.target.closest("a, button")) toggleDetail(tr, it);
    };
    return tr;
  }

  async function load(append = false) {
    const my = ++seq;
    if (!append) offset = 0;
    hint.textContent = VIEW_HINT[view];
    const data = await call(query());
    if (my !== seq) return; // 그새 다른 보기·검색으로 바뀜
    showCounts(data.counts);
    const rows = data.items.map(row);
    if (append) list.append(...rows);
    else list.replaceChildren(...rows);
    offset += data.items.length;
    more.hidden = offset >= data.total;
    if (!data.total) {
      const text = searchText() ? "검색 결과가 없습니다." : view === "starred" ? "아직 관심 표시한 장학금이 없습니다. 목록에서 ☆ 를 눌러 보세요." : mine.checked ? "내 조건에 맞는 장학금이 없습니다. '내 조건만' 을 끄면 전부 볼 수 있어요." : "해당하는 장학금이 없습니다.";
      list.replaceChildren(el("tr", { className: "empty-row" }, el("td", { colSpan: 3, textContent: text })));
    }
  }
  const refreshCounts = () => call(query({ limit: "1", offset: "0" })).then((d) => showCounts(d.counts), () => {});

  async function loadStatus() {
    const [s, open] = await Promise.all([call(`${API}/status`), call(`${API}/items?view=open&mine=${mine.checked}&limit=1`)]);
    const asOf = s.meta?.name?.match(/_(\d{8})$/)?.[1];
    stats.replaceChildren(
      statBox("지금 신청 가능", String(open.counts.open), mine.checked ? "내 조건에 맞는 것" : "전체"),
      statBox("관심", String(s.stars), "마감 임박·다음 모집 알림"),
      statBox("작년 일정 참고", String(open.counts.soon), "올해 공고 아직 없음"),
      statBox("받아 둔 장학금", s.count.toLocaleString("ko-KR"), asOf ? `${asOf.slice(0, 4)}.${asOf.slice(4, 6)}.${asOf.slice(6)} 자료 + 새로 찾은 ${s.extra_count}건` : "아직 원본을 받지 못했습니다"),
    );
    const warn = [s.last_error && `원본 갱신 실패: ${s.last_error}`, s.extra_error && `추가 출처 실패: ${s.extra_error}`].filter(Boolean);
    foot.textContent =
      `출처: 공공데이터포털 한국장학재단 학자금지원정보(월 1회), 한국장학재단 실시간 포털, 드림스폰 모집중 목록, 공고 게시판(출처 버튼). 6시간마다 다시 모읍니다 — 마지막 확인 ${fmtTs(Math.max(s.last_sync_at, s.last_extra_at))}${s.syncing ? " (지금 모으는 중)" : ""}. 자동으로 읽은 날짜는 틀릴 수 있으니 신청 전에 꼭 기관 공고 원문을 확인하세요.` +
      (warn.length ? ` ⚠ ${warn.join(" / ")}` : "");
  }
  const statBox = (label, value, sub) => el("div", { className: "stat" }, el("div", { className: "label", textContent: label }), el("div", { className: "value", textContent: value }), sub ? el("div", { className: "sub", textContent: sub }) : null);

  async function loadOptions() {
    const o = await call(`${API}/options`);
    const keep = category.value;
    category.replaceChildren(el("option", { value: "", textContent: "모든 유형" }), ...o.categories.map((c) => el("option", { value: c, textContent: c })));
    category.value = keep;
    options = o;
  }

  // ---------------- 내 조건·알림 ----------------
  const f = {
    regions: el("input", { className: "input", placeholder: "부산", autocomplete: "off" }),
    level: el("select", { className: "input" }),
    school: el("select", { className: "input" }),
    field: el("select", { className: "input" }),
    purpose: el("select", { className: "input" }, ...Object.entries(PURPOSE).map(([v, t]) => el("option", { value: v, textContent: t }))),
    noLoan: el("input", { type: "checkbox" }),
    notifyNew: el("input", { type: "checkbox" }),
    notifyStarred: el("input", { type: "checkbox" }),
    days: el("input", { className: "input", inputMode: "numeric", placeholder: "7, 3, 1", autocomplete: "off" }),
  };
  const profileMsg = el("span", { className: "error" });
  const profileDialog = el(
    "dialog",
    { className: "sch-dialog" },
    el(
      "form",
      { method: "dialog" },
      el("h2", { textContent: "내 조건" }),
      el("label", {}, "지역 (내 지역 + 전국 장학금이 나옵니다)", f.regions),
      el("div", { className: "row" }, el("label", {}, "과정", f.level), el("label", {}, "학교 종류", f.school)),
      el("div", { className: "row" }, el("label", {}, "계열", f.field), el("label", {}, "지원 용도", f.purpose)),
      el("label", { className: "check" }, f.noLoan, "학자금 대출·대출이자 지원 빼기"),
      el("p", { className: "sch-note", textContent: "'부산'이라고 적으면 부산 장학금과 전국 대상 장학금만 나옵니다. 구까지 적으면(예: 부산, 해운대구) 다른 구 전용 장학금도 빠집니다. 어느 지역 것인지 알 수 없는 읍·면 장학금은 빼고, '내 조건만'을 끄면 '지역 확인 필요'로 보입니다. 지원 내용에 금액만 적힌 장학금이 많습니다. 그런 것까지 보려면 지원 용도를 '등록금 전용만 빼기'로 고르세요. 소득·성적 기준은 공고마다 적는 방식이 달라 거르지 않습니다." }),
      el("h2", { className: "sch-sub", textContent: "알림" }),
      el("label", { className: "check" }, f.notifyNew, "내 조건에 맞는 새 장학금이 올라오면 알림"),
      el("label", { className: "check" }, f.notifyStarred, "관심(☆) 장학금의 마감 임박·다음 모집 알림"),
      el("label", {}, "마감 며칠 전에 알릴까요", f.days),
      el("p", { className: "sch-note", textContent: "알림은 '알림 설정'에서 켠 기기(폰·PC)로 갑니다. 밤 10시~아침 8시에는 보내지 않고 아침에 모아서 보냅니다." }),
      profileMsg,
      el("div", { className: "foot" }, el("button", { className: "btn", type: "button", textContent: "취소", onclick: () => profileDialog.close() }), el("button", { className: "btn primary", value: "ok", textContent: "저장" })),
    ),
  );
  profileDialog.querySelector("form").onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      profile = await call(`${API}/profile`, { method: "PATCH", body: { regions: f.regions.value, level: f.level.value, school: f.school.value, field: f.field.value, purpose: f.purpose.value, exclude_loans: f.noLoan.checked } });
      await call(`${API}/settings`, { method: "PATCH", body: { notify_new: f.notifyNew.checked, notify_starred: f.notifyStarred.checked, reminder_days: f.days.value.split(/[^0-9]+/).filter(Boolean).map(Number) } });
      profileDialog.close();
      await Promise.all([load(), loadStatus()]);
    } catch (e) {
      profileMsg.textContent = e.message;
    }
  };

  async function openProfile() {
    if (!options) await loadOptions();
    const opt = (list) => [el("option", { value: "", textContent: "상관없음" }), ...list.map((v) => el("option", { value: v, textContent: v }))];
    f.level.replaceChildren(...opt(options.levels));
    f.school.replaceChildren(...opt(options.schools));
    f.field.replaceChildren(...opt(options.fields));
    const [p, s] = await Promise.all([call(`${API}/profile`), call(`${API}/settings`)]);
    profile = p;
    f.regions.value = p.regions;
    f.level.value = p.level;
    f.school.value = p.school;
    f.field.value = p.field;
    f.purpose.value = p.purpose;
    f.noLoan.checked = p.exclude_loans;
    f.notifyNew.checked = s.notify_new;
    f.notifyStarred.checked = s.notify_starred;
    f.days.value = s.reminder_days.join(", ");
    profileMsg.textContent = "";
    profileDialog.showModal();
  }

  // ---------------- 공고 게시판 출처 ----------------
  const srcList = el("div", { className: "sch-sources" });
  const srcUrl = el("input", { className: "input", type: "url", placeholder: "https://…/board?…searchKeyword=장학", autocomplete: "off" });
  const srcLabel = el("input", { className: "input", placeholder: "예: 부산대 사회기반시스템공학과", autocomplete: "off" });
  const srcMsg = el("p", { className: "sch-note" });
  const busy = async (btn, text, job) => {
    btn.disabled = true;
    srcMsg.textContent = text;
    try {
      await job();
    } catch (e) {
      srcMsg.textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  };
  const addBtn = el("button", { className: "btn primary", type: "button", textContent: "출처 더하기" });
  const refreshBtn = el("button", { className: "btn", type: "button", textContent: "지금 다시 모으기" });
  const syncBtn = el("button", { className: "btn ghost", type: "button", textContent: "원본(CSV)도 다시 받기" });
  const sourcesDialog = el(
    "dialog",
    { className: "sch-dialog" },
    el(
      "form",
      { method: "dialog" },
      el("h2", { textContent: "공고 게시판 출처" }),
      el("p", { className: "sch-note", textContent: "한국장학재단 자료와 드림스폰에 더해 아래 게시판을 6시간마다 읽습니다. '장학' 글을 열어 본문에서 신청 기간을 읽고, 없으면 첨부 공고문(HWP·PDF·ZIP)을 내려받아 읽습니다. 끄거나 더한 뒤 '지금 다시 모으기'를 누르면 바로 반영됩니다." }),
      srcList,
      el("label", {}, "게시판 목록 화면 주소 ('장학'으로 검색한 화면이면 더 좋습니다)", srcUrl),
      el("label", {}, "이름 (선택)", srcLabel),
      srcMsg,
      el("div", { className: "foot" }, syncBtn, el("span", { className: "grow" }), refreshBtn, addBtn, el("button", { className: "btn", type: "button", textContent: "닫기", onclick: () => sourcesDialog.close() })),
    ),
  );
  const statText = (st) => (!st ? "아직 안 읽음" : st.error ? `못 읽음: ${st.error}` : `글 ${st.posts}개 · 장학 글 ${st.picked}개 열어 봄 · 목록에 ${st.items}건`);
  function renderSources(sources) {
    srcList.replaceChildren(
      ...sources.map((s) => {
        const cb = el("input", { type: "checkbox", checked: s.enabled, ariaLabel: `${s.label} 켜기` });
        cb.onchange = () => call(`${API}/sources/${s.id}`, { method: "PATCH", body: { enabled: cb.checked } }).then((r) => renderSources(r.sources), (e) => ((cb.checked = !cb.checked), showError(e)));
        return el(
          "div",
          { className: "sch-source" },
          cb,
          el("div", { className: "grow" }, el("a", { href: s.url, target: "_blank", rel: "noopener", textContent: s.label }), el("span", { className: "sub" + (s.stat?.error ? " error" : ""), textContent: statText(s.stat) })),
          s.builtin ? null : el("button", { className: "btn ghost sm danger", type: "button", title: "지우기", ariaLabel: "지우기", onclick: () => confirm(`'${s.label}' 출처를 지울까요?`) && call(`${API}/sources/${s.id}`, { method: "DELETE" }).then((r) => renderSources(r.sources), showError) }, icon("trash")),
        );
      }),
    );
  }
  addBtn.onclick = () =>
    busy(addBtn, "게시판을 읽어 보는 중…", async () => {
      if (!srcUrl.value.trim()) throw new Error("게시판 주소를 넣어 주세요.");
      const r = await call(`${API}/sources`, { method: "POST", body: { url: srcUrl.value.trim(), label: srcLabel.value.trim() } });
      renderSources(r.sources);
      const sample = r.probe.scholarship.length ? ` 예: ${r.probe.scholarship.slice(0, 3).join(" / ")}` : " 최근 장학 글은 아직 없습니다.";
      srcMsg.textContent = `더했습니다. 글 ${r.probe.posts}개를 찾았습니다.${sample} '지금 다시 모으기'를 누르면 바로 반영됩니다.`;
      srcUrl.value = srcLabel.value = "";
    });
  // 다시 모으기는 서버에서 따로 돈다. 끝날 때까지 상태를 보다가 결과를 보여 준다.
  async function waitSync() {
    let s;
    do {
      await new Promise((ok) => setTimeout(ok, 3000));
      s = await call(`${API}/status`);
    } while (s.syncing);
    renderSources((await call(`${API}/sources`)).sources);
    srcMsg.textContent = `다시 모았습니다. 지금 ${s.count.toLocaleString("ko-KR")}건(새로 찾은 것 ${s.extra_count}건).` + ([s.last_error, s.extra_error].some(Boolean) ? ` ⚠ ${[s.last_error, s.extra_error].filter(Boolean).join(" / ")}` : "");
    await Promise.all([load(), loadStatus(), loadOptions()]);
  }
  refreshBtn.onclick = () =>
    busy(refreshBtn, "포털·드림스폰·게시판을 다시 읽는 중… (1~2분 걸립니다. 창을 닫아도 계속 모읍니다)", async () => {
      await call(`${API}/sources/refresh`, { method: "POST" });
      await waitSync();
    });
  syncBtn.onclick = () =>
    busy(syncBtn, "공공데이터포털 원본과 추가 출처를 다시 받는 중… (1~2분 걸립니다. 창을 닫아도 계속 받습니다)", async () => {
      await call(`${API}/sync`, { method: "POST" });
      await waitSync();
    });
  sourcesDialog.querySelector("form").onsubmit = (ev) => (ev.preventDefault(), addBtn.click()); // 주소 칸에서 Enter = 더하기
  async function openSources() {
    srcMsg.textContent = "";
    renderSources((await call(`${API}/sources`)).sources);
    sourcesDialog.showModal();
  }
  document.body.append(profileDialog, sourcesDialog);

  return {
    async load() {
      if (!options) await loadOptions();
      await Promise.all([load(), loadStatus()]);
    },
    openProfile: () => openProfile().catch(showError),
    openSources: () => openSources().catch(showError),
  };
}

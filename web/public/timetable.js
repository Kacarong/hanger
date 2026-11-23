// 시간표: 학기마다 과목(교수·학점·성적·전공·요일별 시간과 강의실)을 적고, 에브리타임처럼 주간 칸에 보여 준다.
// 아래 학점 계산기는 같은 과목으로 평점(4.5 만점)·전공 평점·취득 학점을 낸다. 성적이 없는 과목(지금·앞으로의 학기)은 평점에서 빠진다.
const TERM_NAME = { 1: "1학기", 여름: "여름학기", 2: "2학기", 겨울: "겨울학기" };
const TERMS = ["1", "여름", "2", "겨울"];
const DAYS = "월화수목금토일";
const POINTS = { "A+": 4.5, A0: 4, "B+": 3.5, B0: 3, "C+": 2.5, C0: 2, "D+": 1.5, D0: 1, F: 0 };
const GRADES = ["", "A+", "A0", "B+", "B0", "C+", "C0", "D+", "D0", "F", "P", "NP"];
const COLORS = ["yellow", "mint", "blue", "pink", "rose", "lime", "peach", "lavender", "sky", "sand"];
const HOUR = 52; // 한 시간 칸 높이(px)

const semName = (s) => `${s.year}년 ${TERM_NAME[s.term]}`;
const minutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const hourLabel = (h) => (h < 12 ? `오전 ${h}시` : `오후 ${h === 12 ? 12 : h - 12}시`);
const num = (n) => String(Math.round(n * 10) / 10);

// 평점: 등급 있는 과목(A+~F)만 학점으로 가중 평균. 취득: F·NP·성적 없는 과목을 뺀 학점.
export function gpa(courses) {
  const avg = (list) => {
    const graded = list.filter((c) => c.grade in POINTS && c.credits > 0);
    const credits = graded.reduce((a, c) => a + c.credits, 0);
    return credits ? graded.reduce((a, c) => a + c.credits * POINTS[c.grade], 0) / credits : null;
  };
  return {
    all: avg(courses),
    major: avg(courses.filter((c) => c.major)),
    earned: courses.filter((c) => c.grade && c.grade !== "F" && c.grade !== "NP").reduce((a, c) => a + c.credits, 0),
    taking: courses.reduce((a, c) => a + c.credits, 0),
  };
}
const gpaText = (v) => (v === null ? "-" : v.toFixed(2));

// 같은 요일에 겹치는 수업은 나란히(칸을 나눠) 놓는다. → [{ c, t, lane, lanes }]
function layDay(items) {
  items.sort((a, b) => minutes(a.t.start) - minutes(b.t.start));
  const out = [];
  let group = [], groupEnd = -1, laneEnds = [];
  const flush = () => {
    for (const x of group) x.lanes = laneEnds.length;
    out.push(...group);
    (group = []), (laneEnds = []);
  };
  for (const it of items) {
    const s = minutes(it.t.start), e = minutes(it.t.end);
    if (group.length && s >= groupEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= s);
    if (lane < 0) lane = laneEnds.push(0) - 1;
    laneEnds[lane] = e;
    groupEnd = group.length ? Math.max(groupEnd, e) : e;
    group.push({ ...it, lane });
  }
  if (group.length) flush();
  return out;
}

export function mount(root, { icon, call, el, showError }) {
  let data = null; // GET /api/timetable
  let semId = Number(localStorage.getItem("ttSemester")) || null;
  let editing = null; // 수정 중인 과목(null = 새 과목)

  const semSelect = el("select", { className: "input", ariaLabel: "학기" });
  const summary = el("span", { className: "muted tt-summary" });
  const grid = el("div", { className: "tt-grid" });
  const untimed = el("div", { className: "tt-untimed" });
  const gpaStats = el("div", { className: "stats tt-gpa-stats" });
  const semChips = el("div", { className: "tt-sems" });
  const gpaHead = el("div", { className: "tt-gpa-head" });
  const gpaBody = el("tbody");
  root.replaceChildren(
    el(
      "div",
      { className: "toolbar" },
      semSelect,
      el("button", { className: "btn sm", type: "button", onclick: openSemDialog }, icon("plus"), "학기 추가"),
      el("button", { className: "btn ghost sm danger", type: "button", title: "이 학기 삭제", ariaLabel: "이 학기 삭제", onclick: deleteSem }, icon("trash")),
      el("span", { className: "grow" }),
      summary,
      el("button", { className: "btn primary sm", type: "button", onclick: () => openCourse() }, icon("plus"), "과목 추가"),
    ),
    el("div", { className: "tt-wrap" }, grid),
    untimed,
    el("h2", { className: "tt-title", textContent: "학점 계산기" }),
    gpaStats,
    semChips,
    gpaHead,
    el(
      "table",
      { className: "table tt-gpa" },
      el("thead", {}, el("tr", {}, el("th", { textContent: "과목명" }), el("th", { className: "num", textContent: "학점" }), el("th", { textContent: "성적" }), el("th", { textContent: "전공" }), el("th"))),
      gpaBody,
    ),
  );
  semSelect.onchange = () => {
    semId = Number(semSelect.value);
    localStorage.setItem("ttSemester", semId);
    render();
  };

  const sem = () => data.semesters.find((s) => s.id === semId);
  const semCourses = (id = semId) => data.courses.filter((c) => c.semester_id === id);

  async function load() {
    data = await call("/api/timetable");
    if (!data.semesters.some((s) => s.id === semId)) semId = data.semesters.find((s) => s.year === data.current.year && s.term === data.current.term)?.id ?? data.semesters[0]?.id;
    render();
  }

  function render() {
    semSelect.replaceChildren(...data.semesters.map((s) => el("option", { value: s.id, textContent: semName(s) + (s.year === data.current.year && s.term === data.current.term ? " (지금)" : ""), selected: s.id === semId })));
    renderGrid();
    renderGpa();
    renderGpaTable();
  }

  function renderGrid() {
    const list = semCourses();
    const g = gpa(list);
    summary.textContent = `${num(g.taking)}학점 · ${list.length}과목`;
    const slots = list.flatMap((c) => c.times.map((t) => ({ c, t })));
    const days = [0, 1, 2, 3, 4, ...[5, 6].filter((d) => slots.some((x) => x.t.day === d))];
    const from = Math.min(9, ...slots.map((x) => Math.floor(minutes(x.t.start) / 60)));
    const to = Math.max(18, ...slots.map((x) => Math.ceil(minutes(x.t.end) / 60)));
    const narrow = matchMedia("(max-width: 860px)").matches; // 좁은 화면은 시간 칸을 줄이고 "13시"처럼
    grid.style.gridTemplateColumns = `${narrow ? 34 : 58}px repeat(${days.length}, minmax(0, 1fr))`;
    const height = (to - from) * HOUR;
    const col = (d) => {
      const box = el("div", { className: "tt-day", title: "눌러서 이 시간에 과목 추가" });
      box.style.height = `${height}px`;
      box.onclick = (ev) => {
        if (ev.target !== box) return;
        const h = Math.min(from + Math.floor(ev.offsetY / HOUR), 22);
        openCourse(null, { day: d, start: hm(h * 60), end: hm((h + 1) * 60), room: "" });
      };
      for (const { c, t, lane, lanes } of layDay(slots.filter((x) => x.t.day === d))) {
        const b = el("button", { type: "button", className: `tt-block tc-${c.color || "sand"}`, title: `${c.name} ${t.start}~${t.end}` }, el("strong", { textContent: c.name }), el("span", { textContent: [c.professor, t.room].filter(Boolean).join(" ") }));
        Object.assign(b.style, {
          top: `${((minutes(t.start) - from * 60) / 60) * HOUR}px`,
          height: `${((minutes(t.end) - minutes(t.start)) / 60) * HOUR - 2}px`,
          left: `calc(${(lane / lanes) * 100}% + 1px)`,
          width: `calc(${100 / lanes}% - 2px)`,
        });
        b.onclick = () => openCourse(c);
        box.append(b);
      }
      return box;
    };
    const hours = el("div", { className: "tt-hours" }, ...Array.from({ length: to - from }, (_, i) => el("div", { textContent: narrow ? `${from + i}시` : hourLabel(from + i) })));
    hours.style.height = `${height}px`;
    grid.replaceChildren(el("div", { className: "tt-corner" }), ...days.map((d) => el("div", { className: "tt-dayname", textContent: DAYS[d] })), hours, ...days.map(col));
    grid.style.setProperty("--hour", `${HOUR}px`);
    const noTime = list.filter((c) => !c.times.length);
    untimed.replaceChildren(...(noTime.length ? [el("span", { className: "muted", textContent: "시간 없는 과목" }), ...noTime.map((c) => el("button", { type: "button", className: `tt-chip tc-${c.color || "sand"}`, onclick: () => openCourse(c) }, `${c.name} · ${num(c.credits)}학점`))] : []));
  }

  function renderGpa() {
    const all = gpa(data.courses);
    const stat = (label, value, sub) => el("div", { className: "stat" }, el("div", { className: "label", textContent: label }), el("div", { className: "value", textContent: value }), sub ? el("div", { className: "sub", textContent: sub }) : null);
    gpaStats.replaceChildren(stat("전체 평점", gpaText(all.all), "4.5 만점"), stat("전공 평점", gpaText(all.major), ""), stat("취득 학점", num(all.earned), "F·NP·성적 없는 과목 빼고"));
    semChips.replaceChildren(
      ...data.semesters.map((s) => {
        const g = gpa(semCourses(s.id));
        return el("button", { type: "button", className: "tt-sem" + (s.id === semId ? " on" : ""), onclick: () => ((semSelect.value = s.id), semSelect.onchange()) }, el("strong", { textContent: semName(s) }), el("span", { textContent: g.all === null ? `${num(g.taking)}학점 · 성적 없음` : `평점 ${gpaText(g.all)} · 취득 ${num(g.earned)}` }));
      }),
    );
    const g = gpa(semCourses());
    gpaHead.replaceChildren(
      el("strong", { textContent: sem() ? semName(sem()) : "" }),
      el("span", {}, "평점 ", el("b", { textContent: gpaText(g.all) })),
      el("span", {}, "전공 ", el("b", { textContent: gpaText(g.major) })),
      el("span", {}, "취득 ", el("b", { textContent: num(g.earned) })),
      el("span", { className: "muted", textContent: `신청 ${num(g.taking)}학점` }),
    );
  }

  // 표의 칸은 바로 저장한다. 표는 다시 그리지 않아(입력 중인 칸을 잃지 않게) 시간표와 평점만 새로 그린다.
  function renderGpaTable() {
    const patch = (c, body) =>
      call(`/api/courses/${c.id}`, { method: "PATCH", body }).then((row) => {
        Object.assign(c, row);
        renderGrid();
        renderGpa();
      }, showError);
    const gradeSelect = (value, onchange) => el("select", { className: "input sm", ariaLabel: "성적", onchange }, ...GRADES.map((g) => el("option", { value: g, textContent: g || "-", selected: g === value })));
    const rows = semCourses().map((c) =>
      el(
        "tr",
        {},
        el("td", {}, el("input", { className: "input", value: c.name, maxLength: 100, ariaLabel: "과목명", onchange() { if (this.value.trim()) patch(c, { name: this.value }); else this.value = c.name; } })),
        el("td", { className: "num" }, el("input", { className: "input credits", type: "number", min: 0, max: 30, step: 0.5, value: c.credits, ariaLabel: "학점", onchange() { patch(c, { credits: Number(this.value) }); } })),
        el("td", {}, gradeSelect(c.grade, function () { patch(c, { grade: this.value }); })),
        el("td", {}, el("input", { type: "checkbox", checked: !!c.major, ariaLabel: "전공", onchange() { patch(c, { major: this.checked }); } })),
        el("td", { className: "actions" }, el("button", { className: "btn ghost sm", type: "button", title: "시간·교수·색 수정", ariaLabel: "수정", onclick: () => openCourse(c) }, icon("edit")), el("button", { className: "btn ghost sm danger", type: "button", title: "삭제", ariaLabel: "삭제", onclick: () => removeCourse(c) }, icon("trash"))),
      ),
    );
    // 맨 아래 줄: 시간 없이 과목만 더한다(지난 학기 성적 입력 등).
    const name = el("input", { className: "input", placeholder: "과목 추가", maxLength: 100, ariaLabel: "새 과목명" });
    const credits = el("input", { className: "input credits", type: "number", min: 0, max: 30, step: 0.5, value: 3, ariaLabel: "새 과목 학점" });
    const grade = gradeSelect("", null);
    const major = el("input", { type: "checkbox", ariaLabel: "새 과목 전공" });
    const add = async () => {
      if (!name.value.trim()) return name.focus();
      try {
        await call("/api/courses", { method: "POST", body: { semester_id: semId, name: name.value, credits: Number(credits.value), grade: grade.value, major: major.checked, color: nextColor() } });
        await load();
        gpaBody.querySelector("tr:last-child input")?.focus();
      } catch (e) {
        showError(e);
      }
    };
    name.onkeydown = (ev) => ev.key === "Enter" && (ev.preventDefault(), add());
    gpaBody.replaceChildren(...rows, el("tr", { className: "tt-add" }, el("td", {}, name), el("td", { className: "num" }, credits), el("td", {}, grade), el("td", {}, major), el("td", { className: "actions" }, el("button", { className: "btn sm", type: "button", onclick: add }, icon("plus"), "추가"))));
  }

  const nextColor = () => {
    const used = new Set(semCourses().map((c) => c.color));
    return COLORS.find((c) => !used.has(c)) ?? COLORS[semCourses().length % COLORS.length];
  };

  async function removeCourse(c) {
    if (!confirm(`"${c.name}" 을(를) 삭제할까요?`)) return false;
    await call(`/api/courses/${c.id}`, { method: "DELETE" }).then(load, showError);
    return true;
  }

  // 학기 추가 창: 기본값은 마지막 학기 다음 정규 학기.
  const semYear = el("input", { className: "input", type: "number", min: 2000, max: 2100, required: true });
  const semTerm = el("select", { className: "input" }, ...TERMS.map((t) => el("option", { value: t, textContent: TERM_NAME[t] })));
  const semMsg = el("span", { className: "error" });
  const semDialog = el(
    "dialog",
    {},
    el(
      "form",
      { method: "dialog" },
      el("h2", { textContent: "학기 추가" }),
      el("div", { className: "row" }, el("label", {}, "연도", semYear), el("label", {}, "학기", semTerm)),
      semMsg,
      el("div", { className: "foot" }, el("button", { className: "btn", type: "button", textContent: "취소", onclick: () => semDialog.close() }), el("button", { className: "btn primary", value: "ok", textContent: "추가" })),
    ),
  );
  semDialog.querySelector("form").onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      const s = await call("/api/semesters", { method: "POST", body: { year: Number(semYear.value), term: semTerm.value } });
      semId = s.id;
      localStorage.setItem("ttSemester", semId);
      semDialog.close();
      await load();
    } catch (e) {
      semMsg.textContent = e.message;
    }
  };
  function openSemDialog() {
    const last = data.semesters.filter((s) => s.term === "1" || s.term === "2").at(-1) ?? { year: data.current.year, term: "1" };
    semYear.value = last.term === "2" ? last.year + 1 : last.year;
    semTerm.value = last.term === "2" ? "1" : "2";
    semMsg.textContent = "";
    semDialog.showModal();
  }
  async function deleteSem() {
    const s = sem();
    const n = semCourses().length;
    if (!s || !confirm(`${semName(s)}를 삭제할까요?${n ? ` 과목 ${n}개도 함께 지워집니다.` : ""}`)) return;
    await call(`/api/semesters/${s.id}`, { method: "DELETE" }).then(load, showError);
  }

  // 과목 창: 과목명·교수·학점·성적·전공·색, 수업 시간은 여러 줄(요일·시작·끝·강의실).
  const f = {
    name: el("input", { className: "input", maxLength: 100, required: true, placeholder: "구조역학" }),
    professor: el("input", { className: "input", maxLength: 100, placeholder: "교수명" }),
    credits: el("input", { className: "input", type: "number", min: 0, max: 30, step: 0.5, required: true }),
    grade: el("select", { className: "input" }, ...GRADES.map((g) => el("option", { value: g, textContent: g || "성적 없음" }))),
    major: el("input", { type: "checkbox" }),
  };
  const colorBox = el("div", { className: "tt-colors" });
  let color = "";
  const timeList = el("div", { className: "tt-times" });
  const timeRow = (t) => {
    const day = el("select", { className: "input", ariaLabel: "요일" }, ...[...DAYS].map((d, i) => el("option", { value: i, textContent: d, selected: i === t.day })));
    const start = el("input", { className: "input", type: "time", value: t.start, required: true, ariaLabel: "시작" });
    const end = el("input", { className: "input", type: "time", value: t.end, required: true, ariaLabel: "끝" });
    const room = el("input", { className: "input", value: t.room, maxLength: 100, placeholder: "강의실", ariaLabel: "강의실" });
    const row = el("div", { className: "tt-time" }, day, start, el("span", { className: "muted", textContent: "~" }), end, room, el("button", { className: "btn ghost sm", type: "button", title: "이 시간 빼기", ariaLabel: "이 시간 빼기", onclick: () => row.remove() }, icon("x")));
    row.value = () => ({ day: Number(day.value), start: start.value, end: end.value, room: room.value });
    return row;
  };
  const msg = el("span", { className: "error" });
  const title = el("h2");
  const delBtn = el("button", { className: "btn danger", type: "button", textContent: "삭제", onclick: async () => (await removeCourse(editing)) && dialog.close() });
  const dialog = el(
    "dialog",
    { className: "tt-dialog" },
    el(
      "form",
      { method: "dialog" },
      title,
      el("div", { className: "row" }, el("label", {}, "과목명", f.name), el("label", {}, "교수", f.professor)),
      el("div", { className: "row" }, el("label", {}, "학점", f.credits), el("label", {}, "성적", f.grade)),
      el("label", { className: "check" }, f.major, "전공 과목"),
      el("div", { className: "tt-field" }, el("span", { textContent: "수업 시간" }), timeList, el("button", { className: "btn sm", type: "button", onclick: () => timeList.append(timeRow({ day: 0, start: "09:00", end: "10:00", room: "" })) }, icon("plus"), "시간 추가")),
      el("div", { className: "tt-field" }, el("span", { textContent: "색" }), colorBox),
      msg,
      el("div", { className: "foot" }, delBtn, el("span", { className: "grow" }), el("button", { className: "btn", type: "button", textContent: "취소", onclick: () => dialog.close() }), el("button", { className: "btn primary", value: "ok", textContent: "저장" })),
    ),
  );
  const paintColors = () =>
    colorBox.replaceChildren(...COLORS.map((c) => el("button", { type: "button", className: `tt-swatch tc-${c}` + (c === color ? " on" : ""), title: c, ariaLabel: `색 ${c}`, onclick: () => ((color = c), paintColors()) })));

  function openCourse(c = null, time = null) {
    editing = c;
    title.textContent = c ? "과목 수정" : `새 과목 · ${sem() ? semName(sem()) : ""}`;
    f.name.value = c?.name ?? "";
    f.professor.value = c?.professor ?? "";
    f.credits.value = c?.credits ?? 3;
    f.grade.value = c?.grade ?? "";
    f.major.checked = !!c?.major;
    color = c?.color || nextColor();
    paintColors();
    timeList.replaceChildren(...(c ? c.times : time ? [time] : []).map(timeRow));
    delBtn.hidden = !c;
    msg.textContent = "";
    dialog.showModal();
    f.name.focus();
  }

  dialog.querySelector("form").onsubmit = async (ev) => {
    ev.preventDefault();
    const times = [...timeList.children].map((r) => r.value());
    const bad = times.find((t) => !t.start || !t.end || t.start >= t.end);
    if (bad) return (msg.textContent = `${DAYS[bad.day]}요일: 끝나는 시간이 시작보다 늦어야 합니다`);
    // 다른 과목과 시간이 겹치면 묻는다(앞으로의 학기 계획이면 일부러 겹칠 수도 있다).
    const clash = semCourses().filter((o) => o.id !== editing?.id && o.times.some((a) => times.some((b) => a.day === b.day && a.start < b.end && b.start < a.end)));
    if (clash.length && !confirm(`${clash.map((o) => o.name).join(", ")}와(과) 시간이 겹칩니다. 그래도 저장할까요?`)) return;
    const body = { name: f.name.value, professor: f.professor.value, credits: Number(f.credits.value), grade: f.grade.value, major: f.major.checked, color, times };
    try {
      if (editing) await call(`/api/courses/${editing.id}`, { method: "PATCH", body });
      else await call("/api/courses", { method: "POST", body: { ...body, semester_id: semId } });
      dialog.close();
      await load();
    } catch (e) {
      msg.textContent = e.message;
    }
  };
  document.body.append(semDialog, dialog);

  return { load, openCourse: () => openCourse() };
}

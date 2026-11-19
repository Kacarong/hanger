// 작업공간(관리) 화면.
const CHUNK = 16 * 1024 * 1024; // must be a multiple of 256 KiB for Drive resumable uploads
// 같은 ?v= 로 불러야 배포 직후 캐시의 옛 편집기와 섞이지 않는다.
const { createEditor } = await import("./notes.js" + new URL(import.meta.url).search);
const $ = (id) => document.getElementById(id);
let me = null;
let categories = [];
let taskKinds = [];

const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z"/>',
  check: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8 12 3 3 5-6"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="16.5" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>',
  note: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/>',
  logout: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M16 7l3 3M14 9l2 2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  upload: '<path d="M12 15V4M7 9l5-5 5 5M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M4 20h16"/>',
  chevrons: '<path d="m8 9 4-4 4 4M8 15l4 4 4-4"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
};
const icon = (name) => {
  const t = document.createElement("template");
  t.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[name]}</svg>`;
  return t.content.firstChild;
};
document.querySelectorAll("[data-icon]").forEach((e) => e.replaceWith(icon(e.dataset.icon)));

function showError(e) {
  $("msg").textContent = e instanceof Error ? e.message : String(e);
}

async function call(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { "Content-Type": "application/json" } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = res.headers.get("Content-Type")?.includes("json") ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error ?? `요청 실패 (${res.status})`);
  return data;
}

function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return e;
}
const iconBtn = (label, iconName, onclick, extra = "") => el("button", { className: `btn ghost sm ${extra}`, type: "button", onclick, title: label, ariaLabel: label }, icon(iconName));
const stat = (label, value, sub, warn = false) =>
  el("div", { className: "stat" }, el("div", { className: "label", textContent: label }), el("div", { className: "value" + (warn ? " warn" : ""), textContent: value }), el("div", { className: "sub", textContent: sub }));
const pill = (text, color) => el("span", { className: `pill ${color}`, textContent: text });
const emptyRow = (cols, text) => el("tr", { className: "empty-row" }, el("td", { colSpan: cols, textContent: text }));

// Segmented control: buttons with data-v. Returns a getter for the current value.
function seg(id, onChange) {
  const box = $(id);
  box.onclick = (ev) => {
    const b = ev.target.closest("button");
    if (!b) return;
    box.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    onChange(b.dataset.v);
  };
  return () => box.querySelector("button.on").dataset.v;
}

const gb = (n) => (Number(n || 0) / 1024 ** 3).toFixed(1) + "GB";
const sizeText = (n) => (n >= 1024 ** 2 ? (n / 1024 ** 2).toFixed(1) + "MB" : Math.ceil(n / 1024) + "KB");

// Sends one byte range straight to Google. Returns the Drive file when the upload is complete,
// the next offset Google confirmed, or next: null when the reply doesn't say (Range hidden by CORS).
async function putRange(url, file, start, end) {
  const res = await fetch(url, { method: "PUT", headers: { "Content-Range": `bytes ${start}-${end - 1}/${file.size}` }, body: file.slice(start, end) });
  if (res.status === 200 || res.status === 201) return { file: await res.json() };
  if (res.status === 308) {
    const range = res.headers.get("Range"); // "bytes=0-1234"
    return { next: range ? Number(range.split("-")[1]) + 1 : null };
  }
  throw new Error(`구글 업로드 오류 (${res.status})`);
}

// The server asks Google directly, so the answer doesn't depend on which headers CORS exposes.
const uploadStatus = (url, file) => call("/api/uploads/status", { method: "POST", body: { uploadUrl: url, size: file.size } });

async function uploadToDrive(url, file, onProgress) {
  let offset = 0;
  let failures = 0;
  for (;;) {
    try {
      let r = await putRange(url, file, offset, Math.min(offset + CHUNK, file.size));
      if (r.next === null) r = await uploadStatus(url, file);
      if (r.file) return r.file;
      offset = r.next;
      failures = 0;
      onProgress(offset / file.size);
    } catch (e) {
      if (++failures > 5) throw e;
      await new Promise((ok) => setTimeout(ok, 1000 * 2 ** failures));
      try {
        // Resume from whatever Google already has.
        const s = await uploadStatus(url, file);
        if (s.file) return s.file;
        offset = s.next;
      } catch {}
    }
  }
}

async function uploadOne(file) {
  const name = el("span", { textContent: `${file.name} · 준비 중` });
  const fill = el("div", { className: "bar-fill" });
  const li = el("li", {}, name, el("div", { className: "bar-track" }, fill));
  $("progress").append(li);
  try {
    const { uploadUrl } = await call("/api/uploads", { method: "POST", body: { name: file.name, size: file.size, mimeType: file.type } });
    const driveFile = await uploadToDrive(uploadUrl, file, (p) => {
      name.textContent = `${file.name} · ${Math.floor(p * 100)}%`;
      fill.style.width = `${p * 100}%`;
    });
    await call("/api/files", {
      method: "POST",
      body: { driveId: driveFile.id, category: $("up-category").value, tags: $("up-tags").value, note: $("up-note").value },
    });
    name.textContent = `${file.name} · 완료`;
    fill.style.width = "100%";
    return true;
  } catch (e) {
    name.textContent = `${file.name} · 실패: ${e.message}`;
    li.className = "error";
    return false;
  }
}

// 클라우드(파일함)
let fileCategory = () => "";
let editingFile = null;

function openFileDialog(f) {
  editingFile = f;
  $("file-title").value = f.title;
  $("file-category").value = f.category;
  $("file-tags").value = f.tags;
  $("file-note").value = f.note;
  $("file-dialog").showModal();
}

async function loadQuota(files) {
  const shared = files.filter((f) => f.shared).length;
  const pub = files.filter((f) => f.public).length;
  const cards = [stat("파일", String(files.length), "이 조건에 맞는 파일"), stat("공개 중", String(pub), `링크 공유 ${shared}개`)];
  if (me.driveConnected) {
    try {
      const q = await call("/api/quota");
      const pct = q.limit ? (Number(q.usage) / Number(q.limit)) * 100 : 0;
      cards.unshift(stat("구글 드라이브", gb(q.usage), `${q.limit ? gb(q.limit) : "무제한"} 중 ${pct.toFixed(0)}% · 휴지통 ${gb(q.usageInDriveTrash)}`, pct >= 90));
    } catch (e) {
      cards.unshift(stat("구글 드라이브", "—", "용량 확인 실패: " + e.message, true));
    }
  } else {
    cards.unshift(stat("구글 드라이브", "—", "연결 안 됨"));
  }
  $("file-stats").replaceChildren(...cards);
}

async function loadList() {
  const params = new URLSearchParams({ q: $("q").value, category: fileCategory() });
  const files = await call("/api/files?" + params);
  loadQuota(files);
  const rows = files.map((f) => {
    const toggle = (kind, on) => call(`/api/files/${f.id}/${kind}`, { method: "POST", body: { [kind === "share" ? "shared" : "public"]: on } }).then(loadList, showError);
    const sw = (checked, onchange) => el("label", { className: "switch" }, el("input", { type: "checkbox", checked, onchange }), el("span"));
    return el(
      "tr",
      {},
      el("td", {}, el("img", { className: "thumb", src: `/thumb/${f.id}`, alt: "", loading: "lazy", onerror() { this.replaceWith(el("div", { className: "thumb-empty" })); } })),
      el("td", {}, el("a", { className: "title", href: f.web_view_link, target: "_blank", rel: "noopener", textContent: f.title }), el("span", { className: "sub", textContent: f.note || f.name })),
      el("td", { className: "hide-sm" }, pill(f.category, f.category === "포트폴리오" ? "blue" : "gray")),
      el("td", { className: "hide-sm" }, ...f.tags.split(",").map((t) => t.trim()).filter(Boolean).map((t) => el("span", { className: "tag", textContent: t }))),
      el("td", { className: "num muted", textContent: sizeText(f.size) }),
      el("td", {}, sw(!!f.shared, function () { toggle("share", this.checked); })),
      el("td", {}, sw(!!f.public, function () { toggle("public", this.checked); })),
      el(
        "td",
        { className: "actions" },
        f.web_content_link ? el("a", { className: "btn ghost sm", href: f.web_content_link, title: "받기" }, icon("download")) : "",
        iconBtn("수정", "edit", () => openFileDialog(f)),
        iconBtn("삭제", "trash", () => {
          if (confirm(`"${f.title}" 을(를) 드라이브 휴지통으로 보낼까요? (30일 뒤 자동 삭제)`)) call(`/api/files/${f.id}`, { method: "DELETE" }).then(loadList, showError);
        }, "danger"),
      ),
    );
  });
  $("list").replaceChildren(...(rows.length ? rows : [emptyRow(8, $("q").value || fileCategory() ? "검색 결과가 없습니다." : "아직 올린 파일이 없습니다.")]));
}

// 할 일·과제
const DAY = 86400_000;
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
const md = (d) => `${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일`;

function taskStatus(t, today) {
  if (t.done) return pill("끝냄", "gray");
  if (!t.due_date) return pill("날짜 없음", "gray");
  const d = daysBetween(today, t.due_date);
  if (d < 0) return pill("지남", "orange");
  if (d === 0) return pill("오늘", "blue");
  if (d <= 3) return pill("임박", "amber");
  return pill("예정", "white");
}

function dueCell(t, today) {
  if (!t.due_date) return el("td", { className: "muted", textContent: "—" });
  const main = el("span", { className: t.done ? "muted" : "date-main", textContent: md(t.due_date) + (t.due_time ? " " + t.due_time : "") });
  if (t.done) return el("td", {}, main);
  const d = daysBetween(today, t.due_date);
  const note = d < 0 ? [`${-d}일 지남`, "warn"] : d === 0 ? ["오늘", "soon"] : [`D-${d}`, d <= 3 ? "soon" : "ok"];
  return el("td", {}, main, el("span", { className: `date-note ${note[1]}`, textContent: note[0] }));
}

function taskRow(t, today, reload, withActions) {
  const update = (patch) => call(`/api/tasks/${t.id}`, { method: "PATCH", body: patch }).then(reload, showError);
  return el(
    "tr",
    {},
    el("td", {}, el("input", { type: "checkbox", checked: !!t.done, title: "끝냄 표시", onchange() { update({ done: this.checked }); } })),
    el(
      "td",
      {},
      el("span", { className: "title" + (t.done ? " done" : ""), textContent: t.title }),
      t.note ? el("span", { className: "sub", textContent: t.note }) : null,
      t.note_id ? el("span", { className: "sub" }, el("a", { href: `#notes/${t.note_id}`, textContent: `노트 · ${t.note_title || "제목 없음"}` })) : null,
    ),
    el("td", { className: "hide-sm" }, pill(t.kind, t.kind === "과제" ? "blue" : "gray")),
    el("td", { className: "hide-sm muted", textContent: t.course || "—" }),
    dueCell(t, today),
    el("td", {}, taskStatus(t, today)),
    withActions
      ? el(
          "td",
          { className: "actions" },
          iconBtn("수정", "edit", () => openTaskDialog(t)),
          iconBtn("삭제", "trash", () => {
            if (confirm(`"${t.title}" 을(를) 삭제할까요?`)) call(`/api/tasks/${t.id}`, { method: "DELETE" }).then(reload, showError);
          }, "danger"),
        )
      : null,
  );
}

let editingTask = null;
function openTaskDialog(t = null, date = "") {
  editingTask = t;
  $("task-dialog-title").textContent = t ? "할 일 수정" : "새 할 일";
  $("task-kind").value = t?.kind ?? taskKinds[0];
  $("task-title").value = t?.title ?? "";
  $("task-course").value = t?.course ?? "";
  $("task-date").value = t?.due_date ?? date;
  $("task-time").value = t?.due_time ?? "";
  $("task-note").value = t?.note ?? "";
  $("task-dialog").showModal();
}

async function loadToday() {
  const t = await call("/api/today");
  const reload = () => loadToday().catch(showError);
  updateOverdueBadge(t.overdue.length);
  const wd = new Intl.DateTimeFormat("ko-KR", { weekday: "long", timeZone: "Asia/Seoul" }).format(new Date(t.date + "T12:00:00+09:00"));
  $("page-title").textContent = `오늘 · ${md(t.date)} ${wd}`;
  $("today-stats").replaceChildren(
    stat("지난 일", String(t.overdue.length), "날짜가 지났는데 안 끝낸 것", t.overdue.length > 0),
    stat("오늘", String(t.today.length), "오늘 날짜의 할 일·과제"),
    stat("다가오는 과제", String(t.upcoming.length), "3일 안에 마감"),
    stat("오늘 끝낸 일", String(t.doneToday.length), "수고했어요"),
  );
  const q = searchText();
  const sections = [
    ["지난 일", t.overdue],
    ["오늘", t.today],
    ["다가오는 과제 (3일 안)", t.upcoming],
    ["오늘 끝낸 일", t.doneToday],
  ]
    .map(([title, items]) => [title, items.filter((x) => matches(x, q))])
    .filter(([, items]) => items.length);
  $("today-list").replaceChildren(
    ...(sections.length
      ? sections.flatMap(([title, items]) => [el("tr", { className: "group-row" }, el("td", { colSpan: 6, textContent: `${title} · ${items.length}` })), ...items.map((x) => taskRow(x, t.date, reload, false))])
      : [emptyRow(6, "오늘 할 일이 없습니다.")]),
  );
}

let taskDone = () => "0";
let taskKind = () => "";
async function loadTasks() {
  const params = new URLSearchParams();
  if (taskDone()) params.set("done", taskDone());
  if (taskKind()) params.set("kind", taskKind());
  const [tasks, all, today] = await Promise.all([call("/api/tasks?" + params), call("/api/tasks?done=0"), call("/api/today")]);
  updateOverdueBadge(today.overdue.length);
  const reload = () => loadTasks().catch(showError);
  const left = (k) => all.filter((x) => x.kind === k).length;
  $("task-stats").replaceChildren(
    stat("남은 할 일", String(left("할 일")), "안 끝낸 할 일"),
    stat("남은 과제", String(left("과제")), `3일 안 마감 ${today.upcoming.length}개`),
    stat("지난 일", String(today.overdue.length), "날짜가 지났는데 안 끝낸 것", today.overdue.length > 0),
  );
  const q = searchText();
  const shown = tasks.filter((x) => matches(x, q));
  $("task-list").replaceChildren(...(shown.length ? shown.map((x) => taskRow(x, today.date, reload, true)) : [emptyRow(7, q ? "검색 결과가 없습니다." : "없습니다.")]));
}

// 캘린더: 한 달(6주) 칸에 구글 캘린더 일정과 날짜 있는 할 일·과제를 함께 보여 준다.
const seoulToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
const isoDay = (d) => d.toISOString().slice(0, 10);
const plusDays = (date, n) => isoDay(new Date(Date.parse(date + "T00:00:00Z") + n * DAY));
let calMonth = seoulToday().slice(0, 7); // YYYY-MM

function moveMonth(n) {
  const d = new Date(calMonth + "-01T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + n);
  calMonth = isoDay(d).slice(0, 7);
  loadCalendar().catch(showError);
}

async function loadCalendar() {
  const first = calMonth + "-01";
  const from = plusDays(first, -new Date(first + "T00:00:00Z").getUTCDay()); // the Sunday on or before the 1st
  const to = plusDays(from, 41);
  const month = calMonth;
  const data = await call(`/api/calendar?from=${from}&to=${to}`);
  if (month !== calMonth) return; // a newer month was asked for meanwhile
  const today = seoulToday();
  const reload = () => loadCalendar().catch(showError);
  $("cal-month").textContent = `${Number(month.slice(0, 4))}년 ${Number(month.slice(5))}월`;
  const google = $("cal-google");
  google.className = data.google === "error" ? "error" : "muted";
  google.replaceChildren(
    ...({
      ok: ["구글 캘린더 연결됨"],
      off: ["구글 캘린더 연결 안 됨"],
      need_consent: ["구글 캘린더 권한이 없습니다. ", el("a", { href: "/auth/login", className: "date-main", textContent: "구글로 다시 로그인" })],
      error: ["구글 캘린더를 불러오지 못했습니다: " + data.error],
    }[data.google] ?? []),
  );

  const q = searchText();
  const byDay = new Map();
  const put = (day, item) => (byDay.get(day) ?? byDay.set(day, []).get(day)).push(item);
  for (const e of data.events) {
    if (q && !e.title.toLowerCase().includes(q)) continue;
    for (let d = e.startDate < from ? from : e.startDate; d <= e.endDate && d <= to; d = plusDays(d, 1)) {
      put(d, { sort: d === e.startDate && e.time ? e.time : "", node: () => eventItem(e, d) });
    }
  }
  for (const t of data.tasks) if (matches(t, q)) put(t.due_date, { sort: t.due_time ?? "~", node: () => taskItem(t, today, reload) });

  const heads = ["일", "월", "화", "수", "목", "금", "토"].map((w) => el("div", { className: "cal-head", textContent: w }));
  const days = [];
  for (let i = 0; i < 42; i++) {
    const d = plusDays(from, i);
    const items = (byDay.get(d) ?? []).sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0));
    const cls = "cal-day" + (d.slice(0, 7) !== month ? " other" : "") + (d === today ? " today" : "");
    days.push(
      el(
        "div",
        { className: cls, title: `${md(d)}에 할 일 추가`, onclick: (ev) => ev.target === ev.currentTarget || ev.target.classList.contains("cal-num") ? openTaskDialog(null, d) : null },
        el("span", { className: "cal-num", textContent: Number(d.slice(8)) }),
        ...items.map((x) => x.node()),
      ),
    );
  }
  $("cal-grid").replaceChildren(...heads, ...days);
}

// 구글 일정은 눌러서 구글 캘린더에서 연다. 여러 날 일정의 시간은 첫날에만 쓴다.
function eventItem(e, day) {
  const time = e.time && day === e.startDate ? e.time : "";
  return el(
    "a",
    { className: "cal-item", href: e.link || "https://calendar.google.com/", target: "_blank", rel: "noopener", title: `${e.title}${time ? " · " + time : ""}${e.calendar ? " · " + e.calendar : ""}` },
    el("i", { className: "dot", style: e.color ? `background:${e.color}` : "" }),
    time ? el("span", { className: "t", textContent: time }) : null,
    el("span", { textContent: e.title }),
  );
}

function taskItem(t, today, reload) {
  const late = !t.done && t.due_date < today;
  return el(
    "button",
    { type: "button", className: `cal-item task${t.kind === "과제" ? " hw" : ""}${t.done ? " done" : ""}${late ? " late" : ""}`, title: `${t.kind}${t.course ? " · " + t.course : ""} · ${t.title}`, onclick: () => openTaskDialog(t) },
    el("i", { className: "dot" }),
    t.due_time ? el("span", { className: "t", textContent: t.due_time }) : null,
    el("span", { textContent: (t.course ? `[${t.course}] ` : "") + t.title }),
  );
}

function updateOverdueBadge(n) {
  $("nav-overdue").hidden = !n;
  $("nav-overdue").textContent = n;
}

// 노트: 고치면 잠깐 뒤 저장한다. 화면을 옮기거나 창을 닫을 때도 남은 것을 저장한다.
let editor = null;
let noteId = null; // the open note
let noteDirty = false;
let noteSaving = null; // the save in flight
let noteTimer;
let focusTitle = false;
const noteTime = (s) => new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(s.replace(" ", "T") + "Z"));

function noteChanged() {
  noteDirty = true;
  $("note-status").textContent = "저장 전";
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => saveNote().catch(() => {}), 700);
}

async function saveNote(keepalive = false) {
  clearTimeout(noteTimer);
  while (noteSaving) await noteSaving.catch(() => {});
  if (!noteDirty || noteId === null) return;
  noteDirty = false;
  const id = noteId;
  const title = $("note-title").value;
  $("note-status").textContent = "저장 중…";
  noteSaving = call(`/api/notes/${id}`, { method: "PUT", body: { title, blocks: editor.get() }, keepalive });
  try {
    const r = await noteSaving;
    if (id !== noteId) return;
    if (!noteDirty) $("note-status").textContent = "저장됨";
    const a = document.querySelector(`#note-list a[data-id="${id}"]`);
    if (a) a.replaceChildren(title || "제목 없음", el("small", { textContent: noteTime(r.updated_at) }));
  } catch (e) {
    if (id === noteId) {
      noteDirty = true; // 다음에 고치거나 화면을 옮길 때 다시 저장한다
      $("note-status").textContent = "저장 실패: " + e.message;
    }
    throw e;
  } finally {
    noteSaving = null;
  }
}

async function loadNoteList() {
  const list = await call("/api/notes?" + new URLSearchParams({ q: searchText() }));
  $("note-list").replaceChildren(
    ...(list.length
      ? list.map((n) => {
          const a = el("a", { href: `#notes/${n.id}`, className: n.id === noteId ? "active" : "" }, n.title || "제목 없음", el("small", { textContent: noteTime(n.updated_at) }));
          a.dataset.id = n.id;
          return a;
        })
      : [el("span", { className: "muted", textContent: searchText() ? "검색 결과가 없습니다." : "노트가 없습니다." })]),
  );
  return list;
}

// 열 노트: 주소(#notes/3) → 지금 연 노트 → 지난번 노트 → 맨 위 노트. 늘 서버에서 새로 읽는다(오늘 화면에서 체크했을 수 있다).
async function loadNotes() {
  await saveNote().catch(() => {});
  const list = await loadNoteList();
  const wanted = [Number(location.hash.split("/")[1]), noteId, Number(localStorage.getItem("note")), list[0]?.id].filter(Boolean);
  let note = null;
  for (const id of new Set(wanted)) {
    note = await call(`/api/notes/${id}`).catch(() => null);
    if (note) break;
  }
  noteId = note?.id ?? null;
  noteDirty = false;
  $("note-page").hidden = !note;
  $("note-empty").hidden = !!note;
  $("note-delete").hidden = !note;
  document.querySelectorAll("#note-list a").forEach((a) => a.classList.toggle("active", Number(a.dataset.id) === noteId));
  if (!note) return localStorage.removeItem("note");
  localStorage.setItem("note", note.id);
  $("note-title").value = note.title;
  $("note-status").textContent = "저장됨";
  editor.set(note.blocks);
  if (focusTitle) $("note-title").focus();
  focusTitle = false;
}

async function newNote() {
  await saveNote().catch(() => {});
  const n = await call("/api/notes", { method: "POST", body: {} });
  focusTitle = true;
  location.hash = `#notes/${n.id}`;
}

async function deleteNote() {
  if (noteId === null || !confirm(`"${$("note-title").value || "제목 없음"}" 노트를 삭제할까요? 이 노트에서 만든 할 일도 함께 지워집니다.`)) return;
  clearTimeout(noteTimer);
  noteDirty = false;
  await call(`/api/notes/${noteId}`, { method: "DELETE" });
  noteId = null;
  localStorage.removeItem("note");
  if (location.hash === "#notes") await loadNotes();
  else location.hash = "#notes";
}

// 검색: 할 일은 화면에서 거르고, 파일은 서버에 묻는다.
const searchText = () => $("global-search").value.trim().toLowerCase();
const matches = (t, q) => !q || [t.title, t.course, t.note].some((v) => (v ?? "").toLowerCase().includes(q));

const tabs = {
  today: { title: "오늘", load: () => loadToday(), actions: () => [newTaskBtn()] },
  tasks: { title: "할 일·과제", load: () => loadTasks(), actions: () => [newTaskBtn()] },
  calendar: { title: "캘린더", load: () => loadCalendar(), actions: () => [newTaskBtn()] },
  notes: {
    title: "노트",
    load: () => loadNotes(),
    actions: () => [
      el("button", { className: "btn ghost danger", type: "button", id: "note-delete", title: "노트 삭제", ariaLabel: "노트 삭제", hidden: true, onclick: () => deleteNote().catch(showError) }, icon("trash")),
      el("button", { className: "btn primary", type: "button", onclick: () => newNote().catch(showError) }, icon("plus"), "새 노트", el("kbd", { textContent: "N" })),
    ],
  },
  files: {
    title: "클라우드",
    load: () => {
      $("drive-off").hidden = me.driveConnected;
      return loadList();
    },
    actions: () => (me.driveConnected ? [el("button", { className: "btn primary", type: "button", onclick: openUpload }, icon("upload"), "올리기", el("kbd", { textContent: "U" }))] : []),
  },
};
const newTaskBtn = () => el("button", { className: "btn primary", type: "button", onclick: () => openTaskDialog() }, icon("plus"), "새 할 일", el("kbd", { textContent: "N" }));

function openUpload() {
  $("progress").replaceChildren();
  $("upload-dialog").showModal();
}

function showPicked() {
  const files = [...$("files").files];
  $("drop-text").textContent = !files.length
    ? "파일을 여기로 끌어다 놓거나 눌러서 고르세요"
    : files.length === 1 ? files[0].name : `${files[0].name} 외 ${files.length - 1}개`;
}

// 파일함 화면 어디에 끌어다 놓아도 올리기 창이 열리고 그 파일들이 골라진다.
function setupDrop() {
  // 파일을 끌어다 놓을 때 브라우저가 그 파일을 열어 버리지 않게(업로드 중이면 끊긴다) 기본 동작은 늘 막고,
  // 받을 수 있을 때만 골라 넣는다.
  const isFiles = (ev) => ev.dataTransfer?.types.includes("Files");
  const canDrop = () => currentTab() === "files" && me.driveConnected && !$("upload-btn").disabled;
  document.addEventListener("dragover", (ev) => {
    if (!isFiles(ev)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = canDrop() ? "copy" : "none";
    document.body.classList.toggle("dragging", canDrop());
  });
  document.addEventListener("dragleave", (ev) => {
    if (!ev.relatedTarget) document.body.classList.remove("dragging"); // pointer left the window
  });
  document.addEventListener("drop", (ev) => {
    document.body.classList.remove("dragging");
    if (!isFiles(ev)) return;
    ev.preventDefault();
    if (!canDrop() || !ev.dataTransfer.files.length) return;
    if (!$("upload-dialog").open) openUpload();
    $("files").files = ev.dataTransfer.files;
    showPicked();
  });
}

const currentTab = () => {
  const name = location.hash.slice(1).split("/")[0];
  return name in tabs ? name : "today";
};
function showTab() {
  const name = currentTab();
  for (const key of Object.keys(tabs)) $(`tab-${key}`).hidden = key !== name;
  document.querySelectorAll(".nav-item[data-tab]").forEach((a) => a.classList.toggle("active", a.dataset.tab === name));
  $("main").classList.remove("nav-open");
  $("page-title").textContent = tabs[name].title;
  $("bar-actions").replaceChildren(...tabs[name].actions());
  $("msg").textContent = "";
  editor.closeMenu();
  // 노트를 저장하고 나서 읽어야 방금 노트에서 바꾼 할 일이 보인다.
  saveNote()
    .catch(() => {})
    .then(() => tabs[name].load())
    .catch(showError);
}

async function init() {
  me = await call("/api/me");
  if (!me.admin) {
    $("login").hidden = false;
    $("google-login").hidden = !me.googleEnabled;
    $("password-login").onsubmit = (ev) => {
      ev.preventDefault();
      call("/auth/password", { method: "POST", body: { password: $("password").value } }).then(
        () => location.reload(),
        (e) => ($("login-msg").textContent = e.message),
      );
    };
    return;
  }
  categories = me.categories;
  taskKinds = me.taskKinds;
  $("main").hidden = false;
  const opts = (list) => list.map((v) => el("option", { value: v, textContent: v }));
  $("task-kind").append(...opts(taskKinds));
  $("up-category").append(...opts(categories));
  $("file-category").append(...opts(categories));
  editor = createEditor($("note-editor"), noteChanged);
  $("note-title").oninput = noteChanged;
  $("note-title").onkeydown = (ev) => {
    if (ev.key !== "Enter" || ev.isComposing || ev.keyCode === 229) return;
    ev.preventDefault();
    editor.focusFirst();
  };
  addEventListener("pagehide", () => saveNote(true).catch(() => {}));
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && saveNote(true).catch(() => {}));
  $("task-filter-kind").append(...taskKinds.map((k) => el("button", { type: "button", textContent: k })));
  $("task-filter-kind").querySelectorAll("button").forEach((b, i) => i && (b.dataset.v = taskKinds[i - 1]));
  $("filter-category").append(...categories.map((c) => el("button", { type: "button", textContent: c })));
  $("filter-category").querySelectorAll("button").forEach((b, i) => i && (b.dataset.v = categories[i - 1]));

  taskDone = seg("task-filter-done", () => loadTasks().catch(showError));
  taskKind = seg("task-filter-kind", () => loadTasks().catch(showError));
  fileCategory = seg("filter-category", () => loadList().catch(showError));

  // 취소·닫기는 submit 버튼이 아니어야 Enter가 저장·올리기로 간다.
  document.querySelectorAll("dialog [data-close]").forEach((b) => (b.onclick = () => b.closest("dialog").close()));
  $("task-form").onsubmit = async (ev) => {
    ev.preventDefault();
    const body = { kind: $("task-kind").value, title: $("task-title").value, course: $("task-course").value, due_date: $("task-date").value, due_time: $("task-time").value, note: $("task-note").value };
    try {
      if (editingTask) await call(`/api/tasks/${editingTask.id}`, { method: "PATCH", body });
      else await call("/api/tasks", { method: "POST", body });
      $("task-dialog").close();
      tabs[currentTab()].load().catch(showError);
    } catch (e) {
      showError(e);
    }
  };
  $("file-form").onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      await call(`/api/files/${editingFile.id}`, { method: "PATCH", body: { title: $("file-title").value, category: $("file-category").value, tags: $("file-tags").value, note: $("file-note").value } });
      $("file-dialog").close();
      await loadList();
    } catch (e) {
      showError(e);
    }
  };
  $("upload").onsubmit = async (ev) => {
    ev.preventDefault();
    const files = [...$("files").files];
    if (!files.length) return $("progress").replaceChildren(el("li", { className: "error", textContent: "올릴 파일을 골라 주세요." }));
    const tooBig = files.filter((f) => f.size >= me.maxFileSize);
    if (tooBig.length) return $("progress").replaceChildren(el("li", { className: "error", textContent: "1GB 미만 파일만 올릴 수 있습니다: " + tooBig.map((f) => f.name).join(", ") }));
    $("upload-btn").disabled = true;
    $("progress").replaceChildren();
    let ok = true;
    for (const f of files) ok = (await uploadOne(f)) && ok; // one at a time to keep bandwidth predictable
    $("upload-btn").disabled = false;
    $("files").value = "";
    showPicked();
    if (ok) $("upload-dialog").close(); // 실패가 있으면 이유를 볼 수 있게 창을 남긴다.
    loadList().catch(showError);
  };
  $("files").onchange = showPicked;
  setupDrop();
  $("search").onsubmit = (ev) => {
    ev.preventDefault();
    loadList().catch(showError);
  };

  // 사이드바 검색: 파일함에서는 파일 검색, 그 밖에서는 할 일 거르기.
  let searchTimer;
  $("global-search").oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      if (currentTab() === "files") {
        $("q").value = $("global-search").value;
        loadList().catch(showError);
      } else if (currentTab() === "notes") loadNoteList().catch(showError);
      else tabs[currentTab()].load().catch(showError);
    }, 200);
  };
  document.addEventListener("keydown", (ev) => {
    if (ev.target.closest?.("input, textarea, select, dialog") || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.key === "/") (ev.preventDefault(), $("global-search").focus());
    else if (ev.key.toLowerCase() === "n" && currentTab() === "notes") (ev.preventDefault(), newNote().catch(showError));
    else if (ev.key.toLowerCase() === "n" && currentTab() !== "files") (ev.preventDefault(), openTaskDialog());
    else if (ev.key.toLowerCase() === "u" && currentTab() === "files" && me.driveConnected) (ev.preventDefault(), openUpload());
  });
  $("cal-prev").onclick = () => moveMonth(-1);
  $("cal-next").onclick = () => moveMonth(1);
  $("cal-today").onclick = () => {
    calMonth = seoulToday().slice(0, 7);
    loadCalendar().catch(showError);
  };
  $("menu-btn").onclick = () => $("main").classList.toggle("nav-open");
  $("change-password").onclick = () => {
    $("pw-current-row").hidden = me.loginMethod !== "password"; // a Google login already proved who you are
    $("pw-current").required = me.loginMethod === "password";
    $("password-form").reset();
    $("pw-msg").textContent = "";
    $("password-dialog").showModal();
  };
  $("password-form").onsubmit = async (ev) => {
    ev.preventDefault();
    if ($("pw-new").value !== $("pw-new2").value) return ($("pw-msg").textContent = "새 비밀번호 두 칸이 다릅니다.");
    try {
      await call("/api/password", { method: "POST", body: { current: $("pw-current").value, password: $("pw-new").value } });
      $("password-dialog").close();
      $("msg").textContent = "비밀번호를 바꿨습니다. 다른 기기의 로그인은 모두 풀렸습니다.";
    } catch (e) {
      $("pw-msg").textContent = e.message;
    }
  };
  $("logout").onclick = () => call("/auth/logout", { method: "POST" }).then(() => location.reload());

  window.onhashchange = showTab;
  showTab();
}

init().catch(showError);

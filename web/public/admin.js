// 관리 화면. 디자인 없이 기능만 둔다.
const CHUNK = 16 * 1024 * 1024; // must be a multiple of 256 KiB for Drive resumable uploads
const $ = (id) => document.getElementById(id);
let categories = [];
let taskKinds = [];

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

const gb = (n) => (Number(n || 0) / 1024 ** 3).toFixed(1) + "GB";
const sizeText = (n) => (n >= 1024 ** 2 ? (n / 1024 ** 2).toFixed(1) + "MB" : Math.ceil(n / 1024) + "KB");

async function loadQuota() {
  try {
    const q = await call("/api/quota");
    const pct = q.limit ? (Number(q.usage) / Number(q.limit)) * 100 : 0;
    $("quota").textContent =
      `구글 드라이브 ${gb(q.usage)} / ${q.limit ? gb(q.limit) : "무제한"} 사용 (휴지통 ${gb(q.usageInDriveTrash)})` +
      (pct >= 90 ? " ⚠ 용량이 90% 넘게 찼습니다" : "");
  } catch (e) {
    $("quota").textContent = "용량 확인 실패: " + e.message;
  }
}

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
  const li = document.createElement("li");
  li.textContent = `${file.name}: 준비 중`;
  $("progress").append(li);
  try {
    const { uploadUrl } = await call("/api/uploads", { method: "POST", body: { name: file.name, size: file.size, mimeType: file.type } });
    const driveFile = await uploadToDrive(uploadUrl, file, (p) => (li.textContent = `${file.name}: ${Math.floor(p * 100)}%`));
    await call("/api/files", {
      method: "POST",
      body: { driveId: driveFile.id, category: $("up-category").value, tags: $("up-tags").value, note: $("up-note").value },
    });
    li.textContent = `${file.name}: 완료`;
  } catch (e) {
    li.textContent = `${file.name}: 실패 - ${e.message}`;
    li.className = "error";
  }
}

function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}

function categorySelect(value, onChange) {
  const s = el("select", { onchange: () => onChange(s.value) }, ...categories.map((c) => el("option", { value: c, textContent: c, selected: c === value })));
  return s;
}

async function loadList() {
  const params = new URLSearchParams({ q: $("q").value, category: $("filter-category").value });
  const files = await call("/api/files?" + params);
  const rows = files.map((f) => {
    const update = (patch) => call(`/api/files/${f.id}`, { method: "PATCH", body: patch }).then(loadList, showError);
    const toggle = (kind, on) => call(`/api/files/${f.id}/${kind}`, { method: "POST", body: { [kind === "share" ? "shared" : "public"]: on } }).then(loadList, showError);
    return el(
      "tr",
      {},
      el("td", {}, el("img", { src: `/thumb/${f.id}`, alt: "", loading: "lazy", onerror() { this.remove(); } })),
      el("td", {}, el("a", { href: f.web_view_link, target: "_blank", rel: "noopener", textContent: f.title }), el("br"), el("small", { textContent: f.name })),
      el(
        "td",
        {},
        categorySelect(f.category, (c) => update({ category: c })),
        el("div", { textContent: f.tags ? "#" + f.tags : "" }),
        el("div", { textContent: f.note }),
        el("button", {
          textContent: "수정",
          onclick() {
            const title = prompt("제목", f.title);
            if (title === null) return;
            const tags = prompt("태그 (쉼표로 구분)", f.tags);
            if (tags === null) return;
            const note = prompt("메모", f.note);
            if (note === null) return;
            update({ title, tags, note });
          },
        }),
      ),
      el("td", { textContent: sizeText(f.size) }),
      el("td", {}, el("label", {}, el("input", { type: "checkbox", checked: !!f.shared, onchange() { toggle("share", this.checked); } }), " 링크 공유")),
      el("td", {}, el("label", {}, el("input", { type: "checkbox", checked: !!f.public, onchange() { toggle("public", this.checked); } }), " 공개")),
      el(
        "td",
        {},
        f.web_content_link ? el("a", { href: f.web_content_link, textContent: "받기" }) : "",
        " ",
        el("button", {
          textContent: "삭제",
          onclick() {
            if (confirm(`"${f.title}" 을(를) 드라이브 휴지통으로 보낼까요? (30일 뒤 자동 삭제)`)) call(`/api/files/${f.id}`, { method: "DELETE" }).then(loadList, showError);
          },
        }),
      ),
    );
  });
  $("list").replaceChildren(...rows);
}

// 할 일·과제
const DAY = 86400_000;
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

function taskItem(t, today, reload) {
  const update = (patch) => call(`/api/tasks/${t.id}`, { method: "PATCH", body: patch }).then(reload, showError);
  let when = t.due_date ? t.due_date + (t.due_time ? " " + t.due_time : "") : "날짜 없음";
  if (t.kind === "과제" && t.due_date && !t.done) {
    const d = daysBetween(today, t.due_date);
    when += d > 0 ? ` (D-${d})` : d === 0 ? " (오늘 마감)" : ` (${-d}일 지남)`;
  }
  return el(
    "li",
    {},
    el("label", { className: t.done ? "done" : "" }, el("input", { type: "checkbox", checked: !!t.done, onchange() { update({ done: this.checked }); } }), " ", t.title),
    el("small", { textContent: [t.kind, t.course, when].filter(Boolean).join(" · ") }),
    t.note ? el("div", {}, el("small", { textContent: t.note })) : "",
  );
}

async function loadToday() {
  const t = await call("/api/today");
  const reload = () => loadToday().catch(showError);
  $("today-date").textContent = `${t.date} 오늘`;
  const sections = [
    ["지난 일", t.overdue],
    ["오늘", t.today],
    ["다가오는 과제 (3일 안)", t.upcoming],
    ["오늘 끝낸 일", t.doneToday],
  ].filter(([, items]) => items.length);
  $("today-lists").replaceChildren(
    ...(sections.length
      ? sections.flatMap(([title, items]) => [el("h3", { textContent: title }), el("ul", { className: "tasks" }, ...items.map((x) => taskItem(x, t.date, reload)))])
      : [el("p", { textContent: "오늘 할 일이 없습니다." })]),
  );
}

async function loadTasks() {
  const params = new URLSearchParams();
  if ($("task-filter-done").value) params.set("done", $("task-filter-done").value);
  if ($("task-filter-kind").value) params.set("kind", $("task-filter-kind").value);
  const [tasks, { date }] = await Promise.all([call("/api/tasks?" + params), call("/api/today")]);
  const reload = () => loadTasks().catch(showError);
  $("task-list").replaceChildren(
    ...tasks.map((t) => {
      const li = taskItem(t, date, reload);
      li.append(
        " ",
        el("button", {
          textContent: "수정",
          onclick() {
            const title = prompt("제목", t.title);
            if (title === null) return;
            const due_date = prompt("날짜 (YYYY-MM-DD, 비우면 날짜 없음)", t.due_date ?? "");
            if (due_date === null) return;
            const due_time = prompt("시간 (HH:MM, 비우면 없음)", t.due_time ?? "");
            if (due_time === null) return;
            const course = prompt("과목", t.course);
            if (course === null) return;
            const note = prompt("메모", t.note);
            if (note === null) return;
            call(`/api/tasks/${t.id}`, { method: "PATCH", body: { title, due_date, due_time, course, note } }).then(reload, showError);
          },
        }),
        " ",
        el("button", {
          textContent: "삭제",
          onclick() {
            if (confirm(`"${t.title}" 을(를) 삭제할까요?`)) call(`/api/tasks/${t.id}`, { method: "DELETE" }).then(reload, showError);
          },
        }),
      );
      return li;
    }),
  );
  if (!tasks.length) $("task-list").append(el("li", { textContent: "없습니다." }));
}

const tabs = {
  today: () => loadToday(),
  tasks: () => loadTasks(),
  files: async () => {
    loadQuota();
    await loadList();
  },
};

function showTab() {
  const name = location.hash.slice(1) in tabs ? location.hash.slice(1) : "today";
  for (const key of Object.keys(tabs)) $(`tab-${key}`).hidden = key !== name;
  $("msg").textContent = "";
  tabs[name]().catch(showError);
}

async function init() {
  const me = await call("/api/me");
  if (!me.admin) {
    $("login").hidden = false;
    $("google-login").hidden = !me.googleEnabled;
    $("password-login").onsubmit = (ev) => {
      ev.preventDefault();
      call("/auth/password", { method: "POST", body: { password: $("password").value } }).then(() => location.reload(), showError);
    };
    return;
  }
  categories = me.categories;
  taskKinds = me.taskKinds;
  $("main").hidden = false;
  $("task-kind").append(...taskKinds.map((k) => el("option", { value: k, textContent: k })));
  $("task-filter-kind").append(...taskKinds.map((k) => el("option", { value: k, textContent: k })));
  $("task-filter-done").onchange = $("task-filter-kind").onchange = () => loadTasks().catch(showError);
  $("task-add").onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      await call("/api/tasks", {
        method: "POST",
        body: { kind: $("task-kind").value, title: $("task-title").value, course: $("task-course").value, due_date: $("task-date").value, due_time: $("task-time").value, note: $("task-note").value },
      });
      for (const id of ["task-title", "task-course", "task-date", "task-time", "task-note"]) $(id).value = "";
      await loadTasks();
    } catch (e) {
      showError(e);
    }
  };
  $("up-category").append(...categories.map((c) => el("option", { value: c, textContent: c })));
  $("filter-category").append(...categories.map((c) => el("option", { value: c, textContent: c })));

  $("upload").onsubmit = async (ev) => {
    ev.preventDefault();
    const files = [...$("files").files];
    const tooBig = files.filter((f) => f.size >= me.maxFileSize);
    if (tooBig.length) return showError("1GB 미만 파일만 올릴 수 있습니다: " + tooBig.map((f) => f.name).join(", "));
    for (const f of files) await uploadOne(f); // one at a time to keep bandwidth predictable
    $("files").value = "";
    loadList().catch(showError);
    loadQuota();
  };
  $("search").onsubmit = (ev) => {
    ev.preventDefault();
    loadList().catch(showError);
  };
  $("logout").onclick = () => call("/auth/logout", { method: "POST" }).then(() => location.reload());

  window.onhashchange = showTab;
  showTab();
}

init().catch(showError);

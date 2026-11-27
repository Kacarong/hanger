// 작업공간(관리) 화면.
const CHUNK = 16 * 1024 * 1024; // must be a multiple of 256 KiB for Drive resumable uploads
// 같은 ?v= 로 불러야 배포 직후 캐시의 옛 편집기와 섞이지 않는다.
const { createEditor, merge3 } = await import("./notes.js" + new URL(import.meta.url).search);
const $ = (id) => document.getElementById(id);
let me = null;
let categories = [];
let taskKinds = [];
let taskCategories = [];

const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z"/>',
  check: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8 12 3 3 5-6"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="16.5" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>',
  note: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/>',
  logout: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  upload: '<path d="M12 15V4M7 9l5-5 5 5M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M4 20h16"/>',
  grip: '<g fill="currentColor" stroke="none"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></g>',
  chevrons: '<path d="m8 9 4-4 4 4M8 15l4 4 4-4"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  clip: '<path d="m20 11-8.5 8.5a5 5 0 0 1-7-7L13 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L14 7"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  up: '<path stroke-width="2.4" d="m6 15 6-6 6 6"/>',
  left: '<path d="m15 5-7 7 7 7"/>',
  right: '<path d="m9 5 7 7-7 7"/>',
  down: '<path stroke-width="2.4" d="m6 9 6 6 6-6"/>',
  exam: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V2.5h6V4M9 10h6M9 14h6M9 18h3"/>',
  book: '<path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H20v15H5.5A1.5 1.5 0 0 0 4 19.5z"/><path d="M4 19.5A1.5 1.5 0 0 0 5.5 21H20v-3"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  grid: '<rect x="3.5" y="4" width="17" height="16" rx="1.5"/><path d="M3.5 9h17M9 4v16M14.5 4v16"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v11h14V9M10 13h4"/>',
  wallet: '<path d="M4 7.5A1.5 1.5 0 0 1 5.5 6H19a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5.5A1.5 1.5 0 0 1 4 18.5z"/><path d="M4 7.5 15 4v2M15 13h3"/>',
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
  if (!res.ok) throw Object.assign(new Error(data?.error ?? `요청 실패 (${res.status})`), { status: res.status });
  return data;
}

function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return e;
}
const iconBtn = (label, iconName, onclick, extra = "") => el("button", { className: `btn ghost sm ${extra}`, type: "button", onclick, title: label, ariaLabel: label }, icon(iconName));
const stat = (label, value, sub, warn = false) =>
  el("div", { className: "stat" }, el("div", { className: "label", textContent: label }), el("div", { className: "value" + (warn ? " warn" : ""), textContent: value }), sub ? el("div", { className: "sub", textContent: sub }) : null);
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
const sizeText = (n) => (n >= 1024 ** 3 ? gb(n) : n >= 1024 ** 2 ? (n / 1024 ** 2).toFixed(1) + "MB" : Math.ceil(n / 1024) + "KB");
const fileUrl = (f) => `/api/files/${f.id}/content`; // opens images, video, PDF, ... in place; anything else downloads

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

function progressLine(file, list, text) {
  const name = el("span", { textContent: `${file.name} · ${text}` });
  const fill = el("div", { className: "bar-fill" });
  const li = el("li", {}, name, el("div", { className: "bar-track" }, fill));
  list.append(li);
  return { li, name, fill };
}

// Uploads one file into the 파일함 (meta.folderId, or the top) with its progress line in `list`
// (or the given line made earlier by progressLine). Returns the new file row, or null on failure.
async function uploadOne(file, list, meta, line = progressLine(file, list, "준비 중")) {
  const { li, name, fill } = line;
  name.textContent = `${file.name} · 준비 중`;
  try {
    const { uploadUrl } = await call("/api/uploads", { method: "POST", body: { name: file.name, size: file.size, mimeType: file.type, folderId: meta.folderId ?? null } });
    const driveFile = await uploadToDrive(uploadUrl, file, (p) => {
      name.textContent = `${file.name} · ${Math.floor(p * 100)}%`;
      fill.style.width = `${p * 100}%`;
    });
    const row = await call("/api/files", { method: "POST", body: { driveId: driveFile.id, ...meta } });
    name.textContent = `${file.name} · 완료`;
    fill.style.width = "100%";
    return row;
  } catch (e) {
    name.textContent = `${file.name} · 실패: ${e.message}`;
    li.className = "error";
    return null;
  }
}

// 클라우드 첨부: 노트·할 일·포트폴리오에 파일함의 파일을 붙인다(파일은 파일함에 그대로 있고 떼면 연결만 없어진다).
// 아직 저장 안 한 새 할 일·항목은 고른 파일을 들고 있다가 저장할 때 붙인다(flush).
function attachBox(box, target, label = "첨부 파일") {
  let id = null; // null: not saved yet
  let shown = 0; // goes up whenever the box switches to another note/task
  let files = [];
  let category = () => "기타"; // for files uploaded from here
  let uploads = Promise.resolve();
  const err = el("span", { className: "error" });
  const progress = el("ul", { className: "progress" });
  const input = el("input", { type: "file", multiple: true, hidden: true });
  const fail = (e) => (err.textContent = e.message);

  const self = {
    has: (fileId) => files.some((f) => f.id === fileId),
    async show(newId, cat = () => "기타") {
      const n = ++shown;
      id = newId;
      category = cat;
      files = [];
      err.textContent = "";
      progress.replaceChildren();
      render();
      if (id === null) return;
      const list = await call(`/api/attachments?${target}=${id}`).catch(fail);
      if (n === shown && list) (files = list), render();
    },
    // Files without attachment_id are waiting (picked before the task was saved, or left by a failed save).
    // A reply that arrives after the box moved on to another note/task must not touch what is shown now.
    async attach(f) {
      if (self.has(f.id)) return;
      if (id === null) return files.push(f), render();
      const n = shown;
      const list = await call("/api/attachments", { method: "POST", body: { [target]: id, fileId: f.id } });
      if (n === shown) (files = [...list, ...files.filter((x) => !x.attachment_id)]), render();
    },
    // Attaches the waiting files to the saved task (after uploads still running). Call on every save:
    // when it fails, the files not yet attached stay waiting and the next save tries them again.
    async flush(taskId) {
      const n = shown;
      await uploads;
      if (n !== shown) return;
      id = taskId;
      const waiting = files.filter((f) => !f.attachment_id);
      try {
        for (let i = 0; i < waiting.length; i++) {
          let list;
          try {
            list = await call("/api/attachments", { method: "POST", body: { [target]: id, fileId: waiting[i].id } });
          } catch (e) {
            if (e.status !== 409) throw e; // 409: an earlier try got it attached after all
            list = await call(`/api/attachments?${target}=${id}`);
          }
          if (n !== shown) return;
          files = [...list, ...waiting.slice(i + 1)];
          render();
        }
      } catch (e) {
        if (n === shown) render(), fail(e);
        throw e;
      }
    },
  };

  async function detach(f) {
    const n = shown;
    if (f.attachment_id) await call(`/api/attachments/${f.attachment_id}`, { method: "DELETE" });
    if (n !== shown) return;
    files = files.filter((x) => x.id !== f.id);
    render();
  }

  input.onchange = () => {
    const picked = [...input.files];
    input.value = "";
    const tooBig = picked.filter((f) => f.size >= me.maxFileSize);
    if (tooBig.length) return (err.textContent = "1GB 미만 파일만 올릴 수 있습니다: " + tooBig.map((f) => f.name).join(", "));
    err.textContent = "";
    const [n, forId] = [shown, id];
    uploads = uploads.then(async () => {
      for (const file of picked) {
        const row = await uploadOne(file, progress, { category: category() });
        if (!row) continue;
        // The box may have moved on to another note/task meanwhile: the file still goes where it was picked.
        if (n === shown) await self.attach(row).catch(fail);
        else if (forId !== null) await call("/api/attachments", { method: "POST", body: { [target]: forId, fileId: row.id } }).catch(() => {});
      }
    });
  };

  function render() {
    box.replaceChildren(
      el(
        "div",
        { className: "attach-head" },
        icon("clip"),
        el("span", { textContent: files.length ? `${label} ${files.length}개` : label }),
        el("button", { type: "button", className: "btn ghost sm", onclick: () => openPicker(self) }, icon("folder"), "클라우드에서 고르기"),
        me.driveConnected ? el("button", { type: "button", className: "btn ghost sm", onclick: () => input.click() }, icon("upload"), "새로 올리기") : null,
      ),
      el(
        "ul",
        { className: "attach-list", hidden: !files.length },
        ...files.map((f) =>
          el(
            "li",
            {},
            el("a", { href: fileUrl(f), target: "_blank", rel: "noopener", textContent: f.title, title: f.name }),
            el("span", { className: "muted", textContent: sizeText(f.size) }),
            iconBtn("떼기", "x", () => detach(f).catch(fail), "danger"),
          ),
        ),
      ),
      progress,
      err,
      input,
    );
  }
  return self;
}

// 파일함에서 골라 붙이는 창. 여러 개를 연달아 붙일 수 있게 붙여도 닫지 않는다.
let pickFor = null;
let pickTimer;
function openPicker(box) {
  pickFor = box;
  $("pick-q").value = "";
  $("pick-dialog").showModal();
  loadPickList().catch(showPickError);
}
const showPickError = (e) => $("pick-list").replaceChildren(el("li", { className: "error", textContent: e.message }));

async function loadPickList() {
  const q = $("pick-q").value;
  const files = await call("/api/files?" + new URLSearchParams({ q }));
  if (q !== $("pick-q").value) return;
  $("pick-list").replaceChildren(
    ...(files.length
      ? files.map((f) => {
          const on = pickFor.has(f.id);
          return el(
            "li",
            {},
            el("span", { className: "pick-name", textContent: f.title }),
            el("span", { className: "muted", textContent: `${f.category} · ${sizeText(f.size)}` }),
            el("button", {
              type: "button",
              className: "btn sm" + (on ? " ghost" : ""),
              disabled: on,
              textContent: on ? "붙임" : "붙이기",
              onclick: () => pickFor.attach(f).then(loadPickList).catch(showPickError),
            }),
          );
        })
      : [el("li", { className: "muted", textContent: q ? "검색 결과가 없습니다." : "파일함이 비어 있습니다." })]),
  );
}

// 클라우드(파일함): 이 사이트의 폴더와 파일. 파일은 구글 드라이브에 같은 폴더 구조로 보관된다.
let fileCategory = () => "";
let editingFile = null;
let editingFolder = null;
let folders = [];
let listed = []; // what the list shows, in order: { type: "folder" | "file", id, name, sort, key, f (the row) }
const picked = new Set(); // keys ("file:3", "folder:7") of the ticked rows
let pickedIn = ""; // the folder/search the ticks belong to; going elsewhere clears them
let orderSaves = Promise.resolve(); // PUT /api/cloud/order calls, one after another
let orderSeq = 0; // how many saves were queued; the last one redraws the list if any of them failed
let orderFailed = false;
const dayText = (s) => new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "numeric", day: "numeric" }).format(new Date(s.replace(" ", "T") + "Z"));

// The open folder comes from the address (#files/<id>), so back/forward walk the folders. null = the top.
const currentFolder = () => {
  const id = Number(location.hash.split("/")[1]);
  return folders.some((f) => f.id === id) ? id : null;
};
function folderPath(id) {
  const out = [];
  for (let f = folders.find((x) => x.id === id); f; f = folders.find((x) => x.id === f.parent_id)) out.unshift(f);
  return out;
}
const pathText = (id) => ["클라우드", ...folderPath(id).map((f) => f.name)].join(" / ");

// Fills a folder <select>: the top, then every folder by its path. skip: folders that can't be picked (a folder and what's under it).
function folderOptions(select, value, skip = new Set()) {
  const list = folders.filter((f) => !skip.has(f.id)).map((f) => [String(f.id), pathText(f.id)]).sort((a, b) => a[1].localeCompare(b[1], "ko"));
  select.replaceChildren(el("option", { value: "", textContent: "클라우드 (맨 위)" }), ...list.map(([v, t]) => el("option", { value: v, textContent: t })));
  select.value = value === null ? "" : String(value);
}
const subtree = (id) => {
  const out = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of folders) if (f.parent_id !== null && out.has(f.parent_id) && !out.has(f.id)) out.add(f.id), (grew = true);
  }
  return out;
};

function openFileDialog(f) {
  editingFile = f;
  $("file-title").value = f.title;
  $("file-category").value = f.category;
  $("file-tags").value = f.tags;
  $("file-note").value = f.note;
  folderOptions($("file-folder"), f.folder_id);
  $("file-dialog").showModal();
}

function openFolderDialog(folder = null) {
  editingFolder = folder;
  $("folder-dialog-title").textContent = folder ? "폴더 이름·위치 바꾸기" : "새 폴더";
  $("folder-name").value = folder?.name ?? "";
  $("folder-msg").textContent = "";
  folderOptions($("folder-parent"), folder ? folder.parent_id : currentFolder(), folder ? subtree(folder.id) : new Set());
  $("folder-dialog").showModal();
}

async function loadQuota() {
  if (!me.driveConnected) return $("file-stats").replaceChildren(stat("사용 중", "—", "구글 드라이브 연결 안 됨"));
  try {
    const q = await call("/api/quota");
    const limit = Number(q.drive.limit || 0);
    const free = limit ? limit - Number(q.drive.usage || 0) : null;
    $("file-stats").replaceChildren(
      stat("사용 중", sizeText(q.bytes), `파일 ${q.files}개 · 폴더 ${folders.length}개`),
      stat("보관 공간", free === null ? "무제한" : gb(free) + " 남음", limit ? `구글 드라이브 ${gb(limit)} 중` : "구글 드라이브", free !== null && free < limit * 0.1),
    );
  } catch (e) {
    $("file-stats").replaceChildren(stat("사용 중", "—", "용량 확인 실패: " + e.message, true));
  }
}

function renderCrumbs(cur, searching) {
  const parts = [el("a", { href: "#files", textContent: "클라우드" }), ...folderPath(cur).map((f) => el("a", { href: `#files/${f.id}`, textContent: f.name }))];
  if (searching) parts.push(el("span", { textContent: "검색 결과 (모든 폴더)" }));
  $("crumbs").replaceChildren(...parts.flatMap((p, i) => (i ? [el("span", { className: "muted", textContent: "/" }), p] : [p])));
}

async function loadList() {
  folders = await call("/api/folders");
  const q = $("q").value.trim();
  const cur = currentFolder();
  const params = new URLSearchParams({ q, category: fileCategory() });
  if (!q) params.set("folder", cur === null ? "root" : String(cur));
  const files = await call("/api/files?" + params);
  loadQuota();
  renderCrumbs(cur, !!q);
  // A whole folder is in the owner's order (folders and files together) and can be dragged; a search or a filter can't.
  const ordered = !q && !fileCategory();
  const del = (path, text) => confirm(text) && call(path, { method: "DELETE" }).then(loadList, showError);
  const row = (it, cells) => {
    const tick = el("input", { type: "checkbox", checked: picked.has(it.key), title: "고르기", ariaLabel: `${it.name} 고르기`, onchange() { this.checked ? picked.add(it.key) : picked.delete(it.key); showTicks(); } });
    const handle = ordered && el("button", { type: "button", className: "drag-handle", title: "끌어서 순서 바꾸기 · 폴더 위에 놓으면 그 안으로", ariaLabel: `${it.name} 끌어서 옮기기`, onpointerdown: (ev) => dragRows(ev, it.key) }, icon("grip"));
    const tr = el("tr", { className: it.type === "folder" ? "folder-row" : "" }, el("td", { className: "sel-cell" }, el("div", { className: "sel-box" }, handle, tick)), ...cells);
    tr.dataset.key = it.key;
    if (it.type === "folder") tr.dataset.folder = it.id;
    return tr;
  };
  const folderItems = (ordered ? folders.filter((f) => f.parent_id === cur) : []).map((f) => ({ type: "folder", id: f.id, name: f.name, sort: f.sort, key: `folder:${f.id}`, f }));
  const fileItems = files.map((f) => ({ type: "file", id: f.id, name: f.title, sort: f.sort, key: `file:${f.id}`, f }));
  listed = ordered ? [...folderItems, ...fileItems].sort((a, b) => a.sort - b.sort) : fileItems;
  // Ticks stay while the same folder/search is reloaded (after a move, an upload, ...), and only for what is still there.
  // Settled before the rows are made, since each row's box starts from `picked`.
  const where = `${cur}|${q}|${fileCategory()}`;
  if (where !== pickedIn) picked.clear();
  pickedIn = where;
  for (const k of [...picked]) if (!listed.some((it) => it.key === k)) picked.delete(k);
  const rows = listed.map((it) => {
    const f = it.f;
    if (it.type === "folder")
      return row(it, [
        el("td", {}, el("div", { className: "thumb-empty folder-icon" }, icon("folder"))),
        el("td", {}, el("a", { className: "title", href: `#files/${f.id}`, textContent: f.name }), el("span", { className: "sub", textContent: "폴더" })),
        el("td", { className: "hide-sm" }),
        el("td", { className: "hide-sm" }),
        el("td", { className: "num muted" }),
        el("td", { className: "hide-sm muted", textContent: dayText(f.created_at) }),
        el(
          "td",
          { className: "actions" },
          iconBtn("이름·위치 바꾸기", "edit", () => openFolderDialog(f)),
          iconBtn("삭제", "trash", () => del(`/api/folders/${f.id}`, `"${f.name}" 폴더와 그 안의 파일·폴더를 모두 지울까요? (구글 드라이브 휴지통으로 가서 30일 안에는 드라이브에서 되살릴 수 있습니다. 노트·할 일·포트폴리오에 붙인 것도 떨어집니다)`), "danger"),
        ),
      ]);
    return row(it, [
      el("td", {}, el("img", { className: "thumb", src: `/thumb/${f.id}`, alt: "", loading: "lazy", onerror() { this.replaceWith(el("div", { className: "thumb-empty" })); } })),
      el("td", {}, el("a", { className: "title", href: fileUrl(f), target: "_blank", rel: "noopener", textContent: f.title }), el("span", { className: "sub", textContent: q ? pathText(f.folder_id) : f.note || f.name })),
      el("td", { className: "hide-sm" }, pill(f.category, f.category === "포트폴리오" ? "blue" : "gray")),
      el("td", { className: "hide-sm" }, ...f.tags.split(",").map((t) => t.trim()).filter(Boolean).map((t) => el("span", { className: "tag", textContent: t }))),
      el("td", { className: "num muted", textContent: sizeText(f.size) }),
      el("td", { className: "hide-sm muted", textContent: dayText(f.created_at) }),
      el(
        "td",
        { className: "actions" },
        el("a", { className: "btn ghost sm", href: fileUrl(f) + "?download=1", download: "", title: "받기", ariaLabel: "받기" }, icon("download")),
        iconBtn("수정·옮기기", "edit", () => openFileDialog(f)),
        iconBtn("삭제", "trash", () => del(`/api/files/${f.id}`, `"${f.title}" 을(를) 지울까요? (구글 드라이브 휴지통으로 가서 30일 안에는 드라이브에서 되살릴 수 있습니다. 노트·할 일·포트폴리오에 붙인 것도 떨어집니다)`), "danger"),
      ),
    ]);
  });
  $("list").replaceChildren(...(rows.length ? rows : [emptyRow(8, q || fileCategory() ? "검색 결과가 없습니다." : cur === null ? "아직 올린 파일이 없습니다." : "빈 폴더입니다.")]));
  showTicks();
}

// The bar over the list while something is ticked, and the tick-all box in the header.
function showTicks() {
  $("sel-bar").hidden = !picked.size;
  $("sel-count").textContent = `${picked.size}개 고름`;
  $("sel-all").checked = !!listed.length && picked.size === listed.length;
  $("sel-all").indeterminate = !!picked.size && picked.size < listed.length;
  $("list").querySelectorAll("tr[data-key]").forEach((tr) => {
    tr.classList.toggle("picked", picked.has(tr.dataset.key));
    tr.querySelector(".sel-cell input").checked = picked.has(tr.dataset.key);
  });
}

// Moves the items (in list order) into a folder (null = the top), one at a time like the 수정·옮기기 dialog.
// Each lands first there, so going from the last one keeps their order. Returns what could not be moved.
async function moveItems(items, target) {
  const failed = [];
  for (const it of [...items].reverse()) {
    const now = it.type === "folder" ? folders.find((f) => f.id === it.id)?.parent_id : it.f.folder_id;
    if (now === target) continue;
    try {
      if (it.type === "folder") await call(`/api/folders/${it.id}`, { method: "PATCH", body: { parentId: target } });
      else await call(`/api/files/${it.id}`, { method: "PATCH", body: { folderId: target } });
      picked.delete(it.key);
    } catch (e) {
      failed.unshift(`${it.name}: ${e.message}`);
    }
  }
  await loadList();
  return failed;
}

function openMoveDialog() {
  const items = listed.filter((it) => picked.has(it.key));
  if (!items.length) return;
  const nf = items.filter((it) => it.type === "folder").length;
  $("move-what").textContent = [nf && `폴더 ${nf}개`, items.length - nf && `파일 ${items.length - nf}개`].filter(Boolean).join(", ") + "를 옮깁니다.";
  // A folder can't go into itself or below itself.
  const skip = new Set(items.filter((it) => it.type === "folder").flatMap((it) => [...subtree(it.id)]));
  folderOptions($("move-folder"), currentFolder(), skip);
  $("move-msg").textContent = "";
  $("move-dialog").showModal();
}

// 손잡이(점 6개)를 잡고 끌어서 순서를 바꾼다. 폴더 줄 가운데에 놓으면 그 폴더 안으로 옮긴다. 고른 줄을 끌면 고른 것이 모두 같이 간다.
// 마우스와 손가락 모두 pointer 이벤트로 받는다(휴대폰 크롬은 HTML 끌어 놓기를 손가락으로 시작하지 못한다).
function dragRows(ev, key) {
  if (ev.button !== 0) return;
  ev.preventDefault();
  const handle = ev.currentTarget;
  handle.setPointerCapture(ev.pointerId);
  const rows = [...$("list").querySelectorAll("tr[data-key]")];
  const group = picked.has(key) ? listed.filter((it) => picked.has(it.key)).map((it) => it.key) : [key];
  const scroller = $("list").closest(".content");
  const startY = ev.clientY;
  let x = ev.clientX;
  let y = ev.clientY;
  let dragging = false;
  let target = null;
  let where = "";
  let raf = 0;
  const clear = () => rows.forEach((r) => r.classList.remove("drop-before", "drop-after", "drop-into"));
  const locate = () => {
    clear();
    target = document.elementFromPoint(x, y)?.closest("#list tr[data-key]") ?? null;
    if (!target || group.includes(target.dataset.key)) return void (target = null);
    const r = target.getBoundingClientRect();
    const at = (y - r.top) / r.height;
    where = target.dataset.folder && at > 0.25 && at < 0.75 ? "into" : at < 0.5 ? "before" : "after";
    target.classList.add("drop-" + where);
  };
  // 목록 위·아래 끝 가까이 끌고 있으면 목록을 굴린다.
  const scroll = () => {
    const box = scroller.getBoundingClientRect();
    const d = y < box.top + 48 ? -12 : y > box.bottom - 48 ? 12 : 0;
    if (d) {
      scroller.scrollTop += d;
      locate();
    }
    raf = requestAnimationFrame(scroll);
  };
  handle.onpointermove = (e) => {
    x = e.clientX;
    y = e.clientY;
    if (!dragging && Math.abs(y - startY) < 5) return;
    if (!dragging) {
      dragging = true;
      rows.forEach((r) => r.classList.toggle("dragging", group.includes(r.dataset.key)));
      raf = requestAnimationFrame(scroll);
    }
    locate();
  };
  const end = (drop) => {
    handle.onpointermove = handle.onpointerup = handle.onpointercancel = null;
    cancelAnimationFrame(raf);
    clear();
    rows.forEach((r) => r.classList.remove("dragging"));
    if (!drop || !dragging || !target) return;
    const items = listed.filter((it) => group.includes(it.key));
    if (where === "into") {
      moveItems(items, Number(target.dataset.folder)).then((failed) => failed.length && showError("옮기지 못한 것: " + failed.join(" · ")), showError);
      return;
    }
    const rest = listed.filter((it) => !group.includes(it.key));
    const at = rest.findIndex((it) => it.key === target.dataset.key) + (where === "after" ? 1 : 0);
    const next = [...rest.slice(0, at), ...items, ...rest.slice(at)];
    if (next.every((it, i) => it === listed[i])) return;
    listed = next;
    // 바로 그 순서로 보여 주고 저장한다. 저장이 안 되면 서버의 순서로 다시 그린다.
    $("list").append(...next.map((it) => rows.find((r) => r.dataset.key === it.key)));
    // 저장은 한 번에 하나씩 차례로 보낸다. 앞 저장이 늦게 끝나 마지막 순서를 덮어쓰지 않게.
    // 실패가 있었으면 줄 선 저장이 다 끝난 뒤에 한 번 서버의 순서로 다시 그린다(중간에 그리면 뒤 저장이 화면과 어긋난다).
    const body = { folderId: currentFolder(), items: next.map(({ type, id }) => ({ type, id })) };
    const n = ++orderSeq;
    orderSaves = orderSaves
      .then(() => call("/api/cloud/order", { method: "PUT", body }))
      .catch((e) => {
        showError(e);
        orderFailed = true;
      })
      .then(() => {
        if (n !== orderSeq || !orderFailed) return;
        orderFailed = false;
        return loadList().catch(showError);
      });
  };
  handle.onpointerup = () => end(true);
  handle.onpointercancel = () => end(false);
}

// 포트폴리오: 내 소개 + 섹션(업적·작품·취미 …)마다 항목. 항목은 공개(kacarong.kr) 또는 개인용(미리 보기에만).
let pf = null; // the last GET /api/portfolio
let pfPhoto = null; // attachBox of the profile photo
let itemFiles = null; // attachBox of the item dialog
let editingItem = null;

async function loadPortfolio() {
  await refreshSections();
  $("pf-name").value = pf.profile.name;
  $("pf-headline").value = pf.profile.headline;
  $("pf-about").value = pf.profile.about;
  $("pf-saved").textContent = "";
  pfPhoto.show(0, () => "포트폴리오");
}

async function refreshSections() {
  pf = await call("/api/portfolio");
  const reload = () => refreshSections().catch(showError);
  const act = (p, method, body) => call(p, { method, body }).then(reload, showError);
  $("pf-sections").replaceChildren(
    ...pf.sections.map((s, si) => {
      const pub = s.items.filter((i) => i.public).length;
      const rows = s.items.map((it, ii) => {
        const vis = el(
          "select",
          { className: "input sm", title: "공개: kacarong.kr에 나옴 · 개인용: 나만 봄", onchange() { act(`/api/portfolio/items/${it.id}`, "PATCH", { public: this.value === "1" }); } },
          el("option", { value: "1", textContent: "공개" }),
          el("option", { value: "0", textContent: "개인용" }),
        );
        vis.value = it.public ? "1" : "0";
        const cover = it.files[0];
        return el(
          "tr",
          {},
          el("td", {}, cover ? el("img", { className: "thumb", src: `/thumb/${cover.id}`, alt: "", loading: "lazy", onerror() { this.replaceWith(el("div", { className: "thumb-empty" })); } }) : el("div", { className: "thumb-empty" })),
          el("td", {}, el("a", { className: "title", href: "#portfolio", textContent: it.title, onclick: (ev) => (ev.preventDefault(), openItemDialog(it)) }), el("span", { className: "sub", textContent: it.summary || (it.files.length ? `파일 ${it.files.length}개` : "") })),
          el("td", { className: "hide-sm muted", textContent: it.period }),
          el("td", {}, vis),
          el(
            "td",
            { className: "actions" },
            iconBtn("위로", "up", () => act(`/api/portfolio/items/${it.id}/move`, "POST", { dir: -1 }), ii ? "" : "invisible"),
            iconBtn("아래로", "down", () => act(`/api/portfolio/items/${it.id}/move`, "POST", { dir: 1 }), ii < s.items.length - 1 ? "" : "invisible"),
            iconBtn("수정", "edit", () => openItemDialog(it)),
            iconBtn("삭제", "trash", () => confirm(`"${it.title}" 항목을 지울까요? (붙인 파일은 클라우드에 남습니다)`) && act(`/api/portfolio/items/${it.id}`, "DELETE"), "danger"),
          ),
        );
      });
      return el(
        "section",
        { className: "pf-section" },
        el(
          "div",
          { className: "pf-head" },
          el("h2", { textContent: s.title }),
          el("span", { className: "muted", textContent: `${s.items.length}개 · 공개 ${pub}` }),
          el("span", { className: "grow" }),
          layoutSelect(s, act),
          iconBtn("섹션 위로", "up", () => act(`/api/portfolio/sections/${s.id}/move`, "POST", { dir: -1 }), si ? "" : "invisible"),
          iconBtn("섹션 아래로", "down", () => act(`/api/portfolio/sections/${s.id}/move`, "POST", { dir: 1 }), si < pf.sections.length - 1 ? "" : "invisible"),
          iconBtn("섹션 이름 바꾸기", "edit", () => {
            const title = prompt("섹션 이름", s.title);
            if (title?.trim()) act(`/api/portfolio/sections/${s.id}`, "PATCH", { title });
          }),
          iconBtn("섹션 삭제", "trash", () => confirm(`"${s.title}" 섹션과 그 안의 항목 ${s.items.length}개를 지울까요? (붙인 파일은 클라우드에 남습니다)`) && act(`/api/portfolio/sections/${s.id}`, "DELETE"), "danger"),
          el("button", { className: "btn sm", type: "button", onclick: () => openItemDialog(null, s.id) }, icon("plus"), "항목 추가"),
        ),
        el("table", { className: "table" }, el("tbody", {}, ...(rows.length ? rows : [emptyRow(5, "아직 항목이 없습니다.")]))),
      );
    }),
    pf.sections.length ? "" : el("p", { className: "notice", textContent: "섹션이 없습니다." }),
  );
}

// 섹션을 포트폴리오 페이지에 어떻게 보일지: 큰 카드 / 격자 / 목록.
function layoutSelect(s, act) {
  const sel = el(
    "select",
    { className: "input sm", title: "포트폴리오 페이지에서 이 섹션을 보이는 방식", onchange() { act(`/api/portfolio/sections/${s.id}`, "PATCH", { layout: this.value }); } },
    el("option", { value: "cards", textContent: "큰 카드" }),
    el("option", { value: "grid", textContent: "격자" }),
    el("option", { value: "list", textContent: "목록" }),
  );
  sel.value = s.layout || "cards";
  return sel;
}

function newSection() {
  const title = prompt("새 섹션 이름 (예: 업적, 작품, 취미)");
  if (title?.trim()) call("/api/portfolio/sections", { method: "POST", body: { title } }).then(() => refreshSections(), showError).catch(showError);
}

let itemNoteSeq = 0; // 가장 최근에 연 항목 창만 노트 목록을 채운다
function openItemDialog(it = null, sectionId = null) {
  if (!pf?.sections.length) return showError("먼저 섹션을 만들어 주세요.");
  editingItem = it;
  $("item-dialog-title").textContent = it ? "항목 수정" : "새 항목";
  $("item-section").replaceChildren(...pf.sections.map((s) => el("option", { value: String(s.id), textContent: s.title })));
  $("item-section").value = String(it?.section_id ?? sectionId ?? pf.sections[0].id);
  $("item-public").value = it && !it.public ? "0" : "1";
  $("item-title").value = it?.title ?? "";
  $("item-period").value = it?.period ?? "";
  $("item-link").value = it?.link ?? "";
  $("item-summary").value = it?.summary ?? "";
  $("item-body").value = it?.body ?? "";
  // 노트 목록이 오기 전(또는 못 받았을 때) 저장해도 붙어 있던 노트가 그대로 가도록 그 노트를 먼저 골라 둔다.
  const seq = ++itemNoteSeq;
  $("item-note").replaceChildren(
    el("option", { value: "", textContent: "붙이지 않음" }),
    ...(it?.note_id ? [el("option", { value: String(it.note_id), textContent: "(붙인 노트)" })] : []),
  );
  $("item-note").value = it?.note_id ? String(it.note_id) : "";
  call("/api/notes")
    .then((notes) => {
      if (seq !== itemNoteSeq) return; // 그사이 다른 항목 창을 열었다
      const picked = $("item-note").value; // 기다리는 동안 고른 것도 지킨다
      $("item-note").replaceChildren(el("option", { value: "", textContent: "붙이지 않음" }), ...notes.map((n) => el("option", { value: String(n.id), textContent: n.title || "(제목 없음)" })));
      $("item-note").value = notes.some((n) => String(n.id) === picked) ? picked : ""; // 지운 노트면 붙이지 않음
    })
    .catch(showError);
  $("item-msg").textContent = "";
  itemFiles.show(it?.id ?? null, () => "포트폴리오");
  $("item-dialog").showModal();
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
      t.files ? el("span", { className: "clip", title: `첨부 파일 ${t.files}개` }, icon("clip"), String(t.files)) : null,
      t.note ? el("span", { className: "sub", textContent: t.note }) : null,
      t.note_id ? el("span", { className: "sub" }, el("a", { href: `#notes/${t.note_id}`, textContent: `노트 · ${t.note_title || "제목 없음"}` })) : null,
      t.study_id ? el("span", { className: "sub" }, el("a", { href: "#studies", textContent: t.course ? `공부 · ${t.course}` : "공부" })) : null,
    ),
    el("td", { className: "hide-sm" }, pill(t.kind, t.kind === "과제" ? "blue" : t.kind === "공부" ? "amber" : "gray")),
    withActions ? null : el("td", { className: "hide-sm muted", textContent: t.course || "—" }), // 할 일·과제 탭에는 과목 칸이 없다
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

const TODAY_CATEGORY = "오늘 할 일"; // 고르면 날짜가 오늘로 채워진다
const STEADY_CATEGORY = "꾸준히 할 일"; // 고르면 날짜·시간 칸이 숨는다
const syncTaskWhen = () => ($("task-when").hidden = $("task-category").value === STEADY_CATEGORY);
let editingTask = null;
function openTaskDialog(t = null) {
  editingTask = t;
  $("task-dialog-title").textContent = t ? "할 일 수정" : "새 할 일";
  $("task-kind").value = t?.kind ?? taskKinds[0];
  // A new task from the 할 일·과제 tab starts in the category shown there.
  $("task-category").value = t ? t.category : currentTab() === "tasks" && taskCategory() !== "*" ? taskCategory() : "";
  $("task-title").value = t?.title ?? "";
  $("task-date").value = t?.due_date ?? ($("task-category").value === TODAY_CATEGORY ? seoulToday() : "");
  $("task-time").value = t?.due_time ?? "";
  $("task-note").value = t?.note ?? "";
  syncTaskWhen();
  taskFiles.show(t?.id ?? null, () => ($("task-kind").value === "과제" ? "과제" : "기타"));
  $("task-dialog").showModal();
}

// 지난 일을 모두 오늘 날짜로 옮긴다(시간은 그대로). 노트에서 온 할 일도 노트 쪽 날짜가 같이 바뀌도록 하나씩 고친다.
async function moveOverdueToToday(tasks, date) {
  if (!confirm(`지난 일 ${tasks.length}개의 날짜를 오늘로 바꿀까요?`)) return;
  for (const t of tasks) await call(`/api/tasks/${t.id}`, { method: "PATCH", body: { due_date: date } });
}
const overdueBtn = (tasks, date, reload) =>
  el("button", { className: "btn sm", type: "button", onclick: () => moveOverdueToToday(tasks, date).then(reload, (e) => (showError(e), reload())) }, "지난 일 모두 오늘로");

async function loadToday() {
  const t = await call("/api/today");
  const reload = () => loadToday().catch(showError);
  updateOverdueBadge(t.overdue.length);
  const wd = new Intl.DateTimeFormat("ko-KR", { weekday: "long", timeZone: "Asia/Seoul" }).format(new Date(t.date + "T12:00:00+09:00"));
  $("page-title").textContent = `오늘 · ${md(t.date)} ${wd}`;
  $("today-stats").replaceChildren(
    stat("지난 일", String(t.overdue.length), "", t.overdue.length > 0),
    stat("오늘", String(t.today.length), ""),
    stat("다가오는 과제", String(t.upcoming.length), "3일 안"),
    stat("오늘 끝낸 일", String(t.doneToday.length), ""),
    ...(t.exams.length ? [stat("다음 시험", dday(t.date, t.exams[0].date), examName(t.exams[0]), daysBetween(t.date, t.exams[0].date) <= 3)] : []),
  );
  const q = searchText();
  const row = (x) => taskRow(x, t.date, reload, false);
  const sections = [
    ["지난 일", t.overdue, row],
    ["오늘", t.today, row],
    ["다가오는 과제 (3일 안)", t.upcoming, row],
    ["오늘 끝낸 일", t.doneToday, row],
  ]
    .map(([title, items, make]) => [title, items.filter((x) => matches(x, q)), make])
    .filter(([, items]) => items.length);
  $("today-list").replaceChildren(
    ...(sections.length
      ? sections.flatMap(([title, items, make]) => [
          el("tr", { className: "group-row" }, el("td", { colSpan: 6 }, `${title} · ${items.length}`, title === "지난 일" ? overdueBtn(t.overdue, t.date, reload) : null)),
          ...items.map(make),
        ])
      : [emptyRow(6, "오늘 할 일이 없습니다.")]),
  );
}

let taskDone = () => "0";
let taskKind = () => "";
let taskCategory = () => "*";
async function loadTasks() {
  const params = new URLSearchParams();
  if (taskDone()) params.set("done", taskDone());
  if (taskKind()) params.set("kind", taskKind());
  const [tasks, all, today] = await Promise.all([call("/api/tasks?" + params), call("/api/tasks?done=0"), call("/api/today")]);
  updateOverdueBadge(today.overdue.length);
  const reload = () => loadTasks().catch(showError);
  const left = (k) => all.filter((x) => x.kind === k).length;
  $("task-stats").replaceChildren(
    stat("남은 할 일", String(left("할 일")), ""),
    stat("남은 과제", String(left("과제")), `3일 안 마감 ${today.upcoming.length}개`),
    stat("지난 일", String(today.overdue.length), "", today.overdue.length > 0),
  );
  $("task-overdue").replaceChildren(...(today.overdue.length ? [overdueBtn(today.overdue, today.date, reload)] : []));
  const q = searchText();
  const shown = tasks.filter((x) => matches(x, q) && (taskCategory() === "*" || x.category === taskCategory()));
  // One group per category, in the fixed order, 분류 없음 last.
  const groups = [...taskCategories, ""].map((c) => [c || "분류 없음", shown.filter((x) => x.category === c)]).filter(([, items]) => items.length);
  $("task-list").replaceChildren(
    ...(groups.length
      ? groups.flatMap(([title, items]) => [el("tr", { className: "group-row" }, el("td", { colSpan: 6, textContent: `${title} · ${items.length}` })), ...items.map((x) => taskRow(x, today.date, reload, true))])
      : [emptyRow(6, q ? "검색 결과가 없습니다." : "없습니다.")]),
  );
}

// 지출: 매달 나가는 돈(정기)과 앞으로 쓸 돈(예정). 합계는 여기서 낸다.
const won = (n) => `${Number(n).toLocaleString("ko-KR")}원`;
let editingExpense = null;

// The next day a monthly expense goes out (its day, or the month's last day when the month is shorter).
function nextPayDay(day, today) {
  const at = (y, m) => `${y}-${String(m).padStart(2, "0")}-${String(Math.min(day, new Date(Date.UTC(y, m, 0)).getUTCDate())).padStart(2, "0")}`;
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
  const here = at(y, m);
  return here >= today ? here : m === 12 ? at(y + 1, 1) : at(y, m + 1);
}

function syncExpenseKind() {
  const monthly = $("expense-kind").value === "정기";
  // The unused one is also disabled, so a leftover value (day 32, …) can't block the form's validation.
  $("expense-day-box").hidden = $("expense-day").disabled = !monthly;
  $("expense-date-box").hidden = $("expense-date").disabled = monthly;
}

function openExpenseDialog(x = null, kind = "정기") {
  editingExpense = x;
  $("expense-dialog-title").textContent = x ? "지출 수정" : "새 지출";
  $("expense-kind").value = x?.kind ?? kind;
  $("expense-title").value = x?.title ?? "";
  $("expense-amount").value = x ? x.amount.toLocaleString("ko-KR") : "";
  $("expense-day").value = x?.day ?? "";
  $("expense-date").value = x?.date ?? "";
  $("expense-note").value = x?.note ?? "";
  $("expense-msg").textContent = "";
  syncExpenseKind();
  $("expense-dialog").showModal();
}

function expenseRow(x, today, reload) {
  const update = (patch) => call(`/api/expenses/${x.id}`, { method: "PATCH", body: patch }).then(reload, showError);
  let when;
  if (x.kind === "정기") {
    if (!x.day) when = el("td", { className: "muted", textContent: "매달" });
    else {
      const d = daysBetween(today, nextPayDay(x.day, today));
      when = el("td", {}, el("span", { className: "date-main", textContent: `매달 ${x.day}일` }), el("span", { className: `date-note ${d <= 3 ? "soon" : "ok"}`, textContent: d === 0 ? "오늘" : `D-${d}` }));
    }
  } else {
    // Spent ones and ones with no date just show the date; the rest count down like a task.
    when = dueCell({ due_date: x.date, due_time: null, done: x.done }, today);
  }
  return el(
    "tr",
    {},
    el("td", {}, x.kind === "예정" ? el("input", { type: "checkbox", checked: !!x.done, title: "썼음 표시", onchange() { update({ done: this.checked }); } }) : null),
    // On a narrow screen the 언제 column is hidden and the same text goes under the name.
    el("td", {}, el("span", { className: "title" + (x.done ? " done" : ""), textContent: x.title }), el("span", { className: "sub when-sub" }, ...[...when.childNodes].map((n) => n.cloneNode(true))), x.note ? el("span", { className: "sub", textContent: x.note }) : null),
    Object.assign(when, { className: (when.className + " hide-sm").trim() }),
    el("td", { className: "num" + (x.done ? " muted" : ""), textContent: won(x.amount) }),
    el(
      "td",
      { className: "actions" },
      iconBtn("수정", "edit", () => openExpenseDialog(x)),
      iconBtn("삭제", "trash", () => {
        if (confirm(`"${x.title}" 을(를) 삭제할까요?`)) call(`/api/expenses/${x.id}`, { method: "DELETE" }).then(reload, showError);
      }, "danger"),
    ),
  );
}

async function loadExpenses() {
  const { date: today, expenses } = await call("/api/expenses");
  const reload = () => loadExpenses().catch(showError);
  const sum = (list) => list.reduce((a, x) => a + x.amount, 0);
  const monthly = expenses.filter((x) => x.kind === "정기").sort((a, b) => (a.day ?? 99) - (b.day ?? 99) || a.id - b.id);
  const planned = expenses.filter((x) => x.kind === "예정").sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999") || a.id - b.id);
  const toSpend = planned.filter((x) => !x.done);
  const spent = planned.filter((x) => x.done).reverse();
  // 이번 달 남은 것: days from today to the end of this month.
  const left = monthly.filter((x) => x.day && nextPayDay(x.day, today).slice(0, 7) === today.slice(0, 7));
  $("expense-stats").replaceChildren(
    stat("매달 나가는 돈", won(sum(monthly)), `${monthly.length}개`),
    stat("이번 달 남은 정기지출", won(sum(left)), `${left.length}개 · 오늘부터 말일까지`),
    stat("앞으로 쓸 돈", won(sum(toSpend)), `${toSpend.length}개`),
  );
  const q = searchText();
  const shown = (list) => list.filter((x) => !q || [x.title, x.note].some((v) => v.toLowerCase().includes(q)));
  const add = (kind) => el("button", { className: "btn ghost sm", type: "button", onclick: () => openExpenseDialog(null, kind) }, icon("plus"), "추가");
  const group = (title, list, kind) => [
    // Spans count the 언제 column apart (a hidden cell of its own) so a narrow screen keeps four columns.
    el("tr", { className: "group-row" }, el("td", { colSpan: 2, textContent: `${title} · ${list.length}` }), el("td", { className: "hide-sm" }), el("td", { className: "num", textContent: list.length ? won(sum(list)) : "" }), el("td", { className: "actions" }, kind ? add(kind) : null)),
    ...(list.length
      ? list.map((x) => expenseRow(x, today, reload))
      : kind
        ? [el("tr", { className: "empty-row" }, el("td", { colSpan: 4, textContent: q ? "검색 결과가 없습니다." : "없습니다." }), el("td", { className: "hide-sm" }))]
        : []),
  ];
  $("expense-list").replaceChildren(
    ...group("매달 나가는 돈", shown(monthly), "정기"),
    ...group("앞으로 쓸 돈", shown(toSpend), "예정"),
    ...(spent.length ? group("쓴 것", shown(spent), null) : []),
  );
}

// 시간표·학점 계산기는 따로 둔 timetable.js 가 그린다(이 탭을 처음 열 때 불러옴).
let timetable = null;
function loadTimetable() {
  timetable ??= import("./timetable.js" + new URL(import.meta.url).search).then((m) => m.mount($("tab-timetable"), { icon, call, el, showError }));
  return timetable.then((t) => t.load()).catch((e) => {
    timetable = null; // 다음에 탭을 열 때 다시 시도
    throw e;
  });
}

// 수업일정: 바뀐 수업(시간·장소 변경, 보강, 휴강)을 적어 두면 그 전날 저녁 8시에 알림.
let editingClass = null;
const CLASS_KIND_PILL = { 변경: ["시간·장소 변경", "blue"], 보강: ["보강", "amber"], 휴강: ["휴강", "orange"] };
let classPastOpen = false;

function syncClassKind() {
  const off = $("class-kind").value === "휴강";
  $("class-time-box").hidden = off;
  $("class-place-box").hidden = off;
  $("class-from-box").hidden = $("class-kind").value !== "변경";
  $("class-date-label").textContent = off ? "휴강 날짜" : $("class-kind").value === "보강" ? "보강 날짜" : "바뀐 날짜";
}

async function openClassDialog(c = null) {
  editingClass = c;
  $("class-dialog-title").textContent = c ? "수업일정 수정" : "바뀐 수업 기록";
  for (const k of ["course", "kind", "date", "start", "end", "place", "note"]) $(`class-${k}`).value = c?.[k] ?? (k === "kind" ? "변경" : "");
  $("class-from").value = c?.from_date ?? "";
  $("class-msg").textContent = "";
  syncClassKind();
  $("class-dialog").showModal();
  // 과목 칸 자동완성: 시간표의 과목 이름(지금 학기 것 먼저).
  call("/api/timetable").then(
    (t) => {
      const now = t.semesters.find((s) => s.year === t.current.year && s.term === t.current.term)?.id;
      const names = [...t.courses.filter((x) => x.semester_id === now), ...t.courses.filter((x) => x.semester_id !== now).reverse()].map((x) => x.name);
      $("class-courses").replaceChildren(...[...new Set(names)].map((n) => el("option", { value: n })));
    },
    () => {},
  );
}

function classRow(c, today, reload) {
  const d = daysBetween(today, c.date);
  const [kindText, color] = CLASS_KIND_PILL[c.kind] ?? [c.kind, "gray"];
  const time = c.start ? `${c.start}${c.end ? `~${c.end}` : ""}` : "";
  const detail = [time, c.place, c.from_date ? `원래 ${md(c.from_date)} (${weekday(c.from_date)})` : ""].filter(Boolean).join(" · ");
  return el(
    "tr",
    {},
    el("td", {}, el("span", { className: "date-main", textContent: dayLabel(c.date) }), d >= 0 ? el("span", { className: `date-note ${d <= 1 ? "soon" : "ok"}`, textContent: d === 0 ? "오늘" : d === 1 ? "내일" : `D-${d}` }) : null),
    el("td", {}, el("span", { className: "title" + (d < 0 ? " done" : ""), textContent: c.course }), el("span", { className: "sub when-sub", textContent: [kindText, detail].filter(Boolean).join(" · ") }), c.note ? el("span", { className: "sub", textContent: c.note }) : null),
    el("td", { className: "hide-sm" }, pill(kindText, color), detail ? el("span", { className: "muted class-detail", textContent: detail }) : null),
    el(
      "td",
      { className: "actions" },
      iconBtn("수정", "edit", () => openClassDialog(c)),
      iconBtn("삭제", "trash", () => {
        if (confirm(`${dayLabel(c.date)} ${c.course} 기록을 삭제할까요?`)) call(`/api/class-changes/${c.id}`, { method: "DELETE" }).then(reload, showError);
      }, "danger"),
    ),
  );
}

async function loadClasses() {
  const { date: today, changes } = await call("/api/class-changes");
  const reload = () => loadClasses().catch(showError);
  const q = searchText();
  const shown = changes.filter((c) => !q || [c.course, c.place, c.note].some((v) => v.toLowerCase().includes(q)));
  const ahead = shown.filter((c) => c.date >= today);
  const past = shown.filter((c) => c.date < today).reverse();
  const week = changes.filter((c) => c.date >= today && daysBetween(today, c.date) < 7);
  const tomorrow = changes.filter((c) => daysBetween(today, c.date) === 1);
  $("class-stats").replaceChildren(
    stat("앞으로 바뀐 수업", String(changes.filter((c) => c.date >= today).length), "오늘 포함"),
    stat("이번 주(7일 안)", String(week.length), week.length ? week.map((c) => c.course).filter((v, i, a) => a.indexOf(v) === i).join(", ") : ""),
    stat("내일", String(tomorrow.length), tomorrow.length ? tomorrow.map((c) => `${c.course} ${c.kind}`).join(", ") : "알림 받을 수업 없음"),
  );
  const pastRow = el("tr", { className: "group-row fold" }, el("td", { colSpan: 3 }, el("button", { className: "btn ghost sm", type: "button", onclick: () => ((classPastOpen = !classPastOpen), reload()) }, classPastOpen ? "지난 기록 접기" : `지난 기록 ${past.length}개 보기`)), el("td", { className: "hide-sm" }));
  $("class-list").replaceChildren(
    ...(ahead.length ? ahead.map((c) => classRow(c, today, reload)) : [el("tr", { className: "empty-row" }, el("td", { colSpan: 3, textContent: q ? "검색 결과가 없습니다." : "앞으로 바뀐 수업이 없습니다. 오른쪽 위 '바뀐 수업 기록'으로 적어 두세요." }), el("td", { className: "hide-sm" }))]),
    ...(past.length ? [pastRow, ...(classPastOpen ? past.map((c) => classRow(c, today, reload)) : [])] : []),
  );
}

// 캘린더: 한 달(6주) 칸에 구글 캘린더 일정과 날짜 있는 할 일·과제를 함께 보여 준다.
const seoulToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
const isoDay = (d) => d.toISOString().slice(0, 10);
const plusDays = (date, n) => isoDay(new Date(Date.parse(date + "T00:00:00Z") + n * DAY));
let calMonth = seoulToday().slice(0, 7); // YYYY-MM
let calWrite = false; // 구글 일정을 여기서 만들고 고칠 수 있다(쓰기 권한)
let calendars = []; // 일정을 넣을 수 있는 구글 캘린더
let editingEvent = null;

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
    data.google === "ok" && !data.write ? el("span", {}, " · ", el("a", { href: "/auth/login", className: "date-main", textContent: "일정 쓰기 권한 받기" })) : "",
  );
  calWrite = !!data.write;
  calendars = data.calendars ?? [];

  const q = searchText();
  const byDay = new Map();
  const put = (day, item) => (byDay.get(day) ?? byDay.set(day, []).get(day)).push(item);
  for (const e of data.events) {
    if (q && !e.title.toLowerCase().includes(q)) continue;
    for (let d = e.startDate < from ? from : e.startDate; d <= e.endDate && d <= to; d = plusDays(d, 1)) {
      put(d, { sort: d === e.startDate && e.time ? e.time : "", node: () => eventItem(e, d) });
    }
  }

  const heads = ["일", "월", "화", "수", "목", "금", "토"].map((w) => el("div", { className: "cal-head", textContent: w }));
  const days = [];
  for (let i = 0; i < 42; i++) {
    const d = plusDays(from, i);
    const items = (byDay.get(d) ?? []).sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0));
    const cls = "cal-day" + (d.slice(0, 7) !== month ? " other" : "") + (d === today ? " today" : "");
    days.push(
      el(
        "div",
        calWrite
          ? { className: cls + " add", title: `${md(d)}에 구글 일정 추가`, onclick: (ev) => (ev.target === ev.currentTarget || ev.target.classList.contains("cal-num") ? openEventDialog(null, d) : null) }
          : { className: cls },
        el("span", { className: "cal-num", textContent: Number(d.slice(8)) }),
        ...items.map((x) => x.node()),
      ),
    );
  }
  $("cal-grid").replaceChildren(...heads, ...days);
}

// 구글 일정 창. e = 고칠 일정(없으면 새 일정, date 날짜로).
function openEventDialog(e = null, date = seoulToday()) {
  editingEvent = e;
  $("event-dialog-title").textContent = e ? "구글 일정 수정" : "새 구글 일정";
  $("event-calendar-box").hidden = !!e;
  const primary = calendars.find((c) => c.primary) ?? calendars[0];
  $("event-calendar").replaceChildren(...calendars.map((c) => el("option", { value: c.id, textContent: c.name })));
  if (primary) $("event-calendar").value = primary.id;
  $("event-title").value = e?.title ?? "";
  $("event-allday").checked = e ? !e.time : true;
  $("event-date").value = e?.startDate ?? date;
  $("event-time").value = e?.time ?? "";
  $("event-end-date").value = e?.end ?? date;
  $("event-end-time").value = e?.endTime ?? "";
  $("event-location").value = e?.location ?? "";
  $("event-description").value = e?.description ?? "";
  $("event-delete").hidden = !e;
  $("event-open").hidden = !e?.link;
  $("event-open").href = e?.link || "https://calendar.google.com/";
  $("event-msg").textContent = "";
  syncEventTime();
  $("event-dialog").showModal();
}
const syncEventTime = () => {
  const allDay = $("event-allday").checked;
  document.querySelectorAll("#event-dialog .event-time").forEach((x) => (x.hidden = allDay));
  if (!allDay && !$("event-time").value) $("event-time").value = "09:00";
};

// 구글 일정: 바꿀 수 있는 캘린더의 일정은 눌러서 여기서 고치고, 아니면 구글 캘린더에서 연다. 여러 날 일정의 시간은 첫날에만 쓴다.
function eventItem(e, day) {
  const time = e.time && day === e.startDate ? e.time : "";
  const props = e.editable && calWrite
    ? { type: "button", onclick: () => openEventDialog(e) }
    : { href: e.link || "https://calendar.google.com/", target: "_blank", rel: "noopener" };
  return el(
    e.editable && calWrite ? "button" : "a",
    { className: "cal-item", ...props, title: `${e.title}${time ? " · " + time : ""}${e.calendar ? " · " + e.calendar : ""}` },
    el("i", { className: "dot", style: e.color ? `background:${e.color}` : "" }),
    time ? el("span", { className: "t", textContent: time }) : null,
    el("span", { textContent: e.title }),
  );
}

// 시험: 시험마다 일정(날짜·시간·장소·범위).
const weekday = (d) => "일월화수목금토"[new Date(d + "T00:00:00Z").getUTCDay()];
const dday = (today, date) => {
  const n = daysBetween(today, date);
  return n === 0 ? "D-day" : n > 0 ? `D-${n}` : `D+${-n}`;
};
const dayLabel = (d) => `${md(d)} (${weekday(d)})`;
let editingExam = null;
let pastOpen = false; // the 지난 시험 fold stays as it was across redraws
const EXAM_KEYS = ["title", "course", "date", "time", "place", "scope", "note"];
// The exam's name on its card: the course leads, the exam's own name (기말고사, …) goes under it.
const examName = (e) => e.course || e.title;

function openExamDialog(e = null) {
  editingExam = e;
  $("exam-dialog-title").textContent = e ? "시험 수정" : "새 시험";
  for (const k of EXAM_KEYS) $(`exam-${k}`).value = e?.[k] ?? "";
  document.querySelector(`#exam-colors input[value="${e?.color ?? ""}"]`).checked = true;
  $("exam-msg").textContent = "";
  $("exam-dialog").showModal();
}

// 과목별 공부량: 공부 탭에 그 과목으로 적은 공부 중 끝낸 것/전체와 밀린 것. until이 있으면 그날 뒤로 잡은 것은 빼고(시험 날까지),
// 날짜를 아직 안 정한 것은 넣는다.
function studyCount(studies, course, today, until = null) {
  const list = studies.filter((s) => s.course === course && (!until || !s.date || s.date <= until));
  return { total: list.length, done: list.filter((s) => s.done).length, late: list.filter((s) => !s.done && s.date && s.date < today).length };
}
const meter = (c) =>
  el(
    "div",
    { className: "meter" },
    el("div", { className: "meter-track" }, el("div", { className: "meter-fill", style: `width:${c.total ? Math.round((c.done / c.total) * 100) : 0}%` })),
    el("span", { className: "meter-text", textContent: `${c.done}/${c.total}` + (c.late ? ` · 밀린 ${c.late}` : "") }),
  );
// Stat cards for the next exams: the course (or name) with a big D-N; with studies (the 공부 tab) also how much of it is done.
const examStats = (ahead, today, studies = null) =>
  ahead.slice(0, 4).map((e) => {
    const c = studies && e.course ? studyCount(studies, e.course, today, e.date) : null;
    return stat(examName(e), dday(today, e.date), [dayLabel(e.date), c && c.total ? `공부 ${c.done}/${c.total}` : ""].filter(Boolean).join(" · "), daysBetween(today, e.date) <= 3);
  });

async function loadExams() {
  const { date: today, exams } = await call("/api/exams");
  const reload = () => loadExams().catch(showError);
  const q = searchText();
  const shown = exams.filter((e) => !q || [e.title, e.course, e.place, e.scope, e.note].join("\n").toLowerCase().includes(q));
  const ahead = exams.filter((e) => e.date && e.date >= today);
  $("exam-stats").replaceChildren(...(ahead.length ? examStats(ahead, today) : [stat("다가오는 시험", "0", "")]));
  const upcoming = shown.filter((e) => !e.date || e.date >= today);
  const past = shown.filter((e) => e.date && e.date < today).reverse(); // the latest first
  const card = (e) => examCard(e, today, reload);
  const out = upcoming.map(card);
  if (past.length) {
    const fold = el("details", { className: "exam-past", open: pastOpen || !!q, ontoggle() { if (!q) pastOpen = this.open; } }, el("summary", {}, icon("right"), `지난 시험 · ${past.length}`), ...past.map(card));
    out.push(fold);
  }
  if (!shown.length) out.push(el("p", { className: "notice", textContent: q ? "검색 결과가 없습니다." : "아직 시험이 없습니다." }));
  $("exam-list").replaceChildren(...out);
}

function examCard(e, today, reload) {
  const n = e.date ? daysBetween(today, e.date) : null;
  const badge = n === null ? pill("날짜 미정", "gray") : n < 0 ? pill("끝남", "gray") : pill(dday(today, e.date), n <= 3 ? "orange" : n <= 7 ? "amber" : "blue");
  const when = e.date ? dayLabel(e.date) + (e.time ? " " + e.time : "") : "날짜 미정";
  const remove = () => confirm(`"${[e.course, e.title].filter(Boolean).join(" ")}" 시험을 지울까요?`) && call(`/api/exams/${e.id}`, { method: "DELETE" }).then(reload, showError);
  return el(
    "section",
    { className: "exam" + (e.color ? ` c-${e.color}` : "") + (n !== null && n < 0 ? " past" : "") },
    el(
      "div",
      { className: "exam-head" },
      badge,
      el("div", { className: "grow" }, el("h2", { textContent: examName(e) }), el("div", { className: "muted", textContent: [e.course ? e.title : "", when, e.place].filter(Boolean).join(" · ") })),
      iconBtn("시험 수정", "edit", () => openExamDialog(e)),
      iconBtn("시험 삭제", "trash", remove, "danger"),
    ),
    e.scope ? el("div", { className: "exam-text" }, el("span", { className: "muted", textContent: "범위" }), el("p", { textContent: e.scope })) : null,
    e.note ? el("div", { className: "exam-text" }, el("span", { className: "muted", textContent: "메모" }), el("p", { textContent: e.note })) : null,
  );
}

// 공부: 과목마다 공부할 것 목록. 줄마다 언제 할지 날짜를 붙이고(안 정해도 됨) 끝내면 체크한다. 캘린더에는 나오지 않는다.
// 날짜가 된 줄은 할 일·과제의 "오늘 할 일"에도 들어가고(서버), 어느 쪽에서 체크해도 같이 체크된다.
// 과목 카드는 이번 학기 시간표의 과목(시간표 순서)과 공부에 적은 다른 과목, 과목 없이 적은 것("과목 없음") 순.
let editingStudy = null;
const studyDrafts = new Map(); // course → { title, date } typed into that course's card, kept across redraws
let studyFocus = null; // the course whose card gets the focus back after the list is redrawn

async function loadStudies() {
  const [{ date: today, studies, hidden }, { exams }, tt] = await Promise.all([call("/api/studies"), call("/api/exams"), call("/api/timetable")]);
  const reload = () => loadStudies().catch(showError);
  const term = tt.semesters.find((m) => m.year === tt.current.year && m.term === tt.current.term);
  const allTermCourses = tt.courses.filter((c) => term && c.semester_id === term.id).map((c) => c.name);
  const termCourses = allTermCourses.filter((c) => !hidden.includes(c)); // 과목 삭제로 뺀 과목은 카드 없이 '다른 과목' 목록에만
  const others = [...new Set(studies.map((s) => s.course).filter((c) => c && !termCourses.includes(c)))].sort((a, b) => a.localeCompare(b, "ko"));
  const courses = [...new Set([...termCourses, ...others])];
  if (studies.some((s) => !s.course)) courses.push("");
  $("study-courses").replaceChildren(...[...new Set([...courses, ...allTermCourses])].filter(Boolean).map((c) => el("option", { value: c })));
  const todays = studies.filter((s) => s.date === today);
  const undated = studies.filter((s) => !s.date && !s.done);
  const late = studies.filter((s) => s.date && s.date < today && !s.done);
  $("study-stats").replaceChildren(
    stat("오늘 공부", `${todays.filter((s) => s.done).length}/${todays.length}`, ""),
    stat("날짜 안 정한 공부", String(undated.length), ""),
    stat("밀린 공부", String(late.length), "", late.length > 0),
    ...examStats(exams.filter((e) => e.date && e.date >= today && !hidden.includes(e.course)), today, studies).slice(0, 1),
  );
  const q = searchText();
  const out = [];
  let focusIn = null;
  for (const c of courses) {
    const list = studies.filter((s) => s.course === c && (!q || [s.title, s.course].join("\n").toLowerCase().includes(q)));
    if (q && !list.length) continue;
    const next = c ? exams.find((e) => e.course === c && e.date && e.date >= today) : null;
    const add = studyAdd(c);
    if (studyFocus === c) focusIn = add.querySelector("input");
    out.push(
      el(
        "section",
        { className: "exam study-course" },
        el(
          "div",
          { className: "exam-head" },
          el("div", { className: "grow" }, el("h2", { textContent: c || "과목 없음" })),
          next ? pill(`시험 ${dday(today, next.date)}`, daysBetween(today, next.date) <= 3 ? "orange" : "amber") : null,
          iconBtn("과목 삭제", "trash", () => deleteStudyCourse(c, studies.filter((s) => s.course === c).length).then(reload, showError), "danger"),
        ),
        list.length ? meter(studyCount(studies, c, today)) : null,
        list.length ? el("ul", { className: "plan" }, ...list.map((s) => studyRow(s, today, reload))) : null,
        add,
      ),
    );
  }
  if (q && !out.length) out.push(el("p", { className: "notice", textContent: "검색 결과가 없습니다." }));
  if (!q) out.push(studyAddCourse());
  $("study-list").replaceChildren(...out);
  focusIn?.focus();
  studyFocus = null;
}

// 과목 삭제: the card goes with its lines. A 시간표 course stays off until a line is written for it again ('다른 과목').
async function deleteStudyCourse(course, count) {
  const name = course || "과목 없음";
  if (!confirm(count ? `"${name}" 과목과 공부 ${count}줄을 지울까요?` : `"${name}" 과목을 공부 탭에서 뺄까요?`)) return;
  studyDrafts.delete(course);
  await call("/api/studies/course", { method: "DELETE", body: { course } });
}

// A day field that shows only its calendar button while empty (no "연도. 월. 일." placeholder).
function dateInput(props) {
  const input = el("input", { className: "input date", type: "date", ...props });
  const sync = () => input.classList.toggle("empty", !input.value);
  input.addEventListener("input", sync);
  input.addEventListener("change", sync);
  input.addEventListener("click", () => {
    try {
      if (!input.value) input.showPicker?.(); // the whole small box opens the calendar, not just the icon
    } catch {}
  });
  sync();
  return input;
}

// The write-in line at the bottom of a course's card: what to study and, if already known, the day.
function studyAdd(course) {
  const draft = studyDrafts.get(course) ?? { title: "", date: "" };
  studyDrafts.set(course, draft);
  const textIn = el("input", { className: "input", placeholder: "공부할 내용", maxLength: 200, value: draft.title, oninput() { draft.title = this.value; } });
  const dateIn = dateInput({ title: "할 날짜 (비워 두면 미정)", ariaLabel: "할 날짜", value: draft.date, oninput() { draft.date = this.value; } });
  const add = async (ev) => {
    ev.preventDefault();
    if (!textIn.value.trim()) return textIn.focus();
    try {
      await call("/api/studies", { method: "POST", body: { course, title: textIn.value, date: dateIn.value } });
      draft.title = "";
      studyFocus = course;
      await loadStudies();
    } catch (err) {
      showError(err);
    }
  };
  return el("form", { className: "plan-add study-add", onsubmit: add }, textIn, dateIn, el("button", { className: "btn", type: "submit" }, icon("plus"), "추가"));
}

// Under the cards: a line for a course that has no card yet (not in this semester's 시간표).
function studyAddCourse() {
  const courseIn = el("input", { className: "input course", placeholder: "다른 과목", maxLength: 100 });
  courseIn.setAttribute("list", "study-courses");
  const textIn = el("input", { className: "input", placeholder: "공부할 내용", maxLength: 200 });
  const dateIn = dateInput({ title: "할 날짜 (비워 두면 미정)", ariaLabel: "할 날짜" });
  const add = async (ev) => {
    ev.preventDefault();
    if (!courseIn.value.trim()) return courseIn.focus();
    if (!textIn.value.trim()) return textIn.focus();
    try {
      await call("/api/studies", { method: "POST", body: { course: courseIn.value, title: textIn.value, date: dateIn.value } });
      studyFocus = courseIn.value.trim();
      await loadStudies();
    } catch (err) {
      showError(err);
    }
  };
  return el("form", { className: "plan-add study-add study-new-course", onsubmit: add }, courseIn, textIn, dateIn, el("button", { className: "btn", type: "submit" }, icon("plus"), "과목 추가"));
}

// A line of the list: check it off, or set / change / clear its day right there.
function studyRow(s, today, reload) {
  const update = (patch) => call(`/api/studies/${s.id}`, { method: "PATCH", body: patch }).then(reload, showError);
  const late = !s.done && s.date && s.date < today;
  return el(
    "li",
    { className: s.done ? "done" : late ? "late" : "" },
    el("input", { type: "checkbox", checked: !!s.done, title: "끝냄 표시", onchange() { update({ done: this.checked }); } }),
    el("span", { className: "plan-title", textContent: s.title }),
    s.date === today ? pill("오늘", "blue") : late ? pill("밀림", "orange") : null,
    dateInput({ value: s.date ?? "", title: "할 날짜", ariaLabel: `${s.title} 할 날짜`, onchange() { update({ date: this.value }); } }),
    iconBtn("수정", "edit", () => openStudyDialog(s)),
    iconBtn("삭제", "trash", () => confirm(`"${s.title}" 을(를) 지울까요?`) && call(`/api/studies/${s.id}`, { method: "DELETE" }).then(reload, showError), "danger"),
  );
}

function openStudyDialog(s) {
  editingStudy = s;
  $("study-edit-date").value = s.date ?? "";
  $("study-edit-course").value = s.course;
  $("study-edit-title").value = s.title;
  $("study-msg").textContent = "";
  $("study-dialog").showModal();
}

function updateOverdueBadge(n) {
  $("nav-overdue").hidden = !n;
  $("nav-overdue").textContent = n;
}

// 알림: 서버가 정한 때(아침 요약, 과제 마감 전, 시험 전날)에 보내는 알림을 이 기기에서 받는다.
// 웹 푸시가 되면(휴대폰 앱·브라우저) 서비스 워커가 받아 창이 닫혀 있어도 뜨고, 안 되면(PC 프로그램) 이 화면이 1분마다
// 새 알림을 물어 직접 띄운다(notifyMode "page", 창이 열려 있는 동안만).
// PC 프로그램(Tauri) 안이면 프로그램이 윈도우 알림을 띄운다(WebView2 는 웹 알림을 막는다).
const tauriNotify = window.__TAURI__?.notification ?? null;
const pushSupported = () => !tauriNotify && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const notifyMode = () => storage(() => localStorage.getItem("notifyMode")) || "";
let notifyPoll = null;
// 알림 켜기 시도 번호: 끄거나 다시 켜면 올라가서, 그 전 시도(시간이 지나 멈춘 것)는 다음 단계로 못 간다.
let notifyAttempt = 0;
let notifyWanted = false; // 마지막으로 누른 것이 켜기인가
// 서비스 워커 범위는 /admin: 안드로이드 크롬은 이 범위 주소를 여는 앱(TWA, /admin 만 맡음)이 있을 때만
// 알림을 그 앱 이름으로 넘긴다. 범위가 / 면 크롬 이름으로 떠서 크롬 알림을 끈 휴대폰에서는 사라진다.
const SW_SCOPE = "/admin";

// /admin 에 등록이 없으면 getRegistration 은 예전 / 등록을 준다: 그건 이 기기의 구독으로 치지 않는다.
async function pushSubscription() {
  const reg = await navigator.serviceWorker.getRegistration(SW_SCOPE);
  return reg && new URL(reg.scope).pathname === SW_SCOPE ? reg.pushManager.getSubscription() : null;
}

// 예전 범위(/)의 서비스 워커: 그 구독으로 가는 알림은 크롬 이름으로 뜨므로 서버·브라우저에서 지우고 등록을 푼다.
async function dropOldWorkers() {
  for (const reg of await navigator.serviceWorker.getRegistrations()) {
    if (new URL(reg.scope).pathname === SW_SCOPE) continue;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await call("/api/push/unsubscribe", { method: "POST", body: { endpoint: sub.endpoint } }).catch(() => {});
      await sub.unsubscribe();
    }
    await reg.unregister();
  }
}

// 구독은 켜진(active) 워커가 있어야 된다. serviceWorker.ready 는 예전 / 워커로 이미 끝났을 수 있어서 이 등록을 직접 기다린다.
async function untilActive(reg) {
  const w = reg.installing || reg.waiting;
  if (reg.active || !w) return;
  await new Promise((ok, fail) =>
    w.addEventListener("statechange", () => (w.state === "activated" ? ok() : w.state === "redundant" && fail(new Error("서비스 워커를 켜지 못했습니다")))),
  );
}

// 이 기기의 알림 상태 글.
async function notifyStateText() {
  if (tauriNotify) return notifyMode() === "page" ? "켜짐 · 프로그램이 켜져 있는 동안(최소화해도) 받습니다." : "꺼짐";
  if (!("Notification" in window)) return "이 기기(브라우저)는 알림을 지원하지 않습니다.";
  if (Notification.permission === "denied") return "알림이 차단돼 있습니다. 휴대폰 앱이면 휴대폰 설정 → 애플리케이션 → kacarong → 알림에서 알림 허용과 아래 알림 카테고리(일반 등)를 모두 켠 다음, 설정 → 애플리케이션 → Chrome → 강제 중지를 누르고(또는 휴대폰을 다시 켜고) kacarong을 다시 열어 주세요. 앱 화면은 크롬이 띄우는데, 크롬은 새로 켜질 때만 알림 설정을 다시 읽어서 이미 켜 두셨어도 이렇게 해야 적용됩니다(크롬 알림은 꺼져 있어도 됩니다). 브라우저면 브라우저의 사이트 설정에서 허용해 주세요.";
  if (notifyMode() === "page" && Notification.permission === "granted") return "켜짐 · 이 화면이 열려 있는 동안 받습니다.";
  if (notifyMode() === "push" && pushSupported() && (await pushSubscription().catch(() => null))) return "켜짐 · 앱·브라우저가 닫혀 있어도 받습니다.";
  return "꺼짐";
}

// 백업: 매일 드라이브에 올리는 사본이 잘 되고 있는지, 드라이브에 남은 사본, 지금 백업, 받기.
const timeText = (iso) => new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
function showBackup(s) {
  // backup_at 이 생기기 전에 한 백업은 날짜만 안다.
  const last = s.at ? timeText(s.at) : s.last ? md(s.last) : "";
  const [text, warn] = !s.on
    ? ["구글 드라이브가 연결되지 않아 백업하지 않습니다.", true]
    : s.error
      ? [`${timeText(s.error.at)}에 백업하지 못했습니다(한 시간 뒤 다시 합니다): ${s.error.message}${last ? ` · 마지막으로 된 백업 ${last}` : ""}`, true]
      : s.late
        ? [last ? `마지막 백업 ${last} — 오늘 백업이 아직 안 됐습니다.` : "아직 백업한 적이 없습니다.", true]
        : !last
          ? ["아직 백업한 적이 없습니다. 오늘 안에 자동으로 합니다.", false]
          : [`잘 되고 있습니다 · 마지막 백업 ${last}`, false];
  $("backup-state").textContent = text;
  $("backup-state").classList.toggle("warn", warn);
  const day = (name) => dayLabel(name.slice(6, 16));
  $("backup-list").replaceChildren(
    ...(s.files.length
      ? s.files.map((f) =>
          el(
            "tr",
            {},
            el("td", { textContent: day(f.name) }),
            el("td", { className: "hide-sm muted", textContent: f.createdTime ? timeText(f.createdTime) : "" }),
            el("td", { className: "num", textContent: sizeText(f.size) }),
            el("td", { className: "actions" }, el("a", { className: "btn ghost sm", href: `/api/backup/${encodeURIComponent(f.id)}`, download: f.name, title: "받기", ariaLabel: `${f.name} 받기` }, icon("download"))),
          ),
        )
      : [emptyRow(4, s.listError ? `목록을 읽지 못했습니다: ${s.listError}` : "드라이브에 백업이 없습니다.")]),
  );
  $("backup-now").disabled = !s.on || s.running;
}
async function openBackup() {
  $("backup-msg").textContent = "";
  $("backup-state").textContent = "불러오는 중…";
  $("backup-list").replaceChildren();
  $("backup-dialog").showModal();
  showBackup(await call("/api/backup"));
}

async function openNotify() {
  const { settings } = await call("/api/notify");
  $("notify-morning-on").checked = !!settings.morning;
  $("notify-morning").value = settings.morning || "08:00";
  $("notify-homework").checked = settings.homework;
  $("notify-exam").checked = settings.exam;
  $("notify-classes").checked = settings.classes;
  $("notify-msg").textContent = "";
  await showNotifyState();
  $("notify-dialog").showModal();
}

async function showNotifyState() {
  const text = await notifyStateText();
  $("notify-state").textContent = text;
  $("notify-toggle").textContent = text.startsWith("켜짐") ? "이 기기 알림 끄기" : "이 기기에서 알림 받기";
  $("notify-toggle").hidden = !tauriNotify && !("Notification" in window);
}

async function notifyOn() {
  if (tauriNotify) {
    if (!(await tauriNotify.isPermissionGranted()) && (await tauriNotify.requestPermission()) !== "granted") throw new Error("윈도우 설정에서 알림이 꺼져 있습니다.");
    storage(() => localStorage.setItem("notifyMode", "page"));
    return startNotifyPoll();
  }
  if ((await Notification.requestPermission()) !== "granted") throw new Error("알림을 허용하지 않아 켤 수 없습니다. 휴대폰 앱이면 휴대폰 설정 → 애플리케이션 → kacarong → 알림에서 알림 허용과 알림 카테고리(일반 등)를 모두 켜고, 설정 → 애플리케이션 → Chrome → 강제 중지를 누른 뒤(또는 휴대폰을 다시 켠 뒤) kacarong을 다시 열어 눌러 주세요. 이미 켜 두셨어도 크롬이 새로 켜져야 적용됩니다(크롬 알림은 꺼져 있어도 됩니다).");
  let pushError = null;
  if (pushSupported()) {
    // 등록이 끝나지 않고 멈추는 휴대폰이 있어서, 20초 안에 안 끝나면 실패로 친다(버튼이 아무 말 없이 멈추지 않게).
    // 시간이 지났거나 그 뒤에 끄고/다시 켠 시도는 다음 단계로 가지 않는다.
    notifyWanted = true;
    const my = ++notifyAttempt;
    let step = "시작";
    let timedOut = false;
    const stale = () => timedOut || my !== notifyAttempt;
    const subscribe = async () => {
      step = "서버에서 키 받기";
      const { publicKey } = await call("/api/notify");
      if (stale()) return;
      step = "예전 서비스 워커 정리";
      await dropOldWorkers();
      if (stale()) return;
      step = "서비스 워커 등록";
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: SW_SCOPE });
      if (stale()) return;
      step = "서비스 워커 켜기";
      await untilActive(reg);
      if (stale()) return;
      step = "푸시 구독";
      const existing = await reg.pushManager.getSubscription();
      if (stale()) return;
      const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey }));
      // 멈췄다가 늦게 끝난 구독: 이 시도가 새로 만든 것만, 이 시도가 마지막이거나(화면은 이미 "웹 푸시 아님") 끈 뒤일 때 지운다.
      // 그 뒤에 다시 켠 시도가 있으면 같은 구독을 쓰고 있을 수 있어서 둔다.
      const droppedLate = async () => {
        if (!stale()) return false;
        if (!existing && (my === notifyAttempt || !notifyWanted)) {
          await call("/api/push/unsubscribe", { method: "POST", body: { endpoint: sub.endpoint } }).catch(() => {});
          await sub.unsubscribe().catch(() => {});
        }
        return true;
      };
      if (await droppedLate()) return;
      step = "서버에 이 기기 등록";
      await call("/api/push/subscribe", { method: "POST", body: sub.toJSON() });
      await droppedLate();
    };
    try {
      await Promise.race([
        subscribe().catch((e) => Promise.reject(new Error(`${step}: ${e?.message || e}`))),
        new Promise((_, fail) => setTimeout(() => ((timedOut = true), fail(new Error(`${step}: 20초 안에 끝나지 않음`))), 20_000)),
      ]);
      storage(() => localStorage.setItem("notifyMode", "push"));
      return;
    } catch (e) {
      console.warn("웹 푸시를 쓸 수 없어 화면이 직접 알림을 띄웁니다:", e);
      pushError = e;
    }
  }
  if (pushError) {
    // 안드로이드 크롬은 화면의 new Notification 을 막는다: 켜진 서비스 워커도 없으면 화면이 직접 띄우는 방식도 안 된다.
    // 확인 알림을 하나 띄워 보고, 안 되면 켜지 않고 이유를 보여 준다.
    try {
      await showLocal({ id: "on", title: "kacarong 알림", body: "이 화면이 열려 있는 동안 알림을 받습니다.", url: "/admin" });
    } catch (e) {
      throw new Error(`이 기기에서 알림을 켜지 못했습니다. (웹 푸시 — ${pushError.message} / 화면 알림 — ${e?.message || e})`);
    }
  }
  storage(() => localStorage.setItem("notifyMode", "page"));
  startNotifyPoll();
  if (pushError) $("notify-msg").textContent = `앱이 닫혀 있을 때도 받는 알림을 켜지 못해, 이 화면이 열려 있는 동안만 받습니다. (이유: ${pushError.message})`;
}

// 화면이 직접 띄우는 알림. 켜진 /admin 서비스 워커가 있으면 그걸로 띄운다(안드로이드 크롬은 new Notification 을 막음).
async function showLocal(n) {
  const reg = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration(SW_SCOPE).catch(() => null) : null;
  if (reg?.active && new URL(reg.scope).pathname === SW_SCOPE) {
    return reg.showNotification(n.title, { body: n.body, icon: "/static/icon-192.png", tag: `n${n.id}`, data: { url: n.url } });
  }
  const shown = new Notification(n.title, { body: n.body, icon: "/static/icon-192.png", tag: `n${n.id}` });
  shown.onclick = () => {
    window.focus();
    location.hash = new URL(n.url, location.origin).hash;
  };
}

async function notifyOff() {
  notifyWanted = false;
  notifyAttempt++;
  if (pushSupported()) {
    await dropOldWorkers().catch(() => {});
    const sub = await pushSubscription().catch(() => null);
    if (sub) {
      await call("/api/push/unsubscribe", { method: "POST", body: { endpoint: sub.endpoint } });
      await sub.unsubscribe();
    }
  }
  storage(() => localStorage.removeItem("notifyMode"));
  clearInterval(notifyPoll);
  notifyPoll = null;
}

// notifyMode "page": 1분마다 새 알림을 물어 직접 띄운다. 처음에는 지금까지의 마지막 번호만 기억한다.
async function startNotifyPoll() {
  if (notifyPoll) return;
  let last = null;
  const check = async () => {
    if (!tauriNotify && Notification.permission !== "granted") return;
    const list = await call(`/api/notifications?after=${last ?? -1}`);
    if (last === null) return void (last = list[0]?.id ?? 0);
    for (const n of list) {
      last = n.id;
      if (tauriNotify) {
        tauriNotify.sendNotification({ title: n.title, body: n.body });
        continue;
      }
      await showLocal(n);
    }
  };
  notifyPoll = setInterval(() => check().catch(() => {}), 60_000);
  await check().catch(() => {});
}

// 노트: 고치면 잠깐 뒤 저장한다. 화면을 옮기거나 창을 닫을 때도 남은 것을 저장한다.
// 저장하지 못한 초안은 버리지 않는다: 저장이 실패하면 다른 노트를 열지 않는다. 다른 곳(노션, 다른 탭, 오늘 화면)에서
// 노트가 바뀌었으면(409) 블록마다 합쳐서(같은 블록을 둘 다 고쳤으면 이 화면 쪽) 다시 저장한다.
// 열어 둔 노트는 10초마다 서버에 물어 노션에서 바뀐 내용을 받는다.
let editor = null;
let noteFiles = null; // attachBox of the open note
let taskFiles = null; // attachBox of the task dialog
let noteId = null; // the open note
let noteVersion = 0; // the server version the editor content started from
let noteDirty = false;
let noteBase = { title: "", blocks: [] }; // the note as the server last had it, for merging
let noteLinks = {};
let noteSaving = null; // the save in flight
let noteLoadSeq = 0; // only the newest loadNotes may fill the editor
let noteTimer;
let focusTitle = false;
const noteTime = (s) => new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(s.replace(" ", "T") + "Z"));

function noteChanged() {
  noteDirty = true;
  $("note-status").textContent = "저장 전";
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => saveNote().catch(() => {}), 700);
}

// Resolves once everything typed so far is stored; rejects (keeping the draft) when it can't be.
async function saveNote(keepalive = false) {
  clearTimeout(noteTimer);
  while (noteSaving) await noteSaving.catch(() => {});
  if (!noteDirty || noteId === null) return;
  noteDirty = false;
  const id = noteId;
  const title = $("note-title").value;
  const blocks = structuredClone(editor.get());
  $("note-status").textContent = "저장 중…";
  noteSaving = call(`/api/notes/${id}`, { method: "PUT", body: { title, blocks, version: noteVersion }, keepalive });
  try {
    const r = await noteSaving;
    if (id !== noteId) return;
    noteVersion = r.version;
    noteBase = { title, blocks };
    if (!noteDirty) $("note-status").textContent = noteSyncText();
    const a = document.querySelector(`#note-list a[data-id="${id}"]`);
    if (a) a.replaceChildren(title || "제목 없음", el("small", { textContent: noteTime(r.updated_at) }));
  } catch (e) {
    if (id === noteId) {
      noteDirty = true; // 다음에 고치거나 화면을 옮길 때 다시 저장한다
      if (e.status === 409) {
        noteSaving = null;
        await mergeNote(id);
        return saveNote(keepalive);
      }
      $("note-status").textContent = "저장 실패: " + e.message;
    }
    throw e;
  } finally {
    noteSaving = null;
  }
}
const noteSyncText = () => (noteLinked ? "저장됨 · 노션에 반영" : "저장됨");
let noteLinked = false;

// 서버의 노트와 이 화면에서 고친 것을 합친다.
async function mergeNote(id) {
  const n = await call(`/api/notes/${id}`);
  if (id !== noteId) return;
  const local = { title: $("note-title").value, blocks: structuredClone(editor.get()) };
  const blocks = merge3(noteBase.blocks, local.blocks, n.blocks);
  const title = local.title !== noteBase.title ? local.title : n.title;
  noteBase = { title: n.title, blocks: n.blocks };
  noteVersion = n.version;
  noteLinks = n.links ?? {};
  if ($("note-title").value !== title) $("note-title").value = title; // 이 화면에서 고친 제목이 아니면 서버 제목으로
  editor.replace(blocks, noteLinks);
  showNoteNotion(n);
}

// 열어 둔 노트를 서버(노션에서 바뀐 것)와 맞춘다. 고치는 중이면 다음 저장 때 합친다.
async function refreshNote() {
  if (noteId === null || document.visibilityState !== "visible" || noteSaving || currentTab() !== "notes") return;
  const id = noteId;
  const n = await call(`/api/notes/${id}`);
  if (id !== noteId || n.version <= noteVersion) return;
  if (noteDirty || noteSaving) return; // the next save meets a 409 and merges
  // 제목은 포커스가 아니라 실제로 고쳤는지로: 고치지 않았으면 서버(노션) 제목으로 바꾼다.
  const titleEdited = $("note-title").value !== noteBase.title;
  noteBase = { title: n.title, blocks: n.blocks };
  noteVersion = n.version;
  noteLinks = n.links ?? {};
  if (!titleEdited) $("note-title").value = n.title;
  editor.replace(n.blocks, noteLinks);
  showNoteNotion(n);
  const a = document.querySelector(`#note-list a[data-id="${id}"]`);
  if (a) a.replaceChildren(n.title || "제목 없음", el("small", { textContent: noteTime(n.updated_at) }));
}

// 노션 페이지인 노트: 노션에서 열기, 데이터베이스 행이면 열 값(읽기만).
function showNoteNotion(n) {
  const box = $("note-notion");
  noteLinked = !!n.notion;
  box.hidden = !n.notion;
  if (!n.notion) return box.replaceChildren();
  box.replaceChildren(
    ...[
    el("a", { href: n.notion.url, target: "_blank", rel: "noopener", className: "btn ghost sm" }, "노션에서 열기 ↗"),
    n.notion.readOnly ? el("span", { className: "error", textContent: "읽기 전용" }) : null,
    n.notion.props.length ? el("dl", { className: "note-props" }, ...n.notion.props.flatMap(([k, v]) => [el("dt", { textContent: k }), el("dd", { textContent: v })])) : null,
    ].filter(Boolean),
  );
}

// 노트 목록은 노션처럼 상위 노트 밑에 하위 노트를 접어 둔 트리다(검색할 때는 맞는 노트만 평평하게).
// 펼친 노트는 기억하고, 연 노트의 상위 노트는 늘 펼친다.
let noteList = [];
const openNotes = new Set(JSON.parse(localStorage.getItem("noteOpen") || "[]"));
function noteLink(n) {
  const a = el("a", { href: `#notes/${n.id}`, className: n.id === noteId ? "active" : "" }, n.title || "제목 없음", el("small", { textContent: noteTime(n.updated_at) }));
  a.dataset.id = n.id;
  return a;
}
function noteTree(list) {
  const ids = new Set(list.map((n) => n.id));
  const kids = new Map();
  for (const n of list) {
    const up = ids.has(n.parent_id) ? n.parent_id : null;
    kids.set(up, [...(kids.get(up) ?? []), n]);
  }
  const placed = new Set();
  const branch = (n) => {
    placed.add(n.id);
    const under = (kids.get(n.id) ?? []).filter((k) => !placed.has(k.id));
    if (!under.length) return [el("div", { className: "note-row" }, el("span", { className: "note-fold" }), noteLink(n))];
    const group = el("div", { className: "note-kids", hidden: !openNotes.has(n.id) }, ...under.flatMap(branch));
    const fold = el("button", { type: "button", className: "note-fold", ariaLabel: "하위 노트 펼치기·접기" }, icon("right"));
    fold.ariaExpanded = String(!group.hidden);
    fold.onclick = () => {
      group.hidden = !group.hidden;
      fold.ariaExpanded = String(!group.hidden);
      group.hidden ? openNotes.delete(n.id) : openNotes.add(n.id);
      localStorage.setItem("noteOpen", JSON.stringify([...openNotes]));
    };
    return [el("div", { className: "note-row" }, fold, noteLink(n)), group];
  };
  const out = (kids.get(null) ?? []).flatMap(branch);
  for (const n of list) if (!placed.has(n.id)) out.push(...branch(n)); // 부모가 서로를 가리키는 경우에도 빠뜨리지 않는다
  return out;
}
function revealNote(id) {
  for (let g = document.querySelector(`#note-list a[data-id="${id}"]`)?.closest(".note-kids"); g; g = g.parentElement.closest(".note-kids")) {
    g.hidden = false;
    g.previousElementSibling.querySelector(".note-fold").ariaExpanded = "true";
  }
}

async function loadNoteList() {
  const list = await call("/api/notes?" + new URLSearchParams({ q: searchText() }));
  noteList = list;
  $("note-list").replaceChildren(
    ...(!list.length
      ? [el("span", { className: "muted", textContent: searchText() ? "검색 결과가 없습니다." : "노트가 없습니다." })]
      : searchText() ? list.map(noteLink) : noteTree(list)),
  );
  if (noteId !== null) revealNote(noteId); // 검색을 지워 목록을 다시 그려도 연 노트가 접힌 곳에 숨지 않게
  return list;
}

// 열 노트: 주소(#notes/3) → 지금 연 노트 → 지난번 노트 → 맨 위 노트. 늘 서버에서 새로 읽는다(오늘 화면에서 체크했을 수 있다).
// 읽는 동안에는 편집을 잠가서, 그사이 친 글이 도착한 내용에 덮이지 않게 한다.
async function loadNotes() {
  const seq = ++noteLoadSeq;
  const page = $("note-page");
  page.inert = true;
  try {
    try {
      await saveNote();
    } catch (e) {
      if (noteId !== null) history.replaceState(null, "", `#notes/${noteId}`); // 지금 노트에 머문다
      $("note-delete").hidden = noteId === null; // the bar was rebuilt by showTab
      $("note-sub").hidden = noteId === null;
      showError("노트를 저장하지 못해 다른 노트를 열지 않았습니다: " + e.message);
      return;
    }
    const list = await loadNoteList();
    if (seq !== noteLoadSeq) return;
    const wanted = [Number(location.hash.split("/")[1]), noteId, Number(localStorage.getItem("note")), list[0]?.id].filter(Boolean);
    let note = null;
    for (const id of new Set(wanted)) {
      note = await call(`/api/notes/${id}`).catch(() => null);
      if (seq !== noteLoadSeq) return; // a newer navigation took over
      if (note) break;
    }
    noteId = note?.id ?? null;
    noteVersion = note?.version ?? 0;
    noteDirty = false;
    page.hidden = !note;
    $("note-empty").hidden = !!note;
    $("note-delete").hidden = !note;
    $("note-sub").hidden = !note;
    document.querySelectorAll("#note-list a").forEach((a) => a.classList.toggle("active", Number(a.dataset.id) === noteId));
    if (note) revealNote(note.id);
    if (!note) return localStorage.removeItem("note");
    localStorage.setItem("note", note.id);
    $("note-title").value = note.title;
    noteBase = { title: note.title, blocks: note.blocks };
    noteLinks = note.links ?? {};
    showNoteNotion(note);
    $("note-status").textContent = noteSyncText();
    editor.setReadOnly(!!note.notion?.readOnly);
    $("note-title").readOnly = !!note.notion?.readOnly;
    editor.set(note.blocks, noteLinks);
    noteFiles.show(note.id);
    page.inert = false;
    if (focusTitle) $("note-title").focus();
    focusTitle = false;
  } finally {
    if (seq === noteLoadSeq) page.inert = false;
  }
}

async function newNote(under = null) {
  await saveNote(); // 저장하지 못하면 지금 노트에 머문다
  const n = await call("/api/notes", { method: "POST", body: under ? { parent_id: under } : {} });
  if (under) openNotes.add(under), localStorage.setItem("noteOpen", JSON.stringify([...openNotes]));
  focusTitle = true;
  location.hash = `#notes/${n.id}`;
  if (n.warning) setTimeout(() => showError(n.warning), 300);
}

async function deleteNote() {
  const hasKids = noteList.some((n) => n.parent_id === noteId);
  const kidsNote = noteLinked
    ? ` 노션에서도 휴지통으로 옮깁니다(노션 휴지통에서 되살리면 여기에도 돌아옵니다).${hasKids ? " 노션처럼 하위 노트도 함께 지워집니다." : ""}`
    : hasKids ? " 하위 노트는 지우지 않고 한 단계 위로 옮깁니다." : "";
  if (noteId === null || !confirm(`"${$("note-title").value || "제목 없음"}" 노트를 삭제할까요? 이 노트에서 만든 할 일도 함께 지워집니다.${kidsNote}`)) return;
  clearTimeout(noteTimer);
  noteDirty = false;
  await call(`/api/notes/${noteId}`, { method: "DELETE" });
  noteId = null;
  localStorage.removeItem("note");
  if (location.hash === "#notes") await loadNotes();
  else location.hash = "#notes";
}

// 노션 연동 창: 연결 상태, 토큰, 새 노트를 만들 노션 페이지. 맞추는 중이면 1초마다 진행을 묻는다.
let notionTimer;
function notionText(j) {
  if (!j.connected) return j.error ? `연결되어 있지 않습니다. ${j.error}` : "연결되어 있지 않습니다.";
  return [
    j.running ? `노션과 맞추는 중… 페이지 ${j.done}/${j.total || "?"}` : `연결됨${j.lastSync ? ` · 마지막으로 모두 맞춘 때 ${new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(j.lastSync))}` : ""}`,
    j.error && `문제: ${j.error}`,
    j.failed?.length && `맞추지 못한 페이지: ${j.failed.join(", ")}`,
    j.partial?.length && `읽기 전용 페이지: ${j.partial.join(", ")}`,
    j.fileProblems && `가져오지 못한 파일 ${j.fileProblems}개`,
  ].filter(Boolean).join("\n");
}
async function watchNotion(wasRunning = false) {
  clearTimeout(notionTimer);
  const j = await call("/api/notion");
  $("notion-state").textContent = notionText(j);
  $("notion-connect").hidden = j.connected && !j.error?.includes("토큰");
  $("notion-go").textContent = j.connected ? "토큰 바꾸기" : "연결";
  $("notion-off").hidden = !j.connected;
  $("notion-sync").hidden = !j.connected;
  $("notion-sync").disabled = j.running;
  $("notion-root-row").hidden = !j.connected || !j.pages.length;
  $("notion-root").replaceChildren(el("option", { value: "", textContent: "만들지 않음 (이 사이트에만)" }), ...j.pages.map((p) => el("option", { value: p.id, textContent: p.title })));
  $("notion-root").value = j.root ?? "";
  if (j.running && $("notion-dialog").open) notionTimer = setTimeout(() => watchNotion(true).catch(showError), 1000);
  else if (wasRunning && currentTab() === "notes") loadNotes().catch(showError);
}
function openNotion() {
  $("notion-token").value = "";
  $("notion-state").textContent = "";
  $("notion-dialog").showModal();
  watchNotion().catch(showError);
}

// 검색: 할 일은 화면에서 거르고, 파일은 서버에 묻는다.
const searchText = () => $("global-search").value.trim().toLowerCase();
const matches = (t, q) => !q || [t.title, t.course, t.note].some((v) => (v ?? "").toLowerCase().includes(q));

// 전체 검색: 검색칸에 적으면 노트·할 일·과제·시험·공부·지출·클라우드 파일을 한꺼번에 찾아 칸 아래에 띄운다.
// 하나를 고르면 검색칸을 비우고 그 화면으로 가서 연다. Esc·바깥을 누르면 목록만 닫히고 지금 화면은 전처럼 검색어로 걸러진다.
// [종류, 제목, 아이콘, 줄 글자(제목, 아랫줄), 갈 주소, 가서 열 것]
const when = (date, time) => (date ? md(date) + (time ? ` ${time}` : "") : "");
const SEARCH_GROUPS = [
  ["notes", "노트", "note", (n) => [n.title || "제목 없음", n.snippet], (n) => `#notes/${n.id}`, null],
  ["tasks", "할 일·과제", "check", (t) => [t.title, [t.kind, t.course, when(t.due_date, t.due_time), t.done && "끝냄"]], () => "#tasks", openTaskDialog],
  ["exams", "시험", "exam", (e) => [examName(e), [e.course && e.title, when(e.date, e.time), e.place]], () => "#exams", openExamDialog],
  ["studies", "공부", "book", (s) => [s.title, [s.course, s.date && md(s.date), s.done && "끝냄"]], () => "#studies", openStudyDialog],
  ["expenses", "지출", "wallet", (x) => [x.title, [won(x.amount), x.kind === "정기" ? (x.day ? `매달 ${x.day}일` : "매달") : x.date && md(x.date)]], () => "#expenses", (x) => openExpenseDialog(x)],
  // 폴더 고르기 칸이 폴더 목록을 알아야 파일이 엉뚱한 폴더로 옮겨지지 않는다.
  ["files", "클라우드", "folder", (f) => [f.title, [f.category, sizeText(f.size)]], (f) => `#files/${f.folder_id ?? ""}`, async (f) => ((folders = await call("/api/folders")), openFileDialog(f))],
];
let searchHits = []; // 보이는 결과 차례대로 { hash, open, kind }
let searchOn = 0; // 화살표로 고른 결과
let searchSeq = 0;
async function showSearch() {
  const box = $("search-results");
  const q = $("global-search").value.trim();
  const seq = ++searchSeq;
  if (!q) return void (box.hidden = true);
  const r = await call("/api/search?" + new URLSearchParams({ q }));
  if (seq !== searchSeq || document.activeElement !== $("global-search")) return; // 그사이 더 적었거나 칸을 떠났다
  searchHits = [];
  const groups = SEARCH_GROUPS.filter(([kind]) => r[kind].length).map(([kind, title, iconName, text, hash, open]) =>
    el(
      "section",
      {},
      el("h3", { textContent: title }),
      ...r[kind].map((x) => {
        const [main, sub] = text(x);
        const i = searchHits.push({ hash: hash(x), open: open && (() => open(x)), kind }) - 1;
        // 누르는 순간 검색칸이 포커스를 잃어 목록이 닫히지 않게 mousedown 은 막는다.
        return el(
          "button",
          { type: "button", className: "hit", onmousedown: (ev) => ev.preventDefault(), onmousemove: () => markSearch(i), onclick: () => pickSearch(i) },
          icon(iconName),
          el("span", {}, el("b", { textContent: main }), el("small", { textContent: [sub].flat().filter(Boolean).join(" · ") })),
        );
      }),
    ),
  );
  box.replaceChildren(...(groups.length ? groups : [el("p", { className: "muted", textContent: "찾은 것이 없습니다." })]));
  // 사이드바가 좁아서 목록은 검색칸 바로 아래에 화면 기준으로 띄운다.
  const at = $("global-search").closest(".search").getBoundingClientRect();
  Object.assign(box.style, { top: `${at.bottom + 6}px`, left: `${at.left}px`, width: `${Math.min(460, innerWidth - at.left - 12)}px` });
  box.hidden = false;
  markSearch(0);
}
function markSearch(i) {
  const hits = $("search-results").querySelectorAll(".hit");
  if (!hits.length) return;
  searchOn = (i + hits.length) % hits.length;
  hits.forEach((h, j) => h.classList.toggle("on", j === searchOn));
  hits[searchOn].scrollIntoView({ block: "nearest" });
}
function closeSearch() {
  searchSeq++; // 아직 오는 중인 결과도 띄우지 않는다
  $("search-results").hidden = true;
}
function pickSearch(i) {
  const h = searchHits[i];
  if (!h) return;
  $("global-search").value = "";
  if (h.kind === "files") $("q").value = "";
  closeSearch();
  $("global-search").blur();
  if (location.hash === h.hash) showTab(); // 같은 화면이면 주소가 안 바뀌어 다시 그리지 않으므로 직접(검색어 없이)
  else location.hash = h.hash;
  Promise.resolve(h.open?.()).catch(showError);
}

const tabs = {
  today: { title: "오늘", load: () => loadToday(), actions: () => [newTaskBtn()] },
  tasks: { title: "할 일·과제", load: () => loadTasks(), actions: () => [newTaskBtn()] },
  calendar: {
    title: "캘린더",
    load: () => loadCalendar(),
    actions: () => [
      ...(me?.calendarWrite ? [el("button", { className: "btn", type: "button", onclick: () => openEventDialog() }, icon("calendar"), "새 구글 일정")] : []),
    ],
  },
  exams: { title: "시험", load: () => loadExams(), actions: () => [el("button", { className: "btn primary", type: "button", onclick: () => openExamDialog() }, icon("plus"), "새 시험", el("kbd", { textContent: "N" }))] },
  studies: { title: "공부", load: () => loadStudies(), actions: () => [] },
  timetable: { title: "시간표", load: () => loadTimetable(), actions: () => [] },
  classes: { title: "수업일정", load: () => loadClasses(), actions: () => [el("button", { className: "btn primary", type: "button", onclick: () => openClassDialog() }, icon("plus"), "바뀐 수업 기록", el("kbd", { textContent: "N" }))] },
  expenses: { title: "지출", load: () => loadExpenses(), actions: () => [el("button", { className: "btn primary", type: "button", onclick: () => openExpenseDialog() }, icon("plus"), "새 지출", el("kbd", { textContent: "N" }))] },
  notes: {
    title: "노트",
    load: () => loadNotes(),
    actions: () => [
      el("button", { className: "btn ghost danger", type: "button", id: "note-delete", title: "노트 삭제", ariaLabel: "노트 삭제", hidden: true, onclick: () => deleteNote().catch(showError) }, icon("trash")),
      el("button", { className: "btn", type: "button", onclick: openNotion }, icon("download"), "노션 연동"),
      el("button", { className: "btn", type: "button", id: "note-sub", hidden: true, title: "지금 노트 아래에 하위 노트 만들기", onclick: () => newNote(noteId).catch(showError) }, icon("plus"), "하위 노트"),
      el("button", { className: "btn primary", type: "button", onclick: () => newNote().catch(showError) }, icon("plus"), "새 노트", el("kbd", { textContent: "N" })),
    ],
  },
  pdf: { title: "파일 편집기", load: () => loadPdfTools(), actions: () => [] },
  files: {
    title: "클라우드",
    load: () => {
      $("drive-off").hidden = me.driveConnected;
      return loadList();
    },
    actions: () =>
      me.driveConnected
        ? [
            el("button", { className: "btn", type: "button", onclick: () => openFolderDialog() }, icon("plus"), "새 폴더"),
            el("button", { className: "btn primary", type: "button", onclick: openUpload }, icon("upload"), "올리기", el("kbd", { textContent: "U" })),
          ]
        : [],
  },
  portfolio: {
    title: "포트폴리오",
    load: () => loadPortfolio(),
    actions: () => [
      el("a", { className: "btn", href: "/admin/portfolio", target: "_blank", title: "개인용 항목까지 보이는 내 포트폴리오" }, icon("eye"), "미리 보기"),
      el("button", { className: "btn", type: "button", onclick: newSection }, icon("plus"), "섹션 추가"),
      el("button", { className: "btn primary", type: "button", onclick: () => openItemDialog() }, icon("plus"), "새 항목", el("kbd", { textContent: "N" })),
    ],
  },
};
const newTaskBtn = () => el("button", { className: "btn primary", type: "button", onclick: () => openTaskDialog() }, icon("plus"), "새 할 일", el("kbd", { textContent: "N" }));

let pdfTools = null;
function loadPdfTools() {
  pdfTools ??= import("./pdftools.js" + new URL(import.meta.url).search).then((m) => m.mount($("tab-pdf"), { icon }));
  return pdfTools.catch((e) => {
    pdfTools = null; // 다음에 탭을 열 때 다시 시도
    throw e;
  });
}

// 올리기 창에서 고른 파일은 창을 닫고 차례로 올린다(진행은 클라우드 화면 위 목록에). 올리는 동안 더 골라도 뒤에 붙는다.
let uploadQueue = Promise.resolve();
let uploading = 0;
function queueUploads(files, meta) {
  const list = $("upload-queue");
  list.hidden = false;
  uploading += files.length;
  for (const f of files) {
    const line = progressLine(f, list, "기다리는 중");
    uploadQueue = uploadQueue.then(async () => {
      const row = await uploadOne(f, list, meta, line); // one at a time to keep bandwidth predictable
      uploading--;
      const done = () => {
        line.li.remove();
        list.hidden = !list.childElementCount;
      };
      if (row) setTimeout(done, 1500);
      else line.li.append(el("button", { className: "btn ghost sm", type: "button", textContent: "닫기", onclick: done })); // 실패 이유는 닫을 때까지 남긴다
      if (currentTab() === "files") loadList().catch(showError);
    });
  }
}
addEventListener("beforeunload", (ev) => {
  if (uploading) ev.preventDefault(); // 올리는 중에 창을 닫으면 끊긴다
});

function openUpload() {
  $("progress").replaceChildren();
  $("upload-where").textContent = pathText(currentFolder());
  $("upload-dialog").showModal();
}

function showPicked() {
  const files = [...$("files").files];
  $("drop-text").textContent = !files.length
    ? "파일 고르기"
    : files.length === 1 ? files[0].name : `${files[0].name} 외 ${files.length - 1}개`;
}

// 파일함 화면 어디에 끌어다 놓아도 올리기 창이 열리고 그 파일들이 골라진다.
function setupDrop() {
  // 파일을 끌어다 놓을 때 브라우저가 그 파일을 열어 버리지 않게(업로드 중이면 끊긴다) 기본 동작은 늘 막고,
  // 받을 수 있을 때만 골라 넣는다.
  const isFiles = (ev) => ev.dataTransfer?.types.includes("Files");
  const canDrop = () => currentTab() === "files" && me.driveConnected;
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
    .catch((e) => showError("노트를 저장하지 못했습니다(노트 화면에 그대로 남아 있습니다): " + e.message))
    .then(() => tabs[name].load())
    .catch(showError);
}

// Web Storage access throws when the browser blocks it for this site.
function storage(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

async function init() {
  me = await call("/api/me");
  if (!me.admin) {
    // Go straight to Google, which signs the owner in without a click — only on a browser the owner
    // signed in on before (knownDevice), so strangers just see the login screen. Only once per tab, so a
    // cancelled or failed login shows this screen instead of looping, and not after a logout.
    // If the browser blocks Web Storage the attempt can't be recorded, so auto login is skipped.
    const autoLogin = storage(() => {
      if (localStorage.getItem("noAutoLogin") || sessionStorage.getItem("autoLoginTried")) return false;
      sessionStorage.setItem("autoLoginTried", "1");
      return true;
    });
    if (me.googleEnabled && me.knownDevice && autoLogin) {
      location.replace("/auth/login");
      return;
    }
    $("login").hidden = false;
    $("google-login").hidden = !me.googleEnabled;
    if (!me.googleEnabled) $("login-msg").textContent = "구글 로그인이 아직 설정되지 않아 로그인할 수 없습니다.";
    return;
  }
  storage(() => {
    sessionStorage.removeItem("autoLoginTried");
    localStorage.removeItem("noAutoLogin");
  });
  categories = me.categories;
  taskKinds = me.taskKinds;
  taskCategories = me.taskCategories;
  $("main").hidden = false;
  const opts = (list) => list.map((v) => el("option", { value: v, textContent: v }));
  $("task-kind").append(...opts(taskKinds));
  $("task-category").append(el("option", { value: "", textContent: "분류 없음" }), ...opts(taskCategories));
  $("task-category").onchange = () => {
    if ($("task-category").value === TODAY_CATEGORY) $("task-date").value = seoulToday();
    syncTaskWhen();
  };
  $("up-category").append(...opts(categories));
  $("file-category").append(...opts(categories));
  editor = createEditor($("note-editor"), noteChanged, {
    // 사진·파일 블록: 클라우드에서 고른 파일마다 블록 하나.
    pickFile: (onFile) => openPicker({ has: () => false, attach: async (f) => onFile(f) }),
  });
  setInterval(() => refreshNote().catch(() => {}), 10_000);
  noteFiles = attachBox($("note-files"), "note");
  taskFiles = attachBox($("task-files"), "task");
  itemFiles = attachBox($("item-files"), "portfolio", "사진·파일 (첫 파일이 대표 사진)");
  pfPhoto = attachBox($("pf-photo"), "profile", "프로필 사진 (첫 사진)");
  $("pick-q").oninput = () => {
    clearTimeout(pickTimer);
    pickTimer = setTimeout(() => loadPickList().catch(showPickError), 200);
  };
  $("pick-form").onsubmit = (ev) => ev.preventDefault(); // Enter in the search box must not close it
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
  for (const c of [...taskCategories, ""]) {
    const b = el("button", { type: "button", textContent: c.replace(/ 할 일$/, "") || "분류 없음", title: c || "분류 없음" }); // 오늘 · 꾸준히 · 나중에
    b.dataset.v = c;
    $("task-filter-category").append(b);
  }
  $("filter-category").append(...categories.map((c) => el("button", { type: "button", textContent: c })));
  $("filter-category").querySelectorAll("button").forEach((b, i) => i && (b.dataset.v = categories[i - 1]));

  taskDone = seg("task-filter-done", () => loadTasks().catch(showError));
  taskKind = seg("task-filter-kind", () => loadTasks().catch(showError));
  taskCategory = seg("task-filter-category", () => loadTasks().catch(showError));
  fileCategory = seg("filter-category", () => loadList().catch(showError));

  // 취소·닫기는 submit 버튼이 아니어야 Enter가 저장·올리기로 간다.
  document.querySelectorAll("dialog [data-close]").forEach((b) => (b.onclick = () => b.closest("dialog").close()));
  $("task-form").onsubmit = async (ev) => {
    ev.preventDefault();
    const body = { kind: $("task-kind").value, category: $("task-category").value, title: $("task-title").value, note: $("task-note").value };
    // 꾸준히 할 일은 날짜·시간 없이 저장한다. 노트에서 온 할 일은 날짜를 지우면 할 일에서 빠지므로 그대로 둔다.
    if (!$("task-when").hidden) Object.assign(body, { due_date: $("task-date").value, due_time: $("task-time").value });
    else if (!editingTask?.note_id) Object.assign(body, { due_date: "", due_time: "" });
    try {
      if (editingTask) await call(`/api/tasks/${editingTask.id}`, { method: "PATCH", body });
      else editingTask = await call("/api/tasks", { method: "POST", body }); // a retry after a failed attach must not add it twice
      await taskFiles.flush(editingTask.id);
      $("task-dialog").close();
      tabs[currentTab()].load().catch(showError);
    } catch (e) {
      showError(e);
    }
  };
  $("file-form").onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      await call(`/api/files/${editingFile.id}`, { method: "PATCH", body: { title: $("file-title").value, category: $("file-category").value, tags: $("file-tags").value, note: $("file-note").value, folderId: $("file-folder").value || null } });
      $("file-dialog").close();
      await loadList();
    } catch (e) {
      showError(e);
    }
  };
  $("upload").onsubmit = (ev) => {
    ev.preventDefault();
    const files = [...$("files").files];
    if (!files.length) return $("progress").replaceChildren(el("li", { className: "error", textContent: "올릴 파일을 골라 주세요." }));
    const tooBig = files.filter((f) => f.size >= me.maxFileSize);
    if (tooBig.length) return $("progress").replaceChildren(el("li", { className: "error", textContent: "1GB 미만 파일만 올릴 수 있습니다: " + tooBig.map((f) => f.name).join(", ") }));
    queueUploads(files, { category: $("up-category").value, tags: $("up-tags").value, note: $("up-note").value, folderId: currentFolder() });
    $("files").value = "";
    showPicked();
    $("upload-dialog").close();
  };
  $("folder-form").onsubmit = async (ev) => {
    ev.preventDefault();
    const body = { name: $("folder-name").value, parentId: $("folder-parent").value || null };
    try {
      if (editingFolder) await call(`/api/folders/${editingFolder.id}`, { method: "PATCH", body });
      else await call("/api/folders", { method: "POST", body });
      $("folder-dialog").close();
      await loadList();
    } catch (e) {
      $("folder-msg").textContent = e.message;
    }
  };
  $("sel-all").onchange = (ev) => {
    for (const it of listed) ev.target.checked ? picked.add(it.key) : picked.delete(it.key);
    showTicks();
  };
  $("sel-clear").onclick = () => {
    picked.clear();
    showTicks();
  };
  $("sel-move").onclick = openMoveDialog;
  $("move-form").onsubmit = async (ev) => {
    ev.preventDefault();
    const failed = await moveItems(listed.filter((it) => picked.has(it.key)), $("move-folder").value ? Number($("move-folder").value) : null).catch((e) => [e.message]);
    if (failed.length) $("move-msg").textContent = "옮기지 못한 것: " + failed.join(" · ");
    else $("move-dialog").close();
  };
  $("event-allday").onchange = syncEventTime;
  $("event-date").onchange = () => {
    if ($("event-end-date").value < $("event-date").value) $("event-end-date").value = $("event-date").value;
  };
  $("event-form").onsubmit = async (ev) => {
    ev.preventDefault();
    const allDay = $("event-allday").checked;
    const body = {
      title: $("event-title").value,
      date: $("event-date").value,
      endDate: $("event-end-date").value || $("event-date").value,
      time: allDay ? "" : $("event-time").value,
      endTime: allDay ? "" : $("event-end-time").value,
      location: $("event-location").value,
      description: $("event-description").value,
    };
    try {
      if (editingEvent) await call(`/api/calendar/events/${encodeURIComponent(editingEvent.id)}?calendar=${encodeURIComponent(editingEvent.calendarId)}`, { method: "PATCH", body });
      else await call("/api/calendar/events", { method: "POST", body: { ...body, calendarId: $("event-calendar").value } });
      $("event-dialog").close();
      loadCalendar().catch(showError);
    } catch (e) {
      $("event-msg").textContent = e.message;
    }
  };
  $("event-delete").onclick = async () => {
    if (!editingEvent || !confirm(`"${editingEvent.title}" 일정을 구글 캘린더에서 지울까요?`)) return;
    try {
      await call(`/api/calendar/events/${encodeURIComponent(editingEvent.id)}?calendar=${encodeURIComponent(editingEvent.calendarId)}`, { method: "DELETE" });
      $("event-dialog").close();
      loadCalendar().catch(showError);
    } catch (e) {
      $("event-msg").textContent = e.message;
    }
  };
  $("class-kind").onchange = syncClassKind;
  $("class-form").onsubmit = async (ev) => {
    ev.preventDefault();
    const body = { course: $("class-course").value, kind: $("class-kind").value, date: $("class-date").value, start: $("class-start").value, end: $("class-end").value, place: $("class-place").value, from_date: $("class-kind").value === "변경" ? $("class-from").value : "", note: $("class-note").value };
    try {
      if (editingClass) await call(`/api/class-changes/${editingClass.id}`, { method: "PATCH", body });
      else await call("/api/class-changes", { method: "POST", body });
      $("class-dialog").close();
      tabs[currentTab()].load().catch(showError);
    } catch (e) {
      $("class-msg").textContent = e.message;
    }
  };
  $("expense-kind").onchange = syncExpenseKind;
  $("expense-form").onsubmit = async (ev) => {
    ev.preventDefault();
    const amount = Number($("expense-amount").value.replace(/[,\s원]/g, ""));
    if (!Number.isSafeInteger(amount) || amount < 0) return ($("expense-msg").textContent = "금액은 숫자로 적어 주세요(예: 55000)");
    const kind = $("expense-kind").value, day = $("expense-day").value;
    const body = { kind, title: $("expense-title").value, amount, day: kind === "정기" && day ? Number(day) : null, date: kind === "예정" ? $("expense-date").value : "", note: $("expense-note").value };
    try {
      if (editingExpense) await call(`/api/expenses/${editingExpense.id}`, { method: "PATCH", body });
      else await call("/api/expenses", { method: "POST", body });
      $("expense-dialog").close();
      tabs[currentTab()].load().catch(showError);
    } catch (e) {
      $("expense-msg").textContent = e.message;
    }
  };
  $("exam-form").onsubmit = async (ev) => {
    ev.preventDefault();
    const body = Object.fromEntries(EXAM_KEYS.map((k) => [k, $(`exam-${k}`).value]));
    body.color = document.querySelector("#exam-colors input:checked")?.value ?? "";
    try {
      if (editingExam) await call(`/api/exams/${editingExam.id}`, { method: "PATCH", body });
      else await call("/api/exams", { method: "POST", body });
      $("exam-dialog").close();
      tabs[currentTab()].load().catch(showError);
    } catch (e) {
      $("exam-msg").textContent = e.message;
    }
  };
  $("study-form").onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      await call(`/api/studies/${editingStudy.id}`, { method: "PATCH", body: { date: $("study-edit-date").value, course: $("study-edit-course").value, title: $("study-edit-title").value } });
      $("study-dialog").close();
      await loadStudies();
    } catch (e) {
      $("study-msg").textContent = e.message;
    }
  };
  $("profile-form").onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      await call("/api/portfolio/profile", { method: "PUT", body: { name: $("pf-name").value, headline: $("pf-headline").value, about: $("pf-about").value } });
      $("pf-saved").textContent = "저장했습니다";
    } catch (e) {
      $("pf-saved").textContent = e.message;
    }
  };
  $("item-form").onsubmit = async (ev) => {
    ev.preventDefault();
    const body = {
      section_id: Number($("item-section").value),
      public: $("item-public").value === "1",
      title: $("item-title").value,
      period: $("item-period").value,
      link: $("item-link").value,
      summary: $("item-summary").value,
      body: $("item-body").value,
      note_id: $("item-note").value ? Number($("item-note").value) : null,
    };
    try {
      if (editingItem) await call(`/api/portfolio/items/${editingItem.id}`, { method: "PATCH", body });
      else editingItem = await call("/api/portfolio/items", { method: "POST", body }); // a retry after a failed attach must not add it twice
      await itemFiles.flush(editingItem.id);
      $("item-dialog").close();
      await refreshSections();
    } catch (e) {
      $("item-msg").textContent = e.message;
    }
  };
  $("files").onchange = showPicked;
  setupDrop();
  $("search").onsubmit = (ev) => {
    ev.preventDefault();
    loadList().catch(showError);
  };

  // 사이드바 검색: 칸 아래에 전체 검색 결과를 띄우고, 지금 화면도 전처럼 거른다(파일함에서는 파일 검색).
  let searchTimer;
  $("global-search").oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      showSearch().catch(showError);
      if (currentTab() === "files") {
        $("q").value = $("global-search").value;
        loadList().catch(showError);
      } else if (currentTab() === "notes") loadNoteList().catch(showError);
      else tabs[currentTab()].load().catch(showError);
    }, 200);
  };
  $("global-search").onkeydown = (ev) => {
    const open = !$("search-results").hidden;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      if (open) markSearch(searchOn + (ev.key === "ArrowDown" ? 1 : -1));
      else showSearch().catch(showError);
    } else if (ev.key === "Enter" && open && !ev.isComposing) (ev.preventDefault(), pickSearch(searchOn));
    else if (ev.key === "Escape") (ev.preventDefault(), open ? closeSearch() : $("global-search").blur());
  };
  $("global-search").onfocus = () => showSearch().catch(showError);
  $("global-search").onblur = closeSearch;
  document.addEventListener("keydown", (ev) => {
    if (ev.target.closest?.("input, textarea, select, dialog") || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.key === "/") (ev.preventDefault(), $("global-search").focus());
    else if (ev.key.toLowerCase() === "n" && currentTab() === "notes") (ev.preventDefault(), newNote().catch(showError));
    else if (ev.key.toLowerCase() === "n" && currentTab() === "portfolio") (ev.preventDefault(), openItemDialog());
    else if (ev.key.toLowerCase() === "n" && currentTab() === "exams") (ev.preventDefault(), openExamDialog());
    else if (ev.key.toLowerCase() === "n" && currentTab() === "expenses") (ev.preventDefault(), openExpenseDialog());
    else if (ev.key.toLowerCase() === "n" && currentTab() === "classes") (ev.preventDefault(), openClassDialog());
    else if (ev.key.toLowerCase() === "n" && currentTab() === "timetable") (ev.preventDefault(), timetable?.then((t) => t.openCourse()));
    else if (ev.key.toLowerCase() === "n" && currentTab() === "studies") (ev.preventDefault(), document.querySelector("#study-list .study-add input:not(.course)")?.focus());
    else if (ev.key.toLowerCase() === "n" && currentTab() === "calendar") (ev.preventDefault(), calWrite && openEventDialog());
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
  $("notify-btn").onclick = () => openNotify().catch(showError);
  $("backup-btn").onclick = () => openBackup().catch((e) => ($("backup-msg").textContent = e.message));
  $("backup-now").onclick = async () => {
    $("backup-msg").textContent = "";
    $("backup-now").disabled = true;
    $("backup-now").textContent = "백업하는 중…";
    try {
      showBackup(await call("/api/backup", { method: "POST" }));
    } catch (e) {
      $("backup-msg").textContent = e.message;
      await call("/api/backup").then(showBackup, () => ($("backup-now").disabled = false));
    } finally {
      $("backup-now").textContent = "지금 백업";
    }
  };
  $("notify-toggle").onclick = async () => {
    $("notify-msg").textContent = "";
    $("notify-toggle").disabled = true;
    try {
      if ((await notifyStateText()).startsWith("켜짐")) await notifyOff();
      else await notifyOn();
    } catch (e) {
      $("notify-msg").textContent = e.message;
    } finally {
      $("notify-toggle").disabled = false;
      await showNotifyState();
    }
  };
  const saveNotify = () =>
    call("/api/notify", { method: "PUT", body: { morning: $("notify-morning-on").checked ? $("notify-morning").value : "", homework: $("notify-homework").checked, exam: $("notify-exam").checked, classes: $("notify-classes").checked } }).catch(
      (e) => ($("notify-msg").textContent = e.message),
    );
  for (const id of ["notify-morning-on", "notify-morning", "notify-homework", "notify-exam", "notify-classes"]) $(id).onchange = saveNotify;
  // 이 기기가 꺼져 있으면 서버가 이 기기로 보낼 곳이 없다: 보내는 대신 먼저 켜라고 알려 준다.
  $("notify-test").onclick = async () => {
    if (!(await notifyStateText()).startsWith("켜짐")) return void ($("notify-msg").textContent = "이 기기는 아직 알림이 꺼져 있어서 테스트 알림을 받을 수 없습니다. 먼저 위의 '이 기기에서 알림 받기'를 누르고, 묻는 창이 뜨면 '허용'을 눌러 주세요.");
    call("/api/notify/test", { method: "POST" }).then(
      () => ($("notify-msg").textContent = "보냈습니다. 1분 안에 알림이 뜨지 않으면 휴대폰 설정에서 kacarong 알림이 켜져 있는지 확인해 주세요."),
      (e) => ($("notify-msg").textContent = e.message),
    );
  };
  // 이 기기가 알림을 켜 둔 상태면 이어서 받는다: 화면이 직접 띄우는 방식은 다시 묻기 시작하고,
  // 웹 푸시는 구독을 서버에 다시 알려 둔다(서버가 지웠어도 되살아나게). /admin 구독이 없으면(예전 / 구독뿐이거나
  // 브라우저가 지움) 다시 켠다: 이미 허용돼 있어 묻지 않고, 예전 구독은 notifyOn 이 치운다.
  if (notifyMode() === "page") startNotifyPoll();
  else if (notifyMode() === "push" && pushSupported() && Notification.permission === "granted") {
    pushSubscription()
      .then((sub) => (sub ? call("/api/push/subscribe", { method: "POST", body: sub.toJSON() }) : notifyOn()))
      .catch(() => {});
  }
  $("notion-form").onsubmit = async (ev) => {
    ev.preventDefault();
    if ($("notion-connect").hidden) return void ($("notion-connect").hidden = false); // "토큰 바꾸기": show the field first
    try {
      await call("/api/notion", { method: "PUT", body: { token: $("notion-token").value.trim() } });
      $("notion-token").value = "";
      await watchNotion(true);
    } catch (e) {
      $("notion-state").textContent = e.message;
    }
  };
  $("notion-sync").onclick = () => call("/api/notion/sync", { method: "POST" }).then(() => watchNotion(true)).catch((e) => ($("notion-state").textContent = e.message));
  $("notion-off").onclick = () => {
    if (!confirm("노션 연결을 끊을까요? 노트는 그대로 남고, 다시 연결하면 이어서 맞춥니다.")) return;
    call("/api/notion", { method: "DELETE" }).then(() => watchNotion()).catch(showError);
  };
  $("notion-root").onchange = () => call("/api/notion/root", { method: "PUT", body: { pageId: $("notion-root").value || null } }).catch(showError);
  $("logout").onclick = () => {
    storage(() => localStorage.setItem("noAutoLogin", "1")); // otherwise the reload would sign straight back in
    call("/auth/logout", { method: "POST" }).then(() => location.reload());
  };

  window.onhashchange = showTab;
  showTab();
  // 화면을 열어 둔 채 0시가 지나면 날짜가 걸린 화면을 다시 불러온다: 그날 공부가 할 일·과제의 오늘 할 일에 들어가고
  // (서버가 이 조회 때 넣는다) "오늘"·"지난 일"도 새 날짜로 바뀐다.
  // 불러오기에 실패하면(절전에서 막 깨어나 연결이 아직 없을 때 등) 날짜를 그대로 두어 다음 주기에 다시 한다.
  let shownDay = seoulToday();
  let dayLoading = false;
  setInterval(async () => {
    const day = seoulToday();
    if (day === shownDay || dayLoading) return;
    if (!["today", "tasks", "studies", "calendar"].includes(currentTab())) return void (shownDay = day); // 탭을 옮기면 showTab이 불러온다
    dayLoading = true;
    try {
      await tabs[currentTab()].load();
      shownDay = day;
    } catch (err) {
      showError(err);
    } finally {
      dayLoading = false;
    }
  }, 30_000);
}

init().catch(showError);

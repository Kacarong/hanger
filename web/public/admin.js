// 작업공간(관리) 화면.
const CHUNK = 16 * 1024 * 1024; // must be a multiple of 256 KiB for Drive resumable uploads
// 같은 ?v= 로 불러야 배포 직후 캐시의 옛 편집기와 섞이지 않는다.
const { createEditor, merge3 } = await import("./notes.js" + new URL(import.meta.url).search);
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
  clip: '<path d="m20 11-8.5 8.5a5 5 0 0 1-7-7L13 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L14 7"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
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

// Uploads one file into the 파일함 (meta.folderId, or the top) with its progress line in `list`.
// Returns the new file row, or null on failure.
async function uploadOne(file, list, meta) {
  const name = el("span", { textContent: `${file.name} · 준비 중` });
  const fill = el("div", { className: "bar-fill" });
  const li = el("li", {}, name, el("div", { className: "bar-track" }, fill));
  list.append(li);
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
      : [el("li", { className: "muted", textContent: q ? "검색 결과가 없습니다." : "파일함이 비어 있습니다. \"새로 올리기\"로 올려 보세요." })]),
  );
}

// 클라우드(파일함): 이 사이트의 폴더와 파일. 파일은 구글 드라이브에 같은 폴더 구조로 보관된다.
let fileCategory = () => "";
let editingFile = null;
let editingFolder = null;
let folders = [];
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
  const del = (path, text) => confirm(text) && call(path, { method: "DELETE" }).then(loadList, showError);
  const folderRows = (q || fileCategory() ? [] : folders.filter((f) => f.parent_id === cur)).map((f) =>
    el(
      "tr",
      { className: "folder-row" },
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
    ),
  );
  const fileRows = files.map((f) =>
    el(
      "tr",
      {},
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
    ),
  );
  const rows = [...folderRows, ...fileRows];
  $("list").replaceChildren(...(rows.length ? rows : [emptyRow(7, q || fileCategory() ? "검색 결과가 없습니다." : cur === null ? "아직 올린 파일이 없습니다." : "빈 폴더입니다.")]));
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
    pf.sections.length ? "" : el("p", { className: "notice", textContent: "섹션이 없습니다. 오른쪽 위 \"섹션 추가\"로 만들어 보세요." }),
  );
}

function newSection() {
  const title = prompt("새 섹션 이름 (예: 업적, 작품, 취미)");
  if (title?.trim()) call("/api/portfolio/sections", { method: "POST", body: { title } }).then(() => refreshSections(), showError).catch(showError);
}

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
  taskFiles.show(t?.id ?? null, () => ($("task-kind").value === "과제" ? "과제" : "기타"));
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
    n.notion.readOnly ? el("span", { className: "error", textContent: "너무 길거나 깊은 페이지라 여기서는 읽기만 합니다. 노션에서 고쳐 주세요." }) : null,
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
    const fold = el("button", { type: "button", className: "note-fold", ariaLabel: "하위 노트 펼치기·접기", textContent: "▸" });
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
    j.partial?.length && `너무 길거나 깊어서 여기서는 읽기만 하는 페이지: ${j.partial.join(", ")}`,
    j.fileProblems && `노션에서 가져오지 못한 파일 ${j.fileProblems}개 (30분마다 다시 시도합니다)`,
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

const tabs = {
  today: { title: "오늘", load: () => loadToday(), actions: () => [newTaskBtn()] },
  tasks: { title: "할 일·과제", load: () => loadTasks(), actions: () => [newTaskBtn()] },
  calendar: { title: "캘린더", load: () => loadCalendar(), actions: () => [newTaskBtn()] },
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

function openUpload() {
  $("progress").replaceChildren();
  $("upload-where").textContent = `${pathText(currentFolder())}에 · 파일당 1GB 미만`;
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
    // Go straight to Google, which signs the owner in without a click. Only once per tab, so a
    // cancelled or failed login shows this screen instead of looping, and not after a logout.
    // If the browser blocks Web Storage the attempt can't be recorded, so auto login is skipped.
    const autoLogin = storage(() => {
      if (localStorage.getItem("noAutoLogin") || sessionStorage.getItem("autoLoginTried")) return false;
      sessionStorage.setItem("autoLoginTried", "1");
      return true;
    });
    if (me.googleEnabled && autoLogin) {
      location.replace("/auth/login");
      return;
    }
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
  storage(() => {
    sessionStorage.removeItem("autoLoginTried");
    localStorage.removeItem("noAutoLogin");
  });
  categories = me.categories;
  taskKinds = me.taskKinds;
  $("main").hidden = false;
  const opts = (list) => list.map((v) => el("option", { value: v, textContent: v }));
  $("task-kind").append(...opts(taskKinds));
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
  $("upload").onsubmit = async (ev) => {
    ev.preventDefault();
    const files = [...$("files").files];
    if (!files.length) return $("progress").replaceChildren(el("li", { className: "error", textContent: "올릴 파일을 골라 주세요." }));
    const tooBig = files.filter((f) => f.size >= me.maxFileSize);
    if (tooBig.length) return $("progress").replaceChildren(el("li", { className: "error", textContent: "1GB 미만 파일만 올릴 수 있습니다: " + tooBig.map((f) => f.name).join(", ") }));
    $("upload-btn").disabled = true;
    $("progress").replaceChildren();
    let ok = true;
    const meta = { category: $("up-category").value, tags: $("up-tags").value, note: $("up-note").value, folderId: currentFolder() };
    for (const f of files) ok = !!(await uploadOne(f, $("progress"), meta)) && ok; // one at a time to keep bandwidth predictable
    $("upload-btn").disabled = false;
    $("files").value = "";
    showPicked();
    if (ok) $("upload-dialog").close(); // 실패가 있으면 이유를 볼 수 있게 창을 남긴다.
    loadList().catch(showError);
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
    else if (ev.key.toLowerCase() === "n" && currentTab() === "portfolio") (ev.preventDefault(), openItemDialog());
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
}

init().catch(showError);

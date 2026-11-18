// 관리 화면. 디자인 없이 기능만 둔다.
const CHUNK = 16 * 1024 * 1024; // must be a multiple of 256 KiB for Drive resumable uploads
const $ = (id) => document.getElementById(id);
let categories = [];

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
// otherwise the next offset to send.
async function putRange(url, file, start, end) {
  const headers = end > start ? { "Content-Range": `bytes ${start}-${end - 1}/${file.size}` } : { "Content-Range": `bytes */${file.size}` };
  const res = await fetch(url, { method: "PUT", headers, body: end > start ? file.slice(start, end) : undefined });
  if (res.status === 200 || res.status === 201) return { file: await res.json() };
  if (res.status === 308) {
    const range = res.headers.get("Range"); // "bytes=0-1234"; may be hidden by CORS
    if (range) return { next: Number(range.split("-")[1]) + 1 };
    return { next: end > start ? end : 0 };
  }
  throw new Error(`구글 업로드 오류 (${res.status})`);
}

async function uploadToDrive(url, file, onProgress) {
  let offset = 0;
  let failures = 0;
  for (;;) {
    try {
      const r = await putRange(url, file, offset, Math.min(offset + CHUNK, file.size));
      if (r.file) return r.file;
      offset = r.next;
      failures = 0;
      onProgress(offset / file.size);
    } catch (e) {
      if (++failures > 5) throw e;
      await new Promise((ok) => setTimeout(ok, 1000 * 2 ** failures));
      try {
        // Ask Google how much it already has, then resume from there.
        const s = await putRange(url, file, 0, 0);
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

async function init() {
  const me = await call("/api/me");
  if (!me.admin) {
    $("login").hidden = false;
    return;
  }
  categories = me.categories;
  $("main").hidden = false;
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

  loadQuota();
  await loadList();
}

init().catch(showError);

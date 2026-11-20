// 노트 블록 편집기. 글은 블록마다 textarea 하나에 쓴다(한글 입력이 안정적이다).
// 꾸밈(굵게·색·링크…)은 textarea 뒤에 같은 글자 크기로 그린 층에 보이고, textarea 글자는 투명하다.
// 블록 모양은 서버(src/blocks.ts)와 같다: { id, type, text, rich?, d?, color?, ... }. d = 들여쓰기 깊이(노션의 하위 블록).

export const TYPES = [
  { type: "p", label: "텍스트", keys: "text 텍스트 본문 글" },
  { type: "h1", label: "제목 1", keys: "h1 heading 제목1 큰제목" },
  { type: "h2", label: "제목 2", keys: "h2 heading 제목2 중간제목" },
  { type: "h3", label: "제목 3", keys: "h3 heading 제목3 작은제목" },
  { type: "todo", label: "할 일 체크박스", keys: "todo check 할일 체크박스" },
  { type: "bullet", label: "글머리 목록", keys: "bullet list 글머리 목록" },
  { type: "number", label: "번호 목록", keys: "number list 번호 목록" },
  { type: "toggle", label: "토글 목록", keys: "toggle 토글 접기" },
  { type: "quote", label: "인용", keys: "quote 인용" },
  { type: "callout", label: "콜아웃", keys: "callout 콜아웃 강조 박스" },
  { type: "code", label: "코드", keys: "code 코드" },
  { type: "equation", label: "수식", keys: "equation math 수식 latex" },
  { type: "divider", label: "구분선", keys: "divider hr 구분선" },
];
const EXTRA = [
  { action: "media", label: "사진·파일 (클라우드)", keys: "image file photo 사진 이미지 파일 동영상 영상 pdf" },
  { action: "bookmark", label: "북마크 (링크)", keys: "bookmark link url 북마크 링크" },
  { action: "table", label: "표", keys: "table 표" },
];
const TEXT_TYPES = ["p", "h1", "h2", "h3", "todo", "bullet", "number", "quote", "toggle", "callout", "code"];
const RICH_TYPES = TEXT_TYPES.filter((t) => t !== "code");
const LIST_TYPES = ["todo", "bullet", "number", "toggle"]; // Enter continues these
const PLACEHOLDER = { p: "", h1: "제목 1", h2: "제목 2", h3: "제목 3", todo: "할 일", bullet: "목록", number: "목록", quote: "인용", code: "코드", toggle: "토글", callout: "콜아웃", equation: "수식 (LaTeX)" };
export const COLORS = [
  ["default", "기본"], ["gray", "회색"], ["brown", "갈색"], ["orange", "주황"], ["yellow", "노랑"],
  ["green", "초록"], ["blue", "파랑"], ["purple", "보라"], ["pink", "분홍"], ["red", "빨강"],
];
const OPAQUE_NAMES = { button: "버튼", table_of_contents: "목차", breadcrumb: "이동 경로", template: "템플릿 버튼", link_preview: "링크 미리보기", ai_block: "AI 블록", transcription: "회의록", meeting_notes: "회의록", unsupported: "노션 전용 블록" };

// 줄 맨 앞에 쓰면 블록 종류가 바뀌는 표시 (마크다운처럼).
const SHORTCUTS = [
  [/^### /, "h3"], [/^## /, "h2"], [/^# /, "h1"], [/^[-*] /, "bullet"], [/^1[.)] /, "number"],
  [/^\[ ?\] /, "todo"], [/^\[x\] /i, "todo", true], [/^> /, "toggle"], [/^" /, "quote"],
];

const newId = () => crypto.randomUUID().slice(0, 8);
export const emptyBlock = (type = "p", d = 0) => {
  const b = { id: newId(), type, text: "" };
  if (type === "todo") b.checked = false;
  if (type === "code") b.lang = "plain text";
  if (type === "callout") b.icon = "💡";
  if (d) b.d = d;
  return b;
};

function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return e;
}

// ---- 꾸민 글(runs): [{ t, b?, i?, s?, u?, c?, color?, href?, m?, eq? }]

const MARKS = ["b", "i", "s", "u", "c", "eq"];
const isPlainRun = (r) => MARKS.every((k) => !r[k]) && !r.color && !r.href && !r.m;
const sameMarks = (a, b) => MARKS.every((k) => !!a[k] === !!b[k]) && (a.color ?? "") === (b.color ?? "") && (a.href ?? "") === (b.href ?? "") && !a.m && !b.m && !a.eq && !b.eq;
export function normalize(runs) {
  const out = [];
  for (const r of runs) {
    if (!r.t) continue;
    const last = out.at(-1);
    if (last && sameMarks(last, r)) last.t += r.t;
    else out.push({ ...r });
  }
  return out;
}
const runsOf = (text, rich) => rich ?? (text ? [{ t: text }] : []);
const plainOf = (runs) => runs.map((r) => r.t).join("");
// 꾸밈이 하나도 없으면 rich를 빼서 저장 모양을 서버와 같게 한다.
function store(obj, runs, key = "rich", textKey = "text") {
  const n = normalize(runs);
  obj[textKey] = plainOf(n);
  if (n.some((r) => !isPlainRun(r))) obj[key] = n;
  else delete obj[key];
}
function sliceRuns(runs, a, z) {
  const out = [];
  let pos = 0;
  for (const r of runs) {
    const s = Math.max(a, pos);
    const e = Math.min(z, pos + r.t.length);
    if (s < e) {
      const piece = { ...r, t: r.t.slice(s - pos, e - pos) };
      if ((r.m || r.eq) && piece.t !== r.t) delete piece.m, delete piece.eq; // 멘션·수식을 자르면 보통 글이 된다
      out.push(piece);
    }
    pos += r.t.length;
  }
  return out;
}
const marksAt = (runs, i) => {
  let pos = 0;
  for (const r of runs) {
    if (i < pos + r.t.length) return r;
    pos += r.t.length;
  }
  return null;
};
// 글이 바뀌면 바뀌지 않은 앞뒤의 꾸밈은 그대로 두고, 새로 친 글은 바로 앞 글자의 꾸밈을 따른다.
export function mergeEdit(runs, oldText, text) {
  let p = 0;
  while (p < oldText.length && p < text.length && oldText[p] === text[p]) p++;
  let s = 0;
  while (s < oldText.length - p && s < text.length - p && oldText[oldText.length - 1 - s] === text[text.length - 1 - s]) s++;
  const inserted = text.slice(p, text.length - s);
  const before = p > 0 ? marksAt(runs, p - 1) : null;
  const after = marksAt(runs, oldText.length - s);
  const like = before ?? after;
  const ins = { t: inserted };
  if (like) {
    for (const k of ["b", "i", "s", "u", "c"]) if (like[k]) ins[k] = 1;
    if (like.color) ins.color = like.color;
    if (before?.href && after?.href === before.href) ins.href = before.href; // 링크 한가운데에 친 글만 링크가 된다
  }
  return normalize([...sliceRuns(runs, 0, p), ins, ...sliceRuns(runs, oldText.length - s, oldText.length)]);
}
// 고른 범위에 꾸밈을 켜거나 끈다(모두 켜져 있으면 끈다). value: color/href 값, 또는 null로 지우기.
function applyMark(runs, a, z, key, value) {
  const mid = sliceRuns(runs, a, z);
  const on = value === undefined ? !mid.every((r) => r[key]) : value;
  for (const r of mid) {
    if (on) r[key] = value === undefined ? 1 : value;
    else delete r[key];
  }
  const total = plainOf(runs).length;
  return normalize([...sliceRuns(runs, 0, a), ...mid, ...sliceRuns(runs, z, total)]);
}

// 꾸민 글을 HTML로 그린다(그리기 층·표 칸).
function paintRuns(box, runs, links = {}) {
  box.replaceChildren(
    ...runs.map((r) => {
      const cls = [r.b && "r-b", r.i && "r-i", r.s && "r-s", r.u && "r-u", r.c && "r-c", r.color && `c-${r.color}`, r.href && "r-a", r.m && "r-m", r.eq && "r-eq"].filter(Boolean).join(" ");
      return cls ? el("span", { className: cls, textContent: r.t }) : document.createTextNode(r.t);
    }),
    "​", // 끝의 줄바꿈도 높이를 차지하게
  );
}
const linkOf = (r, links) => r.href || (r.m?.page && links[r.m.page.id] ? `#notes/${links[r.m.page.id].id}` : r.m?.page ? notionUrl(r.m.page.id) : r.m?.link_preview?.url ?? null);
const notionUrl = (id) => `https://www.notion.so/${String(id).replace(/-/g, "")}`;

// ---- 깊이: 블록의 부모는 바로 위쪽에서 깊이가 하나 작은 블록이다.

function canHold(parent, child) {
  if (!parent) return child.type !== "column";
  if (parent.type === "columns") return child.type === "column";
  if (child.type === "column") return false;
  if (["h1", "h2", "h3"].includes(parent.type)) return !!parent.toggle;
  return ["p", "todo", "bullet", "number", "quote", "toggle", "callout", "column"].includes(parent.type) || (parent.type === "synced" && !parent.page);
}
function fixDepths(blocks) {
  const stack = [];
  for (const b of blocks) {
    let d = Math.min(b.d ?? 0, stack.length);
    while (d > 0 && !canHold(stack[d - 1], b)) d--;
    stack.length = d;
    stack.push(b);
    if (d) b.d = d;
    else delete b.d;
  }
}
const depth = (b) => b.d ?? 0;
const foldable = (b) => b.type === "toggle" || (["h1", "h2", "h3"].includes(b.type) && b.toggle);

// Turns pasted lines into blocks, reading the same shortcuts.
function linesToBlocks(lines, d) {
  return lines.map((line) => {
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) return emptyBlock("divider", d);
    for (const [re, type, checked] of SHORTCUTS) {
      if (re.test(line)) return { ...emptyBlock(type, d), text: line.replace(re, ""), ...(type === "todo" ? { checked: !!checked } : {}) };
    }
    return { ...emptyBlock("p", d), text: line };
  });
}

// ---- 노트 병합: 다른 곳(노션, 다른 탭)에서 바뀐 노트와 이 화면에서 고친 것을 블록마다 합친다.
// 키 순서와 상관없이 같은 내용이면 같은 문자열.
const stableJson = (v) =>
  Array.isArray(v) ? `[${v.map(stableJson).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(",")}}`
  : JSON.stringify(v) ?? "null";
const blockKey = (b) => stableJson({ ...b, id: undefined });
export function merge3(base, local, remote) {
  const B = new Map(base.map((b) => [b.id, b]));
  const L = new Map(local.map((b) => [b.id, b]));
  const pick = new Map();
  for (const l of local) {
    const b = B.get(l.id);
    const r = remote.find((x) => x.id === l.id);
    if (!b) pick.set(l.id, l);
    else if (!r) {
      if (blockKey(l) !== blockKey(b)) pick.set(l.id, l);
    } else pick.set(l.id, blockKey(l) === blockKey(b) ? r : l);
  }
  for (const r of remote) if (!L.has(r.id) && !B.has(r.id)) pick.set(r.id, r);
  const order = (list) => list.map((b) => b.id).filter((id) => B.has(id));
  const pos = new Map(order(base).map((id, i) => [id, i]));
  const kept = order(local).every((id, i, a) => i === 0 || pos.get(a[i - 1]) < pos.get(id));
  const [first, second] = kept ? [remote, local] : [local, remote];
  const out = first.filter((b) => pick.has(b.id)).map((b) => pick.get(b.id));
  const placed = new Set(out.map((b) => b.id));
  let after = null;
  for (const b of second) {
    if (pick.has(b.id) && !placed.has(b.id)) {
      out.splice(after === null ? 0 : out.findIndex((x) => x.id === after) + 1, 0, pick.get(b.id));
      placed.add(b.id);
    }
    if (placed.has(b.id)) after = b.id;
  }
  fixDepths(out);
  return out;
}

// opts: { pickFile(onFile), openNote(id) }
const FOLD_ICON = '<svg viewBox="0 0 24 24"><path d="m9 5 7 7-7 7"/></svg>';

export function createEditor(root, onChange, opts = {}) {
  let blocks = [emptyBlock()];
  let links = {}; // 노션 페이지 id → { id: 노트 id, title }
  let readOnly = false;
  let menu = null; // { box, items, index, block, mode: "slash" | "handle" }
  let bar = null; // 꾸밈 도구 막대
  let dragId = null;
  const open = new Set(); // 펼친 토글

  const idx = (id) => blocks.findIndex((b) => b.id === id);
  const textOf = (id) => root.querySelector(`[data-id="${id}"] .blk-text`);
  const changed = () => onChange();
  const subtreeEnd = (i) => {
    let j = i + 1;
    while (j < blocks.length && depth(blocks[j]) > depth(blocks[i])) j++;
    return j;
  };
  const hasKids = (i) => subtreeEnd(i) > i + 1;

  function focus(id, pos = "end", posEnd) {
    const ta = textOf(id);
    if (!ta) return root.querySelector(`[data-id="${id}"] .blk-solid`)?.focus();
    ta.focus();
    const p = pos === "end" ? ta.value.length : Math.min(pos, ta.value.length);
    ta.setSelectionRange(p, posEnd === undefined ? p : Math.min(posEnd, ta.value.length));
  }

  const autosize = (ta) => {
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  };

  // 접힌 토글 안의 블록은 그리지 않는다.
  function visible() {
    const out = [];
    let hideBelow = Infinity;
    for (const b of blocks) {
      if (depth(b) > hideBelow) continue;
      hideBelow = Infinity;
      out.push(b);
      if (foldable(b) && !open.has(b.id)) hideBelow = depth(b);
    }
    return out;
  }

  function render(focusId, pos) {
    closeMenu();
    closeBar();
    const nums = []; // 깊이마다 번호 목록 번호
    const rows = [];
    for (const b of visible()) {
      const d = depth(b);
      nums.length = d + 1;
      nums[d] = b.type === "number" ? (nums[d] ?? 0) + 1 : 0;
      rows.push(blockEl(b, nums[d]));
    }
    root.replaceChildren(...rows);
    root.querySelectorAll(".blk-text").forEach(autosize);
    if (focusId) focus(focusId, pos);
  }

  // 지금 커서가 있는 곳을 기억했다가 다시 그린 뒤 되돌린다(노션에서 바뀐 내용을 받을 때).
  function snapshotFocus() {
    const a = document.activeElement;
    const row = a?.closest?.("[data-id]");
    if (!row || !root.contains(row)) return null;
    return { id: row.dataset.id, cell: a.dataset.cell ?? null, field: a.dataset.field ?? null, start: a.selectionStart, end: a.selectionEnd };
  }
  function restoreFocus(f) {
    if (!f) return;
    const row = root.querySelector(`[data-id="${f.id}"]`);
    const t = row && (f.cell ? row.querySelector(`[data-cell="${f.cell}"]`) : f.field ? row.querySelector(`[data-field="${f.field}"]`) : row.querySelector(".blk-text") ?? row.querySelector(".blk-solid"));
    if (!t) return;
    t.focus();
    if (typeof f.start === "number" && t.setSelectionRange) t.setSelectionRange(Math.min(f.start, t.value.length), Math.min(f.end, t.value.length));
  }

  // 꾸밀 수 있는 글 칸: 그리기 층 + 투명한 textarea.
  // sync: called after every change of obj (typing or formatting).
  function richField(obj, { textKey = "text", richKey = "rich", placeholder = "", field = null, cls = "", onText, onKey, sync } = {}) {
    const wrap = el("div", { className: `blk-field ${cls}` });
    const back = el("div", { className: "blk-rich", ariaHidden: "true" });
    const ta = el("textarea", { className: "blk-text", rows: 1, value: obj[textKey] ?? "", placeholder, readOnly, spellcheck: true });
    if (field) ta.dataset.field = field;
    const paint = () => {
      const has = !!obj[richKey];
      ta.classList.toggle("rich", has);
      if (has) paintRuns(back, obj[richKey], links);
      else back.replaceChildren();
    };
    const update = () => (paint(), sync?.());
    paint();
    ta.oninput = () => {
      const old = obj[textKey] ?? "";
      if (obj[richKey]) store(obj, mergeEdit(obj[richKey], old, ta.value), richKey, textKey);
      else obj[textKey] = ta.value;
      update();
      autosize(ta);
      onText?.(ta);
      if (!onText) changed();
    };
    ta.onkeydown = (ev) => {
      if (fmtKey(ev, obj, ta, textKey, richKey, update)) return;
      onKey?.(ev, ta);
    };
    ta.onclick = (ev) => {
      // Ctrl/Cmd + 클릭으로 링크·멘션을 연다.
      if (!(ev.ctrlKey || ev.metaKey) || !obj[richKey]) return;
      const r = marksAt(obj[richKey], ta.selectionStart);
      const href = r && linkOf(r, links);
      if (href) href.startsWith("#") ? (location.hash = href) : window.open(href, "_blank", "noopener");
    };
    ta.onselect = ta.onmouseup = ta.onkeyup = () => setTimeout(() => showBar(obj, ta, textKey, richKey, update), 0);
    ta.onblur = () => setTimeout(() => {
      if (!bar?.box.matches(":hover") && document.activeElement !== ta) closeBar();
      if (menu?.mode === "slash" && menu.block === obj && document.activeElement !== ta) closeMenu();
    }, 150);
    wrap.append(back, ta);
    return wrap;
  }

  // 단축키: Ctrl/Cmd+B 굵게, I 기울임, U 밑줄, Shift+S 취소선, E 코드, K 링크.
  function fmtKey(ev, obj, ta, textKey, richKey, paint) {
    if (!(ev.ctrlKey || ev.metaKey) || ev.altKey || readOnly) return false;
    const k = ev.key.toLowerCase();
    const key = k === "b" ? "b" : k === "i" ? "i" : k === "u" ? "u" : k === "e" ? "c" : k === "s" && ev.shiftKey ? "s" : k === "k" ? "href" : null;
    if (!key || ta.selectionStart === ta.selectionEnd) return false;
    ev.preventDefault();
    format(obj, ta, textKey, richKey, paint, key);
    return true;
  }
  function format(obj, ta, textKey, richKey, paint, key, value) {
    const [a, z] = [ta.selectionStart, ta.selectionEnd];
    if (a === z) return;
    let runs = runsOf(obj[textKey], obj[richKey]);
    if (key === "href") {
      const cur = marksAt(runs, a)?.href ?? "";
      const url = prompt("링크 주소 (비우면 링크 빼기)", cur || "https://");
      if (url === null) return;
      const ok = /^(https?:|mailto:)/i.test(url.trim());
      runs = applyMark(runs, a, z, "href", ok ? url.trim() : null);
    } else runs = applyMark(runs, a, z, key, value);
    store(obj, runs, richKey, textKey);
    paint();
    ta.focus();
    ta.setSelectionRange(a, z);
    changed();
  }

  // 글을 고르면 위에 꾸밈 막대가 뜬다.
  function showBar(obj, ta, textKey, richKey, paint) {
    if (readOnly || document.activeElement !== ta || ta.selectionStart === ta.selectionEnd || ta.closest(".blk-code")) return closeBar();
    if (bar?.ta === ta) return;
    closeBar();
    const btn = (label, title, run, cls = "") => el("button", { type: "button", className: `fmt-btn ${cls}`, textContent: label, title, onclick: run });
    const f = (key, value) => () => format(obj, ta, textKey, richKey, paint, key, value);
    const palette = el("div", { className: "fmt-colors", hidden: true });
    for (const [c, name] of COLORS) {
      palette.append(btn("A", `글자 ${name}`, f("color", c === "default" ? null : c), `c-${c}`));
    }
    for (const [c, name] of COLORS.slice(1)) palette.append(btn("A", `배경 ${name}`, f("color", `${c}_background`), `c-${c}_background`));
    const box = el(
      "div",
      { className: "fmt-bar" },
      btn("B", "굵게 (Ctrl+B)", f("b"), "r-b"),
      btn("I", "기울임 (Ctrl+I)", f("i"), "r-i"),
      btn("U", "밑줄 (Ctrl+U)", f("u"), "r-u"),
      btn("S", "취소선 (Ctrl+Shift+S)", f("s"), "r-s"),
      btn("</>", "코드 (Ctrl+E)", f("c")),
      btn("링크", "링크 (Ctrl+K)", f("href")),
      btn("색", "글자색·배경색", () => (palette.hidden = !palette.hidden), "fmt-menu"),
      palette,
    );
    box.onmousedown = (ev) => ev.preventDefault(); // 고른 범위를 지킨다
    const r = ta.getBoundingClientRect();
    box.style.left = Math.max(8, Math.min(r.left, innerWidth - 330)) + "px";
    box.style.top = (r.top > 60 ? r.top - 40 : r.bottom + 6) + "px";
    document.body.append(box);
    bar = { box, ta };
  }
  function closeBar() {
    bar?.box.remove();
    bar = null;
  }

  function blockEl(b, num) {
    const row = el("div", { className: `blk blk-${b.type}${b.checked ? " checked" : ""}${b.color ? ` bc-${b.color}` : ""}` });
    row.dataset.id = b.id;
    row.style.setProperty("--d", depth(b));
    if (!readOnly) {
      const handle = el("button", { type: "button", className: "blk-handle", title: "끌어서 옮기기 · 눌러서 메뉴", ariaLabel: "블록 메뉴", draggable: true, textContent: "⋮⋮" });
      handle.onclick = () => openMenu(b, handle, "handle");
      handle.ondragstart = (ev) => {
        dragId = b.id;
        ev.dataTransfer.effectAllowed = "move";
        ev.dataTransfer.setData("text/plain", "");
        ev.dataTransfer.setDragImage(row, 0, 0);
      };
      handle.ondragend = () => {
        dragId = null;
        root.querySelectorAll(".drop-before, .drop-after").forEach((x) => x.classList.remove("drop-before", "drop-after"));
      };
      row.append(handle);
      row.ondragover = (ev) => {
        if (!dragId || dragId === b.id) return;
        ev.preventDefault();
        const after = ev.offsetY > row.offsetHeight / 2;
        row.classList.toggle("drop-after", after);
        row.classList.toggle("drop-before", !after);
      };
      row.ondragleave = () => row.classList.remove("drop-before", "drop-after");
      row.ondrop = (ev) => {
        ev.preventDefault();
        if (!dragId || dragId === b.id) return;
        moveTo(dragId, b.id, row.classList.contains("drop-after"));
      };
    }

    // 글 앞 표시
    if (b.type === "todo") {
      row.append(el("input", { type: "checkbox", className: "blk-check", checked: !!b.checked, disabled: readOnly, onchange() { b.checked = this.checked; row.classList.toggle("checked", b.checked); changed(); } }));
    } else if (b.type === "bullet") {
      row.append(el("span", { className: "blk-marker", textContent: ["•", "◦", "▪"][depth(b) % 3] }));
    } else if (b.type === "number") {
      row.append(el("span", { className: "blk-marker", textContent: `${num}.` }));
    } else if (foldable(b)) {
      const t = el("button", { type: "button", className: "blk-fold", ariaLabel: "펼치기·접기", innerHTML: FOLD_ICON });
      t.ariaExpanded = String(open.has(b.id));
      t.onclick = () => {
        open.has(b.id) ? open.delete(b.id) : open.add(b.id);
        if (open.has(b.id) && !hasKids(idx(b.id)) && !readOnly) {
          blocks.splice(idx(b.id) + 1, 0, emptyBlock("p", depth(b) + 1)); // 빈 토글을 펼치면 안에 쓸 줄을 준다
          render(blocks[idx(b.id) + 1].id);
          return changed();
        }
        render();
      };
      row.append(t);
    } else if (b.type === "callout") {
      row.append(el("button", { type: "button", className: "blk-icon", textContent: b.icon || "💡", title: "아이콘 바꾸기", disabled: readOnly, onclick() {
        const v = prompt("아이콘 (이모지 하나)", b.icon || "💡");
        if (v === null) return;
        b.icon = [...v.trim()].slice(0, 2).join("") || "💡";
        this.textContent = b.icon;
        changed();
      } }));
    }

    const solid = (cls, ...kids) => {
      const box = el("div", { className: `blk-solid ${cls}`, tabIndex: 0 }, ...kids);
      box.onkeydown = (ev) => onSolidKey(ev, b);
      return box;
    };

    if (TEXT_TYPES.includes(b.type)) {
      if (b.type === "code") {
        const ta = el("textarea", { className: "blk-text", rows: 1, value: b.text, placeholder: PLACEHOLDER.code, spellcheck: false, readOnly });
        ta.oninput = () => {
          if (b.rich) store(b, mergeEdit(b.rich, b.text, ta.value));
          else b.text = ta.value;
          autosize(ta);
          changed();
        };
        ta.onkeydown = (ev) => onKey(ev, b, ta);
        ta.onpaste = (ev) => onPaste(ev, b, ta);
        row.append(el("div", { className: "blk-field" }, ta, el("span", { className: "blk-lang", textContent: b.lang && b.lang !== "plain text" ? b.lang : "" })));
      } else {
        row.append(richField(b, { placeholder: PLACEHOLDER[b.type], onText: (ta) => onInput(b, ta), onKey: (ev, ta) => onKey(ev, b, ta) }));
        const ta = row.querySelector(".blk-text");
        ta.onpaste = (ev) => onPaste(ev, b, ta);
      }
    } else if (b.type === "equation") {
      const ta = el("textarea", { className: "blk-text", rows: 1, value: b.text, placeholder: PLACEHOLDER.equation, spellcheck: false, readOnly });
      ta.oninput = () => ((b.text = ta.value), autosize(ta), changed());
      ta.onkeydown = (ev) => onKey(ev, b, ta);
      row.append(el("span", { className: "blk-marker", textContent: "∑" }), el("div", { className: "blk-field" }, ta));
    } else if (b.type === "divider") {
      row.append(solid("blk-hr", el("hr")));
    } else if (["image", "video", "audio", "pdf", "file"].includes(b.type)) {
      const src = b.fileId !== undefined ? `/api/files/${b.fileId}/content` : b.url;
      let view;
      if (!src) view = el("p", { className: "blk-missing", textContent: `파일을 가져오지 못했습니다${b.name ? ` (${b.name})` : ""}. 노션에서 열어 보세요.` });
      else if (b.type === "image") view = el("img", { src, alt: b.text || b.name || "", loading: "lazy" });
      else if (b.type === "video") view = el("video", { src, controls: true, preload: "metadata" });
      else if (b.type === "audio") view = el("audio", { src, controls: true, preload: "none" });
      else view = el("a", { className: "blk-filelink", href: src, target: "_blank", rel: "noopener", textContent: `📎 ${b.name || (b.fileId !== undefined ? "파일" : b.url)}` });
      row.append(el("figure", { className: "blk-media" }, solid("", view), richField(b, { placeholder: "설명 쓰기", field: "caption", cls: "blk-caption", onKey: (ev, ta) => onKey(ev, b, ta) })));
    } else if (b.type === "bookmark" || b.type === "embed") {
      row.append(el("figure", { className: "blk-media" }, solid("blk-bookmark", el("a", { href: b.url || "#", target: "_blank", rel: "noopener", textContent: `🔗 ${b.url || "주소 없음"}` })), richField(b, { placeholder: "설명 쓰기", field: "caption", cls: "blk-caption", onKey: (ev, ta) => onKey(ev, b, ta) })));
    } else if (b.type === "page" || b.type === "db" || b.type === "link") {
      const note = links[b.page];
      const title = b.text || note?.title || (b.type === "db" ? "데이터베이스" : "노션 페이지");
      const icon = b.type === "db" || b.nt === "database_id" ? "🗂" : b.type === "link" ? "↗" : "📄";
      const a = el("a", { className: "blk-pagelink", textContent: `${icon} ${title}` });
      if (note && b.type !== "db") a.href = `#notes/${note.id}`;
      else Object.assign(a, { href: notionUrl(b.page ?? ""), target: "_blank", rel: "noopener", title: "노션에서 열기" });
      row.append(solid("", a));
    } else if (b.type === "table") {
      row.append(tableEl(b));
    } else if (b.type === "columns" || b.type === "column") {
      row.append(el("span", { className: "blk-label", textContent: b.type === "columns" ? "열 나누기 (노션에서는 나란히 보입니다)" : "열" }));
    } else if (b.type === "synced") {
      row.append(b.page ? solid("blk-synced", el("span", { className: "blk-label", textContent: "동기화된 블록 (원본에서 고치세요)" }), el("p", { textContent: b.text })) : el("span", { className: "blk-label", textContent: "동기화 블록 원본" }));
    } else {
      row.append(solid("blk-opaque", el("span", { textContent: `${OPAQUE_NAMES[b.nt] ?? b.nt} — 이 사이트에서는 보이지 않는 노션 블록입니다` })));
    }

    if (b.type === "todo") {
      // 날짜를 넣으면 할 일이 되어 오늘 화면과 캘린더에 나온다.
      const date = el("input", { type: "date", className: "blk-date", value: b.date ?? "", title: "날짜를 넣으면 오늘·캘린더에 나옵니다", disabled: readOnly });
      const time = el("input", { type: "time", className: "blk-time", value: b.time ?? "", hidden: !b.date, title: "시간 (선택)", disabled: readOnly });
      date.onchange = () => {
        if (date.value) b.date = date.value;
        else delete b.date, delete b.time, (time.value = "");
        time.hidden = !b.date;
        row.classList.toggle("dated", !!b.date);
        changed();
      };
      time.onchange = () => {
        if (time.value) b.time = time.value;
        else delete b.time;
        changed();
      };
      row.classList.toggle("dated", !!b.date);
      row.append(el("span", { className: "blk-when" }, date, time));
    }
    return row;
  }

  // 표: 칸마다 글 칸 하나. 행 추가·삭제(열 수는 노션에서처럼 처음 정한 대로).
  function tableEl(b) {
    const table = el("table", { className: `blk-table${b.colHeader ? " col-head" : ""}${b.rowHeader ? " row-head" : ""}` });
    for (const [ri, r] of (b.rows ?? []).entries()) {
      const tr = el("tr");
      for (let ci = 0; ci < b.width; ci++) {
        const cell = { text: plainOf(r.cells[ci] ?? []), rich: r.cells[ci]?.some((x) => !isPlainRun(x)) ? r.cells[ci] : undefined };
        const f = richField(cell, { onText: changed, sync: () => (r.cells[ci] = normalize(runsOf(cell.text, cell.rich))) });
        f.querySelector("textarea").dataset.cell = `${ri}:${ci}`;
        tr.append(el("td", {}, f));
      }
      if (!readOnly) tr.append(el("td", { className: "row-del" }, el("button", { type: "button", title: "행 지우기", textContent: "×", onclick: () => {
        b.rows.splice(ri, 1);
        if (!b.rows.length) remove(b.id);
        else render(), changed();
      } })));
      table.append(tr);
    }
    const box = el("div", { className: "blk-tablebox" }, table);
    if (!readOnly) box.append(el("button", { type: "button", className: "btn ghost sm", textContent: "+ 행 추가", onclick: () => {
      b.rows.push({ id: newId(), cells: Array.from({ length: b.width }, () => []) });
      render();
      changed();
    } }));
    return box;
  }

  // 블록과 그 아래 블록들을 다른 블록 앞이나 뒤(그 블록의 하위까지 지나서)로 옮긴다. 깊이는 그 블록에 맞춘다.
  function moveTo(id, targetId, after) {
    const i = idx(id);
    const t0 = idx(targetId);
    if (t0 > i && t0 < subtreeEnd(i)) return; // 자기 안으로는 못 옮긴다
    const moved = blocks.splice(i, subtreeEnd(i) - i);
    const t = idx(targetId);
    const shift = depth(blocks[t]) - depth(moved[0]);
    for (const m of moved) m.d = depth(m) + shift;
    blocks.splice(after ? subtreeEnd(t) : t, 0, ...moved);
    fixDepths(blocks);
    render();
    changed();
  }

  function indent(b, by) {
    const i = idx(b.id);
    const end = subtreeEnd(i);
    if (by > 0) {
      // 바로 위 같은 깊이의 블록 아래로 들어간다.
      let p = i - 1;
      while (p >= 0 && depth(blocks[p]) > depth(b)) p--;
      if (p < 0 || depth(blocks[p]) !== depth(b) || !canHold(blocks[p], b)) return false;
    } else if (!depth(b)) return false;
    for (let j = i; j < end; j++) blocks[j].d = depth(blocks[j]) + by;
    if (by > 0) {
      let p = i - 1;
      while (depth(blocks[p]) >= depth(b)) p--;
      open.add(blocks[p].id);
    }
    fixDepths(blocks);
    return true;
  }

  function setType(b, type, focusPos = 0) {
    const was = b.type;
    b.type = type;
    if (type === "todo") b.checked = !!b.checked;
    else delete b.checked, delete b.date, delete b.time;
    if (type === "code") (b.lang ??= "plain text"), delete b.rich;
    else delete b.lang;
    if (type === "callout") b.icon ??= "💡";
    else delete b.icon;
    if (!["h1", "h2", "h3"].includes(type)) delete b.toggle;
    if (type === "equation") delete b.rich;
    if (type === "divider") {
      b.text = "";
      delete b.rich;
      const i = idx(b.id);
      const next = blocks[i + 1];
      if (!next || next.type === "divider") blocks.splice(i + 1, 0, emptyBlock("p", depth(b)));
      fixDepths(blocks);
      render(blocks[i + 1].id, 0);
    } else {
      if (type === "toggle" && was !== "toggle") open.add(b.id);
      fixDepths(blocks);
      render(b.id, focusPos);
    }
    changed();
  }

  // 하위 페이지·데이터베이스를 지우면 노션에서도 휴지통으로 가므로 묻고 지운다.
  function remove(id, ask = true) {
    const i = idx(id);
    const end = subtreeEnd(i);
    const gone = blocks.slice(i, end);
    const pages = gone.filter((x) => x.type === "page" || x.type === "db");
    if (ask && pages.length && !confirm(`이 블록을 지우면 ${pages.map((p) => `"${p.text || "제목 없음"}"`).join(", ")} 페이지도 노션 휴지통으로 갑니다. 지울까요?`)) return;
    blocks.splice(i, 1);
    // 지운 블록 아래 있던 블록은 한 단계 위로 올린다.
    for (let j = i; j < end - 1; j++) blocks[j].d = depth(blocks[j]) - 1;
    if (!blocks.length) blocks.push(emptyBlock());
    fixDepths(blocks);
    const prev = blocks[Math.max(0, i - 1)];
    render(TEXT_TYPES.includes(prev.type) ? prev.id : undefined);
    changed();
  }

  function onInput(b, ta) {
    autosize(ta);
    if (b.type === "p" && !b.rich) {
      if (/^(---|\*\*\*)$/.test(ta.value)) return setType(b, "divider");
      if (ta.value === "```") return (b.text = ""), setType(b, "code");
      for (const [re, type, checked] of SHORTCUTS) {
        const m = ta.value.match(re);
        if (m && ta.selectionStart === m[0].length) {
          b.text = ta.value.slice(m[0].length);
          if (checked) b.checked = true;
          return setType(b, type);
        }
      }
    }
    const slash = ta.value.match(/^\/(\S{0,20})$/);
    if (slash) openMenu(b, ta, "slash", slash[1]);
    else if (menu?.mode === "slash") closeMenu();
    changed();
  }

  // 화살표로 블록 사이를 오간다: 맨 앞/맨 끝에서 한 번 더 누르면 옆 블록으로(보이는 블록만).
  function step(b, dir, pos) {
    const list = visible();
    const k = list.findIndex((x) => x.id === b.id) + dir;
    const next = list[k];
    if (!next) return false;
    focus(next.id, pos);
    return true;
  }

  function onSolidKey(ev, b) {
    if (readOnly) return;
    if (ev.target !== ev.currentTarget) return;
    if (ev.key === "Backspace" || ev.key === "Delete") return ev.preventDefault(), remove(b.id);
    if (ev.key === "ArrowUp" || ev.key === "ArrowLeft") return step(b, -1, "end") && ev.preventDefault();
    if (ev.key === "ArrowDown" || ev.key === "ArrowRight") return step(b, 1, 0) && ev.preventDefault();
    if (ev.key === "Enter") {
      ev.preventDefault();
      const nb = emptyBlock("p", depth(b));
      blocks.splice(subtreeEnd(idx(b.id)), 0, nb);
      render(nb.id);
      changed();
    }
  }

  function onKey(ev, b, ta) {
    if (ev.isComposing || ev.keyCode === 229) return; // 한글 조합 중인 Enter·화살표는 IME 몫
    if (menu && ["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(ev.key)) {
      ev.preventDefault();
      if (ev.key === "Escape") return closeMenu();
      if (ev.key === "Enter") return menu.items[menu.index]?.run();
      menu.index = (menu.index + (ev.key === "ArrowDown" ? 1 : -1) + menu.items.length) % menu.items.length;
      return paintMenu();
    }
    if (readOnly) return;
    const isCaption = ta.dataset.field === "caption";
    const i = idx(b.id);
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const collapsed = start === end;
    const runs = () => runsOf(b.text, b.rich);

    if (ev.key === "Tab" && !isCaption) {
      ev.preventDefault();
      if (indent(b, ev.shiftKey ? -1 : 1)) {
        render(b.id, start);
        changed();
      }
      return;
    }
    if (ev.key === "Enter" && !ev.shiftKey && (b.type !== "code" || ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      if (isCaption || b.type === "equation") {
        const nb = emptyBlock("p", depth(b));
        blocks.splice(subtreeEnd(i), 0, nb);
        render(nb.id);
        return changed();
      }
      // 빈 목록에서 Enter = 들여쓴 것이면 한 단계 밖으로, 아니면 목록 끝내기
      if (!b.text && b.type !== "p") {
        if (depth(b) && indent(b, -1)) return render(b.id), changed();
        return setType(b, "p");
      }
      const nextType = LIST_TYPES.includes(b.type) ? b.type : "p";
      if (start === 0 && end === 0 && b.text) {
        blocks.splice(i, 0, emptyBlock(nextType === "toggle" ? "p" : nextType, depth(b))); // 맨 앞에서 Enter = 위에 빈 줄
        render(b.id, 0);
        return changed();
      }
      // 펼친 토글이나 하위 블록이 있는 블록에서는 첫 하위 블록으로, 접힌 토글이면 그 아래로.
      let at = i + 1;
      let d = depth(b);
      let type = nextType;
      if (foldable(b) && !open.has(b.id)) at = subtreeEnd(i);
      else if (foldable(b) || hasKids(i)) {
        d++;
        if (foldable(b)) type = "p";
      }
      const nb = emptyBlock(type, d);
      store(nb, sliceRuns(runs(), end, b.text.length));
      store(b, sliceRuns(runs(), 0, start));
      blocks.splice(at, 0, nb);
      fixDepths(blocks);
      render(nb.id, 0);
      return changed();
    }
    if (ev.key === "Backspace" && collapsed && start === 0 && !isCaption) {
      if (b.type !== "p" && TEXT_TYPES.includes(b.type)) return ev.preventDefault(), setType(b, "p");
      if (depth(b) && indent(b, -1)) return ev.preventDefault(), render(b.id, 0), changed();
      const list = visible();
      const prev = list[list.findIndex((x) => x.id === b.id) - 1];
      if (!prev) return;
      ev.preventDefault();
      if (prev.type === "divider") return remove(prev.id), focus(b.id, 0);
      if (!TEXT_TYPES.includes(prev.type) || prev.type === "code") return focus(prev.id);
      const pos = prev.text.length;
      store(prev, [...runsOf(prev.text, prev.rich), ...runs()]);
      const j = idx(b.id);
      const endB = subtreeEnd(j);
      for (let k = j + 1; k < endB; k++) blocks[k].d = depth(blocks[k]) + depth(prev) - depth(b); // 하위는 합친 블록 아래로
      blocks.splice(j, 1);
      fixDepths(blocks);
      render(prev.id, pos);
      return changed();
    }
    if (ev.key === "Delete" && collapsed && start === b.text.length && !isCaption) {
      const list = visible();
      const next = list[list.findIndex((x) => x.id === b.id) + 1];
      if (!next) return;
      ev.preventDefault();
      if (next.type === "divider") return remove(next.id, false), focus(b.id, start);
      if (!TEXT_TYPES.includes(next.type) || next.type === "code") return;
      store(b, [...runs(), ...runsOf(next.text, next.rich)]);
      blocks.splice(idx(next.id), 1);
      fixDepths(blocks);
      render(b.id, start);
      return changed();
    }
    if (collapsed && !ev.shiftKey && (ev.key === "ArrowUp" || ev.key === "ArrowLeft") && start === 0) return step(b, -1, "end") && ev.preventDefault();
    if (collapsed && !ev.shiftKey && (ev.key === "ArrowDown" || ev.key === "ArrowRight") && end === ta.value.length) return step(b, 1, 0) && ev.preventDefault();
  }

  function onPaste(ev, b, ta) {
    const text = ev.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
    if (b.type === "code" || !text.includes("\n") || readOnly) return;
    ev.preventDefault();
    const lines = text.split("\n");
    const runs = runsOf(b.text, b.rich);
    const tail = sliceRuns(runs, ta.selectionEnd, b.text.length);
    store(b, [...sliceRuns(runs, 0, ta.selectionStart), { t: lines[0] }]);
    const added = linesToBlocks(lines.slice(1), depth(b));
    if (added.at(-1).type === "divider" && tail.length) added.push(emptyBlock("p", depth(b))); // 구분선에는 글이 못 들어간다
    const last = added.at(-1);
    const pos = last.text.length;
    store(last, [{ t: last.text }, ...tail]);
    blocks.splice(subtreeEnd(idx(b.id)), 0, ...added);
    fixDepths(blocks);
    render(last.type === "divider" ? undefined : last.id, pos);
    changed();
  }

  // 사진·파일 블록: 클라우드에서 고르거나 새로 올린 파일마다 하나.
  function mediaType(f) {
    const m = f.mime || "";
    return m.startsWith("image/") ? "image" : m.startsWith("video/") ? "video" : m.startsWith("audio/") ? "audio" : m === "application/pdf" ? "pdf" : "file";
  }
  function addMedia(afterId, f) {
    const b = blocks[idx(afterId)];
    const nb = { id: newId(), type: mediaType(f), text: "", fileId: f.id, name: f.name };
    if (depth(b)) nb.d = depth(b);
    const at = b.type === "p" && !b.text ? idx(afterId) : subtreeEnd(idx(afterId));
    if (b.type === "p" && !b.text) blocks.splice(at, 1, nb);
    else blocks.splice(at, 0, nb);
    render();
    changed();
    return nb.id;
  }

  function runExtra(b, action) {
    if (action === "media") {
      let last = b.id;
      opts.pickFile?.((f) => (last = addMedia(last, f)));
    } else if (action === "bookmark") {
      const url = prompt("북마크할 주소", "https://");
      if (!url || !/^https?:\/\//i.test(url.trim())) return;
      Object.assign(b, { type: "bookmark", text: "", url: url.trim() });
      delete b.rich, delete b.checked, delete b.date, delete b.time;
      render();
      changed();
    } else if (action === "table") {
      Object.assign(b, { type: "table", text: "", width: 3, colHeader: 1, rows: [0, 1, 2].map(() => ({ id: newId(), cells: [[], [], []] })) });
      delete b.rich, delete b.checked, delete b.date, delete b.time;
      render();
      changed();
    }
  }

  // 메뉴: "/" 로 연 블록 고르기, 또는 ⋮⋮ 손잡이 메뉴(바꾸기·색·옮기기·들여쓰기·삭제).
  function openMenu(b, anchor, mode, query = "", sub = null) {
    const q = query.toLowerCase();
    const hit = (t) => !q || (t.label + " " + t.keys).toLowerCase().replace(/\s/g, "").includes(q);
    let items = [];
    const canRetype = TEXT_TYPES.includes(b.type) || b.type === "equation" || b.type === "divider";
    if (sub === "color") {
      items = [
        ...COLORS.map(([c, name]) => ({ label: `글자 ${name}`, cls: `c-${c}`, run: () => setColor(b, c === "default" ? null : c) })),
        ...COLORS.slice(1).map(([c, name]) => ({ label: `배경 ${name}`, cls: `c-${c}_background`, run: () => setColor(b, `${c}_background`) })),
      ];
    } else if (mode === "slash" || canRetype) {
      items = TYPES.filter(hit).map((t) => ({
        label: t.label,
        run: () => {
          if (mode === "slash") b.text = "", delete b.rich;
          setType(b, t.type, mode === "slash" ? 0 : "end");
        },
      }));
      if (mode === "slash") items.push(...EXTRA.filter(hit).map((x) => ({ label: x.label, run: () => (closeMenu(), (b.text = ""), runExtra(b, x.action)) })));
    }
    if (mode === "handle" && !sub) {
      const i = idx(b.id);
      const sibling = (dir) => {
        if (dir < 0) {
          let j = i - 1;
          while (j >= 0 && depth(blocks[j]) > depth(b)) j--;
          return j >= 0 && depth(blocks[j]) === depth(b) ? blocks[j] : null;
        }
        const j = subtreeEnd(i);
        return blocks[j] && depth(blocks[j]) === depth(b) ? blocks[j] : null;
      };
      const up = sibling(-1);
      const down = sibling(1);
      if (["h1", "h2", "h3"].includes(b.type)) items.push({ label: b.toggle ? "접기 끄기" : "접을 수 있는 제목으로", run: () => ((b.toggle ? delete b.toggle : ((b.toggle = 1), open.add(b.id))), fixDepths(blocks), render(), changed()), sep: true });
      if (b.type !== "column" && b.type !== "columns" && b.type !== "table" && b.type !== "page" && b.type !== "db") items.push({ label: "색", run: () => openMenu(b, anchor, "handle", "", "color"), sep: !items.length || !["h1", "h2", "h3"].includes(b.type) });
      if (up) items.push({ label: "위로 옮기기", run: () => moveTo(b.id, up.id, false), sep: true });
      if (down) items.push({ label: "아래로 옮기기", run: () => moveTo(b.id, down.id, true), sep: !up });
      items.push({ label: "들여쓰기 (Tab)", run: () => indent(b, 1) && (render(), changed()), sep: true });
      if (depth(b)) items.push({ label: "내어쓰기 (Shift+Tab)", run: () => indent(b, -1) && (render(), changed()) });
      if (b.type !== "column") items.push({ label: "삭제", run: () => remove(b.id), danger: true, sep: true });
    }
    if (!items.length) return closeMenu();
    closeMenu();
    const box = el("div", { className: "blk-menu" });
    box.onmousedown = (ev) => ev.preventDefault(); // keep the caret in the block
    const r = anchor.getBoundingClientRect();
    box.style.left = Math.min(r.left, innerWidth - 220) + "px";
    box.style.top = (r.bottom + 260 > innerHeight ? Math.max(8, r.top - 260) : r.bottom + 4) + "px";
    document.body.append(box);
    menu = { box, items, index: 0, block: b, mode };
    paintMenu();
  }

  function setColor(b, c) {
    if (c) b.color = c;
    else delete b.color;
    render(TEXT_TYPES.includes(b.type) ? b.id : undefined);
    changed();
  }

  function paintMenu() {
    menu.box.replaceChildren(
      ...menu.items.map((it, i) =>
        el("button", { type: "button", className: `blk-menu-item${i === menu.index ? " on" : ""}${it.danger ? " danger" : ""}${it.sep ? " sep" : ""}${it.cls ? " " + it.cls : ""}`, textContent: it.label, onclick: it.run }),
      ),
    );
  }

  function closeMenu() {
    menu?.box.remove();
    menu = null;
  }
  document.addEventListener("mousedown", (ev) => {
    if (menu && !menu.box.contains(ev.target) && !ev.target.closest?.(".blk-handle")) closeMenu();
    if (bar && !bar.box.contains(ev.target) && ev.target !== bar.ta) closeBar();
  });
  addEventListener("resize", () => root.querySelectorAll(".blk-text").forEach(autosize));

  // 마지막 블록 아래 빈 곳을 누르면 거기서 이어 쓴다.
  root.onclick = (ev) => {
    if (ev.target !== root || readOnly) return;
    const last = blocks.at(-1);
    if (last.type === "p" && !last.text && !depth(last)) return focus(last.id);
    blocks.push(emptyBlock());
    render(blocks.at(-1).id);
    changed();
  };

  return {
    set(list, l = {}) {
      blocks = list.length ? structuredClone(list) : [emptyBlock()];
      links = l;
      render();
    },
    // 다른 곳에서 바뀐 내용으로 바꾸되 커서는 제자리에.
    replace(list, l = links) {
      const f = snapshotFocus();
      blocks = list.length ? structuredClone(list) : [emptyBlock()];
      links = l;
      render();
      restoreFocus(f);
    },
    setReadOnly(v) {
      readOnly = v;
    },
    get: () => blocks,
    focusFirst: () => {
      const first = visible().find((b) => TEXT_TYPES.includes(b.type));
      if (first) focus(first.id, 0);
    },
    closeMenu: () => (closeMenu(), closeBar()),
  };
}

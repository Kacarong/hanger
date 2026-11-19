// 노트 블록 편집기. 블록마다 textarea 하나(한글 입력이 안정적이다).
// 블록: { id, type, text, checked?, date?, time? } — 서버(app.ts noteBlocks)와 같은 모양.

export const TYPES = [
  { type: "p", label: "텍스트", keys: "text 텍스트 본문 글" },
  { type: "h1", label: "제목 1", keys: "h1 heading 제목1 큰제목" },
  { type: "h2", label: "제목 2", keys: "h2 heading 제목2 중간제목" },
  { type: "h3", label: "제목 3", keys: "h3 heading 제목3 작은제목" },
  { type: "todo", label: "할 일 체크박스", keys: "todo check 할일 체크박스" },
  { type: "bullet", label: "글머리 목록", keys: "bullet list 글머리 목록" },
  { type: "number", label: "번호 목록", keys: "number list 번호 목록" },
  { type: "quote", label: "인용", keys: "quote 인용" },
  { type: "code", label: "코드", keys: "code 코드" },
  { type: "divider", label: "구분선", keys: "divider hr 구분선" },
];
const LIST_TYPES = ["todo", "bullet", "number"]; // Enter continues these
const PLACEHOLDER = { p: "글을 쓰거나 / 를 눌러 블록을 고르세요", h1: "제목 1", h2: "제목 2", h3: "제목 3", todo: "할 일", bullet: "목록", number: "목록", quote: "인용", code: "코드" };

// 줄 맨 앞에 쓰면 블록 종류가 바뀌는 표시 (마크다운처럼).
const SHORTCUTS = [
  [/^### /, "h3"], [/^## /, "h2"], [/^# /, "h1"], [/^[-*] /, "bullet"], [/^1[.)] /, "number"],
  [/^\[ ?\] /, "todo"], [/^\[x\] /i, "todo", true], [/^> /, "quote"],
];

const newId = () => crypto.randomUUID().slice(0, 8);
export const emptyBlock = (type = "p") => (type === "todo" ? { id: newId(), type, text: "", checked: false } : { id: newId(), type, text: "" });

function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return e;
}

// Turns pasted lines into blocks, reading the same shortcuts.
function linesToBlocks(lines) {
  return lines.map((line) => {
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) return emptyBlock("divider");
    for (const [re, type, checked] of SHORTCUTS) {
      if (re.test(line)) return { ...emptyBlock(type), text: line.replace(re, ""), ...(type === "todo" ? { checked: !!checked } : {}) };
    }
    return { ...emptyBlock(), text: line };
  });
}

export function createEditor(root, onChange) {
  let blocks = [emptyBlock()];
  let menu = null; // { box, items, index, block, mode: "slash" | "handle" }
  let dragId = null;

  const idx = (id) => blocks.findIndex((b) => b.id === id);
  const textOf = (id) => root.querySelector(`[data-id="${id}"] .blk-text`);
  const changed = () => onChange();

  function focus(id, pos = "end") {
    const ta = textOf(id);
    if (!ta) return;
    ta.focus();
    const p = pos === "end" ? ta.value.length : pos;
    ta.setSelectionRange(p, p);
  }

  const autosize = (ta) => {
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  };

  function render(focusId, pos) {
    closeMenu();
    let n = 0;
    root.replaceChildren(
      ...blocks.map((b) => {
        n = b.type === "number" ? n + 1 : 0;
        return blockEl(b, n);
      }),
    );
    root.querySelectorAll(".blk-text").forEach(autosize);
    if (focusId) focus(focusId, pos);
  }

  function blockEl(b, num) {
    const row = el("div", { className: `blk blk-${b.type}${b.checked ? " checked" : ""}` });
    row.dataset.id = b.id;
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

    if (b.type === "divider") {
      row.append(el("hr", { tabIndex: 0, onkeydown: (ev) => (ev.key === "Backspace" || ev.key === "Delete") && (ev.preventDefault(), remove(b.id)) }));
      return row;
    }
    if (b.type === "todo") {
      row.append(el("input", { type: "checkbox", className: "blk-check", checked: !!b.checked, onchange() { b.checked = this.checked; row.classList.toggle("checked", b.checked); changed(); } }));
    } else if (b.type === "bullet") {
      row.append(el("span", { className: "blk-marker", textContent: "•" }));
    } else if (b.type === "number") {
      row.append(el("span", { className: "blk-marker", textContent: `${num}.` }));
    }
    const ta = el("textarea", { className: "blk-text", rows: 1, value: b.text, placeholder: PLACEHOLDER[b.type], spellcheck: b.type !== "code" });
    ta.oninput = () => onInput(b, ta);
    ta.onkeydown = (ev) => onKey(ev, b, ta);
    ta.onpaste = (ev) => onPaste(ev, b, ta);
    ta.onblur = () => setTimeout(() => menu?.mode === "slash" && menu.block === b && closeMenu(), 150);
    row.append(ta);

    if (b.type === "todo") {
      // 날짜를 넣으면 할 일이 되어 오늘 화면과 캘린더에 나온다.
      const date = el("input", { type: "date", className: "blk-date", value: b.date ?? "", title: "날짜를 넣으면 오늘·캘린더에 나옵니다" });
      const time = el("input", { type: "time", className: "blk-time", value: b.time ?? "", hidden: !b.date, title: "시간 (선택)" });
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
      const after = row.classList.contains("drop-after");
      const [moved] = blocks.splice(idx(dragId), 1);
      blocks.splice(idx(b.id) + (after ? 1 : 0), 0, moved);
      render();
      changed();
    };
    return row;
  }

  function setType(b, type, focusPos = 0) {
    b.type = type;
    if (type === "todo") b.checked = !!b.checked;
    else delete b.checked, delete b.date, delete b.time;
    if (type === "divider") {
      b.text = "";
      const i = idx(b.id);
      const next = blocks[i + 1];
      if (!next || next.type === "divider") blocks.splice(i + 1, 0, emptyBlock());
      render(blocks[i + 1].id, 0);
    } else render(b.id, focusPos);
    changed();
  }

  function remove(id) {
    const i = idx(id);
    blocks.splice(i, 1);
    if (!blocks.length) blocks.push(emptyBlock());
    const prev = blocks[Math.max(0, i - 1)];
    render(prev.type === "divider" ? undefined : prev.id);
    changed();
  }

  function onInput(b, ta) {
    b.text = ta.value;
    autosize(ta);
    if (b.type === "p") {
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
    const slash = b.type !== "code" && ta.value.match(/^\/(\S{0,20})$/);
    if (slash) openMenu(b, ta, "slash", slash[1]);
    else if (menu?.mode === "slash") closeMenu();
    changed();
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
    const i = idx(b.id);
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const collapsed = start === end;

    if (ev.key === "Enter" && !ev.shiftKey && (b.type !== "code" || ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      if (!b.text && b.type !== "p") return setType(b, "p"); // 빈 목록에서 Enter = 목록 끝내기
      const nextType = LIST_TYPES.includes(b.type) ? b.type : "p";
      if (start === 0 && end === 0 && b.text) {
        blocks.splice(i, 0, emptyBlock(nextType)); // 맨 앞에서 Enter = 위에 빈 줄
        render(b.id, 0);
      } else {
        const nb = { ...emptyBlock(nextType), text: b.text.slice(end) };
        b.text = b.text.slice(0, start);
        blocks.splice(i + 1, 0, nb);
        render(nb.id, 0);
      }
      return changed();
    }
    if (ev.key === "Backspace" && collapsed && start === 0) {
      if (b.type !== "p") return ev.preventDefault(), setType(b, "p");
      const prev = blocks[i - 1];
      if (!prev) return;
      ev.preventDefault();
      if (prev.type === "divider") {
        blocks.splice(i - 1, 1);
        render(b.id, 0);
      } else {
        const pos = prev.text.length;
        prev.text += b.text;
        blocks.splice(i, 1);
        render(prev.id, pos);
      }
      return changed();
    }
    if (ev.key === "Delete" && collapsed && start === b.text.length) {
      const next = blocks[i + 1];
      if (!next) return;
      ev.preventDefault();
      if (next.type !== "divider") b.text += next.text;
      blocks.splice(i + 1, 1);
      render(b.id, start);
      return changed();
    }
    // 화살표로 블록 사이를 오간다: 맨 앞/맨 끝에서 한 번 더 누르면 옆 블록으로.
    const move = (j, pos) => {
      let k = j;
      while (blocks[k]?.type === "divider") k += j < i ? -1 : 1;
      if (!blocks[k]) return;
      ev.preventDefault();
      focus(blocks[k].id, pos);
    };
    if (collapsed && !ev.shiftKey && (ev.key === "ArrowUp" || ev.key === "ArrowLeft") && start === 0) return move(i - 1, "end");
    if (collapsed && !ev.shiftKey && (ev.key === "ArrowDown" || ev.key === "ArrowRight") && end === b.text.length) return move(i + 1, 0);
  }

  function onPaste(ev, b, ta) {
    const text = ev.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
    if (b.type === "code" || !text.includes("\n")) return;
    ev.preventDefault();
    const lines = text.split("\n");
    const tail = b.text.slice(ta.selectionEnd);
    b.text = b.text.slice(0, ta.selectionStart) + lines[0];
    const added = linesToBlocks(lines.slice(1));
    const last = added.at(-1);
    const pos = last.text.length;
    last.text += tail;
    blocks.splice(idx(b.id) + 1, 0, ...added);
    render(last.type === "divider" ? undefined : last.id, pos);
    changed();
  }

  // 메뉴: "/" 로 연 블록 고르기, 또는 ⋮⋮ 손잡이 메뉴(바꾸기·옮기기·삭제).
  function openMenu(b, anchor, mode, query = "") {
    const q = query.toLowerCase();
    const types = TYPES.filter((t) => !q || (t.label + " " + t.keys).toLowerCase().replace(/\s/g, "").includes(q));
    const items = types.map((t) => ({
      label: t.label,
      run: () => {
        if (mode === "slash") b.text = "";
        setType(b, t.type, mode === "slash" ? 0 : "end");
      },
    }));
    if (mode === "handle") {
      const i = idx(b.id);
      const swap = (j) => {
        [blocks[i], blocks[j]] = [blocks[j], blocks[i]];
        render(b.type === "divider" ? undefined : b.id);
        changed();
      };
      if (i > 0) items.push({ label: "위로 옮기기", run: () => swap(i - 1), sep: true });
      if (i < blocks.length - 1) items.push({ label: "아래로 옮기기", run: () => swap(i + 1), sep: i === 0 });
      items.push({ label: "삭제", run: () => remove(b.id), danger: true, sep: true });
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

  function paintMenu() {
    menu.box.replaceChildren(
      ...menu.items.map((it, i) =>
        el("button", { type: "button", className: `blk-menu-item${i === menu.index ? " on" : ""}${it.danger ? " danger" : ""}${it.sep ? " sep" : ""}`, textContent: it.label, onclick: it.run }),
      ),
    );
  }

  function closeMenu() {
    menu?.box.remove();
    menu = null;
  }
  document.addEventListener("mousedown", (ev) => menu && !menu.box.contains(ev.target) && !ev.target.closest?.(".blk-handle") && closeMenu());
  addEventListener("resize", () => root.querySelectorAll(".blk-text").forEach(autosize));

  // 마지막 블록 아래 빈 곳을 누르면 거기서 이어 쓴다.
  root.onclick = (ev) => {
    if (ev.target !== root) return;
    const last = blocks.at(-1);
    if (last.type === "p" && !last.text) return focus(last.id);
    blocks.push(emptyBlock());
    render(blocks.at(-1).id);
    changed();
  };

  return {
    set(list) {
      blocks = list.length ? structuredClone(list) : [emptyBlock()];
      render();
    },
    get: () => blocks,
    focusFirst: () => blocks[0].type !== "divider" && focus(blocks[0].id, 0),
    closeMenu,
  };
}

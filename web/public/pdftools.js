// 파일 편집기: PDF 나누기·합치기, 이미지 → PDF, PDF → 이미지. 파일은 이 브라우저 안에서만 처리하고 서버로 보내지 않는다.
// 라이브러리(vendor/)는 이 탭을 처음 쓸 때 불러온다.
const search = new URL(import.meta.url).search; // 같은 ?v= 로 불러야 배포 직후 옛 파일과 섞이지 않는다.
let pdfLib = null;
const lib = () => (pdfLib ??= import("./vendor/pdf-lib.min.js" + search));
let pdfJs = null;
const pdfjs = () =>
  (pdfJs ??= import("./vendor/pdf.min.js" + search).then((m) => {
    m.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdf.worker.min.js" + search, import.meta.url).href;
    return m;
  }));

const MB = 1024 * 1024;
const sizeText = (n) => (n >= MB ? (n / MB).toFixed(1) + "MB" : Math.ceil(n / 1024) + "KB");
const baseName = (name) => name.replace(/\.[^.]+$/, "") || "파일";
const tick = () => new Promise((ok) => setTimeout(ok)); // 긴 작업 중에도 화면이 멈추지 않게

async function openPdf(bytes) {
  const { PDFDocument } = await lib();
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    if (e?.name === "EncryptedPDFError" || /encrypt/i.test(e?.message)) throw new Error("비밀번호가 걸린 PDF는 열 수 없습니다.");
    throw new Error("PDF 파일을 읽지 못했습니다.");
  }
}

// "1-3, 5, 8-" → [[0,1,2],[4],[7,…,n-1]] (0부터 센 쪽 번호). 쉼표로 나눈 묶음마다 파일 하나.
export function parseRanges(text, n) {
  const parts = text.split(",").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error("쪽 범위를 적어 주세요. 예: 1-3, 5, 8-10");
  return parts.map((part) => {
    const m = part.match(/^(\d*)\s*[-~]\s*(\d*)$/) ?? part.match(/^(\d+)()$/);
    if (!m || (!m[1] && !m[2])) throw new Error(`"${part}"는 쪽 범위가 아닙니다. 예: 1-3, 5, 8-10`);
    const from = m[1] ? Number(m[1]) : 1;
    const to = m[2] ? Number(m[2]) : part.includes("-") || part.includes("~") ? n : from;
    if (from < 1 || to > n || from > to) throw new Error(`"${part}": 이 PDF는 1~${n}쪽입니다.`);
    return Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i);
  });
}

async function extract(src, indexes) {
  const { PDFDocument } = await lib();
  const out = await PDFDocument.create();
  for (const p of await out.copyPages(src, indexes)) out.addPage(p);
  return out.save();
}

// 쪽 묶음 정하기. plan: { by: "ranges", text } | { by: "every", n } | { by: "size", mb }
async function splitGroups(src, plan, onProgress) {
  const n = src.getPageCount();
  if (plan.by === "ranges") return parseRanges(plan.text, n);
  const all = src.getPageIndices();
  if (plan.by === "every") {
    const k = Math.floor(Number(plan.n));
    if (!(k >= 1)) throw new Error("몇 쪽마다 나눌지 1 이상으로 적어 주세요.");
    const groups = [];
    for (let i = 0; i < n; i += k) groups.push(all.slice(i, i + k));
    return groups;
  }
  const limit = Number(plan.mb) * MB;
  if (!(limit > 0)) throw new Error("파일 하나의 최대 용량(MB)을 적어 주세요.");
  // 쪽마다 따로 저장한 크기로 잰다. 여러 쪽이 같이 쓰는 글꼴·그림은 쪽마다 세므로 실제 파일은 이보다 작다.
  const groups = [];
  let cur = [];
  let sum = 0;
  for (const i of all) {
    const size = (await extract(src, [i])).length;
    if (cur.length && sum + size > limit) (groups.push(cur), (cur = []), (sum = 0));
    cur.push(i);
    sum += size;
    onProgress?.(`용량 재는 중 ${i + 1}/${n}쪽`);
    await tick();
  }
  if (cur.length) groups.push(cur);
  return groups;
}

// → [{ name, blob, note? }]
export async function splitPdf(bytes, fileName, plan, onProgress) {
  const src = await openPdf(bytes);
  const groups = await splitGroups(src, plan, onProgress);
  const base = baseName(fileName);
  const limit = plan.by === "size" ? Number(plan.mb) * MB : Infinity;
  const out = [];
  for (const [k, g] of groups.entries()) {
    onProgress?.(`나누는 중 ${k + 1}/${groups.length}`);
    const data = await extract(src, g);
    const pages = g.length === 1 ? `${g[0] + 1}` : `${g[0] + 1}-${g.at(-1) + 1}`;
    const contiguous = g.every((p, j) => j === 0 || p === g[j - 1] + 1);
    out.push({
      name: `${base}_${contiguous ? pages : k + 1}.pdf`,
      blob: new Blob([data], { type: "application/pdf" }),
      note: data.length > limit ? "한 쪽만으로 기준 용량을 넘습니다" : undefined,
    });
    await tick();
  }
  return out;
}

// files: File들(이름 + arrayBuffer). 순서대로 이어 붙인다. 원본은 한 번에 하나만 읽어 메모리에 쌓지 않는다.
export async function mergePdfs(files, onProgress) {
  const { PDFDocument } = await lib();
  const out = await PDFDocument.create();
  for (const [k, f] of files.entries()) {
    onProgress?.(`합치는 중 ${k + 1}/${files.length}`);
    let src;
    try {
      src = await openPdf(new Uint8Array(await f.arrayBuffer()));
    } catch (e) {
      throw new Error(`${f.name}: ${e.message}`);
    }
    for (const p of await out.copyPages(src, src.getPageIndices())) out.addPage(p);
    await tick();
  }
  return new Blob([await out.save()], { type: "application/pdf" });
}

// JPEG 안의 EXIF 방향값(1~8). 없으면 1. 휴대폰 사진은 방향값으로만 세워 두는 경우가 많다.
export function jpegOrientation(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return 1;
  for (let off = 2; off + 4 <= v.byteLength; ) {
    const marker = v.getUint16(off);
    const len = v.getUint16(off + 2);
    if (marker === 0xffe1 && off + 10 <= v.byteLength && v.getUint32(off + 4) === 0x45786966) {
      const t = off + 10; // TIFF 머리
      if (t + 8 > v.byteLength) return 1;
      const le = v.getUint16(t) === 0x4949;
      const ifd = t + v.getUint32(t + 4, le);
      if (ifd + 2 > v.byteLength) return 1;
      const count = v.getUint16(ifd, le);
      for (let i = 0; i < count; i++) {
        const e = ifd + 2 + i * 12;
        if (e + 10 > v.byteLength) return 1;
        if (v.getUint16(e, le) === 0x0112) return v.getUint16(e + 8, le) || 1;
      }
      return 1;
    }
    if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) return 1; // 그림 데이터 시작: 더 없음
    off += 2 + len;
  }
  return 1;
}

// 브라우저가 방향까지 맞춰 그린 그림을 JPEG로 다시 만든다(투명한 곳은 흰색).
async function reencode(file) {
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    throw new Error(`${file.name}: 이 형식의 그림은 열 수 없습니다. JPG나 PNG로 바꿔 주세요.`);
  }
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const blob = await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.92));
  return new Uint8Array(await blob.arrayBuffer());
}

const A4 = [595.28, 841.89];
// fit: "image" = 사진 크기 그대로, "a4" = A4에 여백 두고, "a4-full" = A4 여백 없이. 사진 방향에 따라 A4도 세로·가로.
export async function imagesToPdf(files, fit, onProgress) {
  const { PDFDocument } = await lib();
  const out = await PDFDocument.create();
  for (const [k, f] of files.entries()) {
    onProgress?.(`PDF 만드는 중 ${k + 1}/${files.length}`);
    const bytes = new Uint8Array(await f.arrayBuffer());
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
    let img;
    try {
      img = isPng ? await out.embedPng(bytes) : isJpeg && jpegOrientation(bytes) === 1 ? await out.embedJpg(bytes) : await out.embedJpg(await reencode(f));
    } catch (e) {
      throw e.message?.startsWith(f.name) ? e : new Error(`${f.name}: 그림을 읽지 못했습니다.`);
    }
    if (fit === "image") {
      out.addPage([img.width, img.height]).drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    } else {
      const [w, h] = img.width > img.height ? [A4[1], A4[0]] : A4;
      const m = fit === "a4" ? 28 : 0;
      const s = Math.min((w - 2 * m) / img.width, (h - 2 * m) / img.height);
      const dw = img.width * s;
      const dh = img.height * s;
      out.addPage([w, h]).drawImage(img, { x: (w - dw) / 2, y: (h - dh) / 2, width: dw, height: dh });
    }
    await tick();
  }
  return new Blob([await out.save()], { type: "application/pdf" });
}

// PDF 쪽을 그림으로. pages: 0부터 센 쪽 번호(없으면 전체). 한 장씩 그려서 바로 그림 파일로 만든다.
async function pdfToImages(bytes, fileName, { format, dpi, rangeText }, onProgress) {
  const m = await pdfjs();
  const doc = await m.getDocument({ data: bytes, isEvalSupported: false, cMapUrl: new URL("./vendor/cmaps/", import.meta.url).href, cMapPacked: true }).promise.catch((e) => {
    throw new Error(e?.name === "PasswordException" ? "비밀번호가 걸린 PDF는 열 수 없습니다." : "PDF 파일을 읽지 못했습니다.");
  });
  try {
    const pages = rangeText.trim() ? [...new Set(parseRanges(rangeText, doc.numPages).flat())].sort((a, b) => a - b) : [...Array(doc.numPages).keys()];
    const base = baseName(fileName);
    const width = String(doc.numPages).length;
    const type = format === "jpg" ? "image/jpeg" : "image/png";
    const out = [];
    for (const [k, i] of pages.entries()) {
      onProgress?.(`그림으로 바꾸는 중 ${k + 1}/${pages.length}`);
      const page = await doc.getPage(i + 1);
      let vp = page.getViewport({ scale: dpi / 72 });
      const px = vp.width * vp.height;
      if (px > 16e6) vp = page.getViewport({ scale: (dpi / 72) * Math.sqrt(16e6 / px) }); // 브라우저 캔버스 한도 안으로
      const c = document.createElement("canvas");
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
      const blob = await new Promise((ok) => c.toBlob(ok, type, 0.92));
      c.width = c.height = 0;
      page.cleanup();
      out.push({ name: `${base}_${String(i + 1).padStart(width, "0")}.${format}`, blob });
    }
    return out;
  } finally {
    doc.destroy();
  }
}

// 압축 없이 묶는 ZIP(PDF·PNG·JPG는 이미 압축돼 있다). 이름은 UTF-8.
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export async function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const data = new Uint8Array(await f.blob.arrayBuffer());
    const name = new TextEncoder().encode(f.name);
    const crc = crc32(data);
    const head = (sig, extra) => {
      const b = new DataView(new ArrayBuffer(extra ? 46 : 30));
      let o = 0;
      const u16 = (x) => (b.setUint16(o, x, true), (o += 2));
      const u32 = (x) => (b.setUint32(o, x, true), (o += 4));
      u32(sig);
      if (extra) u16(20); // 만든 버전
      u16(20), u16(0x0800), u16(0), u16(time), u16(date), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0);
      if (extra) u16(0), u16(0), u16(0), u32(0), u32(offset);
      return new Uint8Array(b.buffer);
    };
    parts.push(head(0x04034b50, false), name, data);
    central.push(head(0x02014b50, true), name);
    offset += 30 + name.length + data.length;
  }
  const size = central.reduce((s, b) => s + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: "application/zip" });
}

// ---- 화면 ----

function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return e;
}

export function mount(root, { icon }) {
  const urls = []; // 지금 보이는 받기 링크(blob:)들. 새로 처리하면 풀어 준다.
  const status = el("p", { className: "muted pdf-status" });
  const results = el("div", { className: "pdf-results" });
  const pane = el("div", { className: "pdf-pane" });
  let busy = false;

  const clearResults = () => {
    urls.splice(0).forEach((u) => URL.revokeObjectURL(u));
    results.replaceChildren();
    status.textContent = "";
    status.className = "muted pdf-status";
  };
  const showResults = (files) => {
    const link = (f) => {
      const href = URL.createObjectURL(f.blob);
      urls.push(href);
      return el("a", { className: "btn sm", href, download: f.name }, icon("download"), "받기");
    };
    const list = el("ul", { className: "pdf-files" }, ...files.map((f) => el("li", {}, el("span", { className: "name", textContent: f.name }), f.note ? el("span", { className: "error small", textContent: f.note }) : null, el("span", { className: "muted", textContent: sizeText(f.blob.size) }), link(f))));
    const all =
      files.length > 1
        ? el("button", {
            className: "btn primary",
            type: "button",
            onclick: async (ev) => {
              const b = ev.currentTarget;
              b.disabled = true;
              try {
                const z = await zip(files);
                const href = URL.createObjectURL(z);
                urls.push(href);
                el("a", { href, download: `${baseName(files[0].name)} 외 ${files.length - 1}개.zip` }).click();
              } finally {
                b.disabled = false;
              }
            },
          }, icon("download"), `모두 받기 (ZIP, ${files.length}개)`)
        : null;
    results.replaceChildren(el("div", { className: "pdf-results-head" }, el("strong", { textContent: `완료 · ${files.length}개 파일` }), all), list);
  };
  // 버튼 하나를 눌러 처리하는 공통 흐름: 진행 글자, 오류 표시, 결과 받기 링크.
  const run = async (btn, job) => {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    clearResults();
    try {
      const files = await job((t) => (status.textContent = t));
      status.textContent = "";
      showResults(files);
    } catch (e) {
      status.className = "error pdf-status";
      status.textContent = e?.message || String(e);
    } finally {
      busy = false;
      btn.disabled = false;
    }
  };

  // 파일 고르는 칸(눌러서 고르기, 끌어다 놓기).
  function picker(accept, multiple, text, onFiles) {
    const input = el("input", { type: "file", accept, multiple });
    input.onchange = () => {
      if (input.files.length && !busy) onFiles([...input.files]);
      input.value = "";
    };
    const zone = el("label", { className: "dropzone" }, input, icon("upload"), el("strong", { textContent: text }), el("span", { className: "muted small", textContent: "눌러서 고르거나 여기로 끌어다 놓으세요" }));
    zone.addEventListener("dragover", (ev) => {
      if (!ev.dataTransfer?.types.includes("Files")) return;
      ev.preventDefault();
      ev.stopPropagation(); // 클라우드 탭의 끌어다 놓기 처리가 막지 않게
      ev.dataTransfer.dropEffect = "copy";
      zone.classList.add("over");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("over"));
    zone.addEventListener("drop", (ev) => {
      zone.classList.remove("over");
      if (!ev.dataTransfer?.files.length) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (busy) return;
      const ok = [...ev.dataTransfer.files].filter((f) => accept.split(",").some((a) => (a.endsWith("/*") ? f.type.startsWith(a.slice(0, -1)) : f.type === a || f.name.toLowerCase().endsWith(a))));
      if (ok.length) onFiles(multiple ? ok : ok.slice(0, 1));
    });
    return zone;
  }

  // 순서를 바꿀 수 있는 파일 목록.
  function orderList(items, render, onChange) {
    const ul = el("ul", { className: "pdf-files" });
    const draw = () => {
      ul.replaceChildren(
        ...items.map((it, i) => {
          const move = (d) => () => {
            if (busy) return; // 처리 중에는 순서를 못 바꾼다
            [items[i], items[i + d]] = [items[i + d], items[i]];
            onChange();
          };
          const b = (label, name, fn, off) => el("button", { className: "btn ghost sm", type: "button", title: label, ariaLabel: label, disabled: off, onclick: fn }, icon(name));
          return el("li", {}, el("span", { className: "num muted", textContent: i + 1 }), ...render(it), b("위로", "up", move(-1), i === 0), b("아래로", "down", move(1), i === items.length - 1), b("빼기", "x", () => busy || (items.splice(i, 1), onChange())));
        }),
      );
    };
    return { ul, draw };
  }

  const pdfOnly = "application/pdf,.pdf";
  const panes = {
    split() {
      let file = null;
      let pages = 0;
      const info = el("p", { className: "muted" });
      const by = el("select", { className: "input" }, el("option", { value: "ranges", textContent: "쪽 범위로" }), el("option", { value: "every", textContent: "몇 쪽마다" }), el("option", { value: "size", textContent: "용량으로" }));
      const ranges = el("input", { className: "input grow", placeholder: "예: 1-3, 5, 8-10  (쉼표로 나눈 묶음마다 파일 하나)" });
      const every = el("input", { className: "input", type: "number", min: 1, value: 10 });
      const mb = el("input", { className: "input", type: "number", min: 1, value: 20 });
      const opt = el("div", { className: "pdf-opt" });
      const showOpt = () => opt.replaceChildren(by.value === "ranges" ? ranges : by.value === "every" ? el("label", { className: "inline" }, every, "쪽마다 나누기") : el("label", { className: "inline" }, "파일 하나에 최대", mb, "MB"));
      by.onchange = showOpt;
      showOpt();
      const go = el("button", { className: "btn primary", type: "button", disabled: true }, "나누기");
      go.onclick = () => run(go, async (p) => splitPdf(new Uint8Array(await file.arrayBuffer()), file.name, { by: by.value, text: ranges.value, n: every.value, mb: mb.value }, p));
      const zone = picker(pdfOnly, false, "PDF 파일 하나 고르기", async ([f]) => {
        clearResults();
        info.textContent = `${f.name} · 읽는 중…`;
        go.disabled = true;
        try {
          pages = (await openPdf(new Uint8Array(await f.arrayBuffer()))).getPageCount();
          file = f;
          info.textContent = `${f.name} · ${pages}쪽 · ${sizeText(f.size)}`;
          go.disabled = false;
        } catch (e) {
          file = null;
          info.textContent = "";
          status.className = "error pdf-status";
          status.textContent = e.message;
        }
      });
      return [zone, info, el("div", { className: "pdf-row" }, by, opt), el("div", { className: "pdf-row" }, go)];
    },

    merge() {
      const items = [];
      const go = el("button", { className: "btn primary", type: "button", disabled: true }, "합치기");
      const list = orderList(items, (f) => [el("span", { className: "name", textContent: f.name }), el("span", { className: "muted", textContent: sizeText(f.size) })], () => (list.draw(), (go.disabled = items.length < 2)));
      go.onclick = () => {
        const files = items.slice(); // 누른 때의 순서 그대로
        run(go, async (p) => [{ name: `${baseName(files[0].name)}_합본.pdf`, blob: await mergePdfs(files, p) }]);
      };
      const zone = picker(pdfOnly, true, "PDF 파일 여러 개 고르기", (fs) => (items.push(...fs), list.draw(), (go.disabled = items.length < 2)));
      return [zone, list.ul, el("p", { className: "muted small", textContent: "위에서부터 차례로 이어 붙입니다. ↑↓로 순서를 바꾸세요." }), el("div", { className: "pdf-row" }, go)];
    },

    images() {
      const items = []; // { file, url }
      const fit = el("select", { className: "input" }, el("option", { value: "image", textContent: "사진 크기 그대로" }), el("option", { value: "a4", textContent: "A4 (여백 있음)" }), el("option", { value: "a4-full", textContent: "A4 (여백 없이)" }));
      const go = el("button", { className: "btn primary", type: "button", disabled: true }, "PDF 만들기");
      const list = orderList(
        items,
        (it) => [el("img", { className: "thumb", src: it.url, alt: "" }), el("span", { className: "name", textContent: it.file.name }), el("span", { className: "muted", textContent: sizeText(it.file.size) })],
        () => {
          list.draw();
          go.disabled = !items.length;
        },
      );
      // 뺀 사진의 미리 보기 주소는 목록을 다시 그릴 때 정리한다.
      const draw = list.draw;
      let shown = [];
      list.draw = () => {
        shown.filter((u) => !items.some((it) => it.url === u)).forEach((u) => URL.revokeObjectURL(u));
        shown = items.map((it) => it.url);
        draw();
      };
      go.onclick = () => run(go, async (p) => [{ name: `${baseName(items[0].file.name)}${items.length > 1 ? ` 외 ${items.length - 1}장` : ""}.pdf`, blob: await imagesToPdf(items.map((it) => it.file), fit.value, p) }]);
      const zone = picker("image/*", true, "사진 여러 장 고르기 (JPG·PNG 등)", (fs) => {
        items.push(...fs.map((file) => ({ file, url: URL.createObjectURL(file) })));
        list.draw();
        go.disabled = false;
      });
      return [zone, list.ul, el("div", { className: "pdf-row" }, el("label", { className: "inline" }, "쪽 크기", fit), go)];
    },

    toimg() {
      let file = null;
      const info = el("p", { className: "muted" });
      const format = el("select", { className: "input" }, el("option", { value: "png", textContent: "PNG" }), el("option", { value: "jpg", textContent: "JPG (용량 작게)" }));
      const dpi = el("select", { className: "input" }, el("option", { value: 96, textContent: "보통 (96dpi)" }), el("option", { value: 150, textContent: "선명하게 (150dpi)", selected: true }), el("option", { value: 300, textContent: "아주 선명하게 (300dpi)" }));
      const ranges = el("input", { className: "input grow", placeholder: "쪽 범위 (비워 두면 전체) 예: 1-3, 7" });
      const go = el("button", { className: "btn primary", type: "button", disabled: true }, "그림으로 바꾸기");
      go.onclick = () => run(go, async (p) => pdfToImages(new Uint8Array(await file.arrayBuffer()), file.name, { format: format.value, dpi: Number(dpi.value), rangeText: ranges.value }, p));
      const zone = picker(pdfOnly, false, "PDF 파일 하나 고르기", ([f]) => {
        clearResults();
        file = f;
        info.textContent = `${f.name} · ${sizeText(f.size)}`;
        go.disabled = false;
      });
      return [zone, info, el("div", { className: "pdf-row" }, format, dpi, ranges), el("div", { className: "pdf-row" }, go)];
    },
  };

  const built = {};
  const tabs = [
    ["split", "PDF 나누기"],
    ["merge", "PDF 합치기"],
    ["images", "이미지 → PDF"],
    ["toimg", "PDF → 이미지"],
  ];
  const seg = el("div", { className: "seg pdf-seg" });
  const show = (key) => {
    if (busy) return;
    clearResults();
    seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === key));
    built[key] ??= el("div", { className: "pdf-pane-body" }, ...panes[key]());
    pane.replaceChildren(built[key]);
  };
  for (const [key, label] of tabs) {
    const b = el("button", { type: "button", textContent: label, onclick: () => show(key) });
    b.dataset.v = key;
    seg.append(b);
  }
  root.replaceChildren(
    el("div", { className: "toolbar" }, seg, el("span", { className: "grow" }), el("span", { className: "muted small", textContent: "파일은 이 기기 안에서만 처리되고 어디에도 올라가지 않습니다." })),
    el("div", { className: "pdf-body" }, pane, status, results),
  );
  show("split");
}

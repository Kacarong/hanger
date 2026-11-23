// 파일 편집기(public/pdftools.js)의 PDF·이미지 처리. 화면 없이 bun에서 실제 pdf-lib로 돌린다.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore 브라우저용 JS 모듈
import { imagesToPdf, jpegOrientation, mergePdfs, parseRanges, splitPdf, zip } from "../public/pdftools.js";
// @ts-ignore
import { PDFDocument, StandardFonts } from "../public/vendor/pdf-lib.min.js";

// 쪽마다 번호를 적은 PDF. big이면 쪽마다 겹치지 않는 긴 글을 넣어 용량을 키운다.
async function makePdf(n: number, size: [number, number] = [300, 400], big = false) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= n; i++) {
    const page = doc.addPage(size);
    page.drawText(`page ${i}`, { x: 20, y: 20, font, size: 12 });
    if (big) for (let k = 0; k < 400; k++) page.drawText(`${i}-${k}-${Math.random()}`, { x: 10, y: (k % 300) + 30, font, size: 4 });
  }
  return doc.save();
}
const pagesOf = async (blob: Blob) => (await PDFDocument.load(new Uint8Array(await blob.arrayBuffer()))).getPageCount();
// 각 쪽에 적은 "page N"으로 순서를 확인한다(쪽 크기를 다르게 줘서 구분).
const widths = async (blob: Blob) => (await PDFDocument.load(new Uint8Array(await blob.arrayBuffer()))).getPages().map((p: any) => Math.round(p.getWidth()));

test("쪽 범위 읽기", () => {
  expect(parseRanges("1-3, 5, 8-", 10)).toEqual([[0, 1, 2], [4], [7, 8, 9]]);
  expect(parseRanges("-2,10", 10)).toEqual([[0, 1], [9]]);
  expect(parseRanges("2~3", 10)).toEqual([[1, 2]]);
  expect(() => parseRanges("3-1", 10)).toThrow("1~10쪽");
  expect(() => parseRanges("11", 10)).toThrow("1~10쪽");
  expect(() => parseRanges("a", 10)).toThrow("쪽 범위가 아닙니다");
  expect(() => parseRanges(" , ", 10)).toThrow("쪽 범위를 적어 주세요");
});

test("PDF 나누기: 쪽 범위, 몇 쪽마다", async () => {
  const pdf = await makePdf(12);
  const byRange = await splitPdf(pdf, "보고서.pdf", { by: "ranges", text: "1-3, 5, 10-" });
  expect(byRange.map((f: any) => f.name)).toEqual(["보고서_1-3.pdf", "보고서_5.pdf", "보고서_10-12.pdf"]);
  expect(await Promise.all(byRange.map((f: any) => pagesOf(f.blob)))).toEqual([3, 1, 3]);

  const every = await splitPdf(pdf, "a.pdf", { by: "every", n: "5" });
  expect(every.map((f: any) => f.name)).toEqual(["a_1-5.pdf", "a_6-10.pdf", "a_11-12.pdf"]);
  await expect(splitPdf(pdf, "a.pdf", { by: "every", n: "0" })).rejects.toThrow("1 이상");
});

test("PDF 나누기: 용량으로 — 모든 쪽이 순서대로 한 번씩, 조각마다 기준 이하", async () => {
  const pdf = await makePdf(10, [300, 400], true);
  const limit = pdf.length / 3 / 1024 / 1024; // 대략 서너 조각
  const parts = await splitPdf(pdf, "big.pdf", { by: "size", mb: String(limit) });
  expect(parts.length).toBeGreaterThan(2);
  for (const p of parts) expect(p.blob.size).toBeLessThanOrEqual(limit * 1024 * 1024);
  expect((await Promise.all(parts.map((p: any) => pagesOf(p.blob)))).reduce((a: number, b: number) => a + b, 0)).toBe(10);
  const nums = parts.map((p: any) => p.name.match(/_(\d+)(?:-(\d+))?\.pdf$/).slice(1).filter(Boolean).map(Number));
  expect(nums[0][0]).toBe(1);
  for (let i = 1; i < nums.length; i++) expect(nums[i][0]).toBe(nums[i - 1].at(-1) + 1);
  expect(nums.at(-1).at(-1)).toBe(10);
});

test("PDF 합치기: 고른 순서대로 이어 붙임", async () => {
  const a = await makePdf(2, [100, 100]);
  const b = await makePdf(3, [200, 100]);
  const out = await mergePdfs([{ name: "b.pdf", bytes: b }, { name: "a.pdf", bytes: a }]);
  expect(await widths(out)).toEqual([200, 200, 200, 100, 100]);
  await expect(mergePdfs([{ name: "깨진.pdf", bytes: new Uint8Array([1, 2, 3]) }])).rejects.toThrow("깨진.pdf");
});

const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAEAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDgKKKK+eP2E//Z", "base64");
// 같은 그림에 EXIF 방향값 6(시계 방향 90도)을 붙인 것.
const exif = Buffer.from("ffe100224578696600004d4d002a00000008000101120003000000010006000000000000", "hex");
const ROTATED = Buffer.concat([JPEG.subarray(0, 2), exif, JPEG.subarray(2)]);

test("JPEG 방향값 읽기", () => {
  expect(jpegOrientation(new Uint8Array(JPEG))).toBe(1);
  expect(jpegOrientation(new Uint8Array(ROTATED))).toBe(6);
  const le = Buffer.from(ROTATED);
  le.set(Buffer.from("49492a0008000000010012010300010000000600", "hex"), 2 + 10); // 같은 내용을 리틀 엔디언으로
  expect(jpegOrientation(new Uint8Array(le))).toBe(6);
  expect(jpegOrientation(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(1);
  expect(jpegOrientation(new Uint8Array(ROTATED.subarray(0, 20)))).toBe(1); // 잘린 파일
});

test("이미지 → PDF: 고른 순서대로 한 장씩, 사진 크기 그대로 또는 A4", async () => {
  const png = Bun.file(join(import.meta.dir, "..", "public", "icon-192.png"));
  const jpg = new File([JPEG], "사진.jpg", { type: "image/jpeg" });
  const asIs = await imagesToPdf([jpg, png], "image");
  expect(await widths(asIs)).toEqual([8, 192]);
  const a4 = await imagesToPdf([jpg, png], "a4");
  // 가로 사진은 A4 가로, 정사각형은 A4 세로
  expect(await widths(a4)).toEqual([842, 595]);
});

test("ZIP: 한글 이름 그대로, 내용이 맞게 풀림", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pdftools-"));
  try {
    const z = await zip([
      { name: "보고서_1-3.pdf", blob: new Blob(["첫째"]) },
      { name: "b.png", blob: new Blob([new Uint8Array(70000).map((_, i) => i % 251)]) },
    ]);
    const path = join(dir, "t.zip");
    writeFileSync(path, new Uint8Array(await z.arrayBuffer()));
    const t = Bun.spawnSync(["unzip", "-t", path]);
    expect(t.exitCode).toBe(0);
    expect(Bun.spawnSync(["unzip", "-Z1", path]).stdout.toString().trim().split("\n")).toEqual(["보고서_1-3.pdf", "b.png"]);
    expect(Bun.spawnSync(["unzip", "-p", path, "보고서_1-3.pdf"]).stdout.toString()).toBe("첫째");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

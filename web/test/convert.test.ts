// 문서 변환(src/convert.ts): 실제 LibreOffice로 변환해 본다. soffice가 없는 곳에서는 건너뛴다.
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertFile, convertTarget } from "../src/convert";

test("변환할 형식 고르기", () => {
  expect(convertTarget("보고서.HWP")).toBe("pdf");
  expect(convertTarget("a.docx")).toBe("pdf");
  expect(convertTarget("a.pptx")).toBe("pdf");
  expect(convertTarget("scan.pdf")).toBe("docx");
  expect(convertTarget("a.exe")).toBeNull();
  expect(convertTarget("pdf")).toBeNull();
});

test.skipIf(!Bun.which("soffice"))("파워포인트 → PDF, 작업 폴더는 남지 않음", async () => {
  const dir = mkdtempSync(join(tmpdir(), "convert-"));
  try {
    const pptx = new Uint8Array(await Bun.file(join(import.meta.dir, "fixtures", "slide.pptx")).arrayBuffer());
    const pdf = await convertFile(pptx, "발표.pptx", dir);
    expect(new TextDecoder().decode(pdf.subarray(0, 5))).toBe("%PDF-");
    expect(readdirSync(dir).filter((n) => n.startsWith("job-"))).toEqual([]);
    await expect(convertFile(new Uint8Array([1, 2, 3]), "깨진.pptx", dir)).rejects.toThrow("변환하지 못했습니다");
    expect(readdirSync(dir).filter((n) => n.startsWith("job-"))).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

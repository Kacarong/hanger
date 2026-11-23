// 문서 변환: LibreOffice(soffice)로 오피스·한글 문서 → PDF, PDF → Word.
// 사이트는 격리(Landlock, 유닉스 소켓 금지) 안에서 돌아 soffice를 띄울 수 없다(soffice는 /tmp에 유닉스 소켓을 만든다).
// 그래서 따로 도는 변환 서버(convert-main.ts)가 변환하고, 사이트는 /api/convert로 받은 파일을 넘기기만 한다.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { extname, join } from "node:path";

const TO_PDF = ["doc", "docx", "odt", "rtf", "txt", "hwp", "xls", "xlsx", "ods", "csv", "ppt", "pptx", "odp"];
export const CONVERT_MAX = 100 * 1024 * 1024; // Cloudflare가 받아 주는 요청 크기(무료 요금제 100MB)
// Cloudflare는 서버가 100초 안에 답하지 않으면 끊는다(524). 그 전에 멈추고 이유를 알려 준다.
export const CONVERT_TIMEOUT = 90_000;

// 입력 파일 이름 → 결과 형식. PDF는 Word로, 나머지 문서는 PDF로. 못 하면 null.
export function convertTarget(name: string): "pdf" | "docx" | null {
  const ext = extname(name).slice(1).toLowerCase();
  if (ext === "pdf") return "docx";
  return TO_PDF.includes(ext) ? "pdf" : null;
}

// 한 번에 하나씩 부를 것(LibreOffice 프로필 하나를 같이 쓴다). 작업 폴더는 끝나면 바로 지운다.
export async function convertFile(input: Uint8Array, name: string, workDir: string, timeoutMs = CONVERT_TIMEOUT): Promise<Uint8Array<ArrayBuffer>> {
  const to = convertTarget(name);
  if (!to) throw new Error("이 형식은 변환할 수 없습니다");
  const job = join(workDir, "job-" + randomUUID());
  mkdirSync(job, { recursive: true });
  try {
    const src = join(job, "in" + extname(name).toLowerCase());
    await Bun.write(src, input);
    // setsid: soffice가 띄우는 하위 프로세스까지 한 묶음으로 끝낼 수 있게.
    const proc = Bun.spawn(
      [
        "setsid",
        "soffice",
        `-env:UserInstallation=file://${join(workDir, "profile")}`,
        "--headless",
        "--norestore",
        ...(to === "docx" ? ["--infilter=writer_pdf_import", "--convert-to", "docx:MS Word 2007 XML"] : ["--convert-to", "pdf"]),
        "--outdir",
        job,
        src,
      ],
      { env: { ...process.env, HOME: workDir, TMPDIR: job }, stdout: "pipe", stderr: "pipe" },
    );
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {}
    }, timeoutMs);
    const log = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    await proc.exited;
    clearTimeout(timer);
    const out = join(job, "in." + to);
    if (timedOut) throw new Error(`변환이 ${timeoutMs / 1000}초 안에 끝나지 않아 멈췄습니다`);
    if (!existsSync(out)) {
      console.error("soffice:", log.trim());
      throw new Error("변환하지 못했습니다. 파일이 깨졌거나, 서버의 LibreOffice에 이 형식을 여는 부분이 없습니다.");
    }
    return new Uint8Array(readFileSync(out));
  } finally {
    rmSync(job, { recursive: true, force: true });
  }
}

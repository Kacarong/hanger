// Sets the owner password: `bun run set-password` then type it (read from stdin).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "./db";
import { MIN_PASSWORD_LENGTH, passwordProblem } from "./password";

const dataDir = process.env.DATA_DIR ?? join(import.meta.dir, "..", "data");
mkdirSync(dataDir, { recursive: true });

process.stdout.write(`새 비밀번호 (${MIN_PASSWORD_LENGTH}자 이상): `);
let password = "";
for await (const line of console) {
  password = line.trim();
  break;
}
const problem = passwordProblem(password);
if (problem) {
  console.error(`\n${problem}.`);
  process.exit(1);
}
const db = openDb(join(dataDir, "folio.db"));
db.setSetting("password_hash", await Bun.password.hash(password));
db.raw.query("DELETE FROM sessions").run(); // log out everywhere
console.log("\n비밀번호를 설정했습니다. 기존 로그인은 모두 해제했습니다.");

import type { Db } from "./db";
import type { Google } from "./google";

const KEEP = 14; // days of backups kept in Drive
// Hours (Korea) when no backup starts: the host's quiet hours, 02:00-07:00.
const QUIET = (h: number) => h >= 2 && h < 7;

const seoul = (d: Date) => {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const v = (t: string) => p.find((x) => x.type === t)!.value;
  return { date: `${v("year")}-${v("month")}-${v("day")}`, hour: Number(v("hour")) };
};

// Once a day, a copy of folio.db (notes, tasks, exams, studies, portfolio, settings) goes to the Drive folder
// "kacarong.kr 백업" as folio-YYYY-MM-DD.db; only the newest KEEP stay. Files in the cloud are in Drive already.
export function createBackup(opts: { db: Db; google: Google; enabled: boolean; origin: string; now: () => Date }) {
  const { db, google } = opts;
  let busy = false;

  // Uploading and pruning are marked done apart (backup_last, backup_pruned), so a failed prune is retried
  // the next hour without uploading the day's copy again.
  async function run(date: string) {
    const folder = await google.backupFolder();
    if (db.getSetting("backup_last") !== date) {
      // serialize() reads through the connection, so changes still in the WAL are in the copy.
      await google.upload(`folio-${date}.db`, "application/vnd.sqlite3", new Blob([new Uint8Array(db.raw.serialize())]), opts.origin, folder);
      db.setSetting("backup_last", date);
    }
    const files = (await google.list(folder)).filter((f) => /^folio-\d{4}-\d{2}-\d{2}\.db$/.test(f.name)).sort((a, b) => b.name.localeCompare(a.name));
    // Same-day duplicates count as one day; the extra copies go.
    const seen = new Set<string>();
    for (const f of files) {
      if (seen.size < KEEP && !seen.has(f.name)) seen.add(f.name);
      else await google.remove(f.id);
    }
    db.setSetting("backup_pruned", date);
  }

  async function tick() {
    if (busy || !opts.enabled || !db.getSetting("refresh_token")) return;
    const { date, hour } = seoul(opts.now());
    if (QUIET(hour) || (db.getSetting("backup_last") === date && db.getSetting("backup_pruned") === date)) return;
    busy = true;
    try {
      await run(date);
    } catch (e) {
      console.error("백업 실패(한 시간 뒤 다시):", e);
    } finally {
      busy = false;
    }
  }

  return {
    tick,
    start(intervalMs: number) {
      void tick();
      setInterval(() => void tick(), intervalMs);
    },
  };
}

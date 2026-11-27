import type { Db } from "./db";
import type { Google } from "./google";

const KEEP = 14; // days of backups kept in Drive
// Hours (Korea) when no backup starts: the host's quiet hours, 02:00-07:00.
const QUIET = (h: number) => h >= 2 && h < 7;
const NAME = /^folio-\d{4}-\d{2}-\d{2}\.db$/;

const seoul = (d: Date) => {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const v = (t: string) => p.find((x) => x.type === t)!.value;
  return { date: `${v("year")}-${v("month")}-${v("day")}`, hour: Number(v("hour")) };
};

export type BackupFile = { id: string; name: string; size: number; createdTime: string };

// Once a day, a copy of folio.db (notes, tasks, exams, studies, portfolio, settings) goes to the Drive folder
// "kacarong.kr 백업" as folio-YYYY-MM-DD.db; only the newest KEEP stay. Files in the cloud are in Drive already.
// The workspace shows how it went (backup_at = last upload, backup_error = the last failure since then) and the list.
export function createBackup(opts: { db: Db; google: Google; enabled: boolean; origin: string; now: () => Date }) {
  const { db, google } = opts;
  let busy = false;
  const on = () => opts.enabled && !!db.getSetting("refresh_token");

  // The day copies in the folder, newest first (a day copied twice: the later copy first).
  async function files(folder: string): Promise<BackupFile[]> {
    return (await google.list(folder))
      .filter((f) => NAME.test(f.name))
      .map((f) => ({ id: f.id, name: f.name, size: Number(f.size ?? 0), createdTime: f.createdTime ?? "" }))
      .sort((a, b) => b.name.localeCompare(a.name) || b.createdTime.localeCompare(a.createdTime));
  }

  // Uploading and pruning are marked done apart (backup_last, backup_pruned), so a failed prune is retried
  // the next hour without uploading the day's copy again. force: upload a new copy even if today's is up.
  async function run(date: string, force: boolean) {
    busy = true;
    try {
      const folder = await google.backupFolder();
      if (force || db.getSetting("backup_last") !== date) {
        // serialize() reads through the connection, so changes still in the WAL are in the copy.
        await google.upload(`folio-${date}.db`, "application/vnd.sqlite3", new Blob([new Uint8Array(db.raw.serialize())]), opts.origin, folder);
        db.setSetting("backup_last", date);
        db.setSetting("backup_at", opts.now().toISOString());
      }
      // Same-day duplicates count as one day; the older copies go.
      const seen = new Set<string>();
      for (const f of await files(folder)) {
        if (seen.size < KEEP && !seen.has(f.name)) seen.add(f.name);
        else await google.remove(f.id);
      }
      db.setSetting("backup_pruned", date);
      db.setSetting("backup_error", "");
    } catch (e) {
      db.setSetting("backup_error", JSON.stringify({ at: opts.now().toISOString(), message: e instanceof Error ? e.message : String(e) }));
      throw e;
    } finally {
      busy = false;
    }
  }

  async function tick() {
    if (busy || !on()) return;
    const { date, hour } = seoul(opts.now());
    if (QUIET(hour) || (db.getSetting("backup_last") === date && db.getSetting("backup_pruned") === date)) return;
    try {
      await run(date, false);
    } catch (e) {
      console.error("백업 실패(한 시간 뒤 다시):", e);
    }
  }

  return {
    tick,
    start(intervalMs: number) {
      void tick();
      setInterval(() => void tick(), intervalMs);
    },
    // "지금 백업" in the workspace: a fresh copy now, whatever the hour. false when one is already running.
    async runNow(): Promise<boolean> {
      if (busy) return false;
      await run(seoul(opts.now()).date, true);
      return true;
    },
    // What the workspace shows. listError: the list couldn't be read from Drive (the rest still shows).
    async status() {
      const error = db.getSetting("backup_error");
      const folder = db.getSetting("backup_folder_id");
      let list: BackupFile[] = [];
      let listError: string | null = null;
      if (on() && folder) {
        try {
          list = await files(folder);
        } catch (e) {
          listError = e instanceof Error ? e.message : String(e);
        }
      }
      return { on: on(), keep: KEEP, running: busy, last: db.getSetting("backup_last"), at: db.getSetting("backup_at"), error: error ? (JSON.parse(error) as { at: string; message: string }) : null, files: list, listError };
    },
    // A day copy from the backup folder, for "받기". null when the id isn't one of them.
    async file(id: string): Promise<BackupFile | null> {
      const folder = db.getSetting("backup_folder_id");
      if (!on() || !folder) return null;
      return (await files(folder)).find((f) => f.id === id) ?? null;
    },
  };
}

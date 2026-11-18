import { Database } from "bun:sqlite";

export type FileRow = {
  id: number;
  drive_id: string;
  name: string;
  title: string;
  mime: string;
  size: number;
  category: string;
  tags: string;
  note: string;
  shared: number;
  public: number;
  web_view_link: string;
  web_content_link: string;
  created_at: string;
};

export const CATEGORIES = ["포트폴리오", "플래닝", "작업", "과제", "기타"];

export function openDb(path: string) {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, email TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      drive_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      title TEXT NOT NULL,
      mime TEXT NOT NULL DEFAULT '',
      size INTEGER NOT NULL DEFAULT 0,
      category TEXT NOT NULL DEFAULT '기타',
      tags TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      shared INTEGER NOT NULL DEFAULT 0,
      public INTEGER NOT NULL DEFAULT 0,
      web_view_link TEXT NOT NULL DEFAULT '',
      web_content_link TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  return {
    raw: db,
    getSetting(key: string): string | null {
      const row = db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
      return row?.value ?? null;
    },
    setSetting(key: string, value: string) {
      db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
    },
    createSession(id: string, email: string, expiresAt: number) {
      db.query("INSERT INTO sessions (id, email, expires_at) VALUES (?, ?, ?)").run(id, email, expiresAt);
    },
    getSession(id: string): { email: string } | null {
      return db.query("SELECT email FROM sessions WHERE id = ? AND expires_at > ?").get(id, Date.now()) as { email: string } | null;
    },
    deleteSession(id: string) {
      db.query("DELETE FROM sessions WHERE id = ?").run(id);
    },
    listFiles(opts: { q?: string; category?: string; publicOnly?: boolean }): FileRow[] {
      const where: string[] = [];
      const args: string[] = [];
      if (opts.publicOnly) where.push("public = 1");
      if (opts.category) {
        where.push("category = ?");
        args.push(opts.category);
      }
      if (opts.q) {
        where.push("(title LIKE ? OR name LIKE ? OR tags LIKE ? OR note LIKE ?)");
        const like = `%${opts.q}%`;
        args.push(like, like, like, like);
      }
      const sql = `SELECT * FROM files ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC`;
      return db.query(sql).all(...args) as FileRow[];
    },
    getFile(id: number): FileRow | null {
      return db.query("SELECT * FROM files WHERE id = ?").get(id) as FileRow | null;
    },
    getFileByDriveId(driveId: string): FileRow | null {
      return db.query("SELECT * FROM files WHERE drive_id = ?").get(driveId) as FileRow | null;
    },
    insertFile(f: Omit<FileRow, "id" | "created_at" | "shared" | "public">): FileRow {
      return db
        .query(
          `INSERT INTO files (drive_id, name, title, mime, size, category, tags, note, web_view_link, web_content_link)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        )
        .get(f.drive_id, f.name, f.title, f.mime, f.size, f.category, f.tags, f.note, f.web_view_link, f.web_content_link) as FileRow;
    },
    updateFile(id: number, patch: Partial<Pick<FileRow, "title" | "category" | "tags" | "note" | "shared" | "public">>) {
      const keys = Object.keys(patch) as (keyof typeof patch)[];
      if (!keys.length) return;
      const sets = keys.map((k) => `${k} = ?`).join(", ");
      db.query(`UPDATE files SET ${sets} WHERE id = ?`).run(...keys.map((k) => patch[k] as string | number), id);
    },
    deleteFile(id: number) {
      db.query("DELETE FROM files WHERE id = ?").run(id);
    },
  };
}

export type Db = ReturnType<typeof openDb>;

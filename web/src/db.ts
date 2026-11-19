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

export type TaskRow = {
  id: number;
  kind: string; // TASK_KINDS
  title: string;
  course: string; // 과목, mainly for 과제
  due_date: string | null; // YYYY-MM-DD in Asia/Seoul
  due_time: string | null; // HH:MM
  note: string;
  done: number;
  done_at: string | null; // YYYY-MM-DD the task was checked off
  created_at: string;
  note_id: number | null; // set when the task is a dated checkbox inside a note
  block_id: string | null;
  note_title?: string | null; // joined in by listTasks/getTask
};

export const TASK_KINDS = ["할 일", "과제"];
export type TaskFields = Pick<TaskRow, "kind" | "title" | "course" | "due_date" | "due_time" | "note">;

// A note is a list of blocks. A "todo" block with a date is also a task (tasks.note_id/block_id),
// so it shows up on the today screen and the calendar.
export const BLOCK_TYPES = ["p", "h1", "h2", "h3", "todo", "bullet", "number", "quote", "code", "divider"];
export type Block = { id: string; type: string; text: string; checked?: boolean; date?: string; time?: string };
export type NoteRow = { id: number; title: string; blocks: Block[]; created_at: string; updated_at: string };
type NoteRecord = Omit<NoteRow, "blocks"> & { blocks: string };

// The task title of a todo block: its first line.
export const blockTitle = (b: Block) => b.text.split("\n")[0]!.trim().slice(0, 200);

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
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL DEFAULT '할 일',
      title TEXT NOT NULL,
      course TEXT NOT NULL DEFAULT '',
      due_date TEXT,
      due_time TEXT,
      note TEXT NOT NULL DEFAULT '',
      done INTEGER NOT NULL DEFAULT 0,
      done_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT '',
      blocks TEXT NOT NULL DEFAULT '[]',
      text TEXT NOT NULL DEFAULT '', -- all block text, for search
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const taskCols = (db.query("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name);
  if (!taskCols.includes("note_id")) db.exec("ALTER TABLE tasks ADD COLUMN note_id INTEGER; ALTER TABLE tasks ADD COLUMN block_id TEXT;");
  db.exec("CREATE INDEX IF NOT EXISTS tasks_note ON tasks (note_id)");
  const TASK_SELECT = "SELECT tasks.*, notes.title AS note_title FROM tasks LEFT JOIN notes ON notes.id = tasks.note_id";
  const TASK_ORDER = "ORDER BY due_date IS NULL, due_date, due_time IS NULL, due_time, tasks.id";
  function getNote(id: number): NoteRow | null {
    const r = db.query("SELECT id, title, blocks, created_at, updated_at FROM notes WHERE id = ?").get(id) as NoteRecord | null;
    return r ? { ...r, blocks: JSON.parse(r.blocks) as Block[] } : null;
  }

  // Makes the note's tasks match its dated todo blocks. Kind, course and memo set on the task stay.
  function syncNoteTasks(noteId: number, blocks: Block[], today: string) {
    const existing = new Map((db.query("SELECT * FROM tasks WHERE note_id = ?").all(noteId) as TaskRow[]).map((t) => [t.block_id, t]));
    for (const b of blocks) {
      const title = blockTitle(b);
      if (b.type !== "todo" || !b.date || !title) continue;
      const done = b.checked ? 1 : 0;
      const t = existing.get(b.id);
      existing.delete(b.id);
      if (!t) {
        db.query("INSERT INTO tasks (title, due_date, due_time, done, done_at, note_id, block_id) VALUES (?, ?, ?, ?, ?, ?, ?)").run(title, b.date, b.time ?? null, done, done ? today : null, noteId, b.id);
      } else {
        const doneAt = done === t.done ? t.done_at : done ? today : null;
        db.query("UPDATE tasks SET title = ?, due_date = ?, due_time = ?, done = ?, done_at = ? WHERE id = ?").run(title, b.date, b.time ?? null, done, doneAt, t.id);
      }
    }
    for (const t of existing.values()) db.query("DELETE FROM tasks WHERE id = ?").run(t.id);
  }

  function writeNote(id: number, title: string, blocks: Block[], today: string) {
    const text = blocks.map((b) => b.text).join("\n");
    db.query("UPDATE notes SET title = ?, blocks = ?, text = ?, updated_at = datetime('now') WHERE id = ?").run(title, JSON.stringify(blocks), text, id);
    syncNoteTasks(id, blocks, today);
  }

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
    deleteOtherSessions(keepId: string) {
      db.query("DELETE FROM sessions WHERE id != ?").run(keepId);
    },
    deleteExpiredSessions() {
      db.query("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
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
    // from/to are inclusive YYYY-MM-DD bounds on due_date; a bound excludes undated tasks.
    listTasks(opts: { done?: boolean; from?: string; to?: string; kind?: string; doneOn?: string }): TaskRow[] {
      const where: string[] = [];
      const args: (string | number)[] = [];
      if (opts.done !== undefined) {
        where.push("done = ?");
        args.push(opts.done ? 1 : 0);
      }
      if (opts.from) {
        where.push("due_date >= ?");
        args.push(opts.from);
      }
      if (opts.to) {
        where.push("due_date <= ?");
        args.push(opts.to);
      }
      if (opts.kind) {
        where.push("kind = ?");
        args.push(opts.kind);
      }
      if (opts.doneOn) {
        where.push("done_at = ?");
        args.push(opts.doneOn);
      }
      const sql = `${TASK_SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""} ${TASK_ORDER}`;
      return db.query(sql).all(...args) as TaskRow[];
    },
    getTask(id: number): TaskRow | null {
      return db.query(`${TASK_SELECT} WHERE tasks.id = ?`).get(id) as TaskRow | null;
    },
    insertTask(t: TaskFields): TaskRow {
      return db
        .query("INSERT INTO tasks (kind, title, course, due_date, due_time, note) VALUES (?, ?, ?, ?, ?, ?) RETURNING *")
        .get(t.kind, t.title, t.course, t.due_date, t.due_time, t.note) as TaskRow;
    },
    updateTask(id: number, patch: Partial<TaskFields & Pick<TaskRow, "done" | "done_at">>) {
      const keys = Object.keys(patch) as (keyof typeof patch)[];
      if (!keys.length) return;
      const sets = keys.map((k) => `${k} = ?`).join(", ");
      db.query(`UPDATE tasks SET ${sets} WHERE id = ?`).run(...keys.map((k) => patch[k] ?? null), id);
    },
    deleteTask(id: number) {
      db.query("DELETE FROM tasks WHERE id = ?").run(id);
    },
    listNotes(q?: string): Pick<NoteRow, "id" | "title" | "updated_at">[] {
      const like = `%${q ?? ""}%`;
      return db.query("SELECT id, title, updated_at FROM notes WHERE ? = '' OR title LIKE ? OR text LIKE ? ORDER BY updated_at DESC, id DESC").all(q ?? "", like, like) as Pick<NoteRow, "id" | "title" | "updated_at">[];
    },
    getNote,
    insertNote: db.transaction((title: string, blocks: Block[], today: string): NoteRow => {
      const id = (db.query("INSERT INTO notes (title) VALUES (?) RETURNING id").get(title) as { id: number }).id;
      writeNote(id, title, blocks, today);
      return getNote(id)!;
    }),
    saveNote: db.transaction((id: number, title: string, blocks: Block[], today: string) => writeNote(id, title, blocks, today)),
    // Applies a change made from the task side (today screen, task dialog) to its block.
    // edit returns the new block, or null to drop the block.
    editNoteBlock: db.transaction((noteId: number, blockId: string, edit: (b: Block) => Block | null, today: string) => {
      const n = getNote(noteId);
      if (!n) return;
      const blocks = n.blocks.flatMap((b) => (b.id !== blockId ? [b] : (edit(b) ?? [])));
      writeNote(noteId, n.title, blocks, today);
    }),
    deleteNote: db.transaction((id: number) => {
      db.query("DELETE FROM tasks WHERE note_id = ?").run(id);
      db.query("DELETE FROM notes WHERE id = ?").run(id);
    }),
  };
}

export type Db = ReturnType<typeof openDb>;

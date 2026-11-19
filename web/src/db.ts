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
  files?: number; // how many cloud files are attached, joined in by listTasks/getTask
};

export const TASK_KINDS = ["할 일", "과제"];
export type TaskFields = Pick<TaskRow, "kind" | "title" | "course" | "due_date" | "due_time" | "note">;

// A note is a list of blocks. A "todo" block with a date is also a task (tasks.note_id/block_id),
// so it shows up on the today screen and the calendar.
export const BLOCK_TYPES = ["p", "h1", "h2", "h3", "todo", "bullet", "number", "quote", "code", "divider"];
export const NOTE_MAX_BLOCKS = 3000;
export const NOTE_MAX_TEXT = 500_000; // characters across all blocks of a note
export type Block = { id: string; type: string; text: string; checked?: boolean; date?: string; time?: string };
// version goes up on every write; a save must name the version it started from (see saveNote).
export type NoteRow = { id: number; title: string; blocks: Block[]; version: number; created_at: string; updated_at: string };
type NoteRecord = Omit<NoteRow, "blocks"> & { blocks: string };

// A cloud file attached to a note or a task. The file itself stays in the 파일함; detaching only drops the link.
export const ATTACH_TARGETS = ["note", "task"] as const;
export type AttachTarget = (typeof ATTACH_TARGETS)[number];
export type AttachedFile = FileRow & { attachment_id: number };

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
    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target TEXT NOT NULL CHECK (target IN ('note', 'task')),
      target_id INTEGER NOT NULL,
      file_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (target, target_id, file_id)
    );
    -- Whatever removes a note, task or file (including tasks a note save drops) also drops its attachments.
    -- What the Notion import brought in, so running it again updates instead of duplicating.
    -- version is the note version right after the import: a different one means it was edited here since.
    -- kids: the child pages ("page:<id>") and databases ("db:<id>") found in it, so an unchanged page still leads to them.
    -- edited is '' when some file of the page failed to copy, so the next run reads the page again.
    CREATE TABLE IF NOT EXISTS notion_pages (page_id TEXT PRIMARY KEY, note_id INTEGER NOT NULL, edited TEXT NOT NULL, version INTEGER NOT NULL);
    -- key: a file block id, or "<page id>:<property id>:<n>" for a file in a database column.
    -- source: the Notion file address without its signature; a new one means the file was replaced.
    CREATE TABLE IF NOT EXISTS notion_files (block_id TEXT PRIMARY KEY, file_id INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS attachments_note_gone AFTER DELETE ON notes BEGIN
      DELETE FROM attachments WHERE target = 'note' AND target_id = old.id;
    END;
    CREATE TRIGGER IF NOT EXISTS attachments_task_gone AFTER DELETE ON tasks BEGIN
      DELETE FROM attachments WHERE target = 'task' AND target_id = old.id;
    END;
    CREATE TRIGGER IF NOT EXISTS attachments_file_gone AFTER DELETE ON files BEGIN
      DELETE FROM attachments WHERE file_id = old.id;
    END;
  `);
  const taskCols = (db.query("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name);
  if (!taskCols.includes("note_id")) db.exec("ALTER TABLE tasks ADD COLUMN note_id INTEGER; ALTER TABLE tasks ADD COLUMN block_id TEXT;");
  db.exec("CREATE INDEX IF NOT EXISTS tasks_note ON tasks (note_id)");
  const noteCols = (db.query("PRAGMA table_info(notes)").all() as { name: string }[]).map((c) => c.name);
  if (!noteCols.includes("version")) db.exec("ALTER TABLE notes ADD COLUMN version INTEGER NOT NULL DEFAULT 0");
  const notionCols = (db.query("PRAGMA table_info(notion_pages)").all() as { name: string }[]).map((c) => c.name);
  if (!notionCols.includes("kids")) db.exec("ALTER TABLE notion_pages ADD COLUMN kids TEXT NOT NULL DEFAULT '[]'");
  const notionFileCols = (db.query("PRAGMA table_info(notion_files)").all() as { name: string }[]).map((c) => c.name);
  if (!notionFileCols.includes("source")) db.exec("ALTER TABLE notion_files ADD COLUMN source TEXT NOT NULL DEFAULT ''");
  const TASK_SELECT = `SELECT tasks.*, notes.title AS note_title,
    (SELECT COUNT(*) FROM attachments WHERE target = 'task' AND target_id = tasks.id) AS files
    FROM tasks LEFT JOIN notes ON notes.id = tasks.note_id`;
  const TASK_ORDER = "ORDER BY due_date IS NULL, due_date, due_time IS NULL, due_time, tasks.id";
  function getNote(id: number): NoteRow | null {
    const r = db.query("SELECT id, title, blocks, version, created_at, updated_at FROM notes WHERE id = ?").get(id) as NoteRecord | null;
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
    db.query("UPDATE notes SET title = ?, blocks = ?, text = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?").run(title, JSON.stringify(blocks), text, id);
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
    // Refuses (returns false) when the note changed since `version`, e.g. a task of it was checked
    // off in another tab; writing anyway would undo that.
    saveNote: db.transaction((id: number, version: number, title: string, blocks: Block[], today: string): boolean => {
      if (getNote(id)?.version !== version) return false;
      writeNote(id, title, blocks, today);
      return true;
    }),
    // Applies a change made from the task side (today screen, task dialog) to its block.
    // edit returns the new block, or null to drop the block.
    editNoteBlock: db.transaction((noteId: number, blockId: string, edit: (b: Block) => Block | null, today: string) => {
      const n = getNote(noteId);
      if (!n) return;
      const blocks = n.blocks.flatMap((b) => (b.id !== blockId ? [b] : (edit(b) ?? [])));
      writeNote(noteId, n.title, blocks, today);
    }),
    listAttachments(target: AttachTarget, targetId: number): AttachedFile[] {
      return db
        .query("SELECT files.*, attachments.id AS attachment_id FROM attachments JOIN files ON files.id = attachments.file_id WHERE target = ? AND target_id = ? ORDER BY attachments.id")
        .all(target, targetId) as AttachedFile[];
    },
    // Returns false when the file is already attached there.
    addAttachment(target: AttachTarget, targetId: number, fileId: number): boolean {
      return db.query("INSERT OR IGNORE INTO attachments (target, target_id, file_id) VALUES (?, ?, ?)").run(target, targetId, fileId).changes > 0;
    },
    deleteAttachment(id: number): boolean {
      return db.query("DELETE FROM attachments WHERE id = ?").run(id).changes > 0;
    },
    // Notion import: dates come from Notion so the list keeps Notion's order.
    setNoteTimes(id: number, created: string, updated: string) {
      db.query("UPDATE notes SET created_at = ?, updated_at = ? WHERE id = ?").run(created, updated, id);
    },
    notionPage(pageId: string): { note_id: number; edited: string; version: number; kids: string[] } | null {
      const r = db.query("SELECT note_id, edited, version, kids FROM notion_pages WHERE page_id = ?").get(pageId) as { note_id: number; edited: string; version: number; kids: string } | null;
      return r ? { ...r, kids: JSON.parse(r.kids) as string[] } : null;
    },
    setNotionPage(pageId: string, noteId: number, edited: string, version: number, kids: string[]) {
      db.query("INSERT OR REPLACE INTO notion_pages (page_id, note_id, edited, version, kids) VALUES (?, ?, ?, ?, ?)").run(pageId, noteId, edited, version, JSON.stringify(kids));
    },
    // The 파일함 copy of a Notion file, if it is still there.
    notionFile(key: string): (FileRow & { source: string }) | null {
      return db.query("SELECT files.*, notion_files.source FROM notion_files JOIN files ON files.id = notion_files.file_id WHERE block_id = ?").get(key) as (FileRow & { source: string }) | null;
    },
    setNotionFile(key: string, fileId: number, source: string) {
      db.query("INSERT OR REPLACE INTO notion_files (block_id, file_id, source) VALUES (?, ?, ?)").run(key, fileId, source);
    },
    // Attachments of a note that the Notion import made (the file is a Notion copy).
    notionAttachments(noteId: number): { id: number; file_id: number }[] {
      return db
        .query("SELECT attachments.id, attachments.file_id FROM attachments WHERE target = 'note' AND target_id = ? AND file_id IN (SELECT file_id FROM notion_files)")
        .all(noteId) as { id: number; file_id: number }[];
    },
    deleteNote: db.transaction((id: number) => {
      db.query("DELETE FROM tasks WHERE note_id = ?").run(id);
      db.query("DELETE FROM notes WHERE id = ?").run(id);
    }),
  };
}

export type Db = ReturnType<typeof openDb>;

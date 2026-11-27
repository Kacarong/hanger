import { Database } from "bun:sqlite";
import { blockTitle, type Block } from "./blocks";

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
  folder_id: number | null; // NULL = the top of the cloud
  // '' = a file uploaded to the cloud. 'notion' = the copy of a file in a Notion page: it shows in its note
  // but is not one of the cloud's files (the cloud lists, counts and picks only its own uploads).
  origin: string;
  sort: number; // place among the folders and files of its folder, smallest first (cloud uploads only)
  // shared/public/web_*_link are left over from when files were shared through Drive links; nothing reads them now.
  shared: number;
  public: number;
  web_view_link: string;
  web_content_link: string;
  created_at: string;
};

// A cloud folder. Each one has a matching folder in Drive (drive_id) so the Drive copy keeps the same layout.
export type FolderRow = { id: number; name: string; parent_id: number | null; drive_id: string; sort: number; created_at: string };
// One thing in a cloud folder, for putting the folder in order.
export type CloudItem = { type: "folder" | "file"; id: number };

export const CATEGORIES = ["포트폴리오", "플래닝", "작업", "과제", "기타"];

export type TaskRow = {
  id: number;
  kind: string; // TASK_KINDS
  category: string; // TASK_CATEGORIES, or "" for 분류 없음
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
  study_id: number | null; // set when the task is a 공부 tab entry whose day has come (see queueStudies)
  note_title?: string | null; // joined in by listTasks/getTask
  files?: number; // how many cloud files are attached, joined in by listTasks/getTask
};

export const TASK_KINDS = ["할 일", "과제", "공부"];
// The 할 일·과제 tab groups tasks by these; a task may have none ("").
export const TASK_CATEGORIES = ["오늘 할 일", "꾸준히 할 일", "나중에 할 일"];
export type TaskFields = Pick<TaskRow, "kind" | "category" | "title" | "course" | "due_date" | "due_time" | "note">;

// An exam on the 시험 tab.
export type ExamRow = {
  id: number;
  title: string;
  course: string;
  date: string | null; // YYYY-MM-DD, null = not fixed yet
  time: string | null; // HH:MM
  place: string;
  scope: string; // 시험 범위
  note: string;
  color: string; // card color, one of EXAM_COLORS ('' = none)
  created_at: string;
};
export type ExamFields = Pick<ExamRow, "title" | "course" | "date" | "time" | "place" | "scope" | "note" | "color">;
export const EXAM_COLORS = ["", "red", "orange", "amber", "green", "blue", "purple", "pink"];

// A line of a course's study list on the 공부 tab, with the day to do it (null = not decided yet). Kept apart from
// tasks so it never shows up on the calendar. When its day comes it is also put in 할 일·과제 as a 오늘 할 일 task
// (tasks.study_id, queued = done so), checked off together with it.
export type StudyRow = { id: number; date: string | null; course: string; title: string; done: number; queued: number; created_at: string };
export type PushSubRow = { endpoint: string; p256dh: string; auth: string };
export type NotificationRow = { id: number; title: string; body: string; url: string; created_at: string };
export type StudyFields = Pick<StudyRow, "date" | "course" | "title">;

// A line on the 지출 tab. 정기 = money that goes out every month (day = the day of the month, null = not fixed);
// 예정 = money to spend later (date = when, null = not fixed; done = spent).
export type ExpenseRow = { id: number; kind: string; title: string; amount: number; day: number | null; date: string | null; note: string; done: number; created_at: string };
export type ExpenseFields = Pick<ExpenseRow, "kind" | "title" | "amount" | "day" | "date" | "note" | "done">;
export const EXPENSE_KINDS = ["정기", "예정"];

// 시간표: a semester (year + term) holds courses. A course's grade feeds the 학점 계산기; times = when it meets each
// week (day 0 = 월 … 6 = 일). A semester with no grades yet (now or later) is just a plan.
export const TERMS = ["1", "여름", "2", "겨울"];
export const GRADES = ["", "A+", "A0", "B+", "B0", "C+", "C0", "D+", "D0", "F", "P", "NP"];
export const COURSE_COLORS = ["yellow", "mint", "blue", "pink", "rose", "lime", "peach", "lavender", "sky", "sand"];
export type SemesterRow = { id: number; year: number; term: string };
export type CourseTime = { day: number; start: string; end: string; room: string };
export type CourseRow = { id: number; semester_id: number; name: string; professor: string; credits: number; grade: string; major: number; color: string; times: CourseTime[] };
export type CourseFields = Omit<CourseRow, "id">;
type CourseRecord = Omit<CourseRow, "times"> & { times: string };

// 수업일정: a class that moved, was added (보강) or cancelled (휴강) on a day. The evening before, a notification.
export const CLASS_CHANGE_KINDS = ["변경", "보강", "휴강"];
export type ClassChangeRow = { id: number; course: string; kind: string; date: string; start: string | null; end: string | null; place: string; from_date: string | null; note: string; created_at: string };
export type ClassChangeFields = Omit<ClassChangeRow, "id" | "created_at">;

// A note is a list of blocks (src/blocks.ts). A "todo" block with a date is also a task (tasks.note_id/block_id),
// so it shows up on the today screen and the calendar.
export { BLOCK_TYPES, NOTE_MAX_BLOCKS, NOTE_MAX_TEXT, blockTitle, type Block } from "./blocks";
// version goes up on every write; a save must name the version it started from (see saveNote).
export type NoteRow = { id: number; title: string; blocks: Block[]; version: number; parent_id: number | null; created_at: string; updated_at: string };
type NoteRecord = Omit<NoteRow, "blocks"> & { blocks: string };

// A note that is a Notion page. snapshot: the page as this site last read it from (or wrote to) Notion,
// in note blocks; a save here is sent to Notion as the difference from it. null until the first read.
export type NotionPageRow = {
  page_id: string;
  note_id: number;
  edited: string; // Notion's last_edited_time when last read ('' = read it again)
  version: number; // the note version the snapshot belongs to
  kids: string[]; // child pages ("page:<id>") and databases ("db:<id>") found in it
  snapshot: { title: string; blocks: Block[] } | null;
  title_prop: string; // the name of the page's title property ("title", or a database's title column)
  icon: string; // the page's emoji, shown in front of the note title
  props: [string, string][]; // a database row's other columns, shown read-only
  parent: string; // the Notion page it sits in ('' at the top or in a database)
};
type NotionPageRecord = Omit<NotionPageRow, "kids" | "snapshot" | "props"> & { kids: string; snapshot: string; props: string };

// A cloud file attached to a note, a task, a portfolio item or the portfolio profile (target_id 0).
// The file itself stays in the 파일함; detaching only drops the link.
export const ATTACH_TARGETS = ["note", "task", "portfolio", "profile"] as const;
export type AttachTarget = (typeof ATTACH_TARGETS)[number];
export type AttachedFile = FileRow & { attachment_id: number };

// The portfolio: a profile (name, one-liner, about text, photo = its first attached image) and sections of items.
// Items are public (on kacarong.kr) or private (only on /admin/portfolio). sort orders sections and items within a section.
export type Profile = { name: string; headline: string; about: string };
// layout: how the portfolio page shows the section — "cards" (big alternating cards), "grid" (small cards side by side), "list" (rows, no pictures).
export const SECTION_LAYOUTS = ["cards", "grid", "list"];
export type PortfolioSection = { id: number; title: string; sort: number; layout: string };
export type PortfolioItem = {
  id: number;
  section_id: number;
  title: string;
  period: string; // free text, e.g. "2025.03 – 2025.06"
  summary: string;
  body: string;
  link: string;
  public: number;
  note_id: number | null; // a note shown under the item (자세히 보기); its pictures become public with the item
  sort: number;
  created_at: string;
  updated_at: string;
};
export type PortfolioFields = Pick<PortfolioItem, "section_id" | "title" | "period" | "summary" | "body" | "link" | "public"> & { note_id?: number | null };
const DEFAULT_SECTIONS = ["업적", "작품", "특기", "취미", "내 정보"];

// by_import = 1: the Notion import made this attachment, so a later import may take it off again. Ones the owner made stay.
const ATTACHMENTS_COLUMNS = `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target TEXT NOT NULL CHECK (target IN ('note', 'task', 'portfolio', 'profile')),
  target_id INTEGER NOT NULL,
  file_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  by_import INTEGER NOT NULL DEFAULT 0,
  UNIQUE (target, target_id, file_id)`;

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
    CREATE TABLE IF NOT EXISTS attachments (${ATTACHMENTS_COLUMNS});
    CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      parent_id INTEGER,
      drive_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS exams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      course TEXT NOT NULL DEFAULT '',
      date TEXT,
      time TEXT,
      place TEXT NOT NULL DEFAULT '',
      scope TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS studies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT,
      course TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      amount INTEGER NOT NULL DEFAULT 0,
      day INTEGER,
      date TEXT,
      note TEXT NOT NULL DEFAULT '',
      done INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS semesters (id INTEGER PRIMARY KEY AUTOINCREMENT, year INTEGER NOT NULL, term TEXT NOT NULL, UNIQUE (year, term));
    CREATE TABLE IF NOT EXISTS courses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      semester_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      professor TEXT NOT NULL DEFAULT '',
      credits REAL NOT NULL DEFAULT 3,
      grade TEXT NOT NULL DEFAULT '',
      major INTEGER NOT NULL DEFAULT 0,
      color TEXT NOT NULL DEFAULT '',
      times TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS courses_semester ON courses (semester_id);
    CREATE TRIGGER IF NOT EXISTS courses_semester_gone AFTER DELETE ON semesters BEGIN
      DELETE FROM courses WHERE semester_id = old.id;
    END;
    CREATE TABLE IF NOT EXISTS class_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course TEXT NOT NULL,
      kind TEXT NOT NULL,
      date TEXT NOT NULL,
      start TEXT,
      end TEXT,
      place TEXT NOT NULL DEFAULT '',
      from_date TEXT,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS portfolio_sections (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS portfolio_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      section_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      period TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      link TEXT NOT NULL DEFAULT '',
      public INTEGER NOT NULL DEFAULT 0,
      sort INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- What the Notion import brought in, so running it again updates instead of duplicating.
    -- version is the note version right after the import: a different one means it was edited here since.
    -- kids: the child pages ("page:<id>") and databases ("db:<id>") found in it, so an unchanged page still leads to them.
    -- edited is '' when some file of the page failed to copy, so the next run reads the page again.
    CREATE TABLE IF NOT EXISTS notion_pages (page_id TEXT PRIMARY KEY, note_id INTEGER NOT NULL, edited TEXT NOT NULL, version INTEGER NOT NULL);
    -- key: a file block id, or "<page id>:<property id>:<n>" for a file in a database column.
    -- source: the Notion file address without its signature; a new one means the file was replaced.
    CREATE TABLE IF NOT EXISTS notion_files (block_id TEXT PRIMARY KEY, file_id INTEGER NOT NULL);
  `);
  const taskCols = (db.query("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name);
  if (!taskCols.includes("note_id")) db.exec("ALTER TABLE tasks ADD COLUMN note_id INTEGER; ALTER TABLE tasks ADD COLUMN block_id TEXT;");
  db.exec("CREATE INDEX IF NOT EXISTS tasks_note ON tasks (note_id)");
  if (!taskCols.includes("category")) db.exec("ALTER TABLE tasks ADD COLUMN category TEXT NOT NULL DEFAULT ''");
  const examCols = (db.query("PRAGMA table_info(exams)").all() as { name: string }[]).map((c) => c.name);
  if (!examCols.includes("color")) db.exec("ALTER TABLE exams ADD COLUMN color TEXT NOT NULL DEFAULT ''");
  if (!taskCols.includes("study_id")) db.exec("ALTER TABLE tasks ADD COLUMN study_id INTEGER");
  const studyCols = (db.query("PRAGMA table_info(studies)").all() as { name: string }[]).map((c) => c.name);
  // Days already gone when this came in are not put in 할 일·과제 afterwards.
  if (!studyCols.includes("queued")) db.exec("ALTER TABLE studies ADD COLUMN queued INTEGER NOT NULL DEFAULT 0; UPDATE studies SET queued = 1 WHERE date < date('now', '+9 hours');");
  // A study's day became optional (a course's list first, days later): SQLite can't drop NOT NULL, so the table is rebuilt.
  if ((db.query("PRAGMA table_info(studies)").all() as { name: string; notnull: number }[]).find((c) => c.name === "date")?.notnull) {
    db.transaction(() => {
      db.exec(`
        DROP TRIGGER IF EXISTS tasks_study_gone;
        CREATE TABLE studies_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          date TEXT,
          course TEXT NOT NULL DEFAULT '',
          title TEXT NOT NULL,
          done INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          queued INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO studies_new (id, date, course, title, done, created_at, queued) SELECT id, date, course, title, done, created_at, queued FROM studies;
        DROP TABLE studies;
        ALTER TABLE studies_new RENAME TO studies;
      `);
    })();
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS tasks_study ON tasks (study_id);
    CREATE TRIGGER IF NOT EXISTS tasks_study_gone AFTER DELETE ON studies BEGIN
      DELETE FROM tasks WHERE study_id = old.id;
    END;
  `);
  const noteCols = (db.query("PRAGMA table_info(notes)").all() as { name: string }[]).map((c) => c.name);
  if (!noteCols.includes("version")) db.exec("ALTER TABLE notes ADD COLUMN version INTEGER NOT NULL DEFAULT 0");
  // parent_id: the note this one sits under in the list (the Notion import keeps Notion's page tree); NULL = top level.
  if (!noteCols.includes("parent_id")) db.exec("ALTER TABLE notes ADD COLUMN parent_id INTEGER");
  const notionCols = (db.query("PRAGMA table_info(notion_pages)").all() as { name: string }[]).map((c) => c.name);
  if (!notionCols.includes("kids")) db.exec("ALTER TABLE notion_pages ADD COLUMN kids TEXT NOT NULL DEFAULT '[]'");
  for (const [col, def] of [["snapshot", "TEXT NOT NULL DEFAULT ''"], ["title_prop", "TEXT NOT NULL DEFAULT 'title'"], ["icon", "TEXT NOT NULL DEFAULT ''"], ["props", "TEXT NOT NULL DEFAULT '[]'"], ["parent", "TEXT NOT NULL DEFAULT ''"]]) {
    if (!notionCols.includes(col!)) db.exec(`ALTER TABLE notion_pages ADD COLUMN ${col} ${def}`);
  }
  // A block made on this site keeps its id in the note; this is the id Notion gave it (blocks read from Notion use Notion's id).
  db.exec("CREATE TABLE IF NOT EXISTS notion_blocks (note_id INTEGER NOT NULL, block_id TEXT NOT NULL, notion_id TEXT NOT NULL UNIQUE, PRIMARY KEY (note_id, block_id))");
  const notionFileCols = (db.query("PRAGMA table_info(notion_files)").all() as { name: string }[]).map((c) => c.name);
  if (!notionFileCols.includes("source")) db.exec("ALTER TABLE notion_files ADD COLUMN source TEXT NOT NULL DEFAULT ''");
  const attachCols = (db.query("PRAGMA table_info(attachments)").all() as { name: string }[]).map((c) => c.name);
  if (!attachCols.includes("by_import")) db.exec("ALTER TABLE attachments ADD COLUMN by_import INTEGER NOT NULL DEFAULT 0");
  const fileCols = (db.query("PRAGMA table_info(files)").all() as { name: string }[]).map((c) => c.name);
  if (!fileCols.includes("folder_id")) db.exec("ALTER TABLE files ADD COLUMN folder_id INTEGER");
  if (!fileCols.includes("origin")) {
    // Copies the Notion import/sync made before this column: recorded in notion_files, or attached by the import.
    // Not by the 노션 tag: the owner may have tagged an upload of their own that way.
    db.exec(`ALTER TABLE files ADD COLUMN origin TEXT NOT NULL DEFAULT '';
      UPDATE files SET origin = 'notion' WHERE id IN (SELECT file_id FROM notion_files) OR id IN (SELECT file_id FROM attachments WHERE by_import = 1);`);
  }
  // sort: the order the owner put a folder's folders and files in (one order for both). Before it, a folder showed
  // its folders by name and then its files newest first, so that is where they start.
  const folderCols = (db.query("PRAGMA table_info(folders)").all() as { name: string }[]).map((c) => c.name);
  if (!folderCols.includes("sort") || !fileCols.includes("sort")) {
    db.transaction(() => {
      if (!folderCols.includes("sort")) db.exec("ALTER TABLE folders ADD COLUMN sort INTEGER NOT NULL DEFAULT 0");
      if (!fileCols.includes("sort")) db.exec("ALTER TABLE files ADD COLUMN sort INTEGER NOT NULL DEFAULT 0");
      db.exec(`
        UPDATE folders SET sort = (SELECT n FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY parent_id ORDER BY name COLLATE NOCASE, id) - 1 AS n FROM folders) r WHERE r.id = folders.id);
        UPDATE files SET sort = (SELECT n FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY folder_id ORDER BY id DESC) - 1 AS n FROM files WHERE origin = '') r WHERE r.id = files.id)
          + (SELECT COUNT(*) FROM folders WHERE parent_id IS files.folder_id) WHERE origin = '';
      `);
    })();
  }
  // Attachments tables made before portfolio items and the profile could have files: widen the target check.
  // SQLite can't change a CHECK in place, so copy the table. The triggers that name it go first and come back below.
  const attachSql = (db.query("SELECT sql FROM sqlite_master WHERE name = 'attachments'").get() as { sql: string }).sql;
  if (!attachSql.includes("'profile'")) {
    db.transaction(() => {
      db.exec(`
        DROP TRIGGER IF EXISTS attachments_note_gone; DROP TRIGGER IF EXISTS attachments_task_gone; DROP TRIGGER IF EXISTS attachments_file_gone;
        CREATE TABLE attachments_new (${ATTACHMENTS_COLUMNS});
        INSERT INTO attachments_new (id, target, target_id, file_id, created_at, by_import) SELECT id, target, target_id, file_id, created_at, by_import FROM attachments;
        DROP TABLE attachments;
        ALTER TABLE attachments_new RENAME TO attachments;
      `);
    })();
  }
  db.exec(`
    -- Whatever removes a note, task, portfolio item or file (including tasks a note save drops) also drops its attachments.
    CREATE TRIGGER IF NOT EXISTS attachments_note_gone AFTER DELETE ON notes BEGIN
      DELETE FROM attachments WHERE target = 'note' AND target_id = old.id;
    END;
    CREATE TRIGGER IF NOT EXISTS attachments_task_gone AFTER DELETE ON tasks BEGIN
      DELETE FROM attachments WHERE target = 'task' AND target_id = old.id;
    END;
    CREATE TRIGGER IF NOT EXISTS attachments_file_gone AFTER DELETE ON files BEGIN
      DELETE FROM attachments WHERE file_id = old.id;
    END;
    CREATE TRIGGER IF NOT EXISTS attachments_portfolio_gone AFTER DELETE ON portfolio_items BEGIN
      DELETE FROM attachments WHERE target = 'portfolio' AND target_id = old.id;
    END;
  `);
  const pfItemCols = (db.query("PRAGMA table_info(portfolio_items)").all() as { name: string }[]).map((c) => c.name);
  if (!pfItemCols.includes("note_id")) db.exec("ALTER TABLE portfolio_items ADD COLUMN note_id INTEGER");
  const pfSectionCols = (db.query("PRAGMA table_info(portfolio_sections)").all() as { name: string }[]).map((c) => c.name);
  if (!pfSectionCols.includes("layout")) db.exec("ALTER TABLE portfolio_sections ADD COLUMN layout TEXT NOT NULL DEFAULT 'cards'");
  // Left over from removed features: the exam study plan (tasks.exam_id), sending tasks and exams to Google Calendar
  // (gcal_links, gcal_push*) and the 공부 tab's period (study_range). The index and trigger go before the column.
  db.exec(`
    DROP TRIGGER IF EXISTS tasks_exam_gone; DROP INDEX IF EXISTS tasks_exam; DROP TABLE IF EXISTS gcal_links;
    DELETE FROM settings WHERE key IN ('gcal_push', 'gcal_push_error', 'study_range');
  `);
  if (taskCols.includes("exam_id")) db.exec("ALTER TABLE tasks DROP COLUMN exam_id");
  // Notifications: the devices that get Web Push, what was sent (also read by pages that show notifications themselves,
  // like the PC program), and which scheduled ones went out already.
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL, url TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS notify_sent (key TEXT PRIMARY KEY, at TEXT NOT NULL DEFAULT (datetime('now')));
  `);
  // A new portfolio starts with the usual sections, once; the owner may rename or delete them.
  if (!(db.query("SELECT 1 FROM settings WHERE key = 'portfolio_seeded'").get())) {
    db.transaction(() => {
      DEFAULT_SECTIONS.forEach((t, i) => db.query("INSERT INTO portfolio_sections (title, sort) VALUES (?, ?)").run(t, i));
      db.query("INSERT INTO settings (key, value) VALUES ('portfolio_seeded', '1')").run();
    })();
  }
  // A sort that puts something first in a cloud folder (before its folders and files).
  const topSort = (folder: number | null) => {
    const { s } = db.query("SELECT MIN(s) AS s FROM (SELECT MIN(sort) AS s FROM folders WHERE parent_id IS ?1 UNION ALL SELECT MIN(sort) FROM files WHERE folder_id IS ?1 AND origin = '')").get(folder) as { s: number | null };
    return s === null ? 0 : s - 1;
  };
  const TASK_SELECT = `SELECT tasks.*, notes.title AS note_title,
    (SELECT COUNT(*) FROM attachments WHERE target = 'task' AND target_id = tasks.id) AS files
    FROM tasks LEFT JOIN notes ON notes.id = tasks.note_id`;
  const TASK_ORDER = "ORDER BY due_date IS NULL, due_date, due_time IS NULL, due_time, tasks.id";
  const notionRow = (r: NotionPageRecord): NotionPageRow => ({ ...r, kids: JSON.parse(r.kids), snapshot: r.snapshot ? JSON.parse(r.snapshot) : null, props: JSON.parse(r.props) });
  function getNote(id: number): NoteRow | null {
    const r = db.query("SELECT id, title, blocks, version, parent_id, created_at, updated_at FROM notes WHERE id = ?").get(id) as NoteRecord | null;
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
    pushSubs(): PushSubRow[] {
      return db.query("SELECT endpoint, p256dh, auth FROM push_subs").all() as PushSubRow[];
    },
    addPushSub(s: PushSubRow) {
      db.query("INSERT OR REPLACE INTO push_subs (endpoint, p256dh, auth) VALUES (?, ?, ?)").run(s.endpoint, s.p256dh, s.auth);
    },
    deletePushSub(endpoint: string) {
      db.query("DELETE FROM push_subs WHERE endpoint = ?").run(endpoint);
    },
    addNotification(n: { title: string; body: string; url: string }): NotificationRow {
      db.query("DELETE FROM notifications WHERE created_at < datetime('now', '-7 days')").run();
      return db.query("INSERT INTO notifications (title, body, url) VALUES (?, ?, ?) RETURNING *").get(n.title, n.body, n.url) as NotificationRow;
    },
    // Notifications after the given id from the last day (after = -1: just the newest id, nothing to show).
    notificationsAfter(after: number): NotificationRow[] {
      if (after < 0) return db.query("SELECT * FROM notifications ORDER BY id DESC LIMIT 1").all() as NotificationRow[];
      return db.query("SELECT * FROM notifications WHERE id > ? AND created_at >= datetime('now', '-1 day') ORDER BY id LIMIT 20").all(after) as NotificationRow[];
    },
    // Marks a scheduled notification as sent; false when it already was.
    markNotified(key: string): boolean {
      db.query("DELETE FROM notify_sent WHERE at < datetime('now', '-30 days')").run();
      return db.query("INSERT OR IGNORE INTO notify_sent (key) VALUES (?)").run(key).changes > 0;
    },
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
    deleteExpiredSessions() {
      db.query("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
    },
    getSession(id: string): { email: string } | null {
      return db.query("SELECT email FROM sessions WHERE id = ? AND expires_at > ?").get(id, Date.now()) as { email: string } | null;
    },
    deleteSession(id: string) {
      db.query("DELETE FROM sessions WHERE id = ?").run(id);
    },
    // folder: a folder id, or null for the top of the cloud; undefined = every folder (search, the picker).
    listFiles(opts: { q?: string; category?: string; folder?: number | null }): FileRow[] {
      const where: string[] = ["origin = ''"];
      const args: (string | number)[] = [];
      if (opts.folder === null) where.push("folder_id IS NULL");
      else if (opts.folder !== undefined) {
        where.push("folder_id = ?");
        args.push(opts.folder);
      }
      if (opts.category) {
        where.push("category = ?");
        args.push(opts.category);
      }
      if (opts.q) {
        where.push("(title LIKE ? OR name LIKE ? OR tags LIKE ? OR note LIKE ?)");
        const like = `%${opts.q}%`;
        args.push(like, like, like, like);
      }
      // One folder is in the owner's order; a search across folders shows the newest first.
      const sql = `SELECT * FROM files WHERE ${where.join(" AND ")} ORDER BY ${opts.folder === undefined ? "" : "sort, "}id DESC`;
      return db.query(sql).all(...args) as FileRow[];
    },
    usage(): { files: number; bytes: number } {
      return db.query("SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM files WHERE origin = ''").get() as { files: number; bytes: number };
    },
    getFile(id: number): FileRow | null {
      return db.query("SELECT * FROM files WHERE id = ?").get(id) as FileRow | null;
    },
    getFileByDriveId(driveId: string): FileRow | null {
      return db.query("SELECT * FROM files WHERE drive_id = ?").get(driveId) as FileRow | null;
    },
    // A new upload goes first in its folder.
    insertFile(f: Pick<FileRow, "drive_id" | "name" | "title" | "mime" | "size" | "category" | "tags" | "note"> & { folder_id?: number | null; origin?: string }): FileRow {
      return db
        .query("INSERT INTO files (drive_id, name, title, mime, size, category, tags, note, folder_id, origin, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *")
        .get(f.drive_id, f.name, f.title, f.mime, f.size, f.category, f.tags, f.note, f.folder_id ?? null, f.origin ?? "", topSort(f.folder_id ?? null)) as FileRow;
    },
    notionCopies(): FileRow[] {
      return db.query("SELECT * FROM files WHERE origin = 'notion'").all() as FileRow[];
    },
    // A file moved to another folder goes first there.
    updateFile(id: number, patch: Partial<Pick<FileRow, "title" | "category" | "tags" | "note" | "folder_id">>) {
      const keys = Object.keys(patch) as (keyof typeof patch)[];
      if (!keys.length) return;
      const before = db.query("SELECT folder_id FROM files WHERE id = ?").get(id) as { folder_id: number | null };
      const sets = keys.map((k) => `${k} = ?`).join(", ");
      db.query(`UPDATE files SET ${sets} WHERE id = ?`).run(...keys.map((k) => patch[k] ?? null), id);
      if (patch.folder_id !== undefined && patch.folder_id !== before.folder_id) db.query("UPDATE files SET sort = ? WHERE id = ?").run(topSort(patch.folder_id), id);
    },
    deleteFile(id: number) {
      db.query("DELETE FROM files WHERE id = ?").run(id);
    },
    listFolders(): FolderRow[] {
      return db.query("SELECT * FROM folders ORDER BY sort, id").all() as FolderRow[];
    },
    getFolder(id: number): FolderRow | null {
      return db.query("SELECT * FROM folders WHERE id = ?").get(id) as FolderRow | null;
    },
    // Another folder of that name already sits in that parent (names are unique per folder, like a file manager).
    folderNameTaken(parentId: number | null, name: string, exceptId = 0): boolean {
      return !!db.query("SELECT 1 FROM folders WHERE parent_id IS ? AND name = ? AND id != ?").get(parentId, name, exceptId);
    },
    // A new folder, or one moved to another folder, goes first there.
    insertFolder(name: string, parentId: number | null, driveId: string): FolderRow {
      return db.query("INSERT INTO folders (name, parent_id, drive_id, sort) VALUES (?, ?, ?, ?) RETURNING *").get(name, parentId, driveId, topSort(parentId)) as FolderRow;
    },
    updateFolder(id: number, name: string, parentId: number | null) {
      const before = db.query("SELECT parent_id FROM folders WHERE id = ?").get(id) as { parent_id: number | null };
      const sort = parentId === before.parent_id ? null : topSort(parentId);
      db.query("UPDATE folders SET name = ?, parent_id = ?, sort = COALESCE(?, sort) WHERE id = ?").run(name, parentId, sort, id);
    },
    // Puts a folder's folders and files in the given order. It must name each of them once (the list on screen
    // may be out of date); returns false otherwise and changes nothing.
    orderFolder: db.transaction((folder: number | null, items: CloudItem[]): boolean => {
      const have = [
        ...(db.query("SELECT id FROM folders WHERE parent_id IS ?").all(folder) as { id: number }[]).map((r) => `folder:${r.id}`),
        ...(db.query("SELECT id FROM files WHERE folder_id IS ? AND origin = ''").all(folder) as { id: number }[]).map((r) => `file:${r.id}`),
      ];
      const want = items.map((i) => `${i.type}:${i.id}`);
      if (new Set(want).size !== want.length || want.length !== have.length || !want.every((k) => have.includes(k))) return false;
      items.forEach((i, n) => db.query(`UPDATE ${i.type === "folder" ? "folders" : "files"} SET sort = ? WHERE id = ?`).run(n, i.id));
      return true;
    }),
    // The folder and every folder below it.
    folderTree(id: number): number[] {
      return (db.query("WITH RECURSIVE t(id) AS (SELECT ? UNION SELECT folders.id FROM folders JOIN t ON folders.parent_id = t.id) SELECT id FROM t").all(id) as { id: number }[]).map((r) => r.id);
    },
    // Drops the folders and the files in them (their attachments go with them by trigger). Returns the removed files.
    deleteFolders: db.transaction((ids: number[]): FileRow[] => {
      const marks = ids.map(() => "?").join(",");
      const files = db.query(`SELECT * FROM files WHERE folder_id IN (${marks})`).all(...ids) as FileRow[];
      db.query(`DELETE FROM files WHERE folder_id IN (${marks})`).run(...ids);
      db.query(`DELETE FROM folders WHERE id IN (${marks})`).run(...ids);
      return files;
    }),
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
      const id = (
        db.query("INSERT INTO tasks (kind, category, title, course, due_date, due_time, note) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id").get(t.kind, t.category, t.title, t.course, t.due_date, t.due_time, t.note) as { id: number }
      ).id;
      return db.query(`${TASK_SELECT} WHERE tasks.id = ?`).get(id) as TaskRow;
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
    // Exams with a date first (soonest first), then the ones without a date.
    listExams(opts: { from?: string; to?: string } = {}): ExamRow[] {
      if (opts.from && opts.to) return db.query("SELECT * FROM exams WHERE date BETWEEN ? AND ? ORDER BY date, time IS NULL, time, id").all(opts.from, opts.to) as ExamRow[];
      return db.query("SELECT * FROM exams ORDER BY date IS NULL, date, time IS NULL, time, id").all() as ExamRow[];
    },
    getExam(id: number): ExamRow | null {
      return db.query("SELECT * FROM exams WHERE id = ?").get(id) as ExamRow | null;
    },
    insertExam(e: ExamFields): ExamRow {
      return db.query("INSERT INTO exams (title, course, date, time, place, scope, note, color) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *").get(e.title, e.course, e.date, e.time, e.place, e.scope, e.note, e.color) as ExamRow;
    },
    updateExam(id: number, patch: Partial<ExamFields>) {
      const keys = Object.keys(patch) as (keyof typeof patch)[];
      if (!keys.length) return;
      db.query(`UPDATE exams SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => patch[k] ?? null), id);
    },
    deleteExam(id: number) {
      db.query("DELETE FROM exams WHERE id = ?").run(id);
    },
    listExpenses(): ExpenseRow[] {
      return db.query("SELECT * FROM expenses ORDER BY id").all() as ExpenseRow[];
    },
    getExpense(id: number): ExpenseRow | null {
      return db.query("SELECT * FROM expenses WHERE id = ?").get(id) as ExpenseRow | null;
    },
    insertExpense(e: ExpenseFields): ExpenseRow {
      return db.query("INSERT INTO expenses (kind, title, amount, day, date, note, done) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *").get(e.kind, e.title, e.amount, e.day, e.date, e.note, e.done) as ExpenseRow;
    },
    updateExpense(id: number, e: ExpenseFields): ExpenseRow {
      return db.query("UPDATE expenses SET kind = ?, title = ?, amount = ?, day = ?, date = ?, note = ?, done = ? WHERE id = ? RETURNING *").get(e.kind, e.title, e.amount, e.day, e.date, e.note, e.done, id) as ExpenseRow;
    },
    deleteExpense(id: number) {
      db.query("DELETE FROM expenses WHERE id = ?").run(id);
    },
    listSemesters(): SemesterRow[] {
      return db.query("SELECT * FROM semesters ORDER BY year, CASE term WHEN '1' THEN 0 WHEN '여름' THEN 1 WHEN '2' THEN 2 ELSE 3 END").all() as SemesterRow[];
    },
    getSemester(id: number): SemesterRow | null {
      return db.query("SELECT * FROM semesters WHERE id = ?").get(id) as SemesterRow | null;
    },
    // null when that semester is already there.
    insertSemester(year: number, term: string): SemesterRow | null {
      return db.query("INSERT OR IGNORE INTO semesters (year, term) VALUES (?, ?) RETURNING *").get(year, term) as SemesterRow | null;
    },
    deleteSemester(id: number) {
      db.query("DELETE FROM semesters WHERE id = ?").run(id); // its courses go by trigger
    },
    listCourses(): CourseRow[] {
      return (db.query("SELECT * FROM courses ORDER BY id").all() as CourseRecord[]).map((c) => ({ ...c, times: JSON.parse(c.times) }));
    },
    getCourse(id: number): CourseRow | null {
      const c = db.query("SELECT * FROM courses WHERE id = ?").get(id) as CourseRecord | null;
      return c && { ...c, times: JSON.parse(c.times) };
    },
    insertCourse(c: CourseFields): CourseRow {
      const r = db.query("INSERT INTO courses (semester_id, name, professor, credits, grade, major, color, times) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *").get(c.semester_id, c.name, c.professor, c.credits, c.grade, c.major, c.color, JSON.stringify(c.times)) as CourseRecord;
      return { ...r, times: JSON.parse(r.times) };
    },
    updateCourse(id: number, c: CourseFields): CourseRow {
      const r = db.query("UPDATE courses SET semester_id = ?, name = ?, professor = ?, credits = ?, grade = ?, major = ?, color = ?, times = ? WHERE id = ? RETURNING *").get(c.semester_id, c.name, c.professor, c.credits, c.grade, c.major, c.color, JSON.stringify(c.times), id) as CourseRecord;
      return { ...r, times: JSON.parse(r.times) };
    },
    deleteCourse(id: number) {
      db.query("DELETE FROM courses WHERE id = ?").run(id);
    },
    listClassChanges(opts: { from?: string; to?: string } = {}): ClassChangeRow[] {
      return db.query("SELECT * FROM class_changes WHERE date >= ? AND date <= ? ORDER BY date, start, id").all(opts.from ?? "", opts.to ?? "9999") as ClassChangeRow[];
    },
    getClassChange(id: number): ClassChangeRow | null {
      return db.query("SELECT * FROM class_changes WHERE id = ?").get(id) as ClassChangeRow | null;
    },
    insertClassChange(c: ClassChangeFields): ClassChangeRow {
      return db.query("INSERT INTO class_changes (course, kind, date, start, end, place, from_date, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *").get(c.course, c.kind, c.date, c.start, c.end, c.place, c.from_date, c.note) as ClassChangeRow;
    },
    updateClassChange(id: number, c: ClassChangeFields): ClassChangeRow {
      return db.query("UPDATE class_changes SET course = ?, kind = ?, date = ?, start = ?, end = ?, place = ?, from_date = ?, note = ? WHERE id = ? RETURNING *").get(c.course, c.kind, c.date, c.start, c.end, c.place, c.from_date, c.note, id) as ClassChangeRow;
    },
    deleteClassChange(id: number) {
      db.query("DELETE FROM class_changes WHERE id = ?").run(id);
    },
    listStudies(): StudyRow[] {
      return db.query("SELECT * FROM studies ORDER BY id").all() as StudyRow[]; // the order they were written in
    },
    getStudy(id: number): StudyRow | null {
      return db.query("SELECT * FROM studies WHERE id = ?").get(id) as StudyRow | null;
    },
    // A day already gone is a record, not something to do: it doesn't go to 할 일·과제. No day yet: waits for one.
    insertStudy(s: StudyFields, today: string): StudyRow {
      return db.query("INSERT INTO studies (date, course, title, queued) VALUES (?, ?, ?, ?) RETURNING *").get(s.date, s.course, s.title, s.date !== null && s.date < today ? 1 : 0) as StudyRow;
    },
    // The 오늘 할 일 task follows. Moved to another day, it waits for that day again (a day already gone: not at all;
    // the day taken off: until it gets one).
    updateStudy: db.transaction((id: number, patch: Partial<StudyFields & { done: number }>, today: string) => {
      const before = db.query("SELECT * FROM studies WHERE id = ?").get(id) as StudyRow;
      const keys = Object.keys(patch) as (keyof typeof patch)[];
      if (keys.length) db.query(`UPDATE studies SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => patch[k]!), id);
      if (patch.date !== undefined && patch.date !== before.date) {
        db.query("DELETE FROM tasks WHERE study_id = ?").run(id);
        db.query("UPDATE studies SET queued = ? WHERE id = ?").run(patch.date !== null && patch.date < today ? 1 : 0, id);
        return;
      }
      if (patch.title !== undefined) db.query("UPDATE tasks SET title = ? WHERE study_id = ?").run(patch.title, id);
      if (patch.course !== undefined) db.query("UPDATE tasks SET course = ? WHERE study_id = ?").run(patch.course, id);
      if (patch.done !== undefined) db.query("UPDATE tasks SET done = ?, done_at = ? WHERE study_id = ? AND done != ?").run(patch.done, patch.done ? today : null, id, patch.done);
    }),
    // Each study whose day has come goes into 할 일·과제 as a 오늘 할 일 task, once: deleted there, it stays deleted.
    queueStudies: db.transaction((today: string) => {
      for (const s of db.query("SELECT * FROM studies WHERE queued = 0 AND date <= ?").all(today) as StudyRow[]) {
        db.query("INSERT INTO tasks (kind, category, title, course, due_date, done, done_at, study_id) VALUES ('공부', '오늘 할 일', ?, ?, ?, ?, ?, ?)").run(s.title, s.course, s.date, s.done, s.done ? today : null, s.id);
        db.query("UPDATE studies SET queued = 1 WHERE id = ?").run(s.id);
      }
    }),
    // An open 나중에 할 일 task whose due day has come (or gone) moves to 오늘 할 일.
    promoteLaterTasks(today: string) {
      db.query("UPDATE tasks SET category = '오늘 할 일' WHERE category = '나중에 할 일' AND done = 0 AND due_date <= ?").run(today);
    },
    deleteStudy(id: number) {
      db.query("DELETE FROM studies WHERE id = ?").run(id);
    },
    // Every note with its text, newest edit first (/api/search filters them).
    noteTexts(): { id: number; title: string; text: string }[] {
      return db.query("SELECT id, title, text FROM notes ORDER BY updated_at DESC, id DESC").all() as { id: number; title: string; text: string }[];
    },
    listNotes(q?: string): Pick<NoteRow, "id" | "title" | "parent_id" | "updated_at">[] {
      const like = `%${q ?? ""}%`;
      return db.query("SELECT id, title, parent_id, updated_at FROM notes WHERE ? = '' OR title LIKE ? OR text LIKE ? ORDER BY updated_at DESC, id DESC").all(q ?? "", like, like) as Pick<NoteRow, "id" | "title" | "parent_id" | "updated_at">[];
    },
    setNoteParent(id: number, parentId: number | null) {
      db.query("UPDATE notes SET parent_id = ? WHERE id = ?").run(parentId, id);
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
    addAttachment(target: AttachTarget, targetId: number, fileId: number, byImport = false): boolean {
      return db.query("INSERT OR IGNORE INTO attachments (target, target_id, file_id, by_import) VALUES (?, ?, ?, ?)").run(target, targetId, fileId, byImport ? 1 : 0).changes > 0;
    },
    deleteAttachment(id: number): boolean {
      return db.query("DELETE FROM attachments WHERE id = ?").run(id).changes > 0;
    },
    // Notion import: dates come from Notion so the list keeps Notion's order.
    setNoteTimes(id: number, created: string, updated: string) {
      db.query("UPDATE notes SET created_at = ?, updated_at = ? WHERE id = ?").run(created, updated, id);
    },
    notionPage(pageId: string): NotionPageRow | null {
      const r = db.query("SELECT * FROM notion_pages WHERE page_id = ?").get(pageId) as NotionPageRecord | null;
      return r ? notionRow(r) : null;
    },
    notionPageOfNote(noteId: number): NotionPageRow | null {
      const r = db.query("SELECT * FROM notion_pages WHERE note_id = ?").get(noteId) as NotionPageRecord | null;
      return r ? notionRow(r) : null;
    },
    notionPages(): NotionPageRow[] {
      return (db.query("SELECT * FROM notion_pages").all() as NotionPageRecord[]).map(notionRow);
    },
    setNotionPage(pageId: string, noteId: number, edited: string, version: number, kids: string[]) {
      db.query("INSERT INTO notion_pages (page_id, note_id, edited, version, kids) VALUES (?, ?, ?, ?, ?) ON CONFLICT(page_id) DO UPDATE SET note_id = excluded.note_id, edited = excluded.edited, version = excluded.version, kids = excluded.kids").run(pageId, noteId, edited, version, JSON.stringify(kids));
    },
    updateNotionPage(pageId: string, patch: Partial<Omit<NotionPageRow, "page_id">>) {
      const enc: Record<string, unknown> = { ...patch };
      if (patch.kids) enc.kids = JSON.stringify(patch.kids);
      if (patch.props) enc.props = JSON.stringify(patch.props);
      if ("snapshot" in patch) enc.snapshot = patch.snapshot ? JSON.stringify(patch.snapshot) : "";
      const keys = Object.keys(enc);
      if (keys.length) db.query(`UPDATE notion_pages SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE page_id = ?`).run(...(keys.map((k) => enc[k]) as (string | number)[]), pageId);
    },
    deleteNotionPage(pageId: string) {
      const r = db.query("DELETE FROM notion_pages WHERE page_id = ? RETURNING note_id").get(pageId) as { note_id: number } | null;
      if (r) db.query("DELETE FROM notion_blocks WHERE note_id = ?").run(r.note_id);
    },
    // note block id → Notion block id, for the blocks of a note made on this site.
    notionBlockIds(noteId: number): Map<string, string> {
      return new Map((db.query("SELECT block_id, notion_id FROM notion_blocks WHERE note_id = ?").all(noteId) as { block_id: string; notion_id: string }[]).map((r) => [r.block_id, r.notion_id]));
    },
    setNotionBlockId(noteId: number, blockId: string, notionId: string) {
      db.query("INSERT OR REPLACE INTO notion_blocks (note_id, block_id, notion_id) VALUES (?, ?, ?)").run(noteId, blockId, notionId);
    },
    deleteNotionBlockId(noteId: number, blockId: string) {
      db.query("DELETE FROM notion_blocks WHERE note_id = ? AND block_id = ?").run(noteId, blockId);
    },
    // Writes the note as read from Notion only if it was not saved here since `version`. Returns the new version, or null.
    writeNoteIf: db.transaction((id: number, version: number, title: string, blocks: Block[], today: string): number | null => {
      const n = getNote(id);
      if (!n || n.version !== version) return null;
      writeNote(id, title, blocks, today);
      return n.version + 1;
    }),
    // The 파일함 copy of a Notion file, if it is still there.
    notionFile(key: string): (FileRow & { source: string }) | null {
      return db.query("SELECT files.*, notion_files.source FROM notion_files JOIN files ON files.id = notion_files.file_id WHERE block_id = ?").get(key) as (FileRow & { source: string }) | null;
    },
    setNotionFile(key: string, fileId: number, source: string) {
      db.query("INSERT OR REPLACE INTO notion_files (block_id, file_id, source) VALUES (?, ?, ?)").run(key, fileId, source);
    },
    // Attachments of a note that the Notion import made (not the ones the owner attached, even of a Notion copy).
    notionAttachments(noteId: number): { id: number; file_id: number }[] {
      return db.query("SELECT id, file_id FROM attachments WHERE target = 'note' AND target_id = ? AND by_import = 1").all(noteId) as { id: number; file_id: number }[];
    },
    profile(): Profile {
      const raw = db.query("SELECT value FROM settings WHERE key = 'portfolio_profile'").get() as { value: string } | null;
      return { name: "", headline: "", about: "", ...(raw ? (JSON.parse(raw.value) as Partial<Profile>) : {}) };
    },
    setProfile(p: Profile) {
      db.query("INSERT INTO settings (key, value) VALUES ('portfolio_profile', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(p));
    },
    listSections(): PortfolioSection[] {
      return db.query("SELECT * FROM portfolio_sections ORDER BY sort, id").all() as PortfolioSection[];
    },
    getSection(id: number): PortfolioSection | null {
      return db.query("SELECT * FROM portfolio_sections WHERE id = ?").get(id) as PortfolioSection | null;
    },
    insertSection(title: string): PortfolioSection {
      return db.query("INSERT INTO portfolio_sections (title, sort) VALUES (?, (SELECT COALESCE(MAX(sort), -1) + 1 FROM portfolio_sections)) RETURNING *").get(title) as PortfolioSection;
    },
    renameSection(id: number, title: string) {
      db.query("UPDATE portfolio_sections SET title = ? WHERE id = ?").run(title, id);
    },
    setSectionLayout(id: number, layout: string) {
      db.query("UPDATE portfolio_sections SET layout = ? WHERE id = ?").run(layout, id);
    },
    // Its items go too (and their attachments, by trigger).
    deleteSection: db.transaction((id: number) => {
      db.query("DELETE FROM portfolio_items WHERE section_id = ?").run(id);
      db.query("DELETE FROM portfolio_sections WHERE id = ?").run(id);
    }),
    listItems(opts: { publicOnly?: boolean } = {}): PortfolioItem[] {
      return db.query(`SELECT * FROM portfolio_items ${opts.publicOnly ? "WHERE public = 1" : ""} ORDER BY section_id, sort, id`).all() as PortfolioItem[];
    },
    getItem(id: number): PortfolioItem | null {
      return db.query("SELECT * FROM portfolio_items WHERE id = ?").get(id) as PortfolioItem | null;
    },
    insertItem(f: PortfolioFields): PortfolioItem {
      return db
        .query(
          `INSERT INTO portfolio_items (section_id, title, period, summary, body, link, public, note_id, sort)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort), -1) + 1 FROM portfolio_items WHERE section_id = ?)) RETURNING *`,
        )
        .get(f.section_id, f.title, f.period, f.summary, f.body, f.link, f.public, f.note_id ?? null, f.section_id) as PortfolioItem;
    },
    // Moving an item to another section puts it at the end there.
    updateItem: db.transaction((id: number, patch: Partial<PortfolioFields>) => {
      const before = db.query("SELECT section_id FROM portfolio_items WHERE id = ?").get(id) as { section_id: number };
      const keys = Object.keys(patch) as (keyof PortfolioFields)[];
      if (!keys.length) return;
      db.query(`UPDATE portfolio_items SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`).run(...keys.map((k) => patch[k] ?? null), id);
      if (patch.section_id !== undefined && patch.section_id !== before.section_id) {
        db.query("UPDATE portfolio_items SET sort = (SELECT COALESCE(MAX(sort), -1) + 1 FROM portfolio_items WHERE section_id = ? AND id != ?) WHERE id = ?").run(patch.section_id, id, id);
      }
    }),
    deleteItem(id: number) {
      db.query("DELETE FROM portfolio_items WHERE id = ?").run(id);
    },
    // Swaps a section or an item with its neighbour above (dir -1) or below (dir 1). Returns false at either end.
    // Sorts are renumbered first, so equal or gapped sort values still move by exactly one place.
    move: db.transaction((kind: "section" | "item", id: number, dir: -1 | 1): boolean => {
      const table = kind === "section" ? "portfolio_sections" : "portfolio_items";
      const scope = kind === "item" ? "WHERE section_id = (SELECT section_id FROM portfolio_items WHERE id = ?)" : "";
      const ids = (db.query(`SELECT id FROM ${table} ${scope} ORDER BY sort, id`).all(...(kind === "item" ? [id] : [])) as { id: number }[]).map((r) => r.id);
      const i = ids.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= ids.length) return false;
      [ids[i], ids[j]] = [ids[j]!, ids[i]!];
      ids.forEach((x, n) => db.query(`UPDATE ${table} SET sort = ? WHERE id = ?`).run(n, x));
      return true;
    }),
    // A file anyone may fetch: attached to the profile or to a public portfolio item, or a picture/file in the note of a public item.
    isPublicFile(fileId: number): boolean {
      return !!db
        .query(
          `SELECT 1 FROM attachments a LEFT JOIN portfolio_items i ON a.target = 'portfolio' AND i.id = a.target_id
           WHERE a.file_id = ? AND (a.target = 'profile' OR i.public = 1)
           UNION ALL
           SELECT 1 FROM portfolio_items i JOIN notes n ON n.id = i.note_id, json_each(n.blocks) b
           WHERE i.public = 1 AND json_extract(b.value, '$.fileId') = ?`,
        )
        .get(fileId, fileId);
    },
    // The notes under it, at any depth (nearest first).
    noteDescendants(id: number): number[] {
      return (db.query("WITH RECURSIVE t(id) AS (SELECT id FROM notes WHERE parent_id = ? UNION SELECT notes.id FROM notes JOIN t ON notes.parent_id = t.id) SELECT id FROM t").all(id) as { id: number }[]).map((r) => r.id);
    },
    // Notes under it move up to its parent, so deleting a note never takes others with it.
    deleteNote: db.transaction((id: number) => {
      db.query("UPDATE notes SET parent_id = (SELECT parent_id FROM notes WHERE id = ?) WHERE parent_id = ?").run(id, id);
      db.query("DELETE FROM tasks WHERE note_id = ?").run(id);
      db.query("DELETE FROM notes WHERE id = ?").run(id);
    }),
  };
}

export type Db = ReturnType<typeof openDb>;

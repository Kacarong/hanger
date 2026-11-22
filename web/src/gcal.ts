import { createHash } from "node:crypto";
import type { Db, ExamRow, TaskRow } from "./db";
import { GoogleError, type EventBody, type Google } from "./google";

const PUSH_BACK_DAYS = 30; // items dated earlier than this many days ago are left as they are in Google

function addDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// start/end of an event in Korea. No start time = all day, through endDate (inclusive; Google's end date is exclusive).
// With a time: until endDate endTime, or `minutes` after the start when no end time is given.
export function eventWhen(date: string, time: string | null, endDate: string, endTime: string | null, minutes: number): Pick<EventBody, "start" | "end"> {
  if (!time) {
    return {
      start: { date, dateTime: null, timeZone: null },
      end: { date: addDays(endDate, 1), dateTime: null, timeZone: null },
    };
  }
  const start = new Date(`${date}T${time}:00+09:00`);
  const end = endTime ? new Date(`${endDate}T${endTime}:00+09:00`) : new Date(start.getTime() + minutes * 60_000);
  return {
    start: { date: null, dateTime: start.toISOString(), timeZone: "Asia/Seoul" },
    end: { date: null, dateTime: end.toISOString(), timeZone: "Asia/Seoul" },
  };
}

const FOOTER = "kacarong.kr 에서 보낸 일정입니다. 여기서 고쳐도 사이트에서 다시 덮어씁니다.";

export function taskEvent(t: TaskRow): EventBody {
  const desc = [t.kind === "할 일" ? "" : t.kind, t.note, FOOTER].filter(Boolean).join("\n\n");
  return {
    summary: (t.done ? "✓ " : "") + (t.course ? `[${t.course}] ` : "") + t.title,
    description: desc,
    location: "",
    ...eventWhen(t.due_date!, t.due_time, t.due_date!, null, 30),
    extendedProperties: { private: { kacarong: `task:${t.id}` } },
  };
}

export function examEvent(e: ExamRow): EventBody {
  const desc = [e.scope ? `범위: ${e.scope}` : "", e.note, FOOTER].filter(Boolean).join("\n\n");
  return {
    summary: `시험 · ${e.course ? `${e.course} ${e.title}` : e.title}`,
    description: desc,
    location: e.place,
    ...eventWhen(e.date!, e.time, e.date!, null, 60),
    extendedProperties: { private: { kacarong: `exam:${e.id}` } },
  };
}

const gone = (e: unknown) => e instanceof GoogleError && (e.status === 404 || e.status === 410);

// Puts dated tasks and exams in the Google calendar the owner picked (settings gcal_push = its id, '' = off)
// and keeps them the same as here: changed ones are patched, ones gone here (or without a date) are deleted there.
// Turning it off deletes every event it made. Runs a moment after a change (kick) and every few minutes.
// The last error is kept in settings gcal_push_error for the calendar screen.
export function createCalendarPush(opts: { db: Db; google: Google; today: () => string; enabled: boolean; debounceMs?: number }) {
  const { db, google } = opts;
  let running: Promise<void> | null = null;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function drop(key: string, calendarId: string, eventId: string) {
    try {
      await google.deleteEvent(calendarId, eventId);
    } catch (e) {
      if (!gone(e)) throw e; // already deleted in Google
    }
    db.deleteGcalLink(key);
  }

  async function run() {
    const target = db.getSetting("gcal_push") ?? "";
    const links = new Map(db.gcalLinks().map((l) => [l.key, l]));
    if (!target && !links.size) return;
    if (!opts.enabled || !db.getSetting("refresh_token") || !google.calendarWriteGranted()) throw new GoogleError("구글 캘린더 쓰기 권한이 없습니다", 401);
    if (!target) {
      for (const l of links.values()) await drop(l.key, l.calendar_id, l.event_id);
      return;
    }
    const from = addDays(opts.today(), -PUSH_BACK_DAYS);
    const { tasks, exams } = db.calendarPushItems(from);
    // Events still listed from the window on. Only used to skip unchanged items: an event missing from it may just be dated
    // before the window (an old item moved forward), so that is not taken as deleted; the PATCH below tells.
    const present = await google.eventIds(target, `${from}T00:00:00+09:00`);
    const want = new Map<string, EventBody>([...tasks.map((t) => [`task:${t.id}`, taskEvent(t)] as const), ...exams.map((e) => [`exam:${e.id}`, examEvent(e)] as const)]);
    for (const [key, body] of want) {
      const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
      const l = links.get(key);
      if (l && l.calendar_id === target) {
        if (l.hash === hash && present.has(l.event_id)) continue;
        try {
          // Deleted in Google: 404/410, or still there as "cancelled". Then it is made again below, since the item is still here.
          if ((await google.patchEvent(target, l.event_id, body)) !== "cancelled") {
            db.setGcalLink({ ...l, hash });
            continue;
          }
        } catch (e) {
          if (!gone(e)) throw e;
        }
      } else if (l) {
        await drop(key, l.calendar_id, l.event_id); // the owner picked another calendar
      }
      db.setGcalLink({ key, calendar_id: target, event_id: await google.insertEvent(target, body), hash });
    }
    // Links not wanted any more: the item is gone, lost its date, or is older than the window (then it stays in Google).
    for (const l of links.values()) {
      if (want.has(l.key)) continue;
      const [kind, id] = l.key.split(":");
      const t = kind === "task" ? db.getTask(Number(id)) : null;
      const date = kind === "task" ? (t && !t.study_id ? t.due_date : null) : db.getExam(Number(id))?.date;
      if (date && date < from) continue;
      await drop(l.key, l.calendar_id, l.event_id);
    }
  }

  // One pass at a time; a kick during a pass runs another one right after it.
  function sync(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        try {
          await run();
          db.setSetting("gcal_push_error", "");
        } catch (e) {
          if (!(e instanceof GoogleError)) console.error("구글 캘린더 보내기 실패:", e);
          db.setSetting("gcal_push_error", e instanceof Error ? e.message : String(e));
        }
      } while (again);
    })().finally(() => (running = null));
    return running;
  }

  return {
    sync,
    kick() {
      if (!db.getSetting("gcal_push") && !db.gcalLinks().length) return;
      clearTimeout(timer);
      timer = setTimeout(() => void sync(), opts.debounceMs ?? 2000);
    },
    start(intervalMs: number) {
      void sync();
      setInterval(() => void sync(), intervalMs);
    },
  };
}

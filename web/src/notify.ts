import type { Db, NotificationRow } from "./db";
import { makeVapid, sendPush, type Vapid } from "./push";

// What to be told about (settings notify_settings). morning: "HH:MM" for the day's summary, "" = none.
export type NotifySettings = { morning: string; homework: boolean; exam: boolean };
const DEFAULTS: NotifySettings = { morning: "08:00", homework: true, exam: true };
const EVENING = "20:00"; // the day before a 과제 deadline or an exam
const LATE_MINUTES = 60; // a notification whose time passed longer ago than this (server was down) is skipped

function addDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const at = (date: string, time: string) => new Date(`${date}T${time}:00+09:00`);
const seoulDate = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(d);
const md = (d: string) => `${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일`;
const dday = (today: string, date: string) => {
  const n = Math.round((Date.parse(date) - Date.parse(today)) / 86400_000);
  return n === 0 ? "D-day" : `D-${n}`;
};

type Note = { key: string; when: Date; title: string; body: string; url: string };

// Sends the scheduled notifications (checked every minute) to every device that subscribed to Web Push, and keeps
// each one in the notifications table for pages that show them themselves (the PC program polls it).
export function createNotifier(opts: { db: Db; subject: string; now: () => Date }) {
  const { db } = opts;
  let vapid: Vapid | null = null;
  function keys(): Vapid {
    if (vapid) return vapid;
    const saved = db.getSetting("vapid");
    vapid = saved ? (JSON.parse(saved) as Vapid) : makeVapid();
    if (!saved) db.setSetting("vapid", JSON.stringify(vapid));
    return vapid;
  }
  const settings = (): NotifySettings => ({ ...DEFAULTS, ...JSON.parse(db.getSetting("notify_settings") ?? "{}") });

  async function deliver(n: { title: string; body: string; url: string }): Promise<NotificationRow> {
    const row = db.addNotification(n);
    await Promise.all(
      db.pushSubs().map(async (s) => {
        try {
          const status = await sendPush(keys(), s, { id: row.id, title: n.title, body: n.body, url: n.url }, opts.subject);
          if (status === 404 || status === 410) db.deletePushSub(s.endpoint); // unsubscribed or expired
          else if (status >= 400) console.error(`알림 보내기 실패 (${status}): ${new URL(s.endpoint).host}`);
        } catch (e) {
          console.error("알림 보내기 실패:", e);
        }
      }),
    );
    return row;
  }

  // Everything that is due around now.
  function due(now: Date): Note[] {
    const s = settings();
    const d = seoulDate(now);
    const out: Note[] = [];
    if (s.morning) {
      db.queueStudies(d); // today's 공부 is part of today's list
      db.promoteLaterTasks(d);
      const open = db.listTasks({ done: false, to: addDays(d, 1) });
      const today = open.filter((t) => t.due_date === d);
      const late = open.filter((t) => t.due_date! < d);
      const hwTomorrow = open.filter((t) => t.due_date === addDays(d, 1) && t.kind === "과제");
      const exams = db.listExams({ from: d, to: addDays(d, 7) });
      const lines = [
        ...today.slice(0, 4).map((t) => `· ${t.course ? `[${t.course}] ` : ""}${t.title}${t.due_time ? ` ${t.due_time}` : ""}`),
        ...(today.length > 4 ? [`· 그 밖에 ${today.length - 4}개`] : []),
        ...exams.map((e) => `시험 ${dday(d, e.date!)} · ${e.course || e.title}${e.date === d && e.time ? ` ${e.time}` : ""}`),
        ...(hwTomorrow.length ? [`내일 마감 과제 ${hwTomorrow.length}개`] : []),
      ];
      if (today.length || late.length || lines.length) {
        out.push({
          key: `morning:${d}`,
          when: at(d, s.morning),
          title: `오늘 할 일 ${today.length}개` + (late.length ? ` · 지난 일 ${late.length}개` : ""),
          body: lines.join("\n") || "오늘 날짜의 할 일은 없습니다.",
          url: "/admin#today",
        });
      }
    }
    if (s.homework) {
      const hw = db.listTasks({ done: false, from: d, to: addDays(d, 1), kind: "과제" });
      const tomorrow = hw.filter((t) => t.due_date === addDays(d, 1));
      if (tomorrow.length) {
        out.push({
          key: `hw-eve:${d}`,
          when: at(d, EVENING),
          title: `내일 마감 과제 ${tomorrow.length}개`,
          body: tomorrow.map((t) => `· ${t.course ? `[${t.course}] ` : ""}${t.title}${t.due_time ? ` ${t.due_time}` : ""}`).join("\n"),
          url: "/admin#tasks",
        });
      }
      for (const t of hw.filter((t) => t.due_time)) {
        out.push({
          key: `hw-1h:${t.id}:${t.due_date}T${t.due_time}`,
          when: new Date(at(t.due_date!, t.due_time!).getTime() - 3600_000),
          title: `과제 마감 1시간 전`,
          body: `${t.course ? `[${t.course}] ` : ""}${t.title} · ${t.due_time}까지`,
          url: "/admin#tasks",
        });
      }
    }
    if (s.exam) {
      const exams = db.listExams({ from: addDays(d, 1), to: addDays(d, 1) });
      if (exams.length) {
        out.push({
          key: `exam-eve:${d}`,
          when: at(d, EVENING),
          title: exams.length > 1 ? `내일 시험 ${exams.length}개` : `내일 시험 · ${exams[0]!.course || exams[0]!.title}`,
          body: exams.map((e) => [`${e.course ? `${e.course} ` : ""}${e.title}`, e.time, e.place].filter(Boolean).join(" · ")).join("\n") + `\n${md(exams[0]!.date!)}`,
          url: "/admin#exams",
        });
      }
    }
    return out.filter((n) => now >= n.when && now.getTime() < n.when.getTime() + LATE_MINUTES * 60_000);
  }

  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      for (const n of due(opts.now())) if (db.markNotified(n.key)) await deliver(n);
    } catch (e) {
      console.error("알림 확인 실패:", e);
    } finally {
      busy = false;
    }
  }

  return {
    publicKey: () => keys().publicKey,
    settings,
    setSettings(s: NotifySettings) {
      db.setSetting("notify_settings", JSON.stringify(s));
    },
    deliver,
    tick,
    start(intervalMs: number) {
      setInterval(() => void tick(), intervalMs);
    },
  };
}

import type { EventBody } from "./google";

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

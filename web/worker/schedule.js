// When predictions run and wagers follow, in US Eastern time. Mirrors ml/schedule_time.py:
// noon on weekends and US federal holidays, 5 p.m. on other days; wagers WAGER_DELAY_MIN later.

export const WEEKEND_HOUR = 12;
export const WEEKDAY_HOUR = 17;
export const WAGER_DELAY_MIN = 10;
export const WAGER_WINDOW_MIN = 110; // keep retrying this long after the slot if predictions aren't deployed yet

const ET = "America/New_York";

/** { date: "YYYY-MM-DD", minutes: minutes since midnight } in Eastern time. */
export function easternNow(now = Date.now()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: ET, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(now)).map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const iso = (dt) => dt.toISOString().slice(0, 10);

// The nth weekday (Mon=1 … Sun=0, as Date.getUTCDay) of a month; n = -1 is the last.
function nthWeekday(year, month, weekday, n) {
  if (n > 0) {
    const first = utc(year, month, 1);
    return utc(year, month, 1 + ((weekday - first.getUTCDay() + 7) % 7) + 7 * (n - 1));
  }
  const last = utc(year, month + 1, 0);
  return utc(year, month, last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7));
}

export function usHolidays(year) {
  return new Set([
    utc(year, 1, 1), nthWeekday(year, 1, 1, 3), nthWeekday(year, 2, 1, 3), nthWeekday(year, 5, 1, -1),
    utc(year, 6, 19), utc(year, 7, 4), nthWeekday(year, 9, 1, 1), nthWeekday(year, 10, 1, 2),
    utc(year, 11, 11), nthWeekday(year, 11, 4, 4), utc(year, 12, 25),
  ].map(iso));
}

/** Eastern hour the predictions run on a YYYY-MM-DD date. */
export function dueHour(date) {
  const [y, m, d] = date.split("-").map(Number);
  const dow = utc(y, m, d).getUTCDay();
  return dow === 0 || dow === 6 || usHolidays(y).has(date) ? WEEKEND_HOUR : WEEKDAY_HOUR;
}

/** Whether `now` falls in today's wager window, and the slot time for display. */
export function wagerWindow(now = Date.now()) {
  const { date, minutes } = easternNow(now);
  const start = dueHour(date) * 60 + WAGER_DELAY_MIN;
  const h = Math.floor(start / 60), mm = String(start % 60).padStart(2, "0");
  return { date, open: minutes >= start && minutes <= start + WAGER_WINDOW_MIN, slot: `${h > 12 ? h - 12 : h}:${mm} ${h >= 12 ? "p.m." : "a.m."} ET` };
}

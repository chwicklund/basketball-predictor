// Unit tests for the wager Worker's pure parts (run with vitest alongside the parity tests).
import { describe, expect, it } from "vitest";
import { dueHour, easternNow, usHolidays, wagerWindow } from "./schedule.js";
import { contractsFor, marketTicker } from "./wagers.js";

describe("schedule (mirrors ml/schedule_time.py)", () => {
  it.each([
    ["2026-10-24", 12], // Saturday
    ["2026-10-27", 17], // Tuesday
    ["2026-11-26", 12], // Thanksgiving
    ["2026-12-25", 12], // Christmas
    ["2027-01-18", 12], // MLK Day
    ["2027-02-15", 12], // Presidents' Day
  ])("%s runs at %i:00", (date, hour) => expect(dueHour(date)).toBe(hour));

  it("lists the same 2027 holidays as Python", () => {
    expect([...usHolidays(2027)].sort().slice(0, 4)).toEqual(["2027-01-01", "2027-01-18", "2027-02-15", "2027-05-31"]);
  });

  it("opens the wager window 10 minutes after the predictions and keeps it open that evening", () => {
    // Saturday 24 Oct 2026, daylight time (UTC-4): noon slot, wagers from 12:10 p.m. to the end of the day
    expect(wagerWindow(Date.parse("2026-10-24T16:05:00Z")).open).toBe(false);
    expect(wagerWindow(Date.parse("2026-10-24T16:10:00Z")).open).toBe(true);
    expect(wagerWindow(Date.parse("2026-10-24T23:40:00Z")).open).toBe(true);
    // 10:30 p.m. Eastern is already the 25th in UTC, but still Saturday's slate
    expect(wagerWindow(Date.parse("2026-10-25T02:30:00Z"))).toMatchObject({ open: true, date: "2026-10-24" });
    // Tuesday 1 Dec 2026, standard time (UTC-5): 5:10 p.m. is 22:10 UTC
    expect(wagerWindow(Date.parse("2026-12-01T21:10:00Z")).open).toBe(false);
    expect(wagerWindow(Date.parse("2026-12-01T22:10:00Z"))).toMatchObject({ open: true, date: "2026-12-01", slot: "5:10 p.m. ET" });
    expect(easternNow(Date.parse("2026-12-02T03:00:00Z")).date).toBe("2026-12-01");
  });
});

describe("orders", () => {
  it("builds Kalshi tickers, translating Basketball-Reference codes", () => {
    expect(marketTicker("2026-10-26", "GSW", "DEN", "DEN")).toBe("KXNBAGAME-26OCT26GSWDEN-DEN");
    expect(marketTicker("2026-11-03", "BRK", "PHO", "BRK")).toBe("KXNBAGAME-26NOV03BKNPHX-BKN");
    expect(marketTicker("2027-01-09", "CHO", "NYK", "CHO")).toBe("KXNBAGAME-27JAN09CHANYK-CHA");
  });

  it("sizes so cost plus fee stays within the amount", () => {
    for (const price of [0.05, 0.39, 0.5, 0.81, 0.95]) {
      const n = contractsFor(1, price);
      const fee = Math.ceil(0.07 * n * price * (1 - price) * 100) / 100;
      expect(n * price + fee).toBeLessThanOrEqual(1);
      expect(n).toBeGreaterThan(0);
    }
  });
});

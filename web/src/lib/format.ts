export const STAT_LABEL: Record<string, string> = {
  MIN: "Minutes", PTS: "Points", TRB: "Rebounds", AST: "Assists",
  "3P": "3-pointers", STL: "Steals", BLK: "Blocks", TOV: "Turnovers",
};

// Game model features grouped into the drivers shown to users
export const DRIVER_GROUP: Record<string, string> = {
  elo_diff: "Team rating (Elo)",
  mar_season_diff: "Season point differential",
  mar_l10_diff: "Last-10 form",
  rest_home: "Rest & schedule",
  rest_away: "Rest & schedule",
  b2b_home: "Rest & schedule",
  b2b_away: "Rest & schedule",
  playoff: "Playoff game",
  missing_home: "Roster absences",
  missing_away: "Roster absences",
};

export const pct = (x: number, digits = 0) => `${(x * 100).toFixed(digits)}%`;
export const one = (x: number) => x.toFixed(1);

/** A sign on every change, with a true minus: +1.2, −0.4, 0.0 */
export function signed(x: number, digits = 1) {
  const v = Number(x.toFixed(digits));
  return `${v > 0 ? "+" : v < 0 ? "\u2212" : ""}${Math.abs(v).toFixed(digits)}`;
}

export function prettyDate(d: string) {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

/** "5:15 p.m." from an ISO time, in Eastern time. */
export function reportTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })
    .replace("AM", "a.m.").replace("PM", "p.m.");
}

export function seasonLabel(season: number) {
  return `${season - 1}-${String(season).slice(2)}`;
}

// Model inputs from the exported state. Mirrors ml/serving.py line for line;
// src/lib/features.test.ts checks the two agree on ml/export.py's fixtures.

import type { GameModel, Opponents, PlayerState, QuantileTable, RosterEntry, StatRange, TeamState } from "./types";

export const REST_CAP = 4;
export const DAYS_OFF_CAP = 15;
export const POS_CODE = { G: 0, F: 1, C: 2 } as const;

function parseDate(d: string): number {
  const [y, m, day] = d.split("-").map(Number);
  return Date.UTC(y, m - 1, day);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((parseDate(a) - parseDate(b)) / 86_400_000);
}

/** Season (by end year) a YYYY-MM-DD date belongs to; August starts the next one. */
export function seasonFor(date: string): number {
  const [y, m] = date.split("-").map(Number);
  return m >= 8 ? y + 1 : y;
}

const clip = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);

function teamRest(team: TeamState, date: string): number {
  return team.last_game ? clip(daysBetween(date, team.last_game), 0, REST_CAP) : REST_CAP;
}

// Roster strength, as in ml/roster.py
const TEAM_MIN = 240;
type Lineup = [rate: number, min: number][];

export function strength(lineup: Lineup): number {
  const total = lineup.reduce((s, [, m]) => s + m, 0);
  if (total <= 0) return 0;
  return (lineup.reduce((s, [r, m]) => s + r * m, 0) / total) * TEAM_MIN / 36;
}

/** Expected roster minus `out` plus `add` (names). */
export function lineupFromRoster(roster: RosterEntry[], out: string[] = [], add: string[] = []): Lineup {
  return roster
    .filter((r) => (r.in_pool && !out.includes(r.name)) || add.includes(r.name))
    .map((r) => [r.rate, r.min]);
}

/** Strength lost to absences: expected roster minus the lineup that plays. */
export function missingStrength(roster: RosterEntry[], lineup?: Lineup): number {
  const full = lineupFromRoster(roster);
  return strength(full) - strength(lineup ?? full);
}

export function gameFeatures(
  home: TeamState, away: TeamState, date: string, playoff = 0, homeLineup?: Lineup, awayLineup?: Lineup,
): Record<string, number> {
  const rh = teamRest(home, date);
  const ra = teamRest(away, date);
  return {
    elo_diff: home.elo - away.elo,
    mar_season_diff: home.mar_season - away.mar_season,
    mar_l10_diff: home.mar_l10 - away.mar_l10,
    rest_home: rh,
    rest_away: ra,
    b2b_home: rh <= 1 ? 1 : 0,
    b2b_away: ra <= 1 ? 1 : 0,
    playoff,
    missing_home: missingStrength(home.roster, homeLineup),
    missing_away: missingStrength(away.roster, awayLineup),
  };
}

export interface GamePrediction {
  pHome: number;
  margin: number;
  contributions: Record<string, number>;
}

export function winProbability(model: GameModel, f: Record<string, number>): GamePrediction {
  let z = model.intercept;
  let margin = model.margin_intercept;
  const contributions: Record<string, number> = {};
  model.features.forEach((name, i) => {
    const x = (f[name] - model.mean[i]) / model.scale[i];
    contributions[name] = model.coef[i] * x;
    z += model.coef[i] * x;
    margin += model.margin_coef[i] * x;
  });
  return { pHome: 1 / (1 + Math.exp(-z)), margin, contributions };
}

/** Points each team scores: average of its offence and the other side's defence, split by the margin. */
export function projectedScore(home: TeamState, away: TeamState, margin: number) {
  const total = (home.pts_for + away.pts_against + away.pts_for + home.pts_against) / 2;
  return { home: total / 2 + margin / 2, away: total / 2 - margin / 2 };
}

const st = (p: PlayerState, k: string) => p[`st_${k}`] as number;

export function playerFeatures(
  p: PlayerState,
  team: TeamState,
  opp: TeamState,
  oppAllow: Opponents[string],
  date: string,
  isHome: number,
  rateStats: string[],
  vacatedMin = 0,
): Record<string, number> {
  const newSeason = p.st_season !== seasonFor(date);
  const rest = teamRest(team, date);
  const f: Record<string, number> = {
    min_ewm: st(p, "min_ewm"),
    min_l3: st(p, "min_l3"),
    min_l10: st(p, "min_l10"),
    start_l10: st(p, "start_l10"),
    s_n: newSeason ? 0 : st(p, "s_n"),
    s_min: newSeason ? st(p, "min_ewm") : st(p, "s_min"),
    days_off: clip(daysBetween(date, p.st_last_date), 0, DAYS_OFF_CAP),
    missed_last: p.missed_last,
  };
  for (const s of rateStats) f[`rate_${s}`] = st(p, `rate_${s}`);
  for (const s of rateStats) f[`l10_${s}`] = st(p, `l10_${s}`);
  for (const s of rateStats)
    f[`s_avg_${s}`] = newSeason ? (st(p, `rate_${s}`) * st(p, "min_ewm")) / 36 : st(p, `s_avg_${s}`);
  f.usg_prev = p.usg_prev;
  f.ast_pct_prev = p.ast_pct_prev;
  f.trb_pct_prev = p.trb_pct_prev;
  f.pos_code = POS_CODE[p.pos];
  f.is_home = isHome;
  f.team_rest = rest;
  f.team_b2b = rest <= 1 ? 1 : 0;
  f.elo_diff = team.elo - opp.elo;
  f.vacated_min = vacatedMin;
  f.opp_pts_against = opp.pts_against;
  f.opp_pace = opp.pts_for + opp.pts_against;
  f.opp_mar_season = opp.mar_season;
  for (const s of rateStats) f[`opp_allow_${s}`] = oppAllow[p.pos][s];
  return f;
}

/** Minutes absent rotation players usually play (rotation = rotationMin+ over their last 10). */
export function vacatedMinutes(out: PlayerState[], rotationMin: number): number {
  return out.reduce((sum, q) => (st(q, "min_l10") >= rotationMin ? sum + st(q, "min_l10") : sum), 0);
}

export function quantileRange(q: QuantileTable, mean: number): StatRange {
  let i = q.edges.filter((e) => e <= mean).length - 1;
  i = clip(i, 0, q.edges.length - 2);
  return { mean, p10: q.p10[i], p90: q.p90[i] };
}

/**
 * Turn raw model outputs (predicted minutes, per-36 rates) into projections.
 * minutesOverride replaces the minutes model's answer.
 */
export function project(
  minutes: number,
  rates: Record<string, number>,
  quantiles: Record<string, QuantileTable>,
  minutesOverride?: number | null,
): Record<string, StatRange> {
  const mins = minutesOverride ?? clip(minutes, 0, 48);
  const out: Record<string, StatRange> = { MIN: quantileRange(quantiles.MIN, mins) };
  for (const [s, rate] of Object.entries(rates)) out[s] = quantileRange(quantiles[s], (rate * mins) / 36);
  return out;
}

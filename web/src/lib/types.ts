// Shapes of the JSON files written by ml/export.py

export interface RosterEntry {
  name: string;
  rate: number;     // Game Score per 36, shrunk
  min: number;      // usual minutes
  last: string | null;
  in_pool: boolean; // expected to play unless toggled out
}

export interface TeamState {
  name: string;
  elo: number;
  mar_season: number;
  mar_l10: number;
  pts_for: number;
  pts_against: number;
  n_games: number;
  last_game: string | null;
  roster: RosterEntry[];
}

export type Pos = "G" | "F" | "C";

// [date, opp, is_home, started, MIN, PTS, TRB, AST, 3P, STL, BLK, TOV]
export type GameLine = [string, string, number, number, ...number[]];

export interface PlayerState {
  player: string;
  team: string;
  pos: Pos;
  st_season: number;
  st_last_date: string;
  missed_last: number;
  usg_prev: number;
  ast_pct_prev: number;
  trb_pct_prev: number;
  recent: GameLine[];
  [stateKey: `st_${string}`]: number | string;
}

export interface GameModel {
  features: string[];
  mean: number[];
  scale: number[];
  coef: number[];
  intercept: number;
  margin_coef: number[];
  margin_intercept: number;
}

export interface FeatureSpec {
  game: string[];
  player: string[];
  targets: string[];
  rate_stats: string[];
  rotation_min: number;
}

export interface QuantileTable {
  edges: number[];
  p10: number[];
  p90: number[];
}

export interface Meta {
  as_of: string;
  season: number;
  data_through: string;
  generated_at: string;
  game_metrics: {
    test_season: number;
    games: number;
    accuracy: number;
    log_loss: number;
    brier: number;
    margin_mae: number;
    home_accuracy: number;
    elo_accuracy: number;
    calibration: { p: number; actual: number; n: number }[];
  };
  player_metrics: Record<string, { mae: number; last10_mae: number; season_mae: number; rmse: number; last10_rmse: number; coverage: number }>;
  player_test_season: number;
}

// [date, visitor, home, start_et]
export type ScheduledGame = [string, string, string, string];
// [date, visitor, home, visitor_pts, home_pts, p_home]
export type GameBacktest = [string, string, string, number, number, number];
// [date, opp, is_home, ...8 predictions, ...8 actuals]
export type PlayerBacktest = [string, string, number, ...number[]];
// opp -> [games, ...8 averages]
export type History = Record<string, Record<string, number[]>>;

export type Opponents = Record<string, Record<Pos, Record<string, number>>>;

export interface StatRange {
  mean: number;
  p10: number;
  p90: number;
}

// From ml/injuries.py: who the latest NBA injury report lists Out or Doubtful, by team (box-score names)
export interface Injuries {
  report: string | null;
  out: Record<string, string[]>;
  unmatched?: string[];
  error?: string;
}

// From ml/grade.py: logged daily predictions scored against results
// log rows: [date, visitor, home, p_home, visitor_pts, home_pts, backfilled];
// pending: [date, visitor, home, p_home, proj_visitor, proj_home, tipoff]
export interface TrackRecord {
  since?: string;
  season?: number;
  games: number;
  backfilled?: number;
  correct?: number;
  log_loss?: number;
  brier?: number;
  margin_mae?: number;
  player_games?: number;
  log: [string, string, string, number, number, number, boolean?][];
  pending: [string, string, string, number, number, number, (string | null)?][];
  players: Record<string, { mae: number; coverage: number }>;
}

"""Build current team/player/opponent state and assemble model inputs from it.

This is the reference for what web/src/lib/features.ts does in the browser:
both take the exported state dicts plus the user's inputs and produce the
same feature vectors. build_states(as_of=...) rebuilds the state as it was
before a past date, which is how tests check serving against training.
"""

import datetime
import math

import polars as pl

from ml.data import team_games
from ml.elo import current_ratings
from ml.player_features import (DAYS_OFF_CAP, POS_CODE, RATE_STATS, USAGE_DEFAULTS, allowed_ratio,
                                opponent_allowed, player_state, positions, prior_usage)
from ml.roster import missing, replay, team_rosters
from ml.team_features import REST_CAP, team_form

RECENT_LINES = 10


def season_for(date):
    """The season (by end year) a date belongs to; August starts the next one."""
    return date.year + 1 if date.month >= 8 else date.year


def _clean(d):
    """Round floats for JSON, so the exported state is exactly what fixtures use."""
    out = {}
    for k, v in d.items():
        if isinstance(v, float):
            v = None if math.isnan(v) else round(v, 5)
        elif isinstance(v, datetime.date):
            v = v.isoformat()
        out[k] = v
    return out


def build_states(logs, games, box, as_of):
    """(teams, players, opponents) dicts as of the start of as_of."""
    _, roster_players, team_last = replay(box, games, until=as_of)
    rosters = team_rosters(roster_players, team_last)
    logs = logs.filter(pl.col("date") < as_of)
    games = games.filter(pl.col("date") < as_of)
    season = season_for(as_of)

    # Team form via the same team_form() as training, using a placeholder next game
    tg = team_games(games)
    teams = sorted(set(tg["team"]))
    placeholder = pl.DataFrame({"team": teams, "season": [season] * len(teams), "date": [as_of] * len(teams)},
                               schema_overrides={"season": tg.schema["season"]})
    form = team_form(pl.concat([tg, placeholder], how="diagonal")).filter(pl.col("game_id").is_null())
    last_game = tg.group_by("team").agg(pl.col("date").max().alias("last_game"))
    elo = current_ratings(games, season)
    team_rows = form.join(last_game, on="team", how="left").select(
        "team", "mar_season", "mar_l10", "pts_for", "pts_against", "n_games", "last_game").to_dicts()
    team_state = {r["team"]: _clean(r | {"elo": elo.get(r["team"], 1500.0)}) | {"roster": rosters.get(r["team"], [])}
                  for r in team_rows}

    # Opponent-allowed ratios for this season so far (1.0 everywhere before it starts)
    pos = positions()
    latest = (opponent_allowed(logs, pos).filter(pl.col("season") == season).sort("date").group_by("opp", "pos").last()
                 .rename({c: f"cum_{c}" for c in ["MIN", *RATE_STATS]}))
    grid = pl.DataFrame({"opp": [t for t in teams for _ in POS_CODE], "pos": list(POS_CODE) * len(teams)})
    allow = allowed_ratio(grid.join(latest, on=["opp", "pos"], how="left"))
    opponents = {}
    for r in allow.to_dicts():
        opponents.setdefault(r["opp"], {})[r["pos"]] = _clean({s: r[f"opp_allow_{s}"] for s in RATE_STATS})

    # Player state after their last game, plus what features_from_state needs
    state = player_state(logs).group_by("player_id").last()
    last_row = logs.sort("date").group_by("player_id").last().select(
        "player_id", "player", "team", missed_last=(~pl.col("played")).cast(pl.Float64))
    cur_pos = (pos.filter(pl.col("season") <= season).sort("season").group_by("player_id").last()
                  .select("player_id", "pos"))
    usage = prior_usage().filter(pl.col("season") == season).drop("season")
    players = (state.rename({"season": "st_season", "date": "st_last_date"}).drop("team")
                    .join(last_row, on="player_id").join(cur_pos, on="player_id", how="left")
                    .join(usage, on="player_id", how="left")
                    .with_columns(pl.col("pos").fill_null("F"),
                                  *[pl.col(c).fill_null(v) for c, v in USAGE_DEFAULTS.items()]))
    player_state_ = {r["player_id"]: _clean(r) for r in players.to_dicts()}
    return team_state, player_state_, opponents


def days_between(a, b):
    return (datetime.date.fromisoformat(a) - datetime.date.fromisoformat(b)).days


def game_features(home, away, date, playoff=0, home_lineup=None, away_lineup=None):
    """Game model inputs (GAME_FEATURES order) from two team states.

    The lineups are (rate, min) lists of who plays; None means each team's
    expected roster (see roster.lineup_from_roster for toggling players).
    """
    def rest(t):
        return float(min(max(days_between(date, t["last_game"]), 0), REST_CAP)) if t["last_game"] else float(REST_CAP)
    rh, ra = rest(home), rest(away)
    return {
        "elo_diff": home["elo"] - away["elo"],
        "mar_season_diff": home["mar_season"] - away["mar_season"],
        "mar_l10_diff": home["mar_l10"] - away["mar_l10"],
        "rest_home": rh, "rest_away": ra,
        "b2b_home": float(rh <= 1), "b2b_away": float(ra <= 1),
        "playoff": float(playoff),
        "missing_home": missing(home["roster"], home_lineup),
        "missing_away": missing(away["roster"], away_lineup),
    }


def player_features(p, team, opp, opp_allow, date, is_home, vacated_min=0.0):
    """Stat model inputs (player_features.FEATURES order) for one player and game."""
    season = season_for(datetime.date.fromisoformat(date))
    new_season = p["st_season"] != season
    team_rest = float(min(max(days_between(date, team["last_game"]), 0), REST_CAP)) if team["last_game"] else float(REST_CAP)
    f = {
        "min_ewm": p["st_min_ewm"], "min_l3": p["st_min_l3"], "min_l10": p["st_min_l10"],
        "start_l10": p["st_start_l10"],
        "s_n": 0.0 if new_season else p["st_s_n"],
        "s_min": p["st_min_ewm"] if new_season else p["st_s_min"],
        "days_off": float(min(max(days_between(date, p["st_last_date"]), 0), DAYS_OFF_CAP)),
        "missed_last": p["missed_last"],
    }
    f |= {f"rate_{s}": p[f"st_rate_{s}"] for s in RATE_STATS}
    f |= {f"l10_{s}": p[f"st_l10_{s}"] for s in RATE_STATS}
    f |= {f"s_avg_{s}": p[f"st_rate_{s}"] * p["st_min_ewm"] / 36 if new_season else p[f"st_s_avg_{s}"]
          for s in RATE_STATS}
    f |= {c: p[c] for c in USAGE_DEFAULTS}
    f |= {"pos_code": float(POS_CODE[p["pos"]]), "is_home": float(is_home), "team_rest": team_rest,
          "team_b2b": float(team_rest <= 1), "elo_diff": team["elo"] - opp["elo"], "vacated_min": float(vacated_min),
          "opp_pts_against": opp["pts_against"], "opp_pace": opp["pts_for"] + opp["pts_against"],
          "opp_mar_season": opp["mar_season"]}
    f |= {f"opp_allow_{s}": opp_allow[p["pos"]][s] for s in RATE_STATS}
    return f


def win_probability(model, features):
    """(p_home_win, margin, contributions) from the exported game model dict."""
    z, contrib = model["intercept"], {}
    margin = model["margin_intercept"]
    for name, mean, scale, w, mw in zip(model["features"], model["mean"], model["scale"], model["coef"],
                                        model["margin_coef"]):
        x = (features[name] - mean) / scale
        contrib[name] = w * x
        z += w * x
        margin += mw * x
    return 1 / (1 + math.exp(-z)), margin, contrib


"""Pre-game team features. Every value uses only games before the one it's for."""

import polars as pl

from ml.data import team_games
from ml.elo import run_elo
from ml.roster import ROSTER_FEATURES, roster_frame

SEASON_PRIOR = 4  # games of league-average form added to season-to-date margin
L10_PRIOR = 2
REST_CAP = 4
LEAGUE_PTS = 113  # prior for points for/against early in a season

GAME_FEATURES = ["elo_diff", "mar_season_diff", "mar_l10_diff",
                 "rest_home", "rest_away", "b2b_home", "b2b_away", "playoff", *ROSTER_FEATURES]


def team_form(tg):
    """Add each team's form going into each game.

    Rows with null pts (upcoming games) get features but don't count toward
    later rows.
    """
    tg = tg.sort("team", "date")
    margin = (pl.col("pts") - pl.col("opp_pts"))
    by_season = ["team", "season"]
    prev = lambda e: e.shift(1).over(by_season)
    played = margin.is_not_null().cast(pl.Int32)
    return (tg.with_columns(_m=margin.fill_null(0), _n=played,
                            _pts=pl.col("pts").fill_null(0), _opp=pl.col("opp_pts").fill_null(0))
              .with_columns(
                  n_games=prev(pl.col("_n").cum_sum()).fill_null(0),
                  _msum=prev(pl.col("_m").cum_sum()).fill_null(0),
                  _ptsum=prev(pl.col("_pts").cum_sum()).fill_null(0),
                  _oppsum=prev(pl.col("_opp").cum_sum()).fill_null(0),
                  _l10sum=prev(pl.col("_m").rolling_sum(10, min_samples=1)).fill_null(0),
                  _l10n=prev(pl.col("_n").rolling_sum(10, min_samples=1)).fill_null(0),
                  _last=pl.col("date").shift(1).over("team"))
              .with_columns(
                  mar_season=pl.col("_msum") / (pl.col("n_games") + SEASON_PRIOR),
                  mar_l10=pl.col("_l10sum") / (pl.col("_l10n") + L10_PRIOR),
                  pts_for=(pl.col("_ptsum") + SEASON_PRIOR * LEAGUE_PTS) / (pl.col("n_games") + SEASON_PRIOR),
                  pts_against=(pl.col("_oppsum") + SEASON_PRIOR * LEAGUE_PTS) / (pl.col("n_games") + SEASON_PRIOR),
                  rest=(pl.col("date") - pl.col("_last")).dt.total_days().clip(0, REST_CAP).fill_null(REST_CAP))
              .with_columns(b2b=(pl.col("rest") <= 1).cast(pl.Int8),
                            rest=pl.col("rest").cast(pl.Float64))
              .drop(pl.selectors.starts_with("_")))


def game_frame(games, box):
    """One row per game with the model features, target and Elo baseline."""
    roster = roster_frame(box, games)
    games, _, _ = run_elo(games)
    form = team_form(team_games(games))
    keep = ["game_id", "team", "mar_season", "mar_l10", "rest", "b2b", "pts_for", "pts_against", "n_games"]
    h = form.select(keep).rename({c: f"{c}_home" for c in keep[2:]} | {"team": "home_abbr"})
    a = form.select(keep).rename({c: f"{c}_away" for c in keep[2:]} | {"team": "visitor_abbr"})
    return (games.join(h, on=["game_id", "home_abbr"]).join(a, on=["game_id", "visitor_abbr"])
                 .join(roster, on="game_id")
                 .with_columns(elo_diff=pl.col("elo_home") - pl.col("elo_away"),
                               mar_season_diff=pl.col("mar_season_home") - pl.col("mar_season_away"),
                               mar_l10_diff=pl.col("mar_l10_home") - pl.col("mar_l10_away"),
                               playoff=(pl.col("type") != "Regular").cast(pl.Int8),
                               total=pl.col("home_pts") + pl.col("visitor_pts"))
                 .sort("date", "game_id"))


def team_dates(games):
    """One row per team per game date with that team's pre-game Elo and form."""
    games, _, _ = run_elo(games)
    elo = pl.concat([games.select("game_id", team="home_abbr", elo="elo_home"),
                     games.select("game_id", team="visitor_abbr", elo="elo_away")])
    return (team_form(team_games(games)).join(elo, on=["game_id", "team"])
            .select("team", "date", "season", "elo", "mar_season", "mar_l10", "pts_for",
                    "pts_against", "rest", "b2b", "n_games"))

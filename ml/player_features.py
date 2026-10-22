"""Pre-game player features for the stat models.

A player's state (st_* columns) is a summary of every game they've played up
to and including one date. A game's features come from the state as of the
day before it, plus the opponent and game context. Export uses the same
features_from_state() on the latest state, so training and inference match.
"""

import polars as pl

from ml.data import load_player_seasons
from ml.team_features import team_dates

TARGETS = ["MIN", "PTS", "TRB", "AST", "3P", "STL", "BLK", "TOV"]
RATE_STATS = TARGETS[1:]
HALF_LIFE = 12          # games
DAYS_OFF_CAP = 15
RECENT_DAYS = 14        # an absent teammate counts as newly vacated minutes if they played this recently
ROTATION_MIN = 15       # ...and averaged at least this many minutes over their last 10 games
OPP_PRIOR_MIN = 1500    # minutes of league-average defence mixed into opponent-allowed rates
POS_CODE = {"G": 0, "F": 1, "C": 2}
# League per-minute rates by position (2020-26 average), the prior for opponent-allowed rates.
# Fixed rather than recomputed so training and serving use the same values.
LEAGUE_RATES = {
    "G": {"PTS": 0.5017, "TRB": 0.1281, "AST": 0.1362, "3P": 0.0627, "STL": 0.0361, "BLK": 0.0119, "TOV": 0.0627},
    "F": {"PTS": 0.4796, "TRB": 0.1907, "AST": 0.0882, "3P": 0.0495, "STL": 0.0313, "BLK": 0.0203, "TOV": 0.0537},
    "C": {"PTS": 0.4646, "TRB": 0.3089, "AST": 0.0756, "3P": 0.0198, "STL": 0.0274, "BLK": 0.0447, "TOV": 0.0569},
}
USAGE_DEFAULTS = {"usg_prev": 18.0, "ast_pct_prev": 12.0, "trb_pct_prev": 9.0}

FEATURES = (
    ["min_ewm", "min_l3", "min_l10", "start_l10", "s_n", "s_min", "days_off", "missed_last"]
    + [f"rate_{s}" for s in RATE_STATS] + [f"l10_{s}" for s in RATE_STATS] + [f"s_avg_{s}" for s in RATE_STATS]
    + list(USAGE_DEFAULTS) + ["pos_code"]
    + ["is_home", "team_rest", "team_b2b", "elo_diff", "vacated_min"]
    + ["opp_pts_against", "opp_pace", "opp_mar_season"] + [f"opp_allow_{s}" for s in RATE_STATS]
)


def positions():
    """(player_id, season, pos) with pos one of G/F/C, filled across a career."""
    first = pl.col("Pos").str.split("-").list.first()
    group = first.replace_strict({"PG": "G", "SG": "G", "G": "G", "SF": "F", "PF": "F", "F": "F", "C": "C"},
                                 default=None)
    return (load_player_seasons("per_game_stats").select("player_id", "season", pos=group)
            .sort("player_id", "season")
            .with_columns(pl.col("pos").forward_fill().backward_fill().over("player_id").fill_null("F")))


def prior_usage():
    """Last season's USG%, AST% and TRB%, keyed by the season they're used in."""
    return load_player_seasons("advanced").select(
        "player_id", (pl.col("season") + 1).alias("season"),
        usg_prev="USG%", ast_pct_prev="AST%", trb_pct_prev="TRB%")


def player_state(logs):
    """One row per played game with the player's state after that game."""
    by, season_by = "player_id", ["player_id", "season"]
    ew = lambda c: pl.col(c).ewm_mean(half_life=HALF_LIFE).over(by)
    n = pl.int_range(1, pl.len() + 1).over(season_by)
    return (logs.filter("played").sort(by, "date").select(
        by, "season", "date", "team",
        st_min_ewm=ew("MIN"),
        st_min_l3=pl.col("MIN").rolling_mean(3, min_samples=1).over(by),
        st_min_l10=pl.col("MIN").rolling_mean(10, min_samples=1).over(by),
        st_start_l10=pl.col("started").cast(pl.Float64).rolling_mean(10, min_samples=1).over(by),
        st_s_n=n.cast(pl.Float64),
        st_s_min=pl.col("MIN").cum_sum().over(season_by) / n,
        **{f"st_rate_{s}": ew(s) / ew("MIN").clip(lower_bound=1) * 36 for s in RATE_STATS},
        **{f"st_l10_{s}": pl.col(s).rolling_mean(10, min_samples=1).over(by) for s in RATE_STATS},
        **{f"st_s_avg_{s}": pl.col(s).cum_sum().over(season_by) / n for s in RATE_STATS}))


def features_from_state(df):
    """Turn state + game columns into model features.

    df needs the st_* columns, st_season, st_last_date, date, season, plus the
    context and opponent columns (see FEATURES).
    """
    new_season = pl.col("st_season") != pl.col("season")
    season_cols = {
        "s_n": pl.when(new_season).then(0.0).otherwise(pl.col("st_s_n")),
        "s_min": pl.when(new_season).then(pl.col("st_min_ewm")).otherwise(pl.col("st_s_min")),
        **{f"s_avg_{s}": pl.when(new_season).then(pl.col(f"st_rate_{s}") * pl.col("st_min_ewm") / 36)
           .otherwise(pl.col(f"st_s_avg_{s}")) for s in RATE_STATS},
    }
    rename = {c: c[3:] for c in df.columns if c.startswith("st_") and c[3:] in FEATURES}
    return (df.with_columns(**season_cols,
                            days_off=(pl.col("date") - pl.col("st_last_date")).dt.total_days()
                            .clip(0, DAYS_OFF_CAP).cast(pl.Float64))
              .rename({k: v for k, v in rename.items() if v not in season_cols})
              .with_columns(*[pl.col(c).fill_null(v) for c, v in USAGE_DEFAULTS.items()]))


def opponent_allowed(logs, pos):
    """Cumulative stats allowed by each team to each position group, per season.

    One row per (opp, season, pos, date) with totals through that date.
    """
    p = logs.filter("played").join(pos, on=["player_id", "season"], how="left") \
            .with_columns(pl.col("pos").fill_null("F"))
    daily = (p.group_by("opp", "season", "pos", "date").agg(pl.col("MIN"), *[pl.col(s) for s in RATE_STATS])
              .with_columns(pl.col("MIN").list.sum(), *[pl.col(s).list.sum() for s in RATE_STATS])
              .sort("opp", "season", "pos", "date"))
    return daily.with_columns(*[pl.col(c).cum_sum().over("opp", "season", "pos") for c in ["MIN", *RATE_STATS]])


def allowed_ratio(df):
    """opp_allow_<stat>: opponent's shrunk per-minute rate allowed / league rate (1.0 = average)."""
    lg = pl.DataFrame([{"pos": p, **{f"lg_{s}": v for s, v in r.items()}} for p, r in LEAGUE_RATES.items()])
    df = df.join(lg, on="pos", how="left")
    k = OPP_PRIOR_MIN
    return df.with_columns(**{
        f"opp_allow_{s}": ((pl.col(f"cum_{s}").fill_null(0) + k * pl.col(f"lg_{s}"))
                           / (pl.col("cum_MIN").fill_null(0) + k)) / pl.col(f"lg_{s}")
        for s in RATE_STATS}).drop(pl.selectors.starts_with("lg_", "cum_"))


def team_context(df, tdates):
    """Join own-team and opponent pre-game form on (team, date) and (opp, date)."""
    own = tdates.select("team", "date", team_elo="elo", team_rest="rest", team_b2b="b2b")
    opp = tdates.select(pl.col("team").alias("opp"), "date", opp_elo="elo", opp_pts_against="pts_against",
                        opp_pace=pl.col("pts_for") + pl.col("pts_against"), opp_mar_season="mar_season")
    return (df.join(own, on=["team", "date"]).join(opp, on=["opp", "date"])
              .with_columns(elo_diff=pl.col("team_elo") - pl.col("opp_elo"),
                            team_b2b=pl.col("team_b2b").cast(pl.Float64)))


def training_frame(logs, games):
    """Every played game (with minutes) from 2020 on with features and targets."""
    state = player_state(logs).rename({"season": "st_season", "date": "st_last_date", "team": "st_team"})
    pos = positions()
    rows = (logs.sort("player_id", "date")
                .with_columns(missed_last=(~pl.col("played").shift(1).over("player_id")).fill_null(False)
                              .cast(pl.Float64))
                .filter(pl.col("season") >= 2020)
                .join_asof(state.sort("st_last_date"), left_on="date", right_on="st_last_date",
                           by="player_id", allow_exact_matches=False, check_sortedness=False)
                .filter(pl.col("st_last_date").is_not_null())
                .join(pos, on=["player_id", "season"], how="left")
                .with_columns(pl.col("pos").fill_null("F"))
                .join(prior_usage(), on=["player_id", "season"], how="left"))

    # Minutes of recent rotation players who sat out, per team game
    vacated = (rows.filter(~pl.col("played") & (pl.col("st_min_l10") >= ROTATION_MIN)
                           & ((pl.col("date") - pl.col("st_last_date")).dt.total_days() <= RECENT_DAYS))
                   .group_by("team", "date").agg(vacated_min=pl.col("st_min_l10").sum()))
    rows = rows.filter(pl.col("played") & (pl.col("MIN") > 0)).join(vacated, on=["team", "date"], how="left") \
               .with_columns(pl.col("vacated_min").fill_null(0.0))

    cum = opponent_allowed(logs, pos).rename({c: f"cum_{c}" for c in ["MIN", *RATE_STATS]}).rename({"date": "cum_date"})
    rows = rows.sort("date").join_asof(
        cum.sort("cum_date"), left_on="date", right_on="cum_date", by=["opp", "season", "pos"],
        allow_exact_matches=False, check_sortedness=False)
    rows = allowed_ratio(rows)
    rows = team_context(rows, team_dates(games))
    rows = features_from_state(rows.with_columns(pos_code=pl.col("pos").replace_strict(POS_CODE).cast(pl.Float64),
                                                 is_home=pl.col("is_home").cast(pl.Float64)))
    return rows

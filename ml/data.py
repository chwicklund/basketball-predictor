"""Load the scraped basketball-reference CSVs into tidy polars frames.

Seasons are named by the year they end, as in the scrapers.
"""

import re
from pathlib import Path

import polars as pl

ROOT = Path(__file__).resolve().parent.parent
GAMES_DIR = ROOT / "bbref_games"
PLAYERS_DIR = ROOT / "bbref_active_players"
PRED_DIR = ROOT / "predictions"  # logged daily predictions (ml.predict), graded by ml.grade

STATS = ["FG", "FGA", "3P", "3PA", "FT", "FTA", "ORB", "DRB", "TRB",
         "AST", "STL", "BLK", "TOV", "PF", "PTS", "GmSc", "+/-"]
# Gamelog GS values for games the player did not play
NOT_PLAYED = ["Inactive", "Did Not Play", "Did Not Dress", "Not With Team", "Suspended"]


def minutes(col):
    """Parse 'mm:ss' into fractional minutes."""
    parts = pl.col(col).str.split(":")
    return (parts.list.get(0, null_on_oob=True).cast(pl.Float64, strict=False)
            + parts.list.get(1, null_on_oob=True).cast(pl.Float64, strict=False) / 60)


def load_games():
    """One row per played game, with home_win and margin added."""
    g = pl.read_csv(GAMES_DIR / "games.csv", try_parse_dates=True)
    return (g.with_columns(pl.col("date").cast(pl.Date),
                           (pl.col("home_pts") - pl.col("visitor_pts")).alias("margin"))
             .with_columns((pl.col("margin") > 0).cast(pl.Int8).alias("home_win"))
             .sort("date", "game_id"))


def team_games(games):
    """Long format: one row per team per game, from that team's point of view."""
    cols = ["game_id", "season", "type", "date"]
    home = games.select(*cols, team="home_abbr", opp="visitor_abbr", pts="home_pts",
                        opp_pts="visitor_pts", is_home=pl.lit(1, pl.Int8))
    away = games.select(*cols, team="visitor_abbr", opp="home_abbr", pts="visitor_pts",
                        opp_pts="home_pts", is_home=pl.lit(0, pl.Int8))
    return pl.concat([home, away]).sort("team", "date")


def load_player_logs():
    """Every game of every active player, including games they missed.

    played is False for Inactive/DNP rows; those rows are kept because they
    show who was unavailable.
    """
    frames = []
    for f in sorted(PLAYERS_DIR.glob("*_gamelog.csv")):
        m = re.match(r"(.+)_([a-z.'-]+\d{2})_gamelog\.csv$", f.name)
        if not m:
            continue
        d = pl.read_csv(f, infer_schema=False)
        if d.height == 0:
            continue
        frames.append(d.with_columns(player_id=pl.lit(m.group(2)),
                                     player=pl.lit(m.group(1).replace("_", " "))))
    logs = pl.concat(frames, how="diagonal")
    return (logs
            .with_columns(
                pl.col("Season").cast(pl.Int32).alias("season"),
                pl.col("Date").str.to_date().alias("date"),
                (pl.col("Home/Away").is_null()).cast(pl.Int8).alias("is_home"),
                (pl.col("Home/Away") == "N").fill_null(False).alias("neutral"),
                (pl.col("GS") == "*").fill_null(False).alias("started"),
                minutes("MP").alias("MIN"),
                *[pl.col(s).str.replace(r"^\+", "").cast(pl.Float64, strict=False) for s in STATS])
            .with_columns(played=pl.col("MIN").is_not_null() & ~pl.col("GS").is_in(NOT_PLAYED).fill_null(False))
            .select("player_id", "player", "season", pl.col("Type").alias("type"), "date",
                    pl.col("Team").alias("team"), pl.col("Opp").alias("opp"), "is_home", "neutral",
                    "played", "started", pl.col("GS").alias("status"), "MIN", *STATS)
            .sort("player_id", "date"))


def load_player_seasons(kind="advanced"):
    """Season rows from <kind>.csv ('advanced', 'per_game_stats' or 'totals_stats').

    Career and multi-year summary rows are dropped, and for players traded
    mid-season only the combined row (2TM, 3TM...) is kept.
    """
    frames = []
    for f in sorted(PLAYERS_DIR.glob(f"*_{kind}.csv")):
        m = re.match(rf"(.+)_([a-z.'-]+\d{{2}})_{kind}\.csv$", f.name)
        if not m:
            continue
        d = pl.read_csv(f, infer_schema=False)
        frames.append(d.with_columns(player_id=pl.lit(m.group(2))))
    d = pl.concat(frames, how="diagonal").filter(pl.col("Season").str.contains(r"^\d{4}-\d{2}$"))
    d = d.with_columns((pl.col("Season").str.slice(0, 4).cast(pl.Int32) + 1).alias("season"),
                       pl.col("Team").str.contains(r"^\d+TM$").alias("combined"))
    # Prefer the combined row when a player has one for that season
    d = d.sort("player_id", "season", "combined", descending=[False, False, True])
    d = d.unique(["player_id", "season"], keep="first", maintain_order=True)
    num = [c for c in d.columns if c not in ("Season", "Team", "Lg", "Pos", "Awards", "player_id", "season", "combined")]
    return d.with_columns(*[pl.col(c).cast(pl.Float64, strict=False) for c in num]).drop("combined")


def _read_boxscore(gdir):
    players = []
    for f in gdir.glob("*_basic.csv"):
        side, team = f.stem.split("_")[:2]
        d = pl.read_csv(f, infer_schema=False)
        players.append(d.with_columns(game_id=pl.lit(gdir.name), team=pl.lit(team),
                                      is_home=pl.lit(int(side == "home"), pl.Int8)))
    ff = pl.read_csv(gdir / "four_factors.csv", infer_schema=False).with_columns(game_id=pl.lit(gdir.name))
    return players, ff


def load_boxscores():
    """(player rows, team four-factor rows) from every downloaded box score.

    Parsed box scores are cached in bbref_games/*_cache.parquet; only game
    folders not in the cache are read.
    """
    box_cache, ff_cache = GAMES_DIR / "box_cache.parquet", GAMES_DIR / "ff_cache.parquet"
    box = pl.read_parquet(box_cache) if box_cache.exists() and ff_cache.exists() else None
    ff = pl.read_parquet(ff_cache) if box is not None else None
    done = set(box["game_id"]) if box is not None else set()
    new_players, new_ff = [], []
    for gdir in sorted((GAMES_DIR / "boxscores").iterdir()):
        if gdir.name in done or not (gdir / "four_factors.csv").exists():
            continue
        players, factors = _read_boxscore(gdir)
        new_players += players
        new_ff.append(factors)
    if new_players:
        nb = pl.concat(new_players, how="diagonal").with_columns(
            minutes("MP").alias("MIN"),
            *[pl.col(s).str.replace(r"^\+", "").cast(pl.Float64, strict=False) for s in STATS])
        nf = pl.concat(new_ff, how="diagonal")
        nf = nf.with_columns(*[pl.col(c).cast(pl.Float64, strict=False) for c in nf.columns if c not in ("Team", "game_id")])
        box = nb if box is None else pl.concat([box, nb], how="diagonal_relaxed")
        ff = nf if ff is None else pl.concat([ff, nf], how="diagonal_relaxed")
        box.write_parquet(box_cache)
        ff.write_parquet(ff_cache)
    return box, ff


def player_names(logs, box=None, games=None):
    """player_id -> display name.

    Uses players.csv from the scraper when present, else the name in matching
    box score rows (same date, team, points and seconds played), else the
    filename's version, which has lost accents and punctuation.
    """
    names = dict(logs.select("player_id", "player").unique("player_id").iter_rows())
    if box is not None and games is not None:
        seconds = (pl.col("MIN") * 60).round().cast(pl.Int64)
        b = (box.filter(pl.col("Role") != "Total").join(games.select("game_id", "date"), on="game_id")
                .select("date", "team", "PTS", seconds.alias("sec"), "Player"))
        l = logs.filter("played").select("player_id", "date", "team", "PTS", seconds.alias("sec"))
        matched = (l.join(b, on=["date", "team", "PTS", "sec"])
                    .group_by("player_id", "Player").len().sort("len", descending=True)
                    .unique("player_id", keep="first"))
        names.update(dict(matched.select("player_id", "Player").iter_rows()))
    csv_path = PLAYERS_DIR / "players.csv"
    if csv_path.exists():
        names.update(dict(pl.read_csv(csv_path).select("player_id", "name").iter_rows()))
    return names

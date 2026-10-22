"""Serving features must equal training features for the same game.

Rebuild the exported state as it was the morning of a past game, assemble
features the way the browser does, and compare with the training frame row.
"""

import datetime
import random

import polars as pl
import pytest

from ml.data import load_boxscores, load_games, load_player_logs
from ml.player_features import FEATURES, training_frame
from ml.roster import lineup_of, replay
from ml.serving import build_states, game_features, player_features
from ml.team_features import GAME_FEATURES, game_frame

DATES = [datetime.date(2025, 12, 3), datetime.date(2026, 2, 10), datetime.date(2025, 10, 23)]


@pytest.fixture(scope="module")
def data():
    logs, games, box = load_player_logs(), load_games(), load_boxscores()[0]
    rows = training_frame(logs, games)
    return logs, games, rows, game_frame(games, box), box


@pytest.mark.parametrize("day", DATES)
def test_player_features_match_training(data, day):
    logs, games, rows, _, box = data
    teams, players, opponents = build_states(logs, games, box, day)
    sample = rows.filter(pl.col("date") == day).to_dicts()
    random.Random(0).shuffle(sample)
    for r in sample[:40]:
        got = player_features(players[r["player_id"]], teams[r["team"]], teams[r["opp"]], opponents[r["opp"]],
                              day.isoformat(), r["is_home"], r["vacated_min"])
        for f in FEATURES:
            assert got[f] == pytest.approx(r[f], rel=1e-4, abs=1e-4), (r["player_id"], f)


@pytest.mark.parametrize("day", DATES)
def test_game_features_match_training(data, day):
    logs, games, _, frame, box = data
    teams, _, _ = build_states(logs, games, box, day)
    _, roster_players, _ = replay(box, games, until=day)
    for r in frame.filter(pl.col("date") == day).to_dicts():
        # Who actually played, as the lineup the user would pick
        lineup = {t: lineup_of(roster_players, box.filter((pl.col("game_id") == r["game_id"]) & (pl.col("team") == t)
                                                          & (pl.col("MIN") > 0) & (pl.col("Role") != "Total"))["Player"])
                  for t in (r["home_abbr"], r["visitor_abbr"])}
        got = game_features(teams[r["home_abbr"]], teams[r["visitor_abbr"]], day.isoformat(), r["playoff"],
                            lineup[r["home_abbr"]], lineup[r["visitor_abbr"]])
        for f in GAME_FEATURES:
            # Exported roster rates are rounded to 4 places
            assert got[f] == pytest.approx(r[f], rel=1e-4, abs=2e-3), (r["game_id"], f)


def test_no_leakage(data):
    """Changing a game's result must not change that game's own features."""
    _, games, _, frame, box = data
    gid = frame.filter(pl.col("season") == 2026)["game_id"][500]
    flipped = games.with_columns(
        home_pts=pl.when(pl.col("game_id") == gid).then(pl.col("visitor_pts")).otherwise(pl.col("home_pts")),
        visitor_pts=pl.when(pl.col("game_id") == gid).then(pl.col("home_pts")).otherwise(pl.col("visitor_pts")))
    flipped = flipped.with_columns(margin=pl.col("home_pts") - pl.col("visitor_pts"))
    a = frame.filter(pl.col("game_id") == gid).select(GAME_FEATURES)
    b = game_frame(flipped, box).filter(pl.col("game_id") == gid).select(GAME_FEATURES)
    assert a.equals(b)

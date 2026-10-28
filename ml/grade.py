"""Score the logged predictions (ml.predict) against what happened.

Games are matched to results on (date, visitor, home); player projections to
the player's game log on (player, date). A player who didn't play isn't
graded. Games not played yet stay pending. The summary covers the whole log;
`log` lists every call of the latest season, newest first.

Usage:
    python -m ml.grade        # print the track record
"""

import math

import polars as pl

from ml.data import PRED_DIR, load_games, load_player_logs
from ml.player_features import TARGETS
from ml.serving import season_for


def _iso(t):
    """Tip-off as an ISO UTC string (polars may have parsed it into a datetime)."""
    if not t:
        return None
    return t.isoformat().replace("+00:00", "Z") if hasattr(t, "isoformat") else str(t)


# A model hash can look like a number ("12345678", "1e345678") to type inference, until one doesn't
_TEXT = {"model": pl.String}


def track_record(games, logs, pred_dir=PRED_DIR):
    """Summary, this season's graded calls and pending calls, as a JSON-ready dict."""
    gpath, ppath = pred_dir / "games.csv", pred_dir / "players.csv"
    if not gpath.exists():
        return {"games": 0, "pending": [], "log": [], "players": {}}
    gp = pl.read_csv(gpath, try_parse_dates=True, schema_overrides=_TEXT).with_columns(pl.col("date").cast(pl.Date))
    results = games.select("date", visitor="visitor_abbr", home="home_abbr", visitor_pts="visitor_pts", home_pts="home_pts")
    joined = gp.join(results, on=["date", "visitor", "home"], how="left").sort("date", "home")
    graded = joined.filter(pl.col("home_pts").is_not_null()).with_columns(
        won=(pl.col("home_pts") > pl.col("visitor_pts")).cast(pl.Int8))
    pending = joined.filter(pl.col("home_pts").is_null())

    season = season_for(gp["date"].max())
    this_season = graded.filter(pl.col("date").map_elements(season_for, return_dtype=pl.Int64) == season)
    out = {"since": gp["date"].min().isoformat(), "games": graded.height, "season": season,
           # [date, visitor, home, p_home, proj_visitor, proj_home, tipoff (ISO UTC or null)]
           "pending": [[r["date"].isoformat(), r["visitor"], r["home"], r["p_home"], r["proj_visitor"], r["proj_home"],
                        _iso(r.get("tipoff"))] for r in pending.iter_rows(named=True)],
           # [date, visitor, home, p_home, visitor_pts, home_pts, backfilled (made after the game, from earlier data)]
           "log": [[r["date"].isoformat(), r["visitor"], r["home"], r["p_home"], r["visitor_pts"], r["home_pts"],
                    bool(r.get("backfilled") or 0)] for r in this_season.reverse().iter_rows(named=True)]}
    out["backfilled"] = int(graded["backfilled"].fill_null(0).sum()) if "backfilled" in graded.columns else 0
    if graded.height:
        p, y = graded["p_home"].to_list(), graded["won"].to_list()
        eps = 1e-6
        out |= {
            "correct": sum((pi >= 0.5) == bool(yi) for pi, yi in zip(p, y)),
            "log_loss": -sum(math.log(max(pi, eps)) if yi else math.log(max(1 - pi, eps)) for pi, yi in zip(p, y)) / len(p),
            "brier": sum((pi - yi) ** 2 for pi, yi in zip(p, y)) / len(p),
            "margin_mae": (graded["margin"] - (graded["home_pts"] - graded["visitor_pts"])).abs().mean(),
        }

    out["players"] = {}
    if ppath.exists():
        pp = pl.read_csv(ppath, try_parse_dates=True, schema_overrides=_TEXT).with_columns(pl.col("date").cast(pl.Date))
        actual = logs.filter("played").select("player_id", "date", *[pl.col(s).alias(f"actual_{s}") for s in TARGETS])
        pg = pp.join(actual, on=["player_id", "date"], how="inner")
        out["player_games"] = pg.height
        for s in TARGETS:
            if pg.height:
                a, m = pg[f"actual_{s}"], pg[s]
                inside = ((a >= pg[f"{s}_p10"]) & (a <= pg[f"{s}_p90"])).mean()
                out["players"][s] = {"mae": (m - a).abs().mean(), "coverage": inside}
    return out


def main():
    r = track_record(load_games(), load_player_logs())
    if not r["games"]:
        print(f"No graded games yet ({len(r['pending'])} pending).")
        return
    print(f"Since {r['since']}: {r['correct']} of {r['games']} winners ({r['correct'] / r['games']:.1%}), "
          f"log loss {r['log_loss']:.3f}, margin miss {r['margin_mae']:.1f}; {len(r['pending'])} pending"
          + (f"; {r['backfilled']} of the graded calls were backfilled" if r["backfilled"] else ""))
    if r["players"]:
        print(f"Players ({r['player_games']} player-games): " + ", ".join(
            f"{s} {v['mae']:.2f}" for s, v in r["players"].items()))


if __name__ == "__main__":
    main()

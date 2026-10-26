"""Write everything the web app needs to web/public/data.

Rebuilds the current state from the CSVs and converts the trained models;
it does not retrain. Run after ml.train_game and ml.train_player.

Usage:
    python -m ml.export                    # state as of today
    python -m ml.export --as-of 2026-02-10 # state as it was before that date
"""

import argparse
import datetime
import json
import pickle
import random
from pathlib import Path

import lightgbm as lgb
import numpy as np
import polars as pl
from onnxmltools import convert_lightgbm
from onnxmltools.convert.common.data_types import FloatTensorType

from ml.grade import track_record
from ml.injuries import ET, out_as_of
from ml.schedule_time import due_hour
from ml.data import GAMES_DIR, ROOT, load_boxscores, load_games, load_player_logs, player_names
from ml.player_features import FEATURES, RATE_STATS, ROTATION_MIN, TARGETS
from ml.roster import lineup_from_roster
from ml.serving import build_states, game_features, player_features, season_for, win_probability
from ml.train_game import MODEL_DIR

OUT = ROOT / "web" / "public" / "data"
STATE_KEYS = ["player", "team", "pos", "st_season", "st_last_date", "missed_last",
              "usg_prev", "ast_pct_prev", "trb_pct_prev"]
LINE_COLS = ["date", "opp", "is_home", "started", *TARGETS]


def write_json(name, obj):
    path = OUT / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, separators=(",", ":")))
    print(f"  {name}: {path.stat().st_size / 1024:.0f} KB")


def game_model_json(game):
    win, margin = game["win"], game["margin"]
    assert np.allclose(win[0].mean_, margin[0].mean_) and np.allclose(win[0].scale_, margin[0].scale_)
    return {"features": game["features"], "mean": win[0].mean_.tolist(), "scale": win[0].scale_.tolist(),
            "coef": win[-1].coef_[0].tolist(), "intercept": float(win[-1].intercept_[0]),
            "margin_coef": margin[-1].coef_.tolist(), "margin_intercept": float(margin[-1].intercept_)}


def stat_projection(boosters, quantiles, x, minutes_override=None):
    """Projection dict for one feature vector, the way the browser computes it."""
    X = np.asarray([x], dtype=np.float32)
    mins = float(np.clip(boosters["MIN"].predict(X)[0], 0, 48)) if minutes_override is None else minutes_override
    out = {}
    for s in TARGETS:
        mean = mins if s == "MIN" else float(boosters[s].predict(X)[0]) * mins / 36
        q = quantiles[s]
        i = int(np.clip(np.searchsorted(q["edges"], mean, side="right") - 1, 0, len(q["edges"]) - 2))
        out[s] = {"mean": mean, "p10": q["p10"][i], "p90": q["p90"][i]}
    return out


def player_files(logs, players):
    """players.json (state + recent lines) and per-opponent history."""
    played = logs.filter(pl.col("played") & (pl.col("season") >= 2020))
    recent = played.sort("date").group_by("player_id").tail(RECENT := 10)
    vs = played.group_by("player_id", "opp").agg(pl.len().alias("n"), *[pl.col(s).mean().round(1) for s in TARGETS])
    lines, history = {}, {}
    for r in recent.sort("player_id", "date", descending=[False, True]).iter_rows(named=True):
        lines.setdefault(r["player_id"], []).append(
            [r["date"].isoformat(), r["opp"], r["is_home"], int(r["started"]), *[round(r[s], 1) for s in TARGETS]])
    for r in vs.iter_rows(named=True):
        history.setdefault(r["player_id"], {})[r["opp"]] = [r["n"], *[r[s] for s in TARGETS]]
    out = {}
    for pid, p in players.items():
        out[pid] = {k: p[k] for k in STATE_KEYS} | {k: v for k, v in p.items() if k.startswith("st_")} \
                   | {"recent": lines.get(pid, [])}
    return out, history


def fixtures(teams, players, opponents, game_model, boosters, quantiles, as_of, n=40):
    """Sample inputs with Python's answers, for the browser parity test."""
    rng = random.Random(1)
    day = lambda: (as_of + datetime.timedelta(days=rng.randint(0, 6))).isoformat()
    team_ids = sorted(teams)
    cases = {"games": [], "players": []}
    for _ in range(n // 2):
        h, a = rng.sample(team_ids, 2)
        date = day()
        toggles = {}
        for t in (h, a):
            pool = [r["name"] for r in teams[t]["roster"] if r["in_pool"]]
            rest = [r["name"] for r in teams[t]["roster"] if not r["in_pool"]]
            toggles[t] = {"out": rng.sample(pool, min(len(pool), rng.choice([0, 1, 2]))),
                          "add": rng.sample(rest, min(len(rest), rng.choice([0, 0, 1])))}
        f = game_features(teams[h], teams[a], date, 0,
                          lineup_from_roster(teams[h]["roster"], **toggles[h]),
                          lineup_from_roster(teams[a]["roster"], **toggles[a]))
        p, margin, _ = win_probability(game_model, f)
        cases["games"].append({"home": h, "away": a, "date": date, "toggles": toggles, "features": f,
                               "p_home": p, "margin": margin})
    pids = sorted(pid for pid, p in players.items() if p["team"] in teams)
    for _ in range(n):
        pid = rng.choice(pids)
        p = players[pid]
        opp = rng.choice([t for t in team_ids if t != p["team"]])
        mates = sorted((q for q in pids if players[q]["team"] == p["team"] and q != pid),
                       key=lambda q: -players[q]["st_min_l10"])[:10]
        out = rng.sample(mates, min(len(mates), rng.choice([0, 0, 1, 2])))
        vacated = sum(players[q]["st_min_l10"] for q in out if players[q]["st_min_l10"] >= ROTATION_MIN)
        is_home = rng.choice([0, 1])
        date = day()
        f = player_features(p, teams[p["team"]], teams[opp], opponents[opp], date, is_home, vacated)
        x = [f[c] for c in FEATURES]
        override = rng.choice([None, None, None, 30.0])
        cases["players"].append({"player_id": pid, "opp": opp, "date": date, "is_home": is_home,
                                 "teammates_out": out, "minutes_override": override, "features": x,
                                 "projection": stat_projection(boosters, quantiles, x, override)})
    return cases


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--as-of", type=datetime.date.fromisoformat, default=datetime.date.today())
    args = ap.parse_args()

    game = pickle.load(open(MODEL_DIR / "game.pkl", "rb"))
    player = pickle.load(open(MODEL_DIR / "player.pkl", "rb"))
    assert player["features"] == FEATURES, "player.pkl is out of date; rerun python -m ml.train_player"

    logs, games, (box, _) = load_player_logs(), load_games(), load_boxscores()
    teams, players, opponents = build_states(logs, games, box, args.as_of)
    names = dict(games.select("home_abbr", "home").unique("home_abbr", keep="last").iter_rows())
    for t in teams:
        teams[t]["name"] = names.get(t, t)
    display = player_names(logs, box, games)
    for pid, p in players.items():
        p["player"] = display.get(pid, p["player"])
    print(f"Exporting state as of {args.as_of} (season {season_for(args.as_of)}) to {OUT}")

    boosters = {s: lgb.Booster(model_str=m) for s, m in player["models"].items()}
    for s, b in boosters.items():
        onx = convert_lightgbm(b, initial_types=[("x", FloatTensorType([None, len(FEATURES)]))],
                               target_opset=15, zipmap=False)
        path = OUT / "stat_models" / f"{s}.onnx"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(onx.SerializeToString())
    print(f"  stat_models/*.onnx: {sum(p.stat().st_size for p in (OUT / 'stat_models').glob('*.onnx')) / 1024:.0f} KB")

    gm = game_model_json(game)
    player_json, history = player_files(logs, players)
    write_json("game_model.json", gm)
    write_json("feature_spec.json", {"game": gm["features"], "player": FEATURES, "targets": TARGETS,
                                     "rate_stats": RATE_STATS, "rotation_min": ROTATION_MIN})
    write_json("teams.json", teams)
    write_json("opponents.json", opponents)
    write_json("players.json", player_json)
    write_json("history.json", history)
    write_json("quantiles.json", player["quantiles"])

    schedule = []
    sched_path = GAMES_DIR / "schedule.csv"
    if sched_path.exists():
        s = pl.read_csv(sched_path, try_parse_dates=True)
        schedule = [[r["date"].isoformat(), r["visitor_abbr"], r["home_abbr"], r["start_et"]]
                    for r in s.filter(pl.col("date") >= args.as_of).iter_rows(named=True)]
    write_json("schedule.json", schedule)

    gb = [[r["date"].isoformat(), r["visitor_abbr"], r["home_abbr"], r["visitor_pts"], r["home_pts"],
           round(r["p_home"], 4)] for r in game["backtest"]]
    write_json("game_backtest.json", gb)
    pb = {}
    for r in player["backtest"].iter_rows(named=True):
        pb.setdefault(r["player_id"], []).append(
            [r["date"].isoformat(), r["opp"], r["is_home"], *[round(r[f"pred_{s}"], 1) for s in TARGETS],
             *[round(r[s], 1) for s in TARGETS]])
    write_json("player_backtest.json", pb)

    write_json("meta.json", {
        "as_of": args.as_of.isoformat(), "season": season_for(args.as_of),
        "data_through": games["date"].max().isoformat(),
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "game_metrics": game["metrics"], "player_metrics": player["metrics"],
        "player_test_season": player["test_season"],
    })
    write_json("track_record.json", track_record(games, logs))
    # The latest injury report (or the one at that day's slot, for a past --as-of), for the pages' default lineups
    now = datetime.datetime.now(ET)
    report_time = now if args.as_of >= now.date() else datetime.datetime.combine(args.as_of, datetime.time(due_hour(args.as_of)), ET)
    injuries = out_as_of(report_time, teams, names)
    print(f"  injury report: {injuries['report'] or injuries.get('error')}")
    write_json("injuries.json", injuries)
    write_json("fixtures.json", fixtures(teams, players, opponents, gm, boosters, player["quantiles"], args.as_of))


if __name__ == "__main__":
    main()

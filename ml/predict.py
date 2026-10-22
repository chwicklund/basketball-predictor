"""Log predictions for today's games, before they're played.

Appends one row per game to predictions/games.csv and one row per rotation
player to predictions/players.csv. A day that's already logged is left alone,
so a rerun can never replace a prediction after tip-off. ml.grade scores the
log against results once the nightly refresh has scraped them.

Predictions assume each team's expected rotation (nobody known to be out),
which is what the site shows before any toggles.

Usage:
    python -m ml.predict                       # today's games, US Eastern date
    python -m ml.predict --date 2026-10-24 --schedule path/to/schedule.csv
"""

import argparse
import csv
import datetime
import hashlib
import pickle
from pathlib import Path
from zoneinfo import ZoneInfo

import re

import lightgbm as lgb
import polars as pl

from ml.data import GAMES_DIR, PRED_DIR, load_boxscores, load_games, load_player_logs, player_names
from ml.export import game_model_json, stat_projection
from ml.player_features import FEATURES, ROTATION_MIN, TARGETS
from ml.serving import build_states, game_features, player_features, projected_score, season_for, win_probability
from ml.train_game import MODEL_DIR

GAME_COLUMNS = ["date", "made_at", "model", "visitor", "home", "p_home", "pick", "proj_visitor", "proj_home", "margin",
                "tipoff"]
ET = ZoneInfo("America/New_York")
PLAYER_COLUMNS = (["date", "made_at", "model", "player_id", "player", "team", "opp", "is_home"]
                  + [f"{s}{k}" for s in TARGETS for k in ("", "_p10", "_p90")])


def model_version():
    """Short hash of the trained models, so the log says which version made each call."""
    h = hashlib.sha256()
    for name in ("game.pkl", "player.pkl"):
        h.update((MODEL_DIR / name).read_bytes())
    return h.hexdigest()[:8]


def logged_dates(path):
    if not path.exists():
        return set()
    with path.open(newline="") as f:
        return {r["date"] for r in csv.DictReader(f)}


def append(path, columns, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    new = not path.exists()
    with path.open("a", newline="") as f:
        w = csv.DictWriter(f, fieldnames=columns)
        if new:
            w.writeheader()
        w.writerows(rows)


def tipoff(day, start_et):
    """Tip-off as an aware datetime from the schedule's '7:30p' style, or None."""
    m = start_et and re.match(r"(\d{1,2}):(\d{2})\s*([ap])", str(start_et).strip().lower())
    if not m:
        return None
    hour = int(m.group(1)) % 12 + (12 if m.group(3) == "p" else 0)
    return datetime.datetime.combine(day, datetime.time(hour, int(m.group(2))), ET)


def predict_day(day, schedule_path, out_dir=PRED_DIR):
    """Predict and log every game on `day`; returns (games logged, players logged)."""
    games_path, players_path = out_dir / "games.csv", out_dir / "players.csv"
    date = day.isoformat()
    if date in logged_dates(games_path):
        print(f"{date} is already logged; leaving it as it was.")
        return 0, 0
    if not schedule_path.exists():
        print(f"No {schedule_path}; run bbref_games.py first.")
        return 0, 0
    slate = (pl.read_csv(schedule_path, try_parse_dates=True, schema_overrides={"start_et": pl.String})
               .filter(pl.col("date").cast(pl.Date) == day).select("visitor_abbr", "home_abbr", "start_et").rows())
    # Never log a call for a game that has already tipped off
    now = datetime.datetime.now(ET)
    tips = {(v, h): tipoff(day, t) for v, h, t in slate}
    started = [g for g, tip in tips.items() if tip and tip <= now]
    for v, h in started:
        print(f"  skipping {v} at {h}: already tipped off")
    slate = [(v, h) for v, h, _ in slate if (v, h) not in started]
    if not slate:
        print(f"No games on {date}.")
        return 0, 0

    game = pickle.load(open(MODEL_DIR / "game.pkl", "rb"))
    player = pickle.load(open(MODEL_DIR / "player.pkl", "rb"))
    boosters = {s: lgb.Booster(model_str=m) for s, m in player["models"].items()}
    gm = game_model_json(game)
    logs, games, (box, _) = load_player_logs(), load_games(), load_boxscores()
    teams, players, opponents = build_states(logs, games, box, day)
    names = player_names(logs, box, games)
    season = season_for(day)
    made_at = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    version = model_version()

    game_rows, player_rows = [], []
    for visitor, home in slate:
        if home not in teams or visitor not in teams:
            print(f"  skipping {visitor} at {home}: no history for one of the teams")
            continue
        p, margin, _ = win_probability(gm, game_features(teams[home], teams[visitor], date))
        ph, pv = projected_score(teams[home], teams[visitor], margin)
        game_rows.append({"date": date, "made_at": made_at, "model": version, "visitor": visitor, "home": home,
                          "p_home": round(p, 4), "pick": home if p >= 0.5 else visitor,
                          "proj_visitor": round(pv, 1), "proj_home": round(ph, 1), "margin": round(margin, 2),
                          "tipoff": tips[(visitor, home)].astimezone(datetime.timezone.utc).isoformat() if tips[(visitor, home)] else ""})
        for team, opp, is_home in ((home, visitor, 1), (visitor, home, 0)):
            rotation = [pid for pid, q in players.items()
                        if q["team"] == team and q["st_season"] >= season - 1 and q["st_min_l10"] >= ROTATION_MIN]
            for pid in rotation:
                f = player_features(players[pid], teams[team], teams[opp], opponents[opp], date, is_home)
                proj = stat_projection(boosters, player["quantiles"], [f[c] for c in FEATURES])
                row = {"date": date, "made_at": made_at, "model": version, "player_id": pid,
                       "player": names.get(pid, players[pid]["player"]), "team": team, "opp": opp, "is_home": is_home}
                for s in TARGETS:
                    row |= {s: round(proj[s]["mean"], 2), f"{s}_p10": round(proj[s]["p10"], 1), f"{s}_p90": round(proj[s]["p90"], 1)}
                player_rows.append(row)

    append(games_path, GAME_COLUMNS, game_rows)
    append(players_path, PLAYER_COLUMNS, player_rows)
    for r in game_rows:
        print(f"  {r['visitor']} at {r['home']}: {r['pick']} ({max(r['p_home'], 1 - r['p_home']):.0%})")
    print(f"Logged {len(game_rows)} games and {len(player_rows)} player projections for {date} (model {version}).")
    return len(game_rows), len(player_rows)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--date", type=datetime.date.fromisoformat,
                    default=datetime.datetime.now(ET).date(),
                    help="the game date to predict (default: today in US Eastern time)")
    ap.add_argument("--schedule", type=Path, default=GAMES_DIR / "schedule.csv")
    ap.add_argument("--out", type=Path, default=PRED_DIR)
    args = ap.parse_args()
    predict_day(args.date, args.schedule, args.out)


if __name__ == "__main__":
    main()

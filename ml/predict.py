"""Log predictions for today's games, before they're played.

Appends one row per game to predictions/games.csv and one row per rotation
player to predictions/players.csv. A day that's already logged is left alone,
so a rerun can never replace a prediction after tip-off. ml.grade scores the
log against results once the nightly refresh has scraped them.

Each team's expected rotation is adjusted by the NBA's official injury report
(ml/injuries.py): players listed Out or Doubtful in the latest report before
the run are dropped from the game model's lineup, get no stat projection, and
their usual minutes count as vacated for teammates. If the report can't be
read, everyone is assumed available and the log says so.

--backfill logs the current season's already-played games that have no call
yet, one day at a time, each from only the data before that day (the models
were trained on earlier seasons). Those rows are marked backfilled=1, since
they weren't made before tip-off.

Usage:
    python -m ml.predict                       # today's games, US Eastern date
    python -m ml.predict --date 2026-10-24 --schedule path/to/schedule.csv
    python -m ml.predict --backfill            # this season's played games so far
"""

import argparse
import csv
import datetime
import functools
import hashlib
import os
import pickle
import re
from pathlib import Path
from zoneinfo import ZoneInfo

import lightgbm as lgb
import polars as pl

from ml.data import GAMES_DIR, PRED_DIR, load_boxscores, load_games, load_player_logs, player_names
from ml.export import game_model_json, stat_projection
from ml.injuries import name_key, out_as_of
from ml.roster import lineup_from_roster
from ml.schedule_time import due_hour
from ml.player_features import FEATURES, ROTATION_MIN, TARGETS
from ml.serving import build_states, game_features, player_features, projected_score, season_for, win_probability
from ml.train_game import MODEL_DIR

GAME_COLUMNS = ["date", "made_at", "model", "visitor", "home", "p_home", "pick", "proj_visitor", "proj_home", "margin",
                "tipoff", "backfilled", "out_visitor", "out_home", "injury_report"]
ET = ZoneInfo("America/New_York")
PLAYER_COLUMNS = (["date", "made_at", "model", "player_id", "player", "team", "opp", "is_home"]
                  + [f"{s}{k}" for s in TARGETS for k in ("", "_p10", "_p90")] + ["backfilled", "vacated_min"])


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
    if path.exists():
        with path.open(newline="") as f:
            header = next(csv.reader(f), [])
        if header != columns:
            # A log from before a column was added: rewrite it once with the new header, values kept
            with path.open(newline="") as f:
                old = list(csv.DictReader(f))
            with path.open("w", newline="") as f:
                w = csv.DictWriter(f, fieldnames=columns)
                w.writeheader()
                w.writerows({c: r.get(c, "") for c in columns} for r in old)
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


@functools.cache
def _context():
    """Models and data, loaded once per run however many days are logged."""
    game = pickle.load(open(MODEL_DIR / "game.pkl", "rb"))
    player = pickle.load(open(MODEL_DIR / "player.pkl", "rb"))
    logs, games, (box, _) = load_player_logs(), load_games(), load_boxscores()
    return {"gm": game_model_json(game), "quantiles": player["quantiles"],
            "boosters": {s: lgb.Booster(model_str=m) for s, m in player["models"].items()},
            "logs": logs, "games": games, "box": box, "names": player_names(logs, box, games),
            "team_names": dict(games.select("home_abbr", "home").unique("home_abbr", keep="last").iter_rows()),
            "version": model_version()}


def log_day(day, slate, out_dir=PRED_DIR, backfilled=False, report_time=None):
    """Predict `slate` [(visitor, home, tipoff or None)] as of the start of `day` and append it to the log.

    Injuries come from the latest report at or before `report_time` (default: now).
    """
    games_path, players_path = out_dir / "games.csv", out_dir / "players.csv"
    date = day.isoformat()
    if date in logged_dates(games_path):
        print(f"{date} is already logged; leaving it as it was.")
        return 0, 0
    if not slate:
        print(f"No games on {date}.")
        return 0, 0
    ctx = _context()
    # build_states only sees games before `day`, so a backfilled call knows nothing a noon call wouldn't
    teams, players, opponents = build_states(ctx["logs"], ctx["games"], ctx["box"], day)
    season = season_for(day)
    made_at = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    flag = int(backfilled)
    inj = out_as_of(report_time or datetime.datetime.now(ET), teams, ctx["team_names"])
    if inj.get("error"):
        print(f"  injury report unavailable ({inj['error']}); assuming everyone plays")
    else:
        print(f"  injury report {inj['report']}: {sum(len(v) for v in inj['out'].values())} players out or doubtful")
    out_keys = {t: {name_key(n) for n in names} for t, names in inj["out"].items()}

    game_rows, player_rows = [], []
    for visitor, home, tip in slate:
        if home not in teams or visitor not in teams:
            print(f"  skipping {visitor} at {home}: no history for one of the teams")
            continue
        out = {t: inj["out"].get(t, []) for t in (home, visitor)}
        lineups = {t: lineup_from_roster(teams[t]["roster"], out=out[t]) for t in (home, visitor)}
        p, margin, _ = win_probability(ctx["gm"], game_features(teams[home], teams[visitor], date, 0,
                                                                lineups[home], lineups[visitor]))
        ph, pv = projected_score(teams[home], teams[visitor], margin)
        game_rows.append({"date": date, "made_at": made_at, "model": ctx["version"], "visitor": visitor, "home": home,
                          "p_home": round(p, 4), "pick": home if p >= 0.5 else visitor,
                          "proj_visitor": round(pv, 1), "proj_home": round(ph, 1), "margin": round(margin, 2),
                          "tipoff": tip.astimezone(datetime.timezone.utc).isoformat() if tip else "", "backfilled": flag,
                          "out_visitor": "; ".join(out[visitor]), "out_home": "; ".join(out[home]),
                          "injury_report": inj["report"] or "unavailable"})
        for team, opp, is_home in ((home, visitor, 1), (visitor, home, 0)):
            rotation = [pid for pid, q in players.items()
                        if q["team"] == team and q["st_season"] >= season - 1 and q["st_min_l10"] >= ROTATION_MIN]
            is_out = lambda pid: name_key(ctx["names"].get(pid, players[pid]["player"])) in out_keys.get(team, set())
            # Out players get no projection; their usual minutes go to the teammates who play
            vacated = sum(players[pid]["st_min_l10"] for pid in rotation if is_out(pid))
            for pid in [pid for pid in rotation if not is_out(pid)]:
                f = player_features(players[pid], teams[team], teams[opp], opponents[opp], date, is_home, vacated)
                proj = stat_projection(ctx["boosters"], ctx["quantiles"], [f[c] for c in FEATURES])
                row = {"date": date, "made_at": made_at, "model": ctx["version"], "player_id": pid,
                       "player": ctx["names"].get(pid, players[pid]["player"]), "team": team, "opp": opp,
                       "is_home": is_home, "backfilled": flag, "vacated_min": round(vacated, 1)}
                for s in TARGETS:
                    row |= {s: round(proj[s]["mean"], 2), f"{s}_p10": round(proj[s]["p10"], 1), f"{s}_p90": round(proj[s]["p90"], 1)}
                player_rows.append(row)

    append(games_path, GAME_COLUMNS, game_rows)
    append(players_path, PLAYER_COLUMNS, player_rows)
    for r in game_rows:
        print(f"  {r['visitor']} at {r['home']}: {r['pick']} ({max(r['p_home'], 1 - r['p_home']):.0%})")
    print(f"Logged {len(game_rows)} games and {len(player_rows)} player projections for {date}"
          f"{' (backfilled)' if backfilled else ''}, model {ctx['version']}.")
    return len(game_rows), len(player_rows)


def predict_day(day, schedule_path, out_dir=PRED_DIR):
    """Predict and log every game on `day` that hasn't tipped off; returns (games logged, players logged)."""
    if day.isoformat() in logged_dates(out_dir / "games.csv"):
        print(f"{day.isoformat()} is already logged; leaving it as it was.")
        return 0, 0
    if not schedule_path.exists():
        print(f"No {schedule_path}; run bbref_games.py first.")
        return 0, 0
    rows = (pl.read_csv(schedule_path, try_parse_dates=True, schema_overrides={"start_et": pl.String})
              .filter(pl.col("date").cast(pl.Date) == day).select("visitor_abbr", "home_abbr", "start_et").rows())
    # Never log a call for a game that has already tipped off
    now = datetime.datetime.now(ET)
    slate = []
    for v, h, t in rows:
        tip = tipoff(day, t)
        if tip and tip <= now:
            print(f"  skipping {v} at {h}: already tipped off")
        else:
            slate.append((v, h, tip))
    return log_day(day, slate, out_dir)


def backfill(out_dir=PRED_DIR, today=None):
    """Log the current season's played games that have no call yet, marked as backfilled."""
    today = today or datetime.datetime.now(ET).date()
    season = season_for(today)
    played = _context()["games"].filter((pl.col("season") == season) & (pl.col("date") < today))
    if played.is_empty():
        print(f"No {season - 1}-{str(season)[2:]} games played before {today} in games.csv; run the nightly refresh first.")
        return 0, 0
    total = [0, 0]
    for (day,), g in played.sort("date", "game_id").group_by("date", maintain_order=True):
        slate = [(v, h, tipoff(day, t)) for v, h, t in g.select("visitor_abbr", "home_abbr", "start_et").rows()]
        # The injury report as it stood at that day's prediction slot, as the daily job would have read it
        slot = datetime.datetime.combine(day, datetime.time(due_hour(day), 0), ET)
        n = log_day(day, slate, out_dir, backfilled=True, report_time=slot)
        total = [total[0] + n[0], total[1] + n[1]]
    print(f"Backfill done: {total[0]} games and {total[1]} player projections added.")
    return tuple(total)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--date", type=datetime.date.fromisoformat,
                    default=datetime.datetime.now(ET).date(),
                    help="the game date to predict (default: today in US Eastern time)")
    ap.add_argument("--schedule", type=Path, default=GAMES_DIR / "schedule.csv")
    ap.add_argument("--out", type=Path, default=PRED_DIR)
    ap.add_argument("--backfill", action="store_true",
                    help="log this season's already-played games that have no call yet (marked backfilled)")
    args = ap.parse_args()
    games_logged, _ = backfill(args.out) if args.backfill else predict_day(args.date, args.schedule, args.out)
    # In GitHub Actions, tell the workflow whether there's anything new to publish
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            f.write(f"logged={games_logged}\n")


if __name__ == "__main__":
    main()

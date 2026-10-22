#!/usr/bin/env python3
"""Download every NBA game and its box score from basketball-reference.com.

Writes:
    <out>/games.csv                          one row per game with the final score
    <out>/schedule.csv                       games not played yet in the seasons fetched
    <out>/boxscores/<game_id>/line_score.csv     points by quarter
    <out>/boxscores/<game_id>/four_factors.csv
    <out>/boxscores/<game_id>/visitor_<TEAM>_basic.csv
    <out>/boxscores/<game_id>/home_<TEAM>_basic.csv

Seasons are named by the year they end, so 2020 is the 2019-20 season.
Only games that have been played (have a box score) are included.

There is one request per box score (about 1,300 a season) and the site allows
about 20 requests per minute, so a full run from 2020 takes 9-10 hours. Don't
run it alongside bbref_active_players.py, or the combined rate will get you
blocked for an hour. Finished games are skipped, so it can be stopped and
resumed.

games.csv keeps the rows of seasons outside the range fetched, so a nightly
run of just the current season (--from-season 2027) only adds new games.

Usage:
    python3 bbref_games.py                     # 2019-20 season to now
    python3 bbref_games.py --from-season 2024 --to-season 2025
"""

import argparse
import csv
import datetime
import html as htmllib
import re
import sys
from pathlib import Path

import bbref_active_players as bbref
from bbref_active_players import BASE, fetch, parse_table

SCHEDULE_COLUMNS = ["season", "date", "start_et", "visitor", "visitor_abbr", "home", "home_abbr"]
GAME_COLUMNS = ["game_id", "season", "type", "date", "start_et", "visitor", "visitor_abbr", "visitor_pts",
                "home", "home_abbr", "home_pts", "overtime", "attendance", "duration", "arena", "notes"]


def current_season():
    today = datetime.date.today()
    return today.year + 1 if today.month >= 10 else today.year


def cell(row_html, stat):
    m = re.search(rf'data-stat="{stat}"[^>]*>(.*?)</t[hd]>', row_html, re.S)
    if not m:
        return ""
    return htmllib.unescape(re.sub(r"<[^>]+>", "", m.group(1))).strip()


def season_games(season):
    """Return (played games, unplayed games) of one season, in schedule order."""
    first = fetch(f"{BASE}/leagues/NBA_{season}_games.html")
    if not first:
        return [], []
    # The season page links every month's page (including its own month)
    months = re.findall(rf'href="(/leagues/NBA_{season}_games-[a-z0-9-]+\.html)"', first)
    pages = []
    for path in dict.fromkeys(months):
        page = fetch(BASE + path)
        if page:
            pages.append(page)
    if not months:
        pages = [first]

    playoff_page = fetch(f"{BASE}/playoffs/NBA_{season}_games.html") or ""
    playoff_ids = set(re.findall(r'href="/boxscores/([0-9A-Z]+)\.html"', playoff_page))

    games, upcoming, seen = [], [], set()
    for page in pages:
        page = page.replace("<!--", "").replace("-->", "")
        table = re.search(r'<table[^>]*id="schedule".*?</table>', page, re.S)
        if not table:
            continue
        for row in re.findall(r"<tr[^>]*>.*?</tr>", table.group(0), re.S):
            box = re.search(r'href="/boxscores/([0-9A-Z]+)\.html"', row)
            teams = re.findall(r'href="/teams/([A-Z]+)/\d+\.html"', row)
            if not box:
                date = cell(row, "date_game")
                if len(teams) > 1 and date:  # not played yet (header rows have no teams)
                    upcoming.append({
                        "season": season,
                        "date": datetime.datetime.strptime(date, "%a, %b %d, %Y").date().isoformat(),
                        "start_et": cell(row, "game_start_time"),
                        "visitor": cell(row, "visitor_team_name"), "visitor_abbr": teams[0],
                        "home": cell(row, "home_team_name"), "home_abbr": teams[1],
                    })
                continue
            if box.group(1) in seen:
                continue
            seen.add(box.group(1))
            notes = cell(row, "game_remarks")
            games.append({
                "game_id": box.group(1),
                "season": season,
                "type": "Playoffs" if box.group(1) in playoff_ids else ("Play-In" if "Play-In" in notes else "Regular"),
                "date": datetime.datetime.strptime(cell(row, "date_game"), "%a, %b %d, %Y").date().isoformat(),
                "start_et": cell(row, "game_start_time"),
                "visitor": cell(row, "visitor_team_name"),
                "visitor_abbr": teams[0] if teams else "",
                "visitor_pts": cell(row, "visitor_pts"),
                "home": cell(row, "home_team_name"),
                "home_abbr": teams[1] if len(teams) > 1 else "",
                "home_pts": cell(row, "home_pts"),
                "overtime": cell(row, "overtimes"),
                "attendance": cell(row, "attendance").replace(",", ""),
                "duration": cell(row, "game_duration"),
                "arena": cell(row, "arena_name"),
                "notes": notes,
            })
    return games, upcoming


def write_csv(path, header, rows):
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(header)
        writer.writerows(rows)


def save_box_score(game, game_dir):
    html = fetch(f"{BASE}/boxscores/{game['game_id']}.html")
    if not html:
        return False

    files = {}
    for table_id, name in (("line_score", "line_score.csv"), ("four_factors", "four_factors.csv")):
        table = parse_table(html, table_id)
        if table is None:
            print(f"  no {table_id} table", file=sys.stderr)
            return False
        header, rows = table
        files[name] = (["Team"] + header[1:], rows)

    for side in ("visitor", "home"):
        team = game[f"{side}_abbr"]
        table = parse_table(html, f"box-{team}-game-basic")
        if table is None:
            print(f"  no box score table for {team}", file=sys.stderr)
            return False
        header, rows = table
        # The Starters/Reserves divider row is dropped by the parser; the first five are starters
        rows = [[("Total" if r[0] == "Team Totals" else "Starter" if i < 5 else "Reserve")] + r
                for i, r in enumerate(rows)]
        files[f"{side}_{team}_basic.csv"] = (["Role", "Player"] + header[1:], rows)

    game_dir.mkdir(parents=True, exist_ok=True)
    for name, (header, rows) in files.items():
        write_csv(game_dir / name, header, rows)
    return True


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--from-season", type=int, default=2020, help="first season, by end year (default 2020 = 2019-20)")
    ap.add_argument("--to-season", type=int, default=current_season(), help="last season, by end year")
    ap.add_argument("-o", "--out", default="bbref_games", help="output directory")
    ap.add_argument("--delay", type=float, default=bbref.DELAY, help="seconds between requests")
    ap.add_argument("--max-games", type=int, help="stop after this many box scores (for testing)")
    args = ap.parse_args()
    bbref.DELAY = args.delay

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    seasons = range(args.from_season, args.to_season + 1)
    games, upcoming = [], []
    for season in seasons:
        found, later = season_games(season)
        print(f"{season - 1}-{str(season)[2:]}: {len(found)} games played, {len(later)} to come")
        games.extend(found)
        upcoming.extend(later)

    # Keep earlier runs' games from seasons outside this range
    games_path = out / "games.csv"
    kept = []
    if games_path.exists():
        with games_path.open(newline="", encoding="utf-8") as f:
            kept = [g for g in csv.DictReader(f) if int(g["season"]) not in seasons]
    all_games = sorted(kept + games, key=lambda g: (g["date"], g["game_id"]))
    if not all_games:
        print("No games found.")
        return
    write_csv(games_path, GAME_COLUMNS, [[g[c] for c in GAME_COLUMNS] for g in all_games])
    write_csv(out / "schedule.csv", SCHEDULE_COLUMNS, [[g[c] for c in SCHEDULE_COLUMNS] for g in upcoming])
    print(f"Wrote {len(all_games)} games to {games_path} and {len(upcoming)} to {out / 'schedule.csv'}\n")

    fetched = 0
    for i, game in enumerate(games, 1):
        game_dir = out / "boxscores" / game["game_id"]
        if game_dir.exists() and len(list(game_dir.glob("*.csv"))) == 4:
            continue
        if args.max_games is not None and fetched >= args.max_games:
            break
        print(f"[{i}/{len(games)}] {game['date']} {game['visitor_abbr']} @ {game['home_abbr']}")
        if not save_box_score(game, game_dir):
            print("  failed", file=sys.stderr)
        fetched += 1

    print(f"\nDone. Output is in {out.resolve()}")


if __name__ == "__main__":
    main()

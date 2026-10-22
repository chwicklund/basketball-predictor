#!/usr/bin/env python3
"""Download stats for every active NBA player from basketball-reference.com.

Active players are the ones shown in bold on the /players/<letter>/ index
pages. For each one, the chosen stat tables are saved to a CSV file named
after the player.

Basketball-Reference rate-limits to about 20 requests per minute and blocks
clients that go over it for an hour, so this script waits between requests.
A full run takes about 35 minutes. Players whose CSV already exists are
skipped, so an interrupted run can be resumed.

--update GAMES_DIR --since DATE refreshes only the players who appear in box
scores dated on or after DATE: their stat tables are rewritten and only the
current season of their game log is refetched. That's about two requests per
player, so a night of games takes 15-25 minutes.

Usage:
    python3 bbref_active_players.py                       # per-game stats
    python3 bbref_active_players.py -t per_game_stats totals_stats advanced
    python3 bbref_active_players.py --letters a b --out stats
"""

import argparse
import csv
import re
import string
import sys
import time
import urllib.error
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

BASE = "https://www.basketball-reference.com"
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
DELAY = 3.5  # seconds between requests; stays under 20/minute


def fetch(url, retries=3):
    for attempt in range(retries):
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                html = resp.read().decode("utf-8", errors="replace")
            time.sleep(DELAY)
            return html
        except urllib.error.HTTPError as e:
            if e.code == 429:
                wait = int(e.headers.get("Retry-After", 60))
                print(f"  rate limited, waiting {wait}s", file=sys.stderr)
                time.sleep(wait)
            elif e.code == 404:
                return None
            else:
                print(f"  HTTP {e.code} for {url}", file=sys.stderr)
                time.sleep(DELAY * (attempt + 2))
        except urllib.error.URLError as e:
            print(f"  error fetching {url}: {e.reason}", file=sys.stderr)
            time.sleep(DELAY * (attempt + 2))
    return None


def active_players(letter):
    """Return [(player_id, name, url)] for the bold (active) players on a letter page."""
    html = fetch(f"{BASE}/players/{letter}/")
    if not html:
        return []
    pattern = r'<strong><a href="(/players/[a-z]/([a-z0-9]+)\.html)">([^<]+)</a></strong>'
    return [(pid, name, BASE + path) for path, pid, name in re.findall(pattern, html)]


class TableParser(HTMLParser):
    """Extract the header row and data rows of one <table id=...>."""

    def __init__(self, table_id):
        super().__init__(convert_charrefs=True)
        self.table_id = table_id
        self.in_table = False
        self.section = None  # thead / tbody / tfoot
        self.header = []
        self.rows = []
        self.row = None
        self.cell = None
        self.skip_row = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "table" and attrs.get("id") == self.table_id:
            self.in_table = True
        if not self.in_table:
            return
        if tag in ("thead", "tbody", "tfoot"):
            self.section = tag
        elif tag == "tr":
            self.row = []
            # Skip repeated header rows inside tbody and blank spacer rows
            classes = attrs.get("class") or ""
            self.skip_row = "thead" in classes or "spacer" in classes
        elif tag in ("th", "td") and self.row is not None:
            self.cell = []
            self.colspan = int(attrs.get("colspan") or 1)

    def handle_endtag(self, tag):
        if not self.in_table:
            return
        if tag in ("th", "td") and self.cell is not None:
            # Pad merged cells (e.g. the career row's "9 Yrs") so columns stay aligned
            self.row.append("".join(self.cell).strip())
            self.row.extend([""] * (self.colspan - 1))
            self.cell = None
        elif tag == "tr" and self.row is not None:
            if self.section == "thead":
                self.header = self.row  # last header row wins (skips over_header groups)
            elif not self.skip_row and any(self.row):
                self.rows.append(self.row)
            self.row = None
        elif tag == "table":
            self.in_table = False

    def handle_data(self, data):
        if self.cell is not None:
            self.cell.append(data)


def parse_table(html, table_id):
    # Many tables on the site are shipped inside HTML comments; uncomment them.
    html = html.replace("<!--", "").replace("-->", "")
    parser = TableParser(table_id)
    parser.feed(html)
    if not parser.header and not parser.rows:
        return None
    return parser.header, parser.rows


def game_logs(player_html, pid, only_season=None):
    """Fetch every season's game log for a player; return (header, rows) or None.

    Regular season and playoff games are combined, with Season and Type columns
    added at the front. only_season limits it to that one season.
    """
    seasons = sorted(set(re.findall(rf'href="/players/[a-z]/{pid}/gamelog/(\d{{4}})"', player_html)))
    if only_season is not None:
        seasons = [s for s in seasons if s == str(only_season)]
    # Columns vary by season (e.g. 3P% is dropped when a player took no threes),
    # so rows are kept as dicts and the header is the union of every season's.
    header, rows = ["Season", "Type"], []
    for season in seasons:
        print(f"  game log {season}")
        html = fetch(f"{BASE}/players/{pid[0]}/{pid}/gamelog/{season}")
        if not html:
            print(f"  failed to fetch {season} game log", file=sys.stderr)
            continue
        for table_id, kind in (("player_game_log_reg", "Regular"), ("player_game_log_post", "Playoffs")):
            table = parse_table(html, table_id)
            if table is None:
                continue
            # The home/away "@" column has no header text
            h = [col or "Home/Away" for col in table[0]]
            prev = "Type"
            for col in h:
                if col not in header:
                    header.insert(header.index(prev) + 1, col)
                prev = col
            for row in table[1]:
                game = dict(zip(h, row))
                # Rows without a date are the season-total footer
                if game.get("Date"):
                    rows.append({"Season": season, "Type": kind, **game})
    if not rows:
        return None
    return header, [[game.get(col, "") for col in header] for game in rows]


def merge_season(path, header, rows, season):
    """Replace one season's rows in an existing game log CSV with rows."""
    old_header, old_rows = [], []
    if path.exists():
        with path.open(newline="", encoding="utf-8") as f:
            reader = csv.reader(f)
            old_header = next(reader, [])
            old_rows = [dict(zip(old_header, r)) for r in reader]
    merged = list(old_header) or list(header)
    for col in header:
        if col not in merged:
            merged.insert(merged.index(header[header.index(col) - 1]) + 1, col)
    new = [dict(zip(header, r)) for r in rows]
    games = [g for g in old_rows if g.get("Season") != str(season)] + new
    return merged, [[g.get(col, "") for col in merged] for g in games]


def updated_players(games_dir, since):
    """Names of players in box scores dated on or after since (YYYY-MM-DD)."""
    games_dir = Path(games_dir)
    with (games_dir / "games.csv").open(newline="", encoding="utf-8") as f:
        ids = [g["game_id"] for g in csv.DictReader(f) if g["date"] >= since]
    names = set()
    for gid in ids:
        for path in (games_dir / "boxscores" / gid).glob("*_basic.csv"):
            with path.open(newline="", encoding="utf-8") as f:
                names.update(r["Player"] for r in csv.DictReader(f) if r["Role"] != "Total")
    return names


def save_names(path, players):
    """Add/refresh (player_id, name) rows in players.csv; filenames lose accents and punctuation."""
    names = {}
    if path.exists():
        with path.open(newline="", encoding="utf-8") as f:
            names = {r["player_id"]: r["name"] for r in csv.DictReader(f)}
    names.update({pid: name for pid, name, _ in players})
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["player_id", "name"])
        writer.writerows(sorted(names.items()))


def safe_filename(name):
    return re.sub(r"[^A-Za-z0-9]+", "_", name).strip("_")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-t", "--tables", nargs="+", default=["per_game_stats"],
                    help="table ids to save, e.g. per_game_stats totals_stats advanced "
                         "per_minute_stats per_poss shooting pbp_stats (add _post for playoffs)")
    ap.add_argument("-o", "--out", default="bbref_active_players", help="output directory")
    ap.add_argument("--letters", nargs="+", default=list(string.ascii_lowercase),
                    help="only process these last-name letters")
    ap.add_argument("-g", "--gamelogs", action="store_true",
                    help="also save <player>_gamelog.csv with every game of their career "
                         "(one extra request per season played, so a full run takes hours)")
    ap.add_argument("--update", metavar="GAMES_DIR",
                    help="only refresh players in this bbref_games.py output's box scores since --since")
    ap.add_argument("--since", help="with --update, the first game date to look at (YYYY-MM-DD)")
    ap.add_argument("--season", type=int, help="with --update, the season to refetch game logs for "
                                                "(by end year; default: the latest one)")
    args = ap.parse_args()
    if args.update and not args.since:
        ap.error("--update needs --since")

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    players = []
    for letter in args.letters:
        found = active_players(letter.lower())
        print(f"{letter.upper()}: {len(found)} active players")
        players.extend(found)
    print(f"Total active players: {len(players)}\n")
    save_names(out / "players.csv", players)

    if args.update:
        wanted = updated_players(args.update, args.since)
        players = [p for p in players if p[1] in wanted]
        print(f"Updating {len(players)} players who played since {args.since}\n")

    for i, (pid, name, url) in enumerate(players, 1):
        base = f"{safe_filename(name)}_{pid}"
        if len(args.tables) == 1:
            targets = {args.tables[0]: out / f"{base}.csv"}
        else:
            targets = {t: out / f"{base}_{t}.csv" for t in args.tables}
        gamelog_path = out / f"{base}_gamelog.csv"

        if not args.update:
            targets = {t: p for t, p in targets.items() if not p.exists()}
        need_gamelog = args.gamelogs and (args.update or not gamelog_path.exists())
        if not targets and not need_gamelog:
            print(f"[{i}/{len(players)}] {name}: already downloaded")
            continue

        print(f"[{i}/{len(players)}] {name}")
        html = fetch(url)
        if not html:
            print("  failed to fetch page", file=sys.stderr)
            continue

        for table_id, path in targets.items():
            table = parse_table(html, table_id)
            if table is None:
                print(f"  no '{table_id}' table (e.g. no games played yet)")
                continue
            header, rows = table
            with path.open("w", newline="", encoding="utf-8") as f:
                writer = csv.writer(f)
                writer.writerow(header)
                writer.writerows(rows)

        if need_gamelog:
            season = args.season
            if args.update and season is None:
                found = re.findall(rf'href="/players/[a-z]/{pid}/gamelog/(\d{{4}})"', html)
                season = max(map(int, found)) if found else None
            table = game_logs(html, pid, only_season=season if args.update else None)
            if table is None:
                print("  no game logs found")
                continue
            header, rows = table
            if args.update:
                header, rows = merge_season(gamelog_path, header, rows, season)
            with gamelog_path.open("w", newline="", encoding="utf-8") as f:
                writer = csv.writer(f)
                writer.writerow(header)
                writer.writerows(rows)
            print(f"  {len(rows)} games")

    print(f"\nDone. CSVs are in {out.resolve()}")


if __name__ == "__main__":
    main()

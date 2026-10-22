"""Roster strength: how good the players who suit up are, from box scores.

Each player has an impact rate (Game Score per 36 minutes, exponentially
weighted and shrunk toward a replacement-level rate) and a usual minutes load.
A lineup's strength is the minute-weighted impact of its players, with their
usual minutes scaled to fill the team's 240:

    strength = sum(rate_i * min_i) / sum(min_i) * 240 / 36

which is roughly the team's expected total Game Score. Box scores identify
players by name only, so this module keys players by box score name.

replay() walks the games in order. Training reads each game's features before
that game updates the states; serving reads the states left after the last
game. Both go through the same code, so they can't drift apart.
"""

import datetime

import polars as pl

HALF_LIFE = 15          # games
ALPHA = 1 - 0.5 ** (1 / HALF_LIFE)
PRIOR_GAMES = 5         # games of replacement-level play mixed into a player's rate
REPLACEMENT = 6.0       # Game Score per 36 of a replacement-level player
NEWCOMER_MIN = 12.0     # usual minutes assumed for a player with no history
POOL_DAYS = 15          # a team's expected roster: players who played for it this close to its last game
TEAM_MIN = 240

ROSTER_FEATURES = ["missing_home", "missing_away"]


class Player:
    __slots__ = ("gmsc", "mins", "n", "team", "last")

    def __init__(self):
        self.gmsc = self.mins = 0.0
        self.n = 0
        self.team = None
        self.last = None

    def update(self, gmsc, mins, team, date):
        if self.n == 0:
            self.gmsc, self.mins = gmsc, mins
        else:
            self.gmsc += ALPHA * (gmsc - self.gmsc)
            self.mins += ALPHA * (mins - self.mins)
        self.n += 1
        self.team, self.last = team, date

    @property
    def rate(self):
        if self.n == 0 or self.mins <= 0:
            return REPLACEMENT
        raw = 36 * self.gmsc / self.mins
        return (self.n * raw + PRIOR_GAMES * REPLACEMENT) / (self.n + PRIOR_GAMES)

    def summary(self):
        return {"rate": round(self.rate, 4), "min": round(self.mins if self.n else NEWCOMER_MIN, 4),
                "last": self.last.isoformat() if self.last else None}


def strength(lineup):
    """lineup: iterable of (rate, usual minutes)."""
    lineup = list(lineup)
    total = sum(m for _, m in lineup)
    if total <= 0:
        return 0.0
    return sum(r * m for r, m in lineup) / total * TEAM_MIN / 36


def pool(players, team, team_last):
    """Names of a team's expected roster going into its next game."""
    if team_last is None:
        return []
    cutoff = team_last - datetime.timedelta(days=POOL_DAYS)
    return [n for n, p in players.items() if p.team == team and p.last is not None and p.last >= cutoff]


def lineup_of(players, names):
    out = []
    for n in names:
        p = players.get(n)
        out.append((p.rate, p.mins) if p and p.n else (REPLACEMENT, NEWCOMER_MIN))
    return out


def replay(box, games, until=None):
    """Walk every game before `until`.

    Returns (features, players, team_last): features has one row per game and
    side with the pre-game full/available strength; players and team_last are
    the states after the last game, for serving.
    """
    played = (box.filter((pl.col("Role") != "Total") & (pl.col("MIN") > 0))
                 .select("game_id", "team", "Player", "MIN", pl.col("GmSc").fill_null(0.0)))
    by_game = {}
    for gid, team, name, mins, gmsc in played.iter_rows():
        by_game.setdefault(gid, {}).setdefault(team, []).append((name, mins, gmsc))

    g = games.sort("date", "game_id")
    if until is not None:
        g = g.filter(pl.col("date") < until)
    players, team_last, rows = {}, {}, []
    # A whole day's features are read before any of its results are applied,
    # so a player traded mid-day can't show up early on his new team
    for (_,), day in g.group_by("date", maintain_order=True):
        day = day.select("game_id", "date", "home_abbr", "visitor_abbr").rows()
        for gid, _, home, away in day:
            lines = by_game.get(gid, {})
            for side, team in (("home", home), ("away", away)):
                full = strength(lineup_of(players, pool(players, team, team_last.get(team))))
                avail = strength(lineup_of(players, [n for n, _, _ in lines.get(team, [])]))
                rows.append({"game_id": gid, "side": side, "full": full, "avail": avail})
        for gid, date, home, away in day:
            lines = by_game.get(gid, {})
            for team in (home, away):
                for name, mins, gmsc in lines.get(team, []):
                    players.setdefault(name, Player()).update(gmsc, mins, team, date)
                team_last[team] = date
    return pl.DataFrame(rows), players, team_last


def roster_frame(box, games):
    """One row per game with the roster features: strength lost to absences on each side."""
    feats, _, _ = replay(box, games)
    wide = feats.pivot(on="side", index="game_id", values=["full", "avail"])
    return wide.select(
        "game_id",
        missing_home=pl.col("full_home") - pl.col("avail_home"),
        missing_away=pl.col("full_away") - pl.col("avail_away"))


def team_rosters(players, team_last, recent_days=200):
    """For export: each team's expected roster plus other recent players.

    in_pool marks who is assumed to play unless toggled out; the others
    (players back from long absences, say) can be toggled in.
    """
    out = {}
    for team, last in team_last.items():
        expected = set(pool(players, team, last))
        cutoff = last - datetime.timedelta(days=recent_days)
        names = [n for n, p in players.items() if p.team == team and p.last >= cutoff]
        out[team] = sorted(
            ({"name": n, **players[n].summary(), "in_pool": n in expected} for n in names),
            key=lambda r: (not r["in_pool"], -r["min"]))
    return out


def missing(roster, lineup=None):
    """Strength lost to absences: expected roster minus the lineup that plays.

    roster is a team_rosters() list; lineup is a list of (rate, min), default
    the expected roster (nobody missing).
    """
    full = [(r["rate"], r["min"]) for r in roster if r["in_pool"]]
    return strength(full) - strength(full if lineup is None else lineup)


def lineup_from_roster(roster, out=(), add=()):
    """(rate, min) list for the expected roster minus `out` plus `add` (names)."""
    return [(r["rate"], r["min"]) for r in roster
            if (r["in_pool"] and r["name"] not in out) or r["name"] in add]

"""Who's out, from the NBA's official injury report (via the nbainjuries package).

Teams must file the report by 5 p.m. local time the day before a game, and the
NBA republishes it through game day (hourly, every 15 minutes since 2025-26).
`out_as_of(ts)` reads the latest report published at or before `ts` and maps
the players listed Out or Doubtful onto our box-score names, so the predictor
can drop them from each team's expected rotation.

nbainjuries reads the report PDF with tabula, which needs Java: set JAVA_HOME
(GitHub's runners get it from actions/setup-java).
"""

import datetime
import re
import unicodedata
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
OUT_STATUSES = {"Out", "Doubtful"}
LOOKBACK = datetime.timedelta(hours=8)
STEP = datetime.timedelta(minutes=15)
SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}
# Report team names that differ from Basketball-Reference's
TEAM_ALIASES = {"LA Clippers": "Los Angeles Clippers"}


def name_key(name):
    """Comparable form of a player name: no accents, punctuation, suffixes or case.

    'Butler III, Jimmy' (report order) and 'Jimmy Butler' (box score) both become 'jimmy butler'.
    """
    if "," in name:
        last, first = name.split(",", 1)
        name = f"{first} {last}"
    name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    words = [w for w in re.sub(r"[^a-z ]", "", name.lower().replace("-", " ")).split() if w not in SUFFIXES]
    return " ".join(words)


def latest_report(ts):
    """(report timestamp, rows) for the newest report at or before `ts` (naive or ET), or (None, [])."""
    from nbainjuries import injury  # imported here: it starts a JVM on import

    if ts.tzinfo is not None:
        ts = ts.astimezone(ET).replace(tzinfo=None)
    t = ts.replace(minute=ts.minute - ts.minute % 15, second=0, microsecond=0)
    seen = set()
    while ts - t <= LOOKBACK:
        url = injury.gen_url(t)  # hourly-era reports map several of these steps to one URL
        if url not in seen:
            seen.add(url)
            if injury.check_reportvalid(t):
                return t, injury.get_reportdata(t, return_df=True).to_dict("records")
        t -= STEP
    return None, []


def out_players(rows, rosters, team_names):
    """{team abbr: [roster names listed Out or Doubtful]} plus the listed players we couldn't match.

    rosters maps abbr -> roster entries ({"name": ...}); team_names maps abbr -> full team name.
    """
    abbr_of = {name: abbr for abbr, name in team_names.items()}
    out, unmatched = {}, []
    for r in rows:
        if r.get("Current Status") not in OUT_STATUSES or not r.get("Player Name"):
            continue
        team = TEAM_ALIASES.get(r.get("Team", ""), r.get("Team", ""))
        abbr = abbr_of.get(team)
        if abbr is None:
            unmatched.append(f"{r['Player Name']} ({team})")
            continue
        key = name_key(r["Player Name"])
        by_key = {name_key(p["name"]): p["name"] for p in rosters.get(abbr, [])}
        name = by_key.get(key)
        if name is None and key:  # same surname and first initial, if that's unique on the team
            first, last = key.split()[0], key.split()[-1]
            guesses = [n for k, n in by_key.items() if k and k.split()[-1] == last and k[0] == first[0]]
            name = guesses[0] if len(guesses) == 1 else None
        if name is None:
            unmatched.append(f"{r['Player Name']} ({abbr})")  # not in our recent roster: no minutes to lose
            continue
        out.setdefault(abbr, []).append(name)
    return out, unmatched


def out_as_of(ts, teams, team_names):
    """{"report": ISO time or None, "out": {abbr: [names]}, "unmatched": [...]} for the report before `ts`.

    teams is build_states' team dict (each with a "roster"); team_names maps abbr -> full name. Never raises: if the report
    can't be fetched or read, everyone is assumed available and "error" says why.
    """
    try:
        when, rows = latest_report(ts)
    except Exception as e:  # network, PDF or JVM trouble: predict without injuries rather than not at all
        return {"report": None, "out": {}, "unmatched": [], "error": f"{type(e).__name__}: {e}"[:300]}
    if when is None:
        return {"report": None, "out": {}, "unmatched": [], "error": "no report in the 8 hours before"}
    rosters = {abbr: t.get("roster", []) for abbr, t in teams.items()}
    out, unmatched = out_players(rows, rosters, team_names)
    return {"report": when.replace(tzinfo=ET).isoformat(), "out": out, "unmatched": unmatched}

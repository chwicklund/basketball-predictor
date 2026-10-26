"""Injury report rows map onto our box-score names (no network or Java needed)."""

from ml.injuries import name_key, out_players

ROSTERS = {
    "GSW": [{"name": "Jimmy Butler"}, {"name": "De'Anthony Melton"}, {"name": "Moses Moody"}],
    "DEN": [{"name": "Nikola Jokić"}, {"name": "Tim Hardaway Jr."}, {"name": "Aaron Gordon"}],
    "LAC": [{"name": "Kawhi Leonard"}],
}
NAMES = {"GSW": "Golden State Warriors", "DEN": "Denver Nuggets", "LAC": "Los Angeles Clippers"}


def row(team, name, status):
    return {"Team": team, "Player Name": name, "Current Status": status}


def test_name_key_handles_order_suffixes_and_accents():
    assert name_key("Butler III, Jimmy") == name_key("Jimmy Butler") == "jimmy butler"
    assert name_key("Jokic, Nikola") == name_key("Nikola Jokić")
    assert name_key("Hardaway Jr., Tim") == name_key("Tim Hardaway Jr.")
    assert name_key("Melton, De'Anthony") == name_key("De'Anthony Melton")


def test_only_out_and_doubtful_count():
    rows = [row("Golden State Warriors", "Butler III, Jimmy", "Out"),
            row("Golden State Warriors", "Moody, Moses", "Doubtful"),
            row("Golden State Warriors", "Melton, De'Anthony", "Questionable"),
            row("Denver Nuggets", "Jokic, Nikola", "Probable"),
            row("Denver Nuggets", "Gordon, Aaron", "Available")]
    out, unmatched = out_players(rows, ROSTERS, NAMES)
    assert out == {"GSW": ["Jimmy Butler", "Moses Moody"]}
    assert unmatched == []


def test_aliases_and_unknown_players():
    rows = [row("LA Clippers", "Leonard, Kawhi", "Out"),
            row("Denver Nuggets", "Newcomer, Some", "Out")]
    out, unmatched = out_players(rows, ROSTERS, NAMES)
    assert out == {"LAC": ["Kawhi Leonard"]}
    assert unmatched == ["Newcomer, Some (DEN)"]

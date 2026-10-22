"""Team Elo ratings, in the style of FiveThirtyEight's NBA Elo."""

import polars as pl

K = 20
HOME_ADV = 70
CARRY = 0.75  # share of a rating kept between seasons; the rest regresses to 1500
MEAN = 1500


def expected(diff):
    """Win probability for a rating advantage of diff (including home court)."""
    return 1 / (1 + 10 ** (-diff / 400))


def mov_multiplier(margin, winner_diff):
    return (abs(margin) + 3) ** 0.8 / (7.5 + 0.006 * winner_diff)


def run_elo(games, k=K, home_adv=HOME_ADV, carry=CARRY):
    """Add pre-game elo_home/elo_away to games and return (games, final ratings).

    The ratings carry over, already regressed, into the season after the last
    one in games, so they're ready for predicting the next game.
    """
    ratings, season_of = {}, {}
    pre_home, pre_away = [], []
    for row in games.sort("date", "game_id").iter_rows(named=True):
        h, a, season = row["home_abbr"], row["visitor_abbr"], row["season"]
        for t in (h, a):
            r = ratings.get(t, MEAN)
            if t in season_of and season_of[t] != season:
                r = MEAN + carry * (r - MEAN)
            ratings[t], season_of[t] = float(r), season
        rh, ra = ratings[h], ratings[a]
        pre_home.append(rh)
        pre_away.append(ra)
        diff = rh + home_adv - ra
        margin = row["margin"]
        winner_diff = diff if margin > 0 else -diff
        shift = k * mov_multiplier(margin, winner_diff) * ((margin > 0) - expected(diff))
        ratings[h], ratings[a] = rh + shift, ra - shift
    out = games.sort("date", "game_id").with_columns(elo_home=pl.Series(pre_home), elo_away=pl.Series(pre_away))
    return out, ratings, season_of


def current_ratings(games, season):
    """Ratings to use for games in season (regressed if that season hasn't started)."""
    _, ratings, season_of = run_elo(games)
    return {t: r if season_of[t] == season else MEAN + CARRY * (r - MEAN) for t, r in ratings.items()}

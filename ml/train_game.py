"""Train and backtest the game winner model.

Train on 2021-24 (2020 only warms up Elo and form), tune on 2025, report on
2026, then refit on everything for the exported model.

Usage:
    python -m ml.train_game
"""

import pickle
from pathlib import Path

import numpy as np
from sklearn.linear_model import LinearRegression, LogisticRegression
from sklearn.metrics import accuracy_score, brier_score_loss, log_loss
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from ml.data import load_boxscores, load_games
from ml.elo import expected, HOME_ADV
from ml.roster import ROSTER_FEATURES
from ml.team_features import GAME_FEATURES, game_frame

MODEL_DIR = Path(__file__).resolve().parent / "models"
FIRST_SEASON = 2021
TEST_SEASON = 2026


def fit(df, features=GAME_FEATURES, C=1.0):
    X, y = df.select(features).to_numpy(), df["home_win"].to_numpy()
    win = make_pipeline(StandardScaler(), LogisticRegression(C=C)).fit(X, y)
    margin = make_pipeline(StandardScaler(), LinearRegression()).fit(X, df["margin"].to_numpy())
    return win, margin


def report(name, y, p):
    print(f"  {name:<14} acc {accuracy_score(y, p > 0.5):.3f}  logloss {log_loss(y, p):.4f}  brier {brier_score_loss(y, p):.4f}")


def calibration(y, p, bins=10):
    edges = np.linspace(0, 1, bins + 1)
    idx = np.clip(np.digitize(p, edges) - 1, 0, bins - 1)
    return [{"p": float(p[idx == b].mean()), "actual": float(y[idx == b].mean()), "n": int((idx == b).sum())}
            for b in range(bins) if (idx == b).any()]


def backtest(frame, test_season, C=1.0):
    train = frame.filter((frame["season"] >= FIRST_SEASON) & (frame["season"] < test_season))
    test = frame.filter(frame["season"] == test_season)
    win, margin = fit(train, C=C)
    X, y = test.select(GAME_FEATURES).to_numpy(), test["home_win"].to_numpy()
    p = win.predict_proba(X)[:, 1]
    p_elo = expected(test["elo_diff"].to_numpy() + HOME_ADV)
    m_mae = np.abs(margin.predict(X) - test["margin"].to_numpy()).mean()
    return test, y, p, p_elo, m_mae


def main():
    frame = game_frame(load_games(), load_boxscores()[0])

    # Pick regularisation on 2025, then report once on 2026
    best = min([0.01, 0.1, 1.0, 10.0], key=lambda C: log_loss(*backtest(frame, 2025, C)[1:3]))
    print(f"C = {best} (chosen on 2025)")

    test, y, p, p_elo, m_mae = backtest(frame, TEST_SEASON, best)
    print(f"Backtest on {TEST_SEASON} ({len(y)} games):")
    report("always home", y, np.full(len(y), 0.55))
    report("Elo only", y, p_elo)
    report("model", y, p)
    base = [f for f in GAME_FEATURES if f not in ROSTER_FEATURES]
    train = frame.filter((frame["season"] >= FIRST_SEASON) & (frame["season"] < TEST_SEASON))
    p_base = fit(train, base, best)[0].predict_proba(test.select(base).to_numpy())[:, 1]
    report("no rosters", y, p_base)
    print(f"  margin MAE {m_mae:.2f}")

    win, margin = fit(frame.filter(frame["season"] >= FIRST_SEASON), C=best)
    coefs = dict(zip(GAME_FEATURES, win[-1].coef_[0] / win[0].scale_))
    print("Per-unit coefficients:", {k: round(v, 4) for k, v in coefs.items()})

    MODEL_DIR.mkdir(exist_ok=True)
    metrics = {
        "test_season": TEST_SEASON, "games": len(y),
        "accuracy": float(accuracy_score(y, p > 0.5)), "log_loss": float(log_loss(y, p)),
        "brier": float(brier_score_loss(y, p)), "margin_mae": float(m_mae),
        "home_accuracy": float(y.mean()), "elo_accuracy": float(accuracy_score(y, p_elo > 0.5)),
        "calibration": calibration(y, p),
    }
    backtest_rows = test.select("game_id", "date", "home_abbr", "visitor_abbr", "home_pts", "visitor_pts") \
                        .with_columns(p_home=p).to_dicts()
    with open(MODEL_DIR / "game.pkl", "wb") as f:
        pickle.dump({"win": win, "margin": margin, "features": GAME_FEATURES,
                     "metrics": metrics, "backtest": backtest_rows}, f)
    print(f"Saved {MODEL_DIR / 'game.pkl'}")


if __name__ == "__main__":
    main()

"""Train and backtest the player stat models.

Stage 1 predicts minutes. Stage 2 predicts each stat per 36 minutes. A stat's
projection is rate * minutes / 36. Ranges are the 10th and 90th percentiles of
actual results among 2025 games with a similar projection.

Usage:
    python -m ml.train_player
"""

import pickle
from pathlib import Path

import lightgbm as lgb
import numpy as np
import polars as pl

from ml.data import load_games, load_player_logs
from ml.player_features import FEATURES, RATE_STATS, TARGETS, training_frame

MODEL_DIR = Path(__file__).resolve().parent / "models"
VAL_SEASON, TEST_SEASON = 2025, 2026
PARAMS = {"learning_rate": 0.05, "num_leaves": 31, "min_data_in_leaf": 100,
          "feature_fraction": 0.8, "bagging_fraction": 0.8, "bagging_freq": 1, "verbose": -1}
MAX_ROUNDS = 400
QUANTILE_BINS = 20


def target(df, stat):
    """(y, weight) for one model: minutes, or per-36 rate weighted by minutes."""
    if stat == "MIN":
        return df["MIN"].to_numpy(), None
    m = df["MIN"].to_numpy()
    return df[stat].to_numpy() / m * 36, m


def train_one(train, stat, rounds=None, val=None):
    y, w = target(train, stat)
    data = lgb.Dataset(train.select(FEATURES).to_numpy(), y, weight=w, feature_name=FEATURES)
    params = PARAMS | {"objective": "regression" if stat == "MIN" else "poisson"}
    if stat == "MIN":
        # A teammate sitting out can only add to a player's expected minutes
        params["monotone_constraints"] = [int(f == "vacated_min") for f in FEATURES]
    if val is None:
        return lgb.train(params, data, num_boost_round=rounds)
    vy, vw = target(val, stat)
    vdata = lgb.Dataset(val.select(FEATURES).to_numpy(), vy, weight=vw, reference=data)
    return lgb.train(params, data, num_boost_round=MAX_ROUNDS, valid_sets=[vdata],
                     callbacks=[lgb.early_stopping(30, verbose=False)])


def predict(models, df):
    """Projected totals for each target."""
    X = df.select(FEATURES).to_numpy()
    mins = np.clip(models["MIN"].predict(X), 0, 48)
    out = {"MIN": mins}
    for s in RATE_STATS:
        out[s] = models[s].predict(X) * mins / 36
    return out


def quantile_table(pred, actual):
    """Bin edges over the projection and the p10/p90 of actuals in each bin."""
    edges = np.unique(np.quantile(pred, np.linspace(0, 1, QUANTILE_BINS + 1)))
    idx = np.clip(np.searchsorted(edges, pred, side="right") - 1, 0, len(edges) - 2)
    p10, p90 = [], []
    for b in range(len(edges) - 1):
        a = actual[idx == b]
        p10.append(float(np.quantile(a, 0.1)) if len(a) else 0.0)
        p90.append(float(np.quantile(a, 0.9)) if len(a) else 0.0)
    return {"edges": edges.tolist(), "p10": p10, "p90": p90}


def lookup(table, pred):
    edges = np.asarray(table["edges"])
    idx = np.clip(np.searchsorted(edges, pred, side="right") - 1, 0, len(edges) - 2)
    return np.asarray(table["p10"])[idx], np.asarray(table["p90"])[idx]


def main():
    rows = training_frame(load_player_logs(), load_games())
    train = rows.filter(pl.col("season") < VAL_SEASON)
    val = rows.filter(pl.col("season") == VAL_SEASON)
    test = rows.filter(pl.col("season") == TEST_SEASON)
    print(f"train {train.height}, val {val.height}, test {test.height} player-games")

    # Pick tree counts on 2025, then refit through 2025 and test on 2026
    rounds = {s: train_one(train, s, val=val).best_iteration or MAX_ROUNDS for s in TARGETS}
    print("rounds:", rounds)
    upto_val = rows.filter(pl.col("season") <= VAL_SEASON)
    models = {s: train_one(train, s, rounds[s]) for s in TARGETS}
    val_pred = predict(models, val)
    quantiles = {s: quantile_table(val_pred[s], val[s].to_numpy()) for s in TARGETS}

    models = {s: train_one(upto_val, s, rounds[s]) for s in TARGETS}
    pred = predict(models, test)
    baseline = {"MIN": ("min_l10", "s_min")} | {s: (f"l10_{s}", f"s_avg_{s}") for s in RATE_STATS}
    print(f"\nBacktest on {TEST_SEASON}: MAE (lower is better), p10-p90 coverage")
    print(f"  {'stat':<5}{'model':>8}{'last10':>8}{'season':>8}{'RMSE':>8}{'last10':>8}{'cover':>8}")
    metrics = {}
    for s in TARGETS:
        y = test[s].to_numpy()
        mae = np.abs(pred[s] - y).mean()
        l10, sea = (np.abs(test[c].to_numpy() - y).mean() for c in baseline[s])
        rmse = np.sqrt(((pred[s] - y) ** 2).mean())
        l10_rmse = np.sqrt(((test[baseline[s][0]].to_numpy() - y) ** 2).mean())
        lo, hi = lookup(quantiles[s], pred[s])
        cover = ((y >= lo) & (y <= hi)).mean()
        metrics[s] = {"mae": float(mae), "last10_mae": float(l10), "season_mae": float(sea),
                      "rmse": float(rmse), "last10_rmse": float(l10_rmse), "coverage": float(cover)}
        print(f"  {s:<5}{mae:>8.3f}{l10:>8.3f}{sea:>8.3f}{rmse:>8.3f}{l10_rmse:>8.3f}{cover:>8.1%}")

    # Out-of-sample 2026 projections, for showing past games next to what happened
    backtest = test.select("player_id", "date", "opp", "is_home", *TARGETS).with_columns(
        **{f"pred_{s}": pred[s] for s in TARGETS})

    final = {s: train_one(rows, s, rounds[s]) for s in TARGETS}
    MODEL_DIR.mkdir(exist_ok=True)
    with open(MODEL_DIR / "player.pkl", "wb") as f:
        pickle.dump({"models": {s: m.model_to_string() for s, m in final.items()}, "features": FEATURES,
                     "quantiles": quantiles, "metrics": metrics, "backtest": backtest,
                     "test_season": TEST_SEASON}, f)
    print(f"Saved {MODEL_DIR / 'player.pkl'}")


if __name__ == "__main__":
    main()

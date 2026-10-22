# Hoops Predictor

Two NBA predictors behind a static React site:

- **Game**: home team, away team and date → winner, win probability, projected score, and what's driving it. Each team's rotation can be edited: switch players off (or back on from injury) and the win probability updates.
- **Player**: player, opponent and date → minutes, points, rebounds, assists, 3-pointers, steals, blocks and turnovers, each with a likely range. You can mark teammates out or set the minutes yourself.

The models run in the browser (game: logistic regression in TS; player: LightGBM via ONNX Runtime Web), so there is no server. Hosting is Cloudflare Pages and the nightly refresh is a GitHub Action. Both fit in free tiers.

## Layout

```
bbref_games.py, bbref_active_players.py   scrape basketball-reference.com
ml/                                       features, training, export (Python)
  data.py            load the CSVs
  elo.py             team Elo
  roster.py          roster strength from box scores (who plays, weighted by minutes)
  team_features.py   pre-game team features
  player_features.py pre-game player features
  serving.py         current state + feature assembly (the reference for web/src/lib/features.ts)
  train_game.py      train + backtest the game model
  train_player.py    train + backtest the stat models
  export.py          write web/public/data (JSON + ONNX + parity fixtures)
  predict.py         log today's predictions before tip-off (daily job)
  grade.py           score the logged predictions against results
  tests/             serving == training features, no leakage
web/                                      Vite + React + TS app
.github/workflows/                        nightly refresh, weekly retrain
```

## Local use

```sh
pip install -r requirements.txt
python -m ml.train_game          # ~1 s; prints the 2025-26 backtest
python -m ml.train_player        # ~1 min
python -m ml.export              # writes web/public/data
python -m pytest ml/tests

cd web
npm install
npm test                         # browser code vs Python on the same inputs
npm run dev
```

Seasons are named by the year they end (2026 = 2025-26). Training uses 2020-21 to 2023-24, 2024-25 is for tuning, and 2025-26 is the held-out test season shown on the About page. The exported models are then refit on everything.

## Deploying (one-time setup)

Everything runs under one Cloudflare account. The raw CSVs and trained models live in an R2 bucket rather than git, because Sports-Reference's terms don't allow redistributing their data.

```sh
cd web
npx wrangler login
npx wrangler pages project create hoops-predictor --production-branch main
npx wrangler r2 bucket create hoops-data

# From the repo root: upload the current data and models
tar czf state.tar.gz bbref_games bbref_active_players ml/models
npx --prefix web wrangler r2 object put hoops-data/state.tar.gz --file state.tar.gz --remote
```

In the GitHub repo, add the secrets `CLOUDFLARE_API_TOKEN` (permissions: *Cloudflare Pages: Edit*, *Workers R2 Storage: Edit*) and `CLOUDFLARE_ACCOUNT_ID`. If you changed the names above, also add the variables `R2_BUCKET` and `PAGES_PROJECT`. Then run **Nightly refresh** once from the Actions tab.

- **Nightly refresh** (10:00 UTC) scrapes the current season's new games, refreshes the players who played, re-exports, uploads the tarball and redeploys. It takes about 20 minutes, almost all of it waiting out the scraper's rate limit.
- **Daily predictions** (noon US Eastern on weekends and federal holidays, 5 p.m. on other days; see `ml/schedule_time.py`) logs a call for every game on the day's schedule (win probability, projected score, and projections for each rotation player) to `predictions/games.csv` and `predictions/players.csv`, then redeploys. A logged day is never rewritten, and a game that has already tipped off is skipped, so the log is an honest record. The nightly refresh grades it: the Game page lists this season's calls as Right or Wrong, and the Report page compares the live record with the backtest. Run `python -m ml.grade` to print it.
- **Retrain** (Mondays) refits both models. It only uploads them and deploys if the Python and browser tests pass.

**Cost**: Pages, R2 (under 1 GB of the 10 GB free) and Actions are all free. Keep the repo **private** so the scraper code and any data stay unpublished. About 20 Action minutes a night is roughly 600 of the 2,000 free private-repo minutes a month.

## Accuracy (2025-26 test season)

| | |
|---|---|
| Game winner | 68.6% (Elo alone 68.4%, always home 55.5%); log-loss 0.588, 0.599 without roster features |
| Points MAE | 4.48 vs 4.66 for the last-10 average |
| Minutes MAE | 4.69 vs 5.23 |

The About page has the full table and a calibration chart.

## Roadmap

- Pace and offensive/defensive ratings from `four_factors.csv` in place of points-based form.
- Feed the Game page's roster toggles into the player projections too (they currently use their own teammates-out list).

## Design

The UI follows taste-skill's app-screen rules, style "achromatic ledger" (seed 1943210619): ink chrome on a stone ground,
Geist, one data hue (#1d5fbf) on the main data element. `web/src/lib/vendor/charts.js` is taste-skill's chart helper
with one addition (`bullet({ better })`).

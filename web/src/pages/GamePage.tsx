import { type ReactNode, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { SwapIcon } from "../components/Icons";
import RosterCard, { type Toggles } from "../components/RosterCard";
import SeasonLog from "../components/SeasonLog";
import TeamSelect from "../components/TeamSelect";
import { useFiles } from "../lib/data";
import { gameFeatures, lineupFromRoster, projectedScore, REST_CAP, daysBetween, strength, winProbability } from "../lib/features";
import { DRIVER_GROUP, one, pct, prettyDate, seasonLabel, signed } from "../lib/format";
import type { GameBacktest, GameModel, TeamState } from "../lib/types";
import { useTween } from "../lib/useTween";

const NONE: Toggles = { out: [], add: [] };
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const short = (name: string) => name.split(" ").slice(-1)[0];

export default function GamePage() {
  const files = useFiles("meta.json", "teams.json", "game_model.json", "schedule.json", "game_backtest.json", "injuries.json");
  const [params, setParams] = useSearchParams();
  const [playoff, setPlayoff] = useState(false);
  const [toggles, setToggles] = useState<Record<string, Toggles>>({});

  const meta = files?.["meta.json"];
  const schedule = files?.["schedule.json"] ?? [];
  const backtest = files?.["game_backtest.json"] ?? [];
  const next = schedule[0];
  const home = params.get("home") ?? next?.[2] ?? "BOS";
  const away = params.get("away") ?? next?.[1] ?? "NYK";
  const date = params.get("date") ?? next?.[0] ?? meta?.as_of ?? "";
  const past = meta !== undefined && date < meta.as_of;
  const set = (patch: Record<string, string>) => setParams({ home, away, date, ...patch }, { replace: true });

  const slate = useMemo(() => (past ? backtest : schedule)
    .filter((g) => g[0] === date).map((g) => ({ away: g[1], home: g[2] })), [schedule, backtest, date, past]);

  if (!files || !meta) return <Loading />;
  const teams = files["teams.json"];
  const model = files["game_model.json"];
  // Upcoming games start from the injury report: its Out and Doubtful players are switched off
  const injuries = files["injuries.json"];
  const reported = (t: string) => (injuries.out[t] ?? []).filter((n) => teams[t].roster.some((r) => r.name === n && r.in_pool));
  const tg = (t: string) => toggles[t] ?? (past ? NONE : { out: reported(t), add: [] });
  const setTeam = (t: string, v: Toggles) => setToggles({ ...toggles, [t]: v });

  const controls = (
    <>
      <div className="controls">
        <TeamSelect label="Away" value={away} teams={teams} exclude={home} onChange={(t) => set({ away: t })} />
        <button className="btn ghost" onClick={() => set({ home: away, away: home })} aria-label="Swap home and away" title="Swap home and away">
          <SwapIcon />
        </button>
        <TeamSelect label="Home" value={home} teams={teams} exclude={away} onChange={(t) => set({ home: t })} />
        <label className="control">
          <span>Date</span>
          <input type="date" className="input" value={date} onChange={(e) => set({ date: e.target.value })} />
        </label>
        {!past && (
          <label className="check">
            <input type="checkbox" className="switch" checked={playoff} onChange={(e) => setPlayoff(e.target.checked)} />
            Playoff game
          </label>
        )}
      </div>
      {slate.length > 0 && (
        <div className="slate" aria-label={`Games on ${prettyDate(date)}`}>
          {slate.map((g) => (
            <button key={g.away + g.home} aria-pressed={g.home === home && g.away === away}
              onClick={() => set({ home: g.home, away: g.away })}>{g.away} at {g.home}</button>
          ))}
        </div>
      )}
    </>
  );

  if (past) {
    const row = backtest.find((g) => g[0] === date && g[1] === away && g[2] === home);
    return (
      <>
        <div className="title-row">
          <div>
            <h1>{teams[away].name} at {teams[home].name}</h1>
            <p className="finding muted">{prettyDate(date)} · what the model said before tip-off, and what happened</p>
          </div>
          <span className="stamp">Data through {prettyDate(meta.data_through)}</span>
        </div>
        {controls}
        {row ? <PastResult row={row} teams={teams} /> : (
          <div className="panel">
            <div className="empty">
              Past dates show the {seasonLabel(meta.game_metrics.test_season)} backtest, and these teams didn't meet
              on {prettyDate(date)}. Pick one of that day's games above, or a date from {prettyDate(meta.as_of)} on.
            </div>
          </div>
        )}
        <SeasonLog />
      </>
    );
  }

  const lineups = { [home]: lineupFromRoster(teams[home].roster, tg(home).out, tg(home).add),
                    [away]: lineupFromRoster(teams[away].roster, tg(away).out, tg(away).add) };
  const pred = winProbability(model, gameFeatures(teams[home], teams[away], date, playoff ? 1 : 0, lineups[home], lineups[away]));
  const base = winProbability(model, gameFeatures(teams[home], teams[away], date, playoff ? 1 : 0));
  const score = projectedScore(teams[home], teams[away], pred.margin);
  const fav = pred.pHome >= 0.5 ? home : away;
  const pFav = fav === home ? pred.pHome : 1 - pred.pHome;

  // Who's missing on each side (injury report or toggles), and what that does to the home team's chances
  const missing = [home, away].filter((t) => tg(t).out.length)
    .map((t) => `${tg(t).out.map(short).join(", ")} (${t})`);
  const shift = (pred.pHome - base.pHome) * 100;
  const finding = `${teams[fav].name} win ${pct(pFav)} of the time${fav === home ? " at home" : " on the road"}, `
    + `projected ${Math.round(Math.max(score.home, score.away))}–${Math.round(Math.min(score.home, score.away))}.`
    + (missing.length && Math.abs(shift) >= 0.1
      ? ` Missing ${missing.join(" and ")} moves the ${teams[home].name}' chances ${shift < 0 ? "down" : "up"} ${one(Math.abs(shift))} points.`
      : "");

  return (
    <>
      <div className="title-row">
        <div>
          <h1>{teams[away].name} at {teams[home].name}</h1>
          <p className="finding">{finding}</p>
        </div>
        <span className="stamp">Data through {prettyDate(meta.data_through)}</span>
      </div>
      {controls}

      <div className="grid">
        <section className="panel span-4 fill" aria-labelledby="wp">
          <header>
            <h2 id="wp">Win probability</h2>
            <span className="meta">{prettyDate(date)}</span>
          </header>
          <Answer home={home} away={away} pHome={pred.pHome} teams={teams} />
          <dl className="facts">
            <div><dt>Projected score</dt><dd>{away} {Math.round(score.away)} – {Math.round(score.home)} {home}</dd></div>
            <div><dt>Margin</dt><dd>{Math.abs(pred.margin) < 0.5 ? "Even" : `${pred.margin > 0 ? home : away} by ${one(Math.abs(pred.margin))}`}</dd></div>
            <div><dt>Total points</dt><dd>{Math.round(score.home + score.away)}</dd></div>
          </dl>
          <Drivers model={model} contributions={pred.contributions} pHome={pred.pHome} home={home} away={away} playoff={playoff} />
        </section>

        <section className="panel span-2 fill" aria-labelledby="form">
          <header><h2 id="form">Form going in</h2></header>
          <FormTable home={home} away={away} teams={teams} date={date} season={meta.season}
            strengths={[strength(lineups[away]), strength(lineups[home])]} />
          <p className="small muted foot">
            Picks the winner {pct(meta.game_metrics.accuracy, 1)} of the time on the {seasonLabel(meta.game_metrics.test_season)} season,
            against {pct(meta.game_metrics.home_accuracy, 1)} for always taking the home team.
          </p>
        </section>

        <RosterCard team={teams[away]} abbr={away} toggles={tg(away)} onChange={(v) => setTeam(away, v)}
          reported={reported(away)} report={injuries.report} />
        <RosterCard team={teams[home]} abbr={home} toggles={tg(home)} onChange={(v) => setTeam(home, v)}
          reported={reported(home)} report={injuries.report} />
      </div>
      <SeasonLog />
    </>
  );
}

function Answer({ home, away, pHome, teams }: { home: string; away: string; pHome: number; teams: Record<string, TeamState> }) {
  const p = useTween(pHome);
  const fav = pHome >= 0.5 ? home : away;
  const dog = fav === home ? away : home;
  const pf = fav === home ? p : 1 - p;
  return (
    <>
      <div className="answer-row">
        <div>
          <div className="answer">{(pf * 100).toFixed(1)}%<small>{teams[fav].name}</small></div>
        </div>
        <div className="answer-side">
          <div className="answer">{((1 - pf) * 100).toFixed(1)}%</div>
          <div className="small muted">{teams[dog].name}</div>
        </div>
      </div>
      {/* away on the left, home on the right, as in the title; the favourite carries the hue */}
      <div className="prob" role="img" aria-label={`${away} ${pct(1 - pHome)}, ${home} ${pct(pHome)}`}>
        <div className={`seg ${fav === away ? "fav" : "dog"}`} style={{ flexBasis: `${(1 - p) * 100}%` }} />
        <div className={`seg ${fav === home ? "fav" : "dog"}`} style={{ flexBasis: `${p * 100}%` }} />
        <span className="mid" />
      </div>
      <div className="prob-legend"><span>{away} · away</span><span>50%</span><span>home · {home}</span></div>
    </>
  );
}

/** Each driver's effect in win-probability points: the chance with it, minus the chance without it. */
function Drivers({ model, contributions, pHome, home, away, playoff }: {
  model: GameModel; contributions: Record<string, number>; pHome: number; home: string; away: string; playoff: boolean;
}) {
  const grouped: Record<string, number> = { "Home court": model.intercept };
  for (const [name, c] of Object.entries(contributions)) {
    const g = DRIVER_GROUP[name] ?? name;
    grouped[g] = (grouped[g] ?? 0) + c;
  }
  const z = Math.log(pHome / (1 - pHome));
  if (!playoff) delete grouped["Playoff game"];
  const rows = Object.entries(grouped)
    .map(([name, c]) => [name, (pHome - sigmoid(z - c)) * 100] as const)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const scale = Math.max(20, ...rows.map(([, v]) => Math.abs(v)));
  return (
    <div className="drivers">
      <header className="chart-head">
        <h3>What moves it</h3>
        <span className="small muted">points of win probability, {away} ← → {home}</span>
      </header>
      {rows.map(([name, pts]) => {
        const w = (Math.abs(pts) / scale) * 50;
        return (
          <div className="driver" key={name}>
            <span>{name}</span>
            <span className="track" aria-hidden>
              <span className="bar" style={{ left: pts >= 0 ? "50%" : `${50 - w}%`, width: `${w}%` }} />
            </span>
            <span className="val">{Math.abs(pts) < 0.05 ? <span className="muted">0.0</span> : <>{pts >= 0 ? home : away} {signed(Math.abs(pts))}</>}</span>
          </div>
        );
      })}
    </div>
  );
}

function FormTable({ home, away, teams, date, season, strengths }: {
  home: string; away: string; teams: Record<string, TeamState>; date: string; season: number; strengths: number[];
}) {
  const t = [teams[away], teams[home]];
  const fresh = t.every((x) => x.n_games === 0);
  const rest = (x: TeamState) => (x.last_game ? Math.min(Math.max(daysBetween(date, x.last_game), 0), REST_CAP) : REST_CAP);
  const dash = <span className="muted">—</span>;
  const rows: [string, (x: TeamState, i: number) => ReactNode][] = [
    ["Elo rating", (x) => Math.round(x.elo)],
    ["Lineup strength", (_, i) => <span title="Game Score per game of the lineup that plays">{one(strengths[i])}</span>],
    [`${seasonLabel(season)} margin`, (x) => (x.n_games ? signed(x.mar_season) : dash)],
    ["Last 10 margin", (x) => (x.n_games ? signed(x.mar_l10) : dash)],
    ["Games played", (x) => x.n_games],
    ["Days of rest", (x) => (rest(x) >= REST_CAP ? `${REST_CAP}+` : rest(x))],
    ["Back-to-back", (x) => (rest(x) <= 1 ? "Yes" : "No")],
    ["Last game", (x) => (x.last_game ? prettyDate(x.last_game).replace(/^\w+, /, "") : dash)],
  ];
  return (
    <>
      <table>
        <thead><tr><th>Team</th><th className="n">{away}</th><th className="n">{home}</th></tr></thead>
        <tbody>
          {rows.map(([label, f]) => (
            <tr key={label}><td>{label}</td>{t.map((x, i) => <td key={i} className="n">{f(x, i)}</td>)}</tr>
          ))}
        </tbody>
      </table>
      {fresh && <p className="small muted" style={{ marginTop: 8 }}>Neither team has played in {seasonLabel(season)} yet, so ratings carry over from last season.</p>}
    </>
  );
}

function PastResult({ row, teams }: { row: GameBacktest; teams: Record<string, TeamState> }) {
  const [, away, home, awayPts, homePts, pHome] = row;
  const picked = pHome >= 0.5 ? home : away;
  const won = homePts > awayPts ? home : away;
  return (
    <div className="grid">
      <section className="panel span-4" aria-labelledby="wp">
        <header>
          <h2 id="wp">Win probability before tip-off</h2>
          <span className={`pill ${picked === won ? "pos" : "neg"}`}>{picked === won ? "Picked the winner" : "Missed"}</span>
        </header>
        <Answer home={home} away={away} pHome={pHome} teams={teams} />
        <dl className="facts">
          <div><dt>Final score</dt><dd>{away} {awayPts} – {homePts} {home}</dd></div>
          <div><dt>Winner</dt><dd>{teams[won].name}</dd></div>
          <div><dt>Margin</dt><dd>{won} by {Math.abs(homePts - awayPts)}</dd></div>
        </dl>
      </section>
      <section className="panel span-2" aria-labelledby="bt">
        <header><h2 id="bt">About past games</h2></header>
        <p className="prose muted">
          This is the model's forecast from a version trained only on earlier seasons, so it never saw this
          game. Roster toggles and the driver breakdown are for upcoming games.
        </p>
      </section>
    </div>
  );
}

function Loading() {
  return (
    <>
      <div className="title-row"><div><h1>Game predictor</h1><p className="finding muted">Loading the latest ratings…</p></div></div>
      <div className="grid">
        <div className="panel span-4"><div className="skeleton" style={{ height: 40, width: 220 }} /><div className="skeleton" style={{ height: 14, marginTop: 14 }} /></div>
        <div className="panel span-2"><div className="skeleton" style={{ height: 160 }} /></div>
      </div>
    </>
  );
}

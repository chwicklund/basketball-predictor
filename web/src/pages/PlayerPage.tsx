import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import Chart from "../components/Chart";
import PlayerSearch from "../components/PlayerSearch";
import TeamSelect from "../components/TeamSelect";
import { loadStatModels, useFiles } from "../lib/data";
import { playerFeatures, vacatedMinutes } from "../lib/features";
import { STAT_LABEL, one, prettyDate, seasonLabel, signed } from "../lib/format";
import type { PlayerBacktest, PlayerState, StatRange } from "../lib/types";
import { useTween } from "../lib/useTween";

const DEFAULT_PLAYER = "jokicni01";
const TARGETS = ["MIN", "PTS", "TRB", "AST", "3P", "STL", "BLK", "TOV"];
const COL = (s: string) => 4 + TARGETS.indexOf(s);  // stat column in a GameLine
const shortDate = (d: string) => {
  const [, m, day] = d.split("-").map(Number);
  return `${day} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]}`;
};
const l10 = (p: PlayerState, s: string) => (s === "MIN" ? p.st_min_l10 : p[`st_l10_${s}`]) as number;

export default function PlayerPage() {
  const files = useFiles("meta.json", "players.json", "teams.json", "opponents.json", "quantiles.json",
    "feature_spec.json", "schedule.json", "history.json");
  const [params, setParams] = useSearchParams();
  const [out, setOut] = useState<string[]>([]);
  const [minutes, setMinutes] = useState("");
  const [stat, setStat] = useState("PTS");
  const [proj, setProj] = useState<Record<string, StatRange>>();
  const [error, setError] = useState<string>();

  const players = files?.["players.json"];
  const meta = files?.["meta.json"];
  const pid = params.get("p") ?? (players && DEFAULT_PLAYER in players ? DEFAULT_PLAYER : Object.keys(players ?? {})[0]);
  const p = pid ? players?.[pid] : undefined;

  // Default to the player's team's next scheduled game
  const next = files?.["schedule.json"].find((g) => p && (g[1] === p.team || g[2] === p.team));
  const opp = params.get("opp") ?? (next ? (next[2] === p?.team ? next[1] : next[2]) : p?.team === "LAL" ? "BOS" : "LAL");
  const date = params.get("date") ?? next?.[0] ?? meta?.as_of ?? "";
  const isHome = Number(params.get("home") ?? (next ? Number(next[2] === p?.team) : 1));
  const past = meta !== undefined && date < meta.as_of;
  const set = (patch: Record<string, string>) =>
    setParams({ p: pid ?? "", opp, date, home: String(isHome), ...patch }, { replace: true });

  useEffect(() => { setOut([]); setMinutes(""); }, [pid]);

  const teammates = useMemo(() => {
    if (!players || !p || !meta || !files) return [];
    const rotation = files["feature_spec.json"].rotation_min;
    return Object.entries(players)
      .filter(([id, q]) => id !== pid && q.team === p.team && q.st_season >= meta.season - 1 && (q.st_min_l10 as number) >= rotation)
      .sort((a, b) => (b[1].st_min_l10 as number) - (a[1].st_min_l10 as number))
      .slice(0, 7);
  }, [players, p, pid, meta, files]);

  useEffect(() => {
    if (!files || !p || past) return;
    const spec = files["feature_spec.json"];
    const teams = files["teams.json"];
    const f = playerFeatures(p, teams[p.team], teams[opp], files["opponents.json"][opp], date, isHome,
      spec.rate_stats, vacatedMinutes(out.map((id) => files["players.json"][id]), spec.rotation_min));
    const override = minutes === "" ? null : Math.min(48, Math.max(0, Number(minutes)));
    let live = true;
    loadStatModels(spec.targets)
      .then((m) => m.predict(spec.player.map((n) => f[n]), files["quantiles.json"], override))
      .then((r) => { if (live) { setProj(r); setError(undefined); } })
      .catch((e) => live && setError(String(e)));
    return () => { live = false; };
  }, [files, p, opp, date, isHome, out, minutes, past]);

  if (!files || !meta || !players) return <div className="title-row"><div><h1>Player projections</h1><p className="finding muted">Loading…</p></div></div>;
  const teams = files["teams.json"];
  const pick = (id: string) => setParams({ p: id }, { replace: true });
  if (!p || !pid) {
    return (
      <div className="title-row"><div><h1>Player projections</h1><p className="finding muted">Search for a player to project.</p></div>
        <PlayerSearch players={players} onPick={pick} /></div>
    );
  }
  const vs = files["history.json"][pid]?.[opp];
  const oppName = teams[opp]?.name ?? opp;
  const where = isHome ? `against the ${oppName}` : `at the ${oppName}`;
  const pts = proj?.PTS.mean;
  const finding = past ? `How his ${seasonLabel(meta.player_test_season)} projection ${where} on ${prettyDate(date)} compared with what he did.`
    : pts === undefined ? `Projecting ${where}…`
    : `Projects ${one(pts)} points, ${one(proj!.TRB.mean)} rebounds and ${one(proj!.AST.mean)} assists ${where}, `
      + `${signed(pts - l10(p, "PTS"))} points against his last-10 average.`;

  return (
    <>
      <div className="title-row">
        <div>
          <h1>{p.player}</h1>
          <p className="finding">{finding}</p>
          <p className="small muted" style={{ marginTop: 4 }}>
            {teams[p.team]?.name ?? p.team} · {{ G: "Guard", F: "Forward", C: "Center" }[p.pos]} · last played {prettyDate(p.st_last_date)}
          </p>
        </div>
        <PlayerSearch players={players} onPick={pick} />
      </div>

      <div className="controls">
        <TeamSelect label="Opponent" value={opp} teams={teams} exclude={p.team} onChange={(t) => set({ opp: t })} />
        <label className="control">
          <span>Date</span>
          <input type="date" className="input" value={date} onChange={(e) => set({ date: e.target.value })} />
        </label>
        <div className="control">
          <span id="venue">Venue</span>
          <div className="segmented" role="group" aria-labelledby="venue">
            <button aria-pressed={isHome === 1} onClick={() => set({ home: "1" })}>Home</button>
            <button aria-pressed={isHome === 0} onClick={() => set({ home: "0" })}>Away</button>
          </div>
        </div>
        {!past && (
          <label className="control">
            <span>Minutes</span>
            <input type="number" min={0} max={48} step={1} className="input" style={{ width: 128 }} placeholder="Model decides"
              value={minutes} onChange={(e) => setMinutes(e.target.value)} />
          </label>
        )}
      </div>

      {past ? <PastProjection pid={pid} date={date} testSeason={meta.player_test_season} asOf={meta.as_of} />
        : (
          <>
            {error && <div className="panel" style={{ marginBottom: 12 }}><p>Couldn't run the model: {error}. <button className="btn ghost" onClick={() => location.reload()}>Retry</button></p></div>}
            <div className="kpis" role="tablist" aria-label="Projected stats">
              {TARGETS.map((s) => <StatTab key={s} stat={s} range={proj?.[s]} p={p} selected={s === stat} onSelect={() => setStat(s)} />)}
            </div>
            <div className="grid">
              <section className="panel span-4 fill" aria-labelledby="recent">
                <div className="chart-head">
                  <h2 id="recent">{STAT_LABEL[stat]}, last {p.recent.length} games</h2>
                  <span className="legend"><span><i style={{ background: "#8a8a8a", borderRadius: 1 }} />Played</span><span><i style={{ background: "var(--hue)", borderRadius: 1 }} />Tonight, projected</span></span>
                </div>
                <Chart label={`${STAT_LABEL[stat]} in his last games against the projection`} deps={[pid, stat, proj?.[stat]?.mean]}
                  draw={(el, C) => {
                    // last 10 in grey, then tonight's projection as the one bar in the hue
                    const games = [...p.recent].reverse();
                    const tonight = proj?.[stat];
                    C.bars(el, {
                      labels: [...games.map((g) => `${g[2] ? "" : "@"}${g[1]}`), ...(tonight ? ["Tonight"] : [])],
                      values: [...games.map((g) => g[COL(stat)] as number), ...(tonight ? [tonight.mean] : [])],
                      highlight: tonight ? games.length : -1, mutedColour: "#8a8a8a", height: 296,
                      format: C.fmt.dec(1), tickFormat: C.fmt.int,
                      reference: tonight ? { value: l10(p, stat), label: "" } : undefined,
                    });
                  }} />
                <p className="small muted foot">
                  {p.recent.length ? `${shortDate(p.recent[p.recent.length - 1][0])} to ${shortDate(p.recent[0][0])}; the dashed line is his last-10 average, ${one(l10(p, stat))}` : ""}
                </p>
              </section>

              <section className="panel span-2 fill" aria-labelledby="mates">
                <header><h2 id="mates">Teammates out</h2><span className="meta">{out.length ? `${out.length} out` : "all playing"}</span></header>
                <ul className="mates">
                  {teammates.map(([id, q]) => {
                    const isOut = out.includes(id);
                    return (
                      <li key={id} className={isOut ? "out" : ""}>
                        <span className="name">{q.player}</span>
                        <span className="muted num small" style={{ marginLeft: "auto" }}>{one(q.st_min_l10 as number)} min</span>
                        <input type="checkbox" className="switch" checked={!isOut} aria-label={`${q.player} ${isOut ? "out" : "playing"}`}
                          onChange={() => setOut(isOut ? out.filter((x) => x !== id) : [...out, id])} />
                      </li>
                    );
                  })}
                  {teammates.length === 0 && <li className="muted">No rotation teammates found.</li>}
                </ul>
                <h3 style={{ marginTop: 18 }}>Against the {oppName}</h3>
                <p className="muted" style={{ marginTop: 4 }}>
                  {vs ? <>{vs[0]} games since 2019-20: <span className="num" style={{ color: "var(--text)" }}>{one(vs[2])} pts, {one(vs[3])} reb, {one(vs[4])} ast</span></>
                    : "No games against them since 2019-20."}
                </p>
              </section>

              <section className="panel span-6" aria-labelledby="log">
                <header><h2 id="log">Game log</h2><span className="meta">Last {p.recent.length}</span></header>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Date</th><th>Opponent</th>{TARGETS.map((s) => <th key={s} className="n">{s === "TRB" ? "REB" : s === "3P" ? "3PM" : s}</th>)}</tr></thead>
                    <tbody>
                      {p.recent.map((g) => (
                        <tr key={g[0]}>
                          <td>{shortDate(g[0])}</td>
                          <td>{g[2] ? "vs" : "at"} {g[1]}</td>
                          {TARGETS.map((s) => <td key={s} className={`n${s === stat ? " lead" : ""}`}>{s === "MIN" ? one(g[COL(s)] as number) : g[COL(s)]}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
          </>
        )}
    </>
  );
}

function StatTab({ stat, range, p, selected, onSelect }: {
  stat: string; range?: StatRange; p: PlayerState; selected: boolean; onSelect: () => void;
}) {
  const v = useTween(range?.mean ?? NaN);
  return (
    <button className="kpi" role="tab" aria-selected={selected} onClick={onSelect}>
      <div className="kpi-label">{STAT_LABEL[stat]}</div>
      <div className="kpi-value">{range ? one(v) : <span className="skeleton" style={{ display: "inline-block", width: 56, height: 28 }} />}</div>
      <div className="kpi-sub">{range ? `${one(range.p10)}–${one(range.p90)} likely` : " "}</div>
      <div className="kpi-sub">Last 10: {one(l10(p, stat))}</div>
    </button>
  );
}

function PastProjection({ pid, date, testSeason, asOf }: { pid: string; date: string; testSeason: number; asOf: string }) {
  const files = useFiles("player_backtest.json");
  if (!files) return <div className="panel"><div className="skeleton" style={{ height: 80 }} /></div>;
  const row: PlayerBacktest | undefined = files["player_backtest.json"][pid]?.find((g) => g[0] === date);
  if (!row) {
    return (
      <div className="panel"><div className="empty">
        No {seasonLabel(testSeason)} game for him on {prettyDate(date)}. Past dates show the out-of-sample projection
        for games in the {seasonLabel(testSeason)} backtest; for a new projection pick a date from {prettyDate(asOf)} on.
      </div></div>
    );
  }
  const n = TARGETS.length;
  return (
    <div className="kpis" aria-label="Projected and actual stats">
      {TARGETS.map((s, i) => (
        <div className="kpi" key={s} style={{ cursor: "default" }}>
          <div className="kpi-label">{STAT_LABEL[s]}</div>
          <div className="kpi-value">{row[3 + n + i]}</div>
          <div className="kpi-sub">Projected {one(row[3 + i] as number)}</div>
        </div>
      ))}
    </div>
  );
}

import Chart from "../components/Chart";
import { TitleSide } from "../components/ViewToggle";
import { HBars, SignedBars } from "../components/viz";
import { useFiles } from "../lib/data";
import { STAT_LABEL, pct, prettyDate, seasonLabel } from "../lib/format";
import { HOME, STAT_COLOR } from "../lib/palette";
import type { Meta, TrackRecord } from "../lib/types";
import { useView } from "../lib/view";

const GREY = "#9a9995";  // the baselines the model is measured against

export default function AboutPage() {
  const files = useFiles("meta.json", "track_record.json");
  const view = useView();
  if (!files) return <div className="title-row"><div><h1>Model report</h1><p className="finding muted">Loading…</p></div></div>;
  const meta = files["meta.json"];
  const g = meta.game_metrics;
  const pm = meta.player_metrics;
  const stats = Object.keys(pm);
  const beats = stats.filter((s) => pm[s].mae < pm[s].last10_mae).length;
  const live = files["track_record.json"];

  return (
    <>
      <div className="title-row">
        <div>
          <h1>Model report</h1>
          <p className="finding">
            On the {seasonLabel(g.test_season)} season, which neither model trained on, the game model picked {pct(g.accuracy, 1)} of
            winners and the player model beat the last-10 average on {beats} of {stats.length} stats.
          </p>
          <p className="small muted" style={{ marginTop: 4 }}>
            Basketball-Reference box scores and game logs, 2019-20 to {prettyDate(meta.data_through)} · rebuilt {new Date(meta.generated_at).toLocaleDateString()}
          </p>
        </div>
        <TitleSide />
      </div>

      <div className="stats">
        <div className="stat"><div className="label">Winners picked</div><div className="value lead">{pct(g.accuracy, 1)}</div><div className="note">of {g.games.toLocaleString()} games</div></div>
        <div className="stat"><div className="label">Elo ratings alone</div><div className="value">{pct(g.elo_accuracy, 1)}</div><div className="note">always home: {pct(g.home_accuracy, 1)}</div></div>
        <div className="stat"><div className="label">Log loss</div><div className="value">{g.log_loss.toFixed(3)}</div><div className="note">lower is better; a coin flip is 0.693</div></div>
        <div className="stat"><div className="label">Margin miss</div><div className="value">{g.margin_mae.toFixed(1)}<span className="muted" style={{ fontSize: 14, marginLeft: 4 }}>pts</span></div><div className="note">average, per game</div></div>
      </div>

      {view === "charts" ? <ReportCharts meta={meta} live={live} /> : (
      <div className="grid">
        <section className="panel span-3" aria-labelledby="cal">
          <div className="chart-head">
            <h2 id="cal">Calibration</h2>
            <CalibrationLegend />
          </div>
          <Calibration calibration={g.calibration} />
        </section>

        <section className="panel span-3" aria-labelledby="miss">
          <div className="chart-head">
            <h2 id="miss">Player model, average miss</h2>
            <span className="small muted">bar: model · tick: last-10 average</span>
          </div>
          <Chart label="Model's average miss per stat against the last-10 average's" deps={[pm]}
            draw={(el, C) => C.bullet(el, stats.map((s) => ({ label: STAT_LABEL[s], value: pm[s].mae, target: pm[s].last10_mae })),
              { format: C.fmt.dec(2), better: "lower" })} />
        </section>

        <section className="panel span-6" aria-labelledby="table">
          <header><h2 id="table">Player model by stat, {seasonLabel(meta.player_test_season)}</h2><span className="meta">average miss per game; lower is better</span></header>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Stat</th><th className="n">Model</th><th className="n">Last-10 average</th><th className="n">Season average</th><th className="n">Model edge</th><th className="n">In likely range</th></tr></thead>
              <tbody>
                {stats.map((s) => {
                  const m = pm[s];
                  const edge = (m.last10_mae - m.mae) / m.last10_mae;
                  return (
                    <tr key={s}>
                      <td className="lead">{STAT_LABEL[s]}</td>
                      <td className="n">{m.mae.toFixed(2)}</td>
                      <td className="n">{m.last10_mae.toFixed(2)}</td>
                      <td className="n">{m.season_mae.toFixed(2)}</td>
                      <td className="n" style={{ color: edge > 0 ? "var(--positive)" : "var(--negative)" }}>{edge > 0 ? "+" : "−"}{pct(Math.abs(edge), 1)}</td>
                      <td className="n">{pct(m.coverage)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="small muted" style={{ marginTop: 10 }}>
            The likely range holds 8 in 10 results in principle; whole-number stats like steals and blocks land inside it more often.
            Blocks miss by slightly more than the last-10 average: a mean forecast of a mostly-zero stat loses on absolute error, though it wins on squared error.
          </p>
        </section>

        <section className="panel span-6" aria-labelledby="live">
          <header>
            <h2 id="live">Live track record</h2>
            <span className="meta">{live.since ? `calls logged before tip-off since ${prettyDate(live.since)}` : "not started"}</span>
          </header>
          {live.games && live.correct !== undefined ? (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Measure</th><th className="n">Live</th><th className="n">{seasonLabel(g.test_season)} backtest</th></tr></thead>
                <tbody>
                  <tr><td>Winners picked</td><td className="n">{pct(live.correct / live.games, 1)} <span className="muted">({live.correct} of {live.games})</span></td><td className="n">{pct(g.accuracy, 1)}</td></tr>
                  <tr><td>Log loss</td><td className="n">{live.log_loss!.toFixed(3)}</td><td className="n">{g.log_loss.toFixed(3)}</td></tr>
                  <tr><td>Margin miss</td><td className="n">{live.margin_mae!.toFixed(1)} pts</td><td className="n">{g.margin_mae.toFixed(1)} pts</td></tr>
                  {stats.filter((s) => live.players[s]).map((s) => (
                    <tr key={s}><td>{STAT_LABEL[s]} miss</td><td className="n">{live.players[s].mae.toFixed(2)}</td><td className="n">{pm[s].mae.toFixed(2)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty">
              {live.pending.length ? `${live.pending.length} calls are waiting on results; the first grades land the morning after.`
                : "A daily job logs a call for every game before tip-off; results appear here once games are played."}
            </div>
          )}
        </section>
      </div>
      )}

      <div className="grid" style={{ marginTop: "var(--gap)" }}>
        <section className="panel span-6 prose" aria-labelledby="how">
          <header><h2 id="how">How it works</h2></header>
          <p><b>Game predictor.</b> A logistic regression on team Elo ratings, season and last-10 point differential, rest and back-to-backs,
            and roster strength: each player's Game Score per 36 minutes, weighted by the minutes he'd play, for the expected
            rotation against the lineup that actually takes the floor. Switching players off on the Game screen changes that lineup.</p>
          <p><b>Player predictor.</b> One gradient-boosted model projects minutes, then one per stat projects production per 36 minutes from
            his recent and season form, last season's usage, the opponent's defense against his position, rest, venue and teammates who are out.
            The projection is rate times minutes; the likely range is the 10th to 90th percentile of results with a similar projection.</p>
          <p><b>No look-ahead.</b> Every input uses only games before the one being predicted, and the models run in your browser on the same
            inputs as in training, which tests check. For fun, not betting advice.</p>
        </section>
      </div>
    </>
  );
}

function CalibrationLegend() {
  return <span className="legend"><span><i style={{ background: HOME }} />Home teams' actual win rate</span><span><i style={{ background: GREY }} />Predicted</span></span>;
}

function Calibration({ calibration }: { calibration: Meta["game_metrics"]["calibration"] }) {
  return (
    <>
      <Chart label="Predicted against actual home win rate by probability bucket" deps={[calibration]}
        draw={(el, C) => C.line(el, {
          labels: calibration.map((c) => pct(c.p)),
          series: [{ name: "Actual", values: calibration.map((c) => c.actual), colour: HOME },
                   { name: "Predicted", values: calibration.map((c) => c.p), colour: GREY }],
          format: C.fmt.pct(0), yTicks: [0, 0.25, 0.5, 0.75, 1], height: 220,
        })} />
      <p className="small muted" style={{ marginTop: 8 }}>Games grouped by the model's home win probability. Where the lines meet, a 70% call won 70% of the time.</p>
    </>
  );
}

/** The report as charts: game model against simpler rules, player model against the last-10 average, the live record. */
function ReportCharts({ meta, live }: { meta: Meta; live: TrackRecord }) {
  const g = meta.game_metrics;
  const pm = meta.player_metrics;
  const stats = Object.keys(pm);
  const edge = (s: string) => (100 * (pm[s].last10_mae - pm[s].mae)) / pm[s].last10_mae;
  const signedPct = (v: number) => `${v > 0 ? "+" : v < 0 ? "\u2212" : ""}${Math.abs(v).toFixed(1)}%`;
  return (
    <div className="grid">
      <section className="panel span-3" aria-labelledby="cal">
        <div className="chart-head"><h2 id="cal">Calibration</h2><CalibrationLegend /></div>
        <Calibration calibration={g.calibration} />
      </section>

      <section className="panel span-3" aria-labelledby="vs-rules">
        <header><h2 id="vs-rules">Winners picked, {seasonLabel(g.test_season)}</h2><span className="meta">{g.games.toLocaleString()} games</span></header>
        <HBars max={100} format={(v) => `${v.toFixed(1)}%`} rows={[
          { label: "This model", value: 100 * g.accuracy, color: HOME },
          { label: "Elo alone", value: 100 * g.elo_accuracy, color: GREY },
          { label: "Always home", value: 100 * g.home_accuracy, color: GREY },
          { label: "Coin flip", value: 50, color: "#d4d3d0" },
        ]} />
        <p className="small muted" style={{ marginTop: 10 }}>Same games, same season; the model adds lineups, form and rest to the Elo ratings.</p>
      </section>

      <section className="panel span-3" aria-labelledby="edge">
        <header><h2 id="edge">Player model edge by stat</h2><span className="meta">smaller miss than the last-10 average</span></header>
        <SignedBars format={signedPct} scale={Math.max(...stats.map((s) => Math.abs(edge(s))), 5)}
          rows={stats.map((s) => ({
            label: STAT_LABEL[s], value: edge(s), color: STAT_COLOR[s],
            tip: <><b>{STAT_LABEL[s]}</b><br />model misses by {pm[s].mae.toFixed(2)}<br />last-10 average by {pm[s].last10_mae.toFixed(2)}</>,
          }))} />
        <div className="signed-axis"><span>last 10 better</span><span>model better</span></div>
      </section>

      <section className="panel span-3" aria-labelledby="cover">
        <header><h2 id="cover">Results inside the likely range</h2><span className="meta">aim: 80%</span></header>
        <HBars max={100} format={(v) => `${Math.round(v)}%`}
          rows={stats.map((s) => ({ label: STAT_LABEL[s], value: 100 * pm[s].coverage, color: STAT_COLOR[s], note: "aim 80%" }))} />
        <p className="small muted" style={{ marginTop: 10 }}>Whole-number stats like steals and blocks land inside more often than 8 in 10.</p>
      </section>

      <section className="panel span-6" aria-labelledby="live">
        <header>
          <h2 id="live">Live track record</h2>
          <span className="meta">{live.since ? `calls logged before tip-off since ${prettyDate(live.since)}` : "not started"}</span>
        </header>
        {live.games && live.correct !== undefined ? (
          <div className="tile-row">
            <div className="tile"><div className="label">Winners picked</div><div className="value">{pct(live.correct / live.games, 1)}</div>
              <div className="small muted">{live.correct} of {live.games} · backtest {pct(g.accuracy, 1)}</div></div>
            <div className="tile"><div className="label">Log loss</div><div className="value">{live.log_loss!.toFixed(3)}</div>
              <div className="small muted">backtest {g.log_loss.toFixed(3)} · lower is better</div></div>
            <div className="tile"><div className="label">Margin miss</div><div className="value">{live.margin_mae!.toFixed(1)} pts</div>
              <div className="small muted">backtest {g.margin_mae.toFixed(1)} pts</div></div>
          </div>
        ) : (
          <div className="empty">
            {live.pending.length ? `${live.pending.length} calls are waiting on results; the first grades land the morning after.`
              : "A daily job logs a call for every game before tip-off; results appear here once games are played."}
          </div>
        )}
      </section>
    </div>
  );
}

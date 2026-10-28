import { useState } from "react";
import Chart from "./Chart";
import { CallLegend, CallStrip, HBars } from "./viz";
import { useFiles } from "../lib/data";
import { pct, seasonLabel } from "../lib/format";
import { HOME } from "../lib/palette";
import { useView } from "../lib/view";

const SHOWN = 15;
const BUCKETS = [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 1.01]];
const shortDate = (d: string) => {
  const [, m, day] = d.split("-").map(Number);
  return `${day} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]}`;
};

/** Every call the daily job logged this season, and whether it was right. */
export default function SeasonLog() {
  const files = useFiles("track_record.json", "meta.json");
  const [all, setAll] = useState(false);
  const view = useView();
  if (!files) return null;
  const tr = files["track_record.json"];
  const backtest = files["meta.json"].game_metrics.accuracy;
  const right = tr.log.filter(([, , , p, vp, hp]) => (p >= 0.5) === (hp > vp)).length;
  const rows = [
    ...tr.pending.map(([date, v, h, p, pv, ph]) => ({ date, v, h, p, final: null as null | [number, number], proj: [pv, ph], back: false })),
    ...tr.log.map(([date, v, h, p, vp, hp, back]) => ({ date, v, h, p, final: [vp, hp] as [number, number], proj: null, back: Boolean(back) })),
  ];
  const shown = all ? rows : rows.slice(0, SHOWN);
  const backfilled = rows.filter((r) => r.back).length;

  return (
    <section className="panel season-log" aria-labelledby="calls">
      <header>
        <h2 id="calls">{tr.season ? `${seasonLabel(tr.season)} calls` : "This season's calls"}</h2>
        <span className="meta">
          {tr.log.length ? `${right} of ${tr.log.length} right · ${pct(right / tr.log.length, 1)}` : "No results yet"}
          {tr.pending.length ? ` · ${tr.pending.length} pending` : ""}
        </span>
      </header>
      {rows.length === 0 ? (
        <div className="empty">Calls are logged before tip-off on every game day (noon Eastern on weekends and holidays, 5 p.m. other days), and graded the next morning.</div>
      ) : view === "charts" ? (
        <CallCharts rows={rows} backtest={backtest} />
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Date</th><th>Game</th><th>Pick</th><th className="n">Chance</th><th className="n">Final</th><th className="n">Result</th></tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const pick = r.p >= 0.5 ? r.h : r.v;
                  const ok = r.final && (r.p >= 0.5) === (r.final[1] > r.final[0]);
                  return (
                    <tr key={r.date + r.v + r.h}>
                      <td>{shortDate(r.date)}{r.back && <span className="muted" title="Backfilled: predicted after the game, from data before it"> †</span>}</td>
                      <td>{r.v} at {r.h}</td>
                      <td className="lead">{pick}</td>
                      <td className="n">{pct(Math.max(r.p, 1 - r.p))}</td>
                      <td className="n">{r.final ? `${r.v} ${r.final[0]} – ${r.final[1]} ${r.h}`
                        : <span className="muted">proj. {Math.round(r.proj![0])} – {Math.round(r.proj![1])}</span>}</td>
                      <td className="n">
                        {r.final ? <span className={`pill ${ok ? "pos" : "neg"}`}>{ok ? "Right" : "Wrong"}</span>
                          : <span className="pill">Pending</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {rows.length > SHOWN && (
            <button className="btn ghost show-all" onClick={() => setAll(!all)}>
              {all ? "Show fewer" : `Show all ${rows.length}`}
            </button>
          )}
          {tr.since && (
            <p className="small muted" style={{ marginTop: 8 }}>
              {backfilled > 0 && <>† {backfilled} {backfilled === 1 ? "call was" : "calls were"} backfilled: made after the game, using only data from before it. </>}
              Logged daily before tip-off since {shortDate(tr.since)}, at noon Eastern on weekends and holidays, 5 p.m. other days, assuming each team's usual rotation. Games are graded once the final score is in.
            </p>
          )}
        </>
      )}
    </section>
  );
}

type Row = { date: string; v: string; h: string; p: number; final: null | [number, number]; proj: number[] | null; back: boolean };

/** Every call as a square in date order, the running hit rate, and how often each level of confidence was right. */
function CallCharts({ rows, backtest }: { rows: Row[]; backtest: number }) {
  const graded = rows.filter((r) => r.final).reverse();  // the log is newest first
  const pending = rows.filter((r) => !r.final);
  const right = (r: Row) => (r.p >= 0.5) === (r.final![1] > r.final![0]);
  const calls = [...graded, ...pending].map((r) => {
    const pick = r.p >= 0.5 ? r.h : r.v;
    return {
      key: r.date + r.v + r.h,
      state: (r.final ? (right(r) ? "right" : "wrong") : "pending") as "right" | "wrong" | "pending",
      tip: <>{shortDate(r.date)} · {r.v} at {r.h}<br />Picked {pick}, {pct(Math.max(r.p, 1 - r.p))}
        <br />{r.final ? `Final ${r.v} ${r.final[0]} – ${r.final[1]} ${r.h}` : "Waiting on the result"}{r.back ? " · backfilled" : ""}</>,
    };
  });

  // the hit rate at the end of each day with results
  const days: { date: string; rate: number }[] = [];
  let hits = 0;
  graded.forEach((r, i) => {
    hits += Number(right(r));
    const day = { date: r.date, rate: hits / (i + 1) };
    if (days.length && days[days.length - 1].date === r.date) days[days.length - 1] = day; else days.push(day);
  });

  const buckets = BUCKETS.map(([lo, hi]) => {
    const inside = graded.filter((r) => Math.max(r.p, 1 - r.p) >= lo && Math.max(r.p, 1 - r.p) < hi);
    const ok = inside.filter(right).length;
    return { label: hi > 1 ? `${lo * 100}%+` : `${lo * 100}–${hi * 100}%`, n: inside.length, ok };
  }).filter((b) => b.n > 0);

  return (
    <>
      <div className="chart-head"><h3>Every call, in date order</h3><CallLegend /></div>
      <CallStrip calls={calls} />
      {graded.length > 0 && (
        <div className="grid" style={{ marginTop: 18 }}>
          <div className="span-3">
            <div className="chart-head">
              <h3>Hit rate so far</h3>
              <span className="small muted">dashed: {pct(backtest, 1)} in the backtest</span>
            </div>
            {days.length > 1 ? (
              <Chart label="Share of calls right, by day" deps={[graded.length, backtest]}
                draw={(el, C) => C.line(el, {
                  labels: days.map((d) => shortDate(d.date)),
                  series: [{ name: "Hit rate", values: days.map((d) => d.rate), colour: HOME }],
                  format: C.fmt.pct(1), tickFormat: C.fmt.pct(0), yTicks: [0, 0.25, 0.5, 0.75, 1], height: 180, endLabel: true,
                  reference: { value: backtest, label: "Backtest" },
                })} />
            ) : <p className="muted">{pct(days[0].rate, 1)} after the first day of results.</p>}
          </div>
          <div className="span-3">
            <div className="chart-head">
              <h3>Right, by how sure it was</h3>
              <span className="small muted">share of calls right</span>
            </div>
            <HBars max={100} format={(v) => `${Math.round(v)}%`} rows={buckets.map((b) => ({
              label: b.label, value: (100 * b.ok) / b.n, color: HOME, note: `${b.ok} of ${b.n}`,
            }))} />
            <p className="small muted" style={{ marginTop: 8 }}>A well-calibrated model is right more often the surer it is.</p>
          </div>
        </div>
      )}
    </>
  );
}

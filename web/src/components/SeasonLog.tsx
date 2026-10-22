import { useState } from "react";
import { useFiles } from "../lib/data";
import { pct, seasonLabel } from "../lib/format";

const SHOWN = 15;
const shortDate = (d: string) => {
  const [, m, day] = d.split("-").map(Number);
  return `${day} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]}`;
};

/** Every call the daily job logged this season, and whether it was right. */
export default function SeasonLog() {
  const files = useFiles("track_record.json");
  const [all, setAll] = useState(false);
  if (!files) return null;
  const tr = files["track_record.json"];
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

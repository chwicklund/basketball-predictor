import { strength } from "../lib/features";
import { one, reportTime } from "../lib/format";
import type { RosterEntry, TeamState } from "../lib/types";

export interface Toggles {
  out: string[];  // expected players sitting out
  add: string[];  // players outside the usual rotation who play
}

const TEAM_MIN = 240;
const LISTED = 9;       // expected players listed before "More players"
const LABEL_MIN = 20;   // a strip segment names its player at this many minutes or more
const SUFFIX = new Set(["Jr.", "Sr.", "II", "III", "IV"]);
const surname = (name: string) => name.split(" ").filter((w) => !SUFFIX.has(w)).slice(-1)[0];

/** A team's rotation as 240 minutes split by who plays, with each player's toggle. */
export default function RosterCard({ team, abbr, toggles, onChange, reported = [], report = null }: {
  team: TeamState; abbr: string; toggles: Toggles; onChange: (t: Toggles) => void;
  reported?: string[];      // players the injury report lists Out or Doubtful
  report?: string | null;   // when that report was published
}) {
  const playing = (r: RosterEntry) => (r.in_pool && !toggles.out.includes(r.name)) || toggles.add.includes(r.name);
  const lineup = team.roster.filter(playing);
  const total = lineup.reduce((s, r) => s + r.min, 0);
  const alloc = (r: RosterEntry) => (playing(r) && total > 0 ? (r.min * TEAM_MIN) / total : 0);
  const pool = team.roster.filter((r) => r.in_pool);
  const listed = pool.slice(0, LISTED);
  const others = [...pool.slice(LISTED), ...team.roster.filter((r) => !r.in_pool && !toggles.add.includes(r.name))];
  const lost = strength(pool.map((r) => [r.rate, r.min])) - strength(lineup.map((r) => [r.rate, r.min]));

  const flip = (r: RosterEntry) => {
    if (r.in_pool) {
      const out = toggles.out.includes(r.name) ? toggles.out.filter((n) => n !== r.name) : [...toggles.out, r.name];
      onChange({ ...toggles, out });
    } else {
      const add = toggles.add.includes(r.name) ? toggles.add.filter((n) => n !== r.name) : [...toggles.add, r.name];
      onChange({ ...toggles, add });
    }
  };
  const row = (r: RosterEntry) => (
    <li key={r.name} className={!playing(r) && r.in_pool ? "out" : toggles.add.includes(r.name) ? "added" : ""}>
      <span className="name">{r.name}</span>
      <span className="n">{playing(r) ? one(alloc(r)) : <span className="muted">—</span>}</span>
      <span className="n">{one(r.rate)}</span>
      <input type="checkbox" className="switch" checked={playing(r)} onChange={() => flip(r)}
        aria-label={`${r.name} ${playing(r) ? "plays" : "sits out"}`} />
    </li>
  );
  // the strip lists players in roster order, so a segment keeps its place while others grow into its minutes
  const strip = team.roster.filter((r) => r.in_pool || toggles.add.includes(r.name));

  return (
    <section className="panel span-3" aria-labelledby={`roster-${abbr}`}>
      <header>
        <h2 id={`roster-${abbr}`}>{team.name} rotation</h2>
        <span className="meta">{lineup.length} playing</span>
      </header>
      {team.roster.length === 0 ? <div className="empty">No box scores for this team yet.</div> : (
        <>
          <div className="strip" role="img" aria-label={`${TEAM_MIN} minutes: ${lineup.map((r) => `${r.name} ${Math.round(alloc(r))}`).join(", ")}`}>
            {strip.map((r) => (
              <span key={r.name} className="seg" title={`${r.name}: ${one(alloc(r))} min`}
                style={{ flexGrow: alloc(r), flexBasis: 0, padding: alloc(r) ? undefined : 0 }}>
                {alloc(r) >= LABEL_MIN ? surname(r.name) : ""}
              </span>
            ))}
          </div>
          <div className="strip-scale small"><span>0</span><span>Minutes if this lineup plays</span><span>{TEAM_MIN}</span></div>
          <ul className="roster">
            <li className="head"><span>Player</span><span className="n">Min</span><span className="n" title="Game Score per 36 minutes, recent games weighted most">Impact</span><span className="n">Plays</span></li>
            {listed.map(row)}
            {team.roster.filter((r) => toggles.add.includes(r.name)).map(row)}
          </ul>
          {reported.length > 0 && report && (
            <p className="small muted" style={{ marginTop: 6 }}>
              Injury report, {reportTime(report)} ET: {reported.join(", ")} {reported.length === 1 ? "is" : "are"} out or doubtful.
            </p>
          )}
          <p className="roster-change small">
            {lost > 0.05 ? <>Absences cost <b>{one(lost)}</b> Game Score a game.</>
              : lost < -0.05 ? <>Changes add <b>{one(-lost)}</b> Game Score a game.</>
              : <>Full expected rotation. Switch a player off to sit him out.</>}
          </p>
          {others.length > 0 && (
            <details className="more">
              <summary>More players ({others.length}): the deep bench, and anyone back from injury</summary>
              <ul className="roster">{others.map(row)}</ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}

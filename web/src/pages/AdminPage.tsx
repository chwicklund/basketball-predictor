import { type FormEvent, useCallback, useEffect, useState } from "react";
import { pct, prettyDate } from "../lib/format";
import { api, setAuthed, useSession } from "../lib/session";

interface Settings { running: boolean; amount: number; dry_run: boolean }
interface Wager {
  id: number; game_date: string; visitor: string; home: string; mode: "dry" | "live"; status: string; pick: string;
  p_pick: number; market_ticker: string | null; limit_price: number | null; count: number | null; fill_count: number | null;
  cost: number | null; fees: number | null; result: "won" | "lost" | null; pnl: number | null; note: string | null; error: string | null;
}
interface Totals { wagers: number; staked: number; pnl: number; wins: number; settled: number }
interface State {
  settings: Settings;
  limits: { min: number; max: number };
  slot: { date: string; open: boolean; slot: string };
  today: { visitor: string; home: string; pick: string; p: number; tipoff: string | null }[];
  balance: number | null;
  balanceError: string | null;
  wagers: Wager[];
  totals: Partial<Record<"dry" | "live", Totals>>;
}

const money = (x: number) => `${x < 0 ? "−" : ""}$${Math.abs(x).toFixed(2)}`;
const signedMoney = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : ""}$${Math.abs(x).toFixed(2)}`;
const STATUS: Record<string, [string, string]> = {
  pending: ["Placing", ""], dry_run: ["Dry run", ""], filled: ["Filled", "pos"], partial: ["Part filled", "pos"],
  unfilled: ["Not filled", ""], skipped: ["Skipped", ""], error: ["Error", "neg"],
};

export default function AdminPage() {
  const authed = useSession();
  if (authed === undefined) return <div className="title-row"><div><h1>Admin</h1><p className="finding muted">Checking…</p></div></div>;
  return authed ? <Dashboard /> : <Login />;
}

function Login() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api("/api/login", { password });
      setAuthed(true);
    } catch (err) {
      setError(String((err as Error).message));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="title-row"><div><h1>Admin</h1><p className="finding muted">Sign in to continue.</p></div></div>
      <form className="panel login" onSubmit={submit}>
        <label className="control">
          <span>Password</span>
          <input type="password" className="input" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="small" style={{ color: "var(--negative)" }}>{error}</p>}
        <button className="btn primary" disabled={busy || !password}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
    </>
  );
}

function Dashboard() {
  const [state, setState] = useState<State>();
  const [error, setError] = useState<string>();
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [runResult, setRunResult] = useState<string>();

  const load = useCallback(() => api<State>("/api/state").then((s) => { setState(s); setError(undefined); return s; })
    .catch((e) => setError(String(e.message))), []);
  useEffect(() => {
    load().then((s) => s && setAmount(String(s.settings.amount)));
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const save = async (patch: Partial<Settings>) => {
    setBusy(true);
    try {
      await api("/api/settings", patch);
      await load();
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };
  const goLive = (live: boolean) => {
    if (live && !confirm(`Turn off dry run? The next run will place real ${money(Number(amount) || state!.settings.amount)} wagers on your Kalshi account.`)) return;
    save({ dry_run: !live });
  };
  const runNow = async () => {
    const s = state!.settings;
    if (!s.dry_run && !confirm(`Place real ${money(s.amount)} wagers on today's ${state!.today.length} picks now?`)) return;
    setBusy(true);
    setRunResult(undefined);
    try {
      const r = await api<{ status: string; reason?: string; placed?: unknown[] }>("/api/run", {});
      setRunResult(r.status === "done" ? `${r.placed!.length} new ${r.placed!.length === 1 ? "wager" : "wagers"} recorded.`
        : r.reason || "Nothing to do.");
      await load();
    } catch (e) {
      setRunResult(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };
  const logout = async () => {
    await api("/api/logout", {}).catch(() => {});
    setAuthed(false);
  };

  if (!state) {
    return (
      <div className="title-row"><div><h1>Wagers</h1><p className="finding muted">{error ? `Couldn't load: ${error}` : "Loading…"}</p></div></div>
    );
  }
  const s = state.settings;
  const live = state.totals.live;
  const dry = state.totals.dry;
  const todays = state.wagers.filter((w) => w.game_date === state.slot.date && w.mode === (s.dry_run ? "dry" : "live"));
  const finding = !s.running
    ? "Stopped. Nothing is wagered until you start the run."
    : `${s.dry_run ? "Dry run: recording" : "Live: wagering"} ${money(s.amount)} on every pick at ${state.slot.slot} today.`;
  const amountChanged = amount !== "" && Number(amount) !== s.amount;

  return (
    <>
      <div className="title-row">
        <div>
          <h1>Wagers</h1>
          <p className="finding">{finding}</p>
        </div>
        <button className="btn" onClick={logout}>Log out</button>
      </div>

      <div className="controls">
        <label className="check">
          <input type="checkbox" className="switch" checked={s.running} disabled={busy} onChange={(e) => save({ running: e.target.checked })} />
          Run daily
        </label>
        <label className="check">
          <input type="checkbox" className="switch" checked={!s.dry_run} disabled={busy} onChange={(e) => goLive(e.target.checked)} />
          Real money
        </label>
        <label className="control">
          <span>Per pick ($)</span>
          <input type="number" className="input" style={{ width: 112 }} min={state.limits.min} max={state.limits.max} step={0.5}
            value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <button className="btn" disabled={busy || !amountChanged} onClick={() => save({ amount: Number(amount) })}>Save amount</button>
        <button className="btn primary" disabled={busy || state.today.length === 0} onClick={runNow}
          title={state.today.length ? "Wager on today's picks now (each game once)" : "No predictions for today yet"}>
          Run now
        </button>
      </div>
      {(error || runResult) && <p className="small" style={{ marginBottom: 12, color: error ? "var(--negative)" : undefined }}>{error || runResult}</p>}

      <div className="stats">
        <div className="stat"><div className="label">Kalshi balance</div>
          <div className="value">{state.balance === null ? <span className="muted">—</span> : money(state.balance)}</div>
          <div className="note">{state.balanceError ? "Couldn't reach Kalshi" : "all shards"}</div></div>
        <div className="stat"><div className="label">Live profit and loss</div>
          <div className="value" style={{ color: live && live.pnl !== 0 ? (live.pnl > 0 ? "var(--positive)" : "var(--negative)") : undefined }}>
            {live ? signedMoney(live.pnl) : "$0.00"}</div>
          <div className="note">{live ? `${money(live.staked)} staked on ${live.wagers}` : "no live wagers yet"}</div></div>
        <div className="stat"><div className="label">Live picks won</div>
          <div className="value">{live?.settled ? pct(live.wins / live.settled, 1) : <span className="muted">—</span>}</div>
          <div className="note">{live?.settled ? `${live.wins} of ${live.settled} settled` : "none settled"}</div></div>
        <div className="stat"><div className="label">Dry-run profit and loss</div>
          <div className="value">{dry ? signedMoney(dry.pnl) : "$0.00"}</div>
          <div className="note">{dry?.settled ? `${dry.wins} of ${dry.settled} won, at the asking price` : "what live would have made"}</div></div>
      </div>

      <div className="grid">
        <section className="panel span-6" aria-labelledby="today">
          <header>
            <h2 id="today">Today, {prettyDate(state.slot.date)}</h2>
            <span className="meta">wagers at {state.slot.slot}{state.slot.open ? " · window open" : ""}</span>
          </header>
          {state.today.length === 0 ? (
            <div className="empty">No predictions for today yet. They're logged at noon on weekends and holidays and 5 p.m. otherwise; wagers follow 10 minutes later.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Game</th><th>Pick</th><th className="n">Model</th><th className="n">Tip-off</th><th className="n">Price</th><th className="n">Contracts</th><th className="n">Status</th></tr></thead>
                <tbody>
                  {state.today.map((g) => {
                    const w = todays.find((x) => x.visitor === g.visitor && x.home === g.home);
                    const [label, tone] = w ? STATUS[w.status] ?? [w.status, ""] : ["Queued", ""];
                    return (
                      <tr key={g.visitor + g.home}>
                        <td>{g.visitor} at {g.home}</td>
                        <td className="lead">{g.pick}</td>
                        <td className="n">{pct(g.p)}</td>
                        <td className="n">{g.tipoff ? new Date(g.tipoff).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—"}</td>
                        <td className="n">{w?.limit_price ? `${Math.round(w.limit_price * 100)}¢` : <span className="muted">—</span>}</td>
                        <td className="n">{w?.count ?? <span className="muted">—</span>}</td>
                        <td className="n"><span className={`pill ${tone}`} title={w?.error || w?.note || ""}>{label}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="panel span-6" aria-labelledby="history">
          <header><h2 id="history">History</h2><span className="meta">{state.wagers.length} most recent</span></header>
          {state.wagers.length === 0 ? <div className="empty">No wagers yet.</div> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Date</th><th>Game</th><th>Pick</th><th>Mode</th><th className="n">Price</th><th className="n">Contracts</th><th className="n">Cost</th><th className="n">Status</th><th className="n">Result</th><th className="n">P&amp;L</th></tr></thead>
                <tbody>
                  {state.wagers.map((w) => {
                    const [label, tone] = STATUS[w.status] ?? [w.status, ""];
                    const contracts = w.mode === "live" ? w.fill_count : w.count;
                    const cost = w.mode === "live" ? w.cost : w.limit_price && w.count ? w.limit_price * w.count : null;
                    return (
                      <tr key={w.id}>
                        <td>{w.game_date.slice(5)}</td>
                        <td>{w.visitor} at {w.home}</td>
                        <td className="lead">{w.pick}</td>
                        <td>{w.mode === "live" ? "Live" : "Dry"}</td>
                        <td className="n">{w.limit_price ? `${Math.round(w.limit_price * 100)}¢` : <span className="muted">—</span>}</td>
                        <td className="n">{contracts ?? <span className="muted">—</span>}</td>
                        <td className="n">{cost !== null ? money(cost) : <span className="muted">—</span>}</td>
                        <td className="n"><span className={`pill ${tone}`} title={w.error || w.note || ""}>{label}</span></td>
                        <td className="n">{w.result ? <span className={`pill ${w.result === "won" ? "pos" : "neg"}`}>{w.result === "won" ? "Won" : "Lost"}</span> : <span className="muted">—</span>}</td>
                        <td className="n" style={{ color: w.pnl ? (w.pnl > 0 ? "var(--positive)" : "var(--negative)") : undefined }}>
                          {w.pnl !== null ? signedMoney(w.pnl) : <span className="muted">—</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="small muted" style={{ marginTop: 10 }}>
            Each pick buys the predicted winner's YES contract at the asking price (immediate-or-cancel), sized so cost plus Kalshi's fee stays within the amount. A game is wagered at most once per mode.
          </p>
        </section>
      </div>
    </>
  );
}

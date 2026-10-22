// Wagers a set amount on each day's predicted winners on Kalshi's NBA game markets.
// The day's picks come from the deployed data/track_record.json, which the prediction job
// redeploys minutes before the wager slot. Structure follows kalshi-trader/src/trader.js.

import * as kalshi from "./kalshi.js";
import { easternNow, wagerWindow } from "./schedule.js";

const FEE_RATE = 0.07; // KXNBAGAME taker fee: 0.07 * C * P * (1 - P), fee_multiplier 1
export const MIN_AMOUNT = 1;
export const MAX_AMOUNT = 100;
// Basketball-Reference team codes that Kalshi spells differently
const KALSHI_TEAM = { BRK: "BKN", CHO: "CHA", PHO: "PHX" };
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS wagers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_date TEXT NOT NULL,
    visitor TEXT NOT NULL,
    home TEXT NOT NULL,
    mode TEXT NOT NULL,
    ts INTEGER NOT NULL,
    trigger TEXT NOT NULL,
    status TEXT NOT NULL,
    pick TEXT,
    p_pick REAL,
    market_ticker TEXT,
    exchange_index INTEGER,
    amount REAL,
    limit_price REAL,
    count REAL,
    order_id TEXT,
    fill_count REAL,
    cost REAL,
    fees REAL,
    result TEXT,
    pnl REAL,
    note TEXT,
    error TEXT,
    UNIQUE (game_date, visitor, home, mode)
  )`,
];

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((s) => db.prepare(s)));
  schemaReady = true;
}

// Starts stopped and in dry run: nothing is wagered until both are switched on the Admin page.
const DEFAULT_SETTINGS = { running: false, amount: 1, dry_run: true };

export async function getSettings(db) {
  await ensureSchema(db);
  const { results } = await db.prepare("SELECT key, value FROM settings").all();
  const s = { ...DEFAULT_SETTINGS };
  for (const { key, value } of results) s[key] = JSON.parse(value);
  return s;
}

export async function saveSettings(db, patch) {
  await ensureSchema(db);
  const stmts = Object.entries(patch).map(([k, v]) =>
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(k, JSON.stringify(v)));
  if (stmts.length) await db.batch(stmts);
  return getSettings(db);
}

/** Contracts so that price * count + fee stays within `amount` (0.01-contract granularity). */
export function contractsFor(amount, price) {
  const perContract = price + FEE_RATE * price * (1 - price);
  return Math.max(0, Math.floor(((amount - 0.01) / perContract) * 100) / 100);
}

/** Kalshi market for `team` winning the game: KXNBAGAME-26OCT26GSWDEN-DEN. */
export function marketTicker(date, visitor, home, team) {
  const [y, m, d] = date.split("-");
  const k = (t) => KALSHI_TEAM[t] || t;
  return `${kalshi.SERIES}-${y.slice(2)}${MONTHS[Number(m) - 1]}${d}${k(visitor)}${k(home)}-${k(team)}`;
}

/** The day's logged predictions that are still waiting on a result. */
export async function picksFor(env, date) {
  const res = await env.ASSETS.fetch(new Request("https://assets.local/data/track_record.json"));
  if (!res.ok) throw new Error(`track_record.json: HTTP ${res.status}`);
  const { pending = [] } = await res.json();
  // pending rows: [date, visitor, home, p_home, proj_visitor, proj_home, tipoff]
  return pending.filter((r) => r[0] === date).map(([gameDate, visitor, home, pHome, , , tipoff]) => {
    const pick = pHome >= 0.5 ? home : visitor;
    return { date: gameDate, visitor, home, pick, p: pick === home ? pHome : 1 - pHome, tipoff: tipoff || null };
  });
}

/**
 * Wager on each of the day's picks. `trigger` is "cron" (only while running, inside today's window)
 * or "manual" (the Admin page's Run now). A game is wagered at most once per mode, so reruns are safe.
 */
export async function runWagers(env, { trigger = "cron", now = Date.now(), date: override } = {}) {
  const db = env.DB;
  const settings = await getSettings(db);
  const slot = wagerWindow(now);
  if (trigger === "cron" && (!settings.running || !slot.open)) return { status: "idle" };
  const mode = settings.dry_run ? "dry" : "live";
  // Another day's slate only for dry runs, so a test can never place real money on the wrong day
  const date = override && mode === "dry" ? override : slot.date;

  const picks = await picksFor(env, date);
  if (!picks.length) return { status: "waiting", reason: `No predictions for ${date} deployed yet` };

  const out = [];
  for (const pick of picks) {
    const claim = await db.prepare(
      `INSERT INTO wagers (game_date, visitor, home, mode, ts, trigger, status, pick, p_pick, amount)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?) ON CONFLICT DO NOTHING`)
      .bind(pick.date, pick.visitor, pick.home, mode, now, trigger, pick.pick, pick.p, settings.amount).run();
    if (!claim.meta.changes) continue; // already wagered this game in this mode
    const id = claim.meta.last_row_id;
    const row = { status: "error" };
    try {
      await wagerOne(env, pick, settings, mode, now, row, id);
    } catch (e) {
      row.status = "error";
      row.error = String(e.message || e).slice(0, 1000);
    }
    await updateWager(db, id, row);
    out.push({ id, game: `${pick.visitor} at ${pick.home}`, ...row });
  }
  return { status: "done", date, mode, placed: out };
}

async function wagerOne(env, pick, settings, mode, now, row, id) {
  if (pick.tipoff && Date.parse(pick.tipoff) <= now) {
    row.status = "skipped";
    row.note = "Game had already tipped off";
    return;
  }
  row.market_ticker = marketTicker(pick.date, pick.visitor, pick.home, pick.pick);
  const market = await kalshi.getMarket(env, row.market_ticker);
  row.exchange_index = market.exchange_index;
  if (market.status !== "active") {
    row.status = "skipped";
    row.note = `Market is ${market.status}`;
    return;
  }
  const price = parseFloat(market.yes_ask_dollars);
  if (!(price > 0 && price < 1)) {
    row.status = "skipped";
    row.note = "No one is selling this side";
    return;
  }
  row.amount = settings.amount;
  row.limit_price = price;
  row.count = contractsFor(settings.amount, price);
  if (row.count < 0.01) throw new Error(`$${settings.amount} is too small to buy at ${price}`);
  if (mode === "dry") {
    row.status = "dry_run";
    return;
  }
  await placeOrder(env, row, `${row.market_ticker}-${id}`);
}

// API orders draw only on the market's exchange shard; top it up from other shards (as kalshi-trader does).
async function fundShard(env, shard, needed) {
  const bal = await kalshi.getBalance(env);
  if (bal.balance / 100 < needed) throw new Error(`Insufficient balance: $${(bal.balance / 100).toFixed(2)}`);
  let shortfall = needed - (bal.shards[shard] || 0);
  if (shortfall <= 0) return null;
  const moved = [];
  const sources = Object.entries(bal.shards)
    .filter(([idx, amt]) => Number(idx) !== shard && amt > 0)
    .sort((a, b) => b[1] - a[1]);
  for (const [idx, amt] of sources) {
    const dollars = Math.min(amt, Math.ceil(shortfall * 100) / 100);
    await kalshi.transferBetweenShards(env, { from: Number(idx), to: shard, dollars });
    moved.push(`$${dollars.toFixed(2)} from shard ${idx}`);
    shortfall -= dollars;
    if (shortfall <= 0) break;
  }
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const after = await kalshi.getBalance(env);
    if ((after.shards[shard] || 0) >= needed) return `Moved ${moved.join(", ")} to shard ${shard}`;
  }
  throw new Error(`Moved ${moved.join(", ")} to shard ${shard} but funds did not arrive in time`);
}

async function placeOrder(env, row, clientOrderId) {
  row.note = (await fundShard(env, row.exchange_index, row.amount)) || undefined;
  const params = { ticker: row.market_ticker, exchangeIndex: row.exchange_index, outcome: "up", price: row.limit_price, clientOrderId };
  let res;
  try {
    res = await kalshi.buy(env, { ...params, count: row.count });
  } catch (e) {
    // If fractional contracts are rejected, retry once with whole contracts.
    const whole = Math.floor(row.count);
    const code = e instanceof kalshi.KalshiError ? e.body?.error?.code : null;
    if (!code || !/fraction|count|invalid/i.test(code) || whole === row.count || whole < 1) throw e;
    row.count = whole;
    res = await kalshi.buy(env, { ...params, count: whole, clientOrderId: clientOrderId + "-w" });
  }
  row.order_id = res.order_id;
  row.fill_count = parseFloat(res.fill_count);
  if (row.fill_count > 0) {
    row.cost = round2(parseFloat(res.average_fill_price) * row.fill_count);
    row.fees = round2(parseFloat(res.average_fee_paid || "0") * row.fill_count);
    row.status = row.fill_count < row.count ? "partial" : "filled";
  } else {
    row.status = "unfilled";
  }
}

const COLUMNS = ["status", "market_ticker", "exchange_index", "limit_price", "count", "order_id", "fill_count",
  "cost", "fees", "note", "error"];

async function updateWager(db, id, row) {
  const cols = COLUMNS.filter((c) => row[c] !== undefined);
  await db.prepare(`UPDATE wagers SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`)
    .bind(...cols.map((c) => row[c]), id).run();
}

/** Result and P&L for filled wagers whose game is final; dry runs are graded as if filled. */
export async function settleWagers(env) {
  const db = env.DB;
  await ensureSchema(db);
  const { results } = await db.prepare(
    `SELECT id, market_ticker, status, count, limit_price, fill_count, cost, fees FROM wagers
     WHERE status IN ('filled', 'partial', 'dry_run') AND result IS NULL AND game_date < ? ORDER BY id DESC LIMIT 40`)
    .bind(easternNow().date).all();
  for (const r of results) {
    try {
      const m = await kalshi.getMarket(env, r.market_ticker);
      if (m.result !== "yes" && m.result !== "no") continue;
      const won = m.result === "yes";
      const dry = r.status === "dry_run";
      const contracts = dry ? r.count : r.fill_count;
      const cost = dry ? r.limit_price * r.count : r.cost || 0;
      const fees = dry ? Math.ceil(FEE_RATE * r.count * r.limit_price * (1 - r.limit_price) * 100) / 100 : r.fees || 0;
      const pnl = round2((won ? contracts : 0) - cost - fees);
      await db.prepare("UPDATE wagers SET result = ?, pnl = ? WHERE id = ?").bind(won ? "won" : "lost", pnl, r.id).run();
    } catch {
      // try again next time
    }
  }
}

export async function history(db, limit = 200) {
  await ensureSchema(db);
  const { results } = await db.prepare("SELECT * FROM wagers ORDER BY game_date DESC, id DESC LIMIT ?").bind(limit).all();
  const totals = await db.prepare(
    `SELECT mode, COUNT(*) AS wagers, COALESCE(SUM(CASE WHEN status = 'dry_run' THEN limit_price * count ELSE cost END), 0) AS staked,
            COALESCE(SUM(pnl), 0) AS pnl, SUM(CASE WHEN result = 'won' THEN 1 ELSE 0 END) AS wins,
            SUM(CASE WHEN result IS NOT NULL THEN 1 ELSE 0 END) AS settled
     FROM wagers WHERE status IN ('filled', 'partial', 'dry_run') GROUP BY mode`).all();
  return { wagers: results, totals: Object.fromEntries(totals.results.map((t) => [t.mode, t])) };
}

const round2 = (n) => Math.round(n * 100) / 100;

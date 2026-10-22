// Minimal Kalshi Trade API v2 client: request signing, market data, orders.
// Adapted from ../../kalshi-trader/src/kalshi.js (same signing, shard funding and order call).

const DEFAULT_BASE = "https://api.elections.kalshi.com/trade-api/v2";
export const SERIES = "KXNBAGAME";

let cachedKey = null; // { pem, key, alg }

async function signingKey(pem) {
  if (cachedKey?.pem === pem) return cachedKey;
  const der = Uint8Array.from(
    atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")),
    (c) => c.charCodeAt(0),
  );
  let key, alg;
  try {
    key = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
    alg = { name: "Ed25519" };
  } catch {
    // PKCS#8 RSA key: Kalshi expects RSA-PSS/SHA-256 with digest-length salt.
    key = await crypto.subtle.importKey("pkcs8", der, { name: "RSA-PSS", hash: "SHA-256" }, false, ["sign"]);
    alg = { name: "RSA-PSS", saltLength: 32 };
  }
  cachedKey = { pem, key, alg };
  return cachedKey;
}

async function authHeaders(env, method, url) {
  if (!env.KALSHI_PRIVATE_KEY || !env.KALSHI_KEY_ID) throw new Error("Kalshi API key is not set (npm run secrets)");
  const { key, alg } = await signingKey(env.KALSHI_PRIVATE_KEY);
  const ts = String(Date.now());
  const path = new URL(url).pathname; // signed path excludes the query string
  const sig = await crypto.subtle.sign(alg, key, new TextEncoder().encode(ts + method + path));
  return {
    "KALSHI-ACCESS-KEY": env.KALSHI_KEY_ID,
    "KALSHI-ACCESS-TIMESTAMP": ts,
    "KALSHI-ACCESS-SIGNATURE": btoa(String.fromCharCode(...new Uint8Array(sig))),
  };
}

export class KalshiError extends Error {
  constructor(status, body) {
    super(`Kalshi ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

// GETs are retried on 429/5xx/network errors with exponential backoff. Writes are never retried here.
async function request(env, method, path, { query, body, auth = false } = {}) {
  const base = env.KALSHI_BASE || DEFAULT_BASE;
  const url = base + path + (query ? "?" + new URLSearchParams(query) : "");
  const attempts = method === "GET" ? 4 : 1;
  for (let i = 1; ; i++) {
    try {
      const headers = { Accept: "application/json" };
      if (body) headers["Content-Type"] = "application/json";
      // Sign even public reads when we can: unsigned requests are rate limited per IP, and Workers share egress IPs.
      if (auth || (env.KALSHI_PRIVATE_KEY && env.KALSHI_KEY_ID)) {
        Object.assign(headers, await authHeaders(env, method, url));
      }
      const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
      if (!res.ok) throw new KalshiError(res.status, data);
      return data;
    } catch (e) {
      const retryable = !(e instanceof KalshiError) || e.status === 429 || e.status >= 500;
      if (!retryable || i >= attempts) throw e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** (i - 1)));
    }
  }
}

export async function getMarket(env, ticker) {
  const { market } = await request(env, "GET", `/markets/${encodeURIComponent(ticker)}`);
  return market;
}

// `balance` is total cents; `shards` maps exchange_index -> dollars available on that shard.
export async function getBalance(env) {
  const res = await request(env, "GET", "/portfolio/balance", { auth: true });
  const shards = {};
  for (const b of res.balance_breakdown || []) shards[b.exchange_index] = parseFloat(b.balance);
  return { ...res, shards };
}

// Move dollars between exchange shards. API orders are only funded from the market's own shard.
export async function transferBetweenShards(env, { from, to, dollars }) {
  return request(env, "POST", "/portfolio/intra_exchange_instance_transfer", {
    auth: true,
    body: {
      client_transfer_id: crypto.randomUUID(),
      source: "event_contract",
      destination: "event_contract",
      source_exchange_shard: from,
      destination_exchange_shard: to,
      amount: Math.ceil(dollars * 10000), // centicents
    },
  });
}

// Buy `count` contracts of YES ("up") or NO ("down") at a limit of `price` dollars, immediate-or-cancel.
// For an NBA game market, YES on KXNBAGAME-...-DEN means "Denver wins".
// The V2 endpoint quotes everything from the YES leg: buying NO at p == selling YES (side "ask") at 1 - p.
export async function buy(env, { ticker, exchangeIndex, outcome, price, count, clientOrderId }) {
  const yesPrice = outcome === "up" ? price : 1 - price;
  return request(env, "POST", "/portfolio/events/orders", {
    auth: true,
    body: {
      ticker,
      exchange_index: exchangeIndex ?? -1,
      client_order_id: clientOrderId,
      side: outcome === "up" ? "bid" : "ask",
      count: count.toFixed(2),
      price: yesPrice.toFixed(4),
      time_in_force: "immediate_or_cancel",
      self_trade_prevention_type: "taker_at_cross",
    },
  });
}

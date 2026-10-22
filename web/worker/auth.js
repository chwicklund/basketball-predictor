// Password login with an HMAC-signed, expiring session cookie (from kalshi-trader/src/auth.js).

const COOKIE = "hp_admin";
const SESSION_TTL_S = 7 * 24 * 3600;

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

function equal(a, b) {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  return ea.length === eb.length && crypto.subtle.timingSafeEqual(ea, eb);
}

export async function checkPassword(env, password) {
  if (!env.DASHBOARD_PASSWORD || !env.SESSION_SECRET) throw new Error("DASHBOARD_PASSWORD / SESSION_SECRET not set");
  // Compare HMACs so the comparison is constant-length regardless of input.
  const [a, b] = await Promise.all([
    hmac(env.SESSION_SECRET, "pw:" + password),
    hmac(env.SESSION_SECRET, "pw:" + env.DASHBOARD_PASSWORD),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export async function sessionCookie(env) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
  const sig = hex(await hmac(env.SESSION_SECRET, "session:" + exp));
  return `${COOKIE}=${exp}.${sig}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_S}`;
}

export const clearCookie = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

export async function isAuthed(request, env) {
  if (!env.SESSION_SECRET) return false;
  const match = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=(\\d+)\\.([0-9a-f]+)`));
  if (!match) return false;
  const [, exp, sig] = match;
  if (Number(exp) < Date.now() / 1000) return false;
  return equal(sig, hex(await hmac(env.SESSION_SECRET, "session:" + exp)));
}

// Serves the React app (static assets) and the password-protected admin API, and runs the daily wagers.
import { checkPassword, clearCookie, isAuthed, sessionCookie } from "./auth.js";
import { getBalance } from "./kalshi.js";
import { wagerWindow } from "./schedule.js";
import { MAX_AMOUNT, MIN_AMOUNT, getSettings, history, picksFor, runWagers, saveSettings, settleWagers } from "./wagers.js";

const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers: { "Cache-Control": "no-store", ...headers } });

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      await settleWagers(env);
      const r = await runWagers(env, { trigger: "cron", now: controller.scheduledTime });
      if (r.status !== "idle") console.log(JSON.stringify(r));
    })());
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (!env.DASHBOARD_PASSWORD || !env.SESSION_SECRET) return json({ error: "Admin secrets are not set" }, 500);

    // State-changing requests must come from this site (the cookie is also SameSite=Strict)
    if (request.method !== "GET" && request.headers.get("Origin") !== url.origin) return json({ error: "bad origin" }, 403);

    if (url.pathname === "/api/session") return json({ authed: await isAuthed(request, env) });
    if (url.pathname === "/api/login" && request.method === "POST") {
      const { password = "" } = await request.json().catch(() => ({}));
      if (await checkPassword(env, String(password))) return json({ authed: true }, 200, { "Set-Cookie": await sessionCookie(env) });
      await new Promise((r) => setTimeout(r, 1000)); // slow down guessing
      return json({ error: "Incorrect password" }, 401);
    }
    if (url.pathname === "/api/logout" && request.method === "POST") {
      return json({ authed: false }, 200, { "Set-Cookie": clearCookie });
    }

    if (!(await isAuthed(request, env))) return json({ error: "unauthorized" }, 401);
    try {
      return await api(request, env, url.pathname);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  },
};

async function api(request, env, pathname) {
  if (pathname === "/api/state" && request.method === "GET") {
    await settleWagers(env);
    const slot = wagerWindow();
    const [settings, log, balance, today] = await Promise.all([
      getSettings(env.DB),
      history(env.DB),
      getBalance(env).catch((e) => ({ error: String(e.message || e) })),
      picksFor(env, slot.date).catch(() => []),
    ]);
    return json({
      settings,
      limits: { min: MIN_AMOUNT, max: MAX_AMOUNT },
      slot,
      today,
      balance: balance.error ? null : balance.balance / 100,
      balanceError: balance.error || null,
      ...log,
    });
  }

  if (pathname === "/api/settings" && request.method === "POST") {
    const body = await request.json();
    const patch = {};
    if ("running" in body) patch.running = Boolean(body.running);
    if ("dry_run" in body) patch.dry_run = Boolean(body.dry_run);
    if ("amount" in body) {
      const amount = Math.round(Number(body.amount) * 100) / 100;
      if (!(amount >= MIN_AMOUNT && amount <= MAX_AMOUNT)) {
        return json({ error: `Amount must be between $${MIN_AMOUNT} and $${MAX_AMOUNT}` }, 400);
      }
      patch.amount = amount;
    }
    return json({ settings: await saveSettings(env.DB, patch) });
  }

  if (pathname === "/api/run" && request.method === "POST") {
    const { date } = await request.json().catch(() => ({}));
    return json(await runWagers(env, { trigger: "manual", date: /^\d{4}-\d{2}-\d{2}$/.test(date || "") ? date : undefined }));
  }

  return json({ error: "not found" }, 404);
}

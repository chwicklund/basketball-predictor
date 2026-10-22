// Uploads the Worker's secrets: the Kalshi API key and the dashboard password are copied from
// kalshi-trader's .env (same account, same login), and the session-signing secret is generated fresh.
// Usage: npm run secrets   (KALSHI_TRADER_ENV=path/to/.env to read another file)
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseEnv } from "node:util";

const path = process.env.KALSHI_TRADER_ENV || new URL("../../../kalshi-trader/.env", import.meta.url);
const env = parseEnv(readFileSync(path, "utf8"));
const names = ["KALSHI_KEY_ID", "KALSHI_PRIVATE_KEY", "DASHBOARD_PASSWORD"];
const missing = names.filter((n) => !env[n]);
if (missing.length) {
  console.error(`Missing in ${path}: ${missing.join(", ")}`);
  process.exit(1);
}
const secrets = Object.fromEntries(names.map((n) => [n, env[n]]));
// A new secret logs out existing admin sessions, which is fine
secrets.SESSION_SECRET = randomBytes(32).toString("hex");
const { status } = spawnSync("npx", ["wrangler", "secret", "bulk"], {
  input: JSON.stringify(secrets),
  stdio: ["pipe", "inherit", "inherit"],
});
process.exit(status ?? 1);

// Whether this browser is logged in to the admin API (the cookie itself is HttpOnly).
import { useEffect, useState } from "react";

let authed: boolean | undefined;
const listeners = new Set<(a: boolean) => void>();

export function setAuthed(a: boolean) {
  authed = a;
  listeners.forEach((l) => l(a));
}

let checking: Promise<void> | undefined;
function check() {
  checking ??= fetch("/api/session", { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : { authed: false }))
    .then((d) => setAuthed(Boolean(d.authed)))
    .catch(() => setAuthed(false));
  return checking;
}

export function useSession(): boolean | undefined {
  const [a, setA] = useState(authed);
  useEffect(() => {
    listeners.add(setA);
    if (authed === undefined) check();
    return () => { listeners.delete(setA); };
  }, []);
  return a;
}

/** fetch for the admin API: same-origin JSON, and a 401 logs the page out. */
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? { credentials: "same-origin" } : {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/api/login") setAuthed(false);
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as T;
}

// Charts or detailed view, shared by every page and remembered in this browser.

import { useSyncExternalStore } from "react";

export type View = "charts" | "detail";
const KEY = "hoops:view";
const listeners = new Set<() => void>();

function read(): View {
  try {
    return localStorage.getItem(KEY) === "detail" ? "detail" : "charts";
  } catch {
    return "charts";  // storage blocked: fall back to the default every time
  }
}

let current = read();

export function setView(v: View) {
  current = v;
  try { localStorage.setItem(KEY, v); } catch { /* not remembered, still switches */ }
  listeners.forEach((l) => l());
}

export function useView(): View {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => current);
}

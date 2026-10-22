import { useEffect, useRef } from "react";
import "../lib/vendor/charts.js";

// taste-skill's charts.js attaches itself to window
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ChartsApi = any;
declare global { interface Window { Charts: ChartsApi } }

/** Draws with charts.js into a div; redraws when `deps` change. */
export default function Chart({ draw, deps, label }: { draw: (el: HTMLDivElement, C: ChartsApi) => void; deps: unknown[]; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.replaceChildren();
    draw(el, window.Charts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return <div ref={ref} className="chart" aria-label={label} />;
}

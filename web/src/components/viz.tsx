// Small charts drawn as React SVG and HTML, for the places charts.js has one hue and these need several:
// the two teams, the eight stats, right and wrong calls. Each mark shows a tooltip on hover, and every
// value a tooltip shows is also written somewhere on the chart or in the detailed view's tables.

import { type CSSProperties, type ReactNode, useRef, useState } from "react";
import { BAD, GOOD, PENDING, tint } from "../lib/palette";
import { useTween } from "../lib/useTween";

/** A tooltip that follows the pointer inside a chart's box. */
function useTip() {
  const ref = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; body: ReactNode } | null>(null);
  const on = (body: ReactNode) => ({
    onPointerMove: (e: React.PointerEvent) => {
      const r = ref.current?.getBoundingClientRect();
      if (r) setTip({ x: e.clientX - r.left, y: e.clientY - r.top, body });
    },
    onPointerLeave: () => setTip(null),
  });
  const el = tip && (
    <div className="viz-tip" style={{ left: tip.x, top: tip.y }} role="tooltip">{tip.body}</div>
  );
  return { ref, on, el };
}

const vars = (v: Record<string, string>) => v as CSSProperties;

/** A rounded top for the scale of a row: 1, 2, 2.5 or 5 times a power of ten, above the largest value. */
export function niceMax(v: number) {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= v) ?? 10 * mag);
}

/* ---------- win probability as a split ring ---------- */

export function ProbRing({ pHome, home, away, homeName, awayName, homeColor, awayColor, size = 188 }: {
  pHome: number; home: string; away: string; homeName: string; awayName: string;
  homeColor: string; awayColor: string; size?: number;
}) {
  const p = useTween(pHome);
  const tip = useTip();
  const stroke = 22, r = (size - stroke) / 2, c = 2 * Math.PI * r, gap = 3;  // a surface gap between the two arcs
  const homeLen = Math.max(0, c * p - gap), awayLen = Math.max(0, c * (1 - p) - gap);
  const fav = pHome >= 0.5 ? home : away;
  const pf = fav === home ? p : 1 - p;
  const arc = (len: number, offset: number, color: string, label: ReactNode) => (
    <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke}
      strokeDasharray={`${len} ${c}`} strokeDashoffset={-offset} transform={`rotate(-90 ${size / 2} ${size / 2})`}
      className="viz-hit" {...tip.on(label)} />
  );
  return (
    <div className="ring-wrap" ref={tip.ref}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img"
        aria-label={`${away} ${(100 * (1 - pHome)).toFixed(1)}%, ${home} ${(100 * pHome).toFixed(1)}%`}>
        {/* home runs clockwise from the top, away fills the rest */}
        {arc(homeLen, gap / 2, homeColor, <><b>{homeName}</b> · home<br />{(100 * pHome).toFixed(1)}% to win</>)}
        {arc(awayLen, c * p + gap / 2, awayColor, <><b>{awayName}</b> · away<br />{(100 * (1 - pHome)).toFixed(1)}% to win</>)}
        <text x={size / 2} y={size / 2 + 4} textAnchor="middle" className="ring-value">{(pf * 100).toFixed(0)}%</text>
        <text x={size / 2} y={size / 2 + 26} textAnchor="middle" className="ring-sub">{fav} to win</text>
      </svg>
      {tip.el}
    </div>
  );
}

/** The two sides as a legend row under the ring: swatch, team, chance. */
export function SideLegend({ rows }: { rows: { color: string; label: string; sub: string; value: string }[] }) {
  return (
    <ul className="side-legend">
      {rows.map((r) => (
        <li key={r.label}>
          <i style={{ background: r.color }} />
          <span><b>{r.label}</b><span className="muted small"> {r.sub}</span></span>
          <span className="num">{r.value}</span>
        </li>
      ))}
    </ul>
  );
}

/* ---------- horizontal bars that share one scale ---------- */

export function HBars({ rows, max, format = (v) => v.toFixed(0) }: {
  rows: { label: ReactNode; value: number; color: string; note?: string }[]; max?: number; format?: (v: number) => string;
}) {
  const tip = useTip();
  const top = max ?? Math.max(...rows.map((r) => r.value));
  return (
    <div className="hbars" ref={tip.ref}>
      {rows.map((r, i) => (
        <div className="hbar" key={i} {...tip.on(<>{r.label}: <b>{format(r.value)}</b>{r.note ? <> · {r.note}</> : null}</>)}>
          <span className="hbar-label">{r.label}</span>
          <span className="hbar-track"><span style={{ width: `${(Math.max(0, r.value) / top) * 100}%`, background: r.color }} /></span>
          <span className="hbar-val num">{format(r.value)}</span>
        </div>
      ))}
      {tip.el}
    </div>
  );
}

/* ---------- head to head: two dots per measure, each row on its own scale ---------- */

export function Dumbbells({ rows, leftColor, rightColor, left, right }: {
  rows: { label: string; left: number; right: number; format: (v: number) => string; hint?: string }[];
  leftColor: string; rightColor: string; left: string; right: string;
}) {
  const tip = useTip();
  return (
    <div className="dumbbells" ref={tip.ref}>
      <div className="db-row db-head small muted">
        <span />
        <span className="n"><i style={{ background: leftColor }} />{left}</span>
        <span />
        <span><i style={{ background: rightColor }} />{right}</span>
      </div>
      {rows.map((r) => {
        // the row's scale: padded around both values, and taking in zero when either side is negative
        let lo = Math.min(r.left, r.right), hi = Math.max(r.left, r.right);
        const signed = lo < 0;
        if (signed) { const m = Math.max(Math.abs(lo), Math.abs(hi), 1) * 1.25; lo = -m; hi = m; }
        else { const pad = Math.max((hi - lo) * 0.6, Math.abs(hi) * 0.08, 0.5); lo = Math.max(0, lo - pad); hi += pad; }
        const at = (v: number) => ((v - lo) / (hi - lo)) * 100;
        const a = at(r.left), b = at(r.right);
        return (
          <div className="db-row" key={r.label}
            {...tip.on(<><b>{r.label}</b><br />{left} {r.format(r.left)} · {right} {r.format(r.right)}{r.hint ? <><br /><span className="muted">{r.hint}</span></> : null}</>)}>
            <span className="db-label">{r.label}</span>
            <span className="n num">{r.format(r.left)}</span>
            <span className="db-track">
              {signed && <span className="db-zero" style={{ left: `${at(0)}%` }} />}
              <span className="db-link" style={{ left: `${Math.min(a, b)}%`, width: `${Math.abs(a - b)}%` }} />
              <span className="db-dot" style={{ left: `${a}%`, background: leftColor }} />
              <span className="db-dot" style={{ left: `${b}%`, background: rightColor }} />
            </span>
            <span className="num">{r.format(r.right)}</span>
          </div>
        );
      })}
      {tip.el}
    </div>
  );
}

/* ---------- a likely range per stat: band from the 10th to 90th percentile, the projection, a reference tick ---------- */

export interface RangeRow {
  key: string; label: string; color: string; mean: number; p10: number; p90: number; ref?: number;
}

export function RangeRows({ rows, refLabel, selected, onSelect }: {
  rows: RangeRow[]; refLabel: string; selected?: string; onSelect?: (key: string) => void;
}) {
  const tip = useTip();
  return (
    <div className="ranges" ref={tip.ref}>
      {rows.map((r) => {
        const top = niceMax(Math.max(r.p90, r.ref ?? 0, r.mean) * 1.08);
        const at = (v: number) => `${(Math.max(0, v) / top) * 100}%`;
        const body = (
          <><b>{r.label}</b>: {r.mean.toFixed(1)} projected<br />likely {r.p10.toFixed(1)}–{r.p90.toFixed(1)}
            {r.ref !== undefined && <><br />{refLabel} {r.ref.toFixed(1)}</>}</>
        );
        const Row = onSelect ? "button" : "div";
        return (
          <Row key={r.key} className={`range-row${selected === r.key ? " on" : ""}`} style={vars({ "--c": r.color })}
            {...(onSelect ? { onClick: () => onSelect(r.key), "aria-pressed": selected === r.key } : {})} {...tip.on(body)}>
            <span className="range-label"><i />{r.label}</span>
            <span className="range-track">
              <span className="range-band" style={{ left: at(r.p10), width: `calc(${at(r.p90)} - ${at(r.p10)})`, background: tint(r.color, 0.3) }} />
              {r.ref !== undefined && <span className="range-ref" style={{ left: at(r.ref) }} />}
              <span className="range-dot" style={{ left: at(r.mean) }} />
            </span>
            <span className="range-val num"><b>{r.mean.toFixed(1)}</b><span className="muted"> {r.p10.toFixed(0)}–{r.p90.toFixed(0)}</span></span>
          </Row>
        );
      })}
      {tip.el}
    </div>
  );
}

/* ---------- projected against actual, one row per stat ---------- */

export function ProjVsActual({ rows }: { rows: { label: string; color: string; proj: number; actual: number }[] }) {
  const tip = useTip();
  return (
    <div className="ranges" ref={tip.ref}>
      {rows.map((r) => {
        const top = niceMax(Math.max(r.proj, r.actual) * 1.1);
        const at = (v: number) => `${(Math.max(0, v) / top) * 100}%`;
        const miss = r.actual - r.proj;
        return (
          <div key={r.label} className="range-row" style={vars({ "--c": r.color })}
            {...tip.on(<><b>{r.label}</b><br />projected {r.proj.toFixed(1)} · actual {r.actual}<br />{miss >= 0 ? "+" : "−"}{Math.abs(miss).toFixed(1)} against the projection</>)}>
            <span className="range-label"><i />{r.label}</span>
            <span className="range-track">
              <span className="range-band" style={{ left: 0, width: at(r.proj), background: tint(r.color, 0.35) }} />
              <span className="range-dot" style={{ left: at(r.actual) }} />
            </span>
            <span className="range-val num"><b>{r.actual}</b><span className="muted"> proj. {r.proj.toFixed(1)}</span></span>
          </div>
        );
      })}
      {tip.el}
    </div>
  );
}

/* ---------- paired bars: one measure against another, per category ---------- */

export function PairBars({ rows, a, b }: {
  rows: { label: string; color: string; a: number; b: number }[]; a: string; b: string;
}) {
  const tip = useTip();
  const top = niceMax(Math.max(...rows.flatMap((r) => [r.a, r.b])) * 1.05);
  return (
    <div className="pairs" ref={tip.ref}>
      {rows.map((r) => (
        <div className="pair" key={r.label} style={vars({ "--c": r.color })}
          {...tip.on(<><b>{r.label}</b><br />{a} {r.a.toFixed(1)} · {b} {r.b.toFixed(1)}</>)}>
          <span className="pair-label">{r.label}</span>
          <span className="pair-bars">
            <span style={{ width: `${(r.a / top) * 100}%`, background: r.color }} />
            <span style={{ width: `${(r.b / top) * 100}%`, background: tint(r.color, 0.35) }} />
          </span>
          <span className="pair-val num"><b>{r.a.toFixed(1)}</b><br /><span className="muted">{r.b.toFixed(1)}</span></span>
        </div>
      ))}
      {tip.el}
    </div>
  );
}

/* ---------- signed bars around a centre line, one colour per row ---------- */

export function SignedBars({ rows, format, scale }: {
  rows: { label: string; value: number; color: string; note?: ReactNode; tip?: ReactNode }[];
  format: (v: number) => string; scale?: number;
}) {
  const tip = useTip();
  const m = scale ?? Math.max(...rows.map((r) => Math.abs(r.value)), 1e-9);
  return (
    <div className="signed" ref={tip.ref}>
      {rows.map((r) => {
        const w = (Math.abs(r.value) / m) * 50;
        return (
          <div className="signed-row" key={r.label} {...tip.on(r.tip ?? <><b>{r.label}</b>: {format(r.value)}</>)}>
            <span>{r.label}</span>
            <span className="signed-track">
              <span className="signed-bar" style={{ left: r.value >= 0 ? "50%" : `${50 - w}%`, width: `${w}%`, background: r.color }} />
            </span>
            <span className="num signed-val">{r.note ?? format(r.value)}</span>
          </div>
        );
      })}
      {tip.el}
    </div>
  );
}

/* ---------- every call as a square: right, wrong or waiting ---------- */

export type Call = { key: string; state: "right" | "wrong" | "pending"; tip: ReactNode };
const GLYPH = { right: "✓", wrong: "✕", pending: "" };
const FILL = { right: GOOD, wrong: BAD, pending: PENDING };

export function CallStrip({ calls }: { calls: Call[] }) {
  const tip = useTip();
  return (
    <div className="calls" ref={tip.ref}>
      <div className="call-grid" role="img" aria-label={`${calls.filter((c) => c.state === "right").length} right, ${calls.filter((c) => c.state === "wrong").length} wrong, ${calls.filter((c) => c.state === "pending").length} pending`}>
        {calls.map((c) => (
          <span key={c.key} className={`call ${c.state}`} style={{ background: FILL[c.state] }} {...tip.on(c.tip)}>{GLYPH[c.state]}</span>
        ))}
      </div>
      {tip.el}
    </div>
  );
}

export function CallLegend() {
  return (
    <span className="legend">
      <span><i className="sq" style={{ background: GOOD }}>✓</i>Right</span>
      <span><i className="sq" style={{ background: BAD }}>✕</i>Wrong</span>
      <span><i className="sq" style={{ background: PENDING }} />Pending</span>
    </span>
  );
}

// 18px outline icons, 1.5px stroke, one set
const base = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.5,
  strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };

export const GameIcon = () => (
  <svg {...base}><rect x="3" y="5" width="18" height="14" rx="1.5" /><path d="M12 5v14M3 10h3v4H3M21 10h-3v4h3" /><circle cx="12" cy="12" r="2" /></svg>
);
export const PlayerIcon = () => (
  <svg {...base}><circle cx="12" cy="7.5" r="3.5" /><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" /></svg>
);
export const ReportIcon = () => (
  <svg {...base}><path d="M4 20V4M4 20h16" /><path d="M8 16l4-5 3 3 4-6" /></svg>
);
export const SwapIcon = () => (
  <svg {...base}><path d="M7 7h12l-3-3M17 17H5l3 3" /></svg>
);
export const SearchIcon = () => (
  <svg {...base}><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></svg>
);

/** The product's mark: a ball in ink with its seams cut out (the chrome holds no colour). */
export const Mark = () => (
  <svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true">
    <circle cx="15" cy="15" r="13" fill="#0a0a0a" />
    <path d="M2 15h26M15 2v26M6 5.5c4.5 5 4.5 14 0 19M24 5.5c-4.5 5-4.5 14 0 19" fill="none" stroke="#f4f3f1" strokeWidth="1.6" />
  </svg>
);

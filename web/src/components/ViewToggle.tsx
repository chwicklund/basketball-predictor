import { setView, useView } from "../lib/view";

/** Charts or detailed: the same switch on every page, remembered across visits. */
export default function ViewToggle() {
  const view = useView();
  return (
    <div className="segmented view-toggle" role="group" aria-label="View">
      <button aria-pressed={view === "charts"} onClick={() => setView("charts")}>Charts</button>
      <button aria-pressed={view === "detail"} onClick={() => setView("detail")}>Detailed</button>
    </div>
  );
}

/** The right side of a page's title row: the view switch over the data stamp. */
export function TitleSide({ stamp }: { stamp?: string }) {
  return (
    <div className="title-side">
      <ViewToggle />
      {stamp && <span className="stamp">{stamp}</span>}
    </div>
  );
}

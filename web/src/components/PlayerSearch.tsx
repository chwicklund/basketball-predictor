import Fuse from "fuse.js";
import { useMemo, useState } from "react";
import type { PlayerState } from "../lib/types";
import { SearchIcon } from "./Icons";

interface Props {
  players: Record<string, PlayerState>;
  onPick: (id: string) => void;
}

export default function PlayerSearch({ players, onPick }: Props) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const fuse = useMemo(() => new Fuse(
    Object.entries(players).map(([id, p]) => ({ id, name: p.player, team: p.team })),
    { keys: ["name"], threshold: 0.35, ignoreLocation: true },
  ), [players]);
  const hits = q.length >= 2 ? fuse.search(q, { limit: 8 }).map((h) => h.item) : [];
  const pick = (id: string) => { onPick(id); setQ(""); setOpen(false); };
  return (
    <div className="search" role="search">
      <SearchIcon />
      <input
        className="input" placeholder="Find a player" value={q} aria-label="Find a player"
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onKeyDown={(e) => { if (e.key === "Enter" && hits[0]) pick(hits[0].id); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && hits.length > 0 && (
        <ul>
          {hits.map((h) => (
            <li key={h.id}>
              <button onMouseDown={() => pick(h.id)}>
                <span>{h.name}</span><span className="muted">{h.team}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

import type { TeamState } from "../lib/types";

interface Props {
  label: string;
  value: string;
  teams: Record<string, TeamState>;
  exclude?: string;
  onChange: (team: string) => void;
}

export default function TeamSelect({ label, value, teams, exclude, onChange }: Props) {
  const ids = Object.keys(teams).sort((a, b) => teams[a].name.localeCompare(teams[b].name));
  return (
    <label className="control">
      <span>{label}</span>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        {ids.map((t) => (
          <option key={t} value={t} disabled={t === exclude}>{teams[t].name}</option>
        ))}
      </select>
    </label>
  );
}

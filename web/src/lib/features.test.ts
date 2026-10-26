// The browser's feature assembly and inference must match Python's answers in fixtures.json.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ort from "onnxruntime-node";
import { describe, expect, it } from "vitest";
import { gameFeatures, lineupFromRoster, playerFeatures, vacatedMinutes, winProbability } from "./features";
import { StatModels, type Ort } from "./inference";
import type { FeatureSpec, GameModel, Opponents, PlayerState, QuantileTable, StatRange, TeamState } from "./types";

const dir = join(__dirname, "../../public/data");
const read = <T>(name: string): T => JSON.parse(readFileSync(join(dir, name), "utf8"));

const spec = read<FeatureSpec>("feature_spec.json");
const teams = read<Record<string, TeamState>>("teams.json");
const players = read<Record<string, PlayerState>>("players.json");
const opponents = read<Opponents>("opponents.json");
const quantiles = read<Record<string, QuantileTable>>("quantiles.json");
const model = read<GameModel>("game_model.json");
const fixtures = read<{
  games: {
    home: string; away: string; date: string; toggles: Record<string, { out: string[]; add: string[] }>;
    features: Record<string, number>; p_home: number; margin: number;
  }[];
  players: {
    player_id: string; opp: string; date: string; is_home: number; teammates_out: string[];
    minutes_override: number | null; features: number[]; projection: Record<string, StatRange>;
  }[];
}>("fixtures.json");

describe("game model", () => {
  it.each(fixtures.games.map((g) => [`${g.away} @ ${g.home}`, g] as const))("%s", (_, g) => {
    const lineup = (t: string) => lineupFromRoster(teams[t].roster, g.toggles[t].out, g.toggles[t].add);
    const f = gameFeatures(teams[g.home], teams[g.away], g.date, 0, lineup(g.home), lineup(g.away));
    for (const name of spec.game) expect(f[name]).toBeCloseTo(g.features[name], 6);
    const pred = winProbability(model, f);
    expect(pred.pHome).toBeCloseTo(g.p_home, 6);
    expect(pred.margin).toBeCloseTo(g.margin, 6);
  });
});

describe("stat models", async () => {
  const models = await StatModels.load(ort as unknown as Ort, spec.targets, async (t) =>
    readFileSync(join(dir, "stat_models", `${t}.onnx`)));

  it.each(fixtures.players.map((c) => [`${c.player_id} vs ${c.opp}`, c] as const))("%s", async (_, c) => {
    const p = players[c.player_id];
    const vacated = vacatedMinutes(c.teammates_out.map((id) => players[id]), spec.rotation_min);
    const f = playerFeatures(p, teams[p.team], teams[c.opp], opponents[c.opp], c.date, c.is_home, spec.rate_stats, vacated);
    const x = spec.player.map((name) => f[name]);
    x.forEach((v, i) => expect(v, spec.player[i]).toBeCloseTo(c.features[i], 6));
    const proj = await models.predict(x, quantiles, c.minutes_override);
    for (const s of spec.targets) {
      expect(proj[s].mean, s).toBeCloseTo(c.projection[s].mean, 2);
      expect(proj[s].p10, s).toBe(c.projection[s].p10);
      expect(proj[s].p90, s).toBe(c.projection[s].p90);
    }
  });
});

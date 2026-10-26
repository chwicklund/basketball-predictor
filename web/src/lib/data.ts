// Loads (once) the JSON and ONNX files that ml/export.py writes to public/data.

import { useEffect, useState } from "react";
// The package doesn't export its runtime files, so reach them by path; Vite emits them as hashed assets
import ortMjs from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url";
import ortWasm from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url";
import { StatModels } from "./inference";
import type {
  FeatureSpec, GameBacktest, GameModel, History, Meta, Opponents, PlayerBacktest, PlayerState,
  Injuries, QuantileTable, ScheduledGame, TeamState, TrackRecord,
} from "./types";

const BASE = `${import.meta.env.BASE_URL}data/`;
const cache = new Map<string, Promise<unknown>>();

export interface Files {
  "meta.json": Meta;
  "feature_spec.json": FeatureSpec;
  "game_model.json": GameModel;
  "teams.json": Record<string, TeamState>;
  "opponents.json": Opponents;
  "players.json": Record<string, PlayerState>;
  "history.json": History;
  "quantiles.json": Record<string, QuantileTable>;
  "schedule.json": ScheduledGame[];
  "game_backtest.json": GameBacktest[];
  "player_backtest.json": Record<string, PlayerBacktest[]>;
  "track_record.json": TrackRecord;
  "injuries.json": Injuries;
}

export function load<K extends keyof Files>(name: K): Promise<Files[K]> {
  if (!cache.has(name)) {
    cache.set(name, fetch(BASE + name).then((r) => {
      if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
      return r.json();
    }));
  }
  return cache.get(name) as Promise<Files[K]>;
}

/** Load several files; returns undefined until all have arrived. */
export function useFiles<K extends keyof Files>(...names: K[]): { [P in K]: Files[P] } | undefined {
  const [files, setFiles] = useState<{ [P in K]: Files[P] }>();
  const key = names.join(",");
  useEffect(() => {
    let live = true;
    Promise.all(names.map((n) => load(n))).then((vals) => {
      if (live) setFiles(Object.fromEntries(names.map((n, i) => [n, vals[i]])) as unknown as { [P in K]: Files[P] });
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return files;
}

let statModels: Promise<StatModels> | undefined;

export function loadStatModels(targets: string[]): Promise<StatModels> {
  statModels ??= (async () => {
    // The plain WASM build is enough for small tree models (no WebGPU)
    const ort = await import("onnxruntime-web/wasm");
    ort.env.wasm.wasmPaths = { mjs: ortMjs, wasm: ortWasm };
    ort.env.wasm.numThreads = 1; // threads need cross-origin isolation, which static hosting lacks
    return StatModels.load(ort, targets, async (t) =>
      new Uint8Array(await (await fetch(`${BASE}stat_models/${t}.onnx`)).arrayBuffer()));
  })();
  return statModels;
}

// Runs the exported LightGBM stat models (ONNX) and turns their output into projections.

import type { InferenceSession } from "onnxruntime-web";
import { project } from "./features";
import type { QuantileTable, StatRange } from "./types";

// onnxruntime-web in the browser, onnxruntime-node in tests; both share this API
export interface Ort {
  InferenceSession: { create(model: Uint8Array): Promise<InferenceSession> };
  Tensor: new (type: "float32", data: Float32Array, dims: number[]) => unknown;
}

export class StatModels {
  private constructor(
    private ort: Ort,
    private sessions: Record<string, InferenceSession>,
  ) {}

  static async load(ort: Ort, targets: string[], fetchModel: (target: string) => Promise<Uint8Array>) {
    const entries = await Promise.all(
      targets.map(async (t) => [t, await ort.InferenceSession.create(await fetchModel(t))] as const),
    );
    return new StatModels(ort, Object.fromEntries(entries));
  }

  /** Raw outputs: predicted minutes and per-36 rates for every other target. */
  async raw(features: number[]): Promise<{ minutes: number; rates: Record<string, number> }> {
    const x = new this.ort.Tensor("float32", Float32Array.from(features), [1, features.length]);
    const outputs = await Promise.all(
      Object.entries(this.sessions).map(async ([t, s]) => {
        const res = await s.run({ x } as Parameters<InferenceSession["run"]>[0]);
        return [t, Number((res[s.outputNames[0]].data as Float32Array)[0])] as const;
      }),
    );
    const { MIN, ...rates } = Object.fromEntries(outputs);
    return { minutes: MIN, rates };
  }

  async predict(
    features: number[],
    quantiles: Record<string, QuantileTable>,
    minutesOverride?: number | null,
  ): Promise<Record<string, StatRange>> {
    const { minutes, rates } = await this.raw(features);
    return project(minutes, rates, quantiles, minutesOverride);
  }
}

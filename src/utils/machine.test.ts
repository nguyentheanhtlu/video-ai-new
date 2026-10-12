import { describe, it, expect } from "vitest";
import { planParallelism } from "./machine.js";

describe("planParallelism", () => {
  it("keeps a weak machine fully sequential", () => {
    const p = planParallelism({}, { cores: 2, memGb: 4 });
    expect(p).toMatchObject({ budget: 1, jobs: 1, scenes: 1, workers: 1 });
  });

  it("splits a mid machine into 2 videos × 2 scenes", () => {
    const p = planParallelism({}, { cores: 6, memGb: 16 });
    expect(p).toMatchObject({ budget: 5, jobs: 2, perJob: 2, scenes: 2, workers: 1 });
  });

  it("is capped by RAM, not just cores", () => {
    expect(planParallelism({}, { cores: 16, memGb: 8 }).budget).toBe(6);
  });

  it("scales up on a big machine", () => {
    const p = planParallelism({}, { cores: 32, memGb: 64 });
    expect(p).toMatchObject({ budget: 31, jobs: 3, perJob: 10, scenes: 4, workers: 2 });
  });

  it("gives a standalone CLI run the whole budget via RENDER_BUDGET", () => {
    const p = planParallelism({ RENDER_BUDGET: "5" }, { cores: 6, memGb: 16 });
    expect(p).toMatchObject({ scenes: 4, workers: 1 });
  });

  it("honours overrides and treats 'auto' as unset", () => {
    const p = planParallelism(
      { MAX_PARALLEL_JOBS: "1", RENDER_CONCURRENCY: "auto", RENDER_WORKERS: "3" },
      { cores: 6, memGb: 16 },
    );
    expect(p).toMatchObject({ jobs: 1, perJob: 5, scenes: 4, workers: 3 });
  });
});

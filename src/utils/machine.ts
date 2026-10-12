import { availableParallelism, totalmem } from "node:os";

export interface Machine {
  cores: number;
  memGb: number;
}

export interface ParallelPlan extends Machine {
  /** Chrome render workers the machine can carry at once. */
  budget: number;
  /** Videos rendered at the same time (web job queue). */
  jobs: number;
  /** Share of `budget` each video gets. */
  perJob: number;
  /** Scene clips rendered at once inside one video. */
  scenes: number;
  /** HyperFrames `--workers` per clip. */
  workers: number;
}

type Env = Record<string, string | undefined>;

export function detectMachine(): Machine {
  return { cores: availableParallelism(), memGb: Math.round(totalmem() / 2 ** 30) };
}

/** Positive integer from env, or undefined for unset / "auto" / garbage. */
function intSetting(env: Env, name: string, max: number): number | undefined {
  const n = parseInt(env[name] ?? "", 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : undefined;
}

/**
 * Split the machine between parallel videos, parallel scenes and Chrome workers.
 * A render worker is one Chrome (~1 GB with 1080p frames) pinning about a core,
 * so the budget keeps one core and 2 GB back for the OS, ffmpeg and the web UI.
 * MAX_PARALLEL_JOBS / RENDER_CONCURRENCY / RENDER_WORKERS override each level;
 * RENDER_BUDGET is set by the web server on the pipelines it spawns.
 */
export function planParallelism(env: Env = process.env, machine: Machine = detectMachine()): ParallelPlan {
  const budget = Math.max(1, Math.min(machine.cores - 1, machine.memGb - 2));
  const jobs = intSetting(env, "MAX_PARALLEL_JOBS", 8) ?? (budget >= 12 ? 3 : budget >= 4 ? 2 : 1);
  const perJob = intSetting(env, "RENDER_BUDGET", 64) ?? Math.max(1, Math.floor(budget / jobs));
  // Scenes first: clips are short, so one Chrome per scene beats splitting a
  // clip's frames across workers (each render pays its own startup).
  const scenes = intSetting(env, "RENDER_CONCURRENCY", 16) ?? Math.min(perJob, 4);
  const workers = intSetting(env, "RENDER_WORKERS", 16) ?? Math.max(1, Math.floor(perJob / scenes));
  return { ...machine, budget, jobs, perJob, scenes, workers };
}

/** Plan for one pipeline process: its server-assigned share, or the whole machine when run from the CLI. */
export function planRender(env: Env = process.env, machine: Machine = detectMachine()): ParallelPlan {
  const plan = planParallelism(env, machine);
  if (env.RENDER_BUDGET) return plan;
  return planParallelism({ ...env, RENDER_BUDGET: String(plan.budget) }, machine);
}

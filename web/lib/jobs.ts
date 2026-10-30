import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { freemem } from "node:os";
import { hyperframesCached } from "../../src/render/template-composer.js";
import { planParallelism } from "../../src/utils/machine.js";
import { ROOT, TSX_CLI } from "./paths.js";

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface Job {
  id: string;
  kind: "pipeline" | "generate" | "render-scene" | "preview-template" | "reference-template" | "sfx-download" | "sfx-filter";
  title: string;
  slug?: string;
  /** Jobs sharing a lock never run together (same project / same output file). */
  lock?: string;
  status: JobStatus;
  progress: { step: number; total: number; label: string } | null;
  logs: string[];
  error?: string;
  result?: unknown;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
}

export interface JobContext {
  log: (line: string) => void;
  progress: (step: number, total: number, label: string) => void;
  /** Run a TypeScript entry via tsx, streaming its output into the job log. */
  runTs: (args: string[]) => Promise<void>;
  signal: AbortSignal;
}

type Runner = (ctx: JobContext) => Promise<unknown>;

const MAX_LOG = 4000;
const jobs = new Map<string, Job>();
const runners = new Map<string, Runner>();
const queue: string[] = [];
const children = new Map<string, ChildProcess>();
const aborts = new Map<string, AbortController>();
const running = new Set<string>();
/** Network-bound jobs: they don't take a render slot. */
const LIGHT: Job["kind"][] = ["generate"];
const MAX_LIGHT = 4;
/** Don't add another render next to a running one below this much free RAM. */
const MIN_FREE_BYTES = 1.5 * 2 ** 30;
const memWaiting = new Set<string>();

/** Emits "update" (Job) on any change and "log" (jobId, line). */
export const bus = new EventEmitter();
bus.setMaxListeners(100);

const summary = (j: Job) => ({ ...j, logs: undefined, logCount: j.logs.length });
export type JobSummary = ReturnType<typeof summary>;

function touch(job: Job) {
  bus.emit("update", summary(job));
}

export function listJobs(): JobSummary[] {
  return [...jobs.values()].map(summary).reverse();
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function activeJobFor(slug: string): Job | undefined {
  return [...jobs.values()].find((j) => j.slug === slug && (j.status === "queued" || j.status === "running"));
}

/**
 * Enqueue work. Renders run a few at a time, sized to the machine (see
 * planParallelism); a project's per-scene caches aren't safe to write from two
 * runs at once, so jobs with the same `lock` (default: the slug) stay serial.
 */
export function enqueue(kind: Job["kind"], title: string, runner: Runner, slug?: string, lock = slug): Job {
  const job: Job = {
    id: randomUUID(),
    kind,
    title,
    slug,
    lock,
    status: "queued",
    progress: null,
    logs: [],
    createdAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);
  runners.set(job.id, runner);
  queue.push(job.id);
  // Keep memory bounded: forget old finished jobs.
  const finished = [...jobs.values()].filter((j) => j.status !== "queued" && j.status !== "running");
  for (const old of finished.slice(0, Math.max(0, finished.length - 30))) jobs.delete(old.id);
  touch(job);
  pump();
  return job;
}

export function cancelJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.status === "queued") {
    queue.splice(queue.indexOf(id), 1);
    memWaiting.delete(id);
    job.status = "cancelled";
    job.endedAt = new Date().toISOString();
    touch(job);
    return true;
  }
  if (job.status !== "running") return false;
  aborts.get(id)?.abort();
  const child = children.get(id);
  if (child?.pid) {
    // Kill the whole tree: tsx → node → npx → hyperframes → chromium/ffmpeg.
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
    else child.kill("SIGTERM");
  }
  return true;
}

/** Each spawned pipeline gets its share of the machine, so N videos at once don't oversubscribe it. */
function childEnv(): NodeJS.ProcessEnv {
  const plan = planParallelism();
  return {
    ...process.env,
    RENDER_BUDGET: String(plan.perJob),
    TTS_CONCURRENCY: process.env.TTS_CONCURRENCY ?? String(Math.max(2, Math.ceil(6 / plan.jobs))),
  };
}

function appendLog(job: Job, text: string) {
  for (const raw of text.split(/\r?\n|\r/)) {
    // eslint-disable-next-line no-control-regex
    const line = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trimEnd();
    if (!line.trim()) continue;
    job.logs.push(line);
    if (job.logs.length > MAX_LOG) job.logs.splice(0, job.logs.length - MAX_LOG);
    bus.emit("log", job.id, line);
    const m = line.match(/\[(\d+)\/(\d+)\]\s+(.*)$/);
    if (m) {
      job.progress = { step: Number(m[1]), total: Number(m[2]), label: m[3] };
      touch(job);
    }
  }
}

/** Start every queued job that fits: free slot of its weight, lock not held, RAM to spare. */
export function pump() {
  // First run: concurrent `npx` installs of HyperFrames would corrupt its cache.
  const maxHeavy = hyperframesCached() ? planParallelism().jobs : 1;
  for (const id of [...queue]) {
    const job = jobs.get(id)!;
    const live = [...running].map((r) => jobs.get(r)!);
    if (job.lock && live.some((j) => j.lock === job.lock)) continue;
    const light = LIGHT.includes(job.kind);
    const peers = live.filter((j) => LIGHT.includes(j.kind) === light).length;
    if (peers >= (light ? MAX_LIGHT : maxHeavy)) continue;
    if (!light && peers > 0 && freemem() < MIN_FREE_BYTES) {
      if (!memWaiting.has(id)) appendLog(job, "RAM trống đang thấp — chờ job đang chạy xong rồi mới bắt đầu.");
      memWaiting.add(id);
      continue;
    }
    queue.splice(queue.indexOf(id), 1);
    memWaiting.delete(id);
    void start(job);
  }
}

async function start(job: Job) {
  const id = job.id;
  const runner = runners.get(id)!;
  running.add(id);
  const abort = new AbortController();
  aborts.set(id, abort);
  job.status = "running";
  job.startedAt = new Date().toISOString();
  touch(job);

  const ctx: JobContext = {
    signal: abort.signal,
    log: (line) => appendLog(job, line),
    progress: (step, total, label) => {
      job.progress = { step, total, label };
      touch(job);
    },
    runTs: (args) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [TSX_CLI, ...args], {
          cwd: ROOT,
          env: { ...childEnv(), FORCE_COLOR: "0", NO_COLOR: "1" },
          windowsHide: true,
        });
        children.set(id, child);
        child.stdout.setEncoding("utf8").on("data", (d: string) => appendLog(job, d));
        child.stderr.setEncoding("utf8").on("data", (d: string) => appendLog(job, d));
        child.on("error", reject);
        child.on("close", (code) => {
          children.delete(id);
          if (abort.signal.aborted) reject(new Error("Đã huỷ"));
          else if (code === 0) resolve();
          else reject(new Error(`Tiến trình kết thúc với mã lỗi ${code}`));
        });
      }),
  };

  try {
    job.result = await runner(ctx);
    job.status = abort.signal.aborted ? "cancelled" : "done";
  } catch (e) {
    job.status = abort.signal.aborted ? "cancelled" : "failed";
    job.error = (e as Error).message;
    appendLog(job, `✗ ${job.error}`);
  } finally {
    job.endedAt = new Date().toISOString();
    running.delete(id);
    aborts.delete(id);
    runners.delete(id);
    touch(job);
    pump();
  }
}

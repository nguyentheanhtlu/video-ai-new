import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { ROOT, TSX_CLI } from "./paths.js";

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface Job {
  id: string;
  kind: "pipeline" | "generate" | "render-scene" | "preview-template" | "sfx-download" | "sfx-filter";
  title: string;
  slug?: string;
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
let running: string | null = null;

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
 * Enqueue work. Jobs run one at a time — rendering is CPU/Chromium heavy and the
 * pipeline's per-scene caches aren't safe to write from two runs at once.
 */
export function enqueue(kind: Job["kind"], title: string, runner: Runner, slug?: string): Job {
  const job: Job = {
    id: randomUUID(),
    kind,
    title,
    slug,
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
  void pump();
  return job;
}

export function cancelJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.status === "queued") {
    queue.splice(queue.indexOf(id), 1);
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

async function pump() {
  if (running || queue.length === 0) return;
  const id = queue.shift()!;
  const job = jobs.get(id)!;
  const runner = runners.get(id)!;
  running = id;
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
          env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
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
    running = null;
    aborts.delete(id);
    runners.delete(id);
    touch(job);
    void pump();
  }
}

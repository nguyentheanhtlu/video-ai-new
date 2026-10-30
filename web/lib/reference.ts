import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDurationSec } from "../../src/assets/audio-tools.js";
import { ensureYtDlpOnPath } from "../../src/utils/ffmpeg-path.js";

/** What the AI gets to see of a sample video. */
export interface ReferenceVideo {
  title: string;
  sourceUrl: string;
  durationSec: number;
  width: number;
  height: number;
  /** Shots per the cut detector, and how long they last on average. */
  shots: number;
  avgShotSec: number;
  transcript: string;
  /** JPEG frames, base64, in time order. */
  frames: string[];
}

const MAX_FRAMES = 12;
const MAX_DOWNLOAD = "300M";

export function ytDlpInstalled(): boolean {
  ensureYtDlpOnPath();
  return spawnSync("yt-dlp", ["--version"], { windowsHide: true }).status === 0;
}

function run(cmd: string, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    // Windows defaults to a legacy code page, which garbles Vietnamese titles.
    const proc = spawn(cmd, args, { windowsHide: true, signal, env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" } });
    proc.stdout.setEncoding("utf8");
    let out = "";
    let err = "";
    proc.stdout.on("data", (c) => (out += c));
    proc.stderr.on("data", (c) => (err += c));
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve(out + err) : reject(new Error(`${cmd} lỗi: ${err.trim().slice(-400)}`))));
  });
}

/** Spoken lines of a WebVTT file, without timings and rolling-caption repeats. */
export function vttToText(vtt: string): string {
  const lines: string[] = [];
  for (const raw of vtt.split(/\r?\n/)) {
    if (!raw.trim() || raw.includes("-->") || /^(WEBVTT|Kind:|Language:|NOTE)/.test(raw)) continue;
    const line = raw.replace(/<[^>]+>/g, "").trim();
    if (line && lines[lines.length - 1] !== line) lines.push(line);
  }
  return lines.join(" ");
}

/** Last line of yt-dlp's output, without the hashtags social videos pad their titles with. */
export function cleanTitle(output: string): string {
  const line = output.trim().split(/\r?\n/).pop() ?? "";
  return line.replace(/#\S+/g, "").replace(/\s+/g, " ").trim();
}

async function download(url: string, dir: string, signal: AbortSignal, log: (line: string) => void) {
  if (!ytDlpInstalled()) {
    throw new Error("Máy chưa có yt-dlp nên chưa tải được link. Chạy: winget install yt-dlp.yt-dlp rồi khởi động lại web, hoặc tải file video mẫu lên trực tiếp.");
  }
  const title = await run("yt-dlp", [
    "--encoding", "utf-8", "--no-playlist", "--no-warnings", "--no-progress",
    "--max-filesize", MAX_DOWNLOAD,
    "-f", "bv*[height<=720]+ba/b[height<=720]/b",
    "--merge-output-format", "mp4",
    "-o", join(dir, "ref.%(ext)s"),
    "--print", "after_move:title",
    "--", url,
  ], signal);
  // Subtitles only improve the analysis: sites rate-limit them, and that mustn't lose the video.
  await run("yt-dlp", [
    "--encoding", "utf-8", "--no-playlist", "--no-warnings", "--no-progress", "--skip-download",
    "--write-auto-subs", "--write-subs", "--sub-format", "vtt", "--sub-langs", "vi,en,vi-orig,en-orig",
    "-o", join(dir, "ref.%(ext)s"),
    "--", url,
  ], signal).catch((e) => log(`Không lấy được phụ đề, phân tích bằng hình ảnh (${(e as Error).message.slice(-120)})`));
  const files = await readdir(dir);
  const video = files.find((f) => f.endsWith(".mp4"));
  if (!video) throw new Error("yt-dlp không tạo ra file video.");
  const subs = files.find((f) => f.endsWith(".vtt"));
  return {
    file: join(dir, video),
    title: cleanTitle(title),
    transcript: subs ? vttToText(await readFile(join(dir, subs), "utf8")) : "",
  };
}

async function probeSize(file: string, signal: AbortSignal) {
  const out = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], signal);
  const [width, height] = out.trim().split(",").map(Number);
  if (!width || !height) throw new Error("File không có hình ảnh video.");
  return { width, height };
}

async function countCuts(file: string, signal: AbortSignal): Promise<number> {
  const out = await run("ffmpeg", ["-hide_banner", "-i", file, "-an", "-vf", "select='gt(scene,0.3)',metadata=print:file=-", "-f", "null", "-"], signal);
  return (out.match(/pts_time:/g) ?? []).length;
}

/** Evenly spaced stills, plus one early frame because hooks carry the most style. */
async function sampleFrames(file: string, durationSec: number, dir: string, signal: AbortSignal): Promise<string[]> {
  const times = [Math.min(0.7, durationSec / 2), ...Array.from({ length: MAX_FRAMES - 1 }, (_, i) => (durationSec * (i + 1)) / MAX_FRAMES)];
  const frames: string[] = [];
  for (const [i, t] of times.entries()) {
    const out = join(dir, `f${i}.jpg`);
    await run("ffmpeg", ["-y", "-v", "error", "-ss", t.toFixed(2), "-i", file, "-frames:v", "1", "-vf", "scale='min(540,iw)':-2", "-q:v", "4", out], signal);
    frames.push((await readFile(out)).toString("base64"));
  }
  return frames;
}

/** Analyse a sample from a link or a local file; the video itself is never kept. */
export async function loadReference(
  source: { url?: string; file?: string; name?: string },
  signal: AbortSignal,
  log: (line: string) => void,
): Promise<ReferenceVideo> {
  const dir = await mkdtemp(join(tmpdir(), "ref-video-"));
  try {
    let file = source.file;
    let title = "";
    let transcript = "";
    if (!file) {
      log(`Tải video mẫu: ${source.url}`);
      ({ file, title, transcript } = await download(source.url!, dir, signal, log));
    }
    const durationSec = await getDurationSec(file);
    const size = await probeSize(file, signal);
    log(`Video mẫu: ${durationSec.toFixed(1)}s, ${size.width}x${size.height}${transcript ? ", có phụ đề" : ", không có phụ đề"}`);
    const shots = (await countCuts(file, signal)) + 1;
    const frames = await sampleFrames(file, durationSec, dir, signal);
    return {
      title: source.name?.trim() || title,
      sourceUrl: source.url ?? "",
      durationSec,
      ...size,
      shots,
      avgShotSec: durationSec / shots,
      transcript: transcript.slice(0, 4000),
      frames,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

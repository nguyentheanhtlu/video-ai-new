import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";

/** Run ffmpeg/ffprobe; rejects with the tail of stderr. `cwd` lets filters take relative paths (ass=…). */
export function run(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, windowsHide: true });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => {
      err += d.toString();
      if (err.length > 20000) err = err.slice(-8000);
    });
    proc.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} failed (exit ${code}): ${err.slice(-1500)}`))));
    proc.on("error", reject);
  });
}

export const W = 1920;
export const H = 1080;
export const FPS = 30;

/** Intermediate clips: fast, near-lossless, all identical so they join cleanly. */
export const MID_ENCODE = ["-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-pix_fmt", "yuv420p", "-r", String(FPS)];

export async function probeSize(file: string): Promise<{ width: number; height: number; duration: number }> {
  const out = await run("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height:format=duration",
    "-of", "json", file,
  ]);
  const j = JSON.parse(out);
  return {
    width: Number(j.streams?.[0]?.width) || 0,
    height: Number(j.streams?.[0]?.height) || 0,
    duration: Number(j.format?.duration) || 0,
  };
}

export function fileKey(...parts: (string | number)[]): string {
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
}

/** Path + mtime + size, so replacing a photo under the same name re-renders its shots. */
export function fileStamp(path: string): string {
  if (!existsSync(path)) return path;
  const s = statSync(path);
  return `${path}:${s.mtimeMs}:${s.size}`;
}

import { existsSync, readdirSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * The pipeline shells out to `ffmpeg`/`ffprobe` by name. If they aren't on PATH
 * (e.g. a terminal opened before FFmpeg was installed), fall back to a static
 * build in %LOCALAPPDATA%\ffmpeg\<build>\bin and prepend it for this process and
 * its children. Returns the directory in use, or null if none was found.
 */
export function ensureFfmpegOnPath(): string | null {
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const dirs = (process.env.PATH ?? "").split(delimiter);
  const found = dirs.find((d) => d && existsSync(join(d, exe)));
  if (found) return found;

  const base = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "ffmpeg") : null;
  if (!base || !existsSync(base)) return null;
  for (const sub of readdirSync(base)) {
    const bin = join(base, sub, "bin");
    if (existsSync(join(bin, exe))) {
      process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
      return bin;
    }
  }
  return null;
}

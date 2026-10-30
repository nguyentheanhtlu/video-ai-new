import { existsSync, readdirSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * The pipeline shells out to `ffmpeg`/`ffprobe` by name. If they aren't on PATH
 * (e.g. a terminal opened before FFmpeg was installed), fall back to a static
 * build in %LOCALAPPDATA%\ffmpeg\<build>\bin and prepend it for this process and
 * its children. Returns the directory in use, or null if none was found.
 */
/**
 * Same idea for yt-dlp: winget puts it in its own folder under Packages, which a
 * process started before the install doesn't have on PATH.
 */
export function ensureYtDlpOnPath(): void {
  const exe = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  if ((process.env.PATH ?? "").split(delimiter).some((d) => d && existsSync(join(d, exe)))) return;
  const packages = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Packages") : null;
  if (!packages || !existsSync(packages)) return;
  const dir = readdirSync(packages).map((d) => join(packages, d)).find((d) => existsSync(join(d, exe)));
  if (dir) process.env.PATH = `${dir}${delimiter}${process.env.PATH ?? ""}`;
}

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

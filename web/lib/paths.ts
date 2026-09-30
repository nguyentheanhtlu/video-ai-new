import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const OUTPUT_DIR = join(ROOT, "output");
export const TEMPLATES_DIR = join(ROOT, "templates");
export const SFX_DIR = join(ROOT, "assets", "sfx");
export const SFX_RAW_DIR = join(ROOT, "SFX");
export const PREVIEW_DIR = join(OUTPUT_DIR, ".previews");
export const ENV_FILE = join(ROOT, ".env.local");
export const TSX_CLI = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/;

/** Resolve output/<slug>, refusing anything that could escape the output dir. */
export function projectDir(slug: string): string {
  if (!SLUG_RE.test(slug) || slug.includes("..")) throw new HttpError(400, `Tên dự án không hợp lệ: ${slug}`);
  return join(OUTPUT_DIR, slug);
}

/** Join `rel` under `base`, rejecting traversal. */
export function safeJoin(base: string, rel: string): string {
  const p = resolve(base, rel);
  if (p !== base && !p.startsWith(base + sep)) throw new HttpError(400, "Đường dẫn không hợp lệ");
  return p;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export { ensureFfmpegOnPath } from "../../src/utils/ffmpeg-path.js";

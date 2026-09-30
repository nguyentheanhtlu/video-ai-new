import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve, sep } from "node:path";

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

export function fileToDataUri(path: string): string {
  const mime = MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
  return `data:${mime};base64,${readFileSync(path).toString("base64")}`;
}

const IMAGE_PATH = /^[^:*?"<>|]+\.(jpe?g|png|webp|gif|svg)$/i;

/**
 * Replace image paths in template inputs (e.g. "images/03.jpg", relative to the
 * project folder) with data: URIs. Templates render in a temp copy served by
 * HyperFrames, so project-relative files aren't reachable by URL — inlining is
 * the one form every template can load. Works on nested arrays/objects.
 */
export function inlineImages(value: unknown, baseDir: string): unknown {
  if (typeof value === "string") {
    if (!IMAGE_PATH.test(value) || /^https?:/i.test(value)) return value;
    const base = resolve(baseDir);
    const p = isAbsolute(value) ? value : resolve(base, value);
    if (!isAbsolute(value) && !p.startsWith(base + sep)) return value;
    if (existsSync(p) && statSync(p).isFile()) return fileToDataUri(p);
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => inlineImages(v, baseDir));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, inlineImages(v, baseDir)]));
  }
  return value;
}

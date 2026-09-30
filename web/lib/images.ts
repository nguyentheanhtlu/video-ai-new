import axios from "axios";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ImageCandidate {
  url: string;
  caption: string;
}

export interface ProjectImage {
  /** Project-relative path used in script inputs, e.g. "images/01.jpg". */
  file: string;
  width: number;
  height: number;
  caption: string;
  url: string;
}

const SKIP = /logo|icon|avatar|sprite|favicon|banner-ads|\/ads?\/|pixel|tracking|blank|placeholder|emoji|loading|spacer|1x1|button|badge|qr[-_]?code/i;
const decode = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const stripTags = (s: string) => decode(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
  return m ? decode(m[2] ?? m[3] ?? "") : null;
}

/** Best URL from an <img> tag: lazy-load attributes first, then the widest srcset entry. */
function imgUrl(tag: string): string | null {
  for (const a of ["data-src", "data-original", "data-lazy-src", "data-srcset", "srcset", "src"]) {
    const v = attr(tag, a);
    if (!v || v.startsWith("data:")) continue;
    if (a.includes("srcset")) {
      const best = v
        .split(",")
        .map((p) => p.trim().split(/\s+/))
        .map(([u, w]) => ({ u, w: parseInt(w ?? "0", 10) || 0 }))
        .sort((x, y) => y.w - x.w)[0];
      if (best?.u) return best.u;
      continue;
    }
    return v;
  }
  return null;
}

/** Pull candidate photos (with captions) out of an article page, best first. */
export function extractImages(rawHtml: string, pageUrl: string): ImageCandidate[] {
  const html = rawHtml.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  const out: ImageCandidate[] = [];
  const seen = new Set<string>();
  const push = (u: string | null, caption = "") => {
    if (!u) return;
    let abs: string;
    try {
      abs = new URL(u, pageUrl).href;
    } catch {
      return;
    }
    if (!/^https?:/.test(abs) || /\.(svg|gif)(\?|$)/i.test(abs) || SKIP.test(abs)) return;
    const key = abs.replace(/[?#].*$/, "");
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ url: abs, caption: caption.slice(0, 200) });
  };

  const meta = (p: string) => {
    const tag = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]*>`, "i"))?.[0];
    return tag ? attr(tag, "content") : null;
  };
  push(meta("og:image"), meta("og:title") ?? "");
  push(meta("twitter:image"));

  const scope = html.match(/<article[\s\S]*<\/article>/i)?.[0] ?? html.match(/<main[\s\S]*<\/main>/i)?.[0] ?? html;
  // <figure> blocks carry captions; loose <img> tags come after.
  for (const fig of scope.matchAll(/<figure[\s\S]*?<\/figure>/gi)) {
    const img = fig[0].match(/<img[^>]*>/i)?.[0];
    const cap = fig[0].match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i)?.[1];
    if (img) push(imgUrl(img), cap ? stripTags(cap) : attr(img, "alt") ?? "");
  }
  for (const m of scope.matchAll(/<img[^>]*>/gi)) {
    const w = parseInt(attr(m[0], "width") ?? "0", 10);
    if (w && w < 300) continue;
    push(imgUrl(m[0]), attr(m[0], "alt") ?? "");
  }
  return out.slice(0, 20);
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err.slice(-300)))));
  });
}

async function probe(file: string): Promise<{ width: number; height: number }> {
  const out = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]);
  const [w, h] = out.trim().split(",").map(Number);
  return { width: w || 0, height: h || 0 };
}

// Several scenes save photos concurrently — hand out file numbers one at a time.
const reserved = new Map<string, number>();
async function nextIndex(dir: string): Promise<number> {
  const nums = existsSync(dir) ? (await readdir(dir)).map((f) => parseInt(f, 10)).filter((n) => !isNaN(n)) : [];
  const next = Math.max(nums.length ? Math.max(...nums) + 1 : 1, (reserved.get(dir) ?? 0) + 1);
  reserved.set(dir, next);
  return next;
}

/**
 * Normalise one image into <projectDir>/images/NN.jpg (≤1600px, JPEG) so it can
 * be inlined into templates cheaply. Returns null when the picture is too small
 * or oddly shaped to work as a video background.
 */
export async function saveImage(
  projectDir: string,
  bytes: Buffer,
  meta: { url: string; caption: string },
  opts: { minWidth?: number; force?: boolean } = {},
): Promise<ProjectImage | null> {
  const imagesDir = join(projectDir, "images");
  await mkdir(imagesDir, { recursive: true });
  const tmp = join(tmpdir(), `img-${createHash("md5").update(bytes).digest("hex")}`);
  await writeFile(tmp, bytes);
  try {
    const dim = await probe(tmp);
    const ratio = dim.width / Math.max(1, dim.height);
    if (!opts.force && (dim.width < (opts.minWidth ?? 480) || dim.height < 300 || ratio > 3.2 || ratio < 0.3)) return null;
    const name = `${String(await nextIndex(imagesDir)).padStart(2, "0")}.jpg`;
    const dest = join(imagesDir, name);
    await run("ffmpeg", ["-y", "-v", "error", "-i", tmp, "-vf", "scale='min(1600,iw)':-2", "-frames:v", "1", "-q:v", "3", dest]);
    const d = await probe(dest);
    return { file: `images/${name}`, width: d.width, height: d.height, caption: meta.caption, url: meta.url };
  } catch {
    return null;
  } finally {
    await rm(tmp, { force: true });
  }
}

export async function readImages(projectDir: string): Promise<ProjectImage[]> {
  try {
    const list = JSON.parse(await readFile(join(projectDir, "images.json"), "utf8")) as ProjectImage[];
    return list.filter((i) => existsSync(join(projectDir, i.file)));
  } catch {
    return [];
  }
}

export async function writeImages(projectDir: string, list: ProjectImage[]): Promise<void> {
  await writeFile(join(projectDir, "images.json"), JSON.stringify(list, null, 2));
}

export async function fetchImageBytes(url: string, referer?: string): Promise<Buffer> {
  const res = await axios.get<ArrayBuffer>(url, {
    responseType: "arraybuffer",
    timeout: 20000,
    maxContentLength: 25 * 1024 * 1024,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
      ...(referer ? { Referer: referer } : {}),
    },
  });
  return Buffer.from(res.data);
}

/** Download article photos into the project, skipping duplicates and tiny/odd images. */
export async function downloadArticleImages(
  projectDir: string,
  candidates: ImageCandidate[],
  referer: string,
  log: (line: string) => void,
  max = 10,
): Promise<ProjectImage[]> {
  const saved: ProjectImage[] = [];
  const hashes = new Set<string>();
  // Small batches: polite to the news site, still fast.
  for (let i = 0; i < candidates.length && saved.length < max; i += 4) {
    const batch = candidates.slice(i, i + 4);
    const bytes = await Promise.all(batch.map((c) => fetchImageBytes(c.url, referer).catch(() => null)));
    for (const [j, b] of bytes.entries()) {
      if (!b || b.length < 12000 || saved.length >= max) continue;
      const h = createHash("md5").update(b).digest("hex");
      if (hashes.has(h)) continue;
      hashes.add(h);
      const img = await saveImage(projectDir, b, batch[j]);
      if (img) saved.push(img);
    }
  }
  log(`Ảnh bài báo: tải ${saved.length}/${candidates.length} ảnh hợp lệ`);
  return saved;
}

import axios from "axios";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import pLimit from "p-limit";
import { ROOT } from "./paths.js";
import { getSetting } from "./settings.js";

/**
 * Stock footage for long videos. Pixabay is the main source (free key at
 * pixabay.com/api/docs — Pexels stopped issuing new API keys in 2026); an
 * existing Pexels key still works as a second source. Both licenses allow
 * commercial use; the video description credits the source anyway.
 */

export type StockProvider = "pixabay" | "pexels" | "ai";

export interface StockVideo {
  /** Project-relative path, e.g. "videos/03.mp4". */
  file: string;
  provider: StockProvider;
  /** Provider's own video id. */
  sourceId: number;
  page: string;
  author: string;
  query: string;
  duration: number;
  width: number;
  height: number;
}

interface Hit {
  provider: StockProvider;
  id: number;
  page: string;
  author: string;
  duration: number;
  file: { url: string; width: number; height: number };
}

export function stockProviders(): StockProvider[] {
  return [
    ...(getSetting("PIXABAY_API_KEY") ? ["pixabay" as const] : []),
    ...(getSetting("PEXELS_API_KEY") ? ["pexels" as const] : []),
  ];
}
export const stockConfigured = () => stockProviders().length > 0;

// Pixabay's terms: every API response is cached for 24 hours.
const CACHE_DIR = join(ROOT, "data", "stock-cache");
const CACHE_MS = 24 * 60 * 60 * 1000;

async function cached<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const file = join(CACHE_DIR, `${createHash("sha1").update(key).digest("hex")}.json`);
  try {
    const { at, data } = JSON.parse(await readFile(file, "utf8")) as { at: number; data: T };
    if (Date.now() - at < CACHE_MS) return data;
  } catch {
    /* miss */
  }
  const data = await fetcher();
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(file, JSON.stringify({ at: Date.now(), data }));
  return data;
}

/** Full HD at most: 4K is slow to download and decode for no visible gain at 1080p. */
const fits = (w: number, h: number) => w >= h && h >= 540 && w <= 1920;

interface PixabayFile { url: string; width: number; height: number; size: number }
interface PixabayHit {
  id: number;
  pageURL: string;
  user: string;
  duration: number;
  videos: { large: PixabayFile; medium: PixabayFile; small: PixabayFile };
}

async function searchPixabay(query: string): Promise<Hit[]> {
  const key = getSetting("PIXABAY_API_KEY");
  const data = await cached(`pixabay|${query}`, async () => {
    const res = await axios.get<{ hits: PixabayHit[] }>("https://pixabay.com/api/videos/", {
      params: { key, q: query.slice(0, 100), video_type: "film", safesearch: "true", per_page: 20 },
      timeout: 20000,
      validateStatus: () => true,
    });
    if (res.status === 400 && /key/i.test(String(res.data))) throw new Error("PIXABAY_API_KEY không hợp lệ");
    if (res.status === 429) throw new Error("Pixabay: vượt giới hạn 100 lượt/phút — thử lại sau ít phút");
    if (res.status !== 200) return { hits: [] };
    return res.data;
  });
  return (data.hits ?? []).flatMap((h) => {
    const file = [h.videos.large, h.videos.medium, h.videos.small].find((f) => f?.url && fits(f.width, f.height));
    return file && h.duration >= 4
      ? [{ provider: "pixabay" as const, id: h.id, page: h.pageURL, author: h.user, duration: h.duration, file }]
      : [];
  });
}

interface PexelsFile { link: string; width: number | null; height: number | null; file_type: string }
interface PexelsVideo { id: number; url: string; duration: number; user?: { name?: string }; video_files: PexelsFile[] }

async function searchPexels(query: string): Promise<Hit[]> {
  const key = getSetting("PEXELS_API_KEY");
  const data = await cached(`pexels|${query}`, async () => {
    const res = await axios.get<{ videos: PexelsVideo[] }>("https://api.pexels.com/videos/search", {
      params: { query, orientation: "landscape", size: "medium", per_page: 15 },
      headers: { Authorization: key },
      timeout: 20000,
      validateStatus: () => true,
    });
    if (res.status === 401 || res.status === 403) throw new Error("PEXELS_API_KEY không hợp lệ");
    if (res.status === 429) throw new Error("Pexels: hết lượt gọi API trong giờ này");
    if (res.status !== 200) return { videos: [] };
    return res.data;
  });
  return (data.videos ?? []).flatMap((v) => {
    const f = v.video_files
      .filter((x) => x.file_type === "video/mp4" && x.width && x.height && fits(x.width, x.height))
      .sort((a, b) => b.width! - a.width!)[0];
    return f && v.duration >= 4
      ? [{ provider: "pexels" as const, id: v.id, page: v.url, author: v.user?.name ?? "", duration: v.duration, file: { url: f.link, width: f.width!, height: f.height! } }]
      : [];
  });
}

/** Every configured source, Pixabay first. A failing source is skipped (its error rethrown only if all fail). */
export async function searchStock(query: string): Promise<Hit[]> {
  const out: Hit[] = [];
  let lastErr: unknown;
  for (const p of stockProviders()) {
    try {
      out.push(...(await (p === "pixabay" ? searchPixabay(query) : searchPexels(query))));
    } catch (e) {
      lastErr = e;
    }
  }
  if (!out.length && lastErr) throw lastErr;
  return out;
}

async function nextIndex(dir: string): Promise<number> {
  const files = existsSync(dir) ? await readdir(dir) : [];
  const nums = files.map((f) => parseInt(f, 10)).filter((n) => Number.isFinite(n));
  return nums.length ? Math.max(...nums) + 1 : 1;
}

export async function readVideos(projectDir: string): Promise<StockVideo[]> {
  try {
    const list = JSON.parse(await readFile(join(projectDir, "videos.json"), "utf8")) as StockVideo[];
    return list.filter((v) => existsSync(join(projectDir, v.file)));
  } catch {
    return [];
  }
}

export async function writeVideos(projectDir: string, list: StockVideo[]): Promise<void> {
  await writeFile(join(projectDir, "videos.json"), JSON.stringify(list, null, 2));
}

// Renames share one counter per project so two downloads never pick the same file name.
const nameLock = pLimit(1);

async function download(projectDir: string, h: Hit, query: string): Promise<StockVideo> {
  const dir = join(projectDir, "videos");
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.dl-${h.provider}-${h.id}.part`);
  const res = await axios.get(h.file.url, {
    responseType: "stream",
    timeout: 60000,
    maxContentLength: 200 * 1024 * 1024,
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" },
  });
  await pipeline(res.data, createWriteStream(tmp));
  const file = await nameLock(async () => {
    const name = `${String(await nextIndex(dir)).padStart(2, "0")}.mp4`;
    await rename(tmp, join(dir, name));
    return `videos/${name}`;
  });
  return { file, provider: h.provider, sourceId: h.id, page: h.page, author: h.author, query, duration: h.duration, width: h.file.width, height: h.file.height };
}

export interface VideoScene {
  id: string;
  voiceText: string;
  videoQuery?: string;
  visual?: string;
  inputs: Record<string, unknown>;
}

/**
 * Give every scene that asked for footage 1–2 clips matching its videoQuery,
 * never reusing a clip within the project. Scenes left without footage keep
 * visual=video but no videos — the photo search fills them afterwards.
 */
export async function fillSceneVideos(
  projectDir: string,
  scenes: VideoScene[],
  wordsPerSec: number,
  log: (line: string) => void,
): Promise<StockVideo[]> {
  const all = await readVideos(projectDir);
  if (!stockConfigured()) {
    log("Chưa có PIXABAY_API_KEY — bỏ qua video minh hoạ, dùng ảnh cho mọi cảnh");
    return all;
  }
  const used = new Set(all.map((v) => `${v.provider}:${v.sourceId}`));
  const want = scenes.filter((s) => s.visual === "video" && s.videoQuery?.trim() && !(s.inputs.videos as string[] | undefined)?.length);
  const limit = pLimit(3);
  let failed = 0;
  await Promise.all(
    want.map((s) =>
      limit(async () => {
        const sec = s.voiceText.split(/\s+/).length / wordsPerSec;
        const n = sec > 11 ? 2 : 1;
        try {
          const query = s.videoQuery!.trim();
          let hits = await searchStock(query);
          // Too specific: retry with the first two words.
          if (hits.filter((h) => !used.has(`${h.provider}:${h.id}`)).length < n && query.split(/\s+/).length > 2) {
            hits = [...hits, ...(await searchStock(query.split(/\s+/).slice(0, 2).join(" ")))];
          }
          const got: StockVideo[] = [];
          for (const h of hits) {
            if (got.length >= n) break;
            const key = `${h.provider}:${h.id}`;
            if (used.has(key)) continue;
            used.add(key);
            try {
              got.push(await download(projectDir, h, query));
            } catch {
              /* next hit */
            }
          }
          if (got.length) {
            s.inputs.videos = got.map((g) => g.file);
            all.push(...got);
          }
          log(`  ${s.id}: ${got.length ? `+${got.length} video "${query}"` : `không có video cho "${query}" → dùng ảnh`}`);
        } catch (e) {
          failed++;
          if (failed === 1) log(`  Lỗi tìm video: ${(e as Error).message}`);
        }
      }),
    ),
  );
  // Partial downloads left by an interrupted run.
  const dir = join(projectDir, "videos");
  if (existsSync(dir)) for (const f of await readdir(dir)) if (f.startsWith(".dl-")) await rm(join(dir, f), { force: true });
  await writeVideos(projectDir, all);
  return all;
}

import axios from "axios";
import pLimit from "p-limit";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fetchImageBytes, saveImage, type ProjectImage } from "./images.js";

export interface SearchHit {
  url: string;
  thumb: string;
  title: string;
  page: string;
}

// Stock libraries burn watermarks into previews; social CDNs expire or block hotlinks.
const BLOCKED = /alamy|shutterstock|gettyimages|istockphoto|dreamstime|depositphotos|123rf|adobestock|stock\.adobe|vectorstock|pinimg|fbcdn|lookaside|tiktokcdn|pngtree|freepik|vecteezy|canstockphoto|bigstockphoto/i;

const unescape = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

const fold = (t: string) =>
  t.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
// Words too common to prove a photo is about the story.
const STOP = new Set("cua va cac nhung voi cho trong duoc nguoi mot hai sau truoc tai tren duoi khi con nay kia the nao bao gian nam ngay thang the thi voi tu den ra vao lai rat qua moi doi tuyen bong da tran dau news photo image anh hinh".split(" "));

/** Distinctive tokens of a query (no diacritics, no stop words). */
function keyTokens(q: string): string[] {
  return [...new Set(fold(q).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)))];
}

/** A hit counts only if its title/page mentions enough of the query's key words. */
function relevant(h: SearchHit, tokens: string[]): boolean {
  if (!tokens.length) return true;
  const hay = fold(`${h.title} ${decodeURIComponent(h.page).replace(/[-_/.]+/g, " ")} ${decodeURIComponent(h.url).replace(/[-_/.]+/g, " ")}`);
  const hits = tokens.filter((t) => hay.includes(t)).length;
  return hits >= Math.max(1, Math.ceil(tokens.length * 0.4));
}

// Bing serves an empty page to concurrent requests from one client — one at a time.
const bingQueue = pLimit(1);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Web image search (Bing Images). Tries large photos first, then any size, then a
 * shorter query, until there are enough hits. Best effort: returns [] on failure.
 */
export async function searchImages(query: string, limit = 20, fallbackQuery?: string): Promise<SearchHit[]> {
  const words = query.trim().split(/\s+/);
  const attempts: [string, boolean][] = [[query, true], [query, false]];
  if (words.length > 3) attempts.push([words.slice(0, Math.ceil(words.length / 2) + 1).join(" "), false]);
  if (fallbackQuery && fallbackQuery !== query) attempts.push([fallbackQuery, false]);
  const out: SearchHit[] = [];
  const seen = new Set<string>();
  for (const [q, large] of attempts) {
    const tokens = keyTokens(q);
    const batch = await bingQueue(async () => { const r = await bingOnce(q, large); await pause(250); return r; });
    for (const h of batch.filter((x) => relevant(x, tokens))) {
      const key = h.url.replace(/[?#].*$/, "");
      if (!seen.has(key)) { seen.add(key); out.push(h); }
    }
    if (out.length >= Math.min(limit, 8)) break;
  }
  return out.slice(0, limit);
}

async function bingOnce(query: string, large: boolean): Promise<SearchHit[]> {
  const url = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2&first=1${large ? "&qft=+filterui:imagesize-large" : ""}`;
  let html: string;
  try {
    const res = await axios.get<string>(url, {
      responseType: "text",
      timeout: 15000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        "Accept-Language": "vi,en;q=0.8",
      },
    });
    html = String(res.data);
  } catch {
    return [];
  }
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/\sm="(\{[^"]*?murl[^"]*?\})"/g)) {
    try {
      const j = JSON.parse(unescape(m[1])) as { murl?: string; turl?: string; t?: string; purl?: string };
      if (!j.murl || !/^https?:/.test(j.murl) || BLOCKED.test(j.murl) || BLOCKED.test(j.purl ?? "")) continue;
      if (/\.(svg|gif)(\?|$)/i.test(j.murl)) continue;
      const key = j.murl.replace(/[?#].*$/, "");
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ url: j.murl, thumb: j.turl ?? j.murl, title: (j.t ?? "").replace(/<[^>]+>/g, ""), page: j.purl ?? "" });
    } catch {
      /* skip malformed entry */
    }
  }
  return hits;
}

/** md5 of the photos already in the project, so searches never add a duplicate. */
export async function knownHashes(projectDir: string, images: ProjectImage[]): Promise<Set<string>> {
  const set = new Set<string>();
  for (const im of images) {
    try {
      set.add(createHash("md5").update(await readFile(join(projectDir, im.file))).digest("hex"));
    } catch {
      /* missing file */
    }
  }
  return set;
}

/**
 * Download up to `want` usable photos for a query into the project. Tries hits in
 * order, skipping ones that fail, are too small, or duplicate what we already have.
 */
export async function fetchSearchImages(
  projectDir: string,
  query: string,
  want: number,
  hashes: Set<string>,
  usedUrls: Set<string>,
  fallbackQuery?: string,
): Promise<ProjectImage[]> {
  const hits = (await searchImages(query, 24, fallbackQuery)).filter((h) => !usedUrls.has(h.url));
  const out: ProjectImage[] = [];
  for (let i = 0; i < hits.length && out.length < want; i += 3) {
    const batch = hits.slice(i, i + 3);
    const bytes = await Promise.all(batch.map((h) => fetchImageBytes(h.url, h.page || undefined).catch(() => null)));
    for (const [k, b] of bytes.entries()) {
      if (!b || b.length < 20000 || out.length >= want) continue;
      const hash = createHash("md5").update(b).digest("hex");
      if (hashes.has(hash)) continue;
      const img = await saveImage(projectDir, b, { url: batch[k].url, caption: batch[k].title }, { minWidth: 640 });
      if (!img) continue;
      hashes.add(hash);
      usedUrls.add(batch[k].url);
      out.push(img);
    }
  }
  return out;
}

// ── Related news articles: same story, real photos with captions ───────────
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** VnExpress site search → article URLs, most relevant first. */
export async function searchVnExpress(query: string, max = 6): Promise<string[]> {
  try {
    const res = await axios.get<string>(`https://timkiem.vnexpress.net/?q=${encodeURIComponent(query)}`, {
      responseType: "text",
      timeout: 15000,
      headers: { "User-Agent": UA, "Accept-Language": "vi" },
    });
    const urls = [...String(res.data).matchAll(/data-url="(https:\/\/vnexpress\.net\/[^"]+?\.html)"/g)].map((m) => m[1]);
    return [...new Set(urls)].slice(0, max);
  } catch {
    return [];
  }
}

export interface PoolImage {
  url: string;
  caption: string;
  /** Article the photo came from (sent as Referer when downloading). */
  page: string;
  pageTitle: string;
}

/**
 * Photos from articles about the same story. Searches VnExpress for each query,
 * reads up to `maxArticles` articles and collects their photos + captions.
 */
export async function relatedArticleImages(queries: string[], exclude: string[], maxArticles = 8): Promise<PoolImage[]> {
  const { extractImages } = await import("./images.js");
  const skip = new Set(exclude.map((u) => u.replace(/[?#].*$/, "")));
  const urls: string[] = [];
  for (const q of [...new Set(queries.map((x) => x.trim()).filter(Boolean))].slice(0, 5)) {
    for (const u of await searchVnExpress(q, 4)) {
      if (!skip.has(u) && !urls.includes(u)) urls.push(u);
    }
    if (urls.length >= maxArticles) break;
  }
  const limit = pLimit(3);
  const pages = await Promise.all(
    urls.slice(0, maxArticles).map((u) =>
      limit(async () => {
        try {
          const res = await axios.get<string>(u, { responseType: "text", timeout: 15000, headers: { "User-Agent": UA } });
          const html = String(res.data);
          const title = html.match(/<title[^>]*>([^<]*)/i)?.[1]?.trim() ?? "";
          return extractImages(html, u).map((c) => ({ url: c.url, caption: c.caption, page: u, pageTitle: title }));
        } catch {
          return [];
        }
      }),
    ),
  );
  const seen = new Set<string>();
  return pages.flat().filter((p) => {
    const k = p.url.replace(/[?#].*$/, "");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** How well a photo's caption/article matches a scene (0 = no shared key words). */
export function matchScore(img: { caption: string; pageTitle?: string }, sceneText: string): number {
  const tokens = keyTokens(sceneText);
  const cap = fold(img.caption);
  const title = fold(img.pageTitle ?? "");
  return tokens.reduce((n, t) => n + (cap.includes(t) ? 2 : 0) + (title.includes(t) ? 1 : 0), 0);
}

/** Download one pool photo into the project (dedup by content hash). */
export async function savePoolImage(
  projectDir: string,
  img: PoolImage,
  hashes: Set<string>,
): Promise<ProjectImage | null> {
  const b = await fetchImageBytes(img.url, img.page).catch(() => null);
  if (!b || b.length < 15000) return null;
  const hash = createHash("md5").update(b).digest("hex");
  if (hashes.has(hash)) return null;
  const saved = await saveImage(projectDir, b, { url: img.url, caption: img.caption || img.pageTitle }, { minWidth: 560 });
  if (saved) hashes.add(hash);
  return saved;
}

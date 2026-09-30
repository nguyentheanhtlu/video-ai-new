import axios from "axios";
import { extractImages, type ImageCandidate } from "./images.js";

export interface Article {
  title: string;
  content: string;
  image: string | null;
  domain: string;
  url: string;
  /** Photos found in the page, best first (og:image, then in-article figures). */
  images: ImageCandidate[];
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);
}

const text = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

function meta(html: string, prop: string): string | null {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, "i");
  const tag = html.match(re)?.[0];
  const content = tag?.match(/content=["']([^"']*)["']/i)?.[1];
  return content ? decode(content).trim() : null;
}

/** Fetch a news article and pull out title / body text / og:image. */
export async function fetchArticle(url: string): Promise<Article> {
  const res = await axios.get<string>(url, {
    responseType: "text",
    timeout: 20000,
    maxRedirects: 5,
    validateStatus: () => true,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      "Accept-Language": "vi,en;q=0.8",
    },
  });
  if (res.status >= 400) {
    throw new Error(`Không tải được trang (HTTP ${res.status}). Kiểm tra lại link, hoặc copy nội dung bài và dán vào ô "Văn bản".`);
  }
  const images = extractImages(String(res.data), url);
  const html = String(res.data)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "");

  const title =
    meta(html, "og:title") ?? text(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "") ?? "";

  // Prefer <article>/<main>; fall back to every <p> on the page.
  const scope = html.match(/<article[\s\S]*<\/article>/i)?.[0] ?? html.match(/<main[\s\S]*<\/main>/i)?.[0] ?? html;
  const blocks = [...scope.matchAll(/<(p|h2|h3|li)[^>]*>([\s\S]*?)<\/\1>/gi)]
    .map((m) => text(m[2]))
    .filter((t) => t.length > 30);
  const content = [...new Set(blocks)].join("\n");

  if (content.length < 200) {
    throw new Error(
      "Không lấy được nội dung bài (trang cần JavaScript, paywall hoặc chặn bot). Hãy copy nội dung bài và dán vào ô \"Văn bản\".",
    );
  }
  let image = meta(html, "og:image");
  if (image) {
    try {
      image = new URL(image, url).href;
    } catch {
      image = null;
    }
  }
  return { title: title || new URL(url).hostname, content, image, domain: new URL(url).hostname, url, images };
}

/** Plain text / .txt input: first line is the title. */
export function articleFromText(raw: string): Article {
  const lines = raw.replace(/\r/g, "").split("\n");
  const firstIdx = lines.findIndex((l) => l.trim());
  const title = (lines[firstIdx] ?? "Bài viết").trim().slice(0, 80);
  const content = lines.slice(firstIdx + 1).join("\n").trim() || title;
  return { title, content, image: null, domain: "local", url: "", images: [] };
}

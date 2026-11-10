import axios from "axios";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pLimit from "p-limit";
import type { ProjectImage } from "./images.js";
import { getSetting } from "./settings.js";
import type { StockVideo } from "./stock-video.js";

/**
 * AI illustrations for long videos (Gemini API):
 *  - images: Nano Banana (`gemini-nano-banana-2.1`), one per prompt the script wrote for the scene;
 *  - every image is checked by a Gemini vision model against the scene's narration and
 *    regenerated (with the checker's better prompt) until it really shows what is said;
 *  - optional opening clip: the hook's image animated with Gemini Omni.
 * Real people and real events are never drawn — those scenes keep real photos.
 */

const API = "https://generativelanguage.googleapis.com/v1beta";
const API_REVISION = "2026-05-20";
const IMAGE_FALLBACKS = ["gemini-nano-banana-2.1", "gemini-3.1-flash-image", "gemini-3-pro-image"];
const JUDGE_MODELS = ["gemini-3.5-flash-lite", "gemini-2.5-flash-lite", "gemini-2.5-flash"];
/** Accept an image at this score (0–10) with no severe defect. */
const PASS_SCORE = 7;
const MAX_ATTEMPTS = 3;
/** Approximate list prices (USD), for the cost line in the log. */
const IMAGE_PRICE: Record<string, number> = { "1K": 0.034, "2K": 0.05 };
const VIDEO_PRICE_PER_SEC = 0.104;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const apiKey = () => {
  const k = getSetting("GEMINI_API_KEY");
  if (!k) throw new Error("Chưa nhập GEMINI_API_KEY trong Cài đặt (ảnh AI dùng Gemini API, cần bật thanh toán).");
  return k;
};

type Media = { type: string; data?: string; uri?: string; mime_type?: string };

/** First content block of the given type anywhere in an Interactions response. */
function findMedia(node: unknown, type: string): Media | undefined {
  if (!node || typeof node !== "object") return undefined;
  const o = node as Record<string, unknown>;
  if (o.type === type && (typeof o.data === "string" || typeof o.uri === "string")) return o as Media;
  for (const v of Object.values(o)) {
    const hit = Array.isArray(v) ? v.map((x) => findMedia(x, type)).find(Boolean) : findMedia(v, type);
    if (hit) return hit;
  }
  return undefined;
}

async function interact(body: Record<string, unknown>) {
  return axios.post(`${API}/interactions`, body, {
    headers: { "x-goog-api-key": apiKey(), "Content-Type": "application/json", "Api-Revision": API_REVISION },
    timeout: 300_000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: () => true,
  });
}

const errText = (data: unknown) => {
  const e = (data as { error?: { message?: string } })?.error?.message;
  return e ?? JSON.stringify(data).slice(0, 300);
};

/** Prompt → JPEG bytes. Retries busy errors; falls back to other image models / 1K when one is unavailable. */
export async function generateImage(prompt: string, size: "1K" | "2K"): Promise<{ bytes: Buffer; model: string }> {
  const models = [...new Set([getSetting("GEMINI_IMAGE_MODEL"), ...IMAGE_FALLBACKS].filter(Boolean))];
  let last = "";
  for (const model of models) {
    let imageSize = size;
    for (const delay of [0, 3000, 8000, 15000]) {
      if (delay) await sleep(delay);
      const res = await interact({
        model,
        input: [{ type: "text", text: prompt }],
        response_format: { type: "image", mime_type: "image/jpeg", aspect_ratio: "16:9", image_size: imageSize },
        store: false,
      });
      if (res.status === 200) {
        const img = findMedia(res.data, "image");
        if (img?.data) return { bytes: Buffer.from(img.data, "base64"), model };
        last = `${model}: không trả ảnh (có thể bị bộ lọc an toàn chặn)`;
        break; // same prompt would be blocked again — let the caller rewrite it
      }
      last = `${model} ${res.status}: ${errText(res.data)}`;
      if (res.status === 400 && /image_size|resolution/i.test(last) && imageSize !== "1K") {
        imageSize = "1K";
        continue;
      }
      // Google answers a wrong key with 400 API_KEY_INVALID, not 401.
      if (res.status === 401 || res.status === 403 || /API_KEY_INVALID|API key not valid/i.test(JSON.stringify(res.data))) throw new Error(`Gemini từ chối key (${last}). Kiểm tra GEMINI_API_KEY và đã bật thanh toán chưa.`);
      // Image models have no free quota ("limit: 0 … on Free Tier"): retrying or switching model can't help.
      if (res.status === 429 && /free.?tier|limit: 0/i.test(last)) {
        throw new Error("Key Gemini đang ở gói miễn phí — model vẽ ảnh không có hạn mức miễn phí. Bật thanh toán (billing) cho project của key tại aistudio.google.com rồi chạy lại.");
      }
      if (![429, 500, 502, 503, 504].includes(res.status)) break; // model unavailable → next model
    }
  }
  throw new Error(`Không tạo được ảnh AI: ${last}`);
}

export interface Verdict {
  score: number;
  severe: boolean;
  defects: string[];
  betterPrompt?: string;
}

/**
 * A vision model checks an image against what the scene says.
 * kind "ai": an illustration we generated (strict on text, anatomy, real people).
 * kind "photo": a real photo found in the article or on the web (strict on overlays and wrong events).
 */
export async function judgeImage(bytes: Buffer, narration: string, prompt: string, kind: "ai" | "photo" = "ai"): Promise<Verdict> {
  const instruction = (kind === "ai"
    ? [
        "You are a strict photo editor approving illustrations for a narrated YouTube video.",
        `Narration of this scene: "${narration}"`,
        `The image was requested as: "${prompt}"`,
        "Score 0-10 how well the image shows what the narration says (right subject, action, setting, era, mood; nothing that contradicts it). A beautiful but off-topic image scores below 5.",
        "List visible defects: any text, letters, numbers, logos or watermarks; deformed hands, faces or bodies; melted/duplicated objects; wrong count of key objects; a recognizable real public figure; wrong flags, uniforms or brands; obvious AI look.",
        "severe = true if the image is off-topic, contains text/logos, has deformed people, or shows a recognizable real person.",
        'If score < 7 or severe, write betterPrompt: an improved English image prompt that fixes the problems (concrete subject, action, setting, camera, lighting; say "no text").',
      ]
    : [
        "You are a strict photo editor choosing real photos for a narrated news video on YouTube.",
        `Narration of this scene: "${narration}"`,
        prompt ? `What we know about the photo (caption / search): "${prompt}"` : "",
        "Score 0-10 how well this photo fits what the narration says: the right people, team or event, the right kind of moment. A photo of the right person at a clearly different club, match, year or occasion than the narration scores at most 4. A generic but plausible photo of the right team / place scores 6-7.",
        "severe = true if ANY of: large headline text, captions or graphics added on top of the photo; a YouTube/TikTok thumbnail or a meme; a collage or split screen; another channel's or agency's logo or watermark that is clearly visible; a screenshot of a website or TV broadcast with overlays; very blurry or tiny; clearly a different event or team than the narration.",
        "Small natural text that belongs to the scene (shirt numbers, sponsor on a kit, stadium ads) is fine.",
      ]).filter(Boolean).concat('Return JSON only: {"score": number, "severe": boolean, "defects": string[], "betterPrompt": string}').join("\n");
  let last = "";
  for (const model of JUDGE_MODELS) {
    const res = await axios.post(
      `${API}/models/${model}:generateContent`,
      {
        contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/jpeg", data: bytes.toString("base64") } }, { text: instruction }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0 },
      },
      { headers: { "x-goog-api-key": apiKey() }, timeout: 120_000, validateStatus: () => true },
    );
    if (res.status === 200) {
      const text = (res.data?.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
      try {
        const v = JSON.parse(text.replace(/^```(?:json)?|```$/g, "").trim());
        return { score: Number(v.score) || 0, severe: !!v.severe, defects: Array.isArray(v.defects) ? v.defects.map(String) : [], betterPrompt: v.betterPrompt || undefined };
      } catch {
        last = `${model}: JSON lỗi`;
        continue;
      }
    }
    last = `${model} ${res.status}: ${errText(res.data)}`;
  }
  // The check itself failing must not block the video: accept, but say so.
  return { score: PASS_SCORE, severe: false, defects: [`không chấm được (${last.slice(0, 120)})`] };
}

/** House rules appended to every image prompt. */
export function fullPrompt(prompt: string, style: string, narration: string): string {
  return [
    prompt.trim().replace(/\.?$/, "."),
    style ? `Visual style: ${style}.` : "",
    `This image illustrates the narration: "${narration.slice(0, 400)}"`,
    "Wide 16:9 landscape composition with a clear main subject.",
    "Absolutely no text, letters, captions, signs with writing, logos or watermarks. No recognizable real celebrities or politicians — people, if any, are anonymous.",
  ].filter(Boolean).join(" ");
}

function probe(file: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const p = spawn("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], { windowsHide: true });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => {
      const [w, h] = out.trim().split(",").map(Number);
      resolve({ width: w || 0, height: h || 0 });
    });
    p.on("error", () => resolve({ width: 0, height: 0 }));
  });
}

export interface AiScene {
  id: string;
  voiceText: string;
  visual?: string;
  imagePrompts?: string[];
  inputs: Record<string, unknown>;
}

export interface AiImageResult {
  images: ProjectImage[];
  generated: number;
  costUsd: number;
}

/**
 * Draw the AI images every scene asked for (visual = "ai", or any scene still
 * without a picture when `fillEmpty`), each checked against the narration.
 */
export async function fillAiImages(
  projectDir: string,
  scenes: AiScene[],
  ctx: { style: string; size: "1K" | "2K" },
  log: (line: string) => void,
  opts: { fillEmpty?: boolean; replace?: boolean } = {},
): Promise<AiImageResult> {
  const dir = join(projectDir, "images");
  await mkdir(dir, { recursive: true });
  const hasPicture = (s: AiScene) =>
    !!s.inputs.image || (Array.isArray(s.inputs.images) && s.inputs.images.length > 0) || (Array.isArray(s.inputs.videos) && s.inputs.videos.length > 0);
  const todo = scenes.filter((s) => opts.replace || (s.visual === "ai" && !hasPicture(s)) || (opts.fillEmpty && !hasPicture(s)));
  const limit = pLimit(4);
  const out: ProjectImage[] = [];
  let generated = 0;
  let failed = 0;
  // A key / billing error hits every scene alike: the first one stops the batch.
  let fatal: Error | undefined;
  await Promise.all(
    todo.map((s) =>
      limit(async () => {
        if (fatal) return;
        const prompts = (s.imagePrompts?.length ? s.imagePrompts : [`A realistic scene showing: ${s.voiceText}`]).slice(0, 3);
        const files: string[] = [];
        for (const [k, base] of prompts.entries()) {
          let prompt = base;
          let best: { bytes: Buffer; verdict: Verdict; model: string; prompt: string } | undefined;
          for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            let img: { bytes: Buffer; model: string };
            try {
              img = await generateImage(fullPrompt(prompt, ctx.style, s.voiceText), ctx.size);
            } catch (e) {
              if (/từ chối key|gói miễn phí/.test((e as Error).message)) {
                fatal ??= e as Error;
                return;
              }
              log(`  ${s.id}: ${(e as Error).message}`);
              break;
            }
            generated++;
            const verdict = await judgeImage(img.bytes, s.voiceText, prompt);
            if (!best || (!verdict.severe && (best.verdict.severe || verdict.score > best.verdict.score))) best = { ...img, verdict, prompt };
            if (verdict.score >= PASS_SCORE && !verdict.severe) break;
            log(`  ${s.id} ảnh ${k + 1}: ${verdict.score}/10${verdict.defects.length ? ` (${verdict.defects.slice(0, 2).join("; ")})` : ""} → tạo lại`);
            if (verdict.betterPrompt) prompt = verdict.betterPrompt;
          }
          if (!best || best.verdict.severe) {
            failed++;
            if (best) log(`  ${s.id} ảnh ${k + 1}: không đạt sau ${MAX_ATTEMPTS} lần — bỏ, cảnh dùng ảnh khác`);
            continue;
          }
          const name = `images/ai-${s.id}-${k + 1}-${Date.now().toString(36)}.jpg`;
          await writeFile(join(projectDir, name), best.bytes);
          const dim = await probe(join(projectDir, name));
          out.push({ file: name, width: dim.width, height: dim.height, caption: best.prompt.slice(0, 300), url: `ai:${best.model}` });
          files.push(name);
          log(`  ${s.id} ảnh ${k + 1}: ✓ ${best.verdict.score}/10`);
        }
        if (files.length) {
          const keep = opts.replace ? [] : ((s.inputs.images as string[] | undefined) ?? []);
          s.inputs = { ...s.inputs, images: [...keep, ...files] };
          delete s.inputs.image;
        }
      }),
    ),
  );
  if (fatal) throw fatal;
  const costUsd = generated * (IMAGE_PRICE[ctx.size] ?? 0.05);
  log(`Ảnh AI: ${out.length} ảnh đạt (${generated} lần tạo${failed ? `, ${failed} ảnh bỏ` : ""}) ≈ ${costUsd.toFixed(2)} USD`);
  return { images: out, generated, costUsd };
}

/** Real photos below this score are dropped (generic-but-right photos score 6–7). */
const PHOTO_PASS = 6;

/**
 * Check every real photo a scene uses against its narration and drop the ones
 * that don't fit or carry overlays (thumbnails, headlines, other channels'
 * logos). AI images were already checked when drawn. Returns how many were dropped.
 */
export async function vetPhotos(
  projectDir: string,
  scenes: AiScene[],
  images: ProjectImage[],
  log: (line: string) => void,
): Promise<{ checked: number; dropped: number }> {
  const meta = new Map(images.map((im) => [im.file, im]));
  const { readFile } = await import("node:fs/promises");
  const limit = pLimit(4);
  let checked = 0;
  let dropped = 0;
  await Promise.all(
    scenes.map((s) =>
      limit(async () => {
        const list = [...new Set([...(s.inputs.image ? [s.inputs.image as string] : []), ...((s.inputs.images as string[] | undefined) ?? [])])];
        const keep: string[] = [];
        for (const f of list) {
          const im = meta.get(f);
          if (im?.url.startsWith("ai:") || !existsSync(join(projectDir, f))) {
            if (existsSync(join(projectDir, f))) keep.push(f);
            continue;
          }
          checked++;
          const v = await judgeImage(await readFile(join(projectDir, f)), s.voiceText, im?.caption ?? "", "photo");
          if (v.severe || v.score < PHOTO_PASS) {
            dropped++;
            log(`  ${s.id}: loại ${f} (${v.score}/10${v.defects.length ? ` — ${v.defects.slice(0, 2).join("; ")}` : ""})`);
          } else keep.push(f);
        }
        if (keep.length !== list.length) {
          const inputs = { ...s.inputs };
          delete inputs.image;
          if (keep.length) inputs.images = keep;
          else delete inputs.images;
          s.inputs = inputs;
        }
      }),
    ),
  );
  log(`Kiểm tra ảnh thật: ${checked} ảnh, loại ${dropped} ảnh không khớp lời đọc / có chữ, logo đè`);
  return { checked, dropped };
}

/** Animate the hook's first image into a short opening clip (Gemini Omni). Best effort: returns undefined on failure. */
export async function aiHookClip(
  projectDir: string,
  hook: AiScene,
  seconds: number,
  log: (line: string) => void,
): Promise<StockVideo | undefined> {
  const images = (hook.inputs.images as string[] | undefined) ?? (hook.inputs.image ? [hook.inputs.image as string] : []);
  const first = images.find((f) => existsSync(join(projectDir, f)));
  if (!first) return undefined;
  const { readFile } = await import("node:fs/promises");
  const dur = Math.max(4, Math.min(10, Math.round(seconds)));
  const model = getSetting("GEMINI_VIDEO_MODEL");
  log(`Tạo clip mở đầu ${dur}s từ ảnh hook (${model})…`);
  try {
    const res = await interact({
      model,
      input: [
        { type: "image", mime_type: "image/jpeg", data: (await readFile(join(projectDir, first))).toString("base64") },
        { type: "text", text: "Animate this exact image as a cinematic shot: slow camera push-in with subtle natural motion. Keep every person, object and the composition as in the image. Do not add new objects, text, logos or captions. No sound." },
      ],
      response_format: { type: "video", aspect_ratio: "16:9", resolution: "1080p", duration: `${dur}s`, delivery: "uri" },
      store: false,
    });
    if (res.status !== 200) throw new Error(`${res.status}: ${errText(res.data)}`);
    const media = findMedia(res.data, "video");
    let bytes: Buffer;
    if (media?.data) bytes = Buffer.from(media.data, "base64");
    else if (media?.uri) bytes = await downloadFile(media.uri);
    else throw new Error("không có video trong phản hồi");
    await mkdir(join(projectDir, "videos"), { recursive: true });
    const file = `videos/ai-hook-${Date.now().toString(36)}.mp4`;
    await writeFile(join(projectDir, file), bytes);
    log(`✓ Clip mở đầu ≈ ${(dur * VIDEO_PRICE_PER_SEC).toFixed(2)} USD`);
    return { file, provider: "ai", sourceId: 0, page: "", author: model, query: "hook", duration: dur, width: 1920, height: 1080 };
  } catch (e) {
    log(`Không tạo được clip mở đầu (${(e as Error).message.slice(0, 200)}) — dùng ảnh`);
    return undefined;
  }
}

/** Files API: wait until the generated video is ready, then download it. */
async function downloadFile(uri: string): Promise<Buffer> {
  const headers = { "x-goog-api-key": apiKey() };
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const meta = await axios.get(uri, { headers, validateStatus: () => true, timeout: 30_000 });
    const state = meta.data?.state ?? meta.data?.file?.state;
    if (meta.status === 200 && (!state || state === "ACTIVE")) break;
    if (state === "FAILED") throw new Error("Files API: xử lý video lỗi");
    await sleep(3000);
  }
  for (const url of [`${uri}:download?alt=media`, `${uri}?alt=media`]) {
    const res = await axios.get<ArrayBuffer>(url, { headers, responseType: "arraybuffer", validateStatus: () => true, timeout: 120_000, maxContentLength: Infinity });
    if (res.status === 200 && res.data.byteLength > 1000) return Buffer.from(res.data);
  }
  throw new Error("không tải được video từ Files API");
}

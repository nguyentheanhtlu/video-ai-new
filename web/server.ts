import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import express, { type NextFunction, type Request, type Response } from "express";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDurationSec } from "../src/assets/audio-tools.js";
import { genmaxCatalog, genmaxFromEnv, GENMAX_PROVIDERS, type GenmaxProvider } from "../src/tts/genmax.js";
import { defaultPlayback, indexSfxLibrary, pickSfxForScene } from "../src/assets/sfx-selector.js";
import { planParallelism, planRender } from "../src/utils/machine.js";
import { listEdgeVoices, startTtsServer, synthesize } from "../scripts/tts-server.js";
import { articleFromText, fetchArticle, type Article } from "./lib/article.js";
import { activeJobFor, bus, cancelJob, enqueue, getJob, listJobs, pump, type JobContext } from "./lib/jobs.js";
import { geminiModels, generateScript, scriptFromText, type GenerateOptions } from "./lib/llm.js";
import { loadReference, ytDlpInstalled } from "./lib/reference.js";
import { createTemplate, deleteGeneratedTemplate, entrySize, refineTemplate } from "./lib/template-gen.js";
import {
  ensureFfmpegOnPath,
  HttpError,
  OUTPUT_DIR,
  PREVIEW_DIR,
  projectDir,
  ROOT,
  SFX_DIR,
  SFX_RAW_DIR,
} from "./lib/paths.js";
import {
  allocateProject,
  clearCache,
  createProject,
  todayVN,
  deleteProject,
  listProjects,
  makeThumb,
  readProject,
  readScript,
  saveScript,
  validateScript,
  writeMeta,
  type Script,
} from "./lib/projects.js";
import { getSetting, publicSettings, updateSettings } from "./lib/settings.js";
import { relatedArticleImages, searchImages } from "./lib/image-search.js";
import { fillSceneImages } from "./lib/scene-images.js";
import { downloadArticleImages, extractImages, fetchImageBytes, readImages, saveImage, writeImages, type ProjectImage } from "./lib/images.js";
import { getTemplate, listTemplates } from "./lib/templates.js";

const PORT = Number(process.env.WEB_PORT ?? 3210);
const TTS_ENDPOINT = new URL(process.env.OMNIVOICE_ENDPOINT ?? "http://127.0.0.1:8123");
const voiceSettings = () => ({ voice: getSetting("EDGE_VOICE"), rate: getSetting("EDGE_RATE"), genmax: genmaxFromEnv() });

const ffmpegDir = ensureFfmpegOnPath();
let ttsMode: "embedded" | "external" | "down" = "down";

const app = express();
app.use(express.json({ limit: "5mb" }));

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) =>
  Promise.resolve(fn(req, res))
    .then((body) => {
      if (body !== undefined && !res.headersSent) res.json(body);
    })
    .catch(next);

const param = (req: Request, name: string) => String(req.params[name]);

// ── System status ──────────────────────────────────────────────────────────
function which(cmd: string): boolean {
  return spawnSync(cmd, ["-version"], { windowsHide: true }).status === 0;
}

function findChrome(): string | null {
  const candidates = [
    process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe"),
    process.env["PROGRAMFILES(X86)"] && join(process.env["PROGRAMFILES(X86)"]!, "Google/Chrome/Application/chrome.exe"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
    process.env["PROGRAMFILES(X86)"] && join(process.env["PROGRAMFILES(X86)"]!, "Microsoft/Edge/Application/msedge.exe"),
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean) as string[];
  return candidates.find((p) => existsSync(p)) ?? null;
}

function sfxCount(): number {
  const idx = indexSfxLibrary(SFX_DIR);
  return Object.values(idx).reduce((n, f) => n + f.length, 0);
}

app.get("/api/status", h(async () => {
  let ttsOk = false;
  try {
    const r = await fetch(`${TTS_ENDPOINT.origin}/`, { signal: AbortSignal.timeout(2000) });
    ttsOk = r.ok;
  } catch {
    /* down */
  }
  const provider = getSetting("LLM_PROVIDER");
  const llmKey = provider === "claude" ? !!process.env.ANTHROPIC_API_KEY : !!process.env.GEMINI_API_KEY;
  return {
    node: process.version,
    ffmpeg: which("ffmpeg"),
    ffprobe: which("ffprobe"),
    ffmpegDir,
    ytDlp: ytDlpInstalled(),
    chrome: findChrome(),
    tts: { ok: ttsOk, mode: ttsOk ? ttsMode : "down", endpoint: TTS_ENDPOINT.origin },
    sfx: sfxCount(),
    sfxRaw: existsSync(SFX_RAW_DIR),
    llm: { provider, configured: llmKey, model: getSetting(provider === "claude" ? "CLAUDE_MODEL" : "GEMINI_MODEL") },
    parallel: parallelPlan(),
  };
}));

/** What each rendering video actually gets: the server hands every pipeline `perJob` of the budget. */
function parallelPlan() {
  const plan = planParallelism();
  return planRender({ ...process.env, RENDER_BUDGET: String(plan.perJob) });
}

// ── Settings & voices ──────────────────────────────────────────────────────
app.get("/api/settings", h(() => publicSettings()));
app.put("/api/settings", h((req) => {
  updateSettings(req.body ?? {});
  pump(); // a raised job limit applies to what's already queued
  return publicSettings();
}));

app.get("/api/gemini/models", h(() => geminiModels()));

let voicesCache: unknown[] | null = null;
app.get("/api/voices", h(async () => {
  if (!voicesCache) {
    const all = await listEdgeVoices();
    voicesCache = all
      .filter((v) => v.Locale === "vi-VN" || /Multilingual/.test(v.ShortName))
      .map((v) => ({ id: v.ShortName, gender: v.Gender, locale: v.Locale, name: v.FriendlyName }))
      .sort((a, b) => Number(b.locale === "vi-VN") - Number(a.locale === "vi-VN") || a.id.localeCompare(b.id));
  }
  return voicesCache;
}));

const genmaxCache = new Map<GenmaxProvider, Awaited<ReturnType<typeof genmaxCatalog>>>();
app.get("/api/genmax/catalog", h(async (req) => {
  const provider = String(req.query.provider) as GenmaxProvider;
  if (!GENMAX_PROVIDERS.includes(provider)) throw new HttpError(400, `Provider không hợp lệ: ${provider}`);
  if (!genmaxCache.has(provider)) genmaxCache.set(provider, await genmaxCatalog(provider));
  return genmaxCache.get(provider);
}));

app.post("/api/tts/preview", h(async (req, res) => {
  const text = String(req.body?.text ?? "").trim();
  if (!text) throw new HttpError(400, "Thiếu text");
  const s = voiceSettings();
  const audio = await synthesize(text.slice(0, 1000), {
    voice: req.body?.voice || s.voice,
    rate: req.body?.rate || s.rate,
    genmax: req.body?.genmax === undefined ? s.genmax : req.body.genmax ?? undefined,
  });
  res.type("audio/mpeg").send(audio);
}));

// ── Templates ──────────────────────────────────────────────────────────────
app.get("/api/templates", h(() =>
  listTemplates().map((t) => ({
    ...t,
    previews: Object.fromEntries(
      t.aspects.map((a) => {
        const f = `${t.id}-${a.replace(":", "x")}.mp4`;
        return [a, existsSync(join(PREVIEW_DIR, f)) ? `/files/.previews/${f}` : null];
      }),
    ),
  })),
));

interface RenderSpec {
  templateId: string;
  inputs: Record<string, unknown>;
  aspect: string;
  outputPath: string;
  baseDir?: string;
  meta?: Script["metadata"];
  durationSec?: number;
  extraVars?: Record<string, unknown>;
}

async function renderTemplateJob(ctx: JobContext, spec: RenderSpec) {
  const specFile = join(tmpdir(), `hf-spec-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(specFile, JSON.stringify(spec));
  await ctx.runTs(["web/tasks/render-template.ts", specFile]);
}

const SAMPLES = {
  vi: {
    title: "Đây là tiêu đề mẫu của bản tin: *từ khoá nổi bật* hiện bằng màu nhấn của kênh",
    voice: "Đây là phụ đề mẫu chạy theo lời đọc của video để xem thử kiểu chữ và vị trí trên khung hình.",
    outro: (channel: string) => `Theo dõi *${channel}* để cập nhật tin nóng mỗi ngày`,
  },
  en: {
    title: "This is a sample news headline: *key phrase* shown in the channel's accent colour",
    voice: "This is a sample subtitle that follows the narration to preview the type and its position on screen.",
    outro: (channel: string) => `Follow *${channel}* for the latest news every day`,
  },
};
const samples = () => SAMPLES[getSetting("SCRIPT_LANGUAGE") === "vi" ? "vi" : "en"];

/** Newest project that has downloaded photos — used as sample images for previews. */
function sampleImageDir(): string | undefined {
  if (!existsSync(OUTPUT_DIR)) return undefined;
  const dirs = readdirSync(OUTPUT_DIR)
    .filter((d) => !d.startsWith(".") && existsSync(join(OUTPUT_DIR, d, "images", "01.jpg")))
    .sort((a, b) => statSync(join(OUTPUT_DIR, b)).mtimeMs - statSync(join(OUTPUT_DIR, a)).mtimeMs);
  return dirs[0] ? join(OUTPUT_DIR, dirs[0]) : undefined;
}

function previewSpec(templateId: string, aspect: string, outputPath: string): RenderSpec {
  const dir = sampleImageDir();
  const imgs = dir
    ? readdirSync(join(dir, "images")).filter((f) => f.endsWith(".jpg")).slice(0, 2).map((f) => `images/${f}`)
    : [];
  const outro = templateId === "news-outro";
  return {
    templateId,
    inputs: outro ? { image: imgs[0] } : { images: imgs },
    aspect,
    outputPath,
    baseDir: dir,
    meta: { title: samples().title, source: { url: "", domain: "local", image: null }, channel: getSetting("CHANNEL_NAME") },
    durationSec: 5,
    extraVars: {
      __title: outro ? samples().outro(getSetting("CHANNEL_NAME")) : samples().title,
      __voice: samples().voice,
      __speech: 5,
      __type: outro ? "outro" : "hook",
      __intro: true,
    },
  };
}

// Samples come from anyone's upload or link, so they stay in the temp folder.
const UPLOAD_DIR = join(tmpdir(), "video-ai-reference");
const UPLOAD_ID = /^[0-9a-f-]{36}$/;

app.post("/api/templates/reference-upload", express.raw({ type: "application/octet-stream", limit: "300mb" }), h(async (req) => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new HttpError(400, "Chưa có file video");
  await mkdir(UPLOAD_DIR, { recursive: true });
  const uploadId = randomUUID();
  await writeFile(join(UPLOAD_DIR, uploadId), req.body);
  return { uploadId };
}));

app.post("/api/templates/from-reference", h(async (req) => {
  const url = String(req.body?.url ?? "").trim();
  const uploadId = String(req.body?.uploadId ?? "");
  if (url && !/^https?:\/\//.test(url)) throw new HttpError(400, "Link phải bắt đầu bằng http:// hoặc https://");
  if (!url && !UPLOAD_ID.test(uploadId)) throw new HttpError(400, "Nhập link hoặc tải file video mẫu lên");
  const file = url ? undefined : join(UPLOAD_DIR, uploadId);
  if (file && !existsSync(file)) throw new HttpError(400, "File video mẫu không còn trên máy, hãy tải lên lại");

  const job = enqueue("reference-template", `Tạo template từ ${url || "file video mẫu"}`, async (ctx) => {
    try {
      ctx.progress(1, 4, "Phân tích video mẫu");
      const reference = await loadReference({ url, file, name: String(req.body?.name ?? "") }, ctx.signal, ctx.log);
      ctx.progress(2, 4, "AI dựng template");
      const { id, design, turns } = await createTemplate(reference, ctx.log);
      try {
        ctx.progress(3, 4, "Render thử template");
        const aspect = entrySize(reference).aspect;
        await mkdir(PREVIEW_DIR, { recursive: true });
        const outputPath = join(PREVIEW_DIR, `${id}-${aspect.replace(":", "x")}.mp4`);
        const still = join(tmpdir(), `${id}.jpg`);
        const renderPreview = async () => {
          await renderTemplateJob(ctx, previewSpec(id, aspect, outputPath));
          spawnSync("ffmpeg", ["-y", "-v", "error", "-ss", "3", "-i", outputPath, "-frames:v", "1", "-q:v", "4", still], { windowsHide: true });
        };
        await renderPreview();
        ctx.progress(4, 4, "AI tinh chỉnh theo bản render");
        await refineTemplate(id, design, turns, reference, (await readFile(still)).toString("base64"), ctx.log);
        await renderPreview();
        await rm(still, { force: true });
      } catch (e) {
        await deleteGeneratedTemplate(id);
        throw e;
      }
      return { templateId: id };
    } finally {
      if (file) await rm(file, { force: true });
    }
  });
  return { jobId: job.id };
}));

app.delete("/api/templates/:id", h(async (req) => {
  const tpl = getTemplate(param(req, "id"));
  if (!tpl) throw new HttpError(404, "Không có template này");
  if (!tpl.generated) throw new HttpError(400, "Chỉ xoá được template tạo từ video mẫu");
  await deleteGeneratedTemplate(tpl.id);
  return { ok: true };
}));

app.post("/api/templates/:id/preview", h(async (req) => {
  const tpl = getTemplate(param(req, "id"));
  if (!tpl) throw new HttpError(404, "Không có template này");
  const aspect = req.body?.aspect === "16:9" ? "16:9" : "9:16";
  if (!tpl.aspects.includes(aspect)) throw new HttpError(400, `Template này chỉ có khung ${tpl.aspects.join(", ")}`);
  await mkdir(PREVIEW_DIR, { recursive: true });
  const outputPath = join(PREVIEW_DIR, `${tpl.id}-${aspect.replace(":", "x")}.mp4`);
  const job = enqueue("preview-template", `Xem trước ${tpl.id} (${aspect})`, (ctx) =>
    renderTemplateJob(ctx, previewSpec(tpl.id, aspect, outputPath)),
  undefined, outputPath);
  return { jobId: job.id };
}));

/** Brand kit preview: one news-frame clip + a still, so the settings page shows the real look. */
app.post("/api/brand/preview", h(async () => {
  await mkdir(PREVIEW_DIR, { recursive: true });
  const outputPath = join(PREVIEW_DIR, "brand-9x16.mp4");
  const job = enqueue("preview-template", "Xem trước bộ nhận diện kênh", async (ctx) => {
    await renderTemplateJob(ctx, previewSpec("news-frame", "9:16", outputPath));
    spawnSync("ffmpeg", ["-y", "-v", "error", "-ss", "2.4", "-i", outputPath, "-frames:v", "1", "-q:v", "3", join(PREVIEW_DIR, "brand-9x16.jpg")], { windowsHide: true });
    return { image: "/files/.previews/brand-9x16.jpg", video: "/files/.previews/brand-9x16.mp4" };
  }, undefined, outputPath);
  return { jobId: job.id };
}));

/** Upload the channel logo (data URL) → assets/brand/logo.<ext>, and point BRAND_LOGO at it. */
app.post("/api/brand/logo", h(async (req) => {
  const m = String(req.body?.dataUrl ?? "").match(/^data:image\/(png|jpe?g|webp|svg\+xml);base64,(.+)$/);
  if (!m) throw new HttpError(400, "Chỉ nhận ảnh PNG, JPG, WEBP hoặc SVG");
  const ext = m[1] === "svg+xml" ? "svg" : m[1] === "jpeg" ? "jpg" : m[1];
  const dir = join(ROOT, "assets", "brand");
  await mkdir(dir, { recursive: true });
  const rel = `assets/brand/logo.${ext}`;
  await writeFile(join(ROOT, rel), Buffer.from(m[2], "base64"));
  updateSettings({ BRAND_LOGO: rel });
  return publicSettings();
}));

app.get("/api/brand/logo", (_req, res) => {
  const p = join(ROOT, getSetting("BRAND_LOGO"));
  if (!existsSync(p)) return res.status(404).end();
  res.sendFile(p);
});

// ── Projects ───────────────────────────────────────────────────────────────
app.get("/api/projects", h(() => listProjects()));

function blankScript(title: string, aspect: Script["aspect"]): Script {
  const channel = getSetting("CHANNEL_NAME");
  return {
    version: "1.0",
    renderer: "hyperframes",
    aspect,
    metadata: { title, source: { url: "", domain: "local", image: null }, channel, date: todayVN() },
    voice: { provider: "omnivoice", speed: 1.0 },
    scenes: [
      { id: "hook", type: "hook", voiceText: `${title.replace(/\*/g, "")}.`, templateId: "news-frame", inputs: {} },
      { id: "body-1", type: "body", voiceText: "Nội dung chính của bản tin ở đây.", templateId: "news-frame", inputs: {} },
      { id: "outro", type: "outro", voiceText: `Theo dõi ${channel} để cập nhật tin tức nóng hổi mỗi ngày.`, templateId: "news-outro", inputs: {} },
    ],
  };
}

app.post("/api/projects", h(async (req) => {
  const body = req.body ?? {};
  const mode = String(body.mode);
  const aspect: "9:16" | "16:9" = body.aspect === "16:9" ? "16:9" : "9:16";

  if (mode === "blank") {
    const slug = await createProject(blankScript(String(body.title || "Video mới"), aspect), { sourceKind: "blank" });
    return { slug };
  }
  if (mode === "import") {
    const script = body.script as Script;
    if (!script || typeof script !== "object" || !Array.isArray(script.scenes)) throw new HttpError(400, "File script.json không hợp lệ");
    script.metadata ??= { title: "Import", source: { url: "", domain: "local", image: null }, channel: getSetting("CHANNEL_NAME") };
    const slug = await createProject(script, { sourceKind: "import" });
    return { slug };
  }
  if (mode !== "url" && mode !== "text") throw new HttpError(400, "mode phải là url | text | blank | import");

  const template = body.templateId ? getTemplate(String(body.templateId)) : undefined;
  if (body.templateId && !template) throw new HttpError(400, `Không có template "${body.templateId}"`);
  const opts: GenerateOptions = {
    length: body.length === "short" || body.length === "sample" ? body.length : "standard",
    // A generated template only exists in the sample video's shape.
    aspect: template ? (template.aspects[0] as typeof aspect) : aspect,
    channel: String(body.channel || getSetting("CHANNEL_NAME")),
    channelUrl: String(body.channelUrl || getSetting("CHANNEL_URL")),
    extraInstructions: body.extraInstructions ? String(body.extraInstructions) : undefined,
    templateId: template?.id,
  };
  const label = mode === "url" ? String(body.url) : String(body.text ?? "").split("\n")[0].slice(0, 60);
  const job = enqueue("generate", `Viết kịch bản: ${label}`, async (ctx) => {
    if (mode === "text" && body.keepScript) {
      const text = String(body.text ?? "");
      ctx.progress(1, 2, "Chia cảnh theo kịch bản của bạn");
      const script = await scriptFromText(text, opts, ctx.log);
      const slug = await allocateProject(script.metadata.title);
      ctx.progress(2, 2, "Tìm ảnh cho từng cảnh");
      try {
        await writeImages(projectDir(slug), await fillSceneImages(projectDir(slug), script, [], ctx.log));
      } catch (e) {
        ctx.log(`Không tìm được ảnh (${(e as Error).message})`);
      }
      await createProject(script, { slug, sourceKind: mode, sourceText: text });
      ctx.log(`✓ Đã tạo dự án ${slug}`);
      if (body.autoRender) enqueuePipeline(slug);
      return { slug };
    }
    let article: Article;
    if (mode === "url") {
      ctx.progress(1, 4, "Tải bài báo");
      ctx.log(`Tải ${body.url} ...`);
      article = await fetchArticle(String(body.url));
    } else {
      article = articleFromText(String(body.text ?? ""));
    }
    ctx.log(`Bài: "${article.title}" — ${article.content.length} ký tự, ${article.images.length} ảnh`);
    const slug = await allocateProject(article.title);
    let images: ProjectImage[] = [];
    if (article.images.length) {
      ctx.progress(2, 4, "Tải ảnh bài báo");
      images = await downloadArticleImages(projectDir(slug), article.images, article.url, ctx.log);
      await writeImages(projectDir(slug), images);
    }
    ctx.progress(3, 4, "AI viết kịch bản");
    let script: Script;
    try {
      script = await generateScript(article, opts, ctx.log, images);
    } catch (e) {
      await deleteProject(slug);
      throw e;
    }
    ctx.progress(4, 4, "Tìm thêm ảnh cho từng scene");
    try {
      images = await fillSceneImages(projectDir(slug), script, images, ctx.log);
      await writeImages(projectDir(slug), images);
    } catch (e) {
      ctx.log(`Không tìm thêm được ảnh (${(e as Error).message}) — dùng ảnh của bài`);
    }
    await createProject(script, {
      slug,
      sourceKind: mode,
      sourceText: `${article.title}\n${article.url}\n\n${article.content}`,
    });
    ctx.log(`✓ Đã tạo dự án ${slug}`);
    if (body.autoRender) enqueuePipeline(slug);
    return { slug };
  });
  return { jobId: job.id };
}));

app.get("/api/projects/:slug", h(async (req) => {
  const slug = param(req, "slug");
  const p = await readProject(slug);
  const active = activeJobFor(slug);
  return { ...p, activeJobId: active?.id ?? null };
}));

app.put("/api/projects/:slug/script", h(async (req) => {
  const slug = param(req, "slug");
  if (activeJobFor(slug)) throw new HttpError(409, "Dự án đang render — đợi xong hoặc huỷ job trước khi lưu.");
  const r = await saveScript(slug, req.body as Script);
  const p = await readProject(slug);
  return { ...p, invalidated: r.invalidated };
}));

app.delete("/api/projects/:slug", h(async (req) => {
  const slug = param(req, "slug");
  if (activeJobFor(slug)) throw new HttpError(409, "Dự án đang render.");
  await deleteProject(slug);
  return { ok: true };
}));

app.post("/api/projects/:slug/duplicate", h(async (req) => {
  const script = await readScript(param(req, "slug"));
  script.metadata.title = `${script.metadata.title} (bản sao)`;
  return { slug: await createProject(script, { sourceKind: "import" }) };
}));

app.post("/api/projects/:slug/cache", h(async (req) => {
  const slug = param(req, "slug");
  if (activeJobFor(slug)) throw new HttpError(409, "Dự án đang render.");
  const kind = ["voice", "clip", "all"].includes(req.body?.kind) ? req.body.kind : "all";
  await clearCache(slug, kind, req.body?.sceneId || undefined);
  return readProject(slug);
}));

function enqueuePipeline(slug: string) {
  const existing = activeJobFor(slug);
  if (existing) return existing;
  return enqueue("pipeline", `Render video: ${slug}`, async (ctx) => {
    const script = await readScript(slug);
    const errors = validateScript(script);
    if (errors.length) throw new Error(`Kịch bản chưa hợp lệ:\n${errors.join("\n")}`);
    const dir = projectDir(slug);
    try {
      await ctx.runTs(["src/cli.ts", `output/${slug}/script.json`]);
    } catch (e) {
      await writeMeta(slug, { lastRender: { at: new Date().toISOString(), ok: false, error: (e as Error).message } });
      throw e;
    }
    const video = join(dir, "video.mp4");
    const durationSec = await getDurationSec(video);
    makeThumb(dir);
    await writeMeta(slug, { lastRender: { at: new Date().toISOString(), ok: true, durationSec } });
    return { slug, durationSec };
  }, slug);
}

app.post("/api/projects/:slug/render", h(async (req) => {
  const slug = param(req, "slug");
  await readScript(slug);
  return { jobId: enqueuePipeline(slug).id };
}));

app.post("/api/projects/:slug/scenes/:id/render", h(async (req) => {
  const slug = param(req, "slug");
  const sceneId = param(req, "id");
  const script = await readScript(slug);
  const scene = script.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new HttpError(404, "Không có scene này");
  if (activeJobFor(slug)) throw new HttpError(409, "Dự án đang có job chạy.");
  const clipsDir = join(projectDir(slug), "clips");
  await mkdir(clipsDir, { recursive: true });
  // Same file the pipeline caches → rendering the full video later reuses it.
  const outputPath = join(clipsDir, `scene-${scene.id}.mp4`);
  // Match the pipeline's clip length (narration + gap) so the full render reuses this clip.
  const idx = script.scenes.indexOf(scene);
  const voice = join(projectDir(slug), "voice", `scene-${scene.id}.mp3`);
  const tail = idx === script.scenes.length - 1 ? 3 : 0.3;
  const durationSec = existsSync(voice) ? (await getDurationSec(voice)) + tail : 6;
  const job = enqueue("render-scene", `Render scene ${scene.id} (${scene.templateId})`, (ctx) =>
    renderTemplateJob(ctx, {
      templateId: scene.templateId,
      inputs: scene.inputs,
      aspect: script.aspect,
      outputPath,
      baseDir: projectDir(slug),
      meta: script.metadata,
      durationSec,
      extraVars: { __title: script.metadata.title, __intro: idx === 0, __index: idx },
    }),
  slug);
  return { jobId: job.id };
}));

/**
 * Move a project made with the old text templates onto the channel frame:
 * news-frame for every scene, news-outro last, photos pulled from the source
 * article (if any) and spread across scenes.
 */
app.post("/api/projects/:slug/migrate", h(async (req) => {
  const slug = param(req, "slug");
  if (activeJobFor(slug)) throw new HttpError(409, "Dự án đang render.");
  const dir = projectDir(slug);
  const script = await readScript(slug);
  let images = await readImages(dir);
  const url = script.metadata.source?.url;
  if (!images.length && url) {
    try {
      const page = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.text());
      images = await downloadArticleImages(dir, extractImages(page, url), url, () => {});
      await writeImages(dir, images);
    } catch {
      /* no photos — the frame falls back to the brand backdrop */
    }
  }
  const n = script.scenes.length;
  script.scenes = script.scenes.map((s, i) => {
    const last = i === n - 1;
    const img = images.length ? images[i % images.length].file : undefined;
    return {
      ...s,
      type: i === 0 ? "hook" : last ? "outro" : "body",
      templateId: last ? "news-outro" : "news-frame",
      inputs: img ? { image: last ? images[0].file : img } : {},
    };
  });
  script.metadata.date ??= todayVN();
  await clearCache(slug, "clip");
  await saveScript(slug, script);
  return readProject(slug);
}));

// ── Project images ─────────────────────────────────────────────────────────
app.get("/api/projects/:slug/images", h(async (req) => readImages(projectDir(param(req, "slug")))));

/** Add a photo from a URL or an uploaded data URL. */
app.post("/api/projects/:slug/images", h(async (req) => {
  const dir = projectDir(param(req, "slug"));
  const list = await readImages(dir);
  let bytes: Buffer;
  let url = "";
  const dataUrl = String(req.body?.dataUrl ?? "");
  if (dataUrl) {
    const m = dataUrl.match(/^data:image\/[a-z+]+;base64,(.+)$/);
    if (!m) throw new HttpError(400, "File không phải ảnh");
    bytes = Buffer.from(m[1], "base64");
  } else {
    url = String(req.body?.url ?? "");
    if (!/^https?:\/\//.test(url)) throw new HttpError(400, "Link ảnh phải bắt đầu bằng http(s)://");
    bytes = await fetchImageBytes(url).catch((e) => { throw new HttpError(400, `Không tải được ảnh: ${e.message}`); });
  }
  const img = await saveImage(dir, bytes, { url, caption: String(req.body?.caption ?? "") }, { force: true });
  if (!img) throw new HttpError(400, "Không đọc được file ảnh");
  list.push(img);
  await writeImages(dir, list);
  return list;
}));

/** Web image search for the picker (results are not downloaded until chosen). */
app.post("/api/images/search", h(async (req) => {
  const q = String(req.body?.query ?? "").trim();
  if (!q) throw new HttpError(400, "Nhập từ khoá tìm ảnh");
  // Photos from news articles about it first (captioned, reliable), then web image search.
  const [news, web] = await Promise.all([
    relatedArticleImages([q], [], 5).catch(() => []),
    searchImages(q, 24),
  ]);
  const seen = new Set<string>();
  return [
    ...news.map((p) => ({ url: p.url, thumb: p.url, title: p.caption || p.pageTitle, page: p.page })),
    ...web,
  ].filter((h) => !seen.has(h.url) && seen.add(h.url)).slice(0, 40);
}));

/**
 * Top up photos for every scene (or one scene) via each scene's imageQuery.
 * force → add 2 more even if the scene already has enough.
 */
app.post("/api/projects/:slug/images/autofill", h(async (req) => {
  const slug = param(req, "slug");
  if (activeJobFor(slug)) throw new HttpError(409, "Dự án đang render.");
  const dir = projectDir(slug);
  const script = await readScript(slug);
  const logs: string[] = [];
  const images = await fillSceneImages(dir, script, await readImages(dir), (l) => logs.push(l), {
    onlyScene: req.body?.sceneId || undefined,
    force: !!req.body?.force,
  });
  await writeImages(dir, images);
  await saveScript(slug, script);
  return { ...(await readProject(slug)), log: logs };
}));

/** Re-download photos from the article the project was made from. */
app.post("/api/projects/:slug/images/refetch", h(async (req) => {
  const slug = param(req, "slug");
  const dir = projectDir(slug);
  const script = await readScript(slug);
  const url = script.metadata.source?.url;
  if (!url) throw new HttpError(400, "Dự án này không có link bài gốc.");
  const page = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.text());
  const have = new Set((await readImages(dir)).map((i) => i.url));
  const fresh = extractImages(page, url).filter((c) => !have.has(c.url));
  const added = await downloadArticleImages(dir, fresh, url, () => {});
  const list = [...(await readImages(dir)), ...added];
  await writeImages(dir, list);
  return list;
}));

app.delete("/api/projects/:slug/images/:file", h(async (req) => {
  const dir = projectDir(param(req, "slug"));
  const file = `images/${param(req, "file")}`;
  if (!/^images\/\d+\.jpg$/.test(file)) throw new HttpError(400, "Tên ảnh không hợp lệ");
  await rm(join(dir, file), { force: true });
  const list = (await readImages(dir)).filter((i) => i.file !== file);
  await writeImages(dir, list);
  return list;
}));

const TYPE_TO_SFX: Record<string, string> = { hook: "hook", body: "callout", outro: "outro" };

app.get("/api/projects/:slug/sfx-plan", h(async (req) => {
  const script = await readScript(param(req, "slug"));
  const index = indexSfxLibrary(SFX_DIR);
  const mode = getSetting("SFX_MODE");
  return script.scenes.map((s) => {
    if (s.sfx) return { id: s.id, source: s.sfx.name === "none" ? "none" : "override", file: s.sfx.name === "none" ? null : `${s.sfx.name}.mp3`, volume: s.sfx.volume ?? 0.4 };
    // Mirrors the pipeline: by default only the outro gets the channel's subscribe bell.
    if (mode === "off") return { id: s.id, source: "none", file: null };
    if (mode !== "auto") {
      return s.type === "outro"
        ? { id: s.id, source: "chuông đăng ký kênh", file: "__brand__/subscribe.mp3", volume: 0.45 }
        : { id: s.id, source: "none", file: null, note: "chỉ đoạn kết có SFX" };
    }
    const picked = pickSfxForScene({ voiceText: s.voiceText, templateName: TYPE_TO_SFX[s.type] ?? "callout", sceneId: s.id, index });
    if (!picked) return { id: s.id, source: "none", file: null };
    const pb = defaultPlayback(picked);
    return { id: s.id, source: picked.source, keyword: picked.matchedKeyword, file: picked.relPath, volume: pb.volume, offsetSec: pb.offsetSec };
  });
}));

// ── SFX library ────────────────────────────────────────────────────────────
app.get("/api/sfx", h(() => {
  const index = indexSfxLibrary(SFX_DIR);
  return Object.entries(index).map(([category, files]) => ({
    category,
    files: files.map((f) => ({ name: f.replace(/\.mp3$/i, ""), path: `${category}/${f}`, size: statSync(join(SFX_DIR, category, f)).size })),
  }));
}));

app.post("/api/sfx/download", h((req) => {
  const max = Math.min(20, Math.max(1, Number(req.body?.max) || 5));
  const job = enqueue("sfx-download", `Tải thư viện SFX (tối đa ${max}/từ khoá)`, (ctx) =>
    ctx.runTs(["scripts/download-sfx.ts", "--max", String(max)]),
  undefined, "sfx");
  return { jobId: job.id };
}));

app.post("/api/sfx/filter", h((req) => {
  const maxSec = Math.min(15, Math.max(0.5, Number(req.body?.maxSec) || 3));
  const job = enqueue("sfx-filter", `Lọc SFX (≤ ${maxSec}s)`, (ctx) =>
    ctx.runTs(["scripts/filter-sfx.ts", "--max-sec", String(maxSec)]),
  undefined, "sfx");
  return { jobId: job.id };
}));

// ── Jobs + live events ─────────────────────────────────────────────────────
app.get("/api/jobs", h(() => listJobs()));
app.get("/api/jobs/:id", h((req) => {
  const job = getJob(param(req, "id"));
  if (!job) throw new HttpError(404, "Không có job này");
  return job;
}));
app.post("/api/jobs/:id/cancel", h((req) => ({ ok: cancelJob(param(req, "id")) })));

app.get("/api/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const onUpdate = (job: unknown) => send("job", job);
  const onLog = (id: string, line: string) => send("log", { id, line });
  bus.on("update", onUpdate);
  bus.on("log", onLog);
  const ping = setInterval(() => res.write(": ping\n\n"), 20000);
  req.on("close", () => {
    clearInterval(ping);
    bus.off("update", onUpdate);
    bus.off("log", onLog);
  });
});

// ── Static files ───────────────────────────────────────────────────────────
app.use("/files", express.static(OUTPUT_DIR, { dotfiles: "allow", fallthrough: false }));
app.use("/sfx-files/__brand__", express.static(join(ROOT, "assets", "brand"), { fallthrough: false }));
app.use("/sfx-files", express.static(SFX_DIR, { fallthrough: false }));
app.use(express.static(join(ROOT, "web", "public")));

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof HttpError ? err.status : (err as { status?: number }).status ?? 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message });
});

// ── Boot ───────────────────────────────────────────────────────────────────
async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  try {
    await startTtsServer(TTS_ENDPOINT, voiceSettings);
    ttsMode = "embedded";
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    ttsMode = "external"; // a separate `npm run tts:server` already serves it
  }
  app.listen(PORT, "127.0.0.1", () => {
    console.log(`\n  🎬 Template Video Studio: http://localhost:${PORT}\n`);
    const genmax = genmaxFromEnv();
    console.log(`  TTS: ${ttsMode === "embedded" ? "nhúng sẵn" : "dùng server có sẵn"} tại ${TTS_ENDPOINT.origin} (${genmax ? `Genmax ${genmax.provider}` : getSetting("EDGE_VOICE")})`);
    console.log(`  FFmpeg: ${ffmpegDir ?? "KHÔNG TÌM THẤY — cài FFmpeg trước khi render"}`);
    const par = parallelPlan();
    console.log(`  Song song: ${par.cores} luồng CPU / ${par.memGb} GB RAM → ${par.jobs} video cùng lúc × ${par.scenes} scene × ${par.workers} worker`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

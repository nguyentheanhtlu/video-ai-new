import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TemplateScriptSchema } from "../../src/render/template-script-schema.js";
import { toSlug } from "../../src/utils/slug.js";
import { getTemplate } from "./templates.js";
import { HttpError, OUTPUT_DIR, projectDir } from "./paths.js";
import { readImages } from "./images.js";

// Loose shape: drafts may be invalid while the user edits them.
export interface Scene {
  id: string;
  type: "hook" | "body" | "outro";
  voiceText: string;
  templateId: string;
  inputs: Record<string, unknown>;
  sfx?: { name: string; volume?: number; startOffsetSec?: number };
  /** Web image-search keywords for this scene (not rendered; used to find photos). */
  imageQuery?: string;
}
export interface Script {
  version: "1.0";
  renderer: "hyperframes";
  aspect: "9:16" | "16:9" | "1:1";
  metadata: { title: string; source: { url: string; domain: string; image: string | null }; channel: string; date?: string };
  voice: { provider: "omnivoice"; speed: number };
  scenes: Scene[];
}

export interface ProjectMeta {
  createdAt: string;
  lastRender?: { at: string; ok: boolean; durationSec?: number; error?: string };
  sourceKind?: "url" | "text" | "blank" | "import";
}

const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export async function readMeta(slug: string): Promise<ProjectMeta> {
  const dir = projectDir(slug);
  return readJson<ProjectMeta>(join(dir, "project.json"), {
    createdAt: existsSync(dir) ? statSync(dir).birthtime.toISOString() : new Date().toISOString(),
  });
}

export async function writeMeta(slug: string, patch: Partial<ProjectMeta>): Promise<void> {
  const meta = { ...(await readMeta(slug)), ...patch };
  await writeFile(join(projectDir(slug), "project.json"), JSON.stringify(meta, null, 2));
}

export async function listProjects() {
  if (!existsSync(OUTPUT_DIR)) return [];
  const out = [];
  for (const slug of readdirSync(OUTPUT_DIR)) {
    if (slug.startsWith(".")) continue;
    const dir = join(OUTPUT_DIR, slug);
    if (!statSync(dir).isDirectory() || !existsSync(join(dir, "script.json"))) continue;
    const script = await readJson<Partial<Script>>(join(dir, "script.json"), {});
    const meta = await readMeta(slug);
    if (existsSync(join(dir, "video.mp4")) && !existsSync(join(dir, "thumb.jpg"))) makeThumb(dir);
    out.push({
      slug,
      title: script.metadata?.title ?? slug,
      scenes: script.scenes?.length ?? 0,
      aspect: script.aspect ?? "9:16",
      createdAt: meta.createdAt,
      updatedAt: statSync(join(dir, "script.json")).mtime.toISOString(),
      lastRender: meta.lastRender ?? null,
      hasVideo: existsSync(join(dir, "video.mp4")),
      hasThumb: existsSync(join(dir, "thumb.jpg")),
    });
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Small poster for the project grid — from the video cover when there is one. */
export function makeThumb(dir: string): void {
  const cover = join(dir, "cover.jpg");
  const args = existsSync(cover)
    ? ["-y", "-v", "error", "-i", cover, "-vf", "scale=360:-2", join(dir, "thumb.jpg")]
    : ["-y", "-v", "error", "-ss", "1.2", "-i", join(dir, "video.mp4"), "-frames:v", "1", "-vf", "scale=360:-2", join(dir, "thumb.jpg")];
  spawnSync("ffmpeg", args, { windowsHide: true });
}

export const todayVN = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
};

/** Reserve output/<slug>-<timestamp>/ up front so article photos can be downloaded into it. */
export async function allocateProject(title: string): Promise<string> {
  const slug = `${toSlug(title.replace(/\*/g, ""))}-${stamp()}`;
  await mkdir(projectDir(slug), { recursive: true });
  return slug;
}

export async function createProject(
  script: Script,
  opts: { sourceText?: string; sourceKind: ProjectMeta["sourceKind"]; slug?: string },
): Promise<string> {
  script.metadata.date ??= todayVN();
  const slug = opts.slug ?? (await allocateProject(script.metadata.title));
  const dir = projectDir(slug);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "script.json"), JSON.stringify(script, null, 2));
  if (opts.sourceText) await writeFile(join(dir, "source.txt"), opts.sourceText);
  await writeMeta(slug, { createdAt: new Date().toISOString(), sourceKind: opts.sourceKind });
  return slug;
}

export async function readScript(slug: string): Promise<Script> {
  const file = join(projectDir(slug), "script.json");
  if (!existsSync(file)) throw new HttpError(404, `Không tìm thấy dự án ${slug}`);
  return JSON.parse(await readFile(file, "utf8"));
}

const sceneFiles = (dir: string, id: string) => ({
  voice: join(dir, "voice", `scene-${id}.mp3`),
  clip: join(dir, "clips", `scene-${id}.mp4`),
  fit: join(dir, "clips", `scene-${id}-fit.mp4`),
});

export async function readProject(slug: string) {
  const dir = projectDir(slug);
  const script = await readScript(slug);
  const files = ["video.mp4", "cover.jpg", "voice.mp3", "script.txt", "script.json", "source.txt", "thumb.jpg"].filter((f) =>
    existsSync(join(dir, f)),
  );
  const scenes = (script.scenes ?? []).map((s) => {
    const f = sceneFiles(dir, s.id);
    return { id: s.id, hasVoice: existsSync(f.voice), hasClip: existsSync(f.clip) };
  });
  return {
    slug,
    script,
    meta: await readMeta(slug),
    files,
    sceneCache: scenes,
    images: await readImages(dir),
    validation: validateScript(script),
    warnings: lintScript(script),
  };
}

/**
 * Save a (possibly draft) script. The pipeline caches TTS and clips per scene id,
 * so drop exactly the caches the edit made stale: voice when voiceText changed,
 * clip when template/inputs/aspect changed.
 */
export async function saveScript(slug: string, next: Script) {
  const dir = projectDir(slug);
  const prev = await readScript(slug).catch(() => null);
  const invalidated: string[] = [];
  if (prev) {
    const prevById = new Map((prev.scenes ?? []).map((s) => [s.id, s]));
    for (const s of next.scenes ?? []) {
      const old = prevById.get(s.id);
      if (!old) continue;
      const f = sceneFiles(dir, s.id);
      if (old.voiceText !== s.voiceText && existsSync(f.voice)) {
        await rm(f.voice, { force: true });
        invalidated.push(`${s.id}: giọng`);
      }
      const visualChanged =
        old.templateId !== s.templateId ||
        JSON.stringify(old.inputs) !== JSON.stringify(s.inputs) ||
        prev.aspect !== next.aspect;
      if (visualChanged && existsSync(f.clip)) {
        await rm(f.clip, { force: true });
        await rm(f.fit, { force: true });
        invalidated.push(`${s.id}: hình`);
      }
    }
  }
  await writeFile(join(dir, "script.json"), JSON.stringify(next, null, 2));
  return { invalidated };
}

export async function clearCache(slug: string, kind: "voice" | "clip" | "all", sceneId?: string) {
  const dir = projectDir(slug);
  if (!sceneId) {
    if (kind !== "clip") await rm(join(dir, "voice"), { recursive: true, force: true });
    if (kind !== "voice") await rm(join(dir, "clips"), { recursive: true, force: true });
    return;
  }
  const f = sceneFiles(dir, sceneId);
  if (kind !== "clip") await rm(f.voice, { force: true });
  if (kind !== "voice") {
    await rm(f.clip, { force: true });
    await rm(f.fit, { force: true });
  }
}

export async function deleteProject(slug: string) {
  await rm(projectDir(slug), { recursive: true, force: true });
}

export function validateScript(script: unknown): string[] {
  const r = TemplateScriptSchema.safeParse(script);
  const errors = r.success ? [] : r.error.issues.map((i) => `${i.path.join(".") || "script"}: ${i.message}`);
  const s = script as Partial<Script>;
  const ids = new Set<string>();
  for (const [i, scene] of (s.scenes ?? []).entries()) {
    if (scene.templateId && !getTemplate(scene.templateId)) errors.push(`scenes.${i}.templateId: không có template "${scene.templateId}"`);
    if (!/^[a-zA-Z0-9_-]+$/.test(scene.id ?? "")) errors.push(`scenes.${i}.id: chỉ dùng chữ, số, - và _`);
    if (ids.has(scene.id)) errors.push(`scenes.${i}.id: trùng id "${scene.id}"`);
    ids.add(scene.id);
  }
  return errors;
}

const EMOJI_RE = /\p{Extended_Pictographic}/u;

/** Soft warnings mirroring the skill's TTS + layout rules. */
export function lintScript(script: Script): { scene: string; field: string; message: string }[] {
  const out: { scene: string; field: string; message: string }[] = [];
  for (const s of script.scenes ?? []) {
    const v = s.voiceText ?? "";
    if (/\d/.test(v)) out.push({ scene: s.id, field: "voiceText", message: "Có chữ số — nên viết số ra chữ (vd \"mười bảy\") để TTS đọc đúng." });
    if (EMOJI_RE.test(v)) out.push({ scene: s.id, field: "voiceText", message: "Có emoji — giọng đọc không được chứa emoji." });
    if (/https?:\/\/|www\./i.test(v)) out.push({ scene: s.id, field: "voiceText", message: "Có URL — không nên đọc URL." });
    if (/[→&%$#+=]/.test(v)) out.push({ scene: s.id, field: "voiceText", message: "Có ký hiệu (→ & % $ # + =) — nên viết ra chữ." });
    if (v && !/[.?!…]$/.test(v.trim())) out.push({ scene: s.id, field: "voiceText", message: "Nên kết câu bằng dấu . hoặc ? để ngắt nghỉ tự nhiên." });

    const tpl = getTemplate(s.templateId);
    if (!tpl) continue;
    const hasImageSlot = tpl.slots.some((sl) => sl.type.startsWith("image"));
    const imgs = [s.inputs?.image, ...(Array.isArray(s.inputs?.images) ? (s.inputs.images as unknown[]) : [])].filter(Boolean);
    if (hasImageSlot && s.type !== "outro" && imgs.length === 0)
      out.push({ scene: s.id, field: "inputs.image", message: "Chưa chọn ảnh — khung sẽ hiện nền màu kênh." });
    if (!tpl.roles.includes(s.type)) out.push({ scene: s.id, field: "templateId", message: `Template "${tpl.id}" thường dùng cho ${tpl.roles.join("/")}, không phải ${s.type}.` });
    for (const slot of tpl.slots) {
      const val = s.inputs?.[slot.name];
      if (slot.max == null || val == null) continue;
      if (typeof val === "string" && val.length > slot.max)
        out.push({ scene: s.id, field: `inputs.${slot.name}`, message: `Dài ${val.length} ký tự, nên ≤ ${slot.max}.` });
      if (Array.isArray(val) && /lines|items/.test(slot.limit) && val.length > slot.max)
        out.push({ scene: s.id, field: `inputs.${slot.name}`, message: `${val.length} mục, nên ≤ ${slot.max}.` });
    }
  }
  return out;
}

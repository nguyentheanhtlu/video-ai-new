import {
  fetchSearchImages,
  knownHashes,
  matchScore,
  relatedArticleImages,
  savePoolImage,
  type PoolImage,
} from "./image-search.js";
import type { ProjectImage } from "./images.js";
import type { Scene, Script } from "./projects.js";

/** Seconds each photo stays on screen — long enough to actually look at it. */
const SEC_PER_PHOTO = 4;
const MAX_PER_SCENE = 3;

const words = (t: string) => (t ?? "").trim().split(/\s+/).filter(Boolean).length;
/** Edge TTS reads ~3.8 Vietnamese words (syllables) per second at +8%. */
const estSec = (t: string) => words(t) / 3.8;

type QScene = Scene & { imageQuery?: string };

export function sceneImages(s: Scene): string[] {
  const list = Array.isArray(s.inputs?.images) ? (s.inputs.images as unknown[]).filter((x): x is string => typeof x === "string") : [];
  if (typeof s.inputs?.image === "string" && !list.includes(s.inputs.image)) list.unshift(s.inputs.image);
  return list;
}

function setSceneImages(s: Scene, list: string[]) {
  const inputs = { ...(s.inputs ?? {}) };
  delete inputs.image;
  delete inputs.images;
  if (list.length === 1) inputs.image = list[0];
  else if (list.length > 1) inputs.images = list;
  s.inputs = inputs;
}

export function photosWanted(s: Scene): number {
  return Math.max(1, Math.min(MAX_PER_SCENE, Math.round(estSec(s.voiceText) / SEC_PER_PHOTO)));
}

/**
 * Give every scene enough photos to change about every 4s.
 *
 * 1. keep photos the script already assigned (from the source article);
 * 2. build a pool from related articles about the same story (VnExpress search
 *    on the headline + scene keywords) and give each scene the photos whose
 *    captions best match its narration, never repeating a photo;
 * 3. fall back to web image search (relevance-filtered) for anything missing.
 *
 * Mutates `script`; returns the project's full image list.
 */
export async function fillSceneImages(
  projectDir: string,
  script: Script,
  images: ProjectImage[],
  log: (line: string) => void,
  opts: { onlyScene?: string; force?: boolean } = {},
): Promise<ProjectImage[]> {
  const all = [...images];
  const hashes = await knownHashes(projectDir, images);
  const usedUrls = new Set(images.map((i) => i.url).filter(Boolean));
  const title = (script.metadata?.title ?? "").replace(/\*/g, "");
  const scenes = (script.scenes as QScene[]).filter((s) => s.type !== "outro" && (!opts.onlyScene || s.id === opts.onlyScene));
  // A photo already shown in an earlier scene is dropped here and replaced with a
  // fresh one (it comes back below only if nothing new can be found).
  if (!opts.onlyScene) {
    const seenBefore = new Set<string>();
    for (const s of script.scenes as QScene[]) {
      if (s.type === "outro") continue;
      const own = sceneImages(s);
      const fresh = own.filter((f) => !seenBefore.has(f));
      own.forEach((f) => seenBefore.add(f));
      if (fresh.length !== own.length) setSceneImages(s, fresh);
    }
  }
  const need = (s: QScene) => Math.min(MAX_PER_SCENE, opts.force ? sceneImages(s).length + 2 : photosWanted(s)) - sceneImages(s).length;
  if (!scenes.some((s) => need(s) > 0)) return all;

  const queries = [title, ...scenes.map((s) => s.imageQuery ?? "")];
  const exclude = script.metadata?.source?.url ? [script.metadata.source.url] : [];
  let pool: PoolImage[] = [];
  try {
    pool = (await relatedArticleImages(queries, exclude)).filter((p) => !usedUrls.has(p.url));
    log(`Kho ảnh từ các bài liên quan: ${pool.length} ảnh`);
  } catch {
    log("Không lấy được bài liên quan — chuyển sang tìm ảnh trên web");
  }

  for (const s of scenes) {
    const missing = need(s);
    if (missing <= 0) continue;
    const have = sceneImages(s);
    const text = `${s.imageQuery ?? ""} ${s.imageQuery ?? ""} ${s.voiceText}`;
    // Best caption match first; ties keep article order (lead photos first).
    const ranked = pool
      .map((p, i) => ({ p, i, score: matchScore(p, text) }))
      .sort((a, b) => b.score - a.score || a.i - b.i);
    const got: ProjectImage[] = [];
    for (let k = 0; k < ranked.length && got.length < missing; k += 3) {
      const batch = ranked.slice(k, k + 3).map((r) => r.p);
      const saved = await Promise.all(batch.map((p) => savePoolImage(projectDir, p, hashes)));
      for (const [j, img] of saved.entries()) {
        usedUrls.add(batch[j].url);
        if (img && got.length < missing) got.push(img);
      }
      pool = pool.filter((p) => !usedUrls.has(p.url));
    }
    let fromWeb: ProjectImage[] = [];
    if (got.length < missing) {
      const query = s.imageQuery?.trim() || title;
      fromWeb = await fetchSearchImages(projectDir, query, missing - got.length, hashes, usedUrls, title);
    }
    all.push(...got, ...fromWeb);
    setSceneImages(s, [...have, ...got.map((g) => g.file), ...fromWeb.map((g) => g.file)].slice(0, MAX_PER_SCENE));
    log(`  ${s.id}: +${got.length} ảnh bài liên quan${fromWeb.length ? `, +${fromWeb.length} ảnh web` : ""}`);
  }

  // Scenes that still have nothing borrow a photo, avoiding the neighbour's.
  for (const [i, s] of script.scenes.entries()) {
    if (s.type === "outro" || sceneImages(s).length) continue;
    const prev = new Set(i > 0 ? sceneImages(script.scenes[i - 1]) : []);
    const pick = all.find((im) => !prev.has(im.file));
    if (pick) setSceneImages(s, [pick.file]);
  }
  // Outro: blurred backdrop = the hook's lead photo.
  const outro = script.scenes[script.scenes.length - 1];
  const lead = sceneImages(script.scenes[0])[0];
  if (outro?.type === "outro" && lead && !outro.inputs?.image) outro.inputs = { ...(outro.inputs ?? {}), image: lead };
  return all;
}

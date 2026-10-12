import { readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import pLimit from "p-limit";
import { TemplateScriptSchema, type TemplateScript } from "./template-script-schema.js";
import { loadConfig } from "../config.js";
import { createTtsClient } from "../tts/tts-client.js";
import {
  getDurationSec,
  concatWithSilence,
  mixSfxOntoVoice,
  type SfxMixSpec,
} from "../assets/audio-tools.js";
import { indexSfxLibrary, pickSfxForScene, defaultPlayback } from "../assets/sfx-selector.js";
import { composeTemplate, hyperframesCached, readTemplateMeta, templateFingerprint } from "./template-composer.js";
import { planRender } from "../utils/machine.js";
import { buildBrand } from "./brand.js";
import { fitClipToDuration, concatVideos, muxAudioOntoVideo, extractFrame } from "./video-tools.js";
import { log } from "../utils/logger.js";

const TOTAL_STEPS = 8;
const SCENE_GAP_SEC = 0.3;
const OUTRO_HOLD_SEC = 3;
const RENDER_FPS = 30;

/** Maps a scene role to a key the SFX selector understands (tier-3 defaults). */
const TYPE_TO_SFX: Record<string, string> = {
  hook: "hook",
  body: "callout",
  outro: "outro",
};

export async function runTemplatePipeline(scriptPath: string): Promise<void> {
  const cfg = loadConfig();
  const outputDir = dirname(scriptPath);
  log.info(`Output directory: ${outputDir}`);

  // STEP 1 — load + validate
  log.step(1, TOTAL_STEPS, `Load + validate template script (TTS: ${cfg.ttsProvider})`);
  const raw = JSON.parse(await readFile(scriptPath, "utf8"));
  const script: TemplateScript = TemplateScriptSchema.parse(raw);

  // STEP 2 — script.txt for CapCut
  log.step(2, TOTAL_STEPS, "Write script.txt");
  await writeFile(join(outputDir, "script.txt"), script.scenes.map((s) => s.voiceText).join("\n\n"));

  // STEP 3 — TTS per scene (idempotent)
  log.step(3, TOTAL_STEPS, "TTS each scene");
  const ttsClient = createTtsClient(cfg);
  const limit = pLimit(cfg.ttsConcurrency);
  const voiceDir = join(outputDir, "voice");
  await mkdir(voiceDir, { recursive: true });
  const sceneAudio = await Promise.all(
    script.scenes.map((scene) =>
      limit(async () => {
        const out = join(voiceDir, `scene-${scene.id}.mp3`);
        const srtOut = join(voiceDir, `scene-${scene.id}.srt`);
        if (existsSync(out)) {
          const dur = await getDurationSec(out);
          log.info(`  scene ${scene.id}: REUSE mp3 (${dur.toFixed(2)}s)`);
          return { id: scene.id, path: out, durationSec: dur };
        }
        log.info(`  TTS scene ${scene.id} (${scene.voiceText.length} chars)...`);
        await ttsClient.generate(scene.voiceText, out, srtOut);
        const dur = await getDurationSec(out);
        log.info(`  scene ${scene.id}: ${dur.toFixed(2)}s`);
        return { id: scene.id, path: out, durationSec: dur };
      }),
    ),
  );

  // STEP 4 — concat voice + compute scene timings
  log.step(4, TOTAL_STEPS, "Concat voice + compute timings");
  const voiceRawMp3 = join(outputDir, "voice-raw.mp3");
  const voiceMp3 = join(outputDir, "voice.mp3");
  await concatWithSilence(sceneAudio.map((a) => a.path), SCENE_GAP_SEC, voiceRawMp3);

  let cursor = 0;
  const sceneStarts: Record<string, number> = {};
  for (const a of sceneAudio) {
    sceneStarts[a.id] = cursor;
    cursor += a.durationSec + SCENE_GAP_SEC;
  }

  // STEP 5 — SFX selection + mix
  log.step(5, TOTAL_STEPS, "Pick + mix SFX");
  const SFX_DIR = join(outputDir, "..", "..", "assets", "sfx");
  const sfxIndex = existsSync(SFX_DIR) ? indexSfxLibrary(SFX_DIR) : {};
  const sfxList: SfxMixSpec[] = [];
  // SFX_MODE=outro (default): news narration stays clean; only the closing
  // "follow the channel" scene gets the channel's subscribe bell.
  // SFX_MODE=auto: the old per-scene keyword picker. SFX_MODE=off: nothing.
  // An explicit scene.sfx always wins.
  const sfxMode = (process.env.SFX_MODE ?? "outro").toLowerCase();
  const outroSfx = [process.env.BRAND_OUTRO_SFX, "assets/brand/outro.mp3", "assets/brand/subscribe.mp3"]
    .filter((p): p is string => !!p)
    .map((p) => join(outputDir, "..", "..", p))
    .find((p) => existsSync(p));
  for (const scene of script.scenes) {
    const startSec = sceneStarts[scene.id];
    if (scene.sfx) {
      if (scene.sfx.name === "none") continue;
      const p = join(SFX_DIR, `${scene.sfx.name}.mp3`);
      if (existsSync(p)) sfxList.push({ path: p, startSec: startSec + scene.sfx.startOffsetSec, volume: scene.sfx.volume });
      continue;
    }
    if (sfxMode === "off") continue;
    if (sfxMode !== "auto") {
      // Bell lands as the follow button pops in (~1s into the outro).
      if (scene.type === "outro" && outroSfx) sfxList.push({ path: outroSfx, startSec: startSec + 0.9, volume: 0.45 });
      continue;
    }
    if (Object.keys(sfxIndex).length === 0) continue;
    const picked = pickSfxForScene({
      voiceText: scene.voiceText,
      templateName: TYPE_TO_SFX[scene.type] ?? "callout",
      sceneId: scene.id,
      index: sfxIndex,
    });
    if (!picked) continue;
    const pb = defaultPlayback(picked);
    sfxList.push({ path: join(SFX_DIR, picked.relPath), startSec: startSec + pb.offsetSec, volume: pb.volume });
  }
  await mixSfxOntoVoice(voiceRawMp3, sfxList, voiceMp3);
  const totalAudioSec = await getDurationSec(voiceMp3);
  log.info(`  voice.mp3: ${totalAudioSec.toFixed(2)}s, ${sfxList.length} SFX`);

  // STEP 6 — render each scene's template clip, fit to its narration length
  log.step(6, TOTAL_STEPS, "Render template clips + fit to narration");
  const clipsDir = join(outputDir, "clips");
  await mkdir(clipsDir, { recursive: true });
  const lastIdx = script.scenes.length - 1;
  const brand = buildBrand(script.metadata);
  // Channel frame (brand kit, headline, aspect) is baked into every dynamic clip:
  // when it changes, those cached clips are stale.
  const stampFile = join(clipsDir, ".frame-stamp");
  const templates = Object.fromEntries(
    [...new Set(script.scenes.map((s) => s.templateId))].map((id) => [id, templateFingerprint(id)]),
  );
  const stamp = JSON.stringify({ brand, title: script.metadata.title, aspect: script.aspect, templates });
  const prevStamp = existsSync(stampFile) ? await readFile(stampFile, "utf8") : null;
  const frameChanged = prevStamp !== null && prevStamp !== stamp;
  if (frameChanged) log.info("  Bộ nhận diện / tiêu đề đã đổi → render lại các clip khung tin");
  // Decide what needs rendering first (cheap, sequential), then render in parallel.
  const plans: { scene: TemplateScript["scenes"][number]; i: number; visualDur: number; rawClip: string; fitClip: string; reuse: boolean }[] = [];
  for (let i = 0; i < script.scenes.length; i++) {
    const scene = script.scenes[i];
    const dur = sceneAudio.find((a) => a.id === scene.id)!.durationSec;
    const visualDur = dur + (i < lastIdx ? SCENE_GAP_SEC : OUTRO_HOLD_SEC);

    const rawClip = join(clipsDir, `scene-${scene.id}.mp4`);
    const fitClip = join(clipsDir, `scene-${scene.id}-fit.mp4`);
    // IDEMPOTENT: reuse an already-rendered clip. Delete it to force a
    // re-render after editing the scene's inputs or template. Dynamic-length
    // templates are rendered to the narration length, so a clip made for an
    // older (different-length) narration is stale too.
    const dynamic = readTemplateMeta(scene.templateId).dynamicDuration === true;
    const staleLength =
      dynamic && existsSync(rawClip) &&
      (frameChanged || Math.abs((await getDurationSec(rawClip)) - visualDur) > 0.25);
    if (staleLength) await rm(rawClip, { force: true });
    plans.push({ scene, i, visualDur, rawClip, fitClip, reuse: existsSync(rawClip) });
  }

  const { cores, memGb, scenes: sceneConcurrency, workers } = planRender();
  log.info(`  Máy ${cores} luồng CPU / ${memGb} GB RAM → ${sceneConcurrency} scene song song × ${workers} worker`);
  const compose = (p: (typeof plans)[number]) =>
    composeTemplate({
      templateId: p.scene.templateId,
      inputs: p.scene.inputs,
      aspect: script.aspect,
      outputPath: p.rawClip,
      fps: RENDER_FPS,
      baseDir: outputDir,
      brand,
      durationSec: p.visualDur,
      workers,
      extraVars: {
        __title: script.metadata.title,
        __intro: p.i === 0,
        __index: p.i,
        __offset: sceneStarts[p.scene.id] ?? 0,
        __total: totalAudioSec + OUTRO_HOLD_SEC,
      },
    });
  // First run on this machine: let one render install HyperFrames before fanning out.
  const composed = new Set<number>();
  const firstNew = plans.find((p) => !p.reuse);
  if (firstNew && sceneConcurrency > 1 && !hyperframesCached()) {
    await compose(firstNew);
    composed.add(firstNew.i);
  }
  const renderLimit = pLimit(sceneConcurrency);
  let renderError: unknown;
  const fittedClips = await Promise.all(
    plans.map((p) =>
      renderLimit(async () => {
        // After a failure, don't start more scenes; ones already rendering finish first.
        if (renderError) return p.fitClip;
        try {
          if (p.reuse) log.info(`  scene ${p.scene.id}: REUSE clip — delete to force re-render`);
          else if (!composed.has(p.i)) await compose(p);
          // An untouched clip whose fitted copy is newer and the right length needs no re-encode.
          const fitFresh =
            p.reuse && existsSync(p.fitClip) &&
            (await stat(p.fitClip)).mtimeMs >= (await stat(p.rawClip)).mtimeMs &&
            Math.abs((await getDurationSec(p.fitClip)) - p.visualDur) < 0.05;
          if (!fitFresh) await fitClipToDuration(p.rawClip, p.visualDur, p.fitClip, RENDER_FPS);
          log.info(`  scene ${p.scene.id}: ${p.scene.templateId} → ${p.visualDur.toFixed(2)}s`);
        } catch (e) {
          renderError ??= e;
        }
        return p.fitClip;
      }),
    ),
  );
  if (renderError) throw renderError;

  await writeFile(stampFile, stamp);

  // STEP 7 — concat clips + mux voice
  log.step(7, TOTAL_STEPS, "Concat clips + mux audio");
  const silentVideo = join(outputDir, "video-silent.mp4");
  const videoPath = join(outputDir, "video.mp4");
  await concatVideos(fittedClips, silentVideo);
  await muxAudioOntoVideo(silentVideo, voiceMp3, videoPath);
  // Cover for TikTok/Shorts: the hook frame once the headline has built in.
  const coverPath = join(outputDir, "cover.jpg");
  const hookSec = sceneAudio[0]?.durationSec ?? 2;
  await extractFrame(videoPath, Math.min(2.2, Math.max(0.5, hookSec - 0.2)), coverPath);

  // STEP 8 — done
  log.step(8, TOTAL_STEPS, "Done");
  console.log("\n=== Result ===");
  console.log(`Video:  ${videoPath}`);
  console.log(`Cover:  ${coverPath}  (ảnh bìa TikTok)`);
  console.log(`Audio:  ${voiceMp3}  (cho CapCut)`);
  console.log(`Script: ${join(outputDir, "script.txt")}  (cho CapCut auto-caption)`);
  console.log(`Tong thoi luong: ${totalAudioSec.toFixed(2)}s`);
}

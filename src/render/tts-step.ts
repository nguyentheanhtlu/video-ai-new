import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pLimit from "p-limit";
import { getDurationSec } from "../assets/audio-tools.js";
import type { Config } from "../config.js";
import { createTtsClient } from "../tts/tts-client.js";
import type { VoiceOverride } from "../tts/voice.js";
import { log } from "../utils/logger.js";

export interface SceneAudio {
  id: string;
  path: string;
  durationSec: number;
}

/**
 * Voice every scene into <outputDir>/voice/scene-<id>.mp3, reusing an mp3 when
 * it was made from the same narration (and voice). `onStale` lets the caller
 * drop visuals cached for the old narration.
 */
export async function voiceScenes(
  cfg: Config,
  outputDir: string,
  scenes: { id: string; voiceText: string }[],
  opts: { voice?: VoiceOverride; onStale?: (id: string) => Promise<void> } = {},
): Promise<SceneAudio[]> {
  const ttsClient = createTtsClient(cfg, opts.voice);
  const limit = pLimit(cfg.ttsConcurrency);
  const voiceDir = join(outputDir, "voice");
  await mkdir(voiceDir, { recursive: true });
  // What each mp3 was made from. Without a voice override the stamp is the bare
  // text, as older projects wrote it, so their caches stay valid.
  const stampOf = (text: string) => (opts.voice ? `${text}\n#voice:${JSON.stringify(opts.voice)}` : text);
  return Promise.all(
    scenes.map((scene) =>
      limit(async () => {
        const out = join(voiceDir, `scene-${scene.id}.mp3`);
        const srtOut = join(voiceDir, `scene-${scene.id}.srt`);
        const textFile = join(voiceDir, `scene-${scene.id}.txt`);
        const stamp = stampOf(scene.voiceText);
        if (existsSync(out) && existsSync(textFile) && (await readFile(textFile, "utf8")) !== stamp) {
          log.info(`  scene ${scene.id}: lời đọc / giọng đã đổi → tạo lại giọng`);
          await rm(out, { force: true });
          await opts.onStale?.(scene.id);
        }
        if (existsSync(out)) {
          const dur = await getDurationSec(out);
          log.info(`  scene ${scene.id}: REUSE mp3 (${dur.toFixed(2)}s)`);
          return { id: scene.id, path: out, durationSec: dur };
        }
        log.info(`  TTS scene ${scene.id} (${scene.voiceText.length} chars)...`);
        await ttsClient.generate(scene.voiceText, out, srtOut);
        await writeFile(textFile, stamp);
        const dur = await getDurationSec(out);
        log.info(`  scene ${scene.id}: ${dur.toFixed(2)}s`);
        return { id: scene.id, path: out, durationSec: dur };
      }),
    ),
  );
}

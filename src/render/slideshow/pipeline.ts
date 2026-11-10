import { existsSync, readdirSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pLimit from "p-limit";
import { getDurationSec } from "../../assets/audio-tools.js";
import { loadConfig } from "../../config.js";
import { log } from "../../utils/logger.js";
import { SlideshowScriptSchema, type SlideshowScript } from "../template-script-schema.js";
import { voiceScenes } from "../tts-step.js";
import { fileKey, H, run, W } from "./ffmpeg.js";
import { reduceClips, renderShot, shotPath, TRANSITION_SEC, xfadeGraph, type Clip, type Shot } from "./shots.js";
import { buildCues, chapterList, thumbnailAss, toAss, toSrt } from "./subtitles.js";

const TOTAL_STEPS = 8;
/** Breath between scenes. */
const SCENE_GAP_SEC = 0.35;
/** Picture held after the last word (outro). */
const OUTRO_HOLD_SEC = 3;
/** Target seconds per shot: long enough to look at, short enough to keep moving. */
const SHOT_SEC = 5;
const MIN_SHOT_SEC = 2.5;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function sceneMedia(scene: SlideshowScript["scenes"][number], dir: string) {
  const inputs = scene.inputs ?? {};
  const images = [...(inputs.image ? [inputs.image] : []), ...(inputs.images ?? [])];
  const media: { kind: "image" | "video"; file: string }[] = [
    ...(inputs.videos ?? []).map((f) => ({ kind: "video" as const, file: join(dir, f) })),
    ...[...new Set(images)].map((f) => ({ kind: "image" as const, file: join(dir, f) })),
  ];
  return media.filter((m) => existsSync(m.file));
}

/** Split each scene's time into shots over its photos/clips; borrow from the previous scene when it has none. */
function planShots(script: SlideshowScript, dir: string, sceneDur: number[], brandColor: string): Shot[] {
  const shots: Shot[] = [];
  let lastMedia: ReturnType<typeof sceneMedia> = [];
  let motion = 0;
  const firstOfChapter = new Set<number>();
  script.scenes.forEach((s, i) => {
    if (i > 0 && s.chapter && s.chapter !== script.scenes[i - 1].chapter) firstOfChapter.add(i);
  });
  const allMedia = script.scenes.map((s) => sceneMedia(s, dir));
  script.scenes.forEach((scene, i) => {
    let media = allMedia[i];
    // No picture: hold the previous scene's last one; at the very start, take the next scene's first.
    if (!media.length && lastMedia.length) media = [lastMedia[lastMedia.length - 1]];
    if (!media.length) media = allMedia.slice(i + 1).find((m) => m.length)?.slice(0, 1) ?? [];
    if (media.length) lastMedia = media;
    const D = sceneDur[i];
    let n = media.length ? Math.max(1, Math.round(D / SHOT_SEC)) : 1;
    n = Math.max(1, Math.min(n, Math.floor(D / MIN_SHOT_SEC)));
    for (let k = 0; k < n; k++) {
      const m = media.length ? media[k % media.length] : undefined;
      shots.push({
        kind: m?.kind ?? "color",
        file: m?.file,
        len: D / n,
        motion: motion++,
        transIn: k === 0 && firstOfChapter.has(i) ? "fadeblack" : "fade",
        color: m ? undefined : brandColor,
      });
    }
  });
  return shots;
}

/** Background track: the channel's own folder first, then assets/music. Same video → same track. */
function pickMusic(script: SlideshowScript): string | undefined {
  const dirs = [
    process.env.MUSIC_DIR,
    script.metadata.channelId ? join(ROOT, "assets", "music", script.metadata.channelId) : undefined,
    join(ROOT, "assets", "music"),
  ].filter((d): d is string => !!d && existsSync(d));
  for (const d of dirs) {
    const files = readdirSync(d).filter((f) => /\.(mp3|m4a|wav|ogg)$/i.test(f)).sort();
    if (files.length) {
      const idx = parseInt(fileKey(script.metadata.title).slice(0, 6), 16) % files.length;
      return join(d, files[idx]);
    }
  }
  return undefined;
}

export async function runSlideshowPipeline(scriptPath: string): Promise<void> {
  const cfg = loadConfig();
  const outputDir = resolve(dirname(scriptPath));
  log.info(`Output directory: ${outputDir}`);

  log.step(1, TOTAL_STEPS, "Load + validate long-form script");
  const script: SlideshowScript = SlideshowScriptSchema.parse(JSON.parse(await readFile(scriptPath, "utf8")));
  const brandColor = script.style.brandColor || process.env.BRAND_COLOR || "#0e9f6e";
  await writeFile(join(outputDir, "script.txt"), script.scenes.map((s) => s.voiceText).join("\n\n"));

  log.step(2, TOTAL_STEPS, `TTS ${script.scenes.length} scenes${script.voice.override ? ` (${script.voice.override.engine} voice of the channel)` : ""}`);
  const audio = await voiceScenes(cfg, outputDir, script.scenes, { voice: script.voice.override });

  // STEP 3 — one PCM track: each scene padded with its gap, so start times are exact.
  log.step(3, TOTAL_STEPS, "Build narration track");
  const pcmDir = join(outputDir, "voice", "pcm");
  await mkdir(pcmDir, { recursive: true });
  const last = script.scenes.length - 1;
  const sceneDur: number[] = [];
  const starts: number[] = [];
  let cursor = 0;
  const wavs: string[] = [];
  const limit = pLimit(Math.max(2, Math.floor(availableParallelism() / 2)));
  await Promise.all(
    audio.map((a, i) =>
      limit(async () => {
        const tail = i === last ? OUTRO_HOLD_SEC : SCENE_GAP_SEC;
        const wav = join(pcmDir, `${a.id}-${fileKey(a.path, a.durationSec.toFixed(3), tail)}.wav`);
        if (!existsSync(wav)) {
          await run("ffmpeg", [
            "-y", "-v", "error", "-i", a.path,
            "-af", `aformat=sample_rates=44100:channel_layouts=stereo,afade=t=in:d=0.008,areverse,afade=t=in:d=0.008,areverse,apad=pad_dur=${tail}`,
            "-c:a", "pcm_s16le", wav,
          ]);
        }
        wavs[i] = wav;
      }),
    ),
  );
  for (let i = 0; i < audio.length; i++) {
    const d = await getDurationSec(wavs[i]);
    starts.push(cursor);
    sceneDur.push(d);
    cursor += d;
  }
  const totalSec = cursor;
  const listFile = join(pcmDir, "list.txt");
  await writeFile(listFile, wavs.map((w) => `file '${w.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"));
  const voiceWav = join(outputDir, "voice.wav");
  await run("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", voiceWav]);
  await run("ffmpeg", ["-y", "-v", "error", "-i", voiceWav, "-c:a", "libmp3lame", "-b:a", "160k", join(outputDir, "voice.mp3")]);
  log.info(`  narration: ${(totalSec / 60).toFixed(1)} phút (${totalSec.toFixed(1)}s)`);

  // STEP 4 — music bed ducked under the voice
  log.step(4, TOTAL_STEPS, "Mix background music");
  const finalAudio = join(outputDir, "audio-final.m4a");
  const music = script.style.music ? pickMusic(script) : undefined;
  if (music) {
    const vol = script.style.musicVolume;
    await run("ffmpeg", [
      "-y", "-v", "error", "-i", voiceWav, "-stream_loop", "-1", "-i", music,
      "-filter_complex",
      [
        `[1:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=${vol},afade=t=in:d=1.5[m]`,
        `[0:a]aformat=sample_rates=44100:channel_layouts=stereo,asplit=2[v][sc]`,
        `[m][sc]sidechaincompress=threshold=0.02:ratio=5:attack=20:release=400[duck]`,
        `[v][duck]amix=inputs=2:duration=first:normalize=0,afade=t=out:st=${Math.max(0, totalSec - 2.5).toFixed(2)}:d=2.5[a]`,
      ].join(";"),
      "-map", "[a]", "-t", totalSec.toFixed(3), "-c:a", "aac", "-b:a", "192k", finalAudio,
    ]);
    log.info(`  nhạc nền: ${music}`);
  } else {
    await run("ffmpeg", ["-y", "-v", "error", "-i", voiceWav, "-c:a", "aac", "-b:a", "192k", finalAudio]);
    log.info(script.style.music ? "  không có nhạc nền (thêm file mp3 vào assets/music/)" : "  nhạc nền: tắt");
  }

  // STEP 5 — subtitles, chapter cards, chapter list
  log.step(5, TOTAL_STEPS, "Subtitles + chapters");
  const timed = script.scenes.map((s, i) => ({
    voiceText: s.voiceText,
    start: starts[i],
    speech: audio[i].durationSec,
  }));
  const cues = buildCues(timed, script.language === "vi" ? 46 : 42);
  await writeFile(join(outputDir, "subtitles.srt"), toSrt(cues));
  const chapterStarts: { start: number; title: string }[] = [];
  for (const ch of script.chapters) {
    const i = script.scenes.findIndex((s) => s.chapter === ch.id);
    if (i >= 0) chapterStarts.push({ start: starts[i], title: ch.title });
  }
  chapterStarts.sort((a, b) => a.start - b.start);
  await writeFile(
    join(outputDir, "subtitles.ass"),
    toAss({
      cues,
      // No card over the opening hook: the first chapter starts with the video.
      chapters: chapterStarts.filter((c) => c.start > 1),
      channel: script.metadata.channel,
      brandColor,
      showSubtitles: script.style.subtitles,
      totalSec,
    }),
  );
  const chapters = chapterList(chapterStarts);

  // STEP 6 — shots
  log.step(6, TOTAL_STEPS, "Render shots (Ken Burns photos + stock footage)");
  const shots = planShots(script, outputDir, sceneDur, brandColor);
  const shotsDir = join(outputDir, "shots");
  await mkdir(shotsDir, { recursive: true });
  const T = TRANSITION_SEC;
  const clips: Clip[] = shots.map((s, i) => {
    const renderLen = s.len + (i < shots.length - 1 ? T : 0);
    return { path: shotPath(shotsDir, s, renderLen), len: renderLen, transIn: s.transIn };
  });
  const toRender = shots.map((s, i) => ({ s, c: clips[i] })).filter(({ c }) => !existsSync(c.path));
  log.info(`  ${shots.length} shot (${shots.filter((s) => s.kind === "video").length} video, ${shots.filter((s) => s.kind === "image").length} ảnh) — cần render ${toRender.length}`);
  const shotLimit = pLimit(Math.max(2, Math.floor(availableParallelism() / 3)));
  let done = 0;
  await Promise.all(
    toRender.map(({ s, c }) =>
      shotLimit(async () => {
        await renderShot(s, c.len, c.path);
        done++;
        if (done % 10 === 0 || done === toRender.length) log.info(`  shot ${done}/${toRender.length}`);
      }),
    ),
  );
  // Drop shots left over from earlier versions of the script.
  const keep = new Set(clips.map((c) => c.path));
  for (const f of readdirSync(shotsDir)) if (!keep.has(join(shotsDir, f))) await rm(join(shotsDir, f), { force: true });

  // STEP 7 — crossfade everything, burn subtitles, add audio
  log.step(7, TOTAL_STEPS, "Join with crossfades + burn subtitles + mux audio");
  const workDir = join(outputDir, "work");
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  const finalClips = await reduceClips(clips, workDir, log.info);
  const { graph } = xfadeGraph(finalClips, "vj");
  const videoPath = join(outputDir, "video.mp4");
  const n = finalClips.length;
  // cwd = outputDir so the ass filter gets a plain relative path (Windows drive colons break filter syntax).
  await run(
    "ffmpeg",
    [
      "-y", "-v", "error",
      ...finalClips.flatMap((c) => ["-i", c.path]),
      "-i", finalAudio,
      "-filter_complex", `${graph};[vj]ass=subtitles.ass[vout]`,
      "-map", "[vout]", "-map", `${n}:a:0`,
      "-c:v", "libx264", "-preset", "faster", "-crf", "20", "-pix_fmt", "yuv420p", "-r", "30",
      "-c:a", "copy", "-movflags", "+faststart", "-t", totalSec.toFixed(3),
      videoPath,
    ],
    outputDir,
  );
  await rm(workDir, { recursive: true, force: true });
  await rm(voiceWav, { force: true });

  // STEP 8 — YouTube package: thumbnail, description, metadata
  log.step(8, TOTAL_STEPS, "Thumbnail + YouTube metadata");
  const thumbSrc = shots.find((s) => s.kind === "image")?.file;
  await writeFile(join(outputDir, "thumbnail.ass"), thumbnailAss(script.metadata.title, brandColor));
  const thumbPath = join(outputDir, "thumbnail.jpg");
  const thumbFilter = `scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,eq=brightness=-0.06:saturation=1.2,ass=thumbnail.ass`;
  if (thumbSrc) await run("ffmpeg", ["-y", "-v", "error", "-i", thumbSrc, "-vf", thumbFilter, "-frames:v", "1", "-q:v", "2", thumbPath], outputDir);
  else await run("ffmpeg", ["-y", "-v", "error", "-ss", "2", "-i", videoPath, "-vf", thumbFilter, "-frames:v", "1", "-q:v", "2", thumbPath], outputDir);
  await copyFile(thumbPath, join(outputDir, "cover.jpg"));

  const vi = script.language === "vi";
  const sources = [script.metadata.source.url, ...(script.metadata.sources ?? [])].filter((u, i, a) => u && a.indexOf(u) === i);
  // Credit the footage libraries actually used (videos.json is written by the web app).
  const usedFiles = new Set(shots.filter((s) => s.kind === "video").map((s) => s.file));
  let stockCredit = "";
  try {
    const list = JSON.parse(await readFile(join(outputDir, "videos.json"), "utf8")) as { file: string; provider?: string }[];
    const names = [...new Set(list.filter((v) => usedFiles.has(join(outputDir, v.file)) && v.provider !== "ai").map((v) => v.provider ?? "pixabay"))]
      .map((p) => (p === "pexels" ? "Pexels (pexels.com)" : "Pixabay (pixabay.com)"));
    stockCredit = names.join(", ");
  } catch {
    /* footage added by hand: no library to credit */
  }
  const description = [
    script.metadata.description?.trim() ?? "",
    chapters.length ? `\n${vi ? "Nội dung" : "Chapters"}:\n${chapters.join("\n")}` : "",
    sources.length ? `\n${vi ? "Nguồn" : "Sources"}:\n${sources.join("\n")}` : "",
    stockCredit ? `\n${vi ? "Video minh hoạ" : "Stock footage"}: ${stockCredit}` : "",
    script.metadata.tags?.length ? `\n${script.metadata.tags.slice(0, 5).map((t) => `#${t.replace(/[^\p{L}\p{N}]/gu, "")}`).join(" ")}` : "",
  ].filter(Boolean).join("\n").trim();
  await writeFile(join(outputDir, "description.txt"), description + "\n");
  await writeFile(join(outputDir, "chapters.txt"), chapters.join("\n") + "\n");
  await writeFile(
    join(outputDir, "youtube.json"),
    JSON.stringify(
      {
        title: script.metadata.title.replace(/\*/g, "").slice(0, 100),
        description,
        tags: script.metadata.tags ?? [],
        language: script.language,
        channelId: script.metadata.channelId ?? null,
        // AI illustrations or clips → YouTube's "altered or synthetic content" disclosure.
        containsSyntheticMedia: shots.some((s) => s.file && /[\\/](ai-[^\\/]+)$/.test(s.file)),
        durationSec: Number(totalSec.toFixed(2)),
        files: { video: "video.mp4", thumbnail: "thumbnail.jpg", captions: "subtitles.srt" },
      },
      null,
      2,
    ),
  );

  const dur = await getDurationSec(videoPath);
  console.log("\n=== Result ===");
  console.log(`Video:      ${videoPath}  (${W}x${H}, ${(dur / 60).toFixed(1)} phút)`);
  console.log(`Thumbnail:  ${thumbPath}`);
  console.log(`Phụ đề:     ${join(outputDir, "subtitles.srt")}`);
  console.log(`Mô tả:      ${join(outputDir, "description.txt")}`);
  console.log(`Tong thoi luong: ${dur.toFixed(2)}s`);
}

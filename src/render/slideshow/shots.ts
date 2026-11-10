import { existsSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileKey, fileStamp, FPS, H, MID_ENCODE, probeSize, run, W } from "./ffmpeg.js";

export type ShotKind = "image" | "video" | "color";

export interface Shot {
  kind: ShotKind;
  /** Absolute path of the photo / clip (none for a colour card). */
  file?: string;
  /** Seconds this shot owns on the timeline (crossfade overlap is added on render). */
  len: number;
  /** Ken Burns variant for photos; start offset seed for clips. */
  motion: number;
  /** Transition into this shot. */
  transIn: "fade" | "fadeblack";
  color?: string;
}

/**
 * Ken Burns moves, cycled shot by shot so consecutive photos never move alike.
 * Gentle (≤8%) and anchored high: in news photos heads sit near the top edge,
 * so whatever the zoom trims comes mostly off the bottom, never the faces.
 */
const TOP = 0.15; // share of the trimmed height taken from the top
const MOTIONS = [
  { z: "1+0.08*on/F", x: "iw/2-(iw/zoom/2)", y: `(ih-ih/zoom)*${TOP}` }, // push in
  { z: "1.08-0.08*on/F", x: "iw/2-(iw/zoom/2)", y: `(ih-ih/zoom)*${TOP}` }, // pull out
  { z: "1.07", x: "(iw-iw/zoom)*on/F", y: `(ih-ih/zoom)*${TOP}` }, // pan right
  { z: "1.07", x: "(iw-iw/zoom)*(1-on/F)", y: `(ih-ih/zoom)*${TOP}` }, // pan left
  { z: "1+0.06*on/F", x: "iw/2-(iw/zoom/2)", y: "0" }, // push in, held at the top edge
];

/**
 * Photos this close to 16:9 are cropped to fill the frame (≤ ~10% trimmed, mostly
 * from the bottom). Anything squarer or wider — 3:2 and 4:3 news photos included —
 * is shown whole on a blurred copy of itself, so no head or ball is ever cut off.
 */
const COVER_MIN = 1.62;
const COVER_MAX = 2.0;

async function imageFilter(file: string): Promise<string> {
  const { width, height } = await probeSize(file).catch(() => ({ width: 16, height: 9 }));
  const ratio = height ? width / height : 16 / 9;
  // Work at 2× so the slow zoom moves in half-pixel steps (no jitter).
  if (ratio >= COVER_MIN && ratio <= COVER_MAX) {
    return `scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2}:(iw-ow)/2:(ih-oh)*${TOP},setsar=1`;
  }
  return [
    `split[a][b]`,
    `[a]scale=${W / 4}:${H / 4}:force_original_aspect_ratio=increase,crop=${W / 4}:${H / 4},boxblur=12:2,eq=brightness=-0.12:saturation=0.9,scale=${W * 2}:${H * 2}[bg]`,
    `[b]scale=${W * 2}:${H * 2}:force_original_aspect_ratio=decrease[fg]`,
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1`,
  ].join(";");
}

export function shotKey(s: Shot, renderLen: number): string {
  return fileKey("v3", s.kind, s.file ? fileStamp(s.file) : s.color ?? "", renderLen.toFixed(3), s.motion);
}

/** Render one shot to exactly `renderLen` seconds of 1920×1080@30 video. */
export async function renderShot(s: Shot, renderLen: number, out: string): Promise<void> {
  const frames = Math.max(1, Math.round(renderLen * FPS));
  const tmp = `${out}.part.mp4`;
  let args: string[];
  if (s.kind === "image" && s.file) {
    const m = MOTIONS[s.motion % MOTIONS.length];
    const zoom = `zoompan=z='${m.z}':x='${m.x}':y='${m.y}':d=${frames}:s=${W}x${H}:fps=${FPS}`.replace(/F/g, String(frames));
    const graph = `[0:v]${await imageFilter(s.file)},${zoom},format=yuv420p[v]`;
    args = ["-y", "-v", "error", "-i", s.file, "-filter_complex", graph, "-map", "[v]", "-frames:v", String(frames), ...MID_ENCODE, tmp];
  } else if (s.kind === "video" && s.file) {
    const { duration } = await probeSize(s.file).catch(() => ({ duration: 0 }));
    // Skip a clip's first second when it is long enough: stock footage often opens on a slate or a fade.
    const offset = duration > renderLen + 2 ? Math.min(1 + (s.motion % 3), duration - renderLen - 0.5) : 0;
    args = [
      "-y", "-v", "error",
      ...(offset > 0 ? ["-ss", offset.toFixed(2)] : ["-stream_loop", "-1"]),
      "-i", s.file,
      "-vf", `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}:(iw-ow)/2:(ih-oh)*${TOP},fps=${FPS},setsar=1,format=yuv420p`,
      "-frames:v", String(frames), ...MID_ENCODE, tmp,
    ];
  } else {
    const color = (s.color ?? "#111827").replace("#", "0x");
    args = ["-y", "-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=${W}x${H}:r=${FPS}`, "-frames:v", String(frames), ...MID_ENCODE, tmp];
  }
  await run("ffmpeg", args);
  await rename(tmp, out);
}

export interface Clip {
  path: string;
  len: number;
  transIn: Shot["transIn"];
}

const TRANSITION_SEC = 0.5;
export { TRANSITION_SEC };

/**
 * xfade a run of clips into one filter graph. Each clip except the last overlaps
 * the next by TRANSITION_SEC, which the caller already added to its length.
 */
export function xfadeGraph(clips: Clip[], label = "vx"): { graph: string; len: number } {
  const T = TRANSITION_SEC;
  const parts = clips.map((_, i) => `[${i}:v]settb=AVTB,fps=${FPS},format=yuv420p,setsar=1[s${i}]`);
  let prev = "s0";
  let acc = clips[0].len;
  for (let i = 1; i < clips.length; i++) {
    const outLabel = i === clips.length - 1 ? label : `x${i}`;
    const offset = acc - T;
    parts.push(`[${prev}][s${i}]xfade=transition=${clips[i].transIn}:duration=${T}:offset=${offset.toFixed(3)}[${outLabel}]`);
    prev = outLabel;
    acc = acc + clips[i].len - T;
  }
  if (clips.length === 1) parts.push(`[s0]null[${label}]`);
  return { graph: parts.join(";"), len: acc };
}

const GROUP = 10;

/**
 * Join many clips with crossfades in groups of GROUP, then join the groups, until
 * at most GROUP remain — so a 10-minute video never needs 150 open decoders at once.
 * Returns the ≤GROUP clips left for the final pass (which also burns subtitles).
 */
export async function reduceClips(clips: Clip[], workDir: string, log: (m: string) => void): Promise<Clip[]> {
  let level = 0;
  let current = clips;
  while (current.length > GROUP) {
    level++;
    const next: Clip[] = [];
    for (let g = 0; g * GROUP < current.length; g++) {
      const group = current.slice(g * GROUP, (g + 1) * GROUP);
      const out = join(workDir, `join-${level}-${g}.mp4`);
      const { graph, len } = xfadeGraph(group);
      await run("ffmpeg", [
        "-y", "-v", "error",
        ...group.flatMap((c) => ["-i", c.path]),
        "-filter_complex", graph, "-map", "[vx]", ...MID_ENCODE, out,
      ]);
      next.push({ path: out, len, transIn: group[0].transIn });
    }
    log(`  ghép cấp ${level}: ${current.length} → ${next.length} đoạn`);
    // Lower-level joins are no longer needed once merged.
    if (level > 1) await Promise.all(current.map((c) => rm(c.path, { force: true })));
    current = next;
  }
  return current;
}

export function shotPath(dir: string, s: Shot, renderLen: number): string {
  return join(dir, `${shotKey(s, renderLen)}.mp4`);
}

export const shotReady = (p: string) => existsSync(p);

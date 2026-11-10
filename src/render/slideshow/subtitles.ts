/**
 * Subtitles for the long-form renderer. The TTS engines return no word timings,
 * so each scene's narration is cut into short lines and timed in proportion to
 * their length inside that scene's speech — close enough for read-along captions.
 */

export interface Cue {
  start: number;
  end: number;
  text: string;
}

export interface TimedScene {
  voiceText: string;
  /** When the scene's speech starts in the final audio, and how long it talks. */
  start: number;
  speech: number;
}

/** Split text into display lines of at most `max` chars, preferring punctuation breaks. */
export function splitLines(text: string, max = 42): string[] {
  const sentences = text.replace(/\s+/g, " ").trim().match(/[^.!?…]+[.!?…]+["”)]*|[^.!?…]+$/g) ?? [text];
  const out: string[] = [];
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if (sentence.length <= max) {
      out.push(sentence);
      continue;
    }
    // Clauses first (commas, semicolons), then words.
    const clauses = sentence.split(/(?<=[,;:])\s+/);
    let line = "";
    for (const clause of clauses) {
      for (const word of clause.split(" ")) {
        if (line && (line + " " + word).length > max) {
          out.push(line);
          line = word;
        } else line = line ? `${line} ${word}` : word;
      }
      // Break after a clause when the line is already reasonably full.
      if (line.length > max * 0.6) {
        out.push(line);
        line = "";
      }
    }
    if (line) out.push(line);
  }
  // Fold a dangling one- or two-word line into its neighbour.
  for (let i = out.length - 1; i > 0; i--) {
    if (out[i].split(" ").length <= 2 && (out[i - 1] + " " + out[i]).length <= max + 12) {
      out[i - 1] = `${out[i - 1]} ${out[i]}`;
      out.splice(i, 1);
    }
  }
  return out;
}

export function buildCues(scenes: TimedScene[], maxChars = 42): Cue[] {
  const cues: Cue[] = [];
  for (const s of scenes) {
    const lines = splitLines(s.voiceText, maxChars);
    // A small fixed weight per line stands in for the pause at each break.
    const weights = lines.map((l) => l.length + 6);
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    let t = s.start;
    lines.forEach((text, i) => {
      const dur = (s.speech * weights[i]) / total;
      cues.push({ start: t, end: t + dur, text });
      t += dur;
    });
  }
  return cues;
}

const pad = (n: number, w = 2) => String(Math.floor(n)).padStart(w, "0");

function srtTime(sec: number): string {
  const ms = Math.round(sec * 1000);
  return `${pad(ms / 3600000)}:${pad((ms / 60000) % 60)}:${pad((ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

function assTime(sec: number): string {
  const cs = Math.round(sec * 100);
  return `${Math.floor(cs / 360000)}:${pad((cs / 6000) % 60)}:${pad((cs / 100) % 60)}.${pad(cs % 100)}`;
}

export function toSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join("\n");
}

/** "#rrggbb" → ASS "&H00BBGGRR". */
function assColor(hex: string, alpha = "00"): string {
  const m = hex.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return `&H${alpha}000000`;
  return `&H${alpha}${m[3]}${m[2]}${m[1]}`.toUpperCase();
}

const assText = (t: string) => t.replace(/\\/g, "/").replace(/[{}]/g, (c) => (c === "{" ? "(" : ")")).replace(/\r?\n/g, "\\N");

export interface AssOptions {
  cues: Cue[];
  /** Chapter title cards: shown for a few seconds where each chapter starts. */
  chapters: { start: number; title: string }[];
  channel: string;
  brandColor: string;
  showSubtitles: boolean;
  totalSec: number;
  font?: string;
}

/** One ASS file carries everything drawn over the footage: captions, chapter cards, channel tag. */
export function toAss(o: AssOptions): string {
  const font = o.font ?? "Arial";
  const brand = assColor(o.brandColor);
  const lines = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1920",
    "PlayResY: 1080",
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Sub,${font},60,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,1.5,2,120,120,64,1`,
    `Style: Chapter,${font},62,&H00FFFFFF,&H00FFFFFF,${brand},${brand},-1,0,0,0,100,100,0.5,0,3,18,0,7,90,90,80,1`,
    `Style: Brand,${font},30,&H40FFFFFF,&H40FFFFFF,&H80000000,&H00000000,-1,0,0,0,100,100,1,0,1,2,0,9,48,48,40,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  if (o.channel) lines.push(`Dialogue: 0,${assTime(0)},${assTime(o.totalSec)},Brand,,0,0,0,,${assText(o.channel.toUpperCase())}`);
  for (const ch of o.chapters) {
    const end = Math.min(o.totalSec, ch.start + 4);
    lines.push(`Dialogue: 2,${assTime(ch.start + 0.2)},${assTime(end)},Chapter,,0,0,0,,{\\fad(350,350)}${assText(ch.title)}`);
  }
  if (o.showSubtitles) for (const c of o.cues) lines.push(`Dialogue: 1,${assTime(c.start)},${assTime(c.end)},Sub,,0,0,0,,${assText(c.text)}`);
  return lines.join("\n") + "\n";
}

/** YouTube chapter list: first entry at 0:00, each at least 10s long. */
export function chapterList(chapters: { start: number; title: string }[]): string[] {
  const kept: { start: number; title: string }[] = [];
  for (const ch of chapters) {
    const start = kept.length === 0 ? 0 : ch.start;
    if (kept.length && start - kept[kept.length - 1].start < 10) continue;
    kept.push({ start, title: ch.title });
  }
  const stamp = (s: number) => {
    const t = Math.floor(s);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    return h ? `${h}:${pad(m)}:${pad(t % 60)}` : `${m}:${pad(t % 60)}`;
  };
  return kept.length >= 3 ? kept.map((c) => `${stamp(c.start)} ${c.title}`) : [];
}

/** Big two-line title for the thumbnail, drawn over the hook photo. */
export function thumbnailAss(title: string, brandColor: string, font = "Arial"): string {
  const words = title.replace(/\*/g, "").split(/\s+/).filter(Boolean);
  // Up to ~9 words, wrapped onto lines of ~3 words.
  const kept = words.slice(0, 9);
  const rows: string[] = [];
  for (let i = 0; i < kept.length; i += 3) rows.push(kept.slice(i, i + 3).join(" "));
  const text = assText(rows.join("\n").toUpperCase() + (words.length > kept.length ? "…" : ""));
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1280",
    "PlayResY: 720",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: T,${font},92,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,7,4,1,60,60,50,1`,
    `Style: Bar,${font},20,${assColor(brandColor)},${assColor(brandColor)},${assColor(brandColor)},${assColor(brandColor)},0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    `Dialogue: 0,0:00:00.00,0:00:10.00,Bar,,0,0,0,,{\\p1\\pos(0,0)}m 0 690 l 1280 690 1280 720 0 720{\\p0}`,
    `Dialogue: 1,0:00:00.00,0:00:10.00,T,,0,0,0,,${text}`,
  ].join("\n") + "\n";
}

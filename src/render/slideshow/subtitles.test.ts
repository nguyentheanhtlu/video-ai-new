import { describe, expect, it } from "vitest";
import { buildCues, chapterList, splitLines, toAss, toSrt } from "./subtitles.js";
import { xfadeGraph } from "./shots.js";

describe("splitLines", () => {
  it("keeps every word, in order, within the line limit (plus a short tail allowance)", () => {
    const text = "Ngay từ những phút đầu tiên, đội bóng xứ Bồ đã chủ động kiểm soát thế trận, liên tục tạo ra các tình huống nguy hiểm. Bàn mở tỷ số đến sớm!";
    const lines = splitLines(text, 42);
    expect(lines.join(" ").split(/\s+/)).toEqual(text.split(/\s+/));
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(42 + 12);
  });
});

describe("buildCues", () => {
  it("fills each scene's speech exactly, back to back", () => {
    const cues = buildCues([
      { voiceText: "Một câu ngắn. Và một câu khác dài hơn một chút để thử.", start: 0, speech: 4 },
      { voiceText: "Cảnh thứ hai.", start: 4.35, speech: 1.5 },
    ]);
    const first = cues.filter((c) => c.start < 4.35);
    expect(first[0].start).toBe(0);
    expect(first.at(-1)!.end).toBeCloseTo(4, 6);
    for (let i = 1; i < first.length; i++) expect(first[i].start).toBeCloseTo(first[i - 1].end, 6);
    expect(cues.at(-1)!.end).toBeCloseTo(5.85, 6);
    expect(toSrt(cues)).toMatch(/^1\n00:00:00,000 --> /);
  });
});

describe("chapterList", () => {
  it("starts at 0:00, drops chapters under 10s, needs at least 3", () => {
    expect(chapterList([{ start: 0.5, title: "A" }, { start: 30, title: "B" }, { start: 35, title: "B2" }, { start: 125, title: "C" }]))
      .toEqual(["0:00 A", "0:30 B", "2:05 C"]);
    expect(chapterList([{ start: 0, title: "A" }, { start: 30, title: "B" }])).toEqual([]);
  });
});

describe("toAss", () => {
  it("escapes override braces in narration", () => {
    const ass = toAss({ cues: [{ start: 0, end: 1, text: "a {b} c" }], chapters: [], channel: "", brandColor: "#ff0000", showSubtitles: true, totalSec: 1 });
    expect(ass).toContain("a (b) c");
    expect(ass).toContain("&H000000FF"); // red in ASS BGR order
  });
});

describe("xfadeGraph", () => {
  it("offsets each crossfade so total length = sum - overlaps", () => {
    const { graph, len } = xfadeGraph([
      { path: "a", len: 5.5, transIn: "fade" },
      { path: "b", len: 4.5, transIn: "fadeblack" },
      { path: "c", len: 3, transIn: "fade" },
    ]);
    expect(len).toBeCloseTo(12, 6);
    expect(graph).toContain("xfade=transition=fadeblack:duration=0.5:offset=5.000");
    expect(graph).toContain("xfade=transition=fade:duration=0.5:offset=9.000"); // a+b = 9.5s after their overlap; next fade starts 0.5s before that
  });
});

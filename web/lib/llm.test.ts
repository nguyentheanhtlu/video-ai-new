import { describe, expect, it } from "vitest";
import { splitIntoScenes } from "./llm.js";

const words = (s: string) => s.replace(/\s+/g, " ").trim();

describe("splitIntoScenes", () => {
  it("keeps every word in order", () => {
    const text = Array.from({ length: 40 }, (_, i) => `Đây là câu số ${i} của kịch bản, gồm vài từ cho đủ dài.`).join("\n");
    const scenes = splitIntoScenes(text);
    expect(words(scenes.join(" "))).toBe(words(text));
    expect(scenes.length).toBeGreaterThanOrEqual(3);
    expect(scenes.length).toBeLessThanOrEqual(12);
  });

  it("splits at sentence ends", () => {
    const text = Array.from({ length: 12 }, (_, i) => `Câu ${i} có nội dung riêng để thử.`).join(" ");
    for (const scene of splitIntoScenes(text)) expect(scene).toMatch(/\.$/);
  });

  it("still makes three scenes from one long sentence", () => {
    const text = Array.from({ length: 30 }, (_, i) => `từ${i}`).join(" ");
    const scenes = splitIntoScenes(text);
    expect(scenes).toHaveLength(3);
    expect(words(scenes.join(" "))).toBe(text);
  });

  it("caps very long scripts at twelve scenes", () => {
    const text = Array.from({ length: 200 }, (_, i) => `Câu thứ ${i} dài vừa phải thôi nhé các bạn ơi.`).join(" ");
    const scenes = splitIntoScenes(text);
    expect(scenes.length).toBeLessThanOrEqual(12);
    expect(words(scenes.join(" "))).toBe(words(text));
  });
});

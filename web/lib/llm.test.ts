import { describe, expect, it } from "vitest";
import { rankGeminiModels, splitIntoScenes } from "./llm.js";

describe("rankGeminiModels", () => {
  it("puts Pro first, newest first, and drops specialised models", () => {
    const ranked = rankGeminiModels([
      "gemini-2.5-flash", "gemini-3.8-flash", "gemini-2.5-pro", "gemini-3.1-pro-preview",
      "gemini-3.8-flash-tts", "gemini-3.5-flash-lite", "gemini-3-pro-image", "gemma-4-31b-it",
    ]);
    expect(ranked).toEqual(["gemini-3.1-pro-preview", "gemini-2.5-pro", "gemini-3.8-flash", "gemini-2.5-flash"]);
  });

  it("prefers a stable release over a preview of the same version", () => {
    expect(rankGeminiModels(["gemini-3-flash-preview", "gemini-3-flash"])[0]).toBe("gemini-3-flash");
  });
});

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

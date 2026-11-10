import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
vi.mock("./llm.js", () => ({
  generateJson: vi.fn(async (system: string, turns: { text: string }[]) => {
    calls.push(system);
    if (system.includes("DÀN Ý")) {
      return {
        value: {
          title: "Bồ Đào Nha *vào tứ kết*",
          description: "Tóm tắt.",
          tags: ["bóng đá"],
          chapters: [
            { title: "Mở đầu", points: ["a"], words: 100 },
            { title: "Diễn biến", points: ["b"], words: 300 },
            { title: "Kết luận", points: ["c"], words: 100 },
          ],
          outro: "Đăng ký kênh nhé.",
        },
        reply: "",
      };
    }
    const n = /CHƯƠNG CẦN VIẾT/.test(turns[0].text) ? 2 : 1;
    return {
      value: {
        scenes: Array.from({ length: n }, (_, i) => ({
          voiceText: `Câu số ${i + 1} của chương.`,
          visual: i === 0 ? "photo" : "video",
          imageQuery: "Ronaldo",
          videoQuery: "football stadium",
          image: "images/01.jpg",
        })),
      },
      reply: "",
    };
  }),
}));

const { generateLongScript } = await import("./long-script.js");

const channel = {
  id: "bd",
  name: "Bóng Đá 24h",
  language: "vi" as const,
  niche: "bóng đá",
  url: "",
  voice: { engine: "edge" as const, edgeVoice: "vi-VN-NamMinhNeural" },
  brandColor: "#112233",
  minutes: 5,
  music: true,
  subtitles: true,
  visuals: "ai" as const,
  aiImageSize: "2K" as const,
  aiHookVideo: false,
  autoUpload: false,
  publishTimes: [],
  privacy: "public" as const,
  categoryId: "22",
  declareSynthetic: true,
};

describe("generateLongScript", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("outlines once, writes every chapter, and assembles a valid long-form script", async () => {
    const script = await generateLongScript(
      [{ title: "Bài", content: "Nội dung", image: null, domain: "vnexpress.net", url: "https://vnexpress.net/a", images: [] }],
      [{ file: "images/01.jpg", width: 1200, height: 800, caption: "", url: "" }],
      { channel, minutes: 5 },
      () => {},
    );
    expect(calls.filter((c) => c.includes("DÀN Ý"))).toHaveLength(1);
    expect(calls).toHaveLength(4); // outline + 3 chapters
    // AI-visual channels: the chapter prompt carries the image-prompt rules as their own lines.
    const chapterSystem = calls.find((c) => !c.includes("DÀN Ý"))!;
    expect(chapterSystem.split("\n").some((l) => l.trim().startsWith("+ TUYỆT ĐỐI KHÔNG đưa vào imagePrompts"))).toBe(true);
    expect(chapterSystem).toContain('"visual": "photo" | "ai"');
    expect(chapterSystem).not.toContain("\\`");
    expect(script.renderer).toBe("slideshow");
    expect(script.chapters.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(script.scenes[0].type).toBe("hook");
    expect(script.scenes.at(-1)).toMatchObject({ id: "outro", type: "outro", chapter: "c3" });
    expect(script.scenes.filter((s) => s.type === "body").length).toBe(script.scenes.length - 2);
    expect(new Set(script.scenes.map((s) => s.id)).size).toBe(script.scenes.length);
    // The article photo goes to one scene only.
    expect(script.scenes.filter((s) => s.inputs.images?.includes("images/01.jpg"))).toHaveLength(1);
    expect(script.voice.override).toEqual(channel.voice);
    expect(script.metadata).toMatchObject({ channel: "Bóng Đá 24h", channelId: "bd", sources: ["https://vnexpress.net/a"] });
    expect(script.style.brandColor).toBe("#112233");
  });

  it("asks for English narration on English channels", async () => {
    await generateLongScript([], [], { channel: { ...channel, language: "en" }, minutes: 5, prompt: "AI chips" }, () => {});
    expect(calls[0]).toMatch(/natural ENGLISH/);
  });
});

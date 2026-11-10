import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nock from "nock";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { fillAiImages, fullPrompt } from "./ai-visuals.js";

let dir: string;
let jpeg: string;

beforeAll(() => {
  process.env.GEMINI_API_KEY = "test-key";
  process.env.GEMINI_IMAGE_MODEL = "gemini-nano-banana-2.1";
  dir = mkdtempSync(join(tmpdir(), "ai-visuals-"));
  const f = join(dir, "sample.jpg");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x180", "-frames:v", "1", f]);
  jpeg = readFileSync(f).toString("base64");
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_IMAGE_MODEL;
});
afterEach(() => nock.cleanAll());

const imageReply = { id: "x", status: "completed", steps: [{ type: "model_output", content: [{ type: "image", data: "", mime_type: "image/jpeg" }] }] };
const verdict = (v: object) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(v) }] } }] });

describe("fillAiImages", () => {
  it("regenerates with the checker's better prompt until the image matches the narration", async () => {
    const prompts: string[] = [];
    nock("https://generativelanguage.googleapis.com")
      .post("/v1beta/interactions", (b) => {
        prompts.push(b.input[0].text);
        return b.model === "gemini-nano-banana-2.1" && b.response_format.aspect_ratio === "16:9" && b.response_format.image_size === "2K";
      })
      .times(2)
      .reply(200, () => ({ ...imageReply, steps: [{ type: "model_output", content: [{ type: "image", data: jpeg, mime_type: "image/jpeg" }] }] }));
    nock("https://generativelanguage.googleapis.com")
      .post(/\/v1beta\/models\/.+:generateContent/)
      .reply(200, verdict({ score: 3, severe: true, defects: ["off-topic: shows a beach"], betterPrompt: "night stadium under floodlights, rain" }))
      .post(/\/v1beta\/models\/.+:generateContent/)
      .reply(200, verdict({ score: 9, severe: false, defects: [] }));

    const scene = { id: "c1-1", voiceText: "Sân vận động chìm trong mưa dưới ánh đèn.", visual: "ai", imagePrompts: ["a stadium"], inputs: {} as Record<string, unknown> };
    const r = await fillAiImages(dir, [scene], { style: "documentary photo", size: "2K" }, () => {});

    expect(r.generated).toBe(2);
    expect(prompts[0]).toContain("a stadium");
    expect(prompts[1]).toContain("night stadium under floodlights, rain"); // second try uses the checker's fix
    expect(prompts[1]).toContain("no text");
    expect(r.images).toHaveLength(1);
    expect(r.images[0].url).toBe("ai:gemini-nano-banana-2.1");
    expect(scene.inputs.images).toEqual([r.images[0].file]);
    expect(existsSync(join(dir, r.images[0].file))).toBe(true);
  });

  it("drops an image that never passes instead of using a wrong one", async () => {
    nock("https://generativelanguage.googleapis.com")
      .post("/v1beta/interactions")
      .times(3)
      .reply(200, () => ({ ...imageReply, steps: [{ type: "model_output", content: [{ type: "image", data: jpeg, mime_type: "image/jpeg" }] }] }));
    nock("https://generativelanguage.googleapis.com")
      .post(/:generateContent/)
      .times(3)
      .reply(200, verdict({ score: 2, severe: true, defects: ["text in image"], betterPrompt: "x" }));
    const scene = { id: "c1-2", voiceText: "abc", visual: "ai", imagePrompts: ["p"], inputs: {} as Record<string, unknown> };
    const r = await fillAiImages(dir, [scene], { style: "", size: "1K" }, () => {});
    expect(r.generated).toBe(3);
    expect(r.images).toHaveLength(0);
    expect(scene.inputs.images).toBeUndefined();
  });

  it("leaves scenes that already have a real photo alone", async () => {
    const scene = { id: "c1-3", voiceText: "abc", visual: "photo", imagePrompts: ["p"], inputs: { images: ["images/01.jpg"] } as Record<string, unknown> };
    const r = await fillAiImages(dir, [scene], { style: "", size: "1K" }, () => {}, { fillEmpty: true });
    expect(r.generated).toBe(0);
  });
});

describe("fullPrompt", () => {
  it("adds style, narration context and the no-text / no-real-people rules", () => {
    const p = fullPrompt("wide shot of a stadium", "muted film look", "Đội nhà thắng.");
    expect(p).toMatch(/^wide shot of a stadium\./);
    expect(p).toContain("Visual style: muted film look.");
    expect(p).toContain('"Đội nhà thắng."');
    expect(p).toMatch(/no text/i);
    expect(p).toMatch(/No recognizable real/);
  });
});

import nock from "nock";
import { afterEach, describe, expect, it } from "vitest";
import { searchStock, stockProviders } from "./stock-video.js";

const file = (width: number, height: number) => ({ url: `https://cdn.pixabay.com/v/${width}.mp4`, width, height, size: 1, thumbnail: "" });

describe("searchStock (Pixabay)", () => {
  afterEach(() => {
    nock.cleanAll();
    delete process.env.PIXABAY_API_KEY;
  });

  it("uses Pixabay when its key is set, keeps ≤1080p landscape files, skips too-short clips", async () => {
    process.env.PIXABAY_API_KEY = "test-key";
    expect(stockProviders()).toEqual(["pixabay"]);
    const q = `stadium crowd ${Date.now()}`; // unique: responses are cached on disk for 24h
    nock("https://pixabay.com")
      .get("/api/videos/")
      .query((p) => p.key === "test-key" && p.q === q)
      .reply(200, {
        hits: [
          // 4K large → falls back to the 1080p medium file
          { id: 1, pageURL: "https://pixabay.com/videos/1", user: "a", duration: 12, videos: { large: file(3840, 2160), medium: file(1920, 1080), small: file(1280, 720) } },
          // portrait only → skipped
          { id: 2, pageURL: "p2", user: "b", duration: 12, videos: { large: file(1080, 1920), medium: file(720, 1280), small: file(540, 960) } },
          // too short → skipped
          { id: 3, pageURL: "p3", user: "c", duration: 2, videos: { large: file(1920, 1080), medium: file(1280, 720), small: file(960, 540) } },
        ],
      });
    const hits = await searchStock(q);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ provider: "pixabay", id: 1, author: "a", file: { width: 1920, height: 1080 } });
  });

  it("returns nothing without any stock key", async () => {
    expect(stockProviders()).toEqual([]);
    expect(await searchStock("city")).toEqual([]);
  });
});

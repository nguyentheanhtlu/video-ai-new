import { afterEach, describe, expect, it, vi } from "vitest";
import { fitTags, fitTitle, nextSlot, type UploadItem } from "./youtube.js";
import type { Channel } from "./channels.js";

const channel = { id: "kenh", publishTimes: ["19:00", "07:00"] } as Channel;

describe("fitTitle", () => {
  it("drops characters YouTube rejects and caps at 100", () => {
    expect(fitTitle("**Bồ Đào Nha** <thắng>  Na Uy")).toBe("Bồ Đào Nha thắng Na Uy");
    const long = fitTitle("a".repeat(150));
    expect(long.length).toBe(100);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("fitTags", () => {
  it("dedupes, strips commas and keeps the list within 500 chars (quotes count for tags with spaces)", () => {
    expect(fitTags(["Bóng đá", "bóng đá", "a,b", "<x>"])).toEqual(["Bóng đá", "a b", "x"]);
    const many = fitTags(Array.from({ length: 100 }, (_, i) => `tag number ${i}`));
    const cost = many.reduce((n, t, i) => n + t.length + 2 + (i ? 1 : 0), 0);
    expect(cost).toBeLessThanOrEqual(500);
    expect(many.length).toBeGreaterThan(10);
  });
});

describe("nextSlot", () => {
  afterEach(() => vi.useRealTimers());
  // 2026-11-10 10:00 in Vietnam = 03:00 UTC
  const now = new Date("2026-11-10T03:00:00Z");

  it("takes the next daily time in Vietnam time", () => {
    vi.useFakeTimers({ now });
    expect(nextSlot(channel, [])).toBe("2026-11-10T12:00:00.000Z"); // 19:00 VN today
  });

  it("skips slots already taken by queued uploads of the same channel", () => {
    vi.useFakeTimers({ now });
    const taken = [{ channelId: "kenh", status: "pending", publishAt: "2026-11-10T12:00:00.000Z" }] as UploadItem[];
    expect(nextSlot(channel, taken)).toBe("2026-11-11T00:00:00.000Z"); // 07:00 VN tomorrow
    const otherChannel = [{ ...taken[0], channelId: "khac" }] as UploadItem[];
    expect(nextSlot(channel, otherChannel)).toBe("2026-11-10T12:00:00.000Z");
  });

  it("has no slot when the channel publishes right away", () => {
    expect(nextSlot({ ...channel, publishTimes: [] }, [])).toBeUndefined();
  });
});

describe("buildComment", () => {
  it("fills {link}, keeps free text, and skips when the link is missing", async () => {
    const { buildComment } = await import("./youtube.js");
    expect(buildComment({ commentTemplate: "🔥 Deal 👉 {link}" }, "https://s.shopee.vn/x")).toBe("🔥 Deal 👉 https://s.shopee.vn/x");
    expect(buildComment({ commentTemplate: "🔥 Deal 👉 {link}" }, undefined)).toBe("");
    expect(buildComment({ commentTemplate: "Inbox page để nhận mã giảm giá" }, undefined)).toBe("Inbox page để nhận mã giảm giá");
    expect(buildComment({ commentTemplate: "  " }, "https://a")).toBe("");
  });
});

import { describe, expect, it } from "vitest";
import { getStyle, SCRIPT_STYLES, styleOverride } from "./script-styles.js";

describe("script styles", () => {
  it("news keeps the original rules untouched", () => {
    expect(styleOverride("news")).toEqual([]);
    expect(styleOverride(undefined)).toEqual([]);
    expect(getStyle("unknown").id).toBe("news");
  });

  it("other styles override the news voice, title and outro", () => {
    for (const s of SCRIPT_STYLES.filter((x) => x.id !== "news")) {
      const block = styleOverride(s.id).join("\n");
      expect(block).toContain("GHI ĐÈ");
      expect(block).toContain("KHÔNG phải tin tức");
      expect(s.rules.some((r) => /^Outro/.test(r))).toBe(true);
    }
  });

  it("affiliate asks for a buy CTA and the affiliate disclosure", () => {
    const block = styleOverride("affiliate").join("\n");
    expect(block).toMatch(/link ở bình luận/);
    expect(block).toContain("link tiếp thị liên kết");
  });
});

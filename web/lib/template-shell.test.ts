import { describe, expect, it } from "vitest";
import { buildTemplateHtml, checkDesign, fontsInCss, normalizeMotion, replaceFonts } from "./template-shell.js";

const html = '<div class="media"></div><h1 class="headline"></h1>';

describe("Vietnamese fonts", () => {
  const css = `.a { font-family: 'Bebas Neue', sans-serif; } .b { font-family: "Inter"; } .c { font-family: Georgia, serif; } .d { font-family: var(--f); }`;

  it("finds the named families", () => {
    expect(fontsInCss(css)).toEqual(["Bebas Neue", "Inter", "Georgia"]);
  });

  it("swaps only fonts without Vietnamese glyphs, keeping heavy ones heavy", () => {
    const out = replaceFonts(css, (f) => f === "Inter");
    expect(out).toContain("font-family: 'Oswald', 'Be Vietnam Pro', sans-serif");
    expect(out).toContain("font-family: 'Inter', 'Be Vietnam Pro', sans-serif");
    expect(out).toContain("font-family: 'Be Vietnam Pro', 'Be Vietnam Pro', sans-serif");
    expect(out).not.toMatch(/Bebas|Georgia/);
    expect(out).toContain("var(--f)");
  });

  it("rejects the font shorthand, which would slip past the check", () => {
    expect(checkDesign({ css: ".a { font: 700 40px Impact; }", html }).join()).toMatch(/font:/);
  });
});

describe("checkDesign", () => {
  it("accepts plain markup and CSS", () => {
    expect(checkDesign({ css: ".headline { color: red; }", html })).toEqual([]);
  });

  it.each([
    ["script tag", ".a{}", `${html}<script>alert(1)</script>`],
    ["event handler", ".a{}", `<div class="media" onclick="x()"></div>`],
    ["remote image", ".a { background: url(https://x.io/a.png); }", html],
    ["image tag", ".a{}", `${html}<img src="https://x.io/a.png">`],
    ["css import", "@import 'https://x.io/a.css';", html],
    ["closing style tag", "</style><script>x</script>", html],
  ])("rejects %s", (_, css, markup) => {
    expect(checkDesign({ css, html: markup }).length).toBeGreaterThan(0);
  });

  it("requires a place for the photos", () => {
    expect(checkDesign({ css: "", html: '<h1 class="headline"></h1>' }).join()).toMatch(/media/);
  });
});

describe("normalizeMotion", () => {
  it("clamps values and drops unknown transitions", () => {
    const m = normalizeMotion({ photoHold: 0.1, subtitleWords: 30, transitions: ["bogus" as never, "whip"] });
    expect(m).toMatchObject({ photoHold: 1.5, subtitleWords: 8, transitions: ["whip"] });
  });

  it("fills in defaults", () => {
    expect(normalizeMotion(undefined).transitions.length).toBeGreaterThan(0);
  });
});

describe("buildTemplateHtml", () => {
  it("produces a dynamic-length composition at the requested size", () => {
    const out = buildTemplateHtml({ fonts: ["Bad'Font", "Anton"], css: "", html, motion: normalizeMotion(undefined) }, { width: 1080, height: 1920 }, "<x>");
    expect(out).toContain('data-duration="6"');
    expect(out).toContain('data-width="1080"');
    expect(out).toContain("family=Anton");
    expect(out).not.toContain("Bad'Font");
    expect(out).not.toContain("__MOTION__");
    expect(out).not.toContain("<x>");
  });
});

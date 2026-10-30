// Turns an AI design (CSS + markup) into a HyperFrames template. The AI never writes
// JavaScript: photos, motion and subtitles come from the fixed runtime below, so a
// generated template can look like anything but always renders the same way.

export const TRANSITIONS = ["flash", "whip", "zoom", "fade", "cut"] as const;

export interface Motion {
  /** Shortest time one photo stays on screen, seconds. */
  photoHold: number;
  transitions: (typeof TRANSITIONS)[number][];
  /** 0 = still photos, 1 = strong Ken Burns. */
  kenBurns: number;
  headlineIn: "rise" | "pop" | "none";
  /** Words on screen at once; 0 hides subtitles. */
  subtitleWords: number;
  /** Colour the word being spoken with the .hl style. */
  subtitleHighlight: boolean;
}

export interface TemplateDesign {
  fonts: string[];
  css: string;
  html: string;
  motion: Motion;
}

export const DEFAULT_MOTION: Motion = {
  photoHold: 3,
  transitions: ["fade"],
  kenBurns: 0.6,
  headlineIn: "rise",
  subtitleWords: 4,
  subtitleHighlight: true,
};

const clamp = (x: unknown, min: number, max: number, fallback: number) => {
  const n = Number(x);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

export function normalizeMotion(raw: Partial<Motion> | undefined): Motion {
  const m = raw ?? {};
  const transitions = (m.transitions ?? []).filter((t) => TRANSITIONS.includes(t));
  return {
    photoHold: clamp(m.photoHold, 1.5, 8, DEFAULT_MOTION.photoHold),
    transitions: transitions.length ? transitions : DEFAULT_MOTION.transitions,
    kenBurns: clamp(m.kenBurns, 0, 1, DEFAULT_MOTION.kenBurns),
    headlineIn: m.headlineIn === "pop" || m.headlineIn === "none" ? m.headlineIn : "rise",
    subtitleWords: Math.round(clamp(m.subtitleWords, 0, 8, DEFAULT_MOTION.subtitleWords)),
    subtitleHighlight: m.subtitleHighlight !== false,
  };
}

/** Problems that make a design unsafe or unrenderable; empty means it can be used. */
export function checkDesign(d: Pick<TemplateDesign, "css" | "html">): string[] {
  const problems: string[] = [];
  const all = `${d.css}\n${d.html}`;
  if (/<\s*(script|iframe|object|embed|link|meta|base|style)\b/i.test(all)) problems.push("Không được dùng thẻ script/iframe/object/embed/link/meta/base/style.");
  if (/\son\w+\s*=/i.test(d.html)) problems.push("Không được dùng thuộc tính sự kiện (onclick…).");
  if (/javascript:|@import|expression\(/i.test(all)) problems.push("Không được dùng javascript:, @import hay expression().");
  if (/url\(\s*['"]?(?!data:|#)/i.test(d.css) || /\b(src|href)\s*=/i.test(d.html)) problems.push("Không được tải tài nguyên ngoài (url(), src, href).");
  if (!/class\s*=\s*["'][^"']*\bmedia\b/.test(d.html)) problems.push('Thiếu phần tử class="media" để hiển thị ảnh.');
  if (/(^|[;{\s])font\s*:/i.test(d.css)) problems.push("Không dùng thuộc tính gộp font:, hãy viết riêng font-family, font-size, font-weight.");
  return problems;
}

const GENERIC_FAMILIES = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "inherit", "initial", "unset"]);
const FALLBACK_FONT = "Be Vietnam Pro";
const DISPLAY_FONT = "Oswald";

/** Every font family the CSS names, without generic keywords. */
export function fontsInCss(css: string): string[] {
  const names = [...css.matchAll(/font-family\s*:\s*([^;}]+)/gi)].flatMap((m) =>
    m[1].split(",").map((f) => f.trim().replace(/^['"]|['"]$/g, "")),
  );
  return [...new Set(names)].filter((f) => f && !GENERIC_FAMILIES.has(f.toLowerCase()) && !f.startsWith("var("));
}

/** Point every font without Vietnamese glyphs at one that has them, so accents never fall back mid-word. */
export function replaceFonts(css: string, hasVietnamese: (font: string) => boolean): string {
  return css.replace(/font-family\s*:\s*([^;}]+)/gi, (_, value: string) => {
    const first = value.split(",")[0].trim().replace(/^['"]|['"]$/g, "");
    if (first.startsWith("var(") || GENERIC_FAMILIES.has(first.toLowerCase())) return `font-family: ${value}`;
    const heavy = /condensed|bebas|impact|anton|narrow|black|league/i.test(first) ? DISPLAY_FONT : FALLBACK_FONT;
    const font = hasVietnamese(first) ? first : heavy;
    return `font-family: '${font}', '${FALLBACK_FONT}', sans-serif`;
  });
}

const FONT_RE = /^[A-Za-z0-9 ]{2,40}$/;

function fontLink(fonts: string[]): string {
  const families = [...new Set([...fonts.filter((f) => FONT_RE.test(f)), "Be Vietnam Pro"])]
    .map((f) => `family=${f.replace(/ /g, "+")}:wght@400;500;700;800;900`)
    .join("&");
  return `<link href="https://fonts.googleapis.com/css2?${families}&display=swap" rel="stylesheet" />`;
}

const BASE_CSS = `
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { overflow: hidden; background: #000; }
#root { position: relative; overflow: hidden; background: #05070a; color: #fff;
  font-family: 'Be Vietnam Pro', system-ui, sans-serif; --brand: #0e9f6e; --hl: #ffd400; }
.media { position: absolute; inset: 0; overflow: hidden; background: #111; }
.slides, .slide { position: absolute; inset: 0; overflow: hidden; }
.slide .blur { position: absolute; left: -40px; top: -40px; width: calc(100% + 80px); height: calc(100% + 80px); object-fit: cover; filter: blur(34px) brightness(.55); }
.slide .ph { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; transform-origin: 50% 45%; will-change: transform; }
.slide .ph.contain { object-fit: contain; }
.flash { position: absolute; inset: 0; z-index: 4; background: #fff; opacity: 0; pointer-events: none; }
.nophoto { position: absolute; inset: 0; background: linear-gradient(160deg, var(--brand), #05070a); }
.headline { overflow: hidden; }
.headline .w { display: inline-block; }
.hl { color: var(--hl); }
`;

const RUNTIME = String.raw`
(function () {
  var M = __MOTION__;
  var v = (window.__hyperframes && typeof window.__hyperframes.getVariables === "function")
    ? window.__hyperframes.getVariables() : {};
  var B = v.__brand || {};
  var root = document.getElementById("root");
  var D = parseFloat(root.getAttribute("data-duration")) || 6;
  var SPEECH = +v.__speech > 0 ? Math.min(+v.__speech, D) : D;
  root.classList.add("is-" + (v.__type || "body"));
  if (B.color) root.style.setProperty("--brand", B.color);
  if (B.accent) root.style.setProperty("--hl", B.accent);
  function $(s) { return root.querySelector(s); }
  function has(x) { return x != null && String(x).trim() !== ""; }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function out3(x) { x = clamp(x, 0, 1); return 1 - Math.pow(1 - x, 3); }
  function inOut(x) { x = clamp(x, 0, 1); return x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; }
  var anims = [];
  function on(fn) { anims.push(fn); }
  function text(sel, value) {
    var el = $(sel);
    if (!el) return;
    if (has(value)) el.textContent = String(value); else el.style.display = "none";
  }

  text(".brand-name", B.name);
  text(".brand-handle", B.handle);
  text(".date", B.date);
  text(".source", has(v.source_credit) ? v.source_credit : B.source);
  text(".caption", v.caption);
  text(".cta", v.__type !== "outro" ? "" : has(v.cta) ? v.cta : (B.labels || {}).follow || "Follow");
  var logo = $(".brand-logo");
  if (logo) {
    if (B.logo) { var li = document.createElement("img"); li.src = B.logo; li.style.cssText = "width:100%;height:100%;object-fit:cover"; logo.appendChild(li); }
    else logo.style.display = "none";
  }

  var OFF = +v.__offset || 0, TOT = +v.__total || D, bar = $(".progress");
  if (bar) on(function (t) { bar.style.width = (clamp((OFF + t) / TOT, 0, 1) * 100) + "%"; });

  /* headline: *phrase* is highlighted; shrinks to fit its box */
  var H = $(".headline");
  /* flex and grid drop the spaces between words, and negative tracking runs letters together */
  function readable(el) {
    if (!el) return;
    var cs = getComputedStyle(el);
    if (/flex|grid/.test(cs.display)) {
      if (cs.justifyContent === "center") el.style.textAlign = "center";
      el.style.display = /inline/.test(cs.display) ? "inline-block" : "block";
    }
    if (parseFloat(cs.letterSpacing) < 0) el.style.letterSpacing = "0";
    el.style.whiteSpace = "normal";
    el.style.wordSpacing = ".08em";
    el.style.overflowWrap = "break-word";
  }
  [H, $(".subtitle"), $(".caption"), $(".cta"), $(".source"), $(".date"), $(".brand-name"), $(".brand-handle")].forEach(readable);
  var MIN_TEXT = 26;
  /* shrink until every word is inside the box; a box too small even then grows, so no text is ever cut */
  function fitHeadline() {
    if (!H) return;
    H.style.fontSize = "";
    H.style.height = "";
    H.style.overflow = "hidden";
    var size = parseFloat(getComputedStyle(H).fontSize);
    var over = function () { return H.scrollHeight > H.clientHeight + 2 || H.scrollWidth > H.clientWidth + 2; };
    while (size > MIN_TEXT && over()) { size -= 2; H.style.fontSize = size + "px"; }
    if (over()) H.style.height = "auto";
    H.style.overflow = "visible";
  }
  if (H) {
    String(has(v.headline) ? v.headline : v.__title || "").split(/(\*[^*]+\*)/).forEach(function (part) {
      if (!part) return;
      var hl = /^\*[^*]+\*$/.test(part);
      part.replace(/^\*|\*$/g, "").split(/(\s+)/).forEach(function (w) {
        if (!w) return;
        if (/^\s+$/.test(w)) { H.appendChild(document.createTextNode(" ")); return; }
        var s = document.createElement("span"); s.className = "w" + (hl ? " hl" : ""); s.textContent = w; H.appendChild(s);
      });
    });
    fitHeadline();
    if (v.__intro && M.headlineIn !== "none") {
      var words = H.querySelectorAll(".w");
      on(function (t) {
        for (var i = 0; i < words.length; i++) {
          var q = out3((t - .1 - i * .04) / .3);
          words[i].style.opacity = q;
          words[i].style.transform = M.headlineIn === "pop" ? "scale(" + (.6 + .4 * q) + ")" : "translateY(" + (30 * (1 - q)) + "px)";
        }
      });
    }
  }

  /* subtitles follow the narration; a word's time is proportional to its length */
  var sub = $(".subtitle");
  var spoken = String(v.__voice || "").split(/\s+/).filter(Boolean);
  if (sub && M.subtitleWords > 0 && spoken.length) {
    var weight = 0, stamps = spoken.map(function (w) { var s = weight; weight += w.length + 2; return s; });
    var perUnit = SPEECH / weight, shown = -1, spans = [];
    var startOf = function (i) { return i >= spoken.length ? SPEECH : stamps[i] * perUnit; };
    on(function (t) {
      var w = 0;
      while (w < spoken.length - 1 && t >= startOf(w + 1)) w++;
      var chunk = Math.floor(w / M.subtitleWords);
      if (chunk !== shown) {
        shown = chunk;
        sub.textContent = "";
        spans = spoken.slice(chunk * M.subtitleWords, (chunk + 1) * M.subtitleWords).map(function (word) {
          var s = document.createElement("span"); s.textContent = word + " "; sub.appendChild(s); return s;
        });
        /* a long word or chunk must stay on screen, whole */
        var maxW = root.clientWidth - 80, maxH = root.clientHeight * .3;
        sub.style.fontSize = "";
        sub.style.maxWidth = maxW + "px";
        var size = parseFloat(getComputedStyle(sub).fontSize);
        while (size > MIN_TEXT && (sub.offsetWidth > maxW || sub.scrollWidth > sub.clientWidth + 2 || sub.offsetHeight > maxH)) { size -= 2; sub.style.fontSize = size + "px"; }
      }
      var pop = out3((t - startOf(chunk * M.subtitleWords)) / .12);
      sub.style.opacity = t > SPEECH + .1 ? 0 : 1;
      sub.style.transform = "scale(" + (.9 + .1 * pop) + ")";
      spans.forEach(function (s, i) { s.className = M.subtitleHighlight && i === w % M.subtitleWords ? "hl" : ""; });
    });
  } else if (sub) sub.style.display = "none";

  /* photos: each holds at least M.photoHold, moving, with the template's cuts */
  var FX = M.transitions, MEDIA = $(".media");
  function slides(list) {
    var box = document.createElement("div"); box.className = "slides"; MEDIA.insertBefore(box, MEDIA.firstChild);
    if (!list.length) { var np = document.createElement("div"); np.className = "nophoto"; box.appendChild(np); return; }
    list = list.slice(0, Math.max(1, Math.min(list.length, Math.floor(D / M.photoHold))));
    var n = list.length, seg = D / n, idx = +v.__index || 0;
    var flash = document.createElement("div"); flash.className = "flash"; MEDIA.appendChild(flash);
    list.forEach(function (url, i) {
      var s = document.createElement("div"); s.className = "slide";
      var bl = document.createElement("img"); bl.className = "blur"; bl.src = url;
      var im = document.createElement("img"); im.className = "ph"; im.src = url;
      if (has(v.focus)) im.style.objectPosition = String(v.focus);
      s.appendChild(bl); s.appendChild(im); box.appendChild(s);
      var shape = function () {
        if (!im.naturalWidth) return;
        var ratio = (im.naturalWidth / im.naturalHeight) / (MEDIA.clientWidth / MEDIA.clientHeight);
        if (ratio < .45 || ratio > 3.2) im.classList.add("contain");
      };
      if (im.complete) shape(); else im.addEventListener("load", shape);
      var moves = ["in-left", "out-right", "in-right", "up"], move = moves[(i + idx) % moves.length];
      var fx = FX[(i + idx) % FX.length], start = i * seg, dur = fx === "cut" ? 0.01 : .5;
      on(function (t) {
        var local = t - start;
        s.style.visibility = (local >= -0.001 && t < start + seg + .55) || (i === n - 1 && local >= 0) ? "visible" : "hidden";
        if (local < 0) { s.style.opacity = 0; return; }
        var e = out3(i === 0 ? 1 : local / dur), tx = 0, extra = 0, blur = 0, op = 1;
        if (i > 0) {
          if (fx === "whip") { tx = (1 - e) * 100; blur = (1 - e) * 14; }
          else if (fx === "zoom") { extra = (1 - e) * .35; blur = (1 - e) * 18; op = e; }
          else if (fx === "fade") { op = e; }
        }
        s.style.opacity = op;
        s.style.transform = "translateX(" + tx + "%)";
        s.style.filter = blur > .2 ? "blur(" + blur + "px)" : "none";
        var drift = inOut(local / (seg + dur)), k = M.kenBurns;
        var sc = 1 + k * (.06 + .12 * (1 - out3(local / .55)) + .08 * drift) + extra, x = 0, y = 0;
        if (move === "in-left") x = (drift - .5) * 3 * k;
        else if (move === "in-right") x = (.5 - drift) * 3 * k;
        else if (move === "up") y = (.5 - drift) * 2.5 * k;
        im.style.transform = "translate(" + x + "%," + y + "%) scale(" + sc + ")";
      });
    });
    on(function (t) {
      var a = 0;
      for (var i = 1; i < n; i++) {
        if (FX[(i + idx) % FX.length] !== "flash") continue;
        var l = t - i * seg;
        if (l >= 0 && l < .3) a = Math.max(a, .85 * (1 - out3(l / .3)));
      }
      flash.style.opacity = a;
    });
  }
  var list = (Array.isArray(v.images) ? v.images : []).filter(has);
  if (!list.length && has(v.image)) list = [v.image];
  slides(list.slice(0, 6));

  function render(t) { for (var i = 0; i < anims.length; i++) anims[i](t); }
  render(0);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { fitHeadline(); render(0); });
  window.__timelines = window.__timelines || {};
  window.__timelines["main"] = { pause: function () {}, seek: function (t) { render(t || 0); }, paused: function () { return true; } };
})();
`;

const VARIABLES = { image: "", images: [], caption: "", headline: "", cta: "", source_credit: "", focus: "", __title: "", __voice: "", __speech: 0, __type: "body", __brand: {}, __intro: false, __index: 0, __offset: 0, __total: 0 };

export function buildTemplateHtml(d: TemplateDesign, size: { width: number; height: number }, title: string): string {
  const safeTitle = title.replace(/[<>&]/g, "");
  const vars = JSON.stringify(VARIABLES).replace(/'/g, "&#39;");
  const motion = JSON.stringify(d.motion).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=${size.width}, height=${size.height}" />
<title>${safeTitle}</title>
${fontLink(d.fonts)}
<style>
html, body, #root { width: ${size.width}px; height: ${size.height}px; }
${BASE_CSS}
/* AI design */
${d.css}
/* Stacked Vietnamese accents (Ệ, Ẩ) need the room, whatever the design chose. */
.headline, .subtitle { line-height: 1.3 !important; }
.headline { padding-top: .1em; padding-bottom: .12em; }
.subtitle { overflow: visible !important; }
</style>
</head>
<body>
  <div
    id="root"
    data-composition-id="main"
    data-start="0"
    data-duration="6"
    data-width="${size.width}"
    data-height="${size.height}"
    data-composition-variables='${vars}'
  >
${d.html}
  </div>
  <script>${RUNTIME.replace("__MOTION__", () => motion)}</script>
</body>
</html>
`;
}

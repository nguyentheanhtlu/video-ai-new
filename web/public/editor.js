import {
  api, bust, clear, confirmBox, el, estSec, fmtDate, fmtSec, guard, jobLogModal, jobs, liveLog,
  onJob, onYoutube, openModal, playTts, playUrl, progressBar, statusChip, toast, waitJob, wordCount, UPLOAD_STATUS, fmtVN,
} from "./lib.js";
import { store } from "./store.js";

const TYPES = [["hook", "Hook (mở đầu)"], ["body", "Body (nội dung)"], ["outro", "Outro (kết)"]];
const LEVELS = [["danger", "danger · đỏ"], ["warn", "warn · vàng"], ["good", "good · xanh lá"], ["info", "info · xanh dương"]];
const EMOJI_RE = /\p{Extended_Pictographic}/u;
const HEX_RE = /^#[0-9a-f]{3,8}$/i;

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

// ── Client-side lint (instant feedback; mirrors web/lib/projects.ts) ───────
function lintScene(scene, tpl) {
  const out = [];
  const v = scene.voiceText ?? "";
  if (!v.trim()) out.push({ err: true, msg: "Chưa có lời đọc (voiceText)." });
  if (/\d/.test(v)) out.push({ msg: "Lời đọc có chữ số — nên viết ra chữ (vd \"mười bảy\", \"hai trăm megapixel\")." });
  if (EMOJI_RE.test(v)) out.push({ msg: "Lời đọc có emoji — hãy bỏ (emoji chỉ dùng trong chữ hiển thị)." });
  if (/https?:\/\/|www\./i.test(v)) out.push({ msg: "Lời đọc có URL — không nên đọc URL." });
  if (/[→&%$#+=]/.test(v)) out.push({ msg: "Lời đọc có ký hiệu → & % $ # + = — nên viết ra chữ." });
  if (v.trim() && !/[.?!…]$/.test(v.trim())) out.push({ msg: "Nên kết câu bằng dấu . hoặc ? để ngắt nghỉ tự nhiên." });
  if (!tpl) out.push({ err: true, msg: `Không có template "${scene.templateId}".` });
  else if (!tpl.roles.includes(scene.type)) out.push({ msg: `Template này thường dùng cho ${tpl.roles.join("/")}, không phải ${scene.type}.` });
  return out;
}

function lintScript(script) {
  const errs = [];
  const n = script.scenes.length;
  if (n < 3) errs.push("Cần ít nhất 3 scene.");
  const maxScenes = script.renderer === "slideshow" ? 250 : 12;
  if (n > maxScenes) errs.push(`Tối đa ${maxScenes} scene.`);
  if (script.scenes[0]?.type !== "hook") errs.push("Scene đầu tiên phải là hook.");
  if (script.scenes[n - 1]?.type !== "outro") errs.push("Scene cuối cùng phải là outro.");
  const ids = new Set();
  for (const s of script.scenes) {
    if (!/^[a-zA-Z0-9_-]+$/.test(s.id)) errs.push(`Id "${s.id}" chỉ được dùng chữ, số, - và _.`);
    if (ids.has(s.id)) errs.push(`Trùng id "${s.id}".`);
    ids.add(s.id);
  }
  if (!script.metadata?.title?.trim()) errs.push("Thiếu tiêu đề.");
  return errs;
}

// ── Generic input widgets built from template defaults + catalog slots ─────
function counter(input, max) {
  const c = el("em");
  const upd = () => {
    const len = input.value.length;
    c.textContent = max ? `${len}/${max}` : "";
    input.classList.toggle("over", !!max && len > max);
  };
  input.addEventListener("input", upd);
  upd();
  return c;
}

function colorField(value, fallback, onChange) {
  const text = el("input", { type: "text", value: value ?? "", placeholder: fallback ?? "#rrggbb" });
  const pick = el("input", { type: "color", value: HEX_RE.test(value ?? "") && value.length === 7 ? value : HEX_RE.test(fallback ?? "") && fallback.length === 7 ? fallback : "#8b5cf6" });
  pick.oninput = () => { text.value = pick.value; onChange(pick.value); };
  text.oninput = () => {
    if (HEX_RE.test(text.value) && text.value.length === 7) pick.value = text.value;
    onChange(text.value.trim() || undefined);
  };
  return el("div", { class: "color-field" }, pick, text);
}

function isColorKey(key, value, slot) {
  return /(^|_)(from|to)$/.test(key) || slot?.limit === "hex" || (typeof value === "string" && HEX_RE.test(value));
}

// ── Photo pickers (project images live in output/<slug>/images/) ──────────
const imgState = { slug: "", images: [], videos: [], onChange: null };
const imgUrl = (file) => `/files/${imgState.slug}/${file}`;

function thumb(file, extra = {}) {
  return el("img", { src: imgUrl(file), alt: file, loading: "lazy", ...extra,
    style: { width: "88px", height: "88px", objectFit: "cover", borderRadius: "8px", border: "1px solid var(--line-2)", ...(extra.style ?? {}) } });
}

/** Modal grid of the project's photos. multi → pick up to `max` in order. */
function pickImages(current, { multi, max = 3 }) {
  return new Promise((resolve) => {
    let picked = [...current];
    let done = false;
    const grid = el("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: "10px" } });
    const draw = () => clear(grid, imgState.images.length === 0
      ? el("div", { class: "muted", style: { gridColumn: "1/-1" } }, "Dự án chưa có ảnh. Thêm ảnh ở tab 🖼 Ảnh.")
      : imgState.images.map((im) => {
        const n = picked.indexOf(im.file);
        return el("button", {
          class: "card tight", title: im.caption || im.file,
          style: { padding: "6px", cursor: "pointer", position: "relative", borderColor: n >= 0 ? "var(--accent)" : "", boxShadow: n >= 0 ? "0 0 0 2px var(--accent)" : "" },
          onclick: () => {
            if (!multi) return finish([im.file]);
            if (n >= 0) picked.splice(n, 1); else if (picked.length < max) picked.push(im.file);
            draw();
          },
        },
        el("img", { src: imgUrl(im.file), style: { width: "100%", aspectRatio: "4/3", objectFit: "cover", borderRadius: "6px", display: "block" } }),
        n >= 0 && multi ? el("span", { class: "chip accent", style: { position: "absolute", top: "10px", left: "10px" } }, n + 1) : null,
        el("div", { class: "small muted", style: { marginTop: "4px", textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, im.caption || im.file));
      }));
    const finish = (v) => { done = true; close(); resolve(v); };
    draw();
    const close = openModal(multi ? `Chọn tối đa ${max} ảnh (theo thứ tự hiển thị)` : "Chọn ảnh cho scene", grid, [
      el("button", { class: "btn sm", onclick: () => finish([]) }, "Không dùng ảnh"),
      multi ? el("button", { class: "btn sm primary", onclick: () => finish(picked) }, "Xong") : null,
    ]);
    const obs = new MutationObserver(() => {
      if (document.getElementById("modal").classList.contains("hidden")) { obs.disconnect(); if (!done) resolve(null); }
    });
    obs.observe(document.getElementById("modal"), { attributes: true });
  });
}

function imageEditor(value, onChange, multi) {
  const box = el("div", { class: "row", style: { alignItems: "flex-start" } });
  let cur = multi ? (Array.isArray(value) ? value : []) : value ? [value] : [];
  const draw = () => clear(box,
    cur.length ? cur.map((f) => thumb(f)) : el("div", { class: "clip-box", style: { width: "88px", height: "88px", aspectRatio: "auto", fontSize: "11px" } }, "Chưa có ảnh"),
    el("div", { class: "stack", style: { gap: "6px" } },
      el("button", { class: "btn sm", onclick: async () => {
        const r = await pickImages(cur, { multi });
        if (r === null) return;
        cur = r;
        onChange(multi ? (cur.length ? cur : undefined) : cur[0]);
        draw();
      } }, multi ? "Chọn nhiều ảnh" : "Chọn ảnh"),
      cur.length ? el("button", { class: "btn ghost sm", onclick: () => { cur = []; onChange(undefined); draw(); } }, "Bỏ ảnh") : null));
  draw();
  return box;
}

/** Stock clips of a long-video scene: preview, reorder-free remove, pick from the project's clips. */
function videoEditor(value, onChange) {
  const box = el("div", { class: "stack", style: { gap: "8px" } });
  let cur = Array.isArray(value) ? [...value] : [];
  const pick = () => new Promise((resolve) => {
    const grid = el("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "10px" } },
      imgState.videos.length === 0
        ? el("div", { class: "muted" }, "Dự án chưa có video. Bấm \"🎞 Tìm video\" ở cảnh để tải từ Pixabay.")
        : imgState.videos.map((v) => el("button", { class: "card tight", style: { padding: "6px", cursor: "pointer" }, onclick: () => { close(); resolve(v.file); } },
          el("video", { src: imgUrl(v.file), muted: true, preload: "metadata", style: { width: "100%", aspectRatio: "16/9", objectFit: "cover", borderRadius: "6px" } }),
          el("div", { class: "small muted", style: { textAlign: "left" } }, `${v.query} · ${Math.round(v.duration)}s`))));
    const close = openModal("Chọn video cho cảnh", grid, []);
  });
  const draw = () => clear(box,
    el("div", { class: "row", style: { alignItems: "flex-start", flexWrap: "wrap" } },
      cur.length ? cur.map((f, i) => el("div", { class: "stack", style: { gap: "4px", width: "160px" } },
        el("video", { src: imgUrl(f), muted: true, loop: true, preload: "metadata", onmouseenter: (e) => e.target.play(), onmouseleave: (e) => e.target.pause(),
          style: { width: "160px", aspectRatio: "16/9", objectFit: "cover", borderRadius: "8px", border: "1px solid var(--line-2)" } }),
        el("button", { class: "btn ghost sm", onclick: () => { cur.splice(i, 1); onChange(cur.length ? cur : undefined); draw(); } }, "Bỏ"))) : el("span", { class: "small faint" }, "Không có video — cảnh dùng ảnh"),
      el("button", { class: "btn sm", onclick: async () => {
        const f = await pick();
        if (!f || cur.includes(f)) return;
        cur.push(f);
        onChange(cur);
        draw();
      } }, "+ Thêm video")));
  draw();
  return box;
}

/**
 * Build an editor for one value. `sample` is the template's default for this key
 * (tells us the shape when the scene has no value yet).
 */
function valueEditor(key, value, sample, slot, onChange) {
  const shape = value !== undefined ? value : sample;
  const t = slot?.type ?? "";
  if (t === "video[]" || key === "videos") return { node: videoEditor(value, onChange), wide: true, hint: "chiếu trước ảnh" };
  if (t === "image" || key === "image") return { node: imageEditor(value, onChange, false), wide: true };
  if (t === "image[]" || key === "images") return { node: imageEditor(value, onChange, true), wide: true, hint: "slideshow 2–3 ảnh" };

  // Array of strings → one line per entry
  if ((Array.isArray(shape) && shape.every((x) => typeof x === "string")) || t === "string[]") {
    const ta = el("textarea", { rows: Math.max(2, (value ?? sample ?? []).length || 2), placeholder: (sample ?? []).join("\n") },
    );
    ta.value = (value ?? []).join("\n");
    ta.oninput = () => {
      const lines = ta.value.split("\n").map((l) => l.trim()).filter(Boolean);
      onChange(lines.length ? lines : undefined);
    };
    return { node: ta, wide: true, hint: "mỗi dòng một mục" };
  }

  // Array of objects → repeater
  if (Array.isArray(shape) || t === "object[]") {
    const itemSample = (Array.isArray(sample) && sample[0]) || (Array.isArray(value) && value[0]) || {};
    let items = clone(value ?? []);
    const box = el("div", { class: "stack", style: { gap: "8px" } });
    const commit = () => onChange(items.length ? items : undefined);
    const draw = () => {
      clear(box,
        items.map((item, i) =>
          el("div", { class: "obj-box" },
            el("div", { class: "obj-head" }, `Mục ${i + 1}`,
              el("div", { class: "row", style: { gap: "4px" } },
                el("button", { class: "btn ghost icon sm", title: "Lên", disabled: i === 0, onclick: () => { [items[i - 1], items[i]] = [items[i], items[i - 1]]; commit(); draw(); } }, "↑"),
                el("button", { class: "btn ghost icon sm", title: "Xuống", disabled: i === items.length - 1, onclick: () => { [items[i + 1], items[i]] = [items[i], items[i + 1]]; commit(); draw(); } }, "↓"),
                el("button", { class: "btn ghost icon sm danger", title: "Xoá mục", onclick: () => { items.splice(i, 1); commit(); draw(); } }, "✕"),
              )),
            objectFields(item, itemSample, (k, v) => {
              if (v === undefined) delete item[k]; else item[k] = v;
              commit();
            }),
          )),
        el("button", {
          class: "btn sm", onclick: () => {
            const base = clone(items[items.length - 1] ?? itemSample);
            items.push(base);
            commit();
            draw();
          },
        }, "+ Thêm mục"),
      );
    };
    draw();
    return { node: box, wide: true };
  }

  // Plain object → nested fields
  if (shape && typeof shape === "object") {
    let obj = clone(value ?? {});
    const box = el("div", { class: "obj-box" },
      objectFields(obj, sample ?? {}, (k, v) => {
        if (v === undefined) delete obj[k]; else obj[k] = v;
        onChange(Object.keys(obj).length ? obj : undefined);
      }));
    return { node: box, wide: true };
  }

  if (typeof shape === "boolean" || key === "win") {
    const cb = el("input", { type: "checkbox", checked: !!value });
    cb.onchange = () => onChange(cb.checked || undefined);
    return { node: el("label", { class: "check" }, cb, "Bật") };
  }

  if (typeof shape === "number" || t === "number") {
    const inp = el("input", { type: "number", value: value ?? "", placeholder: sample ?? "" });
    inp.oninput = () => onChange(inp.value === "" ? undefined : Number(inp.value));
    return { node: inp };
  }

  if (key === "level") {
    const sel = el("select", {}, el("option", { value: "" }, "— mức độ —"), LEVELS.map(([v, l]) => el("option", { value: v }, l)));
    sel.value = value ?? "";
    sel.onchange = () => onChange(sel.value || undefined);
    return { node: sel };
  }

  if (isColorKey(key, shape, slot)) return { node: colorField(value, sample, onChange) };

  const max = slot?.max ?? null;
  const long = (max ?? 0) > 70 || String(value ?? sample ?? "").length > 70;
  const inp = long ? el("textarea", { rows: 2, placeholder: sample ?? "" }) : el("input", { type: "text", placeholder: sample ?? "" });
  inp.value = value ?? "";
  inp.oninput = () => onChange(inp.value === "" ? undefined : inp.value);
  return { node: inp, wide: long, counter: counter(inp, max) };
}

function objectFields(obj, sample, onField) {
  const keys = [...new Set([...Object.keys(sample ?? {}), ...Object.keys(obj ?? {})])];
  return el("div", { class: "obj-grid" },
    keys.map((k) => {
      const ed = valueEditor(k, obj[k], sample?.[k], null, (v) => onField(k, v));
      return el("label", { class: "field", style: ed.wide ? { gridColumn: "1 / -1" } : {} },
        el("span", {}, k, ed.counter ?? (ed.hint ? el("em", {}, ed.hint) : null)), ed.node);
    }));
}

function inputsForm(scene, tpl, onChange) {
  const slots = tpl?.slots ?? [];
  const defaults = tpl?.defaults ?? {};
  const keys = [...new Set([...slots.map((s) => s.name), ...Object.keys(defaults), ...Object.keys(scene.inputs ?? {})])];
  // Rarely-needed slots (catalog marks them optional) go under a fold so the
  // scene card shows just the photo — the headline is set once for the video.
  const LABELS = { image: "Ảnh của scene", images: "Nhiều ảnh (slideshow)", caption: "Chú thích trên ảnh", headline: "Tiêu đề riêng cho scene này", source_credit: "Ghi nguồn riêng", focus: "Điểm lấy nét ảnh (vd 50% 20%)", cta: "Nút kêu gọi" };
  const isAdvanced = (k) => { const sl = slots.find((s) => s.name === k); return (k === "images" && tpl?.id !== "slideshow") || /optional|usually leave/i.test(sl?.notes ?? ""); };
  const field = (k) => {
      const slot = slots.find((s) => s.name === k);
      const ed = valueEditor(k, scene.inputs?.[k], defaults[k], slot, (v) => {
        scene.inputs ??= {};
        if (v === undefined) delete scene.inputs[k]; else scene.inputs[k] = v;
        onChange();
      });
      const title = slot ? `${slot.type}${slot.limit ? ` · ${slot.limit}` : ""}${slot.notes ? ` — ${slot.notes}` : ""}` : "";
      return el("label", { class: `field ${ed.wide ? "wide" : ""}`, title },
        el("span", {}, el("b", { style: { fontWeight: 500 } }, LABELS[k] ?? k), ed.counter ?? (ed.hint ? el("em", {}, ed.hint) : slot?.limit ? el("em", {}, slot.limit) : null)),
        ed.node);
  };
  const main = keys.filter((k) => !isAdvanced(k));
  const adv = keys.filter(isAdvanced);
  const advUsed = adv.some((k) => scene.inputs?.[k] != null && scene.inputs[k] !== "");
  return el("div", { class: "stack", style: { gap: "10px" } },
    el("div", { class: "inputs-grid" }, main.map(field)),
    adv.length ? el("details", { open: advUsed },
      el("summary", {}, `Tuỳ chọn thêm (${adv.length}) — ít dùng`),
      el("div", { class: "inputs-grid", style: { marginTop: "10px" } }, adv.map(field))) : null);
}

// ── The editor view ────────────────────────────────────────────────────────
export async function projectView(root, slug, ctx) {
  const [project, templates, sfxLib] = await Promise.all([
    api("GET", `/api/projects/${slug}`),
    store.templates(),
    store.sfx(),
  ]);
  const tplById = (id) => templates.find((t) => t.id === id);

  let script = clone(project.script);
  let saved = JSON.stringify(script);
  let proj = project;
  imgState.slug = slug;
  imgState.images = proj.images ?? [];
  imgState.videos = proj.videos ?? [];
  const long = script.renderer === "slideshow";
  const wps = long && script.language === "en" ? 2.5 : 3.6;
  // Long videos only use the slideshow scene; template videos never see it.
  const pickable = templates.filter((t) => (long ? t.id === "slideshow" : !t.virtual));
  let tab = proj.files.includes("video.mp4") ? "result" : "script";
  let sfxPlan = [];
  const collapsed = new Set();
  const disposers = [];

  const isDirty = () => JSON.stringify(script) !== saved;
  ctx.setGuard(() => isDirty() ? "Kịch bản có thay đổi chưa lưu. Rời trang?" : null);

  const refreshPlan = () => api("GET", `/api/projects/${slug}/sfx-plan`).then((p) => { sfxPlan = p; drawScenes(); }).catch(() => {});

  // ── header ──
  const saveBtn = el("button", { class: "btn", onclick: () => save() }, "💾 Lưu");
  const renderBtn = el("button", { class: "btn primary", onclick: () => render() }, "▶ Render video");
  const dirtyChip = el("span", { class: "chip warn hidden" }, el("span", { class: "dot" }), "Chưa lưu");
  const titleInput = el("input", {
    type: "text", value: script.metadata.title,
    style: { fontSize: "20px", fontWeight: 700, background: "transparent", border: "1px solid transparent", padding: "4px 8px", marginLeft: "-8px" },
    oninput: (e) => { script.metadata.title = e.target.value; markDirty(); },
  });

  const header = el("div", { class: "page-head" },
    el("div", { class: "grow" },
      titleInput,
      el("div", { class: "row small muted", style: { marginTop: "4px" } },
        el("span", { class: "mono" }, slug), dirtyChip,
        el("span", {}, `Tạo ${fmtDate(proj.meta.createdAt)}`),
      )),
    el("div", { class: "row" },
      el("span", { class: "kbd", title: "Phím tắt lưu" }, "Ctrl+S"),
      saveBtn, renderBtn,
      el("button", { class: "btn ghost", title: "Nhân bản dự án", onclick: duplicate }, "⧉"),
      el("button", { class: "btn ghost danger", title: "Xoá dự án", onclick: remove }, "🗑"),
    ));

  const tabsEl = el("div", { class: "tabs" });
  const body = el("div");
  clear(root, header, tabsEl, body);

  function drawTabs() {
    const items = [["script", "✏️ Kịch bản"], ["images", `🖼 Ảnh (${imgState.images.length})`], ["result", "🎬 Kết quả"], ["json", "{ } JSON"]];
    if (proj.files.includes("source.txt")) items.push(["source", "📰 Bài gốc"]);
    clear(tabsEl, items.map(([k, label]) =>
      el("button", { class: tab === k ? "active" : "", onclick: () => { if (tab === "json" && k !== "json" && !applyJson()) return; tab = k; drawTabs(); drawBody(); } }, label)));
  }

  function markDirty() {
    dirtyChip.classList.toggle("hidden", !isDirty());
  }

  // ── scenes tab ──
  const scenesBox = el("div", { class: "stack" });
  const sideBox = el("div", { class: "side-sticky" });
  const errBox = el("div");

  function drawBody() {
    disposers.splice(0).forEach((d) => d());
    if (tab === "script") {
      clear(body, el("div", { class: "editor" },
        el("div", { class: "stack" }, metaCard(), errBox, scenesBox),
        sideBox));
      drawScenes();
      drawSide();
    } else if (tab === "result") {
      clear(body, resultView());
    } else if (tab === "images") {
      clear(body, imagesView());
    } else if (tab === "json") {
      clear(body, jsonView());
    } else if (tab === "source") {
      const pre = el("div", { class: "log", style: { maxHeight: "70vh", fontFamily: "inherit", fontSize: "14px" } }, "Đang tải…");
      fetch(bust(`/files/${slug}/source.txt`)).then((r) => r.text()).then((t) => { pre.textContent = t; });
      clear(body, el("div", { class: "card" }, pre));
    }
  }

  function longMetaCard() {
    const f = (label, input, hint) => el("label", { class: "field" }, el("span", {}, label, hint ? el("em", {}, hint) : null), input);
    const md = script.metadata;
    script.style ??= {};
    const title = el("input", { type: "text", value: md.title, style: { fontWeight: 700 }, oninput: (e) => { md.title = e.target.value; titleInput.value = e.target.value; markDirty(); } });
    const desc = el("textarea", { rows: 4, oninput: (e) => { md.description = e.target.value; markDirty(); } });
    desc.value = md.description ?? "";
    const tags = el("input", { type: "text", value: (md.tags ?? []).join(", "), placeholder: "tag1, tag2, …",
      oninput: (e) => { md.tags = e.target.value.split(",").map((t) => t.trim()).filter(Boolean); markDirty(); } });
    const toggle = (key, label) => el("label", { class: "check" },
      el("input", { type: "checkbox", checked: script.style[key] !== false, onchange: (e) => { script.style[key] = e.target.checked; markDirty(); } }), label);
    return el("div", { class: "card tight stack" },
      el("div", { class: "row small muted" },
        el("span", { class: "chip accent" }, "Video dài 16:9"),
        el("span", {}, `Kênh: ${md.channel}`),
        el("span", {}, script.language === "en" ? "🇬🇧 Tiếng Anh" : "🇻🇳 Tiếng Việt"),
        script.voice?.override ? el("span", {}, `Giọng: ${script.voice.override.engine === "genmax" ? `Genmax ${script.voice.override.genmax?.provider ?? ""}` : script.voice.override.edgeVoice}`) : null),
      f("Tiêu đề YouTube", title, "≤ 100 ký tự, *từ khoá* chỉ dùng cho thumbnail"),
      f("Mô tả", desc, "chương, nguồn và tag được thêm tự động khi render"),
      f("Tags", tags),
      el("div", { class: "row" }, toggle("subtitles", "In phụ đề lên video"), toggle("music", "Nhạc nền")));
  }

  function metaCard() {
    if (long) return longMetaCard();
    const f = (label, input) => el("label", { class: "field" }, el("span", {}, label), input);
    const aspect = el("div", { class: "seg" }, ["9:16", "16:9"].map((a) =>
      el("button", { class: script.aspect === a ? "active" : "", onclick: (e) => {
        script.aspect = a;
        e.currentTarget.parentElement.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.textContent.startsWith(a)));
        markDirty();
        drawScenes();
      } }, a === "9:16" ? "9:16 dọc (TikTok/Shorts)" : "16:9 ngang (YouTube)")));
    // The headline is the only text on screen for the whole video — give it the spotlight.
    const titleTa = el("textarea", { rows: 2, style: { fontSize: "18px", fontWeight: 700, textTransform: "uppercase", lineHeight: 1.35 },
      placeholder: "Tiêu đề bài báo — hiển thị suốt video" });
    titleTa.value = script.metadata.title ?? "";
    const titleCount = el("em");
    const preview = el("div", { class: "small", style: { lineHeight: 1.5 } });
    const drawTitle = () => {
      const len = titleTa.value.replace(/\*/g, "").length;
      titleCount.textContent = `${len}/120`;
      titleTa.classList.toggle("over", len > 120);
      clear(preview, "Hiển thị: ", titleTa.value.split(/(\*[^*]+\*)/).filter(Boolean).map((p) =>
        /^\*[^*]+\*$/.test(p) ? el("b", { style: { color: "#ffd400", textTransform: "uppercase" } }, p.slice(1, -1)) : el("span", { style: { textTransform: "uppercase" } }, p)));
    };
    titleTa.oninput = () => { script.metadata.title = titleTa.value; titleInput.value = titleTa.value; markDirty(); drawTitle(); };
    drawTitle();
    return el("div", { class: "card tight stack" },
      el("label", { class: "field" },
        el("span", {}, el("b", { style: { color: "var(--text)" } }, "📰 Tiêu đề trên video"), titleCount),
        titleTa),
      el("div", { class: "row between" }, preview,
        el("span", { class: "small faint" }, "Bọc cụm từ khoá trong *dấu sao* để tô màu nổi bật")),
      el("div", { class: "grid-2" },
        f("Ngày đăng (hiển thị trên video)", el("input", { type: "text", value: script.metadata.date ?? "", placeholder: "dd/mm/yyyy", oninput: (e) => { script.metadata.date = e.target.value || undefined; markDirty(); } })),
        f("Nguồn (URL bài gốc)", el("input", { type: "text", value: script.metadata.source?.url ?? "", oninput: (e) => {
          script.metadata.source ??= { url: "", domain: "local", image: null };
          script.metadata.source.url = e.target.value;
          try { script.metadata.source.domain = e.target.value ? new URL(e.target.value).hostname : "local"; } catch { /* keep */ }
          markDirty();
        } })),
      ),
      el("div", { class: "row between" }, el("span", { class: "small muted" }, "Khung hình"), aspect));
  }

  function drawErrors() {
    const errs = lintScript(script);
    const oldTemplates = script.scenes.some((s) => !tplById(s.templateId));
    clear(errBox,
      oldTemplates ? el("div", { class: "callout warn stack", style: { marginBottom: "10px" } },
        el("b", {}, "Dự án này dùng template cũ đã bị bỏ."),
        el("div", { class: "row" },
          el("span", { class: "small" }, "Chuyển toàn bộ scene sang khung tin của kênh (tự lấy ảnh từ bài gốc nếu có):"),
          el("button", { class: "btn primary sm", onclick: async (e) => {
            e.currentTarget.disabled = true;
            const fresh = await guard(() => api("POST", `/api/projects/${slug}/migrate`), "Đã chuyển sang khung kênh");
            proj = fresh;
            imgState.images = fresh.images ?? [];
            script = clone(fresh.script);
            saved = JSON.stringify(script);
            drawTabs();
            drawBody();
          } }, "↻ Chuyển sang khung kênh"))) : null,
      errs.length
        ? el("div", { class: "callout bad" }, el("b", {}, "Kịch bản chưa render được:"), el("ul", { style: { margin: "6px 0 0", paddingLeft: "18px" } }, errs.map((e) => el("li", {}, e))))
        : null);
    renderBtn.disabled = errs.length > 0 || isActive();
  }

  function sceneCache(id) {
    return proj.sceneCache.find((c) => c.id === id) ?? {};
  }

  function drawScenes() {
    if (tab !== "script") return;
    drawErrors();
    clear(scenesBox,
      script.scenes.map((s, i) => [
        long && s.chapter && s.chapter !== script.scenes[i - 1]?.chapter ? chapterHead(s.chapter) : null,
        sceneCard(s, i),
      ]),
      el("div", { class: "add-scene" },
        el("button", { class: "btn", onclick: () => addScene("body") }, "+ Thêm scene nội dung"),
        el("button", { class: "btn ghost", onclick: () => { script.scenes.forEach((s) => collapsed.add(s)); drawScenes(); } }, "Thu gọn tất cả"),
        el("button", { class: "btn ghost", onclick: () => { collapsed.clear(); drawScenes(); } }, "Mở tất cả"),
      ));
  }

  /** Editable chapter title shown above the first scene of each chapter (becomes a YouTube chapter). */
  function chapterHead(id) {
    const ch = (script.chapters ?? []).find((c) => c.id === id);
    const n = (script.chapters ?? []).indexOf(ch) + 1;
    const scenes = script.scenes.filter((s) => s.chapter === id);
    const sec = scenes.reduce((t, s) => t + wordCount(s.voiceText) / wps + 0.35, 0);
    return el("div", { class: "row", style: { margin: "14px 0 2px", gap: "10px", alignItems: "center" } },
      el("span", { class: "chip accent" }, `Chương ${n || "?"}`),
      el("input", { type: "text", value: ch?.title ?? id, style: { fontWeight: 700, fontSize: "16px", maxWidth: "460px" },
        oninput: (e) => { if (ch) { ch.title = e.target.value; markDirty(); } } }),
      el("span", { class: "small faint" }, `${scenes.length} cảnh · ≈ ${fmtSec(sec)}`));
  }

  function uniqueId(base) {
    let n = 1;
    while (script.scenes.some((s) => s.id === `${base}-${n}`)) n++;
    return `${base}-${n}`;
  }

  function addScene(type, after) {
    const tpl = long ? tplById("slideshow") : tplById("news-frame") ?? templates.find((t) => t.roles.includes("body") && !t.virtual);
    // Default to the first photo no scene uses yet.
    const used = new Set(script.scenes.flatMap((s) => [s.inputs?.image, ...(s.inputs?.images ?? [])]));
    const free = imgState.images.find((im) => !used.has(im.file));
    const scene = { id: uniqueId(type), type, voiceText: "", templateId: tpl.id, inputs: free ? { image: free.file } : {} };
    const outroIdx = script.scenes.findIndex((s) => s.type === "outro");
    const idx = after != null ? after + 1 : outroIdx >= 0 ? outroIdx : script.scenes.length;
    if (long) scene.chapter = script.scenes[Math.max(0, idx - 1)]?.chapter;
    script.scenes.splice(idx, 0, scene);
    markDirty();
    drawScenes();
    drawSide();
  }

  function sceneCard(scene, i) {
    const tpl = tplById(scene.templateId);
    const cache = sceneCache(scene.id);
    const isCollapsed = collapsed.has(scene);
    const warnBox = el("div", { class: "warn-list" });
    const drawWarn = () => clear(warnBox, lintScene(scene, tpl).map((w) => el("div", { class: `warn-item ${w.err ? "err" : ""}` }, w.err ? "⛔" : "⚠️", w.msg)));
    const summary = el("div", { class: "scene-summary", onclick: () => toggle() }, scene.voiceText || "(chưa có lời đọc)");
    const changed = () => { markDirty(); drawWarn(); summary.textContent = scene.voiceText || "(chưa có lời đọc)"; drawSideStats(); };
    const toggle = () => { if (collapsed.has(scene)) collapsed.delete(scene); else collapsed.add(scene); drawScenes(); };

    const typeSel = el("select", { title: "Loại scene", onchange: (e) => { scene.type = e.target.value; markDirty(); drawScenes(); } },
      TYPES.map(([v, l]) => el("option", { value: v }, l)));
    typeSel.value = scene.type;

    const tplSel = el("select", { title: "Template", onchange: (e) => changeTemplate(e.target.value) },
      el("optgroup", { label: `Hợp với ${scene.type}` }, pickable.filter((t) => t.roles.includes(scene.type)).map((t) => el("option", { value: t.id }, t.id.replace("frame-", "")))),
      el("optgroup", { label: "Khác" }, pickable.filter((t) => !t.roles.includes(scene.type)).map((t) => el("option", { value: t.id }, t.id.replace("frame-", "")))));
    tplSel.value = scene.templateId;
    if (!tpl) tplSel.prepend(el("option", { value: scene.templateId }, `⚠ ${scene.templateId}`)), (tplSel.value = scene.templateId);

    function changeTemplate(id) {
      const next = tplById(id);
      // Keep values for slots both templates share; take the new template's samples for the rest.
      const kept = Object.fromEntries(Object.entries(scene.inputs ?? {}).filter(([k]) => k in (next?.defaults ?? {})));
      scene.templateId = id;
      scene.inputs = { ...clone(next?.defaults ?? {}), ...kept };
      markDirty();
      drawScenes();
    }

    const idInput = el("input", { class: "sid", type: "text", value: scene.id, title: "Id scene (tên file cache)",
      onchange: (e) => { scene.id = e.target.value.trim().replace(/[^a-zA-Z0-9_-]/g, "-"); e.target.value = scene.id; markDirty(); drawErrors(); } });

    const move = (d) => {
      const j = i + d;
      [script.scenes[i], script.scenes[j]] = [script.scenes[j], script.scenes[i]];
      markDirty();
      drawScenes();
    };

    const head = el("div", { class: "scene-head" },
      el("div", { class: "scene-num" }, i + 1),
      typeSel, tplSel, idInput,
      isCollapsed ? summary : el("div", { class: "grow" }),
      el("div", { class: "row", style: { gap: "2px" } },
        el("button", { class: "btn ghost icon sm", title: "Lên", disabled: i === 0, onclick: () => move(-1) }, "↑"),
        el("button", { class: "btn ghost icon sm", title: "Xuống", disabled: i === script.scenes.length - 1, onclick: () => move(1) }, "↓"),
        el("button", { class: "btn ghost icon sm", title: "Nhân bản scene", onclick: () => {
          const copy = clone(scene);
          copy.id = uniqueId(scene.type);
          script.scenes.splice(i + 1, 0, copy);
          markDirty();
          drawScenes();
        } }, "⧉"),
        el("button", { class: "btn ghost icon sm danger", title: "Xoá scene", onclick: () => { script.scenes.splice(i, 1); markDirty(); drawScenes(); drawSide(); } }, "✕"),
        el("button", { class: "btn ghost icon sm", title: isCollapsed ? "Mở" : "Thu gọn", onclick: toggle }, isCollapsed ? "▸" : "▾"),
      ));

    if (isCollapsed) return el("div", { class: "scene collapsed", "data-type": scene.type }, head);

    // voice
    const voiceMeta = el("div", { class: "voice-meta" });
    const drawVoiceMeta = () => clear(voiceMeta, `${wordCount(scene.voiceText)} từ`, `≈ ${fmtSec(estSec(scene.voiceText))}`);
    const voiceTa = el("textarea", { rows: 3, placeholder: "Câu giọng đọc sẽ đọc. Viết số ra chữ, không emoji, không URL.",
      oninput: (e) => { scene.voiceText = e.target.value; drawVoiceMeta(); changed(); } });
    voiceTa.value = scene.voiceText;
    drawVoiceMeta();
    const listenBtn = el("button", { class: "btn sm", onclick: (e) => playTts(scene.voiceText, e.currentTarget) }, "🔊 Nghe thử");

    // inputs
    const rawToggle = el("button", { class: "btn ghost sm" }, "{ } Sửa JSON");
    const inputsBox = el("div");
    let raw = false;
    const drawInputs = () => {
      if (!raw) return clear(inputsBox, inputsForm(scene, tpl, changed));
      const ta = el("textarea", { class: "json-editor", style: { minHeight: "220px" } });
      ta.value = JSON.stringify(scene.inputs ?? {}, null, 2);
      ta.onchange = () => {
        try { scene.inputs = JSON.parse(ta.value); ta.classList.remove("over"); changed(); } catch (err) { ta.classList.add("over"); toast(`JSON lỗi: ${err.message}`, "bad"); }
      };
      clear(inputsBox, ta);
    };
    rawToggle.onclick = () => { raw = !raw; rawToggle.textContent = raw ? "☰ Dạng form" : "{ } Sửa JSON"; drawInputs(); };
    drawInputs();

    // sfx
    const plan = sfxPlan.find((p) => p.id === scene.id);
    const sfxSel = el("select", {},
      el("option", { value: "" }, "Mặc định của kênh"),
      el("option", { value: "none" }, "Tắt SFX"),
      sfxLib.map((c) => el("optgroup", { label: c.category }, c.files.map((f) => el("option", { value: `${c.category}/${f.name}` }, f.name)))));
    sfxSel.value = scene.sfx?.name ?? "";
    const sfxExtra = el("div", { class: "row" });
    const drawSfxExtra = () => {
      if (!scene.sfx || scene.sfx.name === "none") {
        const auto = !scene.sfx && plan?.file;
        return clear(sfxExtra, auto
          ? [el("span", { class: "small muted" }, "→ ", plan.file.startsWith("__brand__") ? plan.source : plan.file, plan.keyword ? ` (từ khoá "${plan.keyword}")` : plan.file.startsWith("__brand__") ? "" : ` (${plan.source})`),
            el("button", { class: "btn ghost sm", onclick: (e) => playUrl(`/sfx-files/${plan.file}`, e.currentTarget) }, "▶")]
          : !scene.sfx && plan?.note ? el("span", { class: "small faint" }, `Không có SFX — ${plan.note}`) : null);
      }
      const vol = el("input", { type: "range", min: 0, max: 1, step: 0.05, value: scene.sfx.volume ?? 0.4, style: { width: "110px" } });
      const volLabel = el("span", { class: "small muted" }, `Âm lượng ${Math.round((scene.sfx.volume ?? 0.4) * 100)}%`);
      vol.oninput = () => { scene.sfx.volume = Number(vol.value); volLabel.textContent = `Âm lượng ${Math.round(vol.value * 100)}%`; markDirty(); };
      const off = el("input", { type: "number", step: 0.1, value: scene.sfx.startOffsetSec ?? 0, style: { width: "80px" } });
      off.oninput = () => { scene.sfx.startOffsetSec = Number(off.value) || 0; markDirty(); };
      clear(sfxExtra,
        el("button", { class: "btn ghost sm", onclick: (e) => playUrl(`/sfx-files/${scene.sfx.name}.mp3`, e.currentTarget) }, "▶ Nghe"),
        volLabel, vol, el("span", { class: "small muted" }, "Lệch (s)"), off);
    };
    sfxSel.onchange = () => {
      if (!sfxSel.value) delete scene.sfx;
      else scene.sfx = { name: sfxSel.value, volume: scene.sfx?.volume ?? 0.4, startOffsetSec: scene.sfx?.startOffsetSec ?? 0 };
      drawSfxExtra();
      markDirty();
    };
    drawSfxExtra();

    // aside: clip preview + voice cache
    const wide = script.aspect === "16:9";
    const clipUrl = `/files/${slug}/clips/scene-${scene.id}.mp4`;
    const clipBox = el("div", { class: `clip-box ${wide ? "wide" : ""}` },
      cache.hasClip ? el("video", { src: bust(clipUrl), controls: true, muted: true, loop: true, preload: "metadata" }) : "Chưa render hình scene này");
    const findVideoBtn = el("button", { class: "btn sm", disabled: isActive(), title: "Tìm video minh hoạ trên Pixabay theo từ khoá tiếng Anh", onclick: async (e) => {
      const b = e.currentTarget;
      if (isDirty() && !(await save({ quiet: true }))) return;
      b.disabled = true; b.textContent = "Đang tìm…";
      try {
        const fresh = await api("POST", `/api/projects/${slug}/videos/autofill`, { sceneId: scene.id });
        applyFresh(fresh);
        toast(fresh.log?.join("\n") || "Đã tìm video", "ok");
      } catch (err) { toast(err.message, "bad"); b.disabled = false; b.textContent = "🎞 Tìm video"; }
    } }, "🎞 Tìm video");
    const videoQuery = el("input", { type: "text", value: scene.videoQuery ?? "", placeholder: "Từ khoá video (tiếng Anh)",
      oninput: (e) => { scene.videoQuery = e.target.value || undefined; markDirty(); } });
    const promptTa = el("textarea", { rows: 4, placeholder: "Prompt ảnh AI (tiếng Anh): chủ thể, hành động, bối cảnh, ánh sáng, góc máy…",
      oninput: (e) => { scene.imagePrompts = e.target.value.trim() ? [e.target.value.trim(), ...(scene.imagePrompts ?? []).slice(1)] : undefined; markDirty(); } });
    promptTa.value = scene.imagePrompts?.[0] ?? "";
    const redrawBtn = el("button", { class: "btn sm", disabled: isActive(), title: "Gemini vẽ lại theo prompt, rồi chấm điểm khớp lời đọc — dưới 7/10 tự vẽ lại", onclick: async (e) => {
      const b = e.currentTarget;
      if (isDirty() && !(await save({ quiet: true }))) return;
      b.disabled = true; b.textContent = "Đang vẽ + kiểm tra…";
      try {
        const fresh = await api("POST", `/api/projects/${slug}/ai-images`, { sceneId: scene.id, prompt: promptTa.value.trim() });
        applyFresh(fresh);
        toast(fresh.log?.join("\n") || "Đã vẽ lại", "ok");
      } catch (err) { toast(err.message, "bad", 12000); b.disabled = false; b.textContent = "🎨 Vẽ lại ảnh AI"; }
    } }, "🎨 Vẽ lại ảnh AI");
    const visualLabel = { video: "AI chọn: video minh hoạ", ai: "AI chọn: ảnh AI minh hoạ", photo: "AI chọn: ảnh thật" }[scene.visual ?? "photo"] ?? "";
    const aside = long ? el("div", { class: "scene-aside" },
      el("div", { class: "small faint" }, visualLabel),
      promptTa, redrawBtn,
      el("details", {}, el("summary", { class: "small" }, "Video stock"), el("div", { class: "stack", style: { gap: "6px", marginTop: "6px" } }, videoQuery, findVideoBtn)),
      cache.hasVoice ? el("audio", { src: bust(`/files/${slug}/voice/scene-${scene.id}.mp3`), controls: true, style: { width: "100%", height: "32px" } }) : null,
      cache.hasVoice ? el("span", { class: "chip ok" }, "giọng ✓") : el("span", { class: "chip" }, "giọng –"),
    ) : el("div", { class: "scene-aside" },
      clipBox,
      el("button", { class: "btn sm", disabled: isActive(), onclick: () => renderScene(scene) }, cache.hasClip ? "↻ Render lại hình" : "🖼 Render thử hình"),
      cache.hasVoice ? el("audio", { src: bust(`/files/${slug}/voice/scene-${scene.id}.mp3`), controls: true, style: { width: "100%", height: "32px" } }) : null,
      el("div", { class: "row", style: { gap: "4px" } },
        cache.hasVoice ? el("span", { class: "chip ok", title: "Giọng đã tạo — sẽ được dùng lại" }, "giọng ✓") : el("span", { class: "chip" }, "giọng –"),
        cache.hasClip ? el("span", { class: "chip ok", title: "Hình đã render — sẽ được dùng lại" }, "hình ✓") : el("span", { class: "chip" }, "hình –"),
      ),
      cache.hasVoice || cache.hasClip
        ? el("button", { class: "btn ghost sm", disabled: isActive(), onclick: () => clearSceneCache(scene.id) }, "Xoá cache scene")
        : null,
    );

    drawWarn();
    return el("div", { class: "scene", "data-type": scene.type },
      head,
      el("div", { class: "scene-body" },
        el("div", { class: "scene-main" },
          el("label", { class: "field" },
            el("span", {}, "🎙 Lời đọc (voiceText)", voiceMeta), voiceTa),
          el("div", { class: "row" }, listenBtn, tpl ? el("span", { class: "small faint" }, tpl.bestFor || tpl.role) : null),
          warnBox,
          el("div", { class: "row between" }, el("span", { class: "section-label" }, "Hình ảnh"), rawToggle),
          inputsBox,
          scene.type !== "outro" ? el("div", { class: "row" },
            el("div", { class: "grow" }, el("input", { type: "text", value: scene.imageQuery ?? "", placeholder: "Từ khoá tìm ảnh cho scene (vd: Chanathip ăn mừng)",
              oninput: (e) => { scene.imageQuery = e.target.value || undefined; markDirty(); } })),
            el("button", { class: "btn sm", disabled: isActive(), onclick: async (e) => {
              const b = e.currentTarget;
              if (isDirty() && !(await save({ quiet: true }))) return;
              b.disabled = true; b.textContent = "Đang tìm…";
              try {
                const fresh = await api("POST", `/api/projects/${slug}/images/autofill`, { sceneId: scene.id, force: true });
                applyFresh(fresh);
                toast(fresh.log?.join("\n") || "Đã thêm ảnh", "ok");
              } catch (err) { toast(err.message, "bad"); b.disabled = false; b.textContent = "🔍 Tìm thêm ảnh"; }
            } }, "🔍 Tìm thêm ảnh")) : null,
          long ? null : el("div", { class: "section-label" }, "Hiệu ứng âm thanh"),
          long ? null : el("div", { class: "row" }, el("div", { style: { width: "260px" } }, sfxSel), sfxExtra),
        ),
        aside,
      ));
  }

  // ── side panel ──
  const statsBox = el("div");
  const jobBox = el("div");
  function drawSideStats() {
    const words = script.scenes.reduce((n, s) => n + wordCount(s.voiceText), 0);
    const sec = long
      ? script.scenes.reduce((n, s) => n + wordCount(s.voiceText) / wps + 0.35, 0) + 3
      : script.scenes.reduce((n, s) => n + estSec(s.voiceText), 0) + script.scenes.length * 0.3 + 3;
    clear(statsBox, el("div", { class: "grid-2", style: { gap: "8px" } },
      stat("Scene", script.scenes.length), stat("Số từ", words),
      stat("Thời lượng ước tính", fmtSec(sec)), long ? stat("Chương", (script.chapters ?? []).length) : stat("Khung hình", script.aspect)));
  }
  const stat = (label, value) => el("div", { class: "card tight", style: { padding: "10px 12px" } },
    el("div", { class: "small faint" }, label), el("div", { style: { fontWeight: 700, fontSize: "18px" } }, value));

  function isActive() {
    return [...jobs.values()].some((j) => j.slug === slug && (j.status === "running" || j.status === "queued"));
  }

  function activeJob() {
    return [...jobs.values()].find((j) => j.slug === slug && (j.status === "running" || j.status === "queued"));
  }

  let logHandle = null;
  function drawJob() {
    const job = activeJob();
    logHandle?.dispose();
    logHandle = null;
    renderBtn.disabled = !!job || lintScript(script).length > 0;
    if (!job) {
      const last = proj.meta.lastRender;
      return clear(jobBox, last ? el("div", { class: `callout ${last.ok ? "" : "bad"}` },
        last.ok ? `✓ Render lần cuối ${fmtDate(last.at)} · ${fmtSec(last.durationSec)}` : `✗ Render lỗi lúc ${fmtDate(last.at)}: ${last.error ?? ""}`) : null);
    }
    logHandle = liveLog(job.id);
    const p = job.progress;
    clear(jobBox, el("div", { class: "card tight stack" },
      el("div", { class: "row between" }, el("b", {}, job.kind === "pipeline" ? "Đang render video" : job.title), statusChip(job.status)),
      progressBar(job),
      el("div", { class: "small muted" }, p ? `Bước ${p.step}/${p.total}: ${p.label}` : job.status === "queued" ? "Đang chờ job khác xong…" : "Đang khởi động…"),
      logHandle.node,
      el("div", { class: "row" },
        el("button", { class: "btn sm", onclick: () => jobLogModal(job.id) }, "Mở log lớn"),
        el("button", { class: "btn sm danger", onclick: () => guard(() => api("POST", `/api/jobs/${job.id}/cancel`), "Đã gửi lệnh huỷ") }, "Huỷ")),
    ));
  }
  disposers.push(() => logHandle?.dispose());

  function drawSide() {
    if (tab !== "script") return;
    drawSideStats();
    drawJob();
    const hasVideo = proj.files.includes("video.mp4");
    clear(sideBox,
      el("div", { class: "card stack" }, el("h3", {}, "Tổng quan"), statsBox,
        el("div", { class: "small muted" }, long
          ? "Mẹo: sửa lời đọc chỉ tạo lại giọng cảnh đó; ảnh/video đã render được dùng lại — chỉ cảnh thay đổi mới render lại."
          : "Mẹo: sửa lời đọc chỉ tạo lại giọng scene đó; sửa chữ/template chỉ render lại hình scene đó — phần còn lại dùng cache.")),
      jobBox,
      hasVideo ? el("div", { class: "card stack" },
        el("div", { class: "row between" }, el("h3", {}, "Video hiện tại"), el("button", { class: "btn sm", onclick: () => { tab = "result"; drawTabs(); drawBody(); } }, "Mở")),
        el("div", { class: "video-wrap" }, el("video", { src: bust(`/files/${slug}/video.mp4`), controls: true, preload: "metadata" }))) : null,
      long ? el("div", { class: "card stack" },
        el("h3", {}, "Hình ảnh"),
        el("p", { class: "small muted", style: { margin: 0 } }, "Gemini xem lại từng ảnh thật so với lời đọc, loại ảnh lệch nội dung hoặc có chữ/logo kênh khác đè lên, rồi tìm ảnh mới cho cảnh bị trống."),
        el("button", { class: "btn sm", disabled: isActive(), onclick: async (e) => {
          if (isDirty() && !(await save({ quiet: true }))) return;
          e.currentTarget.disabled = true;
          const { jobId } = await guard(() => api("POST", `/api/projects/${slug}/visuals/recheck`), "Đang kiểm tra ảnh…");
          drawJob();
          const job = await waitJob(jobId);
          if (job.status !== "done") return toast(job.error ?? "Kiểm tra ảnh lỗi", "bad", 10000);
          applyFresh(await api("GET", `/api/projects/${slug}`));
          toast("Đã kiểm tra lại ảnh — render lại để áp dụng", "ok");
        } }, "🔍 Kiểm tra lại toàn bộ ảnh")) : null,
      el("div", { class: "card stack" },
        el("h3", {}, "Cache"),
        el("div", { class: "row" },
          el("button", { class: "btn sm", disabled: isActive(), onclick: () => clearAll("voice") }, "Tạo lại toàn bộ giọng"),
          el("button", { class: "btn sm", disabled: isActive(), onclick: () => clearAll("clip") }, "Render lại toàn bộ hình"))),
    );
  }

  // ── result tab ──
  function resultView() {
    const f = proj.files;
    if (!f.includes("video.mp4")) {
      return el("div", { class: "empty" }, el("div", { class: "big" }, "🎬"), el("p", {}, "Chưa có video. Sang tab Kịch bản và bấm Render video."),
        el("button", { class: "btn primary", onclick: () => render() }, "▶ Render video"));
    }
    const last = proj.meta.lastRender;
    const dl = (file, label, desc) => f.includes(file)
      ? el("a", { href: `/files/${slug}/${file}`, download: `${slug}-${file}` }, el("span", {}, el("b", {}, label), el("div", { class: "small muted" }, desc)), "⬇")
      : null;
    drawPublish();
    if (long) return youtubeResult(f, dl, last);
    return el("div", { class: "editor" },
      el("div", { class: "stack" },
        el("div", { class: "row", style: { alignItems: "flex-start", gap: "16px" } },
          el("div", { class: "video-wrap grow", style: { maxWidth: script.aspect === "16:9" ? "100%" : "420px" } },
            el("video", { src: bust(`/files/${slug}/video.mp4`), controls: true, autoplay: false })),
          f.includes("cover.jpg") ? el("div", { class: "stack", style: { width: script.aspect === "16:9" ? "100%" : "220px", gap: "6px" } },
            el("span", { class: "section-label" }, "Ảnh bìa"),
            el("img", { src: bust(`/files/${slug}/cover.jpg`), style: { width: "100%", borderRadius: "10px", border: "1px solid var(--line)" } })) : null)),
      el("div", { class: "side-sticky" },
        pubBox,
        el("div", { class: "card stack" },
          el("h3", {}, "Tải về"),
          el("div", { class: "dl-list" },
            dl("video.mp4", "video.mp4", "Video hoàn chỉnh — đăng thẳng TikTok/Shorts/Reels"),
            dl("cover.jpg", "cover.jpg", "Ảnh bìa theo khung kênh — đặt làm cover khi đăng"),
            dl("voice.mp3", "voice.mp3", "Riêng giọng đọc + SFX — kéo vào CapCut"),
            dl("script.txt", "script.txt", "Toàn bộ lời đọc — CapCut tự bắt phụ đề"),
            dl("script.json", "script.json", "Kịch bản — dùng lại / import"))),
        last ? el("div", { class: "card stack small" },
          el("div", {}, `Render lúc ${fmtDate(last.at)}`),
          last.durationSec ? el("div", {}, `Thời lượng: ${fmtSec(last.durationSec)}`) : null) : null,
        el("div", { class: "callout small" },
          el("b", {}, "Làm phụ đề trong CapCut: "),
          "Import video.mp4 → Chữ → Phụ đề tự động. Hoặc dùng voice.mp3 làm track âm thanh riêng nếu muốn tự dựng hình."),
      ));
  }

  const commentTa = el("textarea", { rows: 3, oninput: (e) => (pubForm.comment = e.target.value) });
  /** "Đăng YouTube" card: this video's uploads + a form to queue one. Refills itself on queue changes. */
  const pubBox = el("div", { class: "card stack" });
  let pubForm = { platform: "youtube", channelId: script.metadata.channelId ?? "", when: "auto", at: "", privacy: "", link: script.metadata.affiliateLink ?? "", comment: null, commentFor: "" };
  async function drawPublish() {
    let yt, channels;
    try {
      [yt, channels] = await Promise.all([api("GET", "/api/youtube/status"), api("GET", "/api/channels")]);
    } catch {
      return clear(pubBox);
    }
    const head = el("h3", {}, "📤 Đăng video");
    const fbOn = !!yt.facebook?.configured;
    if (!yt.configured && !fbOn) return clear(pubBox, head, el("p", { class: "small muted", style: { margin: 0 } }, "Chưa cấu hình YouTube / Facebook."));
    if (pubForm.platform === "facebook" && !fbOn) pubForm.platform = "youtube";
    if (pubForm.platform === "youtube" && !yt.configured) pubForm.platform = "facebook";
    const isFb = pubForm.platform === "facebook";
    const conns = isFb ? yt.facebook.connections : yt.connections;
    const slots = isFb ? yt.facebook.nextSlots : yt.nextSlots;
    const platSeg = yt.configured && fbOn
      ? el("div", { class: "seg" }, [["youtube", "YouTube"], ["facebook", "Facebook"]].map(([v, l]) =>
        el("button", { class: pubForm.platform === v ? "active" : "", onclick: () => { pubForm.platform = v; drawPublish(); } }, l)))
      : null;
    const mine = yt.uploads.filter((u) => u.slug === slug);
    const name = (id) => channels.find((c) => c.id === id)?.name ?? id;
    const rows = mine.map((u) => {
      const [cls, label] = UPLOAD_STATUS[u.status] ?? ["chip", u.status];
      return el("div", { class: "stack", style: { gap: "2px" } },
        el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
          el("span", { class: cls }, u.status === "uploading" && u.progress != null ? `${label} ${u.progress}%` : label),
          el("span", { class: "small" }, `${u.platform === "facebook" ? "Facebook" : "YouTube"} · ${name(u.channelId)}`),
          u.publishAt ? el("span", { class: "small faint" }, `công khai ${fmtVN(u.publishAt)}`) : null,
          u.videoId ? el("a", { class: "small", href: u.url ?? `https://studio.youtube.com/video/${u.videoId}/edit`, target: "_blank" }, "Mở ↗") : null),
        u.error ? el("div", { class: "small", style: { color: "var(--bad)" } }, u.error) : null,
        (u.warnings ?? []).map((w) => el("div", { class: "small", style: { color: "var(--warn)" } }, w)));
    });
    const connected = channels.filter((c) => conns?.[c.id] && !conns[c.id].broken);
    const platName = isFb ? "Facebook" : "YouTube";
    if (!connected.length) {
      return clear(pubBox, head, ...rows, platSeg, el("p", { class: "small muted", style: { margin: 0 } },
        `Chưa kênh nào kết nối ${platName}. `, el("a", { href: "#/channels" }, "Vào trang Kênh"), ` bấm Kết nối ${platName}.`));
    }
    if (!connected.some((c) => c.id === pubForm.channelId)) pubForm.channelId = connected[0].id;
    const ch = connected.find((c) => c.id === pubForm.channelId);
    const chSel = el("select", { onchange: (e) => { pubForm.channelId = e.target.value; drawPublish(); } },
      connected.map((c) => el("option", { value: c.id }, `${c.language === "en" ? "🇬🇧" : "🇻🇳"} ${c.name} → ${isFb ? conns[c.id].page.name : conns[c.id].youtube.title}`)));
    chSel.value = pubForm.channelId;
    const slot = slots?.[ch.id];
    if (pubForm.when === "auto" && !slot) pubForm.when = "now";
    const whenSel = el("select", { onchange: (e) => { pubForm.when = e.target.value; drawPublish(); } },
      slot ? el("option", { value: "auto" }, `Giờ trống kế tiếp của kênh (${fmtVN(slot)})`) : null,
      el("option", { value: "now" }, "Ngay khi tải xong"),
      el("option", { value: "at" }, "Chọn giờ…"));
    whenSel.value = pubForm.when;
    const atInput = pubForm.when === "at"
      ? el("input", { type: "datetime-local", value: pubForm.at, onchange: (e) => (pubForm.at = e.target.value) })
      : null;
    const privSel = pubForm.when === "now"
      ? el("select", { onchange: (e) => (pubForm.privacy = e.target.value) },
        el("option", { value: "" }, `Theo kênh (${{ public: "công khai", unlisted: "không công khai", private: "riêng tư" }[ch.privacy ?? "public"]})`),
        el("option", { value: "public" }, "Công khai"), el("option", { value: "unlisted" }, "Không công khai"), el("option", { value: "private" }, "Riêng tư"))
      : null;
    if (privSel) privSel.value = pubForm.privacy;
    const already = mine.some((u) => u.channelId === ch.id && (u.platform ?? "youtube") === pubForm.platform && u.status !== "failed");
    // Facebook first comment: the channel's template with this video's link, editable here.
    const fillComment = () => {
      const tpl = ch.commentTemplate ?? "👉 Link sản phẩm: {link}";
      return !tpl.trim() ? "" : tpl.includes("{link}") ? (pubForm.link ? tpl.replaceAll("{link}", pubForm.link) : "") : tpl;
    };
    if (pubForm.comment === null || pubForm.commentFor !== ch.id) { pubForm.comment = fillComment(); pubForm.commentFor = ch.id; }
    commentTa.value = pubForm.comment ?? "";
    const commentBox = el("div", { class: "stack", style: { gap: "6px" } },
      el("label", { class: "field" }, el("span", {}, "Link affiliate", el("em", {}, "điền vào {link}")),
        el("input", { type: "url", value: pubForm.link, placeholder: "https://...", oninput: (e) => {
          pubForm.link = e.target.value.trim();
          pubForm.comment = fillComment();
          commentTa.value = pubForm.comment;
        } })),
      el("label", { class: "field" }, el("span", {}, "Bình luận tự động", el("em", {}, isFb ? "tự soạn; để trống = không bình luận" : "tự soạn; YouTube chỉ bình luận được khi video công khai (sau audit)")), commentTa));
    const btn = el("button", { class: "btn primary", disabled: already, onclick: async () => {
      let publishAt;
      if (pubForm.when === "auto") publishAt = "auto";
      else if (pubForm.when === "at") {
        if (!pubForm.at) return toast("Chọn giờ công khai", "warn");
        publishAt = new Date(pubForm.at).toISOString();
      }
      btn.disabled = true;
      try {
        await guard(() => api("POST", "/api/youtube/uploads", { slug, platform: pubForm.platform, channelId: ch.id, publishAt, privacy: pubForm.privacy || undefined, comment: pubForm.comment ?? "" }), `Đã xếp vào hàng đợi đăng ${platName}`);
      } catch {
        btn.disabled = false;
      }
      drawPublish();
    } }, already ? `Đã đăng / đang chờ đăng ${platName}` : `📤 Đăng ${platName}`);
    clear(pubBox, head, ...rows, platSeg,
      el("label", { class: "field" }, el("span", {}, "Kênh"), chSel),
      el("label", { class: "field" }, el("span", {}, "Công khai lúc"), whenSel),
      atInput, privSel ? el("label", { class: "field" }, el("span", {}, "Hiển thị"), privSel) : null,
      commentBox,
      btn,
      el("p", { class: "small faint", style: { margin: 0 } }, isFb ? "Video dọc ≤ 90 giây lên Reels, còn lại lên video thường. " : `Quota YouTube hôm nay còn ~${Math.floor(yt.quota.remaining / 1650)} video. `, el("a", { href: "#/channels" }, "Xem hàng đợi")));
  }
  const offYt = onYoutube(() => { if (pubBox.isConnected) drawPublish(); });

  /** Long video: player, thumbnail, and everything to paste into YouTube Studio. */
  function youtubeResult(f, dl, last) {
    const descBox = el("textarea", { rows: 12, readonly: true, style: { fontFamily: "inherit" } }, "Đang tải…");
    if (f.includes("description.txt")) fetch(bust(`/files/${slug}/description.txt`)).then((r) => r.text()).then((t) => { descBox.value = t; });
    const copy = (text, what) => navigator.clipboard.writeText(text).then(() => toast(`Đã copy ${what}`, "ok"));
    const ytTitle = script.metadata.title.replace(/\*/g, "").slice(0, 100);
    return el("div", { class: "editor" },
      el("div", { class: "stack" },
        el("div", { class: "video-wrap" }, el("video", { src: bust(`/files/${slug}/video.mp4`), controls: true })),
        el("div", { class: "card stack" },
          el("div", { class: "row between" }, el("h3", {}, "Tiêu đề"), el("button", { class: "btn sm", onclick: () => copy(ytTitle, "tiêu đề") }, "Copy")),
          el("div", { style: { fontWeight: 700 } }, ytTitle),
          el("div", { class: "row between" }, el("h3", {}, "Mô tả (kèm chương + nguồn)"), el("button", { class: "btn sm", onclick: () => copy(descBox.value, "mô tả") }, "Copy")),
          descBox,
          (script.metadata.tags ?? []).length ? el("div", { class: "row between" },
            el("span", { class: "small" }, (script.metadata.tags ?? []).join(", ")),
            el("button", { class: "btn sm", onclick: () => copy((script.metadata.tags ?? []).join(", "), "tags") }, "Copy tags")) : null)),
      el("div", { class: "side-sticky" },
        pubBox,
        f.includes("thumbnail.jpg") ? el("div", { class: "card stack" }, el("h3", {}, "Thumbnail"),
          el("img", { src: bust(`/files/${slug}/thumbnail.jpg`), style: { width: "100%", borderRadius: "8px" } })) : null,
        el("div", { class: "card stack" },
          el("h3", {}, "Tải về"),
          el("div", { class: "dl-list" },
            dl("video.mp4", "video.mp4", "Video 1920×1080, phụ đề đã in sẵn"),
            dl("thumbnail.jpg", "thumbnail.jpg", "Thumbnail 1280×720"),
            dl("subtitles.srt", "subtitles.srt", "Phụ đề — tải lên YouTube (Phụ đề → Tải tệp lên)"),
            dl("description.txt", "description.txt", "Mô tả + mục lục chương + nguồn"),
            dl("voice.mp3", "voice.mp3", "Riêng giọng đọc"),
            dl("youtube.json", "youtube.json", "Metadata cho bước đăng tự động"))),
        last ? el("div", { class: "card stack small" },
          el("div", {}, `Render lúc ${fmtDate(last.at)}`),
          last.durationSec ? el("div", {}, `Thời lượng: ${fmtSec(last.durationSec)}`) : null) : null));
  }

  /** Replace local state with a project returned by the server (script + images + cache). */
  function applyFresh(fresh) {
    proj = fresh;
    imgState.images = fresh.images ?? [];
    imgState.videos = fresh.videos ?? [];
    script = clone(fresh.script);
    saved = JSON.stringify(script);
    markDirty();
    drawTabs();
    drawBody();
  }

  /** Search the web for photos; click a result to add it to the project. */
  function webSearchBox(setList) {
    const q = el("input", { type: "text", placeholder: "Tìm ảnh trên web (vd: Chanathip Songkrasin)" });
    const grid = el("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: "8px" } });
    const run = async () => {
      if (!q.value.trim()) return;
      clear(grid, el("div", { class: "row muted" }, el("span", { class: "spinner" }), "Đang tìm…"));
      try {
        const hits = await api("POST", "/api/images/search", { query: q.value.trim() });
        clear(grid, hits.length ? hits.map((h) => el("button", {
          class: "card tight", title: `${h.title}\n${h.page}`, style: { padding: "4px", cursor: "pointer" },
          onclick: async (e) => {
            const b = e.currentTarget;
            b.style.opacity = .4;
            try { setList(await api("POST", `/api/projects/${slug}/images`, { url: h.url, caption: h.title })); toast("Đã thêm ảnh", "ok"); }
            catch (err) { toast(err.message, "bad"); b.style.opacity = 1; }
          },
        }, el("img", { src: h.thumb, loading: "lazy", style: { width: "100%", aspectRatio: "4/3", objectFit: "cover", borderRadius: "6px", display: "block" } }),
          el("div", { class: "small muted", style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: "3px" } }, h.title))) : el("div", { class: "muted" }, "Không tìm thấy ảnh phù hợp (hoặc máy tìm kiếm đang chặn tạm — thử lại sau ít phút)."));
      } catch (err) { clear(grid, err.message); }
    };
    q.addEventListener("keydown", (e) => e.key === "Enter" && run());
    return el("div", { class: "stack", style: { gap: "8px" } },
      el("div", { class: "row" }, el("div", { class: "grow" }, q), el("button", { class: "btn", onclick: run }, "🔍 Tìm ảnh web")),
      grid);
  }

  // ── images tab ──
  function imagesView() {
    const usedBy = (file) => script.scenes.filter((s) => s.inputs?.image === file || (s.inputs?.images ?? []).includes(file)).map((s) => s.id);
    const setList = (list) => { imgState.images = list; drawTabs(); drawBody(); };
    const urlIn = el("input", { type: "url", placeholder: "Dán link ảnh (https://…)" });
    const fileIn = el("input", { type: "file", accept: "image/*", multiple: true, class: "hidden", onchange: async (e) => {
      for (const file of e.target.files) {
        const dataUrl = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(file); });
        setList(await guard(() => api("POST", `/api/projects/${slug}/images`, { dataUrl, caption: file.name.replace(/.[^.]+$/, "") })));
      }
      toast("Đã thêm ảnh", "ok");
    } });
    return el("div", { class: "stack" },
      el("div", { class: "card stack" },
        el("div", { class: "row" },
          el("div", { class: "grow" }, urlIn),
          el("button", { class: "btn", onclick: async () => {
            if (!urlIn.value.trim()) return;
            setList(await guard(() => api("POST", `/api/projects/${slug}/images`, { url: urlIn.value.trim() }), "Đã thêm ảnh"));
          } }, "+ Thêm từ link"),
          el("button", { class: "btn", onclick: () => fileIn.click() }, "⬆ Tải ảnh lên"), fileIn,
          script.metadata.source?.url ? el("button", { class: "btn ghost", onclick: async (e) => {
            e.currentTarget.disabled = true;
            setList(await guard(() => api("POST", `/api/projects/${slug}/images/refetch`), "Đã lấy lại ảnh từ bài gốc"));
          } }, "↻ Lấy ảnh từ bài gốc") : null),
        el("p", { class: "small muted", style: { margin: 0 } }, "Ảnh được chuẩn hoá (≤1600px) và lưu trong images/ của dự án. Chọn ảnh cho từng scene ở tab Kịch bản.")),
      el("div", { class: "card stack" },
        el("div", { class: "row between" },
          el("div", {}, el("h3", {}, "✨ Tự lấp ảnh cho mọi scene"),
            el("p", { class: "small muted", style: { margin: "4px 0 0" } }, "Tìm ảnh từ các bài báo cùng chủ đề (theo tiêu đề + từ khoá ảnh của từng scene), mỗi scene 2–4 ảnh, không lặp.")),
          el("button", { class: "btn primary", disabled: isActive(), onclick: async (e) => {
            const b = e.currentTarget;
            if (isDirty() && !(await save({ quiet: true }))) return;
            b.disabled = true; b.textContent = "Đang tìm…";
            try {
              const fresh = await api("POST", `/api/projects/${slug}/images/autofill`, {});
              applyFresh(fresh);
              toast(fresh.log?.join("\n") || "Các scene đã đủ ảnh", "ok", 8000);
            } catch (err) { toast(err.message, "bad"); b.disabled = false; b.textContent = "✨ Tự lấp ảnh"; }
          } }, "✨ Tự lấp ảnh")),
        webSearchBox(setList)),
      imgState.images.length === 0
        ? el("div", { class: "empty" }, el("div", { class: "big" }, "🖼"), el("p", {}, "Chưa có ảnh. Thêm ảnh để video sinh động hơn."))
        : el("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "14px" } },
          imgState.images.map((im) => {
            const users = usedBy(im.file);
            return el("div", { class: "card tight stack", style: { gap: "8px" } },
              el("img", { src: imgUrl(im.file), style: { width: "100%", aspectRatio: "4/3", objectFit: "cover", borderRadius: "8px" } }),
              el("div", { class: "row between small" }, el("b", { class: "mono" }, im.file), el("span", { class: "faint" }, `${im.width}×${im.height}`)),
              im.caption ? el("div", { class: "small muted" }, im.caption) : null,
              el("div", { class: "row between" },
                users.length ? el("span", { class: "chip ok" }, "Dùng ở: ", users.join(", ")) : el("span", { class: "chip" }, "Chưa dùng"),
                el("button", { class: "btn ghost sm danger", onclick: async () => {
                  if (users.length && !(await confirmBox(`Ảnh đang dùng ở scene ${users.join(", ")}. Vẫn xoá?`, "Xoá", true))) return;
                  setList(await guard(() => api("DELETE", `/api/projects/${slug}/images/${im.file.replace("images/", "")}`), "Đã xoá ảnh"));
                } }, "Xoá")));
          })));
  }

  // ── json tab ──
  let jsonTa = null;
  function jsonView() {
    jsonTa = el("textarea", { class: "json-editor" });
    jsonTa.value = JSON.stringify(script, null, 2);
    return el("div", { class: "stack" },
      el("div", { class: "row between" },
        el("span", { class: "muted small" }, "Sửa trực tiếp script.json. Bấm Áp dụng (hoặc chuyển tab) để cập nhật, rồi Lưu."),
        el("button", { class: "btn", onclick: () => applyJson() && toast("Đã áp dụng JSON", "ok") }, "Áp dụng")),
      jsonTa);
  }
  function applyJson() {
    if (!jsonTa || tab !== "json") return true;
    try {
      const next = JSON.parse(jsonTa.value);
      if (!Array.isArray(next.scenes)) throw new Error("thiếu mảng scenes");
      script = next;
      titleInput.value = script.metadata?.title ?? "";
      markDirty();
      return true;
    } catch (e) {
      toast(`JSON lỗi: ${e.message}`, "bad");
      return false;
    }
  }

  // ── actions ──
  async function save({ quiet = false } = {}) {
    if (tab === "json" && !applyJson()) return false;
    const r = await guard(() => api("PUT", `/api/projects/${slug}/script`, script));
    proj = r;
    imgState.images = r.images ?? imgState.images;
    saved = JSON.stringify(script);
    markDirty();
    if (!quiet || r.invalidated.length) {
      toast(r.invalidated.length ? `Đã lưu. Sẽ làm lại: ${r.invalidated.join(", ")}` : "Đã lưu", "ok");
    }
    refreshPlan();
    drawSide();
    return true;
  }

  async function render() {
    if (isDirty() && !(await save({ quiet: true }))) return;
    const errs = lintScript(script);
    if (errs.length) return toast(errs.join("\n"), "bad");
    await guard(() => api("POST", `/api/projects/${slug}/render`));
    tab = "script";
    drawTabs();
    drawBody();
  }

  async function renderScene(scene) {
    if (isDirty() && !(await save({ quiet: true }))) return;
    await guard(() => api("POST", `/api/projects/${slug}/scenes/${encodeURIComponent(scene.id)}/render`), `Đang render scene ${scene.id}…`);
  }

  async function clearSceneCache(id) {
    proj = { ...proj, ...(await guard(() => api("POST", `/api/projects/${slug}/cache`, { kind: "all", sceneId: id }), "Đã xoá cache scene")) };
    drawScenes();
  }

  async function clearAll(kind) {
    if (!(await confirmBox(kind === "voice" ? "Xoá toàn bộ giọng đã tạo? Lần render sau sẽ tạo lại giọng cho mọi scene." : "Xoá toàn bộ hình đã render? Lần render sau sẽ render lại mọi scene (mỗi scene ~15–20s)."))) return;
    proj = { ...proj, ...(await guard(() => api("POST", `/api/projects/${slug}/cache`, { kind }), "Đã xoá cache")) };
    drawScenes();
    drawSide();
  }

  async function duplicate() {
    const r = await guard(() => api("POST", `/api/projects/${slug}/duplicate`), "Đã nhân bản");
    location.hash = `#/p/${r.slug}`;
  }

  async function remove() {
    if (!(await confirmBox(`Xoá vĩnh viễn dự án "${script.metadata.title}" cùng video, giọng, cache?`, "Xoá", true))) return;
    await guard(() => api("DELETE", `/api/projects/${slug}`), "Đã xoá dự án");
    ctx.setGuard(null);
    location.hash = "#/";
  }

  async function reloadProject() {
    const fresh = await api("GET", `/api/projects/${slug}`);
    proj = fresh;
    imgState.images = fresh.images ?? [];
    if (!isDirty()) {
      script = clone(fresh.script);
      saved = JSON.stringify(script);
    }
    drawTabs();
    drawBody();
  }

  // ── live updates ──
  disposers.length = 0;
  const offJob = onJob((job, prev) => {
    if (!job) return drawSide();
    if (job.slug !== slug) return;
    const finished = ["done", "failed", "cancelled"].includes(job.status) && prev && !["done", "failed", "cancelled"].includes(prev.status);
    if (finished) {
      if (job.kind === "pipeline" && job.status === "done") {
        toast("🎉 Render xong!", "ok");
        tab = "result";
      } else if (job.status === "failed") toast(`Job lỗi: ${job.error ?? ""}`, "bad", 10000);
      reloadProject();
    } else if (tab === "script") {
      if (!prev || prev.status !== job.status) drawSide();
      else if (logHandle) {
        // progress-only update: refresh the bar + label without rebuilding the log
        const card = jobBox.querySelector(".card");
        if (card) {
          card.querySelector(".progress")?.replaceWith(progressBar(job));
          const p = job.progress;
          const lbl = card.querySelector(".small.muted");
          if (lbl && p) lbl.textContent = `Bước ${p.step}/${p.total}: ${p.label}`;
        }
      }
    }
  });

  const onKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save();
    }
  };
  document.addEventListener("keydown", onKey);

  drawTabs();
  drawBody();
  refreshPlan();

  return () => {
    offJob();
    offYt();
    logHandle?.dispose();
    document.removeEventListener("keydown", onKey);
  };
}

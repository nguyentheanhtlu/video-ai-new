import {
  api, bust, clear, confirmBox, connectEvents, el, fmtDate, fmtSec, guard, jobLogModal, jobs, liveLog,
  onJob, onYoutube, playUrl, progressBar, statusChip, toast, waitJob, UPLOAD_STATUS, fmtVN,
} from "./lib.js";
import { projectView } from "./editor.js";
import { store } from "./store.js";

const view = document.getElementById("view");
let cleanup = null;
let leaveGuard = null;
let lastHash = location.hash;

const ctx = { setGuard: (fn) => (leaveGuard = fn) };
const isLive = (j) => j.status === "running" || j.status === "queued";

// ── Router ─────────────────────────────────────────────────────────────────
const routes = [
  [/^#?\/?$/, "projects", projectsView],
  [/^#\/new$/, "new", newView],
  [/^#\/channels$/, "channels", channelsView],
  [/^#\/p\/([^/]+)$/, "projects", (root, slug) => projectView(root, decodeURIComponent(slug), ctx)],
  [/^#\/templates$/, "templates", templatesView],
  [/^#\/sfx$/, "sfx", sfxView],
  [/^#\/jobs$/, "jobs", jobsView],
  [/^#\/settings$/, "settings", settingsView],
];

async function route() {
  const hash = location.hash || "#/";
  if (leaveGuard) {
    const msg = leaveGuard();
    if (msg && hash !== lastHash && !(await confirmBox(msg, "Rời trang", true))) {
      history.replaceState(null, "", lastHash);
      return;
    }
  }
  lastHash = hash;
  leaveGuard = null;
  cleanup?.();
  cleanup = null;
  const [, nav, fn, params] = routes.map(([re, n, f]) => [re, n, f, hash.match(re)]).find(([, , , m]) => m) ?? [];
  document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("active", a.dataset.nav === nav));
  clear(view, el("div", { class: "row muted" }, el("span", { class: "spinner" }), "Đang tải…"));
  if (!fn) return clear(view, el("div", { class: "empty" }, "Không tìm thấy trang."));
  try {
    const root = el("div");
    const c = await fn(root, ...params.slice(1));
    clear(view, root);
    cleanup = typeof c === "function" ? c : null;
    window.scrollTo(0, 0);
  } catch (e) {
    clear(view, el("div", { class: "callout bad" }, e.message));
  }
}
window.addEventListener("hashchange", route);
window.addEventListener("beforeunload", (e) => {
  if (leaveGuard?.()) e.preventDefault();
});

// ── Sidebar status ─────────────────────────────────────────────────────────
let status = null;
async function refreshStatus() {
  try {
    status = await api("GET", "/api/status");
  } catch {
    return;
  }
  const chip = (ok, label, title) => el("span", { class: `chip ${ok ? "ok" : "bad"}`, title }, el("span", { class: "dot" }), label);
  clear(document.getElementById("status"),
    chip(status.ffmpeg && status.ffprobe, "FFmpeg", status.ffmpegDir ?? "Chưa có FFmpeg"),
    chip(!!status.chrome, "Chrome", status.chrome ?? "Không thấy Chrome/Edge"),
    chip(status.tts.ok, `Giọng đọc ${status.tts.ok ? "" : "(tắt)"}`, status.tts.endpoint),
    el("span", { class: `chip ${status.llm.configured ? "ok" : "warn"}`, title: status.llm.model }, el("span", { class: "dot" }), `AI: ${status.llm.provider}${status.llm.configured ? "" : " (chưa có key)"}`),
    el("span", { class: `chip ${status.sfx ? "ok" : "warn"}` }, el("span", { class: "dot" }), `SFX: ${status.sfx} file`),
  );
}

// ── Job dock ───────────────────────────────────────────────────────────────
const recentlyDone = new Map();
function drawDock() {
  const live = [...jobs.values()].filter(isLive);
  const done = [...recentlyDone.keys()].map((id) => jobs.get(id)).filter(Boolean);
  clear(document.getElementById("dock"),
    [...live, ...done].slice(0, 4).map((j) =>
      el("div", { class: "dock-job", onclick: () => jobLogModal(j.id), title: "Bấm để xem log" },
        el("div", { class: "row between" }, el("span", { class: "t grow" }, j.title), statusChip(j.status)),
        isLive(j) ? progressBar(j) : null,
        j.progress && isLive(j) ? el("div", { class: "small muted" }, `${j.progress.step}/${j.progress.total} · ${j.progress.label}`) : null,
        j.status === "failed" ? el("div", { class: "small", style: { color: "var(--bad)" } }, j.error) : null,
      )));
}
onJob((job, prev) => {
  if (job && prev && isLive(prev) && !isLive(job)) {
    recentlyDone.set(job.id, true);
    setTimeout(() => { recentlyDone.delete(job.id); drawDock(); }, job.status === "failed" ? 12000 : 6000);
    if (["sfx-download", "sfx-filter"].includes(job.kind)) { store.invalidate("sfx"); refreshStatus(); }
    if (job.kind === "preview-template") store.invalidate("templates");
  }
  drawDock();
});

// ── Projects ───────────────────────────────────────────────────────────────
async function projectsView(root) {
  const grid = el("div");
  async function draw() {
    const list = await api("GET", "/api/projects");
    if (!list.length) {
      return clear(grid, el("div", { class: "empty" },
        el("div", { class: "big" }, "🎞️"),
        el("h2", {}, "Chưa có dự án nào"),
        el("p", {}, "Dán link bài báo — AI viết kịch bản, pipeline lo giọng đọc, hình, âm thanh."),
        el("a", { class: "btn primary", href: "#/new" }, "✨ Tạo video đầu tiên")));
    }
    clear(grid, el("div", { class: "proj-grid" }, list.map((p) => {
      const job = [...jobs.values()].find((j) => j.slug === p.slug && isLive(j));
      const badge = job ? el("span", { class: "chip accent" }, el("span", { class: "spinner" }), "Đang xử lý")
        : p.hasVideo ? el("span", { class: "chip ok" }, "▶ ", fmtSec(p.lastRender?.durationSec) || "Có video")
        : p.lastRender && !p.lastRender.ok ? el("span", { class: "chip bad" }, "Lỗi render")
        : el("span", { class: "chip" }, "Nháp");
      return el("a", { class: "proj", href: `#/p/${encodeURIComponent(p.slug)}` },
        el("div", { class: "thumb" }, p.hasThumb ? el("img", { src: `/files/${p.slug}/thumb.jpg?t=${encodeURIComponent(p.updatedAt)}`, alt: "" }) : "🎬", badge),
        el("div", { class: "body" },
          el("div", { class: "title" }, p.title),
          el("div", { class: "small faint" }, `${p.scenes} scene · ${p.aspect} · ${fmtDate(p.updatedAt)}`)));
    })));
  }
  await draw();
  clear(root,
    el("div", { class: "page-head" },
      el("div", {}, el("h1", {}, "Dự án"), el("p", {}, "Mỗi dự án là một thư mục trong output/ — kịch bản, giọng đọc, clip, video.")),
      el("a", { class: "btn primary", href: "#/new" }, "✨ Tạo video mới")),
    grid);
  const off = onJob((job, prev) => { if (!job || !prev || job.status !== prev.status) draw(); });
  return off;
}

// ── New project ────────────────────────────────────────────────────────────
async function newView(root) {
  const st = status ?? (await api("GET", "/api/status"));
  const settings = await api("GET", "/api/settings");
  const customTemplates = (await store.templates()).filter((t) => t.generated);
  const channels = await api("GET", "/api/channels").catch(() => []);
  const styles = await api("GET", "/api/script-styles").catch(() => [{ id: "news", name: "Tin tức", hint: "" }]);
  let mode = "long";
  let disposeLog = null;

  const opt = {
    length: "standard",
    aspect: "9:16",
    channel: settings.CHANNEL_NAME,
    channelUrl: settings.CHANNEL_URL,
    extraInstructions: "",
    autoRender: true,
    templateId: "",
    keepScript: true,
    scriptStyle: styles.some((x) => x.id === localStorage.getItem("scriptStyle")) ? localStorage.getItem("scriptStyle") : "news",
  };
  // Remember the sample a channel works from, as long as it still exists.
  const lastTemplate = localStorage.getItem("templateId");
  if (customTemplates.some((t) => t.id === lastTemplate)) {
    opt.templateId = lastTemplate;
    opt.length = "sample";
  }

  const seg = (options, get, set) => {
    const box = el("div", { class: "seg" });
    const draw = () => clear(box, options.map(([v, l]) => el("button", { class: get() === v ? "active" : "", onclick: () => { set(v); draw(); } }, l)));
    draw();
    return box;
  };
  const field = (label, node, hint) => el("label", { class: "field" }, el("span", {}, label, hint ? el("em", {}, hint) : null), node);

  const urlInput = el("input", { type: "url", placeholder: "https://vnexpress.net/..." });
  const textArea = el("textarea", { rows: 12, placeholder: "Dán kịch bản hoặc nội dung bài vào đây…" });
  const fileTxt = el("input", { type: "file", accept: ".txt,text/plain", onchange: async (e) => { const f = e.target.files[0]; if (f) textArea.value = await f.text(); } });
  const blankTitle = el("input", { type: "text", placeholder: "Tên video", value: "" });
  const fileJson = el("input", { type: "file", accept: ".json,application/json" });
  const longUrls = el("textarea", { rows: 5, placeholder: "https://vnexpress.net/...\nhttps://bongda.com.vn/...\n(mỗi dòng 1 link, tối đa 8 — càng nhiều nguồn, video dài càng chắc nội dung)" });
  const longPrompt = el("textarea", { rows: 3, placeholder: "vd: Ronaldo treo áo số 7 — lùi lại để trao trách nhiệm cho thế hệ sau, giọng xúc động. Để trống thì AI tóm tắt theo các bài báo." });
  const long = {
    channelId: channels.some((c) => c.id === localStorage.getItem("channelId")) ? localStorage.getItem("channelId") : channels[0]?.id ?? "",
    minutes: 8,
  };
  const chOf = () => channels.find((c) => c.id === long.channelId);
  if (chOf()) long.minutes = chOf().minutes;
  long.scriptStyle = chOf()?.scriptStyle ?? opt.scriptStyle;

  /** "Kiểu kịch bản": news, affiliate, review… (get/set the value the current tab uses). */
  const stylePicker = (get, set) => {
    const hint = el("div", { class: "small muted" });
    const sel = el("select", { onchange: (e) => { set(e.target.value); hint.textContent = styles.find((x) => x.id === e.target.value)?.hint ?? ""; } },
      styles.map((x) => el("option", { value: x.id }, x.name)));
    sel.value = get();
    hint.textContent = styles.find((x) => x.id === get())?.hint ?? "";
    return el("div", { class: "stack", style: { gap: "4px" } }, field("Kiểu kịch bản", sel), hint);
  };

  const templatePicker = () => {
    const sel = el("select", { onchange: (e) => {
      opt.templateId = e.target.value;
      localStorage.setItem("templateId", opt.templateId);
      opt.length = opt.templateId ? "sample" : "standard";
      drawForm();
    } },
      el("option", { value: "" }, "Khung kênh mặc định"),
      customTemplates.map((t) => el("option", { value: t.id }, t.name)));
    sel.value = opt.templateId;
    return field("Template", sel, customTemplates.length ? "theo video mẫu" : null);
  };

  const lengths = () => [
    ...(opt.templateId ? [["sample", "Theo video mẫu"]] : []),
    ["short", "Ngắn · ~40s"],
    ["standard", "Chuẩn · ~100s"],
  ];

  const longOptions = () => {
    const sel = el("select", { onchange: (e) => {
      long.channelId = e.target.value;
      localStorage.setItem("channelId", long.channelId);
      if (chOf()) long.minutes = chOf().minutes;
      if (chOf()?.scriptStyle) long.scriptStyle = chOf().scriptStyle;
      drawForm();
    } },
      channels.map((c) => el("option", { value: c.id }, `${c.language === "en" ? "🇬🇧" : "🇻🇳"} ${c.name}`)),
      el("option", { value: "" }, "Cài đặt chung (không dùng hồ sơ kênh)"));
    sel.value = long.channelId;
    const minLabel = el("b", {}, `${long.minutes} phút`);
    const ch = chOf();
    return el("div", { class: "card stack" },
      el("h3", {}, "Tuỳ chọn video dài"),
      field("Kênh", sel, ch ? `${ch.language === "en" ? "tiếng Anh" : "tiếng Việt"}` : "theo Cài đặt"),
      stylePicker(() => long.scriptStyle, (v) => (long.scriptStyle = v)),
      channels.length ? null : el("div", { class: "callout small" }, "Chưa có hồ sơ kênh. ", el("a", { href: "#/channels" }, "Tạo kênh"), " để mỗi kênh có ngôn ngữ, giọng đọc, chủ đề riêng."),
      field("Độ dài", el("div", { class: "row" },
        el("input", { type: "range", min: 3, max: 15, step: 1, value: long.minutes, oninput: (e) => { long.minutes = Number(e.target.value); minLabel.textContent = `${long.minutes} phút`; } }), minLabel)),
      field("Yêu cầu thêm cho AI", el("textarea", { rows: 2, value: opt.extraInstructions, placeholder: "vd: giọng văn hài hước, thêm phần so sánh với mùa trước…", oninput: (e) => (opt.extraInstructions = e.target.value) }), "tuỳ chọn"),
      el("label", { class: "check" }, el("input", { type: "checkbox", checked: opt.autoRender, onchange: (e) => (opt.autoRender = e.target.checked) }), "Render video ngay sau khi có kịch bản"),
      (ch?.visuals ?? "ai") === "stock" && !st.stock?.length ? el("div", { class: "callout warn small" }, "Kênh này dùng video stock nhưng chưa có PIXABAY_API_KEY → chỉ dùng ảnh. ", el("a", { href: "#/settings" }, "Nhập key")) : null,
      (ch?.visuals ?? "ai") === "ai" ? el("div", { class: "small muted" }, "🎨 Ảnh AI (Gemini) được kiểm tra khớp lời đọc từng ảnh — cần GEMINI_API_KEY đã bật thanh toán.") : null,
      el("p", { class: "small faint", style: { margin: 0 } }, "Khung 16:9 · ảnh zoom chậm + clip · phụ đề · nhạc nền · chương YouTube · thumbnail."));
  };

  const optionsCard = () => mode === "long" ? longOptions() : el("div", { class: "card stack" },
    el("h3", {}, "Tuỳ chọn"),
    mode === "url" || mode === "text" ? templatePicker() : null,
    (mode === "url" || mode === "text") && !(mode === "text" && opt.keepScript)
      ? stylePicker(() => opt.scriptStyle, (v) => { opt.scriptStyle = v; localStorage.setItem("scriptStyle", v); })
      : null,
    mode === "text" ? field("Dùng văn bản này thế nào", seg([[true, "Đọc đúng kịch bản của tôi"], [false, "AI viết lại từ bài"]], () => opt.keepScript, (v) => { opt.keepScript = v; drawForm(); }),
      opt.keepScript ? "giữ nguyên từng chữ" : null) : null,
    (mode === "url" || mode === "text") && !(mode === "text" && opt.keepScript) ? el("div", { class: "row between" }, el("span", { class: "muted small" }, "Độ dài"),
      seg(lengths(), () => opt.length, (v) => (opt.length = v))) : null,
    mode !== "import" && !(opt.templateId && mode !== "blank") ? el("div", { class: "row between" }, el("span", { class: "muted small" }, "Khung hình"),
      seg([["9:16", "9:16 dọc"], ["16:9", "16:9 ngang"]], () => opt.aspect, (v) => (opt.aspect = v))) : null,
    mode === "url" || mode === "text" ? [
      el("div", { class: "grid-2" },
        field("Tên kênh", el("input", { type: "text", value: opt.channel, oninput: (e) => (opt.channel = e.target.value) })),
        field("URL kênh (outro)", el("input", { type: "text", value: opt.channelUrl, oninput: (e) => (opt.channelUrl = e.target.value) }))),
      mode === "text" && opt.keepScript ? null : field("Ý tưởng của kênh cho AI", el("textarea", { rows: 3, value: opt.extraInstructions, placeholder: "vd: Tập trung vào bức tâm thư và quyết định treo áo số 7, giọng xúc động, kết bằng câu hỏi cho khán giả…", oninput: (e) => (opt.extraInstructions = e.target.value) }), "AI viết theo ý tưởng này, bài báo chỉ để tham khảo"),
      el("label", { class: "check" }, el("input", { type: "checkbox", checked: opt.autoRender, onchange: (e) => (opt.autoRender = e.target.checked) }), mode === "text" && opt.keepScript ? "Render video ngay sau khi chia cảnh xong" : "Render video ngay sau khi AI viết xong kịch bản"),
    ] : null,
  );

  const formBox = el("div");
  const progressBox = el("div");

  function drawForm() {
    const needsLlm = mode === "url" || mode === "text" || mode === "long";
    const tabs = el("div", { class: "tabs" }, [["long", "🎞️ Video dài YouTube"], ["url", "🔗 Từ link bài báo"], ["text", "📝 Dán văn bản / .txt"], ["blank", "📄 Kịch bản trống"], ["import", "📦 Import script.json"]].map(([k, l]) =>
      el("button", { class: mode === k ? "active" : "", onclick: () => { mode = k; drawForm(); } }, l)));
    const main = {
      long: el("div", { class: "card stack" },
        field("Link bài báo", longUrls, "mỗi dòng 1 link"),
        field("Ý tưởng của kênh", longPrompt, "có ý tưởng thì AI viết theo ý tưởng, link chỉ để tham khảo"),
        el("p", { class: "small muted", style: { margin: 0 } }, "AI đọc các bài, lập dàn ý theo chương, viết lời dẫn, rồi lấy ảnh thật cho cảnh về người/sự kiện và vẽ ảnh AI (đã kiểm tra khớp lời đọc) cho các cảnh còn lại. Chỉ có chủ đề, không có link → AI viết từ kiến thức chung (nên kiểm tra lại dữ kiện).")),
      url: el("div", { class: "card stack" }, field("Link bài báo", urlInput), el("p", { class: "small muted", style: { margin: 0 } }, "Server tải trang và lấy nội dung chính. Trang cần đăng nhập / chặn bot → dùng tab Dán văn bản.")),
      text: el("div", { class: "card stack" }, field("Nội dung bài", textArea), el("div", { class: "row small muted" }, "Hoặc chọn file .txt:", fileTxt)),
      blank: el("div", { class: "card stack" }, field("Tên video", blankTitle), el("p", { class: "small muted", style: { margin: 0 } }, "Tạo kịch bản mẫu 3 scene (hook → body → outro) rồi tự viết trong trình soạn thảo. Không cần AI.")),
      import: el("div", { class: "card stack" }, field("File script.json", fileJson), el("p", { class: "small muted", style: { margin: 0 } }, "Ví dụ: script.json do /create-template-video trong Claude Code tạo ra.")),
    }[mode];
    clear(formBox,
      tabs,
      needsLlm && !st.llm.configured ? el("div", { class: "callout warn", style: { marginBottom: "14px" } },
        `Chưa có API key cho AI (${st.llm.provider}). `, el("a", { href: "#/settings" }, "Mở Cài đặt"), " để nhập key — Gemini có gói miễn phí. Hoặc dùng tab Kịch bản trống.") : null,
      el("div", { class: "editor" },
        el("div", { class: "stack" }, main,
          el("div", {}, el("button", { class: "btn primary", onclick: submit }, mode === "text" && opt.keepScript ? "🎬 Tạo video từ kịch bản này" : needsLlm ? "✨ Viết kịch bản bằng AI" : "Tạo dự án"))),
        el("div", { class: "side-sticky" }, optionsCard())));
  }

  async function submit(e) {
    const btn = e.currentTarget;
    let body;
    if (mode === "long") {
      const urls = longUrls.value.split(/\s+/).map((u) => u.trim()).filter(Boolean);
      const bad = urls.filter((u) => !/^https?:\/\//.test(u));
      if (bad.length) return toast(`Link không hợp lệ: ${bad[0]}`, "warn");
      if (!urls.length && longPrompt.value.trim().length < 10) return toast("Nhập ít nhất 1 link, hoặc mô tả chủ đề video", "warn");
      body = { mode, urls, prompt: longPrompt.value.trim(), channelId: long.channelId || undefined, minutes: long.minutes, extraInstructions: opt.extraInstructions, autoRender: opt.autoRender, scriptStyle: long.scriptStyle };
    } else if (mode === "url") {
      if (!/^https?:\/\//.test(urlInput.value.trim())) return toast("Nhập link bắt đầu bằng http:// hoặc https://", "warn");
      body = { mode, url: urlInput.value.trim(), ...opt };
    } else if (mode === "text") {
      if (textArea.value.trim().length < 50) return toast("Nội dung quá ngắn", "warn");
      body = { mode, text: textArea.value, ...opt };
    } else if (mode === "blank") {
      body = { mode, title: blankTitle.value.trim() || "Video mới", aspect: opt.aspect };
    } else {
      const f = fileJson.files[0];
      if (!f) return toast("Chọn file script.json", "warn");
      try { body = { mode, script: JSON.parse(await f.text()) }; } catch (err) { return toast(`File không phải JSON: ${err.message}`, "bad"); }
    }
    btn.disabled = true;
    try {
      const r = await guard(() => api("POST", "/api/projects", body));
      if (r.slug) return (location.hash = `#/p/${r.slug}`);
      disposeLog?.();
      const log = liveLog(r.jobId);
      disposeLog = log.dispose;
      const barBox = el("div", {}, progressBar(jobs.get(r.jobId) ?? { status: "running" }));
      const off = onJob((j) => { if (j?.id === r.jobId) clear(barBox, progressBar(j)); });
      clear(progressBox, el("div", { class: "card stack", style: { marginTop: "16px" } },
        el("h3", {}, "AI đang viết kịch bản…"), barBox, log.node));
      const job = await waitJob(r.jobId);
      off();
      if (job.status === "done") {
        toast(opt.autoRender ? "Đã có kịch bản — đang render video" : "Đã có kịch bản", "ok");
        location.hash = `#/p/${job.result.slug}`;
      } else {
        toast(job.error ?? "Không tạo được kịch bản", "bad", 12000);
      }
    } finally {
      btn.disabled = false;
    }
  }

  drawForm();
  clear(root,
    el("div", { class: "page-head" }, el("div", {}, el("h1", {}, "Tạo video mới"), el("p", {}, "Video dài 16:9 cho YouTube, hoặc video ngắn 9:16 từ một bài báo."))),
    formBox, progressBox);
  return () => disposeLog?.();
}

// ── Channels ───────────────────────────────────────────────────────────────
async function channelsView(root) {
  const [settings, edgeVoices, scriptStyles] = await Promise.all([api("GET", "/api/settings"), store.voices().catch(() => []), api("GET", "/api/script-styles").catch(() => [])]);
  let list = await api("GET", "/api/channels");
  let yt = await api("GET", "/api/youtube/status").catch(() => null);
  const field = (label, node, hint) => el("label", { class: "field" }, el("span", {}, label, hint ? el("em", {}, hint) : null), node);
  const listBox = el("div", { class: "stack" });
  const queueBox = el("div", { class: "stack", style: { marginTop: "20px" } });
  const formBox = el("div");

  const blank = () => ({
    name: "", language: "vi", niche: "", url: "", brandColor: "#0e9f6e", minutes: 8, music: true, subtitles: true,
    visuals: "ai", aiImageSize: "2K", aiHookVideo: false,
    autoUpload: false, publishTimes: ["19:00"], privacy: "public", categoryId: "22", declareSynthetic: true, scriptStyle: "news",
    voice: settings.GENMAX_API_KEY_SET
      ? { engine: "genmax", rate: "+0%", genmax: { provider: settings.GENMAX_PROVIDER, voiceId: settings.GENMAX_VOICE, model: settings.GENMAX_MODEL, language: settings.GENMAX_LANGUAGE } }
      : { engine: "edge", edgeVoice: "vi-VN-HoaiMyNeural", rate: "+5%" },
  });

  /** Connection status + auto-upload summary under each channel. */
  function ytLine(c) {
    if (!yt?.configured && !yt?.facebook?.configured) return null;
    const chips = [];
    if (yt.configured) {
      const con = yt.connections?.[c.id];
      chips.push(!con ? el("span", { class: "chip" }, "YouTube: chưa kết nối")
        : con.broken ? el("span", { class: "chip bad" }, `YouTube: ${con.broken} — kết nối lại`)
        : el("span", { class: "chip ok" }, `▶ ${con.youtube.title}`));
    }
    if (yt.facebook?.configured) {
      const fb = yt.facebook.connections?.[c.id];
      chips.push(!fb ? el("span", { class: "chip" }, "Facebook: chưa kết nối")
        : fb.broken ? el("span", { class: "chip bad" }, `Facebook: ${fb.broken} — kết nối lại`)
        : el("span", { class: "chip info" }, `f ${fb.page.name}`));
    }
    const slot = yt.nextSlots?.[c.id];
    return el("div", { class: "small row", style: { marginTop: "4px", gap: "6px", flexWrap: "wrap" } },
      chips,
      el("span", { class: c.autoUpload ? "chip accent" : "chip" }, c.autoUpload ? "Tự đăng sau khi render" : "Đăng thủ công"),
      c.publishTimes?.length
        ? el("span", { class: "faint" }, `Lịch: ${c.publishTimes.join(", ")}${slot ? ` · giờ trống kế tiếp ${fmtVN(slot)}` : ""}`)
        : el("span", { class: "faint" }, "Công khai ngay khi tải xong"));
  }

  function ytButton(c) {
    const out = [];
    if (yt?.configured) {
      const con = yt.connections?.[c.id];
      out.push(!con || con.broken
        ? el("a", { class: "btn sm", href: `/api/youtube/connect?channel=${encodeURIComponent(c.id)}` }, "🔗 Kết nối YouTube")
        : el("button", { class: "btn ghost sm", onclick: async () => {
          if (!(await confirmBox(`Ngắt kết nối "${c.name}" khỏi kênh YouTube "${con.youtube.title}"? Token sẽ bị thu hồi.`, "Ngắt kết nối", true))) return;
          await guard(() => api("POST", `/api/youtube/disconnect/${c.id}`), "Đã ngắt kết nối");
          await refreshYt();
        } }, "Ngắt YouTube"));
    }
    if (yt?.facebook?.configured) {
      const fb = yt.facebook.connections?.[c.id];
      out.push(!fb || fb.broken
        ? el("a", { class: "btn sm", href: `/api/facebook/connect?channel=${encodeURIComponent(c.id)}` }, "🔗 Kết nối Facebook")
        : el("button", { class: "btn ghost sm", onclick: async () => {
          if (!(await confirmBox(`Ngắt "${c.name}" khỏi Page "${fb.page.name}"?`, "Ngắt kết nối", true))) return;
          await guard(() => api("POST", `/api/facebook/disconnect/${c.id}`), "Đã ngắt Facebook");
          await refreshYt();
        } }, "Ngắt Facebook"));
    }
    return out;
  }

  function drawQueue() {
    if (!yt) return clear(queueBox);
    if (!yt.configured && !yt.facebook?.configured) {
      return clear(queueBox, el("div", { class: "callout warn small" },
        "Chưa có credentials/client_secret.json — tạo OAuth Client ID (Desktop app) trong Google Cloud rồi đặt file vào thư mục credentials/ để đăng YouTube tự động."));
    }
    const q = yt.quota;
    const pct = Math.min(100, Math.round((q.used / q.limit) * 100));
    const name = (id) => list.find((c) => c.id === id)?.name ?? id;
    const rows = yt.uploads.slice(0, 40).map((u) => {
      const [cls, label] = UPLOAD_STATUS[u.status] ?? ["chip", u.status];
      const when = u.publishAt ? `công khai ${fmtVN(u.publishAt)}` : u.privacy === "public" ? "công khai ngay" : u.privacy === "unlisted" ? "không công khai" : "riêng tư";
      return el("div", { class: "card row between", style: { padding: "10px 14px" } },
        el("div", { class: "stack", style: { gap: "2px", minWidth: 0 } },
          el("div", { class: "row", style: { gap: "8px" } },
            el("span", { class: u.platform === "facebook" ? "chip info" : "chip bad" }, u.platform === "facebook" ? "Facebook" : "YouTube"),
            el("span", { class: cls }, u.status === "uploading" && u.progress != null ? `${label} ${u.progress}%` : label),
            el("a", { href: `#/p/${encodeURIComponent(u.slug)}`, style: { fontWeight: 600 } }, u.title)),
          el("div", { class: "small faint" },
            `${name(u.channelId)} · ${when}` + (u.nextTryAt && u.status === "pending" ? ` · thử lại ${fmtVN(u.nextTryAt)}` : "") + (u.auto ? " · tự động" : "")),
          u.error ? el("div", { class: "small", style: { color: "var(--bad)" } }, u.error) : null,
          (u.warnings ?? []).map((w) => el("div", { class: "small", style: { color: "var(--warn)" } }, w))),
        el("div", { class: "row" },
          u.videoId ? el("a", { class: "btn sm", href: u.url ?? `https://studio.youtube.com/video/${u.videoId}/edit`, target: "_blank" }, u.platform === "facebook" ? "Mở Facebook" : "Mở Studio") : null,
          u.status === "failed" ? el("button", { class: "btn sm", onclick: () => guard(() => api("POST", `/api/youtube/uploads/${u.id}/retry`), "Đã xếp lại hàng đợi") }, "Thử lại") : null,
          u.status === "pending" || u.status === "failed"
            ? el("button", { class: "btn ghost sm danger", onclick: () => guard(() => api("DELETE", `/api/youtube/uploads/${u.id}`), "Đã bỏ khỏi hàng đợi") }, "Bỏ")
            : null));
    });
    clear(queueBox,
      el("div", { class: "row between" },
        el("h2", {}, "📤 Hàng đợi đăng YouTube"),
        el("span", { class: "small muted" }, `Quota hôm nay: ${q.used.toLocaleString("vi-VN")} / ${q.limit.toLocaleString("vi-VN")} (còn ~${Math.floor(q.remaining / 1650)} video) · reset 0h giờ Mỹ`)),
      el("div", { class: "progress" }, el("div", { style: { width: `${pct}%` } })),
      el("div", { class: "callout small" },
        "Khi dự án Google Cloud chưa qua kiểm duyệt (audit) của YouTube, video tải lên qua API sẽ bị YouTube khoá ở chế độ Riêng tư dù đã đặt lịch công khai. Được duyệt rồi thì mọi thứ tự chạy, không cần sửa gì."),
      rows.length ? rows : el("div", { class: "empty small" }, "Chưa có video nào trong hàng đợi. Bật \"Tự đăng sau khi render\" ở kênh, hoặc bấm Đăng YouTube trong trang video."));
  }

  async function refreshYt() {
    yt = await api("GET", "/api/youtube/status").catch(() => yt);
    drawList();
    drawQueue();
  }

  function drawList() {
    clear(listBox, list.length === 0
      ? el("div", { class: "empty" }, el("div", { class: "big" }, "📺"), el("p", {}, "Chưa có kênh nào. Mỗi kênh có ngôn ngữ, giọng đọc, chủ đề và màu riêng — tạo bao nhiêu kênh cũng được."))
      : list.map((c) => el("div", { class: "card row between" },
        el("div", { class: "row" },
          el("span", { style: { width: "14px", height: "40px", borderRadius: "4px", background: c.brandColor } }),
          el("div", {},
            el("b", {}, `${c.language === "en" ? "🇬🇧" : "🇻🇳"} ${c.name}`),
            el("div", { class: "small muted" }, c.niche ? c.niche.slice(0, 110) : "(chưa mô tả chủ đề)"),
            el("div", { class: "small faint" }, `${c.voice.engine === "genmax" ? `Genmax ${c.voice.genmax?.provider ?? ""}` : c.voice.edgeVoice} · ${c.minutes} phút · ${c.visuals === "stock" ? "video stock" : "ảnh AI"} · id: ${c.id}`),
            ytLine(c))),
        el("div", { class: "row" },
          ytButton(c),
          el("button", { class: "btn primary sm", onclick: () => { localStorage.setItem("channelId", c.id); location.hash = "#/new"; } }, "✨ Tạo video"),
          el("button", { class: "btn sm", onclick: () => drawForm(structuredClone(c)) }, "Sửa"),
          el("button", { class: "btn ghost sm danger", onclick: async () => {
            if (!(await confirmBox(`Xoá kênh "${c.name}"? Các dự án đã tạo không bị xoá.`, "Xoá", true))) return;
            list = await guard(() => api("DELETE", `/api/channels/${c.id}`), "Đã xoá kênh");
            drawList();
          } }, "Xoá")))));
  }

  async function drawForm(ch) {
    if (!ch) return clear(formBox);
    const text = (key, props = {}) => el("input", { type: "text", value: ch[key] ?? "", oninput: (e) => (ch[key] = e.target.value), ...props });
    const niche = el("textarea", { rows: 3, placeholder: "vd: Tin bóng đá châu Âu, phân tích chiến thuật, giọng sôi nổi, hay đặt câu hỏi cho khán giả", oninput: (e) => (ch.niche = e.target.value) });
    niche.value = ch.niche ?? "";
    const langSeg = el("div", { class: "seg" }, [["vi", "🇻🇳 Tiếng Việt"], ["en", "🇬🇧 Tiếng Anh"]].map(([v, l]) =>
      el("button", { class: ch.language === v ? "active" : "", onclick: () => {
        ch.language = v;
        if (ch.voice.engine === "edge") ch.voice.edgeVoice = v === "vi" ? "vi-VN-HoaiMyNeural" : "en-US-AndrewMultilingualNeural";
        drawForm(ch);
      } }, l)));
    const color = el("input", { type: "color", value: ch.brandColor, oninput: (e) => (ch.brandColor = e.target.value) });
    const minutes = el("input", { type: "number", min: 2, max: 20, value: ch.minutes, style: { width: "90px" }, oninput: (e) => (ch.minutes = Number(e.target.value) || 8) });
    const check = (key, label) => el("label", { class: "check" }, el("input", { type: "checkbox", checked: ch[key] !== false, onchange: (e) => (ch[key] = e.target.checked) }), label);

    // Voice
    const voiceBox = el("div", { class: "stack" });
    const rateNum = parseInt(ch.voice.rate ?? "+0%", 10) || 0;
    const rateLabel = el("b", {}, `${rateNum >= 0 ? "+" : ""}${rateNum}%`);
    const rate = el("input", { type: "range", min: -20, max: 40, step: 1, value: rateNum, oninput: (e) => {
      const v = Number(e.target.value);
      ch.voice.rate = `${v >= 0 ? "+" : ""}${v}%`;
      rateLabel.textContent = ch.voice.rate;
    } });
    async function drawVoice() {
      const engineSeg = el("div", { class: "seg" }, [["edge", "Edge TTS (miễn phí)"], ["genmax", "Genmax"]].map(([v, l]) =>
        el("button", { class: ch.voice.engine === v ? "active" : "", onclick: () => { ch.voice.engine = v; drawVoice(); } }, l)));
      if (ch.voice.engine === "edge") {
        const want = ch.language === "vi" ? (v) => v.locale === "vi-VN" : (v) => v.locale.startsWith("en-");
        const opts = edgeVoices.filter(want);
        if (!opts.some((v) => v.id === ch.voice.edgeVoice)) ch.voice.edgeVoice = opts[0]?.id ?? ch.voice.edgeVoice;
        const sel = el("select", { onchange: (e) => (ch.voice.edgeVoice = e.target.value) },
          opts.map((v) => el("option", { value: v.id }, `${v.id} (${v.gender === "Female" ? "nữ" : "nam"})`)));
        sel.value = ch.voice.edgeVoice;
        delete ch.voice.genmax;
        return clear(voiceBox, engineSeg, field("Giọng", sel, `${opts.length} giọng ${ch.language === "vi" ? "tiếng Việt" : "tiếng Anh"}`));
      }
      if (!settings.GENMAX_API_KEY_SET) return clear(voiceBox, engineSeg, el("div", { class: "callout warn small" }, "Chưa có GENMAX_API_KEY — nhập ở ", el("a", { href: "#/settings" }, "Cài đặt"), " trước."));
      ch.voice.genmax ??= { provider: "minimax", voiceId: "", model: "", language: "" };
      const g = ch.voice.genmax;
      clear(voiceBox, engineSeg, el("div", { class: "muted small" }, "Đang tải giọng Genmax…"));
      let cat;
      try { cat = await api("GET", `/api/genmax/catalog?provider=${g.provider}`); } catch (err) { return clear(voiceBox, engineSeg, el("div", { class: "callout bad small" }, err.message)); }
      const langMatch = (l) => (ch.language === "vi" ? /vi|việt|vietnam/i.test(l) : /^en|english/i.test(l));
      const voices = [...cat.voices].sort((a, b) => Number(langMatch(b.language)) - Number(langMatch(a.language)));
      if (!voices.some((v) => v.id === g.voiceId)) { const v = voices[0]; if (v) { g.voiceId = v.id; g.language = v.language; } }
      if (!cat.models.some((m) => m.id === g.model)) g.model = cat.defaultModel;
      const search = el("input", { type: "text", placeholder: `Tìm trong ${voices.length} giọng…`, oninput: () => fill() });
      const vSel = el("select", { onchange: (e) => { const v = voices.find((x) => x.id === e.target.value); g.voiceId = v.id; g.language = v.language; } });
      const fill = () => {
        const q = search.value.trim().toLowerCase();
        const hits = voices.filter((v) => !q || `${v.name} ${v.language}`.toLowerCase().includes(q));
        const langs = [...new Set(hits.map((v) => v.language))];
        clear(vSel, langs.map((l) => el("optgroup", { label: l }, hits.filter((v) => v.language === l).map((v) => el("option", { value: v.id }, `${v.name}${v.gender ? ` (${v.gender})` : ""}`)))));
        vSel.value = g.voiceId;
      };
      fill();
      const mSel = el("select", { onchange: (e) => (g.model = e.target.value) }, cat.models.map((m) => el("option", { value: m.id }, m.name)));
      mSel.value = g.model;
      clear(voiceBox, engineSeg,
        el("div", { class: "seg" }, [["minimax", "MiniMax"], ["capcut", "CapCut"], ["elevenlabs", "ElevenLabs"]].map(([v, l]) =>
          el("button", { class: g.provider === v ? "active" : "", onclick: () => { g.provider = v; g.voiceId = ""; drawVoice(); } }, l))),
        el("div", { class: "grid-2" }, field("Tìm giọng", search), field("Giọng", vSel, ch.language === "vi" ? "giọng tiếng Việt xếp trước" : "giọng tiếng Anh xếp trước"), field("Model", mSel)));
    }
    drawVoice();

    // Visuals: AI illustrations (Gemini, checked against the narration) or stock footage.
    ch.visuals ??= "ai";
    ch.aiImageSize ??= "2K";
    const visualsBox = el("div", { class: "stack" });
    const drawVisuals = () => {
      const perImage = ch.aiImageSize === "1K" ? 0.034 : 0.05;
      // ~1 image per 7s of narration, plus ~30% redraws after the check.
      const imgs = Math.round((ch.minutes * 60) / 7);
      const cost = imgs * perImage * 1.3 + (ch.aiHookVideo ? 1 : 0);
      clear(visualsBox,
        el("div", { class: "seg" }, [["ai", "🎨 Ảnh AI (Gemini)"], ["stock", "🎞 Video stock (Pixabay)"]].map(([v, l]) =>
          el("button", { class: ch.visuals === v ? "active" : "", onclick: () => { ch.visuals = v; drawVisuals(); } }, l))),
        ch.visuals === "ai"
          ? el("div", { class: "stack" },
            el("p", { class: "small muted", style: { margin: 0 } },
              "AI viết prompt riêng cho từng cảnh theo lời đọc → Gemini vẽ → một model khác xem lại từng ảnh, chấm điểm độ khớp với lời đọc và lỗi hình (chữ, người dị dạng, sai chủ đề); dưới 7/10 thì vẽ lại. Cảnh nói về người thật / sự kiện cụ thể vẫn dùng ảnh thật từ bài báo."),
            el("div", { class: "grid-2" },
              field("Độ nét ảnh", (() => {
                const sel = el("select", { onchange: (e) => { ch.aiImageSize = e.target.value; drawVisuals(); } },
                  el("option", { value: "2K" }, "2K — nét cho 1080p (~0,05 USD/ảnh)"), el("option", { value: "1K" }, "1K — rẻ hơn (~0,034 USD/ảnh)"));
                sel.value = ch.aiImageSize;
                return sel;
              })()),
              field("Clip mở đầu", el("label", { class: "check" },
                el("input", { type: "checkbox", checked: !!ch.aiHookVideo, onchange: (e) => { ch.aiHookVideo = e.target.checked; drawVisuals(); } }),
                "Biến ảnh hook thành clip động (~0,1 USD/giây)"))),
            el("div", { class: "callout small" }, `Ước tính video ${ch.minutes} phút: ~${imgs} ảnh → khoảng ${cost.toFixed(1)} USD (giá niêm yết Google, chưa gồm giọng đọc). Cần GEMINI_API_KEY đã bật thanh toán.`))
          : el("p", { class: "small muted", style: { margin: 0 } }, "Video stock miễn phí từ Pixabay (cần PIXABAY_API_KEY). Cảnh không có video phù hợp dùng ảnh."));
    };
    drawVisuals();
    minutes.addEventListener("input", drawVisuals);

    function uploadBox(ch) {
      ch.publishTimes ??= ["19:00"];
      ch.privacy ??= "public";
      ch.categoryId ??= "22";
      const times = el("input", { type: "text", value: ch.publishTimes.join(", "), placeholder: "vd: 07:00, 19:00",
        oninput: (e) => (ch.publishTimes = e.target.value.split(/[,\s]+/).filter(Boolean)
          .map((t) => (/^\d:\d{2}$/.test(t) ? `0${t}` : t)).filter((t) => /^\d{2}:\d{2}$/.test(t))) });
      const privacy = el("select", { onchange: (e) => (ch.privacy = e.target.value) },
        el("option", { value: "public" }, "Công khai"), el("option", { value: "unlisted" }, "Không công khai (có link mới xem được)"), el("option", { value: "private" }, "Riêng tư"));
      privacy.value = ch.privacy;
      const cat = el("select", { onchange: (e) => (ch.categoryId = e.target.value) },
        [["22", "Mọi người & Blog"], ["25", "Tin tức & Chính trị"], ["17", "Thể thao"], ["24", "Giải trí"], ["27", "Giáo dục"], ["28", "Khoa học & Công nghệ"], ["10", "Âm nhạc"], ["20", "Trò chơi"]]
          .map(([v, l]) => el("option", { value: v }, l)));
      cat.value = ch.categoryId;
      const con = ch.id ? yt?.connections?.[ch.id] : null;
      return el("div", { class: "stack" },
        el("label", { class: "check" }, el("input", { type: "checkbox", checked: !!ch.autoUpload, onchange: (e) => (ch.autoUpload = e.target.checked) }),
          "Tự đăng lên YouTube ngay khi render xong"),
        el("div", { class: "grid-2" },
          field("Giờ công khai mỗi ngày (giờ VN)", times, "mỗi video lấy giờ trống kế tiếp; để trống = công khai ngay"),
          field("Chế độ hiển thị", privacy, "khi không đặt lịch"),
          field("Danh mục YouTube", cat)),
        el("label", { class: "check" }, el("input", { type: "checkbox", checked: ch.declareSynthetic !== false, onchange: (e) => (ch.declareSynthetic = e.target.checked) }),
          "Khai báo \"nội dung đã chỉnh sửa / tạo bằng AI\" (nên bật vì giọng và ảnh là AI)"),
        !ch.id ? el("p", { class: "small faint", style: { margin: 0 } }, "Lưu kênh trước, rồi bấm \"Kết nối YouTube\" ở danh sách kênh.")
          : con ? el("p", { class: "small faint", style: { margin: 0 } }, `Đã kết nối: ${con.youtube.title}`)
          : el("p", { class: "small", style: { margin: 0, color: "var(--warn)" } }, "Kênh chưa kết nối YouTube — bấm \"Kết nối YouTube\" ở danh sách kênh."));
    }
    const sample = el("input", { type: "text", value: ch.language === "vi" ? "Chào mừng các bạn quay trở lại với kênh. Hôm nay chúng ta sẽ cùng tìm hiểu một câu chuyện rất thú vị." : "Welcome back to the channel. Today we are diving into a story you will not want to miss." });
    const tryBtn = el("button", { class: "btn", onclick: async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      try {
        const blob = await api("POST", "/api/tts/preview", { text: sample.value, voice: ch.voice.edgeVoice, rate: ch.voice.rate, genmax: ch.voice.engine === "genmax" ? ch.voice.genmax : null });
        new Audio(URL.createObjectURL(blob)).play();
      } catch (err) { toast(err.message, "bad"); } finally { b.disabled = false; }
    } }, "🔊 Nghe thử");

    clear(formBox, el("div", { class: "card stack", style: { marginTop: "16px" } },
      el("div", { class: "row between" }, el("h2", {}, ch.id ? `Sửa kênh: ${ch.name}` : "Kênh mới"), el("button", { class: "btn ghost sm", onclick: () => drawForm(null) }, "Đóng")),
      el("div", { class: "grid-2" },
        field("Tên kênh", text("name", { placeholder: "vd: Bóng Đá 24h" }), "hiện trên video"),
        field("Ngôn ngữ", langSeg),
        field("Link kênh", text("url", { placeholder: "https://youtube.com/@..." })),
        field("Màu nhận diện", el("div", { class: "row" }, color, el("span", { class: "small faint" }, "thẻ chương, thumbnail")))),
      field("Chủ đề & phong cách", niche, "AI dùng cho mọi kịch bản của kênh"),
      (() => {
        const sel = el("select", { onchange: (e) => (ch.scriptStyle = e.target.value) }, scriptStyles.map((x) => el("option", { value: x.id }, `${x.name} — ${x.hint}`)));
        sel.value = ch.scriptStyle ?? "news";
        return field("Kiểu kịch bản mặc định", sel, "đổi được khi tạo từng video");
      })(),
      el("h3", {}, "🎙 Giọng đọc"),
      voiceBox,
      el("div", { class: "grid-2" },
        field("Tốc độ đọc", el("div", { class: "row" }, rate, rateLabel)),
        field("Độ dài mặc định (phút)", minutes)),
      el("div", { class: "row" }, el("div", { class: "grow" }, sample), tryBtn),
      el("div", { class: "row" }, check("subtitles", "In phụ đề lên video"), check("music", "Nhạc nền")),
      el("h3", {}, "🖼 Hình minh hoạ"),
      visualsBox,
      el("h3", {}, "📤 Đăng YouTube"),
      uploadBox(ch),
      ch.id ? el("p", { class: "small faint", style: { margin: 0 } }, `Nhạc riêng của kênh: chép mp3 vào assets/music/${ch.id}/`) : null,
      el("div", { class: "row" }, el("button", { class: "btn primary", onclick: async () => {
        if (!ch.name?.trim()) return toast("Nhập tên kênh", "warn");
        const saved = await guard(() => api("POST", "/api/channels", ch), "Đã lưu kênh");
        list = await api("GET", "/api/channels");
        drawList();
        drawForm(null);
        return saved;
      } }, "💾 Lưu kênh"))));
    formBox.scrollIntoView({ behavior: "smooth" });
  }

  drawList();
  drawQueue();
  clear(root,
    el("div", { class: "page-head" },
      el("div", {}, el("h1", {}, "Kênh YouTube"), el("p", {}, "Mỗi kênh: ngôn ngữ, giọng đọc, chủ đề, màu riêng. Video dài được làm theo kênh bạn chọn.")),
      el("button", { class: "btn primary", onclick: () => drawForm(blank()) }, "+ Thêm kênh")),
    listBox, formBox, queueBox);
  return onYoutube(refreshYt);
}

// ── Templates ──────────────────────────────────────────────────────────────
async function templatesView(root) {
  let aspect = "9:16";
  const grid = el("div", { class: "tpl-grid" });
  const st = status ?? (await api("GET", "/api/status"));
  const refUrl = el("input", { type: "url", placeholder: "https://www.youtube.com/shorts/… hoặc link TikTok" });
  const refFile = el("input", { type: "file", accept: "video/*" });
  const refName = el("input", { type: "text", placeholder: "Bỏ trống để lấy tiêu đề video hoặc tên file" });
  const refProgress = el("div");
  async function createFromSample(e) {
    const btn = e.currentTarget;
    const url = refUrl.value.trim();
    const file = refFile.files[0];
    if (!url && !file) return toast("Dán link hoặc chọn file video mẫu", "warn");
    btn.disabled = true;
    try {
      let body = { url, name: refName.value.trim() };
      if (!url) {
        clear(refProgress, el("div", { class: "muted small" }, "Đang tải file lên…"));
        const res = await fetch("/api/templates/reference-upload", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `Lỗi ${res.status}`);
        body = { uploadId: data.uploadId, name: refName.value.trim() || file.name.replace(/\.[^.]+$/, "") };
      }
      const { jobId } = await api("POST", "/api/templates/from-reference", body);
      const log = liveLog(jobId);
      const bar = el("div", {}, progressBar(jobs.get(jobId) ?? { status: "running" }));
      const off = onJob((j) => { if (j?.id === jobId) clear(bar, progressBar(j)); });
      clear(refProgress, bar, log.node);
      const job = await waitJob(jobId);
      off();
      log.dispose();
      if (job.status !== "done") throw new Error(job.error ?? "Không tạo được template");
      refUrl.value = "";
      refFile.value = "";
      refName.value = "";
      clear(refProgress);
      toast("Đã tạo template mới, chọn nó ở trang Tạo video", "ok");
      draw(true);
    } catch (err) {
      clear(refProgress, el("div", { class: "callout warn small" }, err.message));
    } finally { btn.disabled = false; }
  }
  const sampleCard = el("div", { class: "card stack", style: { marginBottom: "16px" } },
    el("h2", {}, "🎬 Tạo template từ video mẫu"),
    el("p", { class: "small muted", style: { margin: 0 } }, "AI xem video mẫu, dựng bố cục, màu chữ và nhịp kể riêng rồi lưu vào templates/. Hình và tiếng của video mẫu không được dùng lại. Mất khoảng 5–15 phút."),
    !st.ytDlp ? el("div", { class: "callout warn small" }, "Máy chưa có yt-dlp nên chưa tải được link. Chạy winget install yt-dlp.yt-dlp rồi khởi động lại web, hoặc chọn file video bên dưới.") : null,
    el("div", { class: "grid-2" }, el("label", { class: "field" }, el("span", {}, "Link video"), refUrl), el("label", { class: "field" }, el("span", {}, "Hoặc file video"), refFile)),
    el("label", { class: "field" }, el("span", {}, "Tên template", el("em", {}, "tuỳ chọn")), refName),
    el("div", {}, el("button", { class: "btn primary", onclick: createFromSample }, "✨ Tạo template")),
    refProgress);
  async function draw(fresh = false) {
    const list = (await store.templates(fresh)).filter((t) => t.aspects.includes(aspect) && !t.virtual);
    clear(grid, list.map((t) => {
      const preview = t.previews?.[aspect];
      const running = [...jobs.values()].find((j) => j.kind === "preview-template" && isLive(j) && j.title.includes(t.id) && j.title.includes(aspect));
      const box = el("div", { class: `clip-box ${aspect === "16:9" ? "wide" : ""}` },
        preview ? el("video", { src: bust(preview), muted: true, loop: true, autoplay: true, playsinline: true })
          : running ? el("div", { class: "stack", style: { alignItems: "center" } }, el("span", { class: "spinner" }), "Đang render…")
          : el("button", { class: "btn sm", onclick: () => guard(() => api("POST", `/api/templates/${t.id}/preview`, { aspect }), "Đang render xem trước (~20s)").then(() => draw()) }, "▶ Xem trước"));
      return el("div", { class: "card tpl" },
        box,
        el("div", { class: "stack", style: { gap: "8px", minWidth: 0 } },
          el("div", {}, el("h3", { class: "mono", style: { fontSize: "13.5px" } }, t.id), el("div", { class: "small muted" }, t.name)),
          el("div", { class: "row", style: { gap: "4px" } }, t.roles.map((r) => el("span", { class: `chip ${r === "hook" ? "accent" : r === "outro" ? "info" : ""}` }, r))),
          el("div", { class: "small" }, t.role),
          t.bestFor ? el("div", { class: "small muted" }, "Hợp với: ", t.bestFor) : null,
          t.style?.outline?.length ? el("details", {}, el("summary", {}, `Khung kịch bản · ${t.style.outline.length} đoạn`),
            el("ol", { class: "small", style: { margin: "6px 0 0", paddingLeft: "18px" } }, t.style.outline.map((o) =>
              el("li", {}, el("b", {}, o.part), o.share ? ` (~${o.share}%)` : "", o.pattern ? el("div", { class: "muted" }, o.pattern) : null)))) : null,
          el("details", {}, el("summary", {}, `${t.slots.length} ô nhập liệu`),
            el("table", { class: "slot-table" }, t.slots.map((s) => el("tr", {}, el("td", {}, s.name), el("td", { class: "muted" }, s.type, s.limit ? ` · ${s.limit}` : ""), el("td", { class: "faint" }, s.notes))))),
          el("details", {}, el("summary", {}, "Dữ liệu mẫu"), el("pre", { class: "log", style: { maxHeight: "200px" } }, JSON.stringify(t.defaults, null, 2))),
          preview ? el("button", { class: "btn ghost sm", style: { alignSelf: "flex-start" }, onclick: () => guard(() => api("POST", `/api/templates/${t.id}/preview`, { aspect }), "Đang render lại…").then(() => draw()) }, "↻ Render lại") : null,
          t.generated ? el("button", { class: "btn ghost sm", style: { alignSelf: "flex-start" }, onclick: async () => {
            if (!(await confirmBox(`Xoá template "${t.name}"? Dự án đang dùng nó sẽ không render lại được.`))) return;
            await guard(() => api("DELETE", `/api/templates/${t.id}`), "Đã xoá template");
            draw(true);
          } }, "🗑 Xoá template") : null,
        ));
    }));
  }
  const segBox = el("div", { class: "seg" });
  const drawSeg = () => clear(segBox, ["9:16", "16:9"].map((a) => el("button", { class: aspect === a ? "active" : "", onclick: () => { aspect = a; drawSeg(); draw(); } }, a)));
  drawSeg();
  await draw();
  clear(root,
    el("div", { class: "page-head" },
      el("div", {}, el("h1", {}, "Templates"), el("p", {}, "Template HyperFrames trong templates/. Bạn chỉ điền chữ — thiết kế & chuyển động do template lo.")),
      el("div", { class: "row" },
        el("button", { class: "btn", onclick: async () => {
          const missing = (await store.templates()).filter((t) => !t.previews?.[aspect]);
          if (!missing.length) return toast("Tất cả template đã có bản xem trước", "ok");
          for (const t of missing) await api("POST", `/api/templates/${t.id}/preview`, { aspect });
          toast(`Đã xếp hàng ${missing.length} bản xem trước (~20s mỗi cái)`, "ok");
          draw();
        } }, "▶ Xem trước tất cả"),
        segBox)),
    sampleCard,
    grid);
  return onJob((job, prev) => {
    if (job?.kind === "preview-template" && (!prev || prev.status !== job.status)) draw(!isLive(job));
  });
}

// ── SFX ────────────────────────────────────────────────────────────────────
async function sfxView(root) {
  const listBox = el("div", { class: "stack" });
  const maxInput = el("input", { type: "number", min: 1, max: 20, value: 5, style: { width: "80px" } });
  const secInput = el("input", { type: "number", min: 0.5, max: 15, step: 0.5, value: 3, style: { width: "80px" } });

  async function draw(fresh = false) {
    const lib = await store.sfx(fresh);
    const total = lib.reduce((n, c) => n + c.files.length, 0);
    clear(listBox,
      total === 0 ? el("div", { class: "empty" }, el("div", { class: "big" }, "🔇"), el("p", {}, "Thư viện SFX trống. Bấm \"Tải thư viện\" rồi \"Lọc\" ở trên. Không có SFX video vẫn render bình thường, chỉ không có tiếng hiệu ứng.")) : null,
      lib.map((c) => el("div", { class: "card tight sfx-cat" },
        el("div", { class: "row between" }, el("h3", {}, c.category), el("span", { class: "chip" }, `${c.files.length} file`)),
        el("div", { class: "sfx-files" }, c.files.map((f) => el("button", { title: f.path, onclick: (e) => playUrl(`/sfx-files/${f.path}`, e.currentTarget) }, "▶ ", f.name))))));
  }
  await draw();
  clear(root,
    el("div", { class: "page-head" }, el("div", {}, el("h1", {}, "Âm thanh (SFX)"), el("p", {}, "Hiệu ứng âm thanh được trộn lên giọng đọc ở đầu mỗi scene."))),
    el("div", { class: "grid-2", style: { marginBottom: "16px" } },
      el("div", { class: "card stack" },
        el("h3", {}, "1. Tải thư viện"),
        el("p", { class: "small muted", style: { margin: 0 } }, "Tìm & tải SFX từ myinstants.com theo ~50 từ khoá (whoosh, ding, alert, tada…) vào thư mục SFX/."),
        el("div", { class: "row" }, el("span", { class: "small muted" }, "Số file / từ khoá"), maxInput,
          el("button", { class: "btn", onclick: () => guard(() => api("POST", "/api/sfx/download", { max: Number(maxInput.value) }), "Đang tải SFX…") }, "⬇ Tải thư viện"))),
      el("div", { class: "card stack" },
        el("h3", {}, "2. Lọc vào assets/sfx"),
        el("p", { class: "small muted", style: { margin: 0 } }, "Chỉ giữ file ngắn (hiệu ứng, không phải nhạc) và xếp theo nhóm để pipeline chọn tự động."),
        el("div", { class: "row" }, el("span", { class: "small muted" }, "Dài tối đa (giây)"), secInput,
          el("button", { class: "btn", onclick: () => guard(() => api("POST", "/api/sfx/filter", { maxSec: Number(secInput.value) }), "Đang lọc SFX…") }, "⚙ Lọc")))),
    el("div", { class: "callout small", style: { marginBottom: "16px" } },
      el("b", {}, "Pipeline chọn SFX cho mỗi scene theo 3 tầng: "),
      "① chỉ định trong scene (hoặc Tắt) → ② từ khoá trong lời đọc (cảnh báo→alert, kỷ lục→success, ra mắt→reveal…) → ③ mặc định theo loại scene (hook→transition, body→alert, outro→outro). Cùng kịch bản luôn ra cùng SFX."),
    listBox);
  return onJob((job, prev) => {
    if (job && ["sfx-download", "sfx-filter"].includes(job.kind) && prev && isLive(prev) && !isLive(job)) draw(true);
  });
}

// ── Jobs ───────────────────────────────────────────────────────────────────
async function jobsView(root) {
  const box = el("div", { class: "stack" });
  const draw = () => {
    const list = [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    clear(box, list.length === 0 ? el("div", { class: "empty" }, "Chưa có tiến trình nào trong phiên này.") : list.map((j) =>
      el("div", { class: "card tight row" },
        statusChip(j.status),
        el("div", { class: "grow stack", style: { gap: "4px" } },
          el("b", {}, j.title),
          el("div", { class: "small faint" }, fmtDate(j.createdAt), j.progress ? ` · bước ${j.progress.step}/${j.progress.total}: ${j.progress.label}` : "", j.error ? ` · ${j.error}` : ""),
          isLive(j) ? progressBar(j) : null),
        j.slug ? el("a", { class: "btn sm", href: `#/p/${j.slug}` }, "Dự án") : null,
        el("button", { class: "btn sm", onclick: () => jobLogModal(j.id) }, "Log"),
        isLive(j) ? el("button", { class: "btn sm danger", onclick: () => guard(() => api("POST", `/api/jobs/${j.id}/cancel`)) }, "Huỷ") : null)));
  };
  draw();
  clear(root, el("div", { class: "page-head" }, el("div", {}, el("h1", {}, "Tiến trình"), el("p", {}, status?.parallel
      ? `Render tối đa ${status.parallel.jobs} video cùng lúc (máy ${status.parallel.cores} luồng CPU / ${status.parallel.memGb} GB RAM) — đổi trong Cài đặt → Hiệu năng.`
      : "Số job chạy cùng lúc tự tính theo cấu hình máy."))), box);
  return onJob(draw);
}

// ── Settings ───────────────────────────────────────────────────────────────
async function settingsView(root) {
  const [s, st] = await Promise.all([api("GET", "/api/settings"), api("GET", "/api/status")]);
  const voices = await store.voices().catch(() => []);
  const form = { ...s };
  const field = (label, node, hint) => el("label", { class: "field" }, el("span", {}, label, hint ? el("em", {}, hint) : null), node);
  const bind = (key, props = {}) => el("input", { type: "text", value: form[key] ?? "", oninput: (e) => (form[key] = e.target.value), ...props });

  // Voice
  const voiceSel = el("select", { onchange: (e) => (form.EDGE_VOICE = e.target.value) },
    el("optgroup", { label: "Tiếng Việt" }, voices.filter((v) => v.locale === "vi-VN").map((v) => el("option", { value: v.id }, `${v.id} (${v.gender === "Female" ? "nữ" : "nam"})`))),
    el("optgroup", { label: "Đa ngôn ngữ" }, voices.filter((v) => v.locale !== "vi-VN").map((v) => el("option", { value: v.id }, `${v.id} (${v.gender === "Female" ? "nữ" : "nam"})`))));
  if (!voices.some((v) => v.id === form.EDGE_VOICE)) voiceSel.prepend(el("option", { value: form.EDGE_VOICE }, form.EDGE_VOICE));
  voiceSel.value = form.EDGE_VOICE;
  const rateNum = parseInt(form.EDGE_RATE, 10) || 0;
  const rateLabel = el("b", {}, `${rateNum >= 0 ? "+" : ""}${rateNum}%`);
  const rate = el("input", { type: "range", min: -30, max: 50, step: 1, value: rateNum, oninput: (e) => {
    const v = Number(e.target.value);
    form.EDGE_RATE = `${v >= 0 ? "+" : ""}${v}%`;
    rateLabel.textContent = form.EDGE_RATE;
  } });
  const sample = el("input", { type: "text", value: form.SCRIPT_LANGUAGE === "vi" ? "Xin chào, đây là bản tin công nghệ mới nhất hôm nay." : "Hello, here is today's latest technology news." });
  const tryBtn = el("button", { class: "btn", onclick: async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    try {
      const genmax = useGenmax() ? { provider: form.GENMAX_PROVIDER, voiceId: form.GENMAX_VOICE, model: form.GENMAX_MODEL, language: form.GENMAX_LANGUAGE } : null;
      const blob = await api("POST", "/api/tts/preview", { text: sample.value, voice: form.EDGE_VOICE, rate: form.EDGE_RATE, genmax });
      new Audio(URL.createObjectURL(blob)).play();
    } catch (err) { toast(err.message, "bad"); } finally { b.disabled = false; }
  } }, "🔊 Nghe thử");

  // Genmax: entering the key is the only setup a new machine needs.
  let keySaved = !!s.GENMAX_API_KEY_SET;
  const useGenmax = () => keySaved && form.TTS_ENGINE !== "edge";
  const genmaxBox = el("div", { class: "stack" });
  const edgeBox = el("div");
  const genmaxKey = el("input", { type: "password", placeholder: keySaved ? "•••••• (đã lưu — nhập để thay)" : "sk_…", oninput: (e) => (form.GENMAX_API_KEY = e.target.value) });
  const saveKeyBtn = el("button", { class: "btn", onclick: async () => {
    if (!form.GENMAX_API_KEY?.trim()) return toast("Chưa nhập key", "warn");
    await guard(() => api("PUT", "/api/settings", { GENMAX_API_KEY: form.GENMAX_API_KEY }), "Đã lưu key Genmax");
    delete form.GENMAX_API_KEY;
    genmaxKey.value = "";
    genmaxKey.placeholder = "•••••• (đã lưu — nhập để thay)";
    keySaved = true;
    drawEngine();
  } }, "Lưu key & tải giọng");

  async function drawGenmax() {
    const provider = form.GENMAX_PROVIDER;
    const keyRow = field("GENMAX_API_KEY", el("div", { class: "row" }, el("div", { class: "grow" }, genmaxKey), saveKeyBtn), keySaved ? "đã lưu" : "chưa có");
    const hint = el("p", { class: "small muted", style: { margin: 0 } }, "Lấy key tại ", el("a", { href: "https://genmax.io/docs", target: "_blank" }, "genmax.io/docs"), ". Key chỉ lưu trên máy này, trong .env.local.");
    if (!keySaved) return clear(genmaxBox, keyRow, hint, el("div", { class: "callout warn small" }, "Chưa có key nên đang đọc bằng Edge TTS. Nhập key để dùng Genmax."));
    clear(genmaxBox, keyRow, hint, el("div", { class: "muted small" }, "Đang tải danh sách giọng…"));
    let catalog;
    try {
      catalog = await api("GET", `/api/genmax/catalog?provider=${provider}`);
    } catch (err) {
      return clear(genmaxBox, keyRow, hint, el("div", { class: "callout warn small" }, `Không tải được giọng: ${err.message}`));
    }
    if (form.GENMAX_PROVIDER !== provider) return; // switched again while loading
    const { voices: gVoices, models } = catalog;

    const langInput = bind("GENMAX_LANGUAGE");
    const pick = (v) => { form.GENMAX_VOICE = v.id; form.GENMAX_LANGUAGE = v.language; langInput.value = v.language; };
    const search = el("input", { type: "text", placeholder: `Tìm trong ${gVoices.length} giọng…`, oninput: () => fillVoices() });
    const voicePick = el("select", { onchange: (e) => pick(gVoices.find((v) => v.id === e.target.value)) });
    const isEnglish = (l) => l === "English" || l === "en";
    function fillVoices() {
      const q = search.value.trim().toLowerCase();
      const hits = gVoices.filter((v) => !q || `${v.name} ${v.language}`.toLowerCase().includes(q));
      if (hits.length && !hits.some((v) => v.id === form.GENMAX_VOICE)) pick(hits[0]);
      const langs = [...new Set(hits.map((v) => v.language))].sort((a, b) => Number(isEnglish(b)) - Number(isEnglish(a)) || a.localeCompare(b));
      clear(voicePick, langs.map((l) => el("optgroup", { label: l }, hits.filter((v) => v.language === l).map((v) => el("option", { value: v.id }, `${v.name}${v.gender ? ` (${v.gender})` : ""}`)))));
      voicePick.value = form.GENMAX_VOICE;
    }
    if (!gVoices.some((v) => v.id === form.GENMAX_VOICE)) pick(gVoices.find((v) => isEnglish(v.language)) ?? gVoices[0]);
    fillVoices();

    if (!models.some((m) => m.id === form.GENMAX_MODEL)) form.GENMAX_MODEL = catalog.defaultModel;
    const modelPick = el("select", { onchange: (e) => (form.GENMAX_MODEL = e.target.value) }, models.map((m) => el("option", { value: m.id }, m.name)));
    modelPick.value = form.GENMAX_MODEL;

    clear(genmaxBox, keyRow, hint,
      el("div", { class: "seg" }, [["minimax", "MiniMax"], ["capcut", "CapCut"], ["elevenlabs", "ElevenLabs"]].map(([v, l]) =>
        el("button", { class: provider === v ? "active" : "", onclick: () => { form.GENMAX_PROVIDER = v; drawGenmax(); } }, l))),
      el("div", { class: "grid-2" },
        field("Tìm giọng", search),
        field("Giọng", voicePick, `${gVoices.length} giọng`),
        field("Model", modelPick),
        field("Ngôn ngữ đọc", langInput, "tự điền theo giọng")));
  }

  function drawEngine() {
    clear(engineBox,
      el("div", { class: "seg" }, [["genmax", "Genmax"], ["edge", "Edge TTS (miễn phí)"]].map(([v, l]) =>
        el("button", { class: (form.TTS_ENGINE === "edge") === (v === "edge") ? "active" : "", onclick: () => { form.TTS_ENGINE = v; drawEngine(); } }, l))),
      form.TTS_ENGINE === "edge" ? edgeBox : genmaxBox);
    if (form.TTS_ENGINE !== "edge") drawGenmax();
  }
  const engineBox = el("div", { class: "stack" });
  clear(edgeBox, field("Giọng", voiceSel));
  drawEngine();

  // LLM
  let provider = form.LLM_PROVIDER === "claude" ? "claude" : "gemini";
  const provBox = el("div");
  const geminiKey = el("input", { type: "password", placeholder: s.GEMINI_API_KEY_SET ? "•••••• (đã lưu — nhập để thay)" : "AIza…", oninput: (e) => (form.GEMINI_API_KEY = e.target.value) });
  const pixabayKey = el("input", { type: "password", placeholder: s.PIXABAY_API_KEY_SET ? "•••••• (đã lưu — nhập để thay)" : "key Pixabay", oninput: (e) => (form.PIXABAY_API_KEY = e.target.value) });
  const pexelsKey = el("input", { type: "password", placeholder: s.PEXELS_API_KEY_SET ? "•••••• (đã lưu — nhập để thay)" : "chỉ khi đã có key cũ", oninput: (e) => (form.PEXELS_API_KEY = e.target.value) });
  const claudeKey = el("input", { type: "password", placeholder: s.ANTHROPIC_API_KEY_SET ? "•••••• (đã lưu — nhập để thay)" : "sk-ant-…", oninput: (e) => (form.ANTHROPIC_API_KEY = e.target.value) });
  const claudeModel = el("select", { onchange: (e) => (form.CLAUDE_MODEL = e.target.value) },
    [["claude-opus-5-5", "Claude Opus 5.5 (mặc định, chất lượng cao)"], ["claude-sonnet-5-5", "Claude Sonnet 5.5 (nhanh, rẻ hơn)"], ["claude-haiku-4-5", "Claude Haiku 4.5 (rẻ nhất)"]]
      .map(([v, l]) => el("option", { value: v }, l)));
  if (![...claudeModel.options].some((o) => o.value === form.CLAUDE_MODEL)) claudeModel.prepend(el("option", { value: form.CLAUDE_MODEL }, form.CLAUDE_MODEL));
  claudeModel.value = form.CLAUDE_MODEL;
  const gemList = s.GEMINI_API_KEY_SET ? await api("GET", "/api/gemini/models").catch(() => []) : [];
  const geminiModel = el("select", { onchange: (e) => (form.GEMINI_MODEL = e.target.value) },
    el("option", { value: "auto" }, "Tự chọn model tốt nhất"),
    [...new Set([form.GEMINI_MODEL, ...gemList])].filter((m) => m !== "auto").map((m) => el("option", { value: m }, m)));
  geminiModel.value = form.GEMINI_MODEL;
  const drawProv = () => clear(provBox,
    el("div", { class: "seg", style: { marginBottom: "12px" } }, [["gemini", "Google Gemini"], ["claude", "Anthropic Claude"]].map(([v, l]) =>
      el("button", { class: provider === v ? "active" : "", onclick: () => { provider = v; form.LLM_PROVIDER = v; drawProv(); } }, l))),
    provider === "gemini"
      ? el("div", { class: "grid-2" },
        field("GEMINI_API_KEY", geminiKey, s.GEMINI_API_KEY_SET ? "đã lưu" : "chưa có"),
        field("Model", geminiModel, "tự chọn theo key"),
        el("p", { class: "small muted", style: { margin: 0, gridColumn: "1/-1" } }, "Lấy key miễn phí tại ", el("a", { href: "https://aistudio.google.com/apikey", target: "_blank" }, "aistudio.google.com/apikey"), "."))
      : el("div", { class: "grid-2" },
        field("ANTHROPIC_API_KEY", claudeKey, s.ANTHROPIC_API_KEY_SET ? "đã lưu" : "chưa có"),
        field("Model", claudeModel),
        el("p", { class: "small muted", style: { margin: 0, gridColumn: "1/-1" } }, "Lấy key tại ", el("a", { href: "https://platform.claude.com/", target: "_blank" }, "platform.claude.com"), ". Tính phí theo token.")));
  drawProv();

  // Brand kit — the fixed identity every video of the channel shares.
  function brandCard() {
    const color = (key) => {
      const text = el("input", { type: "text", value: form[key], style: { width: "110px" } });
      const pick = el("input", { type: "color", value: /^#[0-9a-f]{6}$/i.test(form[key]) ? form[key] : "#0e9f6e" });
      pick.oninput = () => { form[key] = pick.value; text.value = pick.value; };
      text.oninput = () => { form[key] = text.value; if (/^#[0-9a-f]{6}$/i.test(text.value)) pick.value = text.value; };
      return el("div", { class: "color-field" }, pick, text);
    };
    const logoImg = el("img", { src: `/api/brand/logo?t=${Date.now()}`, style: { width: "96px", height: "96px", borderRadius: "50%", objectFit: "cover", background: "#fff", border: "3px solid var(--line-2)" } });
    const logoIn = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/svg+xml", class: "hidden", onchange: async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const dataUrl = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(file); });
      const r = await guard(() => api("POST", "/api/brand/logo", { dataUrl }), "Đã cập nhật logo kênh");
      form.BRAND_LOGO = r.BRAND_LOGO;
      logoImg.src = `/api/brand/logo?t=${Date.now()}`;
    } });
    const previewBox = el("div", { class: "clip-box", style: { width: "240px" } }, "Bấm \"Xem trước khung\" để render khung kênh với ảnh mẫu");
    const previewBtn = el("button", { class: "btn", onclick: async () => {
      await saveAll();
      previewBtn.disabled = true;
      clear(previewBox, el("div", { class: "stack", style: { alignItems: "center" } }, el("span", { class: "spinner" }), "Đang render (~20s)…"));
      try {
        const { jobId } = await api("POST", "/api/brand/preview");
        const job = await waitJob(jobId);
        if (job.status !== "done") throw new Error(job.error ?? "Render lỗi");
        clear(previewBox, el("video", { src: bust(job.result.video), autoplay: true, loop: true, muted: true, playsinline: true }));
      } catch (err) {
        clear(previewBox, err.message);
        toast(err.message, "bad");
      } finally { previewBtn.disabled = false; }
    } }, "▶ Xem trước khung");
    return el("div", { class: "card stack" },
      el("h2", {}, "🎨 Bộ nhận diện kênh"),
      el("p", { class: "small muted", style: { margin: 0 } }, "Phần cố định trên MỌI video của kênh: logo, tên, màu khung, màu chữ nổi bật trong tiêu đề. AI không bao giờ thay đổi các phần này."),
      el("div", { class: "row", style: { alignItems: "flex-start", gap: "24px" } },
        el("div", { class: "stack grow", style: { minWidth: "280px" } },
          el("div", { class: "row" }, logoImg,
            el("div", { class: "stack", style: { gap: "6px" } },
              el("button", { class: "btn", onclick: () => logoIn.click() }, "⬆ Tải logo lên"), logoIn,
              el("span", { class: "small faint" }, "PNG/JPG vuông, nền đặc — hiển thị trong vòng tròn"))),
          el("div", { class: "grid-2" },
            field("Tên kênh", bind("CHANNEL_NAME")),
            field("Handle", bind("CHANNEL_HANDLE", { placeholder: "@tenkenh" })),
            field("Khẩu hiệu", bind("CHANNEL_TAGLINE")),
            field("Website", bind("CHANNEL_URL")),
            field("Màu khung kênh", color("BRAND_COLOR")),
            field("Màu chữ nổi bật", color("BRAND_ACCENT"))),
          el("div", { class: "row" }, previewBtn,
            el("span", { class: "small faint" }, "Đổi bộ nhận diện → lần render sau các video tự cập nhật khung."))),
        previewBox));
  }

  // Parallelism — "auto" sizes each level from CPU cores + RAM.
  function perfCard() {
    const p = st.parallel;
    const level = (key, max, autoVal) => {
      const sel = el("select", { onchange: (e) => (form[key] = e.target.value) },
        el("option", { value: "auto" }, `Tự động (${autoVal})`),
        Array.from({ length: max }, (_, i) => el("option", { value: String(i + 1) }, String(i + 1))));
      sel.value = /^d+$/.test(form[key]) && Number(form[key]) <= max ? form[key] : "auto";
      return sel;
    };
    const auto = (key, val) => (/^d+$/.test(form[key]) ? "theo máy" : val);
    return el("div", { class: "card stack" },
      el("h2", {}, "⚡ Hiệu năng (chạy song song)"),
      el("p", { class: "small muted", style: { margin: 0 } },
        `Máy này: ${p.cores} luồng CPU, ${p.memGb} GB RAM → chạy được khoảng ${p.budget} Chrome render cùng lúc. `,
        `Đang dùng: ${p.jobs} video × ${p.scenes} scene × ${p.workers} worker.`),
      el("div", { class: "grid-2" },
        field("Số video render cùng lúc", level("MAX_PARALLEL_JOBS", 8, auto("MAX_PARALLEL_JOBS", p.jobs)), "hàng đợi"),
        field("Số scene render cùng lúc / video", level("RENDER_CONCURRENCY", 8, auto("RENDER_CONCURRENCY", p.scenes))),
        field("Worker Chrome / scene", level("RENDER_WORKERS", 8, auto("RENDER_WORKERS", p.workers)))),
      el("p", { class: "small muted", style: { margin: 0 } },
        "Để Tự động là ổn. Máy giật/đầy RAM khi render → giảm xuống; muốn 1 video xong nhanh nhất → đặt số video cùng lúc = 1. Áp dụng cho job bắt đầu sau khi lưu."));
  }

  async function saveAll() {
    const patch = { ...form };
    for (const k of Object.keys(patch)) if (k.endsWith("_SET")) delete patch[k];
    await guard(() => api("PUT", "/api/settings", patch), "Đã lưu cài đặt vào .env.local");
    geminiKey.value = "";
    claudeKey.value = "";
    pexelsKey.value = "";
    pixabayKey.value = "";
    delete form.PEXELS_API_KEY;
    delete form.PIXABAY_API_KEY;
    if (form.GENMAX_API_KEY) {
      delete form.GENMAX_API_KEY;
      genmaxKey.value = "";
      keySaved = true;
      drawEngine();
    }
    refreshStatus();
  }

  const sys = (ok, label, detail, fix) => el("div", { class: "row", style: { alignItems: "flex-start" } },
    el("span", { class: `chip ${ok ? "ok" : "bad"}` }, ok ? "✓" : "✗"),
    el("div", { class: "grow" }, el("b", {}, label), el("div", { class: "small muted" }, detail), !ok && fix ? el("div", { class: "small", style: { color: "var(--warn)" } }, fix) : null));

  clear(root,
    el("div", { class: "page-head" }, el("div", {}, el("h1", {}, "Cài đặt"), el("p", {}, "Lưu vào .env.local (không commit lên git).")),
      el("button", { class: "btn primary", onclick: saveAll }, "💾 Lưu cài đặt")),
    el("div", { class: "stack" },
      el("div", { class: "card stack" },
        el("h2", {}, "🎙 Giọng đọc"),
        st.tts.mode === "external" ? el("div", { class: "callout warn small" },
          "Đang dùng server giọng đọc chạy riêng (npm run tts:server) nên đổi giọng ở đây sẽ KHÔNG áp dụng khi render. Tắt terminal tts:server rồi khởi động lại web — web tự chạy server giọng đọc.") : null,
        engineBox,
        el("div", { class: "grid-2" },
          field("Tốc độ", el("div", { class: "row" }, rate, rateLabel)),
          field("Ngôn ngữ kịch bản AI", (() => {
            const sel = el("select", { onchange: (e) => (form.SCRIPT_LANGUAGE = e.target.value) },
              el("option", { value: "en" }, "Tiếng Anh"), el("option", { value: "vi" }, "Tiếng Việt"));
            sel.value = form.SCRIPT_LANGUAGE;
            return sel;
          })(), "nên khớp ngôn ngữ của giọng")),
        el("div", { class: "row" }, el("div", { class: "grow" }, sample), tryBtn),
        el("p", { class: "small muted", style: { margin: 0 } }, "Đổi giọng chỉ áp dụng cho các scene chưa tạo giọng. Với dự án cũ: mở dự án → Cache → \"Tạo lại toàn bộ giọng\"."),
        field("Hiệu ứng âm thanh (SFX)", (() => {
          const sel = el("select", { onchange: (e) => (form.SFX_MODE = e.target.value) },
            el("option", { value: "outro" }, "Chỉ đoạn kết — tiếng chuông đăng ký kênh (khuyên dùng)"),
            el("option", { value: "off" }, "Tắt hoàn toàn"),
            el("option", { value: "auto" }, "Tự động mọi scene theo từ khoá (thư viện SFX)"));
          sel.value = form.SFX_MODE || "outro";
          return el("div", { class: "row" }, el("div", { class: "grow" }, sel),
            el("button", { class: "btn", onclick: (e) => playUrl("/sfx-files/__brand__/subscribe.mp3", e.currentTarget) }, "🔔 Nghe chuông"));
        })())),
      el("div", { class: "card stack" }, el("h2", {}, "✨ AI viết kịch bản"), provBox),
      el("div", { class: "card stack" },
        el("h2", {}, "🎞 Video dài (YouTube)"),
        el("div", { class: "grid-2" },
          field("Model vẽ ảnh AI", bind("GEMINI_IMAGE_MODEL"), "mặc định gemini-nano-banana-2.1"),
          field("Model tạo clip AI", bind("GEMINI_VIDEO_MODEL"), "mặc định gemini-omni-1.2-flash"),
          field("PIXABAY_API_KEY", pixabayKey, s.PIXABAY_API_KEY_SET ? "đã lưu" : "tuỳ chọn"),
          field("PEXELS_API_KEY", pexelsKey, s.PEXELS_API_KEY_SET ? "đã lưu" : "tuỳ chọn"),
          field("Nhạc nền", el("div", { class: "small", style: { paddingTop: "8px" } }, `${st.music} bài trong assets/music/`))),
        el("p", { class: "small muted", style: { margin: 0 } },
          "Video minh hoạ miễn phí, được dùng thương mại. Lấy key Pixabay: đăng ký tài khoản rồi mở ", el("a", { href: "https://pixabay.com/api/docs/", target: "_blank" }, "pixabay.com/api/docs"), " — key hiện ngay trong trang. Pexels đã ngừng cấp key mới (2026); ai còn key cũ thì nhập để có thêm nguồn. ",
          "Nhạc nền: chép file mp3 không bản quyền (vd YouTube Audio Library) vào assets/music/ — hoặc assets/music/<id-kênh>/ để mỗi kênh một bộ nhạc.")),
      brandCard(),
      perfCard(),
      el("div", { class: "card stack" },
        el("h2", {}, "🧰 Hệ thống"),
        sys(st.ffmpeg && st.ffprobe, "FFmpeg + ffprobe", st.ffmpegDir ?? "không tìm thấy", "Cài FFmpeg rồi khởi động lại web (npm run web)."),
        sys(!!st.chrome, "Chrome / Edge", st.chrome ?? "không tìm thấy", "HyperFrames cần Chrome để render template."),
        sys(st.tts.ok, "Server giọng đọc", `${st.tts.endpoint} · ${st.tts.mode === "embedded" ? "chạy kèm web" : st.tts.mode === "external" ? "server riêng (npm run tts:server)" : "không chạy"}`, "Khởi động lại web để bật lại."),
        sys(st.stock?.length > 0, "Video minh hoạ", st.stock?.length ? st.stock.join(" + ") : "chưa có key", "Nhập PIXABAY_API_KEY ở trên — không có thì video dài chỉ dùng ảnh."),
        sys(st.sfx > 0, "Thư viện SFX", `${st.sfx} file trong assets/sfx`, "Vào trang Âm thanh để tải."),
        sys(st.llm.configured, "API key AI", `${st.llm.provider} · ${st.llm.model}`, "Nhập key ở trên (chỉ cần khi tạo kịch bản bằng AI)."),
        el("div", { class: "small faint" }, `Node ${st.node}`)),
    ));
}

// ── Boot ───────────────────────────────────────────────────────────────────
await connectEvents();
drawDock();
refreshStatus();
setInterval(refreshStatus, 15000);
route();

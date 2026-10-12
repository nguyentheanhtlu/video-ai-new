import {
  api, bust, clear, confirmBox, connectEvents, el, fmtDate, fmtSec, guard, jobLogModal, jobs, liveLog,
  onJob, playUrl, progressBar, statusChip, toast, waitJob,
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
  let mode = "url";
  let disposeLog = null;

  const opt = {
    length: "standard",
    aspect: "9:16",
    channel: settings.CHANNEL_NAME,
    channelUrl: settings.CHANNEL_URL,
    extraInstructions: "",
    autoRender: true,
  };

  const seg = (options, get, set) => {
    const box = el("div", { class: "seg" });
    const draw = () => clear(box, options.map(([v, l]) => el("button", { class: get() === v ? "active" : "", onclick: () => { set(v); draw(); } }, l)));
    draw();
    return box;
  };
  const field = (label, node, hint) => el("label", { class: "field" }, el("span", {}, label, hint ? el("em", {}, hint) : null), node);

  const urlInput = el("input", { type: "url", placeholder: "https://vnexpress.net/..." });
  const textArea = el("textarea", { rows: 12, placeholder: "Dòng đầu tiên là tiêu đề.\nCác dòng sau là nội dung bài…" });
  const fileTxt = el("input", { type: "file", accept: ".txt,text/plain", onchange: async (e) => { const f = e.target.files[0]; if (f) textArea.value = await f.text(); } });
  const blankTitle = el("input", { type: "text", placeholder: "Tên video", value: "" });
  const fileJson = el("input", { type: "file", accept: ".json,application/json" });

  const optionsCard = () => el("div", { class: "card stack" },
    el("h3", {}, "Tuỳ chọn"),
    mode === "url" || mode === "text" ? el("div", { class: "row between" }, el("span", { class: "muted small" }, "Độ dài"),
      seg([["short", "Ngắn · 4–6 scene · ~40s"], ["standard", "Chuẩn · 8–12 scene · ~100s"]], () => opt.length, (v) => (opt.length = v))) : null,
    mode !== "import" ? el("div", { class: "row between" }, el("span", { class: "muted small" }, "Khung hình"),
      seg([["9:16", "9:16 dọc"], ["16:9", "16:9 ngang"]], () => opt.aspect, (v) => (opt.aspect = v))) : null,
    mode === "url" || mode === "text" ? [
      el("div", { class: "grid-2" },
        field("Tên kênh", el("input", { type: "text", value: opt.channel, oninput: (e) => (opt.channel = e.target.value) })),
        field("URL kênh (outro)", el("input", { type: "text", value: opt.channelUrl, oninput: (e) => (opt.channelUrl = e.target.value) }))),
      field("Yêu cầu thêm cho AI", el("textarea", { rows: 2, placeholder: "vd: giọng văn hài hước, nhấn mạnh giá bán, thêm 1 scene so sánh…", oninput: (e) => (opt.extraInstructions = e.target.value) }), "tuỳ chọn"),
      el("label", { class: "check" }, el("input", { type: "checkbox", checked: opt.autoRender, onchange: (e) => (opt.autoRender = e.target.checked) }), "Render video ngay sau khi AI viết xong kịch bản"),
    ] : null,
  );

  const formBox = el("div");
  const progressBox = el("div");

  function drawForm() {
    const needsLlm = mode === "url" || mode === "text";
    const tabs = el("div", { class: "tabs" }, [["url", "🔗 Từ link bài báo"], ["text", "📝 Dán văn bản / .txt"], ["blank", "📄 Kịch bản trống"], ["import", "📦 Import script.json"]].map(([k, l]) =>
      el("button", { class: mode === k ? "active" : "", onclick: () => { mode = k; drawForm(); } }, l)));
    const main = {
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
          el("div", {}, el("button", { class: "btn primary", onclick: submit }, needsLlm ? "✨ Viết kịch bản bằng AI" : "Tạo dự án"))),
        el("div", { class: "side-sticky" }, optionsCard())));
  }

  async function submit(e) {
    const btn = e.currentTarget;
    let body;
    if (mode === "url") {
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
    el("div", { class: "page-head" }, el("div", {}, el("h1", {}, "Tạo video mới"), el("p", {}, "Đưa vào một bài báo, nhận về video 9:16 — AI viết chữ, template lo hình."))),
    formBox, progressBox);
  return () => disposeLog?.();
}

// ── Templates ──────────────────────────────────────────────────────────────
async function templatesView(root) {
  let aspect = "9:16";
  const grid = el("div", { class: "tpl-grid" });
  async function draw(fresh = false) {
    const list = await store.templates(fresh);
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
          el("details", {}, el("summary", {}, `${t.slots.length} ô nhập liệu`),
            el("table", { class: "slot-table" }, t.slots.map((s) => el("tr", {}, el("td", {}, s.name), el("td", { class: "muted" }, s.type, s.limit ? ` · ${s.limit}` : ""), el("td", { class: "faint" }, s.notes))))),
          el("details", {}, el("summary", {}, "Dữ liệu mẫu"), el("pre", { class: "log", style: { maxHeight: "200px" } }, JSON.stringify(t.defaults, null, 2))),
          preview ? el("button", { class: "btn ghost sm", style: { alignSelf: "flex-start" }, onclick: () => guard(() => api("POST", `/api/templates/${t.id}/preview`, { aspect }), "Đang render lại…").then(() => draw()) }, "↻ Render lại") : null,
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
  const sample = el("input", { type: "text", value: "Xin chào, đây là bản tin công nghệ mới nhất hôm nay." });
  const tryBtn = el("button", { class: "btn", onclick: async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    try {
      const blob = await api("POST", "/api/tts/preview", { text: sample.value, voice: form.EDGE_VOICE, rate: form.EDGE_RATE });
      new Audio(URL.createObjectURL(blob)).play();
    } catch (err) { toast(err.message, "bad"); } finally { b.disabled = false; }
  } }, "🔊 Nghe thử");

  // LLM
  let provider = form.LLM_PROVIDER === "claude" ? "claude" : "gemini";
  const provBox = el("div");
  const geminiKey = el("input", { type: "password", placeholder: s.GEMINI_API_KEY_SET ? "•••••• (đã lưu — nhập để thay)" : "AIza…", oninput: (e) => (form.GEMINI_API_KEY = e.target.value) });
  const claudeKey = el("input", { type: "password", placeholder: s.ANTHROPIC_API_KEY_SET ? "•••••• (đã lưu — nhập để thay)" : "sk-ant-…", oninput: (e) => (form.ANTHROPIC_API_KEY = e.target.value) });
  const claudeModel = el("select", { onchange: (e) => (form.CLAUDE_MODEL = e.target.value) },
    [["claude-opus-5-5", "Claude Opus 5.5 (mặc định, chất lượng cao)"], ["claude-sonnet-5-5", "Claude Sonnet 5.5 (nhanh, rẻ hơn)"], ["claude-haiku-4-5", "Claude Haiku 4.5 (rẻ nhất)"]]
      .map(([v, l]) => el("option", { value: v }, l)));
  if (![...claudeModel.options].some((o) => o.value === form.CLAUDE_MODEL)) claudeModel.prepend(el("option", { value: form.CLAUDE_MODEL }, form.CLAUDE_MODEL));
  claudeModel.value = form.CLAUDE_MODEL;
  const drawProv = () => clear(provBox,
    el("div", { class: "seg", style: { marginBottom: "12px" } }, [["gemini", "Google Gemini"], ["claude", "Anthropic Claude"]].map(([v, l]) =>
      el("button", { class: provider === v ? "active" : "", onclick: () => { provider = v; form.LLM_PROVIDER = v; drawProv(); } }, l))),
    provider === "gemini"
      ? el("div", { class: "grid-2" },
        field("GEMINI_API_KEY", geminiKey, s.GEMINI_API_KEY_SET ? "đã lưu" : "chưa có"),
        field("Model", bind("GEMINI_MODEL"), "vd gemini-flash-latest"),
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
        el("h2", {}, "🎙 Giọng đọc (Edge TTS)"),
        st.tts.mode === "external" ? el("div", { class: "callout warn small" },
          "Đang dùng server giọng đọc chạy riêng (npm run tts:server) nên đổi giọng ở đây sẽ KHÔNG áp dụng khi render. Tắt terminal tts:server rồi khởi động lại web — web tự chạy server giọng đọc.") : null,
        el("div", { class: "grid-2" },
          field("Giọng", voiceSel),
          field("Tốc độ", el("div", { class: "row" }, rate, rateLabel))),
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
      brandCard(),
      perfCard(),
      el("div", { class: "card stack" },
        el("h2", {}, "🧰 Hệ thống"),
        sys(st.ffmpeg && st.ffprobe, "FFmpeg + ffprobe", st.ffmpegDir ?? "không tìm thấy", "Cài FFmpeg rồi khởi động lại web (npm run web)."),
        sys(!!st.chrome, "Chrome / Edge", st.chrome ?? "không tìm thấy", "HyperFrames cần Chrome để render template."),
        sys(st.tts.ok, "Server giọng đọc", `${st.tts.endpoint} · ${st.tts.mode === "embedded" ? "chạy kèm web" : st.tts.mode === "external" ? "server riêng (npm run tts:server)" : "không chạy"}`, "Khởi động lại web để bật lại."),
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

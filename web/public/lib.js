// Tiny DOM + API helpers shared by all views.

export function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "value") node.value = v;
    else if (k === "checked") node.checked = !!v;
    else if (k === "html") node.innerHTML = v;
    else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, v);
  }
  append(node, kids);
  return node;
}

function append(node, kids) {
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
}

export function clear(node, ...kids) {
  node.replaceChildren();
  append(node, kids);
  return node;
}

export async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get("content-type") ?? "";
  const data = type.includes("json") ? await res.json() : await res.blob();
  if (!res.ok) throw new Error(data?.error ?? `Lỗi ${res.status}`);
  return data;
}

export function toast(message, kind = "info", ms = 4500) {
  const t = el("div", { class: `toast ${kind}` }, message);
  document.getElementById("toasts").append(t);
  setTimeout(() => t.remove(), ms);
}

export async function guard(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg, "ok");
    return r;
  } catch (e) {
    toast(e.message, "bad", 8000);
    throw e;
  }
}

export function openModal(title, body, actions = []) {
  const modal = document.getElementById("modal");
  const close = () => {
    modal.classList.add("hidden");
    modal.replaceChildren();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => e.key === "Escape" && close();
  document.addEventListener("keydown", onKey);
  clear(
    modal,
    el(
      "div",
      { class: "modal-box", onclick: (e) => e.stopPropagation() },
      el("header", {}, el("h2", {}, title), el("div", { class: "row" }, actions, el("button", { class: "btn ghost icon", onclick: close, title: "Đóng" }, "✕"))),
      el("div", { class: "modal-body" }, body),
    ),
  );
  modal.onclick = close;
  modal.classList.remove("hidden");
  return close;
}

export function confirmBox(message, okLabel = "Đồng ý", danger = false) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      close();
      resolve(v);
    };
    const close = openModal("Xác nhận", el("div", { class: "stack" },
      el("p", { style: { margin: 0, whiteSpace: "pre-wrap" } }, message),
      el("div", { class: "row", style: { justifyContent: "flex-end" } },
        el("button", { class: "btn", onclick: () => finish(false) }, "Huỷ"),
        el("button", { class: `btn ${danger ? "danger" : "primary"}`, onclick: () => finish(true) }, okLabel),
      ),
    ));
    const obs = new MutationObserver(() => {
      if (document.getElementById("modal").classList.contains("hidden")) {
        obs.disconnect();
        if (!done) { done = true; resolve(false); }
      }
    });
    obs.observe(document.getElementById("modal"), { attributes: true });
  });
}

// ── Jobs (live via SSE) ────────────────────────────────────────────────────
export const jobs = new Map();
const jobListeners = new Set();
const logListeners = new Set();

export function onJob(fn) {
  jobListeners.add(fn);
  return () => jobListeners.delete(fn);
}
export function onLog(fn) {
  logListeners.add(fn);
  return () => logListeners.delete(fn);
}

export async function connectEvents() {
  for (const j of await api("GET", "/api/jobs")) jobs.set(j.id, j);
  jobListeners.forEach((fn) => fn(null));
  const es = new EventSource("/api/events");
  es.addEventListener("job", (e) => {
    const job = JSON.parse(e.data);
    const prev = jobs.get(job.id);
    jobs.set(job.id, job);
    jobListeners.forEach((fn) => fn(job, prev));
  });
  es.addEventListener("log", (e) => {
    const { id, line } = JSON.parse(e.data);
    logListeners.forEach((fn) => fn(id, line));
  });
  es.onerror = () => {
    // Browser auto-reconnects; resync job list when it does.
    es.onopen = async () => {
      for (const j of await api("GET", "/api/jobs")) jobs.set(j.id, j);
      jobListeners.forEach((fn) => fn(null));
    };
  };
}

/** Wait until a job finishes; resolves with the final job. */
export function waitJob(id) {
  return new Promise((resolve) => {
    const check = (job) => {
      const j = job?.id === id ? job : jobs.get(id);
      if (j && ["done", "failed", "cancelled"].includes(j.status)) {
        off();
        resolve(j);
      }
    };
    const off = onJob(check);
    check(null);
  });
}

const NOISE = /━|█|░|\[initSession|Render:trace|telemetry|anonymous usage|No personal info|npm warn/;

export function logLine(line) {
  let cls = "";
  if (/\[\d+\/\d+\]/.test(line)) cls = "step";
  else if (/ERROR|✗|Error:|failed|FAIL/i.test(line)) cls = "err";
  else if (/✓|Done|Rendered:|completed/.test(line)) cls = "ok";
  else if (NOISE.test(line)) cls = "noise";
  return el("div", { class: cls }, line);
}

export function isNoise(line) {
  return NOISE.test(line);
}

/** A live log viewer for one job. Returns { node, dispose }. */
export function liveLog(jobId, { hideNoise = true } = {}) {
  const box = el("div", { class: "log" });
  let showNoise = !hideNoise;
  let lines = [];
  const render = () => {
    clear(box, lines.filter((l) => showNoise || !isNoise(l)).map(logLine));
    box.scrollTop = box.scrollHeight;
  };
  api("GET", `/api/jobs/${jobId}`).then((j) => {
    lines = j.logs;
    render();
  }).catch(() => {});
  const off = onLog((id, line) => {
    if (id !== jobId) return;
    lines.push(line);
    if (!showNoise && isNoise(line)) return;
    const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
    box.append(logLine(line));
    if (stick) box.scrollTop = box.scrollHeight;
  });
  const toggle = el("label", { class: "check small muted" },
    el("input", { type: "checkbox", checked: showNoise, onchange: (e) => { showNoise = e.target.checked; render(); } }),
    "Hiện log chi tiết của renderer");
  return { node: el("div", { class: "stack" }, toggle, box), dispose: off };
}

export function jobLogModal(jobId) {
  const job = jobs.get(jobId);
  const log = liveLog(jobId);
  const cancelBtn = el("button", {
    class: "btn sm danger",
    onclick: () => guard(() => api("POST", `/api/jobs/${jobId}/cancel`), "Đã gửi lệnh huỷ"),
  }, "Huỷ job");
  const close = openModal(job?.title ?? "Tiến trình", log.node, job && ["queued", "running"].includes(job.status) ? [cancelBtn] : []);
  const obs = new MutationObserver(() => {
    if (document.getElementById("modal").classList.contains("hidden")) {
      log.dispose();
      obs.disconnect();
    }
  });
  obs.observe(document.getElementById("modal"), { attributes: true });
  return close;
}

export function progressBar(job) {
  const p = job?.progress;
  const pct = p ? Math.round((p.step / p.total) * 100) : 0;
  return el("div", { class: `progress ${!p && job?.status === "running" ? "indeterminate" : ""}` }, el("div", { style: { width: `${pct}%` } }));
}

export const STATUS_LABEL = {
  queued: ["Đang chờ", "info"],
  running: ["Đang chạy", "accent"],
  done: ["Xong", "ok"],
  failed: ["Lỗi", "bad"],
  cancelled: ["Đã huỷ", "warn"],
};

export function statusChip(status) {
  const [label, kind] = STATUS_LABEL[status] ?? [status, ""];
  return el("span", { class: `chip ${kind}` }, status === "running" ? el("span", { class: "spinner" }) : el("span", { class: "dot" }), label);
}

// ── Formatting ─────────────────────────────────────────────────────────────
export const fmtDate = (iso) =>
  iso ? new Date(iso).toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }) : "";
export const fmtSec = (s) => (s == null ? "" : s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : `${s.toFixed(1)}s`);
export const wordCount = (t) => (t ?? "").trim().split(/\s+/).filter(Boolean).length;
/** Vietnamese words are single syllables — Edge TTS at +8% reads ~3.8 per second. */
export const estSec = (t) => wordCount(t) / 3.8;
export const bust = (url) => `${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`;

export async function playTts(text, btn) {
  if (!text?.trim()) return toast("Chưa có nội dung để đọc", "warn");
  const label = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "Đang tạo…"; }
  try {
    const blob = await api("POST", "/api/tts/preview", { text });
    const audio = new Audio(URL.createObjectURL(blob));
    await audio.play();
  } catch (e) {
    toast(e.message, "bad");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

let currentAudio = null;
let currentUrl = null;
/** Play a sound file; clicking the same one again stops it. */
export function playUrl(url, btn) {
  const wasSame = currentUrl === url;
  if (currentAudio) {
    currentAudio.pause();
    document.querySelectorAll(".playing").forEach((b) => b.classList.remove("playing"));
  }
  currentAudio = null;
  currentUrl = null;
  if (wasSame) return;
  currentAudio = new Audio(url);
  currentUrl = url;
  btn?.classList.add("playing");
  currentAudio.onended = () => {
    btn?.classList.remove("playing");
    currentUrl = null;
  };
  currentAudio.play().catch((e) => toast(e.message, "bad"));
}

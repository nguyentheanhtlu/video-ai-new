import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getChannel } from "./channels.js";
import { HttpError, ROOT } from "./paths.js";
import { UploadError } from "./upload-error.js";

/**
 * Facebook Pages publishing through the official Graph API.
 *
 * One Meta app (FACEBOOK_APP_ID / FACEBOOK_APP_SECRET in .env.local) in
 * Development mode is enough for Pages the app's admins manage — no App Review.
 * Sign-in once per tool channel: the user token is swapped for a long-lived
 * one, and the Page token derived from it does not expire. Only the Page token
 * is kept, in credentials/facebook/<channelId>.json.
 *
 * Profiles and groups cannot be posted to through the API (removed by Meta).
 */

const V = "v23.0";
const GRAPH = `https://graph.facebook.com/${V}`;
const GRAPH_VIDEO = `https://graph-video.facebook.com/${V}`;
const RUPLOAD = `https://rupload.facebook.com/video-upload/${V}`;
const SCOPES = ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "business_management"];
const TOKEN_DIR = join(ROOT, "credentials", "facebook");
const CHUNK = 8 * 1024 * 1024;
/** Reels published through the API must be 9:16 and 3–90 s; longer vertical videos go up as normal videos. */
const REEL_MAX_SEC = 90;

export const fbBus = new EventEmitter();

const app = () => {
  const id = process.env.FACEBOOK_APP_ID?.trim();
  const secret = process.env.FACEBOOK_APP_SECRET?.trim();
  if (!id || !secret) throw new HttpError(400, "Thiếu FACEBOOK_APP_ID / FACEBOOK_APP_SECRET trong .env.local");
  return { id, secret };
};
export const fbConfigured = () => !!(process.env.FACEBOOK_APP_ID?.trim() && process.env.FACEBOOK_APP_SECRET?.trim());

// ── Connections ────────────────────────────────────────────────────────────
export interface FbConnection {
  channelId: string;
  page: { id: string; name: string; picture?: string };
  pageToken: string;
  connectedAt: string;
  broken?: string;
}

const tokenFile = (channelId: string) => {
  if (!/^[a-z0-9-]+$/.test(channelId)) throw new HttpError(400, "Kênh không hợp lệ");
  return join(TOKEN_DIR, `${channelId}.json`);
};

export function getFbConnection(channelId: string): FbConnection | null {
  try {
    return JSON.parse(readFileSync(tokenFile(channelId), "utf8"));
  } catch {
    return null;
  }
}

export function publicFbConnection(channelId: string) {
  const c = getFbConnection(channelId);
  return c ? { page: c.page, connectedAt: c.connectedAt, broken: c.broken ?? null } : null;
}

async function saveFb(c: FbConnection) {
  await mkdir(TOKEN_DIR, { recursive: true });
  await writeFile(tokenFile(c.channelId), JSON.stringify(c, null, 2));
  fbBus.emit("change");
}

export async function fbDisconnect(channelId: string) {
  await rm(tokenFile(channelId), { force: true });
  fbBus.emit("change");
}

// ── Sign-in ────────────────────────────────────────────────────────────────
interface PageChoice {
  id: string;
  name: string;
  access_token: string;
  picture?: { data?: { url?: string } };
}
const pendingAuth = new Map<string, { channelId: string; redirectUri: string; at: number }>();
const pendingPick = new Map<string, { channelId: string; pages: PageChoice[]; at: number }>();

function sweep() {
  const old = Date.now() - 15 * 60_000;
  for (const [k, v] of pendingAuth) if (v.at < old) pendingAuth.delete(k);
  for (const [k, v] of pendingPick) if (v.at < old) pendingPick.delete(k);
}

export function fbAuthUrl(channelId: string, redirectUri: string): string {
  if (!getChannel(channelId)) throw new HttpError(404, "Không có kênh này");
  const { id } = app();
  sweep();
  const state = randomBytes(16).toString("hex");
  pendingAuth.set(state, { channelId, redirectUri, at: Date.now() });
  const q = new URLSearchParams({ client_id: id, redirect_uri: redirectUri, state, response_type: "code", scope: SCOPES.join(",") });
  return `https://www.facebook.com/${V}/dialog/oauth?${q}`;
}

async function graphGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const r = await fetch(`${GRAPH}${path}?${new URLSearchParams(params)}`);
  const data = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
  if (!r.ok || data.error) throw new HttpError(400, `Facebook: ${data.error?.message ?? r.status}`);
  return data as T;
}

/** Finish sign-in. Returns the Pages to choose from (or the one connected, when there is only one). */
export async function fbFinishAuth(code: string, state: string) {
  const p = pendingAuth.get(state);
  if (!p) throw new HttpError(400, "Phiên đăng nhập đã hết hạn — bấm Kết nối Facebook lại.");
  pendingAuth.delete(state);
  const { id, secret } = app();
  const short = await graphGet<{ access_token: string }>("/oauth/access_token", { client_id: id, client_secret: secret, redirect_uri: p.redirectUri, code });
  // Long-lived user token → Page tokens that never expire.
  const long = await graphGet<{ access_token: string }>("/oauth/access_token", {
    grant_type: "fb_exchange_token", client_id: id, client_secret: secret, fb_exchange_token: short.access_token,
  });
  const pages = await graphGet<{ data: PageChoice[] }>("/me/accounts", {
    access_token: long.access_token, fields: "id,name,access_token,picture{url}", limit: "100",
  });
  if (!pages.data?.length) {
    throw new HttpError(400, "Không thấy Page nào. Lúc đăng nhập hãy tick chọn các Page cho app, và tài khoản phải là quản trị viên của Page.");
  }
  if (pages.data.length === 1) {
    const page = await fbSelect(p.channelId, pages.data[0]);
    return { channelId: p.channelId, connected: page };
  }
  sweep();
  const pick = randomBytes(12).toString("hex");
  pendingPick.set(pick, { channelId: p.channelId, pages: pages.data, at: Date.now() });
  return { channelId: p.channelId, pick, pages: pages.data.map((x) => ({ id: x.id, name: x.name, picture: x.picture?.data?.url })) };
}

async function fbSelect(channelId: string, page: PageChoice) {
  await saveFb({
    channelId,
    page: { id: page.id, name: page.name, picture: page.picture?.data?.url },
    pageToken: page.access_token,
    connectedAt: new Date().toISOString(),
  });
  return { id: page.id, name: page.name };
}

export async function fbPick(pick: string, pageId: string) {
  const p = pendingPick.get(pick);
  if (!p) throw new HttpError(400, "Phiên chọn Page đã hết hạn — kết nối lại.");
  const page = p.pages.find((x) => x.id === pageId);
  if (!page) throw new HttpError(400, "Page không hợp lệ");
  pendingPick.delete(pick);
  return { channelId: p.channelId, page: await fbSelect(p.channelId, page) };
}

// ── Upload ─────────────────────────────────────────────────────────────────
export interface FbJob {
  channelId: string;
  video: string;
  title: string;
  description: string;
  vertical: boolean;
  durationSec: number;
  /** ISO time; undefined = publish now. */
  publishAt?: string;
  /** false = upload unpublished (draft in the Page's content library). */
  publish: boolean;
}

async function fbError(r: Response, conn: FbConnection): Promise<UploadError> {
  const body = (await r.json().catch(() => null)) as { error?: { message?: string; code?: number; error_subcode?: number } } | null;
  const e = body?.error;
  const msg = `Facebook ${r.status}${e?.code ? ` #${e.code}` : ""}: ${e?.message ?? r.statusText}`;
  if (e?.code === 190 || e?.code === 102) {
    conn.broken = "Token Page hết hiệu lực";
    await saveFb(conn);
    return new UploadError(`${msg} — kết nối Facebook lại cho kênh.`, false);
  }
  const code = e?.code ?? 0;
  if (code === 10 || (code >= 200 && code < 300)) {
    return new UploadError(`${msg} — thiếu quyền: kiểm tra app Meta đã thêm pages_manage_posts và bạn là quản trị viên Page.`, false);
  }
  if ([4, 17, 32, 613, 80001].includes(e?.code ?? 0)) return new UploadError(`Facebook giới hạn tần suất. ${msg}`, true, 3600_000);
  if (r.status >= 500 || e?.code === 1 || e?.code === 2 || e?.code === 6000) return new UploadError(msg, true);
  return new UploadError(msg, false);
}

async function readChunk(file: string, start: number, end: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const p of createReadStream(file, { start, end })) parts.push(p as Buffer);
  return Buffer.concat(parts);
}

const unix = (iso: string) => String(Math.floor(new Date(iso).getTime() / 1000));

function checkSchedule(publishAt?: string) {
  if (!publishAt) return;
  const ms = new Date(publishAt).getTime() - Date.now();
  if (ms > 29 * 86400_000) throw new UploadError("Facebook chỉ cho hẹn giờ tối đa ~30 ngày — chọn giờ gần hơn.", false);
}

/** Upload one video to the Page; returns the Facebook video id. */
export async function fbUpload(job: FbJob, progress: (pct: number) => void, log: (m: string) => void): Promise<{ videoId: string; url: string }> {
  const conn = getFbConnection(job.channelId);
  if (!conn) throw new UploadError("Kênh chưa kết nối Facebook — vào trang Kênh bấm Kết nối Facebook.", false);
  if (conn.broken) throw new UploadError(`Kết nối Facebook đã hỏng (${conn.broken}) — kết nối lại.`, false);
  checkSchedule(job.publishAt);
  const token = conn.pageToken;
  const size = statSync(job.video).size;
  const asReel = job.vertical && job.durationSec >= 3 && job.durationSec <= REEL_MAX_SEC;
  const caption = [job.title, job.description].filter(Boolean).join("\n\n").slice(0, 60_000);

  if (asReel) {
    log(`Facebook Reels → ${conn.page.name}: "${job.title}" (${(size / 1048576).toFixed(0)} MB)`);
    const start = await fetch(`${GRAPH}/${conn.page.id}/video_reels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ upload_phase: "start", access_token: token }),
    });
    if (!start.ok) throw await fbError(start, conn);
    const { video_id } = (await start.json()) as { video_id: string };
    const bytes = await readFile(job.video);
    const up = await fetch(`${RUPLOAD}/${video_id}`, {
      method: "POST",
      headers: { Authorization: `OAuth ${token}`, offset: "0", file_size: String(size) },
      body: new Uint8Array(bytes),
    });
    if (!up.ok) throw await fbError(up, conn);
    progress(100);
    const params = new URLSearchParams({
      access_token: token,
      upload_phase: "finish",
      video_id,
      description: caption,
      video_state: job.publishAt ? "SCHEDULED" : job.publish ? "PUBLISHED" : "DRAFT",
    });
    if (job.publishAt) params.set("scheduled_publish_time", unix(job.publishAt));
    const fin = await fetch(`${GRAPH}/${conn.page.id}/video_reels?${params}`, { method: "POST" });
    if (!fin.ok) throw await fbError(fin, conn);
    return { videoId: video_id, url: `https://www.facebook.com/reel/${video_id}` };
  }

  // Normal Page video: chunked upload (start → transfer… → finish).
  log(`Facebook video → ${conn.page.name}: "${job.title}" (${(size / 1048576).toFixed(0)} MB)`);
  const form = (fields: Record<string, string | Blob>) => {
    const f = new FormData();
    f.set("access_token", token);
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    return f;
  };
  const start = await fetch(`${GRAPH_VIDEO}/${conn.page.id}/videos`, { method: "POST", body: form({ upload_phase: "start", file_size: String(size) }) });
  if (!start.ok) throw await fbError(start, conn);
  const s = (await start.json()) as { video_id: string; upload_session_id: string; start_offset: string; end_offset: string };
  let from = Number(s.start_offset);
  let to = Number(s.end_offset);
  let failures = 0;
  while (from < to) {
    try {
      const chunk = await readChunk(job.video, from, Math.min(to, from + CHUNK) - 1);
      const r = await fetch(`${GRAPH_VIDEO}/${conn.page.id}/videos`, {
        method: "POST",
        body: form({
          upload_phase: "transfer",
          upload_session_id: s.upload_session_id,
          start_offset: String(from),
          video_file_chunk: new Blob([new Uint8Array(chunk)], { type: "application/octet-stream" }),
        }),
      });
      if (!r.ok) {
        const err = await fbError(r, conn);
        if (!err.retry) throw Object.assign(err, { fatal: true });
        throw err;
      }
      const next = (await r.json()) as { start_offset: string; end_offset: string };
      from = Number(next.start_offset);
      to = Number(next.end_offset);
      failures = 0;
      progress(Math.round((from / size) * 100));
    } catch (e) {
      if ((e as { fatal?: boolean }).fatal || ++failures > 6) throw e;
      log(`Lỗi khi tải lên Facebook (${(e as Error).message}) — thử lại lần ${failures}`);
      await new Promise((res) => setTimeout(res, Math.min(60_000, 2000 * 2 ** failures)));
    }
  }
  const fields: Record<string, string> = {
    upload_phase: "finish",
    upload_session_id: s.upload_session_id,
    title: job.title.slice(0, 255),
    description: job.description,
  };
  if (job.publishAt) {
    fields.published = "false";
    fields.scheduled_publish_time = unix(job.publishAt);
  } else if (!job.publish) fields.published = "false";
  const fin = await fetch(`${GRAPH_VIDEO}/${conn.page.id}/videos`, { method: "POST", body: form(fields) });
  if (!fin.ok) throw await fbError(fin, conn);
  return { videoId: s.video_id, url: `https://www.facebook.com/${conn.page.id}/videos/${s.video_id}` };
}


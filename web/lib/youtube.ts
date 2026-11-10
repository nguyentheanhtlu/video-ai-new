import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDurationSec } from "../../src/assets/audio-tools.js";
import { getChannel, type Channel } from "./channels.js";
import { fbUpload, getFbConnection } from "./facebook.js";
import { HttpError, projectDir, ROOT } from "./paths.js";
import { UploadError } from "./upload-error.js";

/**
 * Block C: publish rendered videos to YouTube through the official Data API v3.
 *
 * - OAuth (installed-app client + PKCE) once per tool channel; the refresh token
 *   lives in credentials/youtube/<channelId>.json and never leaves this machine.
 * - Uploads go through a queue persisted in data/youtube-queue.json, worked one
 *   at a time, so a restart, a dropped connection or a spent daily quota only
 *   delays an upload instead of losing it.
 * - Resumable uploads in 16 MB chunks: a network error resumes from the last
 *   byte YouTube confirmed.
 */

const CRED_DIR = join(ROOT, "credentials");
const CLIENT_FILE = join(CRED_DIR, "client_secret.json");
const TOKEN_DIR = join(CRED_DIR, "youtube");
const QUEUE_FILE = join(ROOT, "data", "youtube-queue.json");
const QUOTA_FILE = join(ROOT, "data", "youtube-quota.json");

const SCOPES = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube"];
const API = "https://www.googleapis.com/youtube/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/youtube/v3";

/** Units per call (developers.google.com/youtube/v3/determine_quota_cost). */
export const COST = { upload: 1600, thumbnail: 50, list: 1 };
const DAILY_QUOTA = () => Number(process.env.YOUTUBE_DAILY_QUOTA) || 10_000;
const CHUNK = 16 * 1024 * 1024; // multiple of 256 KiB, as resumable uploads require
const MAX_ATTEMPTS = 6;

/** Emits "change" whenever the queue, quota or a connection changes. */
export const ytBus = new EventEmitter();

// ── OAuth client ───────────────────────────────────────────────────────────
interface ClientSecret {
  client_id: string;
  client_secret: string;
  auth_uri: string;
  token_uri: string;
}

function client(): ClientSecret {
  if (!existsSync(CLIENT_FILE)) throw new HttpError(400, "Chưa có credentials/client_secret.json (OAuth Client ID loại Desktop app).");
  const raw = JSON.parse(readFileSync(CLIENT_FILE, "utf8"));
  const c = raw.installed ?? raw.web;
  if (!c?.client_id || !c?.client_secret) throw new HttpError(400, "client_secret.json không đúng định dạng.");
  return c;
}

export const oauthConfigured = () => existsSync(CLIENT_FILE);

// ── Tokens, one file per tool channel ──────────────────────────────────────
export interface Connection {
  channelId: string;
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number;
  youtube: { id: string; title: string; thumbnail?: string; customUrl?: string };
  connectedAt: string;
  /** Set when Google rejects the refresh token (revoked / expired): reconnect needed. */
  broken?: string;
}

const tokenFile = (channelId: string) => {
  if (!/^[a-z0-9-]+$/.test(channelId)) throw new HttpError(400, "Kênh không hợp lệ");
  return join(TOKEN_DIR, `${channelId}.json`);
};

export function getConnection(channelId: string): Connection | null {
  try {
    return JSON.parse(readFileSync(tokenFile(channelId), "utf8"));
  } catch {
    return null;
  }
}

async function saveConnection(c: Connection) {
  await mkdir(TOKEN_DIR, { recursive: true });
  await writeFile(tokenFile(c.channelId), JSON.stringify(c, null, 2));
  ytBus.emit("change");
}

/** Public view: no tokens. */
export function publicConnection(channelId: string) {
  const c = getConnection(channelId);
  return c ? { youtube: c.youtube, connectedAt: c.connectedAt, broken: c.broken ?? null } : null;
}

// Pending sign-ins: state → who asked and the PKCE verifier.
const pending = new Map<string, { channelId: string; verifier: string; redirectUri: string; at: number }>();

export function authUrl(channelId: string, redirectUri: string): string {
  if (!getChannel(channelId)) throw new HttpError(404, "Không có kênh này");
  const c = client();
  for (const [k, v] of pending) if (Date.now() - v.at > 15 * 60_000) pending.delete(k);
  const state = randomBytes(16).toString("hex");
  const verifier = randomBytes(48).toString("base64url");
  pending.set(state, { channelId, verifier, redirectUri, at: Date.now() });
  const q = new URLSearchParams({
    client_id: c.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    // Always show the account/channel picker and always return a refresh token.
    prompt: "consent select_account",
    include_granted_scopes: "true",
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  return `${c.auth_uri}?${q}`;
}

async function tokenRequest(body: Record<string, string>) {
  const c = client();
  const r = await fetch(c.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.client_id, client_secret: c.client_secret, ...body }),
  });
  const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw Object.assign(new Error(`Google OAuth: ${data.error_description ?? data.error ?? r.status}`), { code: data.error });
  return data as { access_token: string; expires_in: number; refresh_token?: string; scope?: string };
}

/** Finish the sign-in: swap the code for tokens and record which YouTube channel was picked. */
export async function finishAuth(code: string, state: string): Promise<{ channelId: string; youtubeTitle: string }> {
  const p = pending.get(state);
  if (!p) throw new HttpError(400, "Phiên đăng nhập đã hết hạn — bấm Kết nối YouTube lại.");
  pending.delete(state);
  const t = await tokenRequest({ code, grant_type: "authorization_code", redirect_uri: p.redirectUri, code_verifier: p.verifier });
  if (!t.refresh_token) throw new HttpError(400, "Google không trả refresh token — vào myaccount.google.com/permissions gỡ app rồi kết nối lại.");
  const granted = (t.scope ?? "").split(" ");
  if (!granted.includes(SCOPES[0])) throw new HttpError(400, "Bạn chưa tick quyền tải video lên YouTube — kết nối lại và tick đủ các quyền.");
  const r = await fetch(`${API}/channels?part=snippet&mine=true`, { headers: { Authorization: `Bearer ${t.access_token}` } });
  const data = (await r.json()) as { items?: { id: string; snippet: { title: string; customUrl?: string; thumbnails?: { default?: { url: string } } } }[] };
  await addQuota(COST.list);
  const ch = data.items?.[0];
  if (!ch) throw new HttpError(400, "Tài khoản này chưa có kênh YouTube — tạo kênh trên YouTube trước.");
  await saveConnection({
    channelId: p.channelId,
    refreshToken: t.refresh_token,
    accessToken: t.access_token,
    expiresAt: Date.now() + t.expires_in * 1000,
    youtube: { id: ch.id, title: ch.snippet.title, customUrl: ch.snippet.customUrl, thumbnail: ch.snippet.thumbnails?.default?.url },
    connectedAt: new Date().toISOString(),
  });
  kick();
  return { channelId: p.channelId, youtubeTitle: ch.snippet.title };
}

export async function disconnect(channelId: string): Promise<void> {
  const c = getConnection(channelId);
  if (!c) return;
  // Revoke at Google too, so the token is dead even if the file was copied.
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(c.refreshToken)}`, { method: "POST" }).catch(() => {});
  await rm(tokenFile(channelId), { force: true });
  ytBus.emit("change");
}

async function accessToken(channelId: string): Promise<string> {
  const c = getConnection(channelId);
  if (!c) throw new UploadError("Kênh chưa kết nối YouTube — vào trang Kênh bấm Kết nối YouTube.", false);
  if (c.broken) throw new UploadError(`Kết nối YouTube đã hỏng (${c.broken}) — kết nối lại.`, false);
  if (c.accessToken && (c.expiresAt ?? 0) - Date.now() > 120_000) return c.accessToken;
  try {
    const t = await tokenRequest({ refresh_token: c.refreshToken, grant_type: "refresh_token" });
    c.accessToken = t.access_token;
    c.expiresAt = Date.now() + t.expires_in * 1000;
    await saveConnection(c);
    return c.accessToken;
  } catch (e) {
    if ((e as { code?: string }).code === "invalid_grant") {
      c.broken = "Google đã thu hồi quyền hoặc token hết hạn";
      await saveConnection(c);
      throw new UploadError(`${c.broken} — kết nối lại kênh.`, false);
    }
    throw new UploadError((e as Error).message, true);
  }
}

// ── Quota (resets at midnight Pacific time) ────────────────────────────────
const pacificDay = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

export function quota() {
  let q = { day: pacificDay(), used: 0 };
  try {
    const saved = JSON.parse(readFileSync(QUOTA_FILE, "utf8"));
    if (saved.day === q.day) q = saved;
  } catch {
    /* first use today */
  }
  return { ...q, limit: DAILY_QUOTA(), remaining: Math.max(0, DAILY_QUOTA() - q.used) };
}

async function addQuota(units: number) {
  const q = quota();
  await mkdir(join(ROOT, "data"), { recursive: true });
  await writeFile(QUOTA_FILE, JSON.stringify({ day: q.day, used: q.used + units }));
}

/** Google says the quota is gone even if our count disagrees: trust Google. */
async function quotaSpent() {
  const q = quota();
  await addQuota(Math.max(0, q.limit - q.used));
}

// ── Metadata ───────────────────────────────────────────────────────────────
interface Manifest {
  title: string;
  description: string;
  tags: string[];
  language?: "vi" | "en";
  containsSyntheticMedia?: boolean;
  thumbnail?: string;
  vertical: boolean;
}

const clean = (s: string) => s.replace(/[<>]/g, "").replace(/\*/g, "");

/** Cut a string to a UTF-8 byte budget without splitting a character. */
function byteSlice(s: string, max: number) {
  if (Buffer.byteLength(s) <= max) return s;
  let out = "";
  for (const ch of s) {
    if (Buffer.byteLength(out + ch) > max) break;
    out += ch;
  }
  return out;
}

/** YouTube counts the tag list as ≤500 chars, a tag with spaces costing its quotes too. */
export function fitTags(tags: string[]): string[] {
  const out: string[] = [];
  let len = 0;
  for (const raw of tags) {
    const t = clean(raw).replace(/,/g, " ").trim().slice(0, 100);
    if (!t || out.some((o) => o.toLowerCase() === t.toLowerCase())) continue;
    const cost = t.length + (/\s/.test(t) ? 2 : 0) + (out.length ? 1 : 0);
    if (len + cost > 500) break;
    out.push(t);
    len += cost;
  }
  return out;
}

export function fitTitle(title: string): string {
  const t = clean(title).replace(/\s+/g, " ").trim();
  return t.length <= 100 ? t : `${t.slice(0, 99).trimEnd()}…`;
}

async function readManifest(slug: string): Promise<Manifest> {
  const dir = projectDir(slug);
  if (!existsSync(join(dir, "video.mp4"))) throw new UploadError("Dự án chưa có video.mp4 — render trước.", false);
  const script = JSON.parse(await readFile(join(dir, "script.json"), "utf8"));
  const vertical = script.aspect === "9:16";
  const yt = existsSync(join(dir, "youtube.json")) ? JSON.parse(await readFile(join(dir, "youtube.json"), "utf8")) : null;
  const descFile = join(dir, "description.txt");
  const description = yt?.description ?? (existsSync(descFile) ? await readFile(descFile, "utf8") : script.metadata?.description ?? "");
  const thumb = ["thumbnail.jpg", ...(vertical ? [] : ["cover.jpg"])].find((f) => existsSync(join(dir, f)));
  return {
    title: yt?.title ?? script.metadata?.title ?? slug,
    description: String(description).trim(),
    tags: yt?.tags ?? script.metadata?.tags ?? [],
    language: yt?.language ?? script.language,
    containsSyntheticMedia: yt?.containsSyntheticMedia,
    thumbnail: thumb ? join(dir, thumb) : undefined,
    vertical,
  };
}

// ── Queue ──────────────────────────────────────────────────────────────────
export type UploadStatus = "pending" | "uploading" | "done" | "failed";
export type Privacy = "public" | "unlisted" | "private";

export type Platform = "youtube" | "facebook";
export const PLATFORM_NAME: Record<Platform, string> = { youtube: "YouTube", facebook: "Facebook" };

export interface UploadItem {
  id: string;
  /** Missing on entries queued before Facebook existed: those are YouTube. */
  platform?: Platform;
  slug: string;
  channelId: string;
  title: string;
  privacy: Privacy;
  /** ISO time YouTube makes the video public (uploaded private until then). */
  publishAt?: string;
  status: UploadStatus;
  progress?: number;
  attempts: number;
  nextTryAt?: string;
  error?: string;
  videoId?: string;
  /** Where to see it (Studio link for YouTube, the post for Facebook). */
  url?: string;
  warnings?: string[];
  createdAt: string;
  uploadedAt?: string;
  auto?: boolean;
}

function readQueue(): UploadItem[] {
  try {
    const q = JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
    return Array.isArray(q) ? q : [];
  } catch {
    return [];
  }
}

let queueCache: UploadItem[] | null = null;
const items = () => (queueCache ??= readQueue());

async function persist() {
  await mkdir(join(ROOT, "data"), { recursive: true });
  // Keep the last 300 finished entries.
  const list = items();
  const finished = list.filter((i) => i.status === "done" || i.status === "failed");
  const drop = new Set(finished.slice(0, Math.max(0, finished.length - 300)).map((i) => i.id));
  queueCache = list.filter((i) => !drop.has(i.id));
  await writeFile(QUEUE_FILE, JSON.stringify(queueCache, null, 2));
  ytBus.emit("change");
}

export const platformOf = (i: Pick<UploadItem, "platform">): Platform => i.platform ?? "youtube";
export const listUploads = () => [...items()].reverse().map((i) => ({ ...i, platform: platformOf(i) }));
export const uploadsFor = (slug: string) => items().filter((i) => i.slug === slug);

const isConnected = (platform: Platform, channelId: string) =>
  platform === "facebook" ? !!getFbConnection(channelId) : !!getConnection(channelId);

/**
 * Next free daily publish slot (Vietnam time, UTC+7) for a channel on one
 * platform, at least 30 min out. YouTube and Facebook keep separate slot lists,
 * so the same video goes live on both at the same time.
 */
export function nextSlot(channel: Channel, taken = items(), platform: Platform = "youtube"): string | undefined {
  const times = (channel.publishTimes ?? []).filter((t) => /^\d{2}:\d{2}$/.test(t)).sort();
  if (!times.length) return undefined;
  const busy = new Set(
    taken
      .filter((i) => i.channelId === channel.id && platformOf(i) === platform && i.publishAt && i.status !== "failed")
      .map((i) => new Date(i.publishAt!).getTime()),
  );
  const earliest = Date.now() + 30 * 60_000;
  const vnNow = new Date(Date.now() + 7 * 3600_000);
  for (let d = 0; d < 120; d++) {
    for (const t of times) {
      const [hh, mm] = t.split(":").map(Number);
      const at = Date.UTC(vnNow.getUTCFullYear(), vnNow.getUTCMonth(), vnNow.getUTCDate() + d, hh - 7, mm);
      if (at >= earliest && !busy.has(at)) return new Date(at).toISOString();
    }
  }
  return undefined;
}

export async function enqueueUpload(opts: {
  slug: string;
  channelId: string;
  platform?: Platform;
  privacy?: Privacy;
  /** ISO time, "auto" = next free slot of the channel, undefined = right away. */
  publishAt?: string;
  auto?: boolean;
}): Promise<UploadItem> {
  const platform = opts.platform ?? "youtube";
  const channel = getChannel(opts.channelId);
  if (!channel) throw new HttpError(404, "Không có kênh này");
  if (!isConnected(platform, channel.id)) throw new HttpError(400, `Kênh "${channel.name}" chưa kết nối ${PLATFORM_NAME[platform]}.`);
  const live = items().find((i) => i.slug === opts.slug && i.channelId === channel.id && platformOf(i) === platform && (i.status === "pending" || i.status === "uploading" || i.status === "done"));
  if (live) throw new HttpError(409, live.status === "done" ? `Video này đã đăng lên ${PLATFORM_NAME[platform]} của kênh này rồi.` : `Video này đang chờ đăng ${PLATFORM_NAME[platform]}.`);
  const m = await readManifest(opts.slug).catch((e) => {
    throw new HttpError(400, (e as Error).message);
  });
  let publishAt = opts.publishAt === "auto" ? nextSlot(channel, items(), platform) : opts.publishAt;
  if (publishAt) {
    const t = new Date(publishAt).getTime();
    if (!Number.isFinite(t)) throw new HttpError(400, "Giờ đăng không hợp lệ");
    if (t < Date.now() + 15 * 60_000) publishAt = undefined; // too close: just publish now
    else publishAt = new Date(t).toISOString();
  }
  const item: UploadItem = {
    id: randomUUID(),
    platform,
    slug: opts.slug,
    channelId: channel.id,
    title: fitTitle(m.title),
    privacy: opts.privacy ?? channel.privacy ?? "public",
    publishAt,
    status: "pending",
    attempts: 0,
    createdAt: new Date().toISOString(),
    auto: opts.auto,
  };
  items().push(item);
  await persist();
  kick();
  return item;
}

export async function retryUpload(id: string) {
  const it = items().find((i) => i.id === id);
  if (!it) throw new HttpError(404, "Không có lượt đăng này");
  if (it.status !== "failed") throw new HttpError(400, "Chỉ thử lại được lượt đăng bị lỗi");
  Object.assign(it, { status: "pending", attempts: 0, error: undefined, nextTryAt: undefined, progress: undefined });
  await persist();
  kick();
  return it;
}

export async function removeUpload(id: string) {
  const it = items().find((i) => i.id === id);
  if (!it) return;
  if (it.status === "uploading") throw new HttpError(409, "Đang tải lên — chờ xong hoặc lỗi rồi mới xoá.");
  queueCache = items().filter((i) => i.id !== id);
  await persist();
}

// ── Upload ─────────────────────────────────────────────────────────────────
async function ytError(r: Response): Promise<UploadError> {
  const body = (await r.json().catch(() => null)) as { error?: { message?: string; errors?: { reason?: string }[] } } | null;
  const reason = body?.error?.errors?.[0]?.reason ?? "";
  const msg = `YouTube ${r.status}${reason ? ` ${reason}` : ""}: ${body?.error?.message ?? r.statusText}`;
  if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
    await quotaSpent();
    return new UploadError(`Hết quota API hôm nay — tự đăng tiếp sau 0h giờ Mỹ (~14–15h VN). ${msg}`, true);
  }
  // Too many uploads for this channel today (YouTube's own per-channel cap).
  if (reason === "uploadLimitExceeded") return new UploadError(`Kênh đã chạm giới hạn upload trong ngày. ${msg}`, true, 6 * 3600_000);
  if (r.status === 401) return new UploadError(msg, true, 60_000);
  if (r.status >= 500 || r.status === 429) return new UploadError(msg, true);
  return new UploadError(msg, false);
}

async function readChunk(file: string, start: number, end: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const p of createReadStream(file, { start, end })) parts.push(p as Buffer);
  return Buffer.concat(parts);
}

/** How many bytes YouTube already has for a resumable session (from a 308's Range header). */
function confirmedBytes(r: Response): number {
  const range = r.headers.get("range");
  const m = range?.match(/bytes=0-(\d+)/);
  return m ? Number(m[1]) + 1 : 0;
}

async function upload(item: UploadItem, log: (msg: string) => void): Promise<void> {
  const channel = getChannel(item.channelId);
  if (!channel) throw new UploadError("Kênh đã bị xoá khỏi tool", false);
  const m = await readManifest(item.slug);
  const video = join(projectDir(item.slug), "video.mp4");
  const size = statSync(video).size;

  const lang = m.language ?? channel.language;
  let description = clean(m.description);
  if (m.vertical && !/#shorts/i.test(description) && !/#shorts/i.test(m.title)) description = `${description}\n\n#Shorts`.trim();
  const status: Record<string, unknown> = {
    privacyStatus: item.publishAt ? "private" : item.privacy,
    selfDeclaredMadeForKids: false,
    embeddable: true,
    // AI-made visuals or voice: YouTube's "altered or synthetic content" label.
    containsSyntheticMedia: channel.declareSynthetic !== false ? true : !!m.containsSyntheticMedia,
  };
  if (item.publishAt) status.publishAt = item.publishAt;
  const resource = {
    snippet: {
      title: fitTitle(m.title),
      description: byteSlice(description, 5000),
      tags: fitTags(m.tags),
      categoryId: channel.categoryId ?? "22",
      defaultLanguage: lang,
      defaultAudioLanguage: lang,
    },
    status,
  };

  if (quota().remaining < COST.upload + COST.thumbnail) {
    throw new UploadError(`Hết quota API hôm nay (${quota().used}/${quota().limit}) — tự đăng tiếp khi quota reset (0h giờ Mỹ).`, true, 30 * 60_000);
  }

  let token = await accessToken(item.channelId);
  log(`Bắt đầu tải lên "${resource.snippet.title}" (${(size / 1048576).toFixed(0)} MB) → ${channel.name}`);
  const init = await fetch(`${UPLOAD_API}/videos?uploadType=resumable&part=snippet,status&notifySubscribers=true`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Length": String(size),
      "X-Upload-Content-Type": "video/mp4",
    },
    body: JSON.stringify(resource),
  });
  if (!init.ok) throw await ytError(init);
  const session = init.headers.get("location");
  if (!session) throw new UploadError("YouTube không trả URL phiên upload", true);
  // videos.insert is charged when the session is created.
  await addQuota(COST.upload);

  let offset = 0;
  let failures = 0;
  let result: { id?: string } | null = null;
  while (!result) {
    const end = Math.min(offset + CHUNK, size) - 1;
    try {
      const body = await readChunk(video, offset, end);
      const r = await fetch(session, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Length": String(body.length), "Content-Range": `bytes ${offset}-${end}/${size}` },
        body: new Uint8Array(body),
      });
      if (r.status === 308) {
        offset = confirmedBytes(r);
      } else if (r.ok) {
        result = (await r.json()) as { id?: string };
        break;
      } else if (r.status >= 500 || r.status === 401) {
        throw await ytError(r);
      } else {
        throw Object.assign(await ytError(r), { fatal: true });
      }
      failures = 0;
      item.progress = Math.round((offset / size) * 100);
      ytBus.emit("change");
    } catch (e) {
      if ((e as { fatal?: boolean }).fatal || ++failures > 8) throw e;
      log(`Lỗi mạng khi tải (${(e as Error).message}) — thử lại lần ${failures}`);
      await new Promise((res) => setTimeout(res, Math.min(60_000, 2000 * 2 ** failures)));
      token = await accessToken(item.channelId);
      // Ask YouTube how much it has, then continue from there.
      const s = await fetch(session, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Range": `bytes */${size}`, "Content-Length": "0" } }).catch(() => null);
      if (s?.ok) {
        result = (await s.json()) as { id?: string };
        break;
      }
      if (s?.status === 308) offset = confirmedBytes(s);
      else if (s?.status === 404 || s?.status === 410) throw new UploadError("Phiên upload đã hết hạn — sẽ tải lại từ đầu", true);
    }
  }
  if (!result.id) throw new UploadError("YouTube không trả ID video", false);
  item.videoId = result.id;
  item.url = `https://studio.youtube.com/video/${result.id}/edit`;
  item.progress = 100;
  log(`✓ Đã tải lên: https://youtu.be/${result.id}`);

  // Thumbnail: needs a phone-verified channel; a failure here keeps the upload.
  if (m.thumbnail) {
    try {
      const img = await readFile(m.thumbnail);
      if (img.length > 2 * 1024 * 1024) throw new Error("ảnh > 2 MB");
      const r = await fetch(`${UPLOAD_API}/thumbnails/set?videoId=${result.id}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${await accessToken(item.channelId)}`, "Content-Type": "image/jpeg" },
        body: new Uint8Array(img),
      });
      await addQuota(COST.thumbnail);
      if (!r.ok) throw await ytError(r);
      log("✓ Đã đặt thumbnail");
    } catch (e) {
      (item.warnings ??= []).push(`Chưa đặt được thumbnail: ${(e as Error).message}. Kênh cần xác minh số điện thoại (youtube.com/verify).`);
      log(`⚠ ${item.warnings.at(-1)}`);
    }
  }
}

async function uploadFacebook(item: UploadItem) {
  const m = await readManifest(item.slug);
  const video = join(projectDir(item.slug), "video.mp4");
  const durationSec = await getDurationSec(video).catch(() => 0);
  const r = await fbUpload(
    {
      channelId: item.channelId,
      video,
      title: fitTitle(m.title),
      description: clean(m.description),
      vertical: m.vertical,
      durationSec,
      publishAt: item.publishAt,
      publish: item.privacy === "public",
    },
    (pct) => {
      item.progress = pct;
      ytBus.emit("change");
    },
    log,
  );
  item.videoId = r.videoId;
  item.url = r.url;
  item.progress = 100;
  log(`✓ Đã đăng Facebook: ${r.url}`);
}

// ── Worker: one upload at a time ───────────────────────────────────────────
let busy = false;
let timer: NodeJS.Timeout | null = null;
const logs: string[] = [];
export const uploadLog = () => logs.slice(-200);

function log(msg: string) {
  const line = `[${new Date().toLocaleTimeString("vi-VN")}] ${msg}`;
  logs.push(line);
  if (logs.length > 500) logs.splice(0, logs.length - 500);
  console.log(`  [Đăng video] ${msg}`);
  ytBus.emit("log", line);
}

export function kick() {
  setImmediate(() => void work());
}

async function work() {
  if (busy) return;
  busy = true;
  try {
    for (;;) {
      const now = Date.now();
      const item = items().find((i) => i.status === "pending" && (!i.nextTryAt || new Date(i.nextTryAt).getTime() <= now));
      if (!item) break;
      // A slot that passed while waiting: publish right away instead of failing.
      if (item.publishAt && new Date(item.publishAt).getTime() < now + 15 * 60_000) item.publishAt = undefined;
      item.status = "uploading";
      item.attempts++;
      item.error = undefined;
      await persist();
      try {
        if (platformOf(item) === "facebook") await uploadFacebook(item);
        else await upload(item, log);
        item.status = "done";
        item.uploadedAt = new Date().toISOString();
        item.nextTryAt = undefined;
      } catch (e) {
        const err = e instanceof UploadError ? e : new UploadError((e as Error).message, true);
        item.error = err.message;
        item.progress = undefined;
        const quotaWait = /quota/i.test(err.message);
        if (err.retry && (quotaWait || item.attempts < MAX_ATTEMPTS)) {
          item.status = "pending";
          if (quotaWait) item.attempts--; // waiting for quota isn't a failed try
          const wait = err.waitMs ?? (quotaWait ? 30 * 60_000 : Math.min(3600_000, 60_000 * 2 ** item.attempts));
          item.nextTryAt = new Date(Date.now() + wait).toISOString();
          log(`✗ [${PLATFORM_NAME[platformOf(item)]}] ${item.title}: ${err.message} — thử lại lúc ${new Date(item.nextTryAt).toLocaleTimeString("vi-VN")}`);
        } else {
          item.status = "failed";
          log(`✗ [${PLATFORM_NAME[platformOf(item)]}] ${item.title}: ${err.message}`);
        }
      }
      await persist();
    }
  } finally {
    busy = false;
  }
}

/** Resume after a restart: an upload cut off mid-way goes back to the queue. */
export async function startUploadWorker() {
  let changed = false;
  for (const i of items()) {
    if (i.status === "uploading") {
      i.status = "pending";
      i.progress = undefined;
      changed = true;
    }
  }
  if (changed) await persist();
  timer ??= setInterval(kick, 60_000);
  kick();
}

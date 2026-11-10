import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { toSlug } from "../../src/utils/slug.js";
import { VoiceOverrideSchema } from "../../src/tts/voice.js";
import { HttpError, ROOT } from "./paths.js";
import { STYLE_IDS } from "./script-styles.js";

/**
 * A YouTube channel the tool produces for: its language, voice, topic and look.
 * Every long video is made "for" one channel, which is how many channels (in
 * Vietnamese and English) run side by side from one install.
 */
export const ChannelSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(80),
  language: z.enum(["vi", "en"]),
  /** Topic + editorial voice, given to the AI for every script (e.g. "Bóng đá châu Âu, phân tích chiến thuật, giọng sôi nổi"). */
  niche: z.string().max(2000).default(""),
  url: z.string().max(200).default(""),
  voice: VoiceOverrideSchema,
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#0e9f6e"),
  /** Default length of a long video, in minutes. */
  minutes: z.number().min(2).max(20).default(8),
  music: z.boolean().default(true),
  subtitles: z.boolean().default(true),
  /** "ai": AI illustrations checked against the narration (Gemini); "stock": Pixabay/Pexels footage. Real people always use real photos. */
  visuals: z.enum(["ai", "stock"]).default("ai"),
  aiImageSize: z.enum(["1K", "2K"]).default("2K"),
  /** Animate the opening image into a short clip (Gemini Omni, ~0.1 USD/s). */
  aiHookVideo: z.boolean().default(false),
  /** Upload to YouTube by itself as soon as a video of this channel finishes rendering. */
  autoUpload: z.boolean().default(false),
  /** Daily publish times, Vietnam time (HH:MM). Each video takes the next free one; empty = publish right after upload. */
  publishTimes: z.array(z.string().regex(/^\d{2}:\d{2}$/)).max(24).default(["19:00"]),
  privacy: z.enum(["public", "unlisted", "private"]).default("public"),
  /** YouTube category: 22 People & Blogs, 25 News & Politics, 17 Sports, 24 Entertainment, 27 Education, 28 Science & Tech. */
  categoryId: z.string().regex(/^\d+$/).default("22"),
  /** First comment posted under each Facebook post; {link} = the video's affiliate link. Empty = no comment. */
  commentTemplate: z.string().max(2000).default("👉 Link sản phẩm: {link}"),
  /** Default script style for this channel's videos (news, affiliate, review…). */
  scriptStyle: z.enum(STYLE_IDS).default("news"),
  /** Tick YouTube's "altered or synthetic content" box on every upload (AI voice / AI images). */
  declareSynthetic: z.boolean().default(true),
  createdAt: z.string().optional(),
});
export type Channel = z.infer<typeof ChannelSchema>;

const FILE = join(ROOT, "data", "channels.json");

export function listChannels(): Channel[] {
  if (!existsSync(FILE)) return [];
  try {
    const raw = JSON.parse(readFileSync(FILE, "utf8"));
    return (Array.isArray(raw) ? raw : []).flatMap((c) => {
      const r = ChannelSchema.safeParse(c);
      return r.success ? [r.data] : [];
    });
  } catch {
    return [];
  }
}

export function getChannel(id: string): Channel | undefined {
  return listChannels().find((c) => c.id === id);
}

async function writeAll(list: Channel[]) {
  await mkdir(join(ROOT, "data"), { recursive: true });
  await writeFile(FILE, JSON.stringify(list, null, 2));
}

/** Create (no id / unknown id) or update a channel. */
export async function saveChannel(input: unknown): Promise<Channel> {
  const body = (input ?? {}) as Record<string, unknown>;
  const list = listChannels();
  const existing = typeof body.id === "string" ? list.find((c) => c.id === body.id) : undefined;
  let id = existing?.id;
  if (!id) {
    const base = toSlug(String(body.name ?? "")).slice(0, 40) || "kenh";
    id = base;
    for (let n = 2; list.some((c) => c.id === id); n++) id = `${base}-${n}`;
  }
  const r = ChannelSchema.safeParse({ ...existing, ...body, id, createdAt: existing?.createdAt ?? new Date().toISOString() });
  if (!r.success) throw new HttpError(400, `Kênh chưa hợp lệ: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const next = existing ? list.map((c) => (c.id === id ? r.data : c)) : [...list, r.data];
  await writeAll(next);
  return r.data;
}

export async function deleteChannel(id: string): Promise<void> {
  await writeAll(listChannels().filter((c) => c.id !== id));
}

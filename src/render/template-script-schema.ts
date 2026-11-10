import { z } from "zod";
import { VoiceOverrideSchema } from "../tts/voice.js";

/**
 * Script schema for the HyperFrames template pipeline. Each scene names a
 * vendored template under templates/<templateId>/ and supplies `inputs` matching that template's
 * data-composition-variables. The agent only fills text — the template owns the
 * visual design. inputs are kept loose here; each template validates its own.
 */

const SfxSpec = z.object({
  name: z.string().min(1),
  volume: z.number().min(0).max(1).default(0.4),
  startOffsetSec: z.number().default(0),
});
export type TplSfxSpecType = z.infer<typeof SfxSpec>;

const TemplateScene = z.object({
  id: z.string().min(1),
  type: z.enum(["hook", "body", "outro"]),
  /** Spoken narration (Vietnamese, spelled-out numbers — see skill rules). */
  voiceText: z.string().min(1),
  /** Folder name under templates/, e.g. "frame-bold-poster". */
  templateId: z.string().min(1),
  /** Text slots for the template's data-composition-variables. */
  inputs: z.record(z.string(), z.unknown()).default({}),
  /** Optional SFX override (else picked per scene.type + voiceText keywords). */
  sfx: SfxSpec.optional(),
});
export type TemplateSceneType = z.infer<typeof TemplateScene>;

export const TemplateScriptSchema = z.object({
  version: z.literal("1.0"),
  /** Discriminator: marks this as a HyperFrames-template script. */
  renderer: z.literal("hyperframes"),
  metadata: z.object({
    title: z.string().min(1),
    source: z.object({
      url: z.string(),
      domain: z.string(),
      image: z.string().url().nullable(),
    }),
    channel: z.string().min(1),
    /** Publish date shown on screen (dd/mm/yyyy); defaults to the render day. */
    date: z.string().optional(),
  }),
  voice: z.object({
    provider: z.literal("omnivoice").default("omnivoice"),
    speed: z.number().min(0.5).max(2.0),
  }),
  /** Output aspect for every scene (templates render a matching composition). */
  aspect: z.enum(["9:16", "16:9", "1:1"]).default("9:16"),
  scenes: z
    .array(TemplateScene)
    .min(3)
    .max(12)
    .refine((s) => s[0]?.type === "hook", { message: "scenes[0] must be type=hook" })
    .refine((s) => s[s.length - 1]?.type === "outro", { message: "last scene must be type=outro" }),
});

export type TemplateScript = z.infer<typeof TemplateScriptSchema>;

/**
 * Long-form 16:9 video (YouTube, 5–15 min): photos and stock footage cut to the
 * narration with crossfades, burned-in subtitles, background music and chapter
 * cards — rendered straight with ffmpeg (src/render/slideshow/), no templates.
 */
const SlideshowScene = z.object({
  id: z.string().min(1),
  type: z.enum(["hook", "body", "outro"]),
  voiceText: z.string().min(1),
  /** Always "slideshow"; kept so the web editor treats every scene alike. */
  templateId: z.literal("slideshow").default("slideshow"),
  /** images: project-relative photos; videos: project-relative stock clips. Shown in that order: videos first. */
  inputs: z
    .object({
      image: z.string().optional(),
      images: z.array(z.string()).optional(),
      videos: z.array(z.string()).optional(),
    })
    .passthrough()
    .default({}),
  /** Chapter id (see script.chapters) this scene belongs to. */
  chapter: z.string().optional(),
  imageQuery: z.string().optional(),
  /** English keywords for stock footage search (Pixabay / Pexels). */
  videoQuery: z.string().optional(),
  /** What the AI asked for: a real photo of the story, generic footage, or an AI illustration. */
  visual: z.enum(["photo", "video", "ai"]).optional(),
  /** English prompts for AI illustrations of this scene (also the fallback when no real photo is found). */
  imagePrompts: z.array(z.string()).optional(),
});
export type SlideshowSceneType = z.infer<typeof SlideshowScene>;

export const SlideshowScriptSchema = z.object({
  version: z.literal("1.0"),
  renderer: z.literal("slideshow"),
  language: z.enum(["vi", "en"]).default("vi"),
  metadata: z.object({
    title: z.string().min(1),
    /** YouTube description (chapters and credits are appended at render time). */
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    source: z.object({ url: z.string(), domain: z.string(), image: z.string().nullable() }),
    /** Extra source links (several articles can feed one long video). */
    sources: z.array(z.string()).optional(),
    channel: z.string().min(1),
    channelId: z.string().optional(),
    date: z.string().optional(),
  }),
  voice: z.object({
    provider: z.literal("omnivoice").default("omnivoice"),
    speed: z.number().min(0.5).max(2.0).default(1),
    override: VoiceOverrideSchema.optional(),
  }),
  aspect: z.literal("16:9").default("16:9"),
  chapters: z.array(z.object({ id: z.string().min(1), title: z.string().min(1) })).default([]),
  style: z
    .object({
      subtitles: z.boolean().default(true),
      music: z.boolean().default(true),
      musicVolume: z.number().min(0).max(1).default(0.12),
      brandColor: z.string().optional(),
      /** Shared look of every AI image in the video. */
      visualStyle: z.string().optional(),
    })
    .default({ subtitles: true, music: true, musicVolume: 0.12 }),
  scenes: z
    .array(SlideshowScene)
    .min(3)
    .max(250)
    .refine((s) => s[0]?.type === "hook", { message: "scenes[0] must be type=hook" })
    .refine((s) => s[s.length - 1]?.type === "outro", { message: "last scene must be type=outro" }),
});
export type SlideshowScript = z.infer<typeof SlideshowScriptSchema>;

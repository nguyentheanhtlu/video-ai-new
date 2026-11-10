import { z } from "zod";
import { GENMAX_PROVIDERS } from "./genmax.js";

/**
 * A voice chosen per channel and stored in the script, so each channel speaks
 * its own language and voice no matter what the global Settings say. Absent →
 * the TTS server's global voice (Settings → Giọng đọc).
 */
export const VoiceOverrideSchema = z.object({
  engine: z.enum(["edge", "genmax"]),
  /** Edge voice id, e.g. "vi-VN-HoaiMyNeural" or "en-US-AndrewMultilingualNeural". */
  edgeVoice: z.string().optional(),
  /** Relative speed, e.g. "+8%". */
  rate: z.string().optional(),
  genmax: z
    .object({
      provider: z.enum(GENMAX_PROVIDERS),
      voiceId: z.string().min(1),
      model: z.string().min(1),
      language: z.string().min(1),
    })
    .optional(),
});
export type VoiceOverride = z.infer<typeof VoiceOverrideSchema>;

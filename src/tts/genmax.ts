import pLimit from "p-limit";

// Genmax TTS (https://genmax.io/docs). Synthesis is asynchronous:
// POST /v1/text-to-speech/{voice} → task id → poll /v1/history/{id} → download MP3.

export const GENMAX_PROVIDERS = ["minimax", "capcut", "elevenlabs"] as const;
export type GenmaxProvider = (typeof GENMAX_PROVIDERS)[number];

export interface GenmaxVoice {
  provider: GenmaxProvider;
  voiceId: string;
  model: string;
  /** Provider's own value: "English" for MiniMax, "en" for CapCut/ElevenLabs. */
  language: string;
}

export interface GenmaxVoiceInfo {
  id: string;
  name: string;
  language: string;
  gender: string;
}

const DEFAULT_MODEL: Record<GenmaxProvider, string> = {
  minimax: "speech-2.8-turbo",
  capcut: "capcut",
  elevenlabs: "eleven_multilingual_v2",
};

const SPEED_RANGE: Record<GenmaxProvider, [number, number]> = {
  minimax: [0.5, 2],
  capcut: [0.5, 2],
  elevenlabs: [0.7, 1.2],
};

export const GENMAX_DEFAULTS = {
  provider: "minimax" as GenmaxProvider,
  voiceId: "236835177529408", // Expressive Narrator
  model: DEFAULT_MODEL.minimax,
  language: "English",
};

const POLL_MS = 1000;
// Stays under the 180s the pipeline's TTS client waits for one scene.
const TASK_TIMEOUT_MS = 170_000;
const slots = pLimit(Number(process.env.GENMAX_MAX_CONCURRENCY) || 6);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const baseUrl = () => process.env.GENMAX_BASE_URL || "https://api.genmax.io";

/** Active voice, or undefined to use Edge TTS: entering a key is all it takes to switch on. */
export function genmaxFromEnv(): GenmaxVoice | undefined {
  if (!process.env.GENMAX_API_KEY || process.env.TTS_ENGINE === "edge") return undefined;
  const provider = (process.env.GENMAX_PROVIDER || GENMAX_DEFAULTS.provider) as GenmaxProvider;
  return {
    provider,
    voiceId: process.env.GENMAX_VOICE || GENMAX_DEFAULTS.voiceId,
    model: process.env.GENMAX_MODEL || DEFAULT_MODEL[provider],
    language: process.env.GENMAX_LANGUAGE || GENMAX_DEFAULTS.language,
  };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const apiKey = process.env.GENMAX_API_KEY;
  if (!apiKey) throw new Error("Chưa nhập GENMAX_API_KEY trong Cài đặt.");
  const res = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Genmax ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

interface Task {
  status: "pending" | "processing" | "completed" | "failed";
  result?: { audio_url?: string };
  error?: string | null;
  detail_error?: string | null;
}

async function waitForAudioUrl(id: string): Promise<string> {
  const deadline = Date.now() + TASK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // A failed poll says nothing about the task — keep polling rather than resubmit and pay twice.
    const task = await request<Task>(`/v1/history/${id}`).catch(() => null);
    if (task?.status === "completed") {
      if (!task.result?.audio_url) throw new Error(`Genmax task ${id} hoàn tất nhưng không có audio_url`);
      return task.result.audio_url;
    }
    if (task?.status === "failed") throw new Error(`Genmax task ${id} lỗi: ${task.detail_error || task.error || "không rõ"}`);
    await sleep(POLL_MS);
  }
  throw new Error(`Genmax task ${id} quá ${TASK_TIMEOUT_MS / 1000}s chưa xong`);
}

/** Text → MP3 bytes. `speed` is a multiplier, clamped to what the provider accepts. */
export function genmaxSynthesize(text: string, voice: GenmaxVoice, speed = 1): Promise<Buffer> {
  return slots(async () => {
    const [min, max] = SPEED_RANGE[voice.provider];
    const { id } = await request<{ id: string }>(`/v1/text-to-speech/${encodeURIComponent(voice.voiceId)}`, {
      method: "POST",
      body: JSON.stringify({
        text,
        provider: voice.provider,
        model_id: voice.model,
        language_code: voice.language,
        voice_settings: { speed: Math.min(max, Math.max(min, speed)) },
      }),
    });
    const url = await waitForAudioUrl(id);
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Genmax không tải được audio (status ${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  });
}

interface VoicePage<T> {
  voice_list: T[];
  total: number;
}

// MiniMax's page 1 caps at 30 whatever page_size asks for, so a larger size skips voices.
const PAGE_SIZE = 30;

async function allPages<T>(path: string): Promise<T[]> {
  const fetchPage = (page: number) => request<VoicePage<T>>(`${path}?page=${page}&page_size=${PAGE_SIZE}`);
  const first = await fetchPage(1);
  const rest = Array.from({ length: Math.ceil(first.total / PAGE_SIZE) - 1 }, (_, i) => fetchPage(i + 2));
  return [first, ...(await Promise.all(rest))].flatMap((p) => p.voice_list);
}

async function listVoices(provider: GenmaxProvider): Promise<GenmaxVoiceInfo[]> {
  if (provider === "minimax") {
    const voices = await allPages<{ voice_id: string; voice_name: string; tag_list?: string[] }>("/v1/minimax/system-voices");
    return voices.map((v) => ({
      id: v.voice_id,
      name: v.voice_name,
      language: v.tag_list?.[0] || "English",
      gender: v.tag_list?.find((t) => t === "Male" || t === "Female") ?? "",
    }));
  }
  if (provider === "capcut") {
    const voices = await allPages<{ voice_id: string; name: string; language?: string; gender?: string }>("/v1/capcut/system-voices");
    return voices.map((v) => ({ id: v.voice_id, name: v.name, language: v.language || "en", gender: v.gender ?? "" }));
  }
  const { voices } = await request<{ voices: { voice_id: string; name: string; language?: string; gender?: string }[] }>("/v1/default-voices?page_size=100");
  return voices.map((v) => ({ id: v.voice_id, name: v.name, language: v.language || "en", gender: v.gender ?? "" }));
}

async function listModels(provider: GenmaxProvider): Promise<{ id: string; name: string }[]> {
  const query = provider === "elevenlabs" ? "" : `?provider=${provider}`;
  const models = await request<{ model_id: string; name: string; can_do_text_to_speech?: boolean }[]>(`/v1/models${query}`);
  return models.filter((m) => m.can_do_text_to_speech !== false).map((m) => ({ id: m.model_id, name: m.name }));
}

/** Every voice and model of one provider, de-duplicated across pages. */
export async function genmaxCatalog(provider: GenmaxProvider) {
  const [voices, models] = await Promise.all([listVoices(provider), listModels(provider)]);
  const unique = [...new Map(voices.map((v) => [v.id, v])).values()];
  return { voices: unique, models, defaultModel: DEFAULT_MODEL[provider] };
}

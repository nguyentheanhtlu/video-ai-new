import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { genmaxFromEnv, genmaxSynthesize, type GenmaxVoice } from "./genmax.js";

const ENV_KEYS = ["GENMAX_API_KEY", "TTS_ENGINE", "GENMAX_PROVIDER", "GENMAX_VOICE", "GENMAX_MODEL", "GENMAX_LANGUAGE"];
const voice: GenmaxVoice = { provider: "elevenlabs", voiceId: "abc", model: "m", language: "en" };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("genmaxFromEnv", () => {
  beforeEach(() => ENV_KEYS.forEach((k) => delete process.env[k]));
  afterEach(() => ENV_KEYS.forEach((k) => delete process.env[k]));

  it("stays on Edge until a key is entered", () => {
    expect(genmaxFromEnv()).toBeUndefined();
  });

  it("switches on with the key alone, speaking English", () => {
    process.env.GENMAX_API_KEY = "sk_test";
    expect(genmaxFromEnv()).toMatchObject({ provider: "minimax", language: "English" });
  });

  it("honours an explicit choice of Edge", () => {
    process.env.GENMAX_API_KEY = "sk_test";
    process.env.TTS_ENGINE = "edge";
    expect(genmaxFromEnv()).toBeUndefined();
  });
});

describe("genmaxSynthesize", () => {
  beforeEach(() => {
    process.env.GENMAX_API_KEY = "sk_test";
  });
  afterEach(() => {
    delete process.env.GENMAX_API_KEY;
    vi.unstubAllGlobals();
  });

  it("submits, polls through a failed poll, and downloads the audio", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ id: "t1", status: "pending" }))
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValueOnce(json({ status: "completed", result: { audio_url: "https://x/a.mp3" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal("fetch", fetchMock);

    const audio = await genmaxSynthesize("Hello", voice, 1.5);

    expect(audio).toEqual(Buffer.from([1, 2, 3]));
    expect(fetchMock).toHaveBeenCalledTimes(4); // one submit only — no double charge
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/v1\/text-to-speech\/abc$/);
    expect(init.headers["xi-api-key"]).toBe("sk_test");
    expect(JSON.parse(init.body).voice_settings.speed).toBe(1.2); // ElevenLabs maximum
  });

  it("reports a failed task", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json({ id: "t2" }))
      .mockResolvedValueOnce(json({ status: "failed", detail_error: "out of credits" })));
    await expect(genmaxSynthesize("Hello", voice)).rejects.toThrow(/out of credits/);
  });
});

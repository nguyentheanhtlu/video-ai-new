import "dotenv/config";

export type TtsProvider = "omnivoice";

export interface Config {
    ttsProvider: TtsProvider;

    // OmniVoice (local TTS server)
    omnivoiceEndpoint: string;

    ttsConcurrency: number;
}

function intDefault(name: string, def: number): number {
    const v = process.env[name];
    if (!v) return def;
    const n = parseInt(v, 10);
    if (isNaN(n))
        throw new Error(`Env var ${name} must be integer, got "${v}"`);
    return n;
}

export function loadConfig(): Config {
    const provider = (process.env.TTS_PROVIDER ?? "omnivoice") as TtsProvider;
    if (provider !== "omnivoice") {
        throw new Error(
            `TTS_PROVIDER must be "omnivoice", got "${provider}"`,
        );
    }

    return {
        ttsProvider: provider,
        omnivoiceEndpoint:
            process.env.OMNIVOICE_ENDPOINT ?? "http://127.0.0.1:8123",
        // Edge TTS is slow per new sentence (5–10s) but happy to work in parallel (sentences are split further server-side).
        ttsConcurrency: intDefault("TTS_CONCURRENCY", 6),
    };
}

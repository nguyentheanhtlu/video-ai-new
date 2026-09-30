import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import pLimit from "p-limit";
import { ensureFfmpegOnPath } from "../src/utils/ffmpeg-path.js";

ensureFfmpegOnPath();

// Local TTS server speaking the OmniVoice contract (POST /tts { text } → audio/mpeg),
// backed by Microsoft Edge TTS. Drop-in for OMNIVOICE_ENDPOINT — needs internet.

export interface VoiceSettings {
  voice: string;
  /** Relative speed, e.g. "+8%". */
  rate: string;
}

export function voiceFromEnv(): VoiceSettings {
  return {
    voice: process.env.EDGE_VOICE ?? "vi-VN-HoaiMyNeural",
    rate: process.env.EDGE_RATE ?? "+0%",
  };
}

const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function edgeSynthesize(text: string, voice: string): Promise<Buffer> {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
  try {
    const { audioStream } = tts.toStream(escapeXml(text));
    const chunks: Buffer[] = [];
    for await (const chunk of audioStream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  } finally {
    tts.close();
  }
}

/** Split narration at sentence ends (never mid-sentence, so prosody is unchanged). */
export function splitSentences(text: string, minLen = 70): string[] {
  const parts = text.match(/[^.!?…]+[.!?…]+["”)]*s*|[^.!?…]+$/g)?.map((p) => p.trim()).filter(Boolean) ?? [text];
  // Glue very short sentences to the previous one — tiny requests aren't worth a round trip.
  const out: string[] = [];
  for (const p of parts) {
    if (out.length && (out[out.length - 1].length < minLen / 2 || p.length < minLen / 2)) out[out.length - 1] += " " + p;
    else out.push(p);
  }
  return out;
}

/** Concatenate MP3 chunks and apply the speed change in one ffmpeg pass. */
async function finishAudio(chunks: Buffer[], tempo: number): Promise<Buffer> {
  if (chunks.length === 1 && Math.abs(tempo - 1) < 0.001) return chunks[0];
  const dir = await mkdtemp(join(tmpdir(), "tts-"));
  try {
    const files = await Promise.all(chunks.map(async (c, i) => {
      const p = join(dir, `${i}.mp3`);
      await writeFile(p, c);
      return p;
    }));
    const inputs = files.flatMap((p) => ["-i", p]);
    const concat = files.map((_, i) => `[${i}:a]`).join("") + `concat=n=${files.length}:v=0:a=1`;
    const filter = Math.abs(tempo - 1) > 0.001 ? `${concat},atempo=${tempo}` : concat;
    return await new Promise<Buffer>((resolve, reject) => {
      const proc = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", ...inputs,
        "-filter_complex", filter, "-b:a", "96k", "-f", "mp3", "pipe:1"], { windowsHide: true });
      const out: Buffer[] = [];
      let err = "";
      proc.stdout.on("data", (c: Buffer) => out.push(c));
      proc.stderr.on("data", (c: Buffer) => (err += c));
      proc.on("error", reject);
      proc.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg failed: ${err}`))));
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Edge closes the socket when the first audio byte isn't ready within ~3s, which
 * is common for new sentences when the service is busy. It keeps synthesising
 * server-side and caches the result, so polling with fresh connections gets it
 * once ready. A failed attempt received nothing, so a retry never truncates audio.
 */
// Edge throttles an IP that opens many sockets at once — cap concurrent attempts
// across all requests (scenes and their sentences share these slots).
const edgeSlots = pLimit(Number(process.env.EDGE_MAX_CONNECTIONS) || 3);

async function edgeWithRetry(text: string, voice: string): Promise<Buffer> {
  const delays = [0, 0, 300, 500, 800, 1000, 1500, 2000, 2000, 3000, 3000, 4000];
  for (let attempt = 0; ; attempt++) {
    try {
      const audio = await edgeSlots(() => edgeSynthesize(text, voice));
      if (audio.length === 0) throw new Error("empty audio from Edge TTS");
      return audio;
    } catch (e) {
      if (attempt >= delays.length) throw e;
      if (attempt >= 1) console.warn(`[tts] Edge đang tổng hợp, chờ thêm (lần ${attempt + 2}): "${text.slice(0, 40)}…"`);
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
}

/**
 * Text → MP3. Long narration is split into sentences synthesised in parallel
 * (each is ready sooner), then joined. Speed is applied with ffmpeg atempo because
 * Edge rejects non-default <prosody rate> ("+8%" → 1.08).
 */
export async function synthesize(text: string, settings: VoiceSettings): Promise<Buffer> {
  const parts = text.length > 90 ? splitSentences(text) : [text];
  const chunks = await Promise.all(parts.map((p) => edgeWithRetry(p, settings.voice)));
  const tempo = 1 + (parseFloat(settings.rate) || 0) / 100;
  return finishAudio(chunks, tempo);
}

export async function listEdgeVoices() {
  return new MsEdgeTTS().getVoices();
}

/** Start the HTTP server. `getSettings` is read per request so voice changes apply live. */
export function startTtsServer(
  endpoint: URL,
  getSettings: () => VoiceSettings = voiceFromEnv,
): Promise<Server> {
  const port = Number(endpoint.port || 8123);
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/plain" }).end(`ok ${getSettings().voice}`);
      return;
    }
    if (req.method !== "POST" || req.url !== "/tts") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let text: unknown;
      try {
        text = JSON.parse(body).text;
      } catch {
        /* handled below */
      }
      if (typeof text !== "string" || !text.trim()) {
        res.writeHead(400).end("body must be JSON { text: string }");
        return;
      }
      try {
        const audio = await synthesize(text, getSettings());
        res.writeHead(200, { "Content-Type": "audio/mpeg" }).end(audio);
        console.log(`[tts] ${audio.length}B ← "${text.slice(0, 60)}"`);
      } catch (e) {
        console.error("[tts] failed:", e);
        res.writeHead(502).end(String(e));
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, endpoint.hostname, () => resolve(server));
  });
}

// CLI: `npm run tts:server`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const endpoint = new URL(process.env.OMNIVOICE_ENDPOINT ?? "http://127.0.0.1:8123");
  const { voice, rate } = voiceFromEnv();
  startTtsServer(endpoint).then(
    () => console.log(`Edge TTS server (${voice}, rate ${rate}) on ${endpoint.origin}/tts`),
    (e: NodeJS.ErrnoException) => {
      if (e.code === "EADDRINUSE") {
        console.error(`Port ${endpoint.port} đang bị chiếm — có thể một tts:server khác (hoặc web UI) đang chạy. Dùng luôn nó, hoặc tắt nó đi.`);
        process.exit(1);
      }
      throw e;
    },
  );
}

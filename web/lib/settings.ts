import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ENV_FILE } from "./paths.js";

/** Keys the web UI may read/write in .env.local. */
export const SETTING_KEYS = [
  "EDGE_VOICE",
  "EDGE_RATE",
  "LLM_PROVIDER",
  "ANTHROPIC_API_KEY",
  "CLAUDE_MODEL",
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "CHANNEL_NAME",
  "CHANNEL_URL",
  "CHANNEL_HANDLE",
  "CHANNEL_TAGLINE",
  "BRAND_COLOR",
  "BRAND_ACCENT",
  "BRAND_LOGO",
  "SFX_MODE",
  "MAX_PARALLEL_JOBS",
  "RENDER_CONCURRENCY",
  "RENDER_WORKERS",
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

const SECRET_KEYS: SettingKey[] = ["ANTHROPIC_API_KEY", "GEMINI_API_KEY"];

export const DEFAULTS: Record<SettingKey, string> = {
  EDGE_VOICE: "vi-VN-HoaiMyNeural",
  EDGE_RATE: "+8%",
  LLM_PROVIDER: "gemini",
  ANTHROPIC_API_KEY: "",
  CLAUDE_MODEL: "claude-opus-5-5",
  GEMINI_API_KEY: "",
  GEMINI_MODEL: "gemini-flash-latest",
  CHANNEL_NAME: "AI Coding",
  CHANNEL_URL: "https://aicodingvn.vercel.app/",
  CHANNEL_HANDLE: "",
  CHANNEL_TAGLINE: "Tin nóng mỗi ngày",
  BRAND_COLOR: "#0e9f6e",
  BRAND_ACCENT: "#ffd400",
  BRAND_LOGO: "assets/logo.svg",
  SFX_MODE: "outro",
  MAX_PARALLEL_JOBS: "auto",
  RENDER_CONCURRENCY: "auto",
  RENDER_WORKERS: "auto",
};

export function getSetting(key: SettingKey): string {
  const v = process.env[key];
  return v !== undefined && v !== "" ? v : DEFAULTS[key];
}

/** Settings for the browser — secrets are masked, never echoed back. */
export function publicSettings() {
  const out: Record<string, string | boolean> = {};
  for (const k of SETTING_KEYS) {
    if (SECRET_KEYS.includes(k)) out[`${k}_SET`] = !!process.env[k];
    else out[k] = getSetting(k);
  }
  return out;
}

/**
 * Update .env.local in place (keeps comments/other keys) and process.env.
 * Empty string for a secret means "leave unchanged"; use null to clear it.
 */
export function updateSettings(patch: Partial<Record<SettingKey, string | null>>): void {
  let lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8").split(/\r?\n/) : [];
  for (const [key, raw] of Object.entries(patch) as [SettingKey, string | null][]) {
    if (!SETTING_KEYS.includes(key)) continue;
    if (SECRET_KEYS.includes(key) && raw === "") continue;
    const value = (raw ?? "").replace(/[\r\n]/g, "").trim();
    const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
    const line = `${key}=${value}`;
    if (idx >= 0) lines[idx] = line;
    else lines.push(line);
    process.env[key] = value;
  }
  lines = lines.filter((l, i) => l !== "" || i < lines.length - 1);
  writeFileSync(ENV_FILE, lines.join("\n") + "\n", "utf8");
}

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileToDataUri } from "./inline-assets.js";

/**
 * Channel identity — the parts of every news video that never change between
 * episodes (logo, name, colour, handle…). Configured once in .env.local and
 * injected into every template as the `__brand` variable, so neither the LLM
 * nor the per-scene inputs can drift from the channel's look.
 */
export interface Brand {
  name: string;
  handle: string;
  tagline: string;
  url: string;
  color: string;
  /** Highlight colour for *marked* words in the headline. */
  accent: string;
  /** data: URI of the logo (or "" to fall back to the channel initials). */
  logo: string;
  /** Publish date shown in the top bar, dd/mm/yyyy. */
  date: string;
  /** Source domain of the article, for the "Nguồn: …" credit. */
  source: string;
  /** Fixed on-screen words, in the language of the channel's scripts. */
  labels: { date: string; source: string; follow: string };
}

const HEX = /^#[0-9a-f]{6}$/i;

const LABELS = {
  vi: { date: "NGÀY ĐĂNG", source: "NGUỒN", follow: "Theo dõi ngay" },
  en: { date: "PUBLISHED", source: "SOURCE", follow: "Follow now" },
};

export function buildBrand(meta?: { source?: { domain?: string }; date?: string }, now = new Date()): Brand {
  const env = process.env;
  const logoPath = resolve(env.BRAND_LOGO || "assets/logo.svg");
  const color = env.BRAND_COLOR && HEX.test(env.BRAND_COLOR) ? env.BRAND_COLOR : "#0e9f6e";
  const accent = env.BRAND_ACCENT && HEX.test(env.BRAND_ACCENT) ? env.BRAND_ACCENT : "#ffd400";
  const p = (n: number) => String(n).padStart(2, "0");
  const domain = meta?.source?.domain && meta.source.domain !== "local" ? meta.source.domain : "";
  return {
    name: env.CHANNEL_NAME || "AI Coding",
    handle: env.CHANNEL_HANDLE || "",
    tagline: env.CHANNEL_TAGLINE || "Tin nóng mỗi ngày",
    url: env.CHANNEL_URL || "",
    color,
    accent,
    logo: existsSync(logoPath) ? fileToDataUri(logoPath) : "",
    date: meta?.date || `${p(now.getDate())}/${p(now.getMonth() + 1)}/${now.getFullYear()}`,
    source: domain.replace(/^www\./, ""),
    labels: LABELS[env.SCRIPT_LANGUAGE === "vi" ? "vi" : "en"],
  };
}

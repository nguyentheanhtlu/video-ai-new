import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { TEMPLATES_DIR } from "./paths.js";

export interface Slot {
  name: string;
  type: string;
  /** Max length parsed from "≤N" (chars for strings, lines/items for arrays). */
  max: number | null;
  limit: string;
  notes: string;
}

/** How a generated template tells a story, learned from its sample video. */
export interface TemplateStyle {
  structure?: string;
  hook?: string;
  tone?: string;
  pacing?: string;
  language?: string;
  /** The sample's script skeleton, in order: new content is poured into these parts. */
  outline?: { part: string; purpose?: string; pattern?: string; share?: number }[];
  durationSec?: number;
  avgShotSec?: number;
  sourceUrl?: string;
}

export interface TemplateInfo {
  id: string;
  name: string;
  /** Made from a sample video: covers every scene type and can be deleted. */
  generated: boolean;
  style?: TemplateStyle;
  /** Which scene types this template is meant for. */
  roles: ("hook" | "body" | "outro")[];
  role: string;
  bestFor: string;
  slots: Slot[];
  /** Sample inputs baked into the template (data-composition-variables). */
  defaults: Record<string, unknown>;
  aspects: string[];
  docs: string;
}

const ASPECT_FILES: Record<string, string> = {
  "9:16": "compositions/portrait.html",
  "16:9": "index.html",
};

const stripMd = (s: string) => s.replace(/\*\*|`/g, "");

const decodeEntities = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

function readDefaults(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  const html = readFileSync(file, "utf8");
  const m = html.match(/data-composition-variables='([^']*)'/) ?? html.match(/data-composition-variables="([^"]*)"/);
  if (!m) return {};
  try {
    return JSON.parse(decodeEntities(m[1]));
  } catch {
    return {};
  }
}

/** Split CATALOG.md into `## <id>` sections. */
function catalogSections(): Map<string, string> {
  const file = join(TEMPLATES_DIR, "CATALOG.md");
  const out = new Map<string, string>();
  if (!existsSync(file)) return out;
  // CATALOG.md is checked out with CRLF on Windows; normalise so "\n\n" paragraph splits work.
  const parts = readFileSync(file, "utf8").replace(/\r\n/g, "\n").split(/^## /m).slice(1);
  for (const p of parts) {
    const id = p.split(/\r?\n/)[0].trim();
    out.set(id, p.slice(id.length).trim().replace(/\n---\s*$/, "").trim());
  }
  return out;
}

function parseSlots(section: string): Slot[] {
  const slots: Slot[] = [];
  for (const line of section.split(/\r?\n/)) {
    const cells = line.split("|").map((c) => c.trim());
    // | `slot` | type | limit | notes |
    const m = cells[1]?.match(/^`([a-z_]+)`$/);
    if (!m || cells.length < 5) continue;
    const limit = cells[3] ?? "";
    const num = limit.match(/(\d+)/);
    slots.push({
      name: m[1],
      type: cells[2],
      limit,
      max: limit.includes("≤") && num ? Number(num[1]) : null,
      notes: cells[4] ?? "",
    });
  }
  return slots;
}

function rolesFor(id: string, roleText: string): TemplateInfo["roles"] {
  if (/outro/.test(id) || /^outro/i.test(roleText)) return ["outro"];
  const roles: TemplateInfo["roles"] = [];
  if (/hook/i.test(roleText)) roles.push("hook");
  if (/body/i.test(roleText) || roles.length === 0) roles.push("body");
  return roles;
}

let cache: { at: number; list: TemplateInfo[] } | null = null;

export function clearTemplateCache() {
  cache = null;
}

export function listTemplates(): TemplateInfo[] {
  if (cache && Date.now() - cache.at < 5000) return cache.list;
  const sections = catalogSections();
  const list: TemplateInfo[] = [];
  for (const id of readdirSync(TEMPLATES_DIR).sort()) {
    const dir = join(TEMPLATES_DIR, id);
    if (!statSync(dir).isDirectory() || !existsSync(join(dir, "index.html"))) continue;
    let name = id;
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
      name = (meta.name as string) ?? id;
    } catch {
      /* optional */
    }
    if (meta.generated) {
      list.push({
        id,
        name,
        generated: true,
        style: meta.style as TemplateStyle,
        role: (meta.summary as string) ?? "",
        bestFor: (meta.bestFor as string) ?? "",
        roles: ["hook", "body", "outro"],
        slots: (meta.slots as Slot[]) ?? [],
        defaults: {},
        aspects: (meta.aspects as string[]) ?? ["9:16"],
        docs: "",
      });
      continue;
    }
    const section = sections.get(id) ?? "";
    let defaults = readDefaults(join(dir, ASPECT_FILES["9:16"]));
    if (Object.keys(defaults).length === 0) defaults = readDefaults(join(dir, "index.html"));
    // "__"-prefixed variables are injected by the pipeline (brand, title…), not user slots.
    defaults = Object.fromEntries(Object.entries(defaults).filter(([k]) => !k.startsWith("__")));
    const role = section.match(/\*\*Role:\*\*\s*([\s\S]*?)(?:\n\*\*|\n\n|$)/)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
    const bestFor = section.match(/\*\*Best for:\*\*\s*([\s\S]*?)(?:\n\n|$)/)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
    list.push({
      id,
      name,
      generated: false,
      role: stripMd(role),
      bestFor: stripMd(bestFor),
      roles: rolesFor(id, role),
      slots: parseSlots(section),
      defaults,
      aspects: Object.entries(ASPECT_FILES)
        .filter(([, f]) => existsSync(join(dir, f)))
        .map(([a]) => a),
      docs: section,
    });
  }
  cache = { at: Date.now(), list };
  return list;
}

export function getTemplate(id: string): TemplateInfo | undefined {
  return listTemplates().find((t) => t.id === id);
}

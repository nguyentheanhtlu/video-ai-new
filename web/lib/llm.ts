import Anthropic from "@anthropic-ai/sdk";
import axios from "axios";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Article } from "./article.js";
import type { ProjectImage } from "./images.js";
import { ROOT, TEMPLATES_DIR } from "./paths.js";
import { validateScript, type Script } from "./projects.js";
import { getSetting } from "./settings.js";

export interface GenerateOptions {
  /** "short" ≈ 4–6 scenes (~30–45s), "standard" = skill default 8–12 scenes (~90–120s). */
  length: "short" | "standard";
  aspect: "9:16" | "16:9";
  channel: string;
  channelUrl: string;
  extraInstructions?: string;
}

type Turn = { role: "user" | "assistant"; text: string };

/**
 * System prompt = the skill's own content rules (template map, TTS number rules,
 * self-check) + the full template catalog, so web and /create-template-video
 * produce scripts by the same rules.
 */
function systemPrompt(): string {
  const skill = readFileSync(join(ROOT, ".claude", "skills", "create-template-video", "SKILL.md"), "utf8");
  const rules = skill.slice(skill.indexOf("### Step 4"), skill.indexOf("### Step 7")).trim();
  const catalog = readFileSync(join(TEMPLATES_DIR, "CATALOG.md"), "utf8");
  return [
    "Bạn là biên tập viên viết kịch bản video tin tức ngắn tiếng Việt. Nhiệm vụ: đọc bài báo người dùng gửi và viết `script.json` cho pipeline render template HyperFrames.",
    "Chỉ trả về MỘT object JSON hợp lệ (không markdown, không giải thích). Các bước về WebFetch/Write/Bash trong quy tắc dưới đây do hệ thống lo — bạn chỉ viết JSON.",
    "",
    "# Quy tắc viết kịch bản",
    rules,
    "",
    "# Danh mục template (templates/CATALOG.md)",
    catalog,
  ].join("\n");
}

function userPrompt(article: Article, o: GenerateOptions, images: ProjectImage[]): string {
  const len =
    o.length === "short"
      ? "Video NGẮN: 5–7 scene (1 hook + 3–5 body + 1 outro), tổng voiceText ~120–180 từ (~40–60 giây)."
      : "Video CHUẨN: 8–12 scene, tổng voiceText ~250–350 từ (~80–120 giây).";
  const imgList = images.length
    ? images.map((im) => `- ${im.file} (${im.width}x${im.height})${im.caption ? ` — chú thích gốc: "${im.caption}"` : ""}`).join("\n")
    : "(không có ảnh — bỏ trống image, khung sẽ dùng nền màu kênh)";
  return [
    `Độ dài: ${len}`,
    `aspect: "${o.aspect}"`,
    `Tên kênh (metadata.channel, brand, footer, outro brand_name): "${o.channel}"`,
    `URL kênh (outro primary_url): "${o.channelUrl}"`,
    o.extraInstructions ? `Yêu cầu thêm của người dùng: ${o.extraInstructions}` : "",
    "",
    "Ảnh của bài đã tải về (CHỈ dùng đúng các đường dẫn này; gán cho scene có nội dung khớp chú thích — mỗi ảnh tối đa 2 scene, không bắt buộc scene nào cũng có ảnh bài vì hệ thống sẽ tự tìm thêm theo imageQuery):",
    imgList,
    "",
    `Nguồn: ${article.url || "(văn bản dán tay)"} — domain: ${article.domain}`,
    `Tiêu đề: ${article.title}`,
    "Nội dung:",
    article.content,
  ].join("\n");
}

function extractJson(raw: string): unknown {
  const s = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("LLM không trả về JSON");
  return JSON.parse(s.slice(start, end + 1));
}

// Models that accept adaptive thinking + server-side refusal fallback ("default").
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

async function callClaude(system: string, turns: Turn[], _log: (line: string) => void): Promise<string> {
  const apiKey = getSetting("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("Chưa nhập ANTHROPIC_API_KEY trong Cài đặt.");
  const client = new Anthropic({ apiKey });
  const model = getSetting("CLAUDE_MODEL");
  const isHaiku = model.startsWith("claude-haiku");
  const stream = client.beta.messages.stream({
    model,
    max_tokens: 64000,
    system,
    messages: turns.map((t) => ({ role: t.role, content: t.text })),
    ...(isHaiku ? {} : { thinking: { type: "adaptive" as const }, output_config: { effort: "medium" as const } }),
    ...(FALLBACK_MODELS.has(model)
      ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
      : {}),
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") throw new Error("Claude từ chối yêu cầu này (refusal).");
  if (msg.stop_reason === "max_tokens") throw new Error("Claude hết max_tokens trước khi viết xong kịch bản.");
  return msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

// Tried in order when the chosen model is overloaded (free tier returns 503 at peak times).
const GEMINI_FALLBACKS = ["gemini-2.5-flash", "gemini-flash-lite-latest"];
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callGemini(system: string, turns: Turn[], log: (line: string) => void): Promise<string> {
  const apiKey = getSetting("GEMINI_API_KEY");
  if (!apiKey) throw new Error("Chưa nhập GEMINI_API_KEY trong Cài đặt (lấy miễn phí tại https://aistudio.google.com/apikey).");
  const models = [...new Set([getSetting("GEMINI_MODEL"), ...GEMINI_FALLBACKS])];
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: turns.map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.text }] })),
    generationConfig: { responseMimeType: "application/json", temperature: 0.7 },
  };

  let lastError = "";
  for (const model of models) {
    for (const delay of [0, 3000, 8000]) {
      if (delay) {
        log(`  Gemini quá tải, thử lại ${model} sau ${delay / 1000}s...`);
        await sleep(delay);
      }
      let res;
      try {
        res = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
          body,
          { headers: { "x-goog-api-key": apiKey }, timeout: 180000, validateStatus: () => true },
        );
      } catch (e) {
        lastError = `không kết nối được Gemini (${(e as Error).message})`;
        continue;
      }
      if (res.status === 200) {
        const cand = res.data?.candidates?.[0];
        const text = (cand?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
        if (!text) throw new Error(`Gemini không trả nội dung (finishReason: ${cand?.finishReason ?? "?"})`);
        if (model !== models[0]) log(`  ✓ Đã dùng model dự phòng ${model}`);
        return text;
      }
      lastError = `Gemini lỗi ${res.status} (${model}): ${res.data?.error?.message ?? JSON.stringify(res.data).slice(0, 300)}`;
      if (!RETRYABLE.has(res.status)) throw new Error(lastError);
    }
    log(`  ${model} vẫn quá tải — chuyển sang model khác`);
  }
  throw new Error(`${lastError}
Tất cả model Gemini đều đang quá tải — thử lại sau ít phút, hoặc chuyển sang Claude trong Cài đặt.`);
}

/** Fill fields the model shouldn't have to guess, then validate. */
function normalize(raw: unknown, article: Article, o: GenerateOptions, images: ProjectImage[]): Script {
  const s = raw as Script;
  s.version = "1.0";
  s.renderer = "hyperframes";
  s.aspect = o.aspect;
  s.voice = { provider: "omnivoice", speed: 1.0 };
  s.metadata = {
    title: s.metadata?.title || article.title,
    source: { url: article.url, domain: article.domain, image: article.image },
    channel: o.channel,
  };
  // Keep only photos that were really downloaded; the channel uses exactly two templates.
  const known = new Set(images.map((im) => im.file));
  const n = (s.scenes ?? []).length;
  s.scenes = (s.scenes ?? []).map((sc, i) => {
    const inputs: Record<string, unknown> = { ...(sc.inputs ?? {}) };
    if (typeof inputs.image === "string" && !known.has(inputs.image)) delete inputs.image;
    if (Array.isArray(inputs.images)) {
      const ok = inputs.images.filter((p) => typeof p === "string" && known.has(p)).slice(0, 3);
      if (ok.length) inputs.images = ok;
      else delete inputs.images;
    }
    const isOutro = sc.type === "outro" || i === n - 1;
    return {
      ...sc,
      id: String(sc.id ?? `scene-${i + 1}`),
      templateId: isOutro ? "news-outro" : "news-frame",
      inputs,
    };
  });
  return s;
}

export async function generateScript(
  article: Article,
  o: GenerateOptions,
  log: (line: string) => void,
  images: ProjectImage[] = [],
): Promise<Script> {
  const provider = getSetting("LLM_PROVIDER") === "claude" ? "claude" : "gemini";
  const call = provider === "claude" ? callClaude : callGemini;
  const model = getSetting(provider === "claude" ? "CLAUDE_MODEL" : "GEMINI_MODEL");
  const system = systemPrompt();
  const turns: Turn[] = [{ role: "user", text: userPrompt(article, o, images) }];

  for (let attempt = 1; attempt <= 3; attempt++) {
    log(`Gọi ${provider} (${model}) viết kịch bản${attempt > 1 ? ` — sửa lần ${attempt - 1}` : ""}...`);
    const reply = await call(system, turns, log);
    let problems: string[];
    try {
      const script = normalize(extractJson(reply), article, o, images);
      problems = validateScript(script);
      if (problems.length === 0) {
        log(`✓ Kịch bản hợp lệ: ${script.scenes.length} scene`);
        return script;
      }
    } catch (e) {
      problems = [(e as Error).message];
    }
    log(`Kịch bản chưa hợp lệ: ${problems.slice(0, 5).join("; ")}`);
    turns.push({ role: "assistant", text: reply });
    turns.push({
      role: "user",
      text: `JSON chưa hợp lệ:\n- ${problems.join("\n- ")}\nHãy sửa và trả lại TOÀN BỘ object JSON.`,
    });
  }
  throw new Error("LLM không viết được kịch bản hợp lệ sau 3 lần thử.");
}

import Anthropic from "@anthropic-ai/sdk";
import axios from "axios";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Article } from "./article.js";
import type { ProjectImage } from "./images.js";
import { ROOT, TEMPLATES_DIR } from "./paths.js";
import { validateScript, type Script } from "./projects.js";
import { getSetting } from "./settings.js";
import { getTemplate, type TemplateInfo } from "./templates.js";

export interface GenerateOptions {
  /**
   * "short" ≈ 4–6 scenes (~30–45s), "standard" = skill default 8–12 scenes (~90–120s),
   * "sample" = as long as the template's sample video.
   */
  length: "short" | "standard" | "sample";
  aspect: "9:16" | "16:9";
  channel: string;
  channelUrl: string;
  extraInstructions?: string;
  /** Template generated from a sample video; every scene uses it. Omit for the news frame. */
  templateId?: string;
}

/** `images` are base64 JPEGs shown to the model along with the text. */
export type Turn = { role: "user" | "assistant"; text: string; images?: string[] };

/**
 * System prompt = the skill's own content rules (template map, TTS number rules,
 * self-check) + the full template catalog, so web and /create-template-video
 * produce scripts by the same rules.
 */
function styleRules(tpl: TemplateInfo): string[] {
  const s = tpl.style ?? {};
  return [
    "",
    `# TEMPLATE MẪU: ${tpl.id}`,
    `Quy tắc này ghi đè các quy định về template ở trên. Dùng "templateId": "${tpl.id}" cho MỌI scene, kể cả hook và outro; template này không dùng news-frame hay news-outro. Slot: image, images, caption, headline, và cta (chữ nút ở scene outro, ≤24 ký tự).`,
    `Viết kịch bản theo đúng phong cách của video mẫu, nhưng bằng nội dung của người dùng; giữ nguyên các thông tin trong văn bản họ đưa, không thêm dữ kiện mới.`,
    s.structure ? `- Cấu trúc: ${s.structure}` : "",
    s.hook ? `- Mở đầu: ${s.hook}` : "",
    s.tone ? `- Giọng văn: ${s.tone}` : "",
    s.pacing ? `- Nhịp: ${s.pacing}` : "",
    ...(s.outline?.length
      ? [
          "",
          "## Khung kịch bản BẮT BUỘC",
          "Điền nội dung của người dùng vào đúng các đoạn dưới đây, đúng thứ tự, dùng mẫu câu tương tự và chia thời lượng theo tỉ lệ đã cho. Mỗi đoạn là một hoặc nhiều scene. Điền [chỗ trống] bằng thông tin thật; nếu nội dung không có dữ kiện cho đoạn nào thì viết ngắn lại thay vì tự chế.",
          ...s.outline.map((o, i) => `${i + 1}. ${o.part}${o.share ? ` (~${o.share}%)` : ""}${o.purpose ? ` — ${o.purpose}` : ""}${o.pattern ? `\n   Mẫu câu: ${o.pattern}` : ""}`),
        ]
      : []),
  ].filter(Boolean);
}

function systemPrompt(tpl?: TemplateInfo): string {
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
    ...(tpl ? styleRules(tpl) : []),
    ...(getSetting("SCRIPT_LANGUAGE") === "en"
      ? [
          "",
          "# NGÔN NGỮ BẮT BUỘC: TIẾNG ANH",
          "Quy tắc này ghi đè mọi quy định về tiếng Việt ở trên. Viết TOÀN BỘ lời đọc (voiceText), tiêu đề và mọi chữ hiển thị trên video bằng tiếng Anh tự nhiên, kể cả khi bài báo gốc là tiếng Việt. Viết số và ký hiệu theo cách đọc tiếng Anh để giọng đọc phát âm đúng. Giữ nguyên tên key JSON và tên template.",
        ]
      : []),
  ].join("\n");
}

/** Narration length matching the sample video, at roughly 2.6 spoken words per second. */
function sampleLength(sec: number): string {
  const words = Math.max(40, Math.round(sec * 2.6));
  const scenes = Math.min(12, Math.max(3, Math.round(sec / 8)));
  return `Video THEO MẪU: khoảng ${scenes} scene (1 hook + body + 1 outro), tổng voiceText ~${words} từ (~${Math.round(sec)} giây, bằng video mẫu).`;
}

function lengthRule(o: GenerateOptions, tpl?: TemplateInfo): string {
  if (o.length === "sample" && tpl?.style?.durationSec) return sampleLength(tpl.style.durationSec);
  return o.length === "short"
    ? "Video NGẮN: 5–7 scene (1 hook + 3–5 body + 1 outro), tổng voiceText ~120–180 từ (~40–60 giây)."
    : "Video CHUẨN: 8–12 scene, tổng voiceText ~250–350 từ (~80–120 giây).";
}

function userPrompt(article: Article, o: GenerateOptions, images: ProjectImage[], tpl?: TemplateInfo): string {
  const len = lengthRule(o, tpl);
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
    messages: turns.map((t) => ({
      role: t.role,
      content: t.images?.length
        ? [
            ...t.images.map((data) => ({ type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data } })),
            { type: "text" as const, text: t.text },
          ]
        : t.text,
    })),
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
    contents: turns.map((t) => ({
      role: t.role === "assistant" ? "model" : "user",
      parts: [...(t.images ?? []).map((data) => ({ inlineData: { mimeType: "image/jpeg", data } })), { text: t.text }],
    })),
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
function normalize(raw: unknown, article: Article, o: GenerateOptions, images: ProjectImage[], tpl?: TemplateInfo): Script {
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
      templateId: tpl?.id ?? (isOutro ? "news-outro" : "news-frame"),
      inputs,
    };
  });
  return s;
}

const activeModel = () => {
  const provider = getSetting("LLM_PROVIDER") === "claude" ? "claude" : "gemini";
  return {
    provider,
    call: provider === "claude" ? callClaude : callGemini,
    model: getSetting(provider === "claude" ? "CLAUDE_MODEL" : "GEMINI_MODEL"),
  };
};

/** One JSON round-trip with the configured model; `reply` is the raw text for follow-up turns. */
export async function generateJson(system: string, turns: Turn[], log: (line: string) => void) {
  const { call } = activeModel();
  const reply = await call(system, turns, log);
  return { value: extractJson(reply), reply };
}

/** Cut a finished script into scenes at sentence ends; the words themselves never change. */
export function splitIntoScenes(text: string): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  const words = clean.split(" ");
  const count = Math.min(12, Math.max(3, Math.round(words.length / 35)));
  let sentences = clean.match(/[^.!?…]+[.!?…]+["”)]*|[^.!?…]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [clean];
  if (sentences.length < 3) {
    // Too few sentences to make the three scenes a script needs: fall back to equal runs of words.
    const size = Math.ceil(words.length / 3);
    sentences = [0, 1, 2].map((i) => words.slice(i * size, (i + 1) * size).join(" ")).filter(Boolean);
  }
  const target = clean.length / count;
  const scenes: string[] = [];
  let current = "";
  sentences.forEach((sentence, i) => {
    current = current ? `${current} ${sentence}` : sentence;
    const left = sentences.length - i - 1;
    if (left === 0 || current.length >= target || left <= count - scenes.length - 1) {
      scenes.push(current);
      current = "";
    }
  });
  return scenes;
}

/** Use the user's script word for word; the AI only titles it and suggests photo searches. */
export async function scriptFromText(text: string, o: GenerateOptions, log: (line: string) => void): Promise<Script> {
  const tpl = o.templateId ? getTemplate(o.templateId) : undefined;
  if (o.templateId && !tpl) throw new Error(`Không có template "${o.templateId}"`);
  const parts = splitIntoScenes(text);
  if (parts.length < 3) throw new Error("Kịch bản quá ngắn: cần đủ nội dung cho ít nhất 3 cảnh.");
  log(`Giữ nguyên kịch bản: chia thành ${parts.length} cảnh`);
  const system = `Người dùng đã có kịch bản video chia sẵn thành các cảnh. KHÔNG viết lại lời. Chỉ trả về JSON:
{ "title": "tiêu đề hiển thị 40-110 ký tự, cùng ngôn ngữ với kịch bản, đánh dấu 1 cụm từ khoá bằng *...*", "imageQueries": ["3-7 từ khoá cụ thể để tìm ảnh minh hoạ cho từng cảnh"], "cta": "chữ nút kêu gọi ≤24 ký tự" }
imageQueries phải có đúng ${parts.length} phần tử, theo thứ tự cảnh.`;
  let reply: { title?: string; imageQueries?: string[]; cta?: string } = {};
  try {
    reply = (await generateJson(system, [{ role: "user", text: parts.map((p, i) => `Cảnh ${i + 1}: ${p}`).join("\n") }], log)).value as typeof reply;
  } catch (e) {
    log(`AI không đặt được tiêu đề (${(e as Error).message}), dùng câu đầu kịch bản`);
  }
  const last = parts.length - 1;
  const script: Script = {
    version: "1.0",
    renderer: "hyperframes",
    aspect: o.aspect,
    metadata: {
      title: reply.title?.trim() || parts[0].slice(0, 100),
      source: { url: "", domain: "local", image: null },
      channel: o.channel,
    },
    voice: { provider: "omnivoice", speed: 1.0 },
    scenes: parts.map((voiceText, i) => ({
      id: i === 0 ? "hook" : i === last ? "outro" : `body-${i}`,
      type: i === 0 ? "hook" : i === last ? "outro" : "body",
      voiceText,
      templateId: tpl?.id ?? (i === last ? "news-outro" : "news-frame"),
      inputs: i === last && reply.cta ? { cta: reply.cta } : {},
      imageQuery: reply.imageQueries?.[i] || voiceText.slice(0, 60),
    })),
  };
  const problems = validateScript(script);
  if (problems.length) throw new Error(`Kịch bản chưa hợp lệ: ${problems.join("; ")}`);
  return script;
}

export async function generateScript(
  article: Article,
  o: GenerateOptions,
  log: (line: string) => void,
  images: ProjectImage[] = [],
): Promise<Script> {
  const { provider, call, model } = activeModel();
  const tpl = o.templateId ? getTemplate(o.templateId) : undefined;
  if (o.templateId && !tpl) throw new Error(`Không có template "${o.templateId}"`);
  const system = systemPrompt(tpl);
  const turns: Turn[] = [{ role: "user", text: userPrompt(article, o, images, tpl) }];

  for (let attempt = 1; attempt <= 3; attempt++) {
    log(`Gọi ${provider} (${model}) viết kịch bản${attempt > 1 ? ` — sửa lần ${attempt - 1}` : ""}...`);
    const reply = await call(system, turns, log);
    let problems: string[];
    try {
      const script = normalize(extractJson(reply), article, o, images, tpl);
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

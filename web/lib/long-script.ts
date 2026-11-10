import pLimit from "p-limit";
import { z } from "zod";
import { SlideshowScriptSchema, type SlideshowScript } from "../../src/render/template-script-schema.js";
import type { Article } from "./article.js";
import type { Channel } from "./channels.js";
import type { ProjectImage } from "./images.js";
import { generateJson } from "./llm.js";
import { todayVN } from "./projects.js";
import { styleOverride } from "./script-styles.js";

/**
 * Long-form (5–15 min) script in two passes, so a 10-minute video stays
 * structured instead of drifting: 1) an outline of chapters with the facts each
 * covers, 2) every chapter written into scenes, in parallel, against that outline.
 */

/** Spoken words per second: Vietnamese counts syllables, so it runs faster. */
export const WORDS_PER_SEC = { vi: 3.5, en: 2.5 } as const;

export interface LongOptions {
  channel: Channel;
  minutes: number;
  extraInstructions?: string;
  /** Topic / angle typed by the user (with or without source links). */
  prompt?: string;
  /** Script style (news, affiliate, review…); defaults to the channel's. */
  scriptStyle?: string;
}

const Outline = z.object({
  title: z.string().min(5),
  description: z.string().default(""),
  tags: z.array(z.string()).default([]),
  chapters: z
    .array(z.object({ title: z.string().min(1), points: z.array(z.string()).default([]), words: z.number().optional() }))
    .min(3),
  outro: z.string().min(5),
  /** One look for every AI image of the video, so the pictures feel like one piece. */
  visualStyle: z.string().default(""),
});
type OutlineT = z.infer<typeof Outline>;

const ChapterScenes = z.object({
  scenes: z
    .array(
      z.object({
        voiceText: z.string().min(5),
        visual: z.enum(["photo", "video", "ai"]).catch("photo"),
        imageQuery: z.string().default(""),
        videoQuery: z.string().default(""),
        imagePrompts: z.array(z.string()).default([]),
        image: z.string().optional(),
      }),
    )
    .min(1),
});

const LANG_RULES = {
  vi: [
    "Ngôn ngữ: TIẾNG VIỆT tự nhiên, như người dẫn chương trình YouTube kể chuyện.",
    "Lời đọc dành cho máy đọc (TTS): viết số bằng chữ (\"hai mươi tám\", \"năm 2024\" → \"năm hai nghìn không trăm hai mươi tư\"), không ký hiệu (% → \"phần trăm\", & → \"và\"), không emoji, không URL, không viết tắt khó đọc.",
  ],
  en: [
    "Language: natural ENGLISH, like an engaging YouTube narrator — even when the sources are in Vietnamese (translate names of places/organisations where an English name exists).",
    "Narration is read by TTS: write numbers and symbols the way they are spoken (\"28 percent\" → \"twenty-eight percent\"), no emoji, no URLs, no hard abbreviations.",
  ],
};

function sourceBlock(articles: Article[], maxChars = 45000, brief = false): string {
  if (brief) {
    if (!articles.length) return "(Không có tài liệu tham khảo — viết hoàn toàn theo ý tưởng của kênh.)";
    const per = Math.floor(maxChars / articles.length);
    return [
      "## TÀI LIỆU THAM KHẢO (không bắt buộc — chỉ lấy chi tiết nào giúp ý tưởng của kênh hay hơn; KHÔNG đi theo nội dung hay bố cục của nó)",
      ...articles.map((a, i) => `### Tham khảo ${i + 1}: ${a.title}\n${a.url || "(văn bản dán tay)"}\n${a.content.slice(0, per)}`),
    ].join("\n\n");
  }
  if (!articles.length) return "(Không có bài nguồn — dựa vào chủ đề người dùng đưa. Chỉ nêu kiến thức phổ biến, chắc chắn; KHÔNG bịa số liệu, trích dẫn, ngày tháng cụ thể.)";
  const per = Math.floor(maxChars / articles.length);
  return articles
    .map((a, i) => `### Nguồn ${i + 1}: ${a.title}\n${a.url || "(văn bản dán tay)"}\n${a.content.slice(0, per)}`)
    .join("\n\n");
}

/**
 * The user's own brief comes first and wins: it sets the angle, focus and
 * structure; the sources only supply facts for it. (Listed as one line among
 * the channel info, the model used to follow the article's structure instead.)
 */
function briefBlock(o: LongOptions): string {
  if (!o.prompt) return "";
  return [
    "## Ý TƯỞNG CỦA KÊNH — VIẾT THEO ĐÚNG Ý TƯỞNG NÀY",
    o.prompt,
    "",
    "→ Đây là nội dung video. Ý tưởng quyết định câu chuyện, trọng tâm, góc nhìn, bố cục và giọng; nếu nêu số chương, thứ tự ý, độ dài, giọng điệu hay điều cần tránh thì làm ĐÚNG như vậy.",
    "→ Tự phát triển ý tưởng bằng kiến thức của bạn. Tài liệu tham khảo (nếu có) chỉ để lấy thêm chi tiết khi hữu ích — không bắt buộc dùng, không đi theo nó.",
    "",
  ].join("\n");
}

function channelBlock(o: LongOptions): string {
  return [
    briefBlock(o),
    `Kênh: "${o.channel.name}"${o.channel.niche ? ` — chủ đề & phong cách: ${o.channel.niche}` : ""}`,
    o.extraInstructions ? `Yêu cầu thêm: ${o.extraInstructions}` : "",
  ].filter(Boolean).join("\n");
}

async function makeOutline(articles: Article[], o: LongOptions, totalWords: number, log: (l: string) => void): Promise<OutlineT> {
  const lang = o.channel.language;
  const nCh = Math.min(12, Math.max(4, Math.round(o.minutes * 0.9)));
  const system = [
    o.prompt
      ? "Bạn là biên tập viên trưởng của một kênh YouTube video dài (khung ngang 16:9). Nhiệm vụ: lên DÀN Ý cho một video THEO Ý TƯỞNG CỦA KÊNH (không phải tóm tắt tài liệu)."
      : "Bạn là biên tập viên trưởng của một kênh YouTube video dài (khung ngang 16:9). Nhiệm vụ: lên DÀN Ý cho một video từ các nguồn được đưa.",
    "Chỉ trả về MỘT object JSON hợp lệ, không markdown.",
    ...LANG_RULES[lang],
    ...styleOverride(o.scriptStyle ?? o.channel.scriptStyle),
    "",
    "Quy tắc nội dung:",
    o.prompt
      ? "- Video đi theo Ý TƯỞNG CỦA KÊNH: mọi chương phục vụ ý tưởng; tiêu đề, mở đầu, kết luận xoay quanh đúng ý tưởng đó. Tự do phát triển bằng kiến thức chung, phân tích, cảm xúc, liên hệ; chỉ tránh bịa số liệu, ngày tháng hay câu nói cụ thể gán cho người thật."
      : "- Chỉ dùng dữ kiện có trong nguồn. Khi nguồn ngắn, mở rộng bằng bối cảnh, giải thích, so sánh, ý nghĩa, câu hỏi mở — KHÔNG bịa số liệu, trích dẫn, tên người.",
    "- Chương đầu là phần mở (hook mạnh trong 15 giây đầu: vấn đề / điều bất ngờ / câu hỏi), chương cuối là tổng kết + nhận định.",
    "- Mỗi chương có 2–5 ý cụ thể (points), không trùng ý giữa các chương.",
    "- title: tiêu đề YouTube hấp dẫn, ≤ 90 ký tự, đúng sự thật, có thể đánh dấu 1 cụm từ khoá bằng *...*.",
    "- description: 2–4 câu mô tả video cho YouTube (không chèn link). tags: 6–12 tag tìm kiếm.",
    "- outro: 1–2 câu kết, mời người xem đăng ký kênh và bình luận ý kiến.",
    "- visualStyle: 1 câu TIẾNG ANH mô tả phong cách hình ảnh chung cho cả video, hợp chủ đề (vd \"photorealistic documentary photography, natural light, muted cinematic colour grade\").",
    "",
    `Schema: { "title": string, "description": string, "tags": string[], "chapters": [{ "title": "≤ 50 ký tự", "points": string[], "words": number }], "outro": string, "visualStyle": string }`,
  ].join("\n");
  const user = [
    channelBlock(o),
    `Độ dài mục tiêu: ~${o.minutes} phút ≈ ${totalWords} từ lời đọc, chia thành ${nCh} chương (trường "words" của các chương cộng lại ≈ ${totalWords}).`,
    "",
    sourceBlock(articles, 45000, !!o.prompt),
  ].join("\n");
  let lastErr = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { value } = await generateJson(system, [{ role: "user", text: attempt === 1 ? user : `${user}\n\nLần trước JSON lỗi: ${lastErr}. Trả lại đúng schema.` }], log);
    const r = Outline.safeParse(value);
    if (r.success) return r.data;
    lastErr = r.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    log(`  Dàn ý chưa hợp lệ (${lastErr}) — thử lại`);
  }
  throw new Error(`AI không lập được dàn ý: ${lastErr}`);
}

async function writeChapter(
  idx: number,
  outline: OutlineT,
  articles: Article[],
  images: ProjectImage[],
  o: LongOptions,
  log: (l: string) => void,
) {
  const lang = o.channel.language;
  const ch = outline.chapters[idx];
  const words = ch.words && ch.words > 40 ? ch.words : Math.round((o.minutes * 60 * WORDS_PER_SEC[lang]) / outline.chapters.length);
  const sceneWords = lang === "vi" ? "35–55" : "25–40";
  const system = [
    "Bạn là người viết lời dẫn cho video YouTube dài. Viết lời đọc cho MỘT chương, chia thành các cảnh (scene) ngắn.",
    "Chỉ trả về MỘT object JSON hợp lệ, không markdown.",
    ...LANG_RULES[lang],
    ...styleOverride(o.scriptStyle ?? o.channel.scriptStyle),
    "",
    "Quy tắc:",
    `- Mỗi scene 2–3 câu, ${sceneWords} từ, kết thúc bằng dấu . ? hoặc !. Câu ngắn gọn, dễ nghe, có nhịp.`,
    o.prompt
      ? "- Bám đúng các ý của chương và Ý TƯỞNG CỦA KÊNH; tự phát triển bằng kiến thức của bạn, tài liệu tham khảo chỉ dùng khi giúp ích; không lặp lại ý của chương khác; không bịa số liệu, ngày tháng hay câu nói cụ thể gán cho người thật."
      : "- Bám đúng các ý của chương; chỉ dùng dữ kiện trong nguồn; không lặp lại ý của chương khác.",
    idx === 0
      ? "- Đây là chương MỞ ĐẦU: câu đầu tiên phải là hook gây tò mò ngay lập tức. Không chào hỏi dài dòng."
      : `- Câu đầu chương chuyển ý tự nhiên từ chương trước ("${outline.chapters[idx - 1].title}"). Không chào hỏi lại, không tóm tắt lại video.`,
    idx === outline.chapters.length - 1 ? "- Đây là chương CUỐI: tổng kết và đưa nhận định; KHÔNG viết lời kêu gọi đăng ký (đã có phần outro riêng)." : "",
    ...(o.channel.visuals === "ai"
      ? [
          "- visual: \"photo\" khi cảnh nói về NGƯỜI THẬT, sự kiện, địa điểm CỤ THỂ có tên trong câu chuyện (phải dùng ảnh thật, AI không được vẽ người thật); \"ai\" khi cảnh có thể minh hoạ bằng hình vẽ AI không cần người thật cụ thể (bối cảnh, khái niệm, không khí, đồ vật, đám đông vô danh, minh hoạ ý).",
          "- imageQuery: 3–7 từ khoá tìm ảnh thật cho cảnh (tên riêng, sự kiện; viết bằng ngôn ngữ của nguồn).",
          `- imagePrompts: ${"1–2"} prompt TIẾNG ANH cho ảnh AI (cảnh dài trên 10 giây thì 2 prompt khác góc nhìn). Viết cho MỌI cảnh, kể cả cảnh photo (dùng khi không tìm được ảnh thật — khi đó tả bối cảnh, không tả người thật). Mỗi prompt phải thể hiện ĐÚNG điều lời đọc của cảnh đang nói, cụ thể: chủ thể, hành động, bối cảnh, thời điểm, ánh sáng, góc máy (vd \"wide shot of an empty football stadium at night under floodlights, rain falling, low angle\"). Không chữ, không logo, không người nổi tiếng thật, không cờ/đồng phục cụ thể nếu không chắc.`,
          "  + TUYỆT ĐỐI KHÔNG đưa vào imagePrompts: tên người thật (cầu thủ, HLV, chính trị gia… → viết \"a football player in a red kit\"); bất cứ thứ gì có chữ hay số để đọc (bảng tỉ số, băng rôn có chữ, tiêu đề báo, màn hình có chữ, áo in tên). Thay vào đó tả không khí, hành động, bối cảnh, cảm xúc đúng với lời đọc.",
        ]
      : [
          "- visual: \"photo\" khi cảnh nói về người, sự kiện, địa điểm CỤ THỂ trong câu chuyện (cần ảnh thật); \"video\" khi nói về bối cảnh chung (đám đông, thành phố, tiền bạc, công nghệ, thiên nhiên, cảm xúc…) có thể minh hoạ bằng video stock.",
          "- imageQuery: 3–7 từ khoá tìm ảnh thật cho cảnh (tên riêng, sự kiện; viết bằng ngôn ngữ của nguồn).",
          "- videoQuery: 2–4 từ TIẾNG ANH mô tả cảnh quay stock chung chung (không tên riêng), vd \"football stadium crowd\", \"stock market screen\".",
        ]),
    images.length ? "- image (tuỳ chọn): đường dẫn 1 ảnh bài báo khớp chú thích với cảnh, chỉ chọn trong danh sách ảnh đã cho." : "",
    "",
    o.channel.visuals === "ai"
      ? `Schema: { "scenes": [{ "voiceText": string, "visual": "photo" | "ai", "imageQuery": string, "imagePrompts": string[]${images.length ? ', "image"?: string' : ""} }] }`
      : `Schema: { "scenes": [{ "voiceText": string, "visual": "photo" | "video", "imageQuery": string, "videoQuery": string${images.length ? ', "image"?: string' : ""} }] }`,
  ].filter(Boolean).join("\n");
  const user = [
    channelBlock(o),
    `Video: "${outline.title}"`,
    outline.visualStyle ? `Phong cách hình ảnh chung: ${outline.visualStyle}` : "",
    "Dàn ý toàn video:",
    ...outline.chapters.map((c, i) => `${i + 1}. ${c.title}${i === idx ? "   ← CHƯƠNG CẦN VIẾT" : ""}\n   - ${c.points.join("\n   - ")}`),
    "",
    `Viết chương ${idx + 1}: "${ch.title}" — khoảng ${words} từ (≈ ${Math.max(2, Math.round(words / (lang === "vi" ? 45 : 32)))} scene).`,
    images.length ? `\nẢnh bài báo có sẵn:\n${images.map((im) => `- ${im.file}${im.caption ? ` — "${im.caption}"` : ""}`).join("\n")}` : "",
    "",
    sourceBlock(articles, 30000, !!o.prompt),
  ].join("\n");
  let lastErr = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { value } = await generateJson(system, [{ role: "user", text: attempt === 1 ? user : `${user}\n\nLần trước JSON lỗi: ${lastErr}. Trả lại đúng schema.` }], log);
      const r = ChapterScenes.safeParse(value);
      if (r.success) return r.data.scenes;
      lastErr = r.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    } catch (e) {
      lastErr = (e as Error).message;
    }
    log(`  Chương ${idx + 1} lỗi (${lastErr.slice(0, 120)}) — thử lại`);
  }
  throw new Error(`AI không viết được chương ${idx + 1} "${ch.title}": ${lastErr}`);
}

export async function generateLongScript(
  articles: Article[],
  images: ProjectImage[],
  o: LongOptions,
  log: (line: string) => void,
): Promise<SlideshowScript> {
  const lang = o.channel.language;
  const totalWords = Math.round(o.minutes * 60 * WORDS_PER_SEC[lang]);
  log(`Lập dàn ý video ~${o.minutes} phút (~${totalWords} từ, ${lang === "vi" ? "tiếng Việt" : "tiếng Anh"})...`);
  const outline = await makeOutline(articles, o, totalWords, log);
  log(`✓ Dàn ý: "${outline.title}" — ${outline.chapters.length} chương`);
  outline.chapters.forEach((c, i) => log(`  ${i + 1}. ${c.title}`));

  const limit = pLimit(3);
  let done = 0;
  const written = await Promise.all(
    outline.chapters.map((_, i) =>
      limit(async () => {
        const scenes = await writeChapter(i, outline, articles, images, o, log);
        log(`✓ Chương ${i + 1}/${outline.chapters.length} — ${scenes.length} cảnh (${++done}/${outline.chapters.length} xong)`);
        return scenes;
      }),
    ),
  );

  const known = new Set(images.map((im) => im.file));
  const usedImages = new Set<string>();
  const chapters = outline.chapters.map((c, i) => ({ id: `c${i + 1}`, title: c.title.replace(/\*/g, "") }));
  const scenes: SlideshowScript["scenes"] = [];
  written.forEach((list, ci) =>
    list.forEach((s, si) => {
      const inputs: SlideshowScript["scenes"][number]["inputs"] = {};
      // An article photo is shown once: a long video has room for fresh ones.
      if (s.image && known.has(s.image) && !usedImages.has(s.image)) {
        inputs.images = [s.image];
        usedImages.add(s.image);
      }
      scenes.push({
        id: `c${ci + 1}-${si + 1}`,
        type: scenes.length === 0 ? "hook" : "body",
        voiceText: s.voiceText.trim(),
        templateId: "slideshow",
        inputs,
        chapter: chapters[ci].id,
        imageQuery: s.imageQuery || undefined,
        videoQuery: s.videoQuery || undefined,
        imagePrompts: s.imagePrompts.length ? s.imagePrompts.slice(0, 2) : undefined,
        // A mode's own vocabulary only: stock channels never get "ai" scenes and vice versa.
        visual: o.channel.visuals === "ai" ? (s.visual === "video" ? "ai" : s.visual) : s.visual === "ai" ? "video" : s.visual,
      });
    }),
  );
  scenes.push({
    id: "outro",
    type: "outro",
    voiceText: outline.outro.trim(),
    templateId: "slideshow",
    inputs: {},
    chapter: chapters[chapters.length - 1].id,
    visual: "photo",
  });
  if (outline.visualStyle) log(`Phong cách hình: ${outline.visualStyle}`);

  const words = scenes.reduce((n, s) => n + s.voiceText.split(/\s+/).length, 0);
  const estMin = words / WORDS_PER_SEC[lang] / 60;
  log(`Kịch bản: ${scenes.length} cảnh, ${words} từ ≈ ${estMin.toFixed(1)} phút`);
  if (estMin < o.minutes * 0.7) log(`⚠ Ngắn hơn mục tiêu ${o.minutes} phút — nguồn có thể quá ít nội dung. Thêm link hoặc sửa kịch bản.`);

  const lead = articles.find((a) => a.url) ?? articles[0];
  return SlideshowScriptSchema.parse({
    version: "1.0",
    renderer: "slideshow",
    language: lang,
    metadata: {
      title: outline.title,
      description: outline.description,
      tags: outline.tags.slice(0, 15),
      source: { url: lead?.url ?? "", domain: lead?.domain ?? "local", image: lead?.image ?? null },
      sources: articles.map((a) => a.url).filter(Boolean),
      channel: o.channel.name,
      channelId: o.channel.id,
      date: todayVN(),
    },
    voice: { provider: "omnivoice", speed: 1, override: o.channel.voice },
    aspect: "16:9",
    chapters,
    style: { subtitles: o.channel.subtitles, music: o.channel.music, musicVolume: 0.12, brandColor: o.channel.brandColor, visualStyle: outline.visualStyle || undefined },
    scenes,
  });
}

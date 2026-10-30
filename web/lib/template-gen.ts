import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { toSlug } from "../../src/utils/slug.js";
import { generateJson, type Turn } from "./llm.js";
import { TEMPLATES_DIR } from "./paths.js";
import type { ReferenceVideo } from "./reference.js";
import { buildTemplateHtml, checkDesign, fontsInCss, normalizeMotion, replaceFonts, TRANSITIONS, type Motion } from "./template-shell.js";
import { clearTemplateCache, type TemplateStyle } from "./templates.js";

const SLOTS = [
  { name: "image", type: "image", limit: "—", max: null, notes: 'ảnh của scene, vd "images/02.jpg"' },
  { name: "images", type: "image[]", limit: "≤3 items", max: 3, notes: "2–3 ảnh chiếu lần lượt trong scene" },
  { name: "caption", type: "string", limit: "≤40", max: 40, notes: "nhãn nhỏ, thường để trống" },
  { name: "headline", type: "string", limit: "≤120", max: 120, notes: "đổi tiêu đề riêng cho scene này, thường để trống" },
  { name: "cta", type: "string", limit: "≤24", max: 24, notes: "chữ nút kêu gọi ở scene outro" },
];

interface DesignReply {
  name?: string;
  summary?: string;
  bestFor?: string;
  style?: Partial<TemplateStyle>;
  motion?: Partial<Motion>;
  css?: string;
  html?: string;
}

const CONTRACT = `Bạn là nhà thiết kế motion graphics. Bạn dựng lại PHONG CÁCH của video mẫu thành một template HTML/CSS tái sử dụng cho nội dung mới, trên canvas cố định.

Chỉ trả về MỘT object JSON:
{
  "name": "tên ngắn nêu đúng loại video mẫu theo nội dung thật, vd: Quảng cáo thuốc thú y, Bản tin bóng đá",
  "summary": "mô tả phong cách trong 1 câu",
  "bestFor": "loại nội dung hợp với mẫu",
  "style": { "structure": "...", "hook": "...", "tone": "...", "pacing": "...", "language": "ngôn ngữ của video mẫu", "outline": [{ "part": "tên đoạn", "purpose": "đoạn này làm gì", "pattern": "mẫu câu có chỗ trống, vd: Bạn có biết [sự thật gây sốc] không?", "share": phần trăm thời lượng }] },
  "motion": { "photoHold": giây, "transitions": [${TRANSITIONS.map((t) => `"${t}"`).join(", ")}], "kenBurns": 0..1, "headlineIn": "rise|pop|none", "subtitleWords": 0..8, "subtitleHighlight": true|false },
  "css": "...",
  "html": "..."
}

"style" mô tả cách KỂ để người viết kịch bản làm theo: cấu trúc, kiểu mở đầu 3 giây đầu, giọng văn, nhịp.
"outline" là KHUNG KỊCH BẢN của video mẫu: 3–8 đoạn theo đúng thứ tự xuất hiện, từ mở đầu đến kết. "pattern" giữ nguyên cách đặt câu của mẫu nhưng thay chi tiết cụ thể bằng [chỗ trống] mô tả cần điền gì, để nội dung khác điền vào được. Không chép nguyên văn lời thoại.

Yêu cầu "html": chỉ các thẻ div/span/h1/h2/p, đặt trực tiếp bên trong #root. Hệ thống tự điền nội dung vào các class sau, nên để TRỐNG bên trong chúng:
- "media" (BẮT BUỘC): vùng hiển thị ảnh của scene.
- "headline": tiêu đề video. Phải có chiều cao cố định để chữ tự co lại vừa khung; đặt sẵn font-size lớn.
- "subtitle": phụ đề chạy theo lời đọc. Dùng nếu video mẫu có chữ lớn chạy theo giọng nói.
- "brand-logo", "brand-name", "brand-handle": logo và tên kênh của người dùng.
- "date", "source", "caption": ngày, nguồn, nhãn ảnh.
- "cta": nút kêu gọi. Mặc định ẩn, chỉ hiện với ".is-outro .cta".
- "progress": thanh tiến trình, đặt height; hệ thống tự chỉnh width.
Có thể thêm phần tử trang trí (khung, dải màu, gạch chân) bằng class riêng.

Yêu cầu "css":
- Font: chỉ dùng font-family là một trong: Be Vietnam Pro, Oswald, Anton, Barlow Condensed, Roboto Condensed, Montserrat, Inter, Lexend, League Spartan, Saira Condensed, Bangers, Fjalla One. Viết riêng font-family, font-size, font-weight, không dùng thuộc tính gộp "font:".
- #root có class is-hook, is-body hoặc is-outro theo loại scene; có thể đổi bố cục theo đó. Scene outro phải có điểm nhấn kêu gọi theo dõi.
- Chữ đang được đọc trong phụ đề và cụm từ khoá có class "hl"; hãy định dạng ".hl".
- --brand và --hl là màu kênh của người dùng; dùng chúng cho logo, nút cta. Các màu phong cách khác lấy từ video mẫu.
- Đảm bảo chữ dễ đọc trên ảnh bất kỳ (nền đặc, shadow hoặc viền). Chừa vùng an toàn: không đặt chữ quan trọng sát mép.

Cấm: thẻ script, style, link, img, iframe; thuộc tính onclick và các thuộc tính sự kiện; src, href; url() ra ngoài; @import.
Không sao chép logo, watermark, tên kênh hay chữ có sẵn trong video mẫu; đây là khung cho nội dung của người dùng.`;

function describeReference(r: ReferenceVideo, size: { width: number; height: number }): string {
  return [
    `Canvas: ${size.width}x${size.height}px.`,
    r.title ? `Tiêu đề video mẫu: ${r.title}` : "",
    `Thời lượng: ${r.durationSec.toFixed(1)}s, ${r.shots} cảnh, trung bình ${r.avgShotSec.toFixed(1)}s/cảnh.`,
    r.transcript ? `Lời thoại:\n${r.transcript}` : "Không có lời thoại dạng chữ; suy ra từ chữ trên hình nếu có.",
    `Dưới đây là ${r.frames.length} khung hình theo thứ tự thời gian. Phân tích bố cục, màu, font, cách đặt chữ và cách dùng phụ đề, rồi dựng template.`,
  ].filter(Boolean).join("\n\n");
}

function designProblems(raw: unknown): string[] {
  const d = raw as DesignReply;
  if (typeof d?.css !== "string" || typeof d?.html !== "string") return ['Thiếu "css" hoặc "html".'];
  return checkDesign({ css: d.css, html: d.html });
}

/** Ask for a design; the AI gets its validation errors back to fix them. */
async function requestDesign(turns: Turn[], log: (line: string) => void): Promise<DesignReply> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    log(`AI đang dựng template${attempt > 1 ? ` (sửa lần ${attempt - 1})` : ""}...`);
    const { value, reply } = await generateJson(CONTRACT, turns, log);
    const problems = designProblems(value);
    if (problems.length === 0) return value as DesignReply;
    log(`Thiết kế chưa đạt: ${problems.join(" ")}`);
    turns.push({ role: "assistant", text: reply }, { role: "user", text: `Chưa đạt:\n- ${problems.join("\n- ")}\nTrả lại TOÀN BỘ object JSON đã sửa.` });
  }
  throw new Error("AI không dựng được template hợp lệ sau 3 lần thử.");
}

export const entrySize = (r: Pick<ReferenceVideo, "width" | "height">) =>
  r.width >= r.height ? { width: 1920, height: 1080, aspect: "16:9" as const } : { width: 1080, height: 1920, aspect: "9:16" as const };

/** Uploads and reposts often carry a generated id such as "fdaee947 e935 4cd8" instead of a title. */
export const isRealTitle = (title: string) => {
  const t = title.trim();
  return t.length > 0 && !/^[0-9a-f]{8}[\s_-]+[0-9a-f]{4}\b/i.test(t) && !/^[\d\s_-]+$/.test(t);
};

/** A template is named after its sample; the AI's name is for samples without a usable title. */
const templateName = (d: DesignReply, r: ReferenceVideo) => (isRealTitle(r.title) ? r.title.trim() : d.name?.trim() || "");

const FONT_CHECK_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36";
const fontSupport = new Map<string, boolean>();

/** Google Fonts lists a "vietnamese" subset for fonts with the glyphs; unknown fonts answer 400. */
async function hasVietnamese(font: string): Promise<boolean> {
  const known = fontSupport.get(font);
  if (known !== undefined) return known;
  let supported = false;
  try {
    const res = await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(font)}`, {
      headers: { "User-Agent": FONT_CHECK_UA },
      signal: AbortSignal.timeout(10_000),
    });
    supported = res.ok && (await res.text()).includes("/* vietnamese */");
  } catch {
    return false; // Unreachable: use the safe font now, but ask again next time.
  }
  fontSupport.set(font, supported);
  return supported;
}

/** Keep only fonts that can draw Vietnamese; returns the rewritten CSS and the fonts to load. */
export async function vietnameseSafeCss(css: string) {
  const fonts = fontsInCss(css);
  const checks = await Promise.all(fonts.map(async (f) => [f, await hasVietnamese(f)] as const));
  const ok = new Set(checks.filter(([, v]) => v).map(([f]) => f));
  const safe = replaceFonts(css, (f) => ok.has(f));
  return { css: safe, fonts: fontsInCss(safe) };
}

async function writeTemplate(id: string, d: DesignReply, r: ReferenceVideo) {
  const { aspect, ...size } = entrySize(r);
  const dir = join(TEMPLATES_DIR, id);
  const name = templateName(d, r) || id;
  const { css, fonts } = await vietnameseSafeCss(d.css!);
  const html = buildTemplateHtml({ fonts, css, html: d.html!, motion: normalizeMotion(d.motion) }, size, name);
  await mkdir(join(dir, "compositions"), { recursive: true });
  await writeFile(join(dir, "index.html"), html);
  if (aspect === "9:16") await writeFile(join(dir, "compositions", "portrait.html"), html);
  await writeFile(join(dir, "hyperframes.json"), JSON.stringify({ paths: { blocks: "compositions", components: "compositions/components", assets: "assets" } }, null, 2));
  await writeFile(join(dir, "meta.json"), JSON.stringify({
    id,
    name,
    dynamicDuration: true,
    generated: true,
    summary: d.summary ?? "",
    bestFor: d.bestFor ?? "",
    aspects: [aspect],
    slots: SLOTS,
    style: { ...d.style, durationSec: Math.round(r.durationSec), avgShotSec: +r.avgShotSec.toFixed(1), sourceUrl: r.sourceUrl },
  }, null, 2));
  clearTemplateCache();
}

/** Design a template from a sample and save it under templates/. Returns its id and the conversation. */
export async function createTemplate(r: ReferenceVideo, log: (line: string) => void) {
  const turns: Turn[] = [{ role: "user", text: describeReference(r, entrySize(r)), images: r.frames }];
  const design = await requestDesign(turns, log);
  const base = toSlug(templateName(design, r) || "mau").slice(0, 40);
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 12);
  const id = `ref-${base}-${stamp}`;
  await writeTemplate(id, design, r);
  log(`✓ Đã lưu template ${id}`);
  return { id, design, turns };
}

/** Show the AI its own render next to the sample and apply one round of fixes. */
export async function refineTemplate(id: string, design: DesignReply, turns: Turn[], r: ReferenceVideo, previewJpeg: string, log: (line: string) => void) {
  turns.push(
    { role: "assistant", text: JSON.stringify(design) },
    {
      role: "user",
      text: `Đây là ảnh render thật từ template của bạn, dùng ảnh và chữ mẫu. So với các khung hình video mẫu ở trên, sửa các lỗi rõ ràng: chữ tràn hoặc bị che, sai bố cục, sai màu, thiếu chi tiết nhận diện phong cách. Nếu đã tốt, giữ nguyên. Trả lại TOÀN BỘ object JSON.`,
      images: [previewJpeg],
    },
  );
  const improved = await requestDesign(turns, log);
  await writeTemplate(id, { ...design, ...improved }, r);
  log("✓ Đã tinh chỉnh template theo bản render thử");
}

export async function deleteGeneratedTemplate(id: string) {
  const dir = join(TEMPLATES_DIR, id);
  if (existsSync(dir)) await rm(dir, { recursive: true, force: true });
  clearTemplateCache();
}

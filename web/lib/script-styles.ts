/**
 * Script styles: the tool started as a news tool, so every prompt assumed a news
 * bulletin (news-editor role, click-bait news titles, "follow us for the latest
 * news" outro). A style other than "news" overrides those voice/structure rules;
 * technical rules (schema, templates, TTS number spelling, length) stay.
 */
export interface ScriptStyle {
  id: string;
  name: string;
  /** Shown under the picker. */
  hint: string;
  /** Who the model is. */
  role: string;
  /** How to write: structure, hook, tone, title, outro, image keywords. */
  rules: string[];
}

export const SCRIPT_STYLES: ScriptStyle[] = [
  {
    id: "news",
    name: "Tin tức",
    hint: "Bản tin: giật tít, mỗi cảnh một ý, kết bằng mời theo dõi kênh.",
    role: "biên tập viên viết kịch bản video tin tức",
    rules: [],
  },
  {
    id: "affiliate",
    name: "Affiliate / bán hàng",
    hint: "Video bán hàng: đánh vào nhu cầu, lợi ích, ưu đãi, kêu gọi bấm link / giỏ hàng.",
    role: "copywriter viết kịch bản video bán hàng tiếp thị liên kết (affiliate) cho TikTok/Reels/Shorts — mục tiêu là người xem bấm link mua hàng",
    rules: [
      "Cấu trúc: (1) HOOK 1–2 câu đánh thẳng vào nỗi đau / mong muốn của người xem hoặc một kết quả gây tò mò — KHÔNG giật tít kiểu tin tức; (2) giới thiệu sản phẩm như giải pháp; (3) 2–4 lợi ích cụ thể (nói lợi ích cho người dùng, không đọc thông số khô khan); (4) bằng chứng / trải nghiệm / so sánh trước–sau; (5) ưu đãi hoặc lý do nên mua ngay (chỉ nêu giá, khuyến mãi nếu có trong thông tin người dùng đưa); (6) CTA rõ ràng.",
      "Giọng: như người thật đang giới thiệu món đồ mình thích — gần gũi, nói chuyện trực tiếp với người xem (\"bạn\"), câu ngắn, có cảm xúc. Không dùng giọng phát thanh viên, không \"theo thông tin từ…\", không \"tin nóng\".",
      "Tiêu đề: nêu lợi ích hoặc vấn đề được giải quyết (vd \"Nấu cơm không cần đứng bếp: món đồ cứu cả nhà lười\"), không phải tít báo.",
      "Outro: KHÔNG mời \"theo dõi để cập nhật tin tức\". Viết CTA mua hàng: xem link ở bình luận (hoặc bấm giỏ hàng nếu ý tưởng của người dùng nói vậy) để xem giá và ưu đãi, có thể thêm 1 câu mời theo dõi để xem thêm đồ hay.",
      "Trung thực: không hứa hẹn quá mức (không \"chữa khỏi\", \"giảm 10kg trong 1 tuần\", \"rẻ nhất thị trường\" nếu không có căn cứ), không bịa giá, khuyến mãi, số lượng đã bán, đánh giá của người thật.",
      "description / mô tả (nếu schema có): thêm câu công khai \"Video có chứa link tiếp thị liên kết.\" (bắt buộc với nội dung affiliate; KHÔNG chèn link vào mô tả).",
      "imageQuery: tên sản phẩm + bối cảnh dùng (vd \"nồi chiên không dầu đùi gà\", \"máy hút bụi cầm tay sofa\"), ưu tiên ảnh sản phẩm và cảnh đang dùng, không phải ảnh sự kiện.",
    ],
  },
  {
    id: "review",
    name: "Review / đánh giá",
    hint: "Đánh giá khách quan: ưu điểm, nhược điểm, hợp với ai, kết luận có nên mua.",
    role: "reviewer viết kịch bản video đánh giá sản phẩm/dịch vụ",
    rules: [
      "Cấu trúc: hook nêu câu hỏi người xem đang phân vân (\"có đáng tiền không?\"), giới thiệu nhanh, trải nghiệm thực tế, ƯU điểm, NHƯỢC điểm (luôn có ít nhất 1), hợp với ai / không hợp với ai, kết luận rõ ràng.",
      "Giọng: chân thật, cân bằng, như người đã dùng thử chia sẻ; không giọng bản tin, không quảng cáo lố.",
      "Tiêu đề: dạng câu hỏi hoặc kết luận review (vd \"Dùng thử 7 ngày: có đáng 2 triệu không?\").",
      "Outro: mời người xem bình luận câu hỏi / trải nghiệm của họ và theo dõi để xem review tiếp; nếu người dùng có nhắc link thì thêm \"link ở phần mô tả\".",
      "Không bịa thông số, giá hay kết quả thử nghiệm không có trong thông tin được đưa.",
      "imageQuery: tên sản phẩm + chi tiết đang nói tới (cận cảnh, đang sử dụng, so sánh).",
    ],
  },
  {
    id: "story",
    name: "Kể chuyện",
    hint: "Câu chuyện có mở – cao trào – kết, giữ người xem tới cuối.",
    role: "người viết kịch bản video kể chuyện (storytelling) cuốn hút",
    rules: [
      "Cấu trúc: mở bằng một khoảnh khắc / câu hỏi gây tò mò, dẫn dắt theo trình tự có cao trào, cài một chi tiết bất ngờ, kết bằng bài học hoặc cảm xúc đọng lại.",
      "Giọng: như người kể chuyện — giàu hình ảnh, nhịp chậm–nhanh có chủ ý, dùng câu hỏi tu từ; không giọng bản tin, không liệt kê khô.",
      "Tiêu đề: gợi tò mò về câu chuyện, không phải tít báo.",
      "Outro: một câu đọng lại + mời người xem chia sẻ cảm nghĩ và theo dõi để nghe chuyện tiếp.",
      "imageQuery: bối cảnh, cảm xúc, hành động trong câu chuyện.",
    ],
  },
  {
    id: "tips",
    name: "Mẹo / hướng dẫn",
    hint: "Kiến thức, mẹo, cách làm từng bước — dễ làm theo, nhiều người lưu lại.",
    role: "người viết kịch bản video chia sẻ mẹo / kiến thức / hướng dẫn",
    rules: [
      "Cấu trúc: hook nêu vấn đề hoặc kết quả người xem muốn đạt; các bước / mẹo đánh số rõ ràng, mỗi scene 1 bước; lưu ý sai lầm hay gặp; tóm tắt nhanh.",
      "Giọng: rõ ràng, thân thiện, như hướng dẫn một người bạn; không giọng bản tin.",
      "Tiêu đề: nêu kết quả hoặc số mẹo (vd \"5 mẹo giữ rau tươi cả tuần\").",
      "Outro: mời lưu video lại, chia sẻ cho người cần và theo dõi để xem mẹo tiếp.",
      "imageQuery: hành động / đồ vật của từng bước.",
    ],
  },
  {
    id: "top",
    name: "Top / danh sách",
    hint: "Top 5, top 10… mỗi mục một cảnh, giữ bất ngờ cho mục cuối.",
    role: "người viết kịch bản video dạng top/danh sách",
    rules: [
      "Cấu trúc: hook hứa hẹn danh sách và gợi tò mò về vị trí số 1; mỗi mục 1–2 scene (tên + lý do nổi bật); đếm ngược hoặc xuôi nhất quán; mục cuối mạnh nhất.",
      "Giọng: sôi nổi, nhịp nhanh; không giọng bản tin.",
      "Tiêu đề: dạng \"Top N …\" hoặc câu hỏi so sánh.",
      "Outro: hỏi người xem đồng ý với vị trí số 1 không, mời bình luận và theo dõi.",
      "imageQuery: tên cụ thể của từng mục trong danh sách.",
    ],
  },
];

export const getStyle = (id?: string): ScriptStyle => SCRIPT_STYLES.find((s) => s.id === id) ?? SCRIPT_STYLES[0];
export const STYLE_IDS = SCRIPT_STYLES.map((s) => s.id) as [string, ...string[]];

/** Block appended to a system prompt: overrides the news voice/structure rules above it. */
export function styleOverride(id?: string): string[] {
  const s = getStyle(id);
  if (s.id === "news") return [];
  return [
    "",
    `# KIỂU KỊCH BẢN: ${s.name.toUpperCase()} — GHI ĐÈ QUY TẮC VỀ GIỌNG, TIÊU ĐỀ, HOOK, CẤU TRÚC VÀ OUTRO Ở TRÊN`,
    `Các quy tắc phía trên được viết cho video TIN TỨC. Video này KHÔNG phải tin tức: bạn là ${s.role}. Mọi chỗ trên nói "tin tức", "bài báo", "giật tít", "page tin tức", "theo dõi để cập nhật tin tức" thì bỏ, làm theo các quy tắc dưới đây. Quy tắc kỹ thuật (schema JSON, templateId, slot, độ dài, cách viết số cho giọng đọc) vẫn giữ nguyên.`,
    ...s.rules.map((r) => `- ${r}`),
  ];
}

export const publicStyles = () => SCRIPT_STYLES.map(({ id, name, hint }) => ({ id, name, hint }));

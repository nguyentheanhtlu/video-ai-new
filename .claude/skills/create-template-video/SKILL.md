---
name: create-template-video
description: Tạo video tin tức 9:16 theo khung nhận diện cố định của kênh (ảnh bài báo + panel thương hiệu + tiêu đề, giọng đọc kể nội dung) từ URL bài báo hoặc file .txt tiếng Việt. Trigger khi user muốn tạo video tin tức, làm short news, "tạo video template", "làm bản tin", "video TikTok tin tức". Output: video.mp4 + voice.mp3 + script.txt + cover.jpg.
---

# Create Template Video Skill

Sinh video tin tức 9:16 kiểu các page tin tức lớn trên TikTok: **ảnh bài báo ở
trên, panel màu kênh ở dưới với logo kênh, ngày đăng và TIÊU ĐỀ bài báo**.
Tiêu đề đứng yên suốt video; chỉ ảnh thay đổi theo lời đọc. **Nội dung nằm ở
giọng đọc (`voiceText`)** — trên màn hình gần như chỉ có tiêu đề.

Logo, tên kênh, màu, handle, ngày, nguồn do pipeline tự chèn từ bộ nhận diện kênh
(`.env.local`) — KHÔNG viết vào `inputs`.

## Input

1 tham số: URL bài báo (`http://`/`https://`) HOẶC đường dẫn file `.txt`.

## Workflow (theo đúng thứ tự)

### Step 1–3: Lấy nội dung, ảnh + tạo output dir

- **URL** → `WebFetch` với prompt:
    ```
    Trích xuất từ trang này, trả về JSON:
    - title (string): tiêu đề bài báo
    - content (string): nội dung chính, ~500-1500 từ
    - domain (string): domain của URL
    - images (array): tối đa 10 ảnh trong bài theo thứ tự xuất hiện, mỗi ảnh { url, caption }
      (ảnh og:image đứng đầu; bỏ logo, icon, avatar, ảnh quảng cáo)
    ```
    Fail (paywall/JS/4xx) → bảo user lưu nội dung vào `.txt` rồi gọi lại. Stop.
- **File `.txt`** → `Read`; title = dòng đầu (≤80 ký tự), content = phần còn lại, images = `[]`, domain = `"local"`.
- slug = ASCII không dấu (bỏ dấu tiếng Việt, đ→d), ≤40 ký tự; timestamp = `YYYYMMDD-HHmm`; `outputDir = output/<slug>-<timestamp>/`; `mkdir -p <outputDir>/images`.
- Tải ảnh: với mỗi ảnh `i` (1-based) chạy
  `curl -sL -A "Mozilla/5.0" -e "<url bài>" "<image url>" -o <outputDir>/images/raw-<i>`
  rồi chuẩn hoá `ffmpeg -y -v error -i <raw> -vf "scale='min(1600,iw)':-2" -frames:v 1 -q:v 3 <outputDir>/images/<NN>.jpg`
  (NN = 01, 02…; bỏ ảnh lỗi hoặc nhỏ hơn 480px ngang), xoá file raw. Ghi nhớ caption của từng ảnh.

### Step 4: Đọc danh mục template

Đọc `templates/CATALOG.md`. Kênh chỉ dùng **2 template**:

- `news-frame` — mọi scene hook + body. Slot chính: `image` (hoặc `images` 2–3 ảnh).
- `news-outro` — scene cuối (kêu gọi theo dõi kênh).

### Step 5: Sinh script.json

```json
{
    "version": "1.0",
    "renderer": "hyperframes",
    "aspect": "9:16",
    "metadata": {
        "title": "Tây Ban Nha, Anh cùng thắng ở Nations League: *Lamine Yamal* tiếp tục tỏa sáng",
        "source": { "url": "...", "domain": "vnexpress.net", "image": null },
        "channel": "AI Coding"
    },
    "voice": { "provider": "omnivoice", "speed": 1.0 },
    "scenes": [
        { "id": "hook", "type": "hook", "voiceText": "...", "imageQuery": "Tây Ban Nha Nations League 2026", "templateId": "news-frame", "inputs": { "image": "images/01.jpg" } },
        { "id": "body-1", "type": "body", "voiceText": "...", "imageQuery": "Lamine Yamal ghi bàn Croatia", "templateId": "news-frame", "inputs": { "image": "images/02.jpg" } },
        { "id": "body-2", "type": "body", "voiceText": "...", "imageQuery": "Harry Kane tuyển Anh", "templateId": "news-frame", "inputs": { "images": ["images/03.jpg", "images/04.jpg"] } },
        { "id": "outro", "type": "outro", "voiceText": "Theo dõi AI Coding để cập nhật tin tức nóng hổi mỗi ngày.", "templateId": "news-outro", "inputs": { "image": "images/01.jpg" } }
    ]
}
```

**`metadata.title` = TIÊU ĐỀ hiển thị suốt video** (thứ quan trọng nhất trên màn hình):

- Viết lại tiêu đề kiểu page tin tức: đủ ý, gây tò mò, **40–110 ký tự**, có thể dùng dấu `:` để thêm chi tiết.
- Đánh dấu **1 cụm từ khoá** (tên người, con số, sự kiện chính) bằng `*...*` để tô màu nổi bật. Không đánh dấu quá 2 cụm.
- Không emoji, không hashtag. Chữ tự in hoa khi hiển thị.

**Scenes:**

- `scenes[0]` = `hook`, `news-frame`, ảnh đẹp/đặc trưng nhất (thường là ảnh 01). voiceText hook = 1–2 câu giật tít, nêu điều hấp dẫn nhất.
- body = `news-frame`, mỗi scene **1 ý**, ~25–45 từ. Chọn ảnh có **caption khớp với nội dung scene**; phân bổ để các ảnh đều được dùng, tránh 2 scene liền nhau cùng ảnh. Scene dài (>40 từ) và còn nhiều ảnh → dùng `images` (2–3 ảnh).
- Không có ảnh nào → bỏ `image`, khung vẫn hiển thị nền màu kênh.
- scene cuối = `outro`, `news-outro`, `image` = ảnh hook; voiceText kêu gọi theo dõi kênh (dùng tên kênh).
- **Mỗi scene (trừ outro) có `imageQuery`** (đặt ngang hàng `voiceText`, không nằm trong `inputs`): từ khoá tìm ảnh minh hoạ ĐÚNG nội dung scene đó, 3–7 từ, cụ thể (tên người, đội, địa danh, sự kiện, đồ vật) — vd `"Chanathip Songkrasin ăn mừng"`, `"sân Si Jalak Harupat"`, `"cổ động viên Thái Lan"`. Tên riêng nước ngoài giữ nguyên tiếng gốc. Không dùng từ chung chung ("bóng đá", "tin tức"). Hệ thống dùng từ khoá này để tự tìm thêm ảnh (mỗi ảnh ~4 giây, tối đa 3 ảnh/scene), nên video luôn có nhiều ảnh dù bài gốc ít ảnh.
- `inputs.caption`: chỉ khi thật cần (tên nhân vật trong ảnh), ≤40 ký tự. Còn lại **để trống — không thêm chữ lên màn hình**.
- Tổng: **5–12 scene**, voiceText tổng ~150–350 từ (~50–120 giây) tuỳ độ dài bài.
- voiceText phải kể **đầy đủ câu chuyện** (ai, cái gì, khi nào, ở đâu, vì sao, diễn biến, kết quả) — người xem chỉ nghe là hiểu.

### ⚠️ Quy tắc TTS tiếng Việt (BẮT BUỘC cho `voiceText`)

`voiceText` được đọc bằng TTS tiếng Việt. **Số và ký hiệu bị đọc theo nghĩa đen**
— luôn viết số ra chữ trong `voiceText`. (Tiêu đề `metadata.title` thì GIỮ số đẹp: "0-2", "5.5", "82%".)

| Dạng số                  | SAI (TTS đọc nhầm)             | ĐÚNG (viết ra chữ)                                          |
| ------------------------ | ------------------------------ | ---------------------------------------------------------- |
| Phiên bản thập phân      | `GPT 5.5` → "năm rưỡi"         | `GPT năm chấm năm`                                         |
| Số liệu thập phân        | `82.7%`                        | `tám mươi hai phẩy bảy phần trăm`                          |
| Tỷ số                    | `2-0`                          | `hai không`                                                |
| Năm                      | `2026`                         | `hai nghìn không trăm hai mươi sáu`                        |
| Ngày tháng               | `30/9`                         | `ngày ba mươi tháng chín`                                  |
| Thông số kỹ thuật        | `200MP`                        | `hai trăm megapixel`                                       |
| Giá VND                  | `21 triệu đồng`                | `hai mươi mốt triệu đồng`                                  |
| Giá USD                  | `$5`                           | `năm đô la`                                                |
| Phần trăm                | `30%`                          | `ba mươi phần trăm`                                        |
| Bội số                   | `2x`                           | `gấp đôi`                                                  |

- Viết tắt khó đọc → viết đầy đủ hoặc phiên âm (`TP.HCM` → `Thành phố Hồ Chí Minh`, `UBND` → `Ủy ban nhân dân`, `CSGT` → `cảnh sát giao thông`).
- **`voiceText` KHÔNG có emoji, URL, hashtag** và không có `→ & % $ # + = /`. Kết câu bằng `.` hoặc `?`.

### Step 6: Tự kiểm tra

- scenes[0]=hook, scene cuối=outro; hook/body dùng `news-frame`, outro dùng `news-outro`;
- mọi đường dẫn ảnh có thật trong danh sách ảnh đã tải; ảnh khớp nội dung scene;
- voiceText đã viết số ra chữ, không emoji; không có chữ thừa trong `inputs`. Sửa thầm tối đa 2 lần.

### Step 7: Ghi script.json

Dùng tool `Write` ghi `<outputDir>/script.json`.

### Step 8: Chạy pipeline

```bash
npm run pipeline -- <outputDir>/script.json
```

Pipeline: TTS song song → trộn SFX → render từng scene đúng bằng độ dài lời đọc → ghép + mux → `cover.jpg`.

### Step 9: Báo kết quả

```markdown
✓ Video: [video.mp4](output/<slug>/video.mp4)
✓ Ảnh bìa: [cover.jpg](output/<slug>/cover.jpg) — đặt làm cover TikTok
✓ Audio: [voice.mp3](output/<slug>/voice.mp3)
✓ Script: [script.txt](output/<slug>/script.txt) — cho CapCut auto-caption
Tổng thời lượng: XX.Xs
```

## Ghi chú

- Web UI (`npm run web`) làm toàn bộ quy trình này bằng giao diện, kể cả tải ảnh bài báo.
- Render mỗi scene ~15–25s. TTS và clip đều được cache theo scene id — sửa scene nào chỉ làm lại scene đó.

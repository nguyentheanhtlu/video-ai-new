# Đơn kiểm duyệt YouTube API (YouTube API Services – Audit and Quota Extension)

Tài liệu gồm 4 phần:

1. Chuẩn bị trước khi nộp (tiếng Việt, cho bạn)
2. Câu trả lời cho từng mục trong form (tiếng Anh, copy vào form)
3. Privacy Policy (tiếng Anh, đăng lên website)
4. Terms of Service (tiếng Anh, đăng lên website)

Chỗ nào có `[...]` là bạn tự điền. Form của Google có thể đổi câu hỏi theo thời gian. Câu nào khác với tài liệu này thì lấy ý từ phần trả lời gần nhất.

Link form: https://support.google.com/youtube/contact/yt_api_form

---

## 1. Chuẩn bị trước khi nộp

### 1.1 Tạo Google Cloud project (miễn phí, khoảng 10 phút)

1. Vào https://console.cloud.google.com/, tạo project mới, đặt tên ví dụ `video-studio`.
2. Vào **APIs & Services → Library**, tìm và bật **YouTube Data API v3**.
3. Vào **APIs & Services → OAuth consent screen**:
   - User type: **External**
   - App name: `[Tên app, vd: AI Video Studio]`
   - User support email và developer contact: email của bạn
   - App domain: điền link Privacy Policy và Terms (mục 1.2)
   - Scopes: thêm `https://www.googleapis.com/auth/youtube.upload` và `https://www.googleapis.com/auth/youtube.readonly`
   - Test users: thêm email Google của **từng tài khoản sở hữu kênh** (tối đa 100)
   - Để ở trạng thái **Testing**. Ở trạng thái này, mỗi kênh phải đăng nhập lại sau mỗi 7 ngày. Chuyển sang Production thì cần thêm bước xác minh OAuth của Google cho scope nhạy cảm, đây là quy trình riêng với đơn kiểm duyệt này.
4. Vào **APIs & Services → Credentials → Create credentials → OAuth client ID**, chọn loại **Desktop app**. Giữ lại Client ID, sau này tool cần nó.
5. Ghi lại **Project number** (trang Dashboard của project). Form sẽ hỏi số này.

### 1.2 Đăng Privacy Policy và Terms of Service

Google yêu cầu hai trang này **công khai trên Internet**. Bạn đã có website `aicodingvn.vercel.app`, nên thêm 2 trang:

- `https://aicodingvn.vercel.app/privacy`: nội dung ở phần 3
- `https://aicodingvn.vercel.app/terms`: nội dung ở phần 4

### 1.3 Video demo (screencast)

Quay màn hình 2–4 phút, đăng lên YouTube ở chế độ **Không công khai (Unlisted)**, rồi dán link vào form. Nội dung cần quay:

1. Mở tool, vào trang Kênh YouTube, bấm "Kết nối YouTube".
2. Màn hình đăng nhập Google và màn hình xin quyền. Phải thấy rõ tên app và các quyền.
3. Tool hiện kênh đã kết nối, có link tới YouTube Terms of Service, Google Privacy Policy và nút ngắt kết nối.
4. Chọn 1 video đã render, bấm Đăng. Tool gửi tiêu đề, mô tả, thumbnail, phụ đề.
5. Mở YouTube Studio, thấy video vừa đăng.
6. Bấm "Ngắt kết nối" để cho thấy token bị xoá.

Phần này **cần khối C** (chức năng đăng YouTube). Nếu nộp ngay bây giờ chưa có video demo, khả năng cao Google sẽ hỏi thêm hoặc từ chối. Lúc đó cứ làm C, quay demo rồi trả lời email của họ.

### 1.4 Số liệu quota

Chi phí API cho mỗi video (theo bảng quota của Google, nên kiểm tra lại tại https://developers.google.com/youtube/v3/determine_quota_cost):

| Thao tác | Đơn vị |
|---|---|
| `videos.insert` (upload) | ~1.600 |
| `thumbnails.set` | 50 |
| `captions.insert` (phụ đề) | 400 |
| `channels.list`, `videos.list` (kiểm tra) | ~5 |
| **Tổng mỗi video** | **~2.055** |

Ví dụ: `[S]` kênh × `[V]` video/ngày × 2.055 = quota cần xin. Hãy ghi **con số thật** bạn định làm. Google xem kỹ mục này, và ghi khống sẽ bị từ chối hoặc thu hồi quyền.

---

## 2. Câu trả lời cho form (tiếng Anh)

### Organization / Contact

- **Organization name:** `[Tên bạn hoặc tên công ty]`
- **Organization website:** `https://aicodingvn.vercel.app`
- **Address / Country:** `[Địa chỉ]`, Vietnam
- **Contact email:** `[email]`

### API Client information

- **Google Cloud project number:** `[project number]`
- **API client / app name:** `[AI Video Studio]`
- **Link to the API client:** `https://aicodingvn.vercel.app` (if asked whether the client is publicly available: **No, internal tool used only by the organization for its own channels**)
- **Which YouTube API Services does your client use?** YouTube Data API v3
- **Number of users / authorized accounts:** `[S]` YouTube channels, all owned and operated by our organization. No third-party users.

### Describe your API client and how it uses YouTube API Services

> [App name] is a desktop video production tool that our team runs locally (Node.js, on our own computers) to produce and publish videos to the YouTube channels that we own and operate.
>
> The workflow: an editor provides news article links or a topic; the tool helps write a narration script (reviewed and edited by a human in the tool's editor), generates a voice-over, assembles licensed photos and stock footage (Pexels), adds subtitles, and renders a 16:9 video. When the editor approves the video, the tool uploads it to the selected channel.
>
> YouTube API usage is limited to the channel owner's own account, authorized with OAuth 2.0 (installed-app flow):
> - `videos.insert`: upload the finished video with its title, description, tags, category, language and privacy status (or a scheduled publish time chosen by the editor).
> - `thumbnails.set`: set the custom thumbnail produced with the video.
> - `captions.insert`: upload the subtitle track (.srt) we generated for the video.
> - `channels.list` (mine=true): show which channel is connected, so the editor uploads to the right one.
> - `videos.list`: confirm the upload's processing status after publishing.
>
> We do not access, collect or analyze data from other users or other channels, and we do not download YouTube content. OAuth refresh tokens are stored only on the operator's computer and can be removed at any time from the tool ("Disconnect", which also revokes the token) or at https://myaccount.google.com/permissions. The tool displays links to the YouTube Terms of Service and the Google Privacy Policy on the channel connection screen.

### How will users authorize / What OAuth scopes do you request?

> `https://www.googleapis.com/auth/youtube.upload` (upload videos, thumbnails and captions)
> `https://www.googleapis.com/auth/youtube.readonly` (read the connected channel's name and the uploaded video's status)
> Each channel owner signs in through Google's standard OAuth consent screen. Only accounts of our own channels are added as users.

### Quota request

- **Requested daily quota:** `[con số ở mục 1.4, vd 130,000]` units/day
- **Justification:**

> We publish about `[V]` videos per day on each of our `[S]` channels (`[S × V]` uploads/day). Each published video uses about 2,055 units: videos.insert (1,600), captions.insert (400), thumbnails.set (50) and a few list calls to verify the channel and processing status. `[S × V]` × 2,055 ≈ `[tổng]` units/day; we request `[tổng làm tròn lên]` to allow for occasional retries of failed uploads. We do not poll or run searches; usage is strictly one upload pipeline per approved video.

### Data handling and compliance

- **Do you store YouTube API data?** No, apart from what we need to manage our own uploads: OAuth tokens (stored locally on the operator's machine) and the IDs of videos we uploaded. We do not store data from other channels or users.
- **Data retention / deletion:** Tokens are deleted when a channel is disconnected. Video IDs of our own uploads are kept only as a link from each project to its published video.
- **Do you display YouTube data to users?** Only the connected channel's name and our own uploaded videos' status, inside the internal tool.
- **Is your client used by anyone outside your organization?** No.
- **Privacy Policy URL:** `https://aicodingvn.vercel.app/privacy`
- **Terms of Service URL:** `https://aicodingvn.vercel.app/terms`
- **Screencast / demo video:** `[link video Unlisted, mục 1.3]`

### About the content (if asked)

> Videos are produced by our editors with AI assistance for scripting and narration. Every video is reviewed before publishing, uses only licensed or permitted media (Pexels stock footage under the Pexels License, photos credited to their sources), credits sources in the description, and follows YouTube's Community Guidelines and policies on altered or synthetic content, applying the disclosure label where required.

---

## 3. Privacy Policy (đăng tại /privacy)

```
Privacy Policy — [App name]
Last updated: [date]

[App name] ("the App") is an internal video production tool operated by [Organization name] ("we") to create and publish videos to YouTube channels that we own and operate.

1. Use of YouTube API Services
The App uses YouTube API Services to upload videos, thumbnails and captions to our own YouTube channels and to read those channels' names and upload status. By using the App you agree to the YouTube Terms of Service (https://www.youtube.com/t/terms). Google's Privacy Policy applies to data processed by Google: https://policies.google.com/privacy

2. Information we access
With the permission granted through Google's OAuth consent screen, the App accesses: the connected YouTube channel's ID and name, and the status of videos uploaded by the App. The App does not access other users' data, comments, subscribers, analytics, or any data of channels we do not own.

3. How we use and store it
OAuth access and refresh tokens are stored only on the computer that runs the App, and are used solely to upload videos that our editors have approved. We keep the IDs of videos we uploaded to link each project to its published video. We do not sell, share or transfer this information to any third party, and we do not use it for advertising.

4. Retention and deletion
Tokens are deleted when a channel is disconnected in the App. You can also revoke the App's access at any time at https://myaccount.google.com/permissions; after revocation the App can no longer access the channel. Stored video IDs are deleted together with the project. To request deletion of any data, contact [email].

5. Cookies
The App is a locally run tool and does not use cookies or tracking.

6. Contact
[Organization name] — [email] — [address]
```

---

## 4. Terms of Service (đăng tại /terms)

```
Terms of Service — [App name]
Last updated: [date]

1. The App is an internal tool of [Organization name], used by our staff to produce and publish videos to YouTube channels we own and operate. It is not offered to the public.

2. By connecting a YouTube account to the App, you agree to be bound by the YouTube Terms of Service (https://www.youtube.com/t/terms) and acknowledge the Google Privacy Policy (https://policies.google.com/privacy).

3. Users of the App must only connect YouTube channels they own or are authorized to manage, and must review every video before it is published. Content published through the App must comply with YouTube's Community Guidelines and policies, including the disclosure of altered or synthetic content where required, and with copyright law.

4. Access can be withdrawn at any time by disconnecting the channel in the App or at https://myaccount.google.com/permissions.

5. The App is provided "as is", without warranty. [Organization name] is not liable for actions taken by YouTube regarding published content.

6. Contact: [email]
```

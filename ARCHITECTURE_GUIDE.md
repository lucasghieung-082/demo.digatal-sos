# DIGITAL SOS — Tài liệu Kiến trúc & Hướng dẫn Giải thích Mã nguồn

Tài liệu này được biên soạn để **nhóm 3 học sinh** có thể hiểu rõ cấu trúc mã nguồn, cách tính điểm minh bạch, luồng gọi Gemini AI an toàn và nguyên tắc bảo mật của ứng dụng **DIGITAL SOS**.

---

## 1. Tổng quan Kiến trúc (Full-Stack React + Express)

Ứng dụng gồm 2 phần chạy trên cùng một cổng `3000`:
1. **Frontend (`src/`)**: Giao diện React + Tailwind CSS (hỗ trợ Tiếng Việt & Tiếng Anh, responsive trên máy tính và điện thoại).
2. **Backend (`server.ts`)**: Máy chủ Express giữ `GEMINI_API_KEY` ở phía server và cung cấp 3 API:
   - `POST /api/analyze-message`: Phân tích SMS, Email và OCR ảnh chụp màn hình.
   - `POST /api/analyze-link`: Phân tích cấu trúc URL + giải thích ngữ cảnh tên miền.
   - `POST /api/chat`: Chatbot **SOS AI Assistant** có thể đọc ngữ cảnh từ lần kiểm tra trước.

> **Tại sao không gọi Gemini trực tiếp từ trình duyệt?**  
> Để không làm lộ khóa `GEMINI_API_KEY` ra mã nguồn phía người dùng. Mọi lời gọi AI đều đi qua `server.ts`.

---

## 2. Bộ máy tính điểm rủi ro minh bạch (`src/utils/riskEngine.ts`)

Điểm rủi ro (0–100) **không do AI tự bịa ra một con số ngẫu nhiên**, mà được cộng dồn từ các quy tắc có thể kiểm chứng:

| Mã quy tắc | Dấu hiệu phát hiện | Trọng số điểm |
| :--- | :--- | :--- |
| `RULE-CRED-01` | Yêu cầu OTP, mật khẩu, mã PIN, CCCD | +30 |
| `RULE-FIN-02` | Đòi chuyển khoản, đóng phí, dọa khóa tài khoản | +25 |
| `RULE-URL-03` | Link giả mạo thương hiệu hoặc đuôi `.xyz`, `.top` | +25 đến +35 |
| `RULE-IMP-05` | Giả danh ngân hàng, công an, giáo viên | +20 |
| `RULE-URG-06` | Thúc ép thời gian ("trong 2 giờ", "khẩn cấp") | +15 |

### Phân loại mức độ rủi ro:
- **60 – 100 điểm**: `Rủi ro cao` (`HIGH`)
- **25 – 59 điểm**: `Cần thận trọng` (`MEDIUM`)
- **0 – 24 điểm**: `Chưa phát hiện dấu hiệu nguy hiểm` (`LOW_CAUTION`)

> **Nguyên tắc quan trọng**: Ứng dụng **không bao giờ** khẳng định một tin nhắn hoặc website *"An toàn tuyệt đối 100%"*, vì kẻ gian có thể dùng tên miền mới chưa có trong danh sách cảnh báo.

---

## 3. Chức năng của từng thư mục & tệp chính

- `server.ts`: Khởi tạo Express, kết nối `@google/genai` (model `gemini-4-hydrogen`), xử lý OCR ảnh chụp màn hình và JSON schema trả về.
- `src/utils/riskEngine.ts`: Chứa `analyzeUrlStructure()` (tách `protocol`, `subdomain`, `rootDomain`, `tld`), `evaluateMessageHeuristics()`, `calculateVerifiableRiskScore()`, và `redactSensitiveData()` (che mã OTP, số tài khoản, email).
- `src/utils/riskEngine.test.ts`: Kiểm thử tự động (Unit Tests) bằng `node:test` để chứng minh công thức tính điểm chạy chính xác.
- `src/data/threatIntel.ts`: Danh sách tên miền chính thức của các ngân hàng/tổ chức, đuôi tên miền rủi ro cao, dữ liệu minh họa mẫu (`SAMPLE_DEMO_REPORT`), 4 bài học, câu hỏi trắc nghiệm và 10 tình huống Cyber Challenge.
- `src/components/RiskReportCard.tsx`: Thành phần **AI Risk Analyzer** thống nhất hiển thị 5 phần (Điểm số, Cấp độ, Dấu hiệu, Giải thích & tô sáng cụm từ đáng ngờ, Khuyến nghị + nút **"Hỏi AI cách xử lý"**).
- `src/components/HomeDashboard.tsx`: Trang chủ với ô kiểm tra nhanh, cảnh báo mới nhất, thống kê hoạt động.
- `src/components/MessageScanner.tsx`: Hỗ trợ 3 đầu vào (SMS, Email, Ảnh chụp màn hình OCR).
- `src/components/LinkChecker.tsx`: Kiểm tra URL + hiển thị chi tiết tên miền & nguồn tra cứu.
- `src/components/AiAssistant.tsx`: Chatbot nhận ngữ cảnh tự động từ Scanner / Link Checker.
- `src/components/CyberAcademy.tsx`: 4 khu vực Learn, Quiz, Challenge (10 tình huống) và Leaderboard.
- `src/components/HistoryView.tsx` & `ProfileView.tsx`: Mặc định **tắt lưu lịch sử nhạy cảm**, chỉ lưu bản tóm tắt đã che thông tin khi có sự đồng ý của người dùng, và có nút xóa toàn bộ dữ liệu.

---

## 4. Cách chạy kiểm thử Unit Test

```bash
npx --yes tsx --test src/utils/riskEngine.test.ts
```

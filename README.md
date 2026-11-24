# DIGITAL SOS

Trợ lý AI phát hiện nguy cơ lừa đảo qua tin nhắn, email, ảnh chụp màn hình và đường link. Mã nguồn mở (MIT).

## Chạy local
1. `npm install`
2. Tạo file `.env.local` với `GEMINI_API_KEY=khoa_cua_ban`
3. `npm run dev` rồi mở http://localhost:3000

## Triển khai lên Vercel
1. Đưa repo này lên GitHub.
2. Vào vercel.com → Add New → Project → chọn repo → Import.
3. Trong Environment Variables, thêm `GEMINI_API_KEY`.
4. Bấm Deploy.

Tài liệu kiến trúc: xem `ARCHITECTURE_GUIDE.md`.

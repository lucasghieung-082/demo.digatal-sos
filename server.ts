import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import {
  analyzeUrlStructure,
  buildUnifiedRiskReport,
  evaluateMessageHeuristics,
  VERIFIABLE_RULE_CATALOG,
} from './src/utils/riskEngine.js';
import type { Language, ScanContextSummary } from './src/types/safety.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '15mb' }));

// Allow external websites to embed the widget and call Digital SOS analysis endpoints
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  return next();
});

app.get('/embed-widget.js', (req, res) => {
  const forwardedProto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
  const host = req.headers.host || `localhost:${PORT}`;
  const origin = `${forwardedProto}://${host}`;
  res.type('application/javascript; charset=utf-8');
  res.send(`(function () {
  if (window.__digitalSosLoaded) return;
  window.__digitalSosLoaded = true;
  var scriptEl = document.currentScript;
  var tab = (scriptEl && scriptEl.getAttribute('data-tab')) || 'scanner';
  var lang = (scriptEl && scriptEl.getAttribute('data-lang')) || 'vi';
  var baseUrl = ${JSON.stringify(origin)};

  var btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('aria-label', 'DIGITAL SOS');
  btn.textContent = lang === 'en' ? 'DIGITAL SOS Check' : 'Kiểm tra an toàn SOS';
  btn.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483000;background:#0f172a;color:#fff;border:1px solid #0e7490;border-radius:10px;padding:11px 16px;font:600 13px/1.2 system-ui,-apple-system,sans-serif;cursor:pointer;box-shadow:0 8px 24px rgba(15,23,42,0.25);';

  var panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;right:20px;bottom:74px;z-index:2147483000;width:min(440px,calc(100vw - 32px));height:min(660px,calc(100vh - 100px));background:#fff;border:1px solid #cbd5e1;border-radius:14px;overflow:hidden;box-shadow:0 18px 40px rgba(15,23,42,0.28);display:none;';

  var iframe = document.createElement('iframe');
  iframe.title = 'DIGITAL SOS Widget';
  iframe.style.cssText = 'width:100%;height:100%;border:0;';
  panel.appendChild(iframe);

  var open = false;
  btn.addEventListener('click', function () {
    open = !open;
    if (open && !iframe.src) {
      iframe.src = baseUrl + '/?embed=1&tab=' + encodeURIComponent(tab) + '&lang=' + encodeURIComponent(lang);
    }
    panel.style.display = open ? 'block' : 'none';
    btn.textContent = open ? (lang === 'en' ? 'Close DIGITAL SOS' : 'Đóng DIGITAL SOS') : (lang === 'en' ? 'DIGITAL SOS Check' : 'Kiểm tra an toàn SOS');
  });

  document.body.appendChild(panel);
  document.body.appendChild(btn);
})();`);
});

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function formatGeminiError(err: unknown, language: Language = 'vi'): { status: number; message: string } {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('API_KEY_INVALID') || msg.includes('PERMISSION_DENIED') || msg.includes('403')) {
    return {
      status: 403,
      message:
        language === 'vi'
          ? 'Khóa Gemini API chưa hợp lệ hoặc thiếu quyền. Vui lòng kiểm tra mục Settings > Secrets.'
          : 'Gemini API key is invalid or lacks permissions. Please check Settings > Secrets.',
    };
  }
  if (msg.includes('RESOURCE_EXHAUSTED') || msg.includes('429')) {
    return {
      status: 429,
      message:
        language === 'vi'
          ? 'Hệ thống AI đang tạm quá tải lượt gọi. Vui lòng thử lại sau ít phút.'
          : 'AI service rate limit reached temporarily. Please try again shortly.',
    };
  }
  if (msg.includes('TIMEOUT') || msg.includes('503') || msg.includes('UNAVAILABLE') || msg.includes('high demand')) {
    return {
      status: 503,
      message:
        language === 'vi'
          ? 'Dịch vụ Gemini AI đang phản hồi chậm hoặc quá tải tạm thời. Vui lòng thử lại sau vài giây hoặc dùng Bộ quy tắc cục bộ.'
          : 'Gemini AI is responding slowly or under temporary high demand. Please retry shortly or use the Local Rule Check.',
    };
  }
  return {
    status: 502,
    message:
      language === 'vi'
        ? 'Không thể kết nối máy chủ phân tích AI lúc này. Vui lòng thử lại.'
        : 'Unable to reach AI analysis service right now. Please try again.',
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`TIMEOUT: ${label} exceeded ${ms}ms`)), ms);
    }),
  ]);
}

async function generateWithRetry<T>(fn: () => Promise<T>, maxRetries = 1): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient =
        msg.includes('503') ||
        msg.includes('UNAVAILABLE') ||
        msg.includes('429') ||
        msg.includes('fetch failed') ||
        msg.includes('TIMEOUT');
      if (!isTransient || attempt === maxRetries) {
        throw err;
      }
      const delayMs = 600 * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

async function generateWithModelFallback<T>(
  runner: (model: 'gemini-4-hydrogen' | 'gemini-3.1-flash-lite') => Promise<T>
): Promise<{ result: T; modelUsed: string }> {
  try {
    const result = await withTimeout(runner('gemini-4-hydrogen'), 8000, 'gemini-4-hydrogen');
    return { result, modelUsed: 'Gemini 4 Hydrogen' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const shouldFallback =
      msg.includes('TIMEOUT') ||
      msg.includes('503') ||
      msg.includes('UNAVAILABLE') ||
      msg.includes('high demand') ||
      msg.includes('429') ||
      msg.includes('RESOURCE_EXHAUSTED');
    if (!shouldFallback) {
      throw err;
    }
    const result = await generateWithRetry(
      () => withTimeout(runner('gemini-3.1-flash-lite'), 12000, 'gemini-3.1-flash-lite'),
      1
    );
    return { result, modelUsed: 'Gemini 3.1 Flash Lite' };
  }
}

app.post('/api/analyze-message', async (req, res) => {
  try {
    const {
      inputType = 'sms',
      text = '',
      subject = '',
      imageBase64,
      mimeType,
      language = 'vi',
    } = req.body as {
      inputType: 'sms' | 'email' | 'screenshot';
      text?: string;
      subject?: string;
      imageBase64?: string;
      mimeType?: string;
      language?: Language;
    };

    if (inputType === 'screenshot' && !imageBase64) {
      return res.status(400).json({
        error:
          language === 'vi'
            ? 'Vui lòng tải lên ảnh chụp màn hình để OCR và phân tích.'
            : 'Please upload a screenshot image to OCR and analyze.',
      });
    }

    if (inputType !== 'screenshot' && !text.trim() && !subject.trim()) {
      return res.status(400).json({
        error:
          language === 'vi'
            ? 'Vui lòng nhập nội dung tin nhắn hoặc email cần kiểm tra.'
            : 'Please enter a message or email body to analyze.',
      });
    }

    const ai = getGeminiClient();
    if (!ai) {
      return res.status(503).json({
        error:
          language === 'vi'
            ? 'Chưa cấu hình GEMINI_API_KEY trên máy chủ. Vui lòng kiểm tra Settings > Secrets.'
            : 'GEMINI_API_KEY is not configured on the server. Check Settings > Secrets.',
      });
    }

    const allowedTactics = Object.keys(VERIFIABLE_RULE_CATALOG).join(', ');
    const promptInstruction = `Bạn là trợ lý an toàn số DIGITAL SOS. Hãy phân tích nội dung ${
      inputType === 'screenshot'
        ? 'trong ảnh chụp màn hình (trích xuất toàn bộ chữ OCR chính xác trước)'
        : inputType === 'email'
          ? 'email (tiêu đề và nội dung)'
          : 'tin nhắn SMS'
    }.
QUY TẮC BẮT BUỘC:
1. KHÔNG tự bịa điểm số. Chỉ xác định các mã dấu hiệu rủi ro thuộc danh sách sau nếu thực sự có bằng chứng: [${allowedTactics}].
2. Không khẳng định an toàn tuyệt đối ngay cả khi nội dung trông bình thường; hãy dùng ngôn ngữ thận trọng như "Chưa phát hiện dấu hiệu nguy hiểm".
3. Trích xuất danh sách các cụm từ/câu đáng ngờ chính xác có trong văn bản (suspiciousPhrases).
4. Giải thích rõ ràng, dễ hiểu cho học sinh, phụ huynh và giáo viên (ngôn ngữ: ${language === 'vi' ? 'Tiếng Việt' : 'English'}), kèm cả bản tóm tắt song ngữ và 3-4 khuyến nghị hành động an toàn.`;

    const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];
    if (inputType === 'screenshot' && imageBase64) {
      const cleanBase64 = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
      parts.push({
        inlineData: {
          mimeType: mimeType || 'image/png',
          data: cleanBase64,
        },
      });
    }
    parts.push({
      text: `${promptInstruction}\n\n${subject ? `Subject: ${subject}\n` : ''}${text ? `Content:\n${text}` : 'Hãy OCR toàn bộ chữ trong ảnh và phân tích.'}`,
    });

    const { result: response, modelUsed } = await generateWithModelFallback((model) =>
      ai.models.generateContent({
        model,
        contents: { parts },
        config: {
          thinkingConfig: {
            thinkingLevel:
              model === 'gemini-4-hydrogen' ? ThinkingLevel.LOW : ThinkingLevel.MINIMAL,
          },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              extractedText: {
                type: Type.STRING,
                description: 'Full OCR extracted text from screenshot, or echoed input text.',
              },
              detectedTacticIds: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: `List of matching verifiable rule IDs strictly from: ${allowedTactics}`,
              },
              suspiciousPhrases: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: 'Exact suspicious phrases, URLs, or urgent statements found in the text.',
              },
              explanationVi: { type: Type.STRING },
              explanationEn: { type: Type.STRING },
              recommendationsVi: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              recommendationsEn: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
            },
            required: [
              'extractedText',
              'detectedTacticIds',
              'suspiciousPhrases',
              'explanationVi',
              'explanationEn',
              'recommendationsVi',
              'recommendationsEn',
            ],
          },
        },
      })
    );

    const parsed = JSON.parse(response.text || '{}') as {
      extractedText?: string;
      detectedTacticIds?: string[];
      suspiciousPhrases?: string[];
      explanationVi?: string;
      explanationEn?: string;
      recommendationsVi?: string[];
      recommendationsEn?: string[];
    };

    const effectiveText =
      inputType === 'screenshot' ? parsed.extractedText || text : text;

    const heuristics = evaluateMessageHeuristics(
      effectiveText,
      subject,
      parsed.detectedTacticIds || []
    );

    const report = buildUnifiedRiskReport({
      sourceType: inputType,
      signals: heuristics.signals,
      highlightedPhrases: [
        ...heuristics.matchedPhrases,
        ...(parsed.suspiciousPhrases || []),
      ],
      explanationVi:
        parsed.explanationVi ||
        'Hệ thống đã đối chiếu nội dung với bộ quy tắc phát hiện lừa đảo và phân tích ngữ cảnh AI.',
      explanationEn:
        parsed.explanationEn ||
        'Content was evaluated against verifiable anti-scam rules and AI context analysis.',
      recommendationsVi:
        parsed.recommendationsVi && parsed.recommendationsVi.length > 0
          ? parsed.recommendationsVi
          : [
              'Không bấm vào liên kết lạ hoặc cung cấp mã OTP, mật khẩu.',
              'Xác minh lại trực tiếp qua số điện thoại hoặc kênh chính thức.',
            ],
      recommendationsEn:
        parsed.recommendationsEn && parsed.recommendationsEn.length > 0
          ? parsed.recommendationsEn
          : [
              'Do not click unknown links or share OTPs or passwords.',
              'Verify directly through official channels.',
            ],
      extractedText: inputType === 'screenshot' ? effectiveText : undefined,
      isDemo: false,
      analysisEngine: `Digital SOS Rule Engine + ${modelUsed}`,
    });

    return res.json({ report });
  } catch (err) {
    console.error('Error in /api/analyze-message:', err);
    const { status, message } = formatGeminiError(err, req.body?.language === 'en' ? 'en' : 'vi');
    return res.status(status).json({ error: message });
  }
});

app.post('/api/analyze-link', async (req, res) => {
  try {
    const { url = '', language = 'vi' } = req.body as {
      url?: string;
      language?: Language;
    };

    if (!url.trim()) {
      return res.status(400).json({
        error:
          language === 'vi'
            ? 'Vui lòng nhập đường link cần kiểm tra.'
            : 'Please enter a URL to inspect.',
      });
    }

    const ai = getGeminiClient();
    if (!ai) {
      return res.status(503).json({
        error:
          language === 'vi'
            ? 'Chưa cấu hình GEMINI_API_KEY trên máy chủ. Vui lòng kiểm tra Settings > Secrets.'
            : 'GEMINI_API_KEY is not configured on the server. Check Settings > Secrets.',
      });
    }

    const { details, signals } = analyzeUrlStructure(url);

    const { result: response, modelUsed } = await generateWithModelFallback((model) =>
      ai.models.generateContent({
        model,
        contents: `Phân tích đường link sau dưới góc độ an toàn số cho học sinh/phụ huynh:
URL gốc: ${details.originalUrl}
Hostname: ${details.hostname || 'không hợp lệ'}
Tên miền gốc (Root domain): ${details.rootDomain || 'không xác định'}
Tên miền phụ (Subdomain): ${details.subdomain || 'không có'}
Đuôi tên miền (TLD): ${details.tld || 'không rõ'}
Giao thức: ${details.protocol}
Khớp danh sách thương hiệu chính thức: ${details.isOfficialVerifiedDomain ? `Có (${details.matchedBrandName})` : 'Không'}
Các dấu hiệu kỹ thuật đã phát hiện từ bộ quy tắc: ${signals.map((s) => `${s.ruleCode}: ${s.titleVi} (${s.evidence})`).join('; ') || 'Chưa phát hiện dấu hiệu bất thường trong cấu trúc URL'}

YÊU CẦU:
1. Giải thích rõ tại sao đường link này có rủi ro hoặc chưa phát hiện dấu hiệu nguy hiểm.
2. KHÔNG BAO GIỜ khẳng định website an toàn tuyệt đối 100% (ngay cả khi không có dấu hiệu xấu).
3. Đưa ra 3 khuyến nghị hành động cụ thể bằng cả Tiếng Việt và Tiếng Anh.`,
        config: {
          thinkingConfig: {
            thinkingLevel:
              model === 'gemini-4-hydrogen' ? ThinkingLevel.LOW : ThinkingLevel.MINIMAL,
          },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              explanationVi: { type: Type.STRING },
              explanationEn: { type: Type.STRING },
              recommendationsVi: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              recommendationsEn: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
            },
            required: ['explanationVi', 'explanationEn', 'recommendationsVi', 'recommendationsEn'],
          },
        },
      })
    );

    const parsed = JSON.parse(response.text || '{}') as {
      explanationVi?: string;
      explanationEn?: string;
      recommendationsVi?: string[];
      recommendationsEn?: string[];
    };

    const report = buildUnifiedRiskReport({
      sourceType: 'link',
      signals,
      highlightedPhrases: [details.hostname, details.tld ? `.${details.tld}` : ''].filter(Boolean),
      explanationVi:
        parsed.explanationVi ||
        (signals.length > 0
          ? 'Đường link có các đặc điểm cấu trúc thường gặp trong trang giả mạo.'
          : 'Chưa phát hiện dấu hiệu nguy hiểm rõ rệt trong cấu trúc tên miền, tuy nhiên luôn thận trọng trước khi đăng nhập.'),
      explanationEn:
        parsed.explanationEn ||
        (signals.length > 0
          ? 'The URL exhibits structural traits commonly found in phishing domains.'
          : 'No immediate threat traits were found in URL structure, though absolute safety cannot be guaranteed.'),
      recommendationsVi:
        parsed.recommendationsVi && parsed.recommendationsVi.length > 0
          ? parsed.recommendationsVi
          : [
              'Kiểm tra kỹ tên miền gốc ngay trước dấu "/" đầu tiên.',
              'Không nhập mật khẩu hay OTP nếu còn nghi ngờ.',
            ],
      recommendationsEn:
        parsed.recommendationsEn && parsed.recommendationsEn.length > 0
          ? parsed.recommendationsEn
          : [
              'Inspect the root domain directly before the first "/".',
              'Never submit passwords or OTPs if unsure.',
            ],
      urlDetails: {
        ...details,
        lookupSource: `Digital SOS URL Engine + Threat Registry + ${modelUsed}`,
      },
      isDemo: false,
      analysisEngine: `Digital SOS URL Engine + ${modelUsed}`,
    });

    return res.json({ report });
  } catch (err) {
    console.error('Error in /api/analyze-link:', err);
    const { status, message } = formatGeminiError(err, req.body?.language === 'en' ? 'en' : 'vi');
    return res.status(status).json({ error: message });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const {
      messages = [],
      scanContext,
      language = 'vi',
    } = req.body as {
      messages: Array<{ role: 'user' | 'assistant'; content: string }>;
      scanContext?: ScanContextSummary | null;
      language?: Language;
    };

    if (!messages.length) {
      return res.status(400).json({
        error:
          language === 'vi'
            ? 'Vui lòng nhập câu hỏi cho trợ lý SOS.'
            : 'Please enter a question for the SOS assistant.',
      });
    }

    const ai = getGeminiClient();
    if (!ai) {
      return res.status(503).json({
        error:
          language === 'vi'
            ? 'Chưa cấu hình GEMINI_API_KEY trên máy chủ. Vui lòng kiểm tra Settings > Secrets.'
            : 'GEMINI_API_KEY is not configured on the server. Check Settings > Secrets.',
      });
    }

    const contextBlock = scanContext
      ? `\n\nNGỮ CẢNH KIỂM TRA VỪA THỰC HIỆN (người dùng nhấn "Hỏi AI cách xử lý"):
- Loại kiểm tra: ${scanContext.sourceType}
- Điểm rủi ro: ${scanContext.score}/100 (${scanContext.riskLevel})
- Tóm tắt đã che thông tin nhạy cảm: ${scanContext.redactedPreview}
- Dấu hiệu phát hiện: ${scanContext.topSignals.join('; ') || 'Không có'}
- Kết luận trước đó: ${scanContext.explanation}
Hãy tư vấn trực tiếp dựa trên ngữ cảnh này, không bắt người dùng giải thích lại từ đầu.`
      : '';

    const systemInstruction = `Bạn là SOS AI Assistant thuộc nền tảng DIGITAL SOS – Trợ lý an toàn số dành cho học sinh, phụ huynh, giáo viên và cộng đồng.
NGUYÊN TẮC TƯ VẤN:
1. Trả lời bằng ${language === 'vi' ? 'Tiếng Việt thân thiện, bình tĩnh, dễ hiểu, không quá kỹ thuật' : 'friendly, calm, plain English'}.
2. Chia hướng dẫn thành các bước hành động cụ thể theo thứ tự ưu tiên (1, 2, 3...) để người đang hoang mang làm theo được ngay.
3. Nhắc người dùng không đọc OTP, đổi mật khẩu trên kênh chính thức, bật 2FA, báo ngân hàng/giáo viên/phụ huynh hoặc cơ quan chức năng nếu đã chuyển tiền.
4. Không bao giờ khẳng định một trang web hay tin nhắn an toàn tuyệt đối 100%.${contextBlock}`;

    const historyTranscript = messages
      .slice(-8)
      .map((m) => `${m.role === 'user' ? 'Người dùng' : 'SOS AI'}: ${m.content}`)
      .join('\n\n');

    const { result: response } = await generateWithModelFallback((model) =>
      ai.models.generateContent({
        model,
        contents: historyTranscript,
        config: {
          systemInstruction,
          thinkingConfig: {
            thinkingLevel:
              model === 'gemini-4-hydrogen' ? ThinkingLevel.LOW : ThinkingLevel.MINIMAL,
          },
        },
      })
    );

    return res.json({
      reply:
        response.text ||
        (language === 'vi'
          ? 'Xin lỗi, tôi chưa thể tạo phản hồi lúc này. Vui lòng thử lại.'
          : 'Sorry, I could not generate a reply right now. Please try again.'),
    });
  } catch (err) {
    console.error('Error in /api/chat:', err);
    const { status, message } = formatGeminiError(err, req.body?.language === 'en' ? 'en' : 'vi');
    return res.status(status).json({ error: message });
  }
});

async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`DIGITAL SOS server running at http://localhost:${PORT}`);
  });
}

export default app;

// Trên Vercel không được tự listen; Vercel sẽ gọi app như một serverless function.
if (!process.env.VERCEL) {
  startServer();
}

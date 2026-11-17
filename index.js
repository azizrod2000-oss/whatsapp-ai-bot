import 'dotenv/config';
import express from 'express';
import QRCode from 'qrcode';
import pino from 'pino';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import { GoogleGenAI } from '@google/genai';

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PHONE_NUMBER = process.env.PHONE_NUMBER?.replace(/\D/g, '') || '';
const ALLOW_GROUPS = process.env.ALLOW_GROUPS === 'true';
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  'Sen WhatsApp üzerinden yardımcı olan, nazik, kısa ve anlaşılır Türkçe yanıtlar veren bir yapay zeka asistanısın.';

if (!GEMINI_API_KEY) {
  console.error('HATA: GEMINI_API_KEY ortam değişkeni tanımlı değil!');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// Her kullanıcı için son mesaj geçmişini bellekte tutar (maksimum 10 mesaj)
const chatHistories = new Map();
const MAX_HISTORY = 10;

// Web arayüzü durum değişkenleri
let botStatus = 'Başlatılıyor...';
let latestQrDataUrl = null;
let latestPairingCode = null;
let isConnected = false;

const app = express();

app.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    connected: isConnected,
    status: botStatus,
  });
});

app.get('/', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="refresh" content="5" />
  <title>WhatsApp AI Bot</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f172a;
      color: #f8fafc;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      padding: 16px;
      text-align: center;
    }
    .card {
      background: #1e293b;
      border-radius: 16px;
      padding: 24px;
      max-width: 400px;
      width: 100%;
      box-shadow: 0 10px 25px rgba(0,0,0,0.4);
    }
    .status {
      display: inline-block;
      padding: 6px 14px;
      border-radius: 999px;
      font-weight: 600;
      font-size: 14px;
      margin-bottom: 16px;
      background: ${isConnected ? '#166534' : '#854d0e'};
      color: ${isConnected ? '#bbf7d0' : '#fef08a'};
    }
    img {
      background: #fff;
      padding: 12px;
      border-radius: 12px;
      max-width: 260px;
      width: 100%;
      margin: 12px 0;
    }
    .code {
      font-size: 28px;
      font-weight: bold;
      letter-spacing: 4px;
      background: #0f172a;
      padding: 14px;
      border-radius: 10px;
      margin: 16px 0;
      color: #38bdf8;
    }
    p { color: #cbd5e1; font-size: 14px; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <h2>WhatsApp AI Bot</h2>
    <div class="status">${botStatus}</div>
    ${
      isConnected
        ? '<p>Bot şu an WhatsApp hesabınıza bağlı ve mesajlara yanıt vermeye hazır.</p>'
        : latestPairingCode
        ? `<p>WhatsApp &gt; Bağlı Cihazlar &gt; Cihaz Bağla &gt; <b>Telefon numarasıyla bağla</b> adımında bu kodu girin:</p>
           <div class="code">${latestPairingCode}</div>`
        : latestQrDataUrl
        ? `<p>WhatsApp &gt; Bağlı Cihazlar &gt; Cihaz Bağla menüsünden bu QR kodu okutun:</p>
           <img src="${latestQrDataUrl}" alt="WhatsApp QR Kodu" />`
        : '<p>Bağlantı hazırlanıyor, sayfa otomatik yenileniyor...</p>'
    }
  </div>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`Web sunucusu http://localhost:${PORT} portunda çalışıyor.`);
});

async function askGemini(chatId, userText) {
  const history = chatHistories.get(chatId) || [];
  history.push({ role: 'user', parts: [{ text: userText }] });

  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: history,
    config: {
      systemInstruction: SYSTEM_PROMPT,
    },
  });

  const replyText =
    response.text?.trim() || 'Üzgünüm, şu an yanıt oluşturamadım.';

  history.push({ role: 'model', parts: [{ text: replyText }] });
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
  chatHistories.set(chatId, history);

  return replyText;
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['WhatsApp AI Bot', 'Chrome', '1.0.0'],
  });

  // Tek telefonla QR okutamayanlar için telefon numarasıyla eşleştirme kodu
  if (PHONE_NUMBER && !sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(PHONE_NUMBER);
        latestPairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
        botStatus = 'Eşleştirme Kodu Hazır';
        console.log(`Eşleştirme Kodunuz: ${latestPairingCode}`);
      } catch (err) {
        console.error('Eşleştirme kodu alınamadı:', err.message);
      }
    }, 3000);
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !PHONE_NUMBER) {
      latestQrDataUrl = await QRCode.toDataURL(qr);
      botStatus = 'QR Kod Bekleniyor';
      isConnected = false;
      console.log('Yeni QR kod oluşturuldu. Web arayüzünden okutabilirsiniz.');
    }

    if (connection === 'open') {
      isConnected = true;
      latestQrDataUrl = null;
      latestPairingCode = null;
      botStatus = 'Bağlandı';
      console.log('WhatsApp bağlantısı başarılı!');
    }

    if (connection === 'close') {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      botStatus = shouldReconnect
        ? 'Yeniden bağlanılıyor...'
        : 'Oturum kapatıldı (Yeniden giriş gerekli)';

      console.log(
        `Bağlantı kapandı (Kod: ${statusCode}). Yeniden bağlanıyor: ${shouldReconnect}`
      );

      if (shouldReconnect) {
        setTimeout(startBot, 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const remoteJid = msg.key.remoteJid;
      if (!remoteJid || remoteJid === 'status@broadcast') continue;

      const isGroup = remoteJid.endsWith('@g.us');
      if (isGroup && !ALLOW_GROUPS) continue;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        '';

      if (!text.trim()) continue;

      // Sıfırlama komutu
      if (text.trim().toLowerCase() === '/sifirla') {
        chatHistories.delete(remoteJid);
        await sock.sendMessage(
          remoteJid,
          { text: 'Sohbet geçmişiniz sıfırlandı.' },
          { quoted: msg }
        );
        continue;
      }

      try {
        await sock.sendPresenceUpdate('composing', remoteJid);
        const reply = await askGemini(remoteJid, text.trim());
        await sock.sendMessage(remoteJid, { text: reply }, { quoted: msg });
        await sock.sendPresenceUpdate('paused', remoteJid);
      } catch (err) {
        console.error('Mesaj yanıtlanırken hata:', err.message);
        await sock.sendMessage(
          remoteJid,
          { text: 'Şu an bir hata oluştu, lütfen biraz sonra tekrar deneyin.' },
          { quoted: msg }
        );
      }
    }
  });
}

startBot().catch((err) => {
  console.error('Bot başlatma hatası:', err);
});

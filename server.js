/**
 * ChatHub WhatsApp QR Bridge Servisi
 * ====================================
 * Sunucu: Ayrı bir VPS/sunucu (Node.js 18+)
 * Port: 3001 (veya PORT env değişkeni)
 * 
 * Kurulum:
 *   npm install
 *   CHATHUB_URL=https://asyaplaystation.com/whatsapp BRIDGE_SECRET=@sifre@ node server.js
 * 
 * PM2 ile:
 *   pm2 start server.js --name wa-bridge -e 'CHATHUB_URL=https://asyaplaystation.com/whatsapp BRIDGE_SECRET=@sifre@'
 */

'use strict';

const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const QRCode  = require('qrcode');
const cors    = require('cors');
const fetch   = require('node-fetch');
const fs      = require('fs');
const path    = require('path');
const pino    = require('pino');

// ── Yapılandırma ─────────────────────────────────────────────
const PORT           = process.env.PORT           || 3001;
const CHATHUB_URL    = (process.env.CHATHUB_URL   || '').replace(/\/$/, '');
const BRIDGE_SECRET  = process.env.BRIDGE_SECRET  || '';
const SESSIONS_DIR   = process.env.SESSIONS_DIR   || path.join(__dirname, 'sessions');

if (!CHATHUB_URL) {
  console.error('❌ CHATHUB_URL ortam değişkeni zorunlu!');
  process.exit(1);
}

// ── Logger ───────────────────────────────────────────────────
const logger = pino({ level: 'info' });

// ── Express ──────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cors({ origin: '*' })); // Sadece ChatHub sunucusundan gelecek

// Basit güvenlik: Her istekte shared secret kontrol
const authMiddleware = (req, res, next) => {
  if (!BRIDGE_SECRET) return next(); // Secret tanımlı değilse atla
  const sent = req.headers['x-bridge-secret'] || req.body?.secret || req.query?.secret;
  if (sent !== BRIDGE_SECRET) {
    return res.status(401).json({ ok: false, message: 'Yetkisiz erişim' });
  }
  next();
};

// ── Session Yönetimi ─────────────────────────────────────────
const sessions = {}; // businessId => { socket, connected, qr, phone }

/**
 * Session başlat / yeniden bağlan
 */
async function startSession(businessId) {
  const bid = String(businessId);

  // Önceki socket varsa kapat
  if (sessions[bid]?.socket) {
    try { sessions[bid].socket.end(undefined); } catch(e) {}
  }

  sessions[bid] = sessions[bid] || {};
  sessions[bid].connected = false;
  sessions[bid].qr        = null;
  sessions[bid].reconnecting = true;

  const authDir = path.join(SESSIONS_DIR, bid);
  fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version }          = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }), // Baileys loglarını sustur
    browser: ['ChatHub', 'Chrome', '1.0'],
  });

  sessions[bid].socket = sock;
  sock.ev.on('creds.update', saveCreds);

  // ── Bağlantı Olayları ─────────────────────────────────────
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      try {
        const qrDataUrl = await QRCode.toDataURL(qr, { width: 280, margin: 2 });
        sessions[bid].qr        = qrDataUrl;
        sessions[bid].qr_text   = qr; // Raw QR text
        sessions[bid].connected = false;
        sessions[bid].qr_ts     = Date.now();
        logger.info({ bid }, 'QR üretildi');
      } catch (e) {
        logger.error(e, 'QR oluşturma hatası');
      }
    }

    if (connection === 'open') {
      sessions[bid].connected = true;
      sessions[bid].qr        = null;
      sessions[bid].reconnecting = false;
      sessions[bid].phone     = sock.user?.id?.split(':')[0] || '';
      logger.info({ bid, phone: sessions[bid].phone }, 'WhatsApp bağlandı');

      // ChatHub'a bildir
      await chatHubCallback(bid, {
        event:     'connected',
        connected: true,
        phone:     sessions[bid].phone,
      });
    }

    if (connection === 'close') {
      sessions[bid].connected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut  = statusCode === DisconnectReason.loggedOut;
      logger.info({ bid, statusCode, loggedOut }, 'Bağlantı kapandı');

      if (loggedOut) {
        // Oturum dosyalarını temizle
        fs.rmSync(path.join(SESSIONS_DIR, bid), { recursive: true, force: true });
        await chatHubCallback(bid, { event: 'logged_out', connected: false });
        delete sessions[bid];
      } else {
        // Yeniden bağlan (5 saniye sonra)
        logger.info({ bid }, '5sn sonra yeniden bağlanıyor...');
        setTimeout(() => startSession(bid), 5000);
        await chatHubCallback(bid, { event: 'disconnected', connected: false });
      }
    }
  });

  // ── Gelen Mesajlar ────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const from    = msg.key.remoteJid || '';
      const isGroup = from.endsWith('@g.us');
      if (isGroup) continue; // Grup mesajlarını atla

      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        '';

      const phone = from.replace('@s.whatsapp.net', '').replace(/[^0-9]/g, '');

      await chatHubMessage(bid, {
        from:      phone,
        text:      text.trim(),
        timestamp: msg.messageTimestamp,
        msgId:     msg.key.id,
      });
    }
  });

  return sock;
}

/**
 * ChatHub'a callback gönder
 */
async function chatHubCallback(businessId, data) {
  if (!CHATHUB_URL) return;
  try {
    await fetch(`${CHATHUB_URL}/api/wa-bridge-callback`, {
      method:  'POST',
      headers: {
        'Content-Type':    'application/json',
        'X-Bridge-Secret': BRIDGE_SECRET,
      },
      body: JSON.stringify({ businessId, ...data }),
      timeout: 8000,
    });
  } catch (e) {
    logger.warn({ businessId, err: e.message }, 'ChatHub callback hatası');
  }
}

/**
 * ChatHub'a gelen mesajı ilet
 */
async function chatHubMessage(businessId, data) {
  if (!CHATHUB_URL) return;
  try {
    await fetch(`${CHATHUB_URL}/api/wa-bridge-message`, {
      method:  'POST',
      headers: {
        'Content-Type':    'application/json',
        'X-Bridge-Secret': BRIDGE_SECRET,
      },
      body: JSON.stringify({ businessId, message: data }),
      timeout: 8000,
    });
  } catch (e) {
    logger.warn({ businessId, err: e.message }, 'ChatHub mesaj iletme hatası');
  }
}

// ── API Endpoint'leri ─────────────────────────────────────────

/**
 * Sağlık kontrolü
 * GET /health
 */
app.get('/health', (req, res) => {
  res.json({
    ok:       true,
    uptime:   Math.floor(process.uptime()),
    sessions: Object.keys(sessions).length,
    chathub:  CHATHUB_URL,
  });
});

/**
 * QR Başlat
 * POST /qr/start
 * Body: { businessId }
 */
app.post('/qr/start', authMiddleware, async (req, res) => {
  const businessId = String(req.body.businessId || '');
  if (!businessId) return res.json({ ok: false, message: 'businessId zorunlu' });

  const session = sessions[businessId];

  // Zaten bağlıysa haber ver
  if (session?.connected) {
    return res.json({ ok: true, bagli: true, phone: session.phone || '' });
  }

  try {
    await startSession(businessId);

    // QR oluşması için max 6 saniye bekle
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (sessions[businessId]?.qr) break;
    }

    const qr = sessions[businessId]?.qr || null;
    res.json({ ok: true, qr, bagli: false });
  } catch (e) {
    logger.error(e, 'QR başlatma hatası');
    res.json({ ok: false, message: e.message });
  }
});

/**
 * QR Durumu
 * GET /qr/status/:businessId
 */
app.get('/qr/status/:businessId', authMiddleware, (req, res) => {
  const bid     = String(req.params.businessId);
  const session = sessions[bid];

  if (!session) {
    return res.json({ ok: true, bagli: false, qr: null, durum: 'yok' });
  }

  // QR 60 saniyeden eskiyse yenile gerek
  const qrFresh = session.qr && (Date.now() - (session.qr_ts || 0)) < 60000;

  res.json({
    ok:    true,
    bagli: session.connected || false,
    qr:    qrFresh ? session.qr : null,
    phone: session.phone || '',
    durum: session.connected ? 'bagli' : (session.qr ? 'qr_bekleniyor' : 'baglaniyor'),
  });
});

/**
 * Mesaj Gönder
 * POST /send
 * Body: { businessId, to, message }
 */
app.post('/send', authMiddleware, async (req, res) => {
  const { businessId, to, message } = req.body;
  if (!businessId || !to || !message) {
    return res.json({ ok: false, message: 'businessId, to ve message zorunlu' });
  }

  const session = sessions[String(businessId)];
  if (!session?.connected || !session.socket) {
    return res.json({ ok: false, message: 'Oturum yok veya bağlı değil' });
  }

  try {
    const phone = String(to).replace(/[^0-9]/g, '');
    // Türkiye numaraları 90 ile başlamalı
    const jid = (phone.startsWith('90') ? phone : '90' + phone.replace(/^0/, '')) + '@s.whatsapp.net';
    await session.socket.sendMessage(jid, { text: String(message) });
    res.json({ ok: true });
  } catch (e) {
    logger.error(e, 'Mesaj gönderme hatası');
    res.json({ ok: false, message: e.message });
  }
});

/**
 * Oturumu Kapat / Çıkış Yap
 * POST /logout/:businessId
 */
app.post('/logout/:businessId', authMiddleware, async (req, res) => {
  const bid     = String(req.params.businessId);
  const session = sessions[bid];

  if (session?.socket) {
    try { await session.socket.logout(); } catch (e) {}
  }

  // Session dosyalarını temizle
  fs.rmSync(path.join(SESSIONS_DIR, bid), { recursive: true, force: true });
  delete sessions[bid];

  res.json({ ok: true });
});

/**
 * Tüm Aktif Oturumlar
 * GET /sessions
 */
app.get('/sessions', authMiddleware, (req, res) => {
  const list = Object.entries(sessions).map(([bid, s]) => ({
    businessId: bid,
    connected:  s.connected || false,
    phone:      s.phone || '',
    qr:         !!s.qr,
  }));
  res.json({ ok: true, sessions: list });
});

// ── Sunucu Başlat ────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info({ port: PORT, chathub: CHATHUB_URL }, '✅ WA Bridge çalışıyor');
  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ChatHub WA Bridge v1.0
  Port    : ${PORT}
  ChatHub : ${CHATHUB_URL}
  Secret  : ${BRIDGE_SECRET ? '✅ Aktif' : '⚠️ Yok (güvensiz)'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
});

// Çöküşlerde yeniden başlatma için
process.on('uncaughtException', (e) => logger.error(e, 'uncaughtException'));
process.on('unhandledRejection', (e) => logger.error(e, 'unhandledRejection'));

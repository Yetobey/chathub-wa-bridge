const sock = makeWASocket({
  version,
  auth: state,
  printQRInTerminal: false,
  logger: pino({ level: 'warn' }), // 'silent' yerine 'warn'
  browser: ['Ubuntu', 'Chrome', '120.0.0.0'], // Daha modern browser
  shouldSyncHistoryMessage: false,
  syncFullHistory: false,
  markOnlineOnConnect: true,
  connectTimeoutMs: 30000, // 30 saniye timeout
});

// Retry logic ekle
let retryCount = 0;
const maxRetries = 5;
const retryDelays = [5000, 10000, 20000, 30000, 60000]; // 5s, 10s, 20s, 30s, 60s

sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
  if (qr) {
    try {
      const qrDataUrl = await QRCode.toDataURL(qr, { width: 280, margin: 2 });
      sessions[bid].qr = qrDataUrl;
      sessions[bid].qr_text = qr;
      sessions[bid].connected = false;
      sessions[bid].qr_ts = Date.now();
      retryCount = 0; // QR gelince retry counter sıfırla
      logger.info({ bid }, 'QR üretildi');
    } catch (e) {
      logger.error(e, 'QR oluşturma hatası');
    }
  }

  if (connection === 'open') {
    sessions[bid].connected = true;
    sessions[bid].qr = null;
    sessions[bid].reconnecting = false;
    sessions[bid].phone = sock.user?.id?.split(':')[0] || '';
    retryCount = 0;
    logger.info({ bid, phone: sessions[bid].phone }, 'WhatsApp bağlandı');
    await chatHubCallback(bid, {
      event: 'connected',
      connected: true,
      phone: sessions[bid].phone,
    });
  }

  if (connection === 'close') {
    sessions[bid].connected = false;
    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const loggedOut = statusCode === DisconnectReason.loggedOut;
    logger.info({ bid, statusCode, loggedOut, retryCount }, 'Bağlantı kapandı');
    
    if (loggedOut) {
      fs.rmSync(path.join(SESSIONS_DIR, bid), { recursive: true, force: true });
      await chatHubCallback(bid, { event: 'logged_out', connected: false });
      delete sessions[bid];
      retryCount = 0;
    } else {
      if (retryCount < maxRetries) {
        const delay = retryDelays[retryCount];
        logger.info({ bid, retryCount, delay }, `${delay/1000}sn sonra yeniden bağlanıyor...`);
        setTimeout(() => startSession(bid), delay);
        retryCount++;
      } else {
        logger.error({ bid }, 'Max retry sayısına ulaşıldı. Session siliniyor.');
        fs.rmSync(path.join(SESSIONS_DIR, bid), { recursive: true, force: true });
        delete sessions[bid];
        retryCount = 0;
      }
      await chatHubCallback(bid, { event: 'disconnected', connected: false });
    }
  }
});

// Error handler ekle
sock.ev.on('error', (err) => {
  logger.error({ bid, err }, 'Socket error');
});

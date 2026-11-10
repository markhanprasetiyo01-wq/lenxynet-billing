const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const AUTH_DIR = path.join(__dirname, 'wa_session');
if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

let sock = null;
let currentQR = null;
let connectionStatus = 'disconnected'; // 'disconnected', 'connecting', 'connected'
let isInitializing = false;
let reconnectTimer = null;

function scheduleReconnect(delayMs) {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    initWhatsApp();
  }, delayMs);
}

async function initWhatsApp() {
  if (isInitializing) return;
  isInitializing = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  try {
    if (sock) {
      try { sock.ev.removeAllListeners(); } catch (e) {}
      try { sock.end(); } catch (e) {}
      sock = null;
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['LenxyNet Billing', 'Chrome', '1.0.0'],
      connectTimeoutMs: 30000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          currentQR = await QRCode.toDataURL(qr);
        } catch (e) {}
        connectionStatus = 'connecting';
        try { db.prepare("UPDATE settings SET value = 'connecting' WHERE key = 'wa_status'").run(); } catch (e) {}
        console.log('[WhatsApp] QR Code siap untuk di-scan!');
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isReplaced = statusCode === 440;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const shouldReconnect = !isLoggedOut && !isReplaced;
        console.log(`[WhatsApp] Koneksi terputus. Kode status: ${statusCode}. Reconnect: ${shouldReconnect}`);

        connectionStatus = 'disconnected';
        currentQR = null;
        try { db.prepare("UPDATE settings SET value = 'disconnected' WHERE key = 'wa_status'").run(); } catch (e) {}

        if (isReplaced) {
          console.log('[WhatsApp] Sesi digantikan oleh perangkat lain (kode 440 / connection replaced). Auto-reconnect dijeda.');
        } else if (shouldReconnect) {
          scheduleReconnect(5000);
        } else {
          // Logged out: bersihkan folder sesi
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            fs.mkdirSync(AUTH_DIR, { recursive: true });
          } catch (e) {}
          scheduleReconnect(3000);
        }
      } else if (connection === 'open') {
        console.log('✅ [WhatsApp] Bot Baileys berhasil TERHUBUNG!');
        connectionStatus = 'connected';
        currentQR = null;
        try { db.prepare("UPDATE settings SET value = 'connected' WHERE key = 'wa_status'").run(); } catch (e) {}
      }
    });

  } catch (err) {
    console.error('[WhatsApp] Init error:', err.message);
    scheduleReconnect(10000);
  } finally {
    isInitializing = false;
  }
}

// Standardisasi format nomor lokal (08xxxxxxxxx)
function normalizePhoneLocal(phone) {
  if (!phone || phone === '-') return '-';
  let cleaned = String(phone).replace(/\D/g, '');
  if (cleaned.startsWith('62')) {
    cleaned = '0' + cleaned.substring(2);
  } else if (cleaned.startsWith('8')) {
    cleaned = '0' + cleaned;
  }
  return cleaned;
}

// Format nomor telepon ke standar WhatsApp internasional (contoh 0858... -> 62858...@s.whatsapp.net)
function formatPhoneNumber(phone) {
  let cleaned = String(phone).replace(/\D/g, '');
  if (cleaned.startsWith('0')) {
    cleaned = '62' + cleaned.substring(1);
  } else if (!cleaned.startsWith('62')) {
    cleaned = '62' + cleaned;
  }
  return cleaned + '@s.whatsapp.net';
}

// Fungsi Kirim Pesan Teks
async function sendWhatsAppMessage(phone, text) {
  if (connectionStatus !== 'connected' || !sock) {
    console.warn(`[WhatsApp] Gagal kirim ke ${phone}: Bot belum terhubung.`);
    return { success: false, error: 'Bot WhatsApp belum terhubung' };
  }

  try {
    const jid = formatPhoneNumber(phone);
    await sock.sendMessage(jid, { text: text });
    console.log(`[WhatsApp] Pesan sukses terkirim ke ${phone}`);
    return { success: true };
  } catch (err) {
    console.error(`[WhatsApp] Gagal mengirim pesan ke ${phone}:`, err.message);
    return { success: false, error: err.message };
  }
}

// Fungsi Kirim Notifikasi ke Admin (Kirim ke Diri Sendiri / Message Yourself & Nomor Admin)
async function sendNotificationToAdmin(text) {
  if (connectionStatus !== 'connected' || !sock) {
    console.warn('[WhatsApp] Bot belum terhubung, tidak dapat mengirim notifikasi admin.');
    return { success: false, error: 'Bot belum terhubung' };
  }

  const targetJids = new Set();

  // 1. Kirim ke Diri Sendiri (Nomor bot WhatsApp yang sedang login / scan QR)
  if (sock.user && sock.user.id) {
    const selfNum = sock.user.id.split(':')[0].split('@')[0];
    if (selfNum) {
      targetJids.add(selfNum + '@s.whatsapp.net');
    }
  }

  // 2. Kirim ke nomor WhatsApp admin tambahan jika dikonfigurasi di Pengaturan
  const adminPhoneSetting = db.prepare("SELECT value FROM settings WHERE key = 'admin_wa_number'").get()?.value;
  if (adminPhoneSetting && adminPhoneSetting.trim() !== '') {
    targetJids.add(formatPhoneNumber(adminPhoneSetting.trim()));
  }

  let sentCount = 0;
  for (const jid of targetJids) {
    try {
      await sock.sendMessage(jid, { text: text });
      console.log(`[WhatsApp] Notifikasi QRIS sukses terkirim ke: ${jid}`);
      sentCount++;
    } catch (err) {
      console.error(`[WhatsApp] Gagal mengirim notifikasi admin ke ${jid}:`, err.message);
    }
  }

  return { success: sentCount > 0, sentCount };
}

// Template 1: Reminder H-3 Sebelum Jatuh Tempo (Dinamis dari Database)
async function sendReminderHMinus3(customer, bill, portalUrl) {
  const template = db.getMessageTemplate('reminder_hminus3');
  const message = template
    .replace(/{nama}/gi, customer.name || 'Pelanggan')
    .replace(/{name}/gi, customer.name || 'Pelanggan')
    .replace(/{username}/gi, customer.pppoe_username || '-')
    .replace(/{paket}/gi, customer.plan_name || 'Internet PPPoE')
    .replace(/{jatuh_tempo}/gi, String(customer.due_date || '10'))
    .replace(/{nominal}/gi, `Rp ${Number(bill.amount).toLocaleString('id-ID')}`)
    .replace(/{portal_url}/gi, portalUrl);

  return await sendWhatsAppMessage(customer.phone, message);
}

// Template 2: Reminder H+1 Setelah Jatuh Tempo (Dinamis dari Database)
async function sendReminderHPlus1(customer, bill, toleranceDays, portalUrl) {
  const template = db.getMessageTemplate('reminder_hplus1');
  const message = template
    .replace(/{nama}/gi, customer.name || 'Pelanggan')
    .replace(/{name}/gi, customer.name || 'Pelanggan')
    .replace(/{username}/gi, customer.pppoe_username || '-')
    .replace(/{paket}/gi, customer.plan_name || 'Internet PPPoE')
    .replace(/{jatuh_tempo}/gi, String(customer.due_date || '10'))
    .replace(/{nominal}/gi, `Rp ${Number(bill.amount).toLocaleString('id-ID')}`)
    .replace(/{toleransi}/gi, String(toleranceDays || 1))
    .replace(/{portal_url}/gi, portalUrl);

  return await sendWhatsAppMessage(customer.phone, message);
}

// Template 3: Ucapan Terima Kasih Saat Sudah Benar-Benar Membayar (LUNAS) (Dinamis dari Database)
async function sendPaymentSuccessNotice(customer, bill) {
  const periodText = bill.durationMonths && bill.durationMonths > 1 
    ? `${bill.period} (${bill.durationMonths} Bulan Sekaligus)`
    : bill.period;

  const template = db.getMessageTemplate('payment_success');
  const message = template
    .replace(/{nama}/gi, customer.name || 'Pelanggan')
    .replace(/{name}/gi, customer.name || 'Pelanggan')
    .replace(/{username}/gi, customer.pppoe_username || '-')
    .replace(/{paket}/gi, customer.plan_name || 'Internet PPPoE')
    .replace(/{durasi}/gi, periodText)
    .replace(/{periode}/gi, periodText)
    .replace(/{nominal}/gi, `Rp ${Number(bill.amount).toLocaleString('id-ID')}`)
    .replace(/{metode}/gi, bill.payment_method || 'QRIS Instan');

  return await sendWhatsAppMessage(customer.phone, message);
}

// Template 4: Info Layanan, Daftar Paket & Event Promosi (Dinamis dari Database)
async function sendPromoNotice(customer, customMessage, plansList, portalUrl) {
  const template = customMessage || db.getMessageTemplate('promo_general');

  const message = template
    .replace(/{nama}/gi, customer.name || 'Pelanggan')
    .replace(/{name}/gi, customer.name || 'Pelanggan')
    .replace(/{username}/gi, customer.pppoe_username || '-')
    .replace(/{portal_url}/gi, portalUrl)
    .replace(/{plans}/gi, plansList || '• Paket Hemat LenxyNet Fiber');

  return await sendWhatsAppMessage(customer.phone, message);
}

function getWAStatus() {
  return {
    status: connectionStatus,
    qr: currentQR
  };
}

async function logoutWhatsApp() {
  try {
    if (sock) {
      try { sock.ev.removeAllListeners(); } catch (e) {}
      try { await sock.logout(); } catch (e) {}
      try { sock.end(); } catch (e) {}
      sock = null;
    }
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    connectionStatus = 'disconnected';
    currentQR = null;
    db.prepare("UPDATE settings SET value = 'disconnected' WHERE key = 'wa_status'").run();
    scheduleReconnect(2000);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

module.exports = {
  initWhatsApp,
  getWAStatus,
  formatPhoneNumber,
  normalizePhoneLocal,
  sendWhatsAppMessage,
  sendNotificationToAdmin,
  sendReminderHMinus3,
  sendReminderHPlus1,
  sendPaymentSuccessNotice,
  sendPromoNotice,
  logoutWhatsApp
};


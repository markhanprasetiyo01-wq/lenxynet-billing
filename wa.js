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

async function initWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['LenxyNet Billing', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQR = await QRCode.toDataURL(qr);
        connectionStatus = 'connecting';
        db.prepare("UPDATE settings SET value = 'connecting' WHERE key = 'wa_status'").run();
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
        db.prepare("UPDATE settings SET value = 'disconnected' WHERE key = 'wa_status'").run();

        if (isReplaced) {
          console.log('[WhatsApp] Sesi digantikan oleh perangkat lain (kode 440 / connection replaced). Auto-reconnect dijeda.');
        } else if (shouldReconnect) {
          setTimeout(initWhatsApp, 5000);
        } else {
          // Logged out: bersihkan folder sesi
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          } catch(e) {}
          setTimeout(initWhatsApp, 3000);
        }
      } else if (connection === 'open') {
        console.log('✅ [WhatsApp] Bot Baileys berhasil TERHUBUNG!');
        connectionStatus = 'connected';
        currentQR = null;
        db.prepare("UPDATE settings SET value = 'connected' WHERE key = 'wa_status'").run();
      }
    });

  } catch (err) {
    console.error('[WhatsApp] Init error:', err.message);
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

// Template 1: Reminder H-3 Sebelum Jatuh Tempo
async function sendReminderHMinus3(customer, bill, portalUrl) {
  const message = `Halo Bapak/Ibu *${customer.name}*,

Pemberitahuan dari *LenxyNet Fiber*.
Tagihan internet bulanan Anda akan jatuh tempo dalam *3 hari lagi*:

📄 *Detail Tagihan:*
• Nama Pelanggan: *Bapak/Ibu ${customer.name}*
• Paket: *${customer.plan_name || 'Internet PPPoE'}*
• Jatuh Tempo: *Tgl ${customer.due_date}*
• Total Tagihan: *Rp ${Number(bill.amount).toLocaleString('id-ID')}*

Silakan lakukan pembayaran lebih awal agar terhindar dari pemutusan layanan otomatis. Anda dapat membayar langsung via QRIS melalui tautan berikut:
👉 ${portalUrl}

💡 _Tips: Jika tautan di atas belum bisa diklik, simpan nomor ini ke kontak atau balas pesan ini (ketik OK)._

Terima kasih atas kerja samanya.
_Customer Service LenxyNet_`;

  return await sendWhatsAppMessage(customer.phone, message);
}

// Template 2: Reminder H+1 Setelah Jatuh Tempo (Keterlambatan & Peringatan Isolir)
async function sendReminderHPlus1(customer, bill, toleranceDays, portalUrl) {
  const message = `PEMBERITAHUAN KETERLAMBATAN
Kepada Yth. Bapak/Ibu *${customer.name}*,

Tagihan internet *LenxyNet* Anda telah melewati tanggal jatuh tempo (Tgl ${customer.due_date}).

📄 *Rincian Tagihan Tertunggak:*
• Total: *Rp ${Number(bill.amount).toLocaleString('id-ID')}*
• Masa Toleransi: *${toleranceDays} Hari*

⚠️ *Peringatan:* Jika pembayaran belum diselesaikan hingga masa toleransi berakhir, sistem kami akan melakukan *pemutusan koneksi internet otomatis (Isolir)*.

Bayar sekarang menggunakan QRIS instan:
👉 ${portalUrl}

💡 _Tips: Jika tautan di atas belum bisa diklik, simpan nomor ini ke kontak atau balas pesan ini (ketik OK)._

Abaikan pesan ini jika Anda sudah melakukan pembayaran.
_Layanan Pelanggan LenxyNet_`;

  return await sendWhatsAppMessage(customer.phone, message);
}

// Template 3: Ucapan Terima Kasih Saat Sudah Benar-Benar Membayar (LUNAS)
async function sendPaymentSuccessNotice(customer, bill) {
  const periodText = bill.durationMonths && bill.durationMonths > 1 
    ? `${bill.period} (${bill.durationMonths} Bulan Sekaligus)`
    : bill.period;

  const message = `PEMBAYARAN BERHASIL & DITERIMA ✅
Halo Bapak/Ibu *${customer.name}*,

Terima kasih! Pembayaran tagihan internet *LenxyNet* Anda telah kami terima:

📄 *Bukti Pembayaran:*
• ID Pelanggan: *${customer.pppoe_username}*
• Paket: *${customer.plan_name || 'Internet PPPoE'}*
• Durasi / Periode: *${periodText}*
• Total Bayar: *Rp ${Number(bill.amount).toLocaleString('id-ID')}*
• Metode: *${bill.payment_method || 'QRIS Instan'}*
• Status: *LUNAS*

Layanan internet Anda aktif normal hingga masa aktif berikutnya. Selamat menikmati koneksi internet berkecepatan tinggi dari LenxyNet!

_Salam hangat, Tim LenxyNet Fiber_`;

  return await sendWhatsAppMessage(customer.phone, message);
}

// Template 4: Info Layanan, Daftar Paket & Event Promosi (Bisa dicustom)
async function sendPromoNotice(customer, customMessage, plansList, portalUrl) {
  let message = customMessage;
  if (!message) {
    message = `Halo Bapak/Ibu *{name}*, dapatkan promo internet terbaik di {portal_url}!`;
  }

  // Replace variable placeholders
  message = message
    .replace(/{name}/g, customer.name || 'Pelanggan')
    .replace(/{username}/g, customer.pppoe_username || '-')
    .replace(/{portal_url}/g, portalUrl)
    .replace(/{plans}/g, plansList || '• Paket Hemat LenxyNet Fiber');

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
      await sock.logout();
    }
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    connectionStatus = 'disconnected';
    currentQR = null;
    db.prepare("UPDATE settings SET value = 'disconnected' WHERE key = 'wa_status'").run();
    setTimeout(initWhatsApp, 2000);
    return { success: true };
  } catch(e) {
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


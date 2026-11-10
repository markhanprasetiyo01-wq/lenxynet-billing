const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const dbPath = path.join(__dirname, 'database.sqlite');
const db = new DatabaseSync(dbPath);

// Optimasi & Proteksi SQLite untuk Server 24/7 (STB HG680P eMMC & Anti-Korup Mati Lampu)
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`);

// Initialize Tables
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    profile TEXT NOT NULL,
    price INTEGER NOT NULL,
    speed TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT DEFAULT '-',
    pppoe_username TEXT NOT NULL UNIQUE,
    pppoe_password TEXT NOT NULL,
    plan_id INTEGER,
    due_date INTEGER DEFAULT 10,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(plan_id) REFERENCES plans(id)
  );

  CREATE TABLE IF NOT EXISTS bills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    period TEXT NOT NULL, -- e.g. '2026-11'
    amount INTEGER NOT NULL,
    status TEXT DEFAULT 'unpaid', -- 'unpaid' or 'paid'
    paid_at DATETIME,
    payment_method TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(customer_id) REFERENCES customers(id)
  );

  CREATE TABLE IF NOT EXISTS otp_codes (
    phone TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    customer_id INTEGER NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS activity_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL, -- e.g. 'PAYMENT', 'ISOLIR', 'UNISOLIR', 'WA_SENT', 'CONFIG_CHANGE'
    details TEXT NOT NULL,
    target TEXT, -- e.g. username pelanggan atau sistem
    status TEXT DEFAULT 'success', -- 'success' or 'failed'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS admin_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    customer_id INTEGER NOT NULL,
    pppoe_username TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(customer_id) REFERENCES customers(id)
  );
`);

// Migrasi skema kolom baru pada otp_codes jika belum ada
try {
  db.exec("ALTER TABLE otp_codes ADD COLUMN attempts INTEGER DEFAULT 0;");
} catch (e) {}
try {
  db.exec("ALTER TABLE otp_codes ADD COLUMN last_requested_at DATETIME DEFAULT CURRENT_TIMESTAMP;");
} catch (e) {}

// Migrasi skema kolom baru pada bills untuk verifikasi QRIS Statis Toko
try {
  db.exec("ALTER TABLE bills ADD COLUMN proof_image TEXT;");
} catch (e) {}
try {
  db.exec("ALTER TABLE bills ADD COLUMN proof_uploaded_at DATETIME;");
} catch (e) {}
try {
  db.exec("ALTER TABLE bills ADD COLUMN rejection_reason TEXT;");
} catch (e) {}
try {
  db.exec("ALTER TABLE bills ADD COLUMN duration_months INTEGER DEFAULT 1;");
} catch (e) {}
try {
  db.exec("ALTER TABLE bills ADD COLUMN last_hminus3_sent TEXT;");
} catch (e) {}
try {
  db.exec("ALTER TABLE bills ADD COLUMN last_hplus1_sent TEXT;");
} catch (e) {}
try {
  db.exec("ALTER TABLE customers ADD COLUMN comment TEXT;");
} catch (e) {}

// Index untuk performa jangka panjang (ribuan pelanggan & transaksi bertahun-tahun)
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_bills_customer_period ON bills(customer_id, period);
  CREATE INDEX IF NOT EXISTS idx_bills_status ON bills(status);
  CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
  CREATE INDEX IF NOT EXISTS idx_customers_status ON customers(status);
  CREATE INDEX IF NOT EXISTS idx_activity_logs_created ON activity_logs(created_at);
`);

// Seed default settings if empty
const checkSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const insertSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');

if (!checkSetting.get('tolerance_days')) {
  insertSetting.run('tolerance_days', '3'); // Toleransi default 3 hari
}
if (!checkSetting.get('router_ip')) {
  insertSetting.run('router_ip', '');
}
if (!checkSetting.get('router_user')) {
  insertSetting.run('router_user', '');
}
if (!checkSetting.get('router_pass')) {
  insertSetting.run('router_pass', '');
}
if (!checkSetting.get('router_port')) {
  insertSetting.run('router_port', '8728');
}
if (!checkSetting.get('router_connected')) {
  insertSetting.run('router_connected', 'false');
}
if (!checkSetting.get('admin_username')) {
  insertSetting.run('admin_username', 'admin');
}
if (!checkSetting.get('admin_password')) {
  insertSetting.run('admin_password', 'admin123'); // Default password admin
}
if (!checkSetting.get('wa_status')) {
  insertSetting.run('wa_status', 'disconnected');
}
if (!checkSetting.get('mock_payment_enabled')) {
  insertSetting.run('mock_payment_enabled', 'false');
} else {
  db.prepare("UPDATE settings SET value = 'false' WHERE key = 'mock_payment_enabled'").run();
}
if (!checkSetting.get('qris_image')) {
  insertSetting.run('qris_image', '/uploads/qris/default-qris.png');
}
if (!checkSetting.get('admin_wa_number')) {
  insertSetting.run('admin_wa_number', '');
}
if (!checkSetting.get('public_portal_url')) {
  insertSetting.run('public_portal_url', '');
}
if (!checkSetting.get('telegram_bot_token')) {
  insertSetting.run('telegram_bot_token', '');
}
if (!checkSetting.get('telegram_chat_id')) {
  insertSetting.run('telegram_chat_id', '');
}
if (!checkSetting.get('telegram_backup_enabled')) {
  insertSetting.run('telegram_backup_enabled', 'false');
}
if (!checkSetting.get('cron_enabled')) {
  insertSetting.run('cron_enabled', 'true');
}
if (!checkSetting.get('promo_template')) {
  const defaultPromo = `Halo *{name}*! 👋

Ada kabar gembira dan info menarik dari *LenxyNet Fiber* 🚀
Nikmati koneksi internet rumah super cepat, stabil, dan tanpa batas kuota (True Unlimited)!

🔥 *DAFTAR PAKET SPESIAL LENXYNET:*
{plans}

✨ *Keunggulan Layanan LenxyNet:*
• 100% Fiber Optic murni
• Ping rendah & stabil untuk gaming/streaming
• Dukungan Customer Support 24/7
• Pembayaran mudah via QRIS otomatis

Yuk cek status akun atau upgrade paket internet Anda langsung di portal pelanggan:
👉 {portal_url}

_Terima kasih telah menjadi bagian dari keluarga LenxyNet Fiber!_`;
  insertSetting.run('promo_template', defaultPromo);
}

// Seed default plans if empty
const countPlans = db.prepare('SELECT COUNT(*) as count FROM plans').get();
if (countPlans.count === 0) {
  const insertPlan = db.prepare('INSERT INTO plans (name, profile, price, speed) VALUES (?, ?, ?, ?)');
  insertPlan.run('Paket 150rb/10Mbps', 'Paket 150rb/10Mbps', 150000, '10M /10M');
}

// === TABEL TEMPLATE PESAN WHATSAPP & BROADCAST ===
db.exec(`
  CREATE TABLE IF NOT EXISTS message_templates (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    category TEXT NOT NULL, -- 'system', 'notice', 'promo'
    content TEXT NOT NULL,
    variables TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

const DEFAULT_MESSAGE_TEMPLATES = [
  {
    id: 'reminder_hminus3',
    title: 'Pengingat H-3 Sebelum Jatuh Tempo',
    category: 'system',
    variables: '{nama}, {username}, {paket}, {jatuh_tempo}, {nominal}, {portal_url}',
    content: `Halo Bapak/Ibu *{nama}*,

Pemberitahuan dari *LenxyNet Fiber*.
Tagihan internet bulanan Anda akan jatuh tempo dalam *3 hari lagi*:

📄 *Detail Tagihan:*
• Nama Pelanggan: *Bapak/Ibu {nama}*
• Paket: *{paket}*
• Jatuh Tempo: *Tgl {jatuh_tempo}*
• Total Tagihan: *{nominal}*

Silakan lakukan pembayaran lebih awal agar terhindar dari pemutusan layanan otomatis. Anda dapat membayar langsung via QRIS melalui tautan berikut:
👉 {portal_url}

💡 _Tips: Jika tautan di atas belum bisa diklik, simpan nomor ini ke kontak atau balas pesan ini (ketik OK)._

Terima kasih atas kerja samanya.
_Customer Service LenxyNet_`
  },
  {
    id: 'reminder_hplus1',
    title: 'Pengingat H+1 Jatuh Tempo (Keterlambatan & Peringatan Isolir)',
    category: 'system',
    variables: '{nama}, {username}, {paket}, {jatuh_tempo}, {nominal}, {toleransi}, {portal_url}',
    content: `PEMBERITAHUAN KETERLAMBATAN
Kepada Yth. Bapak/Ibu *{nama}*,

Tagihan internet *LenxyNet* Anda telah melewati tanggal jatuh tempo (Tgl {jatuh_tempo}).

📄 *Rincian Tagihan Tertunggak:*
• Total: *{nominal}*
• Masa Toleransi: *{toleransi} Hari*

⚠️ *Peringatan:* Jika pembayaran belum diselesaikan hingga masa toleransi berakhir, sistem kami akan melakukan *pemutusan koneksi internet otomatis (Isolir)*.

Bayar sekarang menggunakan QRIS instan:
👉 {portal_url}

💡 _Tips: Jika tautan di atas belum bisa diklik, simpan nomor ini ke kontak atau balas pesan ini (ketik OK)._

Abaikan pesan ini jika Anda sudah melakukan pembayaran.
_Layanan Pelanggan LenxyNet_`
  },
  {
    id: 'payment_success',
    title: 'Struk Bukti Pembayaran Lunas',
    category: 'system',
    variables: '{nama}, {username}, {paket}, {periode}, {nominal}, {metode}',
    content: `PEMBAYARAN BERHASIL & DITERIMA ✅
Halo Bapak/Ibu *{nama}*,

Terima kasih! Pembayaran tagihan internet *LenxyNet* Anda telah kami terima:

📄 *Bukti Pembayaran:*
• ID Pelanggan: *{username}*
• Paket: *{paket}*
• Durasi / Periode: *{periode}*
• Total Bayar: *{nominal}*
• Metode: *{metode}*
• Status: *LUNAS*

Layanan internet Anda aktif normal hingga masa aktif berikutnya. Selamat menikmati koneksi internet berkecepatan tinggi dari LenxyNet!

_Salam hangat, Tim LenxyNet Fiber_`
  },
  {
    id: 'otp',
    title: 'Kode OTP Verifikasi Login Pelanggan',
    category: 'system',
    variables: '{nama}, {otp}',
    content: `*KODE VERIFIKASI LENXYNET* 🔐
Halo Bapak/Ibu *{nama}*,

Kode OTP untuk masuk ke Portal Pelanggan Anda adalah:
👉 *${'{otp}'}*

_Kode ini bersifat rahasia dan hanya berlaku selama 5 menit. Jangan berikan kode ini kepada siapa pun demi keamanan akun Anda._`
  },
  {
    id: 'payment_rejected',
    title: 'Pemberitahuan Penolakan Bukti Transfer',
    category: 'system',
    variables: '{nama}, {periode}, {nominal}, {alasan}, {portal_url}',
    content: `Halo Bapak/Ibu *{nama}*,

Pemberitahuan dari *LenxyNet Fiber*.
Mohon maaf, bukti pembayaran yang Anda unggah untuk periode *{periode}* sebesar *{nominal}* belum dapat disetujui.

❌ *Alasan Penolakan:* {alasan}

Silakan periksa mutasi rekening / riwayat transfer Anda dan unggah bukti transfer yang benar melalui tautan portal berikut:
👉 {portal_url}

💡 _Tips: Jika tautan di atas belum bisa diklik, simpan nomor ini ke kontak atau balas pesan ini (ketik OK)._

Hubungi Customer Service jika Anda membutuhkan bantuan lebih lanjut.
_Customer Service LenxyNet_`
  },
  {
    id: 'notice_maintenance',
    title: '⚠️ Maintenance Jaringan Terjadwal',
    category: 'notice',
    variables: '{nama}, {username}, {paket}, {portal_url}',
    content: `PEMBERITAHUAN MAINTENANCE JARINGAN ⚠️
Halo Bapak/Ibu *{nama}*,

Diberitahukan bahwa tim teknis *LenxyNet* akan melakukan pemeliharaan rutin jaringan untuk meningkatkan stabilitas dan kecepatan koneksi:

📅 *Jadwal Pemeliharaan:*
• Waktu: *Malam ini, Pukul 01:00 - 04:00 WIB*
• Dampak: *Koneksi internet akan terputus sementara waktu*

Koneksi internet akan kembali normal otomatis setelah proses selesai. Kami memohon maaf atas ketidaknyamanan yang terjadi.

_Terima kasih atas perhatian dan kerja samanya._
*Tim Teknis LenxyNet Fiber*`
  },
  {
    id: 'notice_gangguan',
    title: '🚨 Gangguan Kabel FO / Kendala Teknis',
    category: 'notice',
    variables: '{nama}, {username}, {portal_url}',
    content: `INFORMASI GANGGUAN KONEKSI INTERNET ⚠️
Kepada Yth. Bapak/Ibu *{nama}*,

Kami informasikan bahwa saat ini sedang terjadi kendala teknis / pemutusan kabel FO utama yang mempengaruhi koneksi internet di wilayah Anda.

🛠️ *Status Penanganan:*
Tim teknisi saat ini sudah berada di lokasi lapangan dan sedang berupaya melakukan perbaikan secepat mungkin.

Kami mohon maaf yang sebesar-besarnya atas ketidaknyamanan aktivitas internet Anda. Pembaruan informasi akan kami sampaikan secara berkala.

_Layanan Pelanggan LenxyNet_`
  },
  {
    id: 'notice_pengumuman',
    title: '📢 Pengumuman Umum Layanan',
    category: 'notice',
    variables: '{nama}, {username}, {portal_url}',
    content: `PENGUMUMAN LAYANAN LENXYNET 📢
Halo Bapak/Ibu *{nama}*,

Informasi penting bagi seluruh pelanggan *LenxyNet Fiber*:

Kami terus berkomitmen memberikan layanan internet terbaik untuk Anda. Untuk mengecek status langganan, paket aktif, dan info pembayaran, silakan kunjungi:
👉 {portal_url}

Jika Anda mengalami kendala atau membutuhkan bantuan teknis, jangan ragu untuk menghubungi layanan support kami.

_Salam hangat, Manajemen LenxyNet_`
  },
  {
    id: 'promo_upgrade',
    title: '🚀 Promo Upgrade Kecepatan Internet',
    category: 'promo',
    variables: '{nama}, {plans}, {portal_url}',
    content: `PROMO SPESIAL UPGRADE KECEPATAN! 🚀
Halo Bapak/Ibu *{nama}*,

Rasakan pengalaman internet super kencang tanpa hambatan! Nikmati penawaran khusus upgrade paket internet *LenxyNet Fiber*:

📦 *Pilihan Paket Kecepatan Tinggi:*
{plans}

🎉 Kecepatan lebih kencang untuk streaming 4K, meeting lancar, dan gaming anti-lag bersama keluarga!

Hubungi Admin kami sekarang atau cek detail di portal:
👉 {portal_url}

_LenxyNet - Internet Cepat & Stabil_`
  },
  {
    id: 'promo_diskon',
    title: '🎁 Promo Hemat Bayar Di Muka (6 & 12 Bulan)',
    category: 'promo',
    variables: '{nama}, {portal_url}',
    content: `PROMO HEMAT LANGGANAN LENXYNET! 🎁
Halo Bapak/Ibu *{nama}*,

Mau internetan lebih hemat tanpa repot bayar tiap bulan?
Ambil promo bayar di muka sekarang juga:

✨ *Bayar 6 Bulan*: *Gratis 1 Bulan Langganan!*
✨ *Bayar 12 Bulan*: *Gratis 2 Bulan Langganan!*

Promo terbatas untuk pelanggan setia *LenxyNet*. Amankan promonya sekarang dengan menghubungi admin kami atau bayar langsung via QRIS:
👉 {portal_url}

_LenxyNet Fiber_`
  },
  {
    id: 'promo_referral',
    title: '🤝 Promo Ajak Tetangga (Bonus Potongan Tagihan)',
    category: 'promo',
    variables: '{nama}, {portal_url}',
    content: `AJAK TETANGGA & DAPATKAN BONUS! 🤝
Halo Bapak/Ibu *{nama}*,

Puas dengan koneksi internet *LenxyNet*? Ajak tetangga atau kerabat Anda untuk pasang Wi-Fi LenxyNet!

🎁 *Dapatkan Bonus Potongan Tagihan Rp 25.000* untuk setiap 1 orang teman yang berhasil terpasang dari rekomendasi Anda.

Info pemasangan silakan hubungi Admin kami.
👉 {portal_url}

_Terima kasih telah berlangganan di LenxyNet!_`
  },
  {
    id: 'promo_general',
    title: '🔥 Promo Penawaran Spesial Umum',
    category: 'promo',
    variables: '{nama}, {plans}, {portal_url}',
    content: `Halo Bapak/Ibu *{nama}*! 👋

Ada kabar gembira dan info menarik dari *LenxyNet Fiber* 🚀
Nikmati koneksi internet rumah super cepat, stabil, dan tanpa batas kuota (True Unlimited)!

🔥 *DAFTAR PAKET SPESIAL LENXYNET:*
{plans}

✨ *Keunggulan Layanan LenxyNet:*
• 100% Fiber Optic murni
• Ping rendah & stabil untuk gaming/streaming
• Dukungan Customer Support 24/7
• Pembayaran mudah via QRIS otomatis

Yuk cek status akun atau upgrade paket internet Anda langsung di portal pelanggan:
👉 {portal_url}

_Terima kasih telah menjadi bagian dari keluarga LenxyNet Fiber!_`
  }
];

// Seed template ke database SQLite jika belum ada
const insertTpl = db.prepare(`
  INSERT INTO message_templates (id, title, category, content, variables)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(id) DO NOTHING
`);
for (const t of DEFAULT_MESSAGE_TEMPLATES) {
  insertTpl.run(t.id, t.title, t.category, t.content, t.variables);
}

// Helper untuk membaca isi template pesan terkini dari database
function getMessageTemplate(id) {
  try {
    const row = db.prepare('SELECT content FROM message_templates WHERE id = ?').get(id);
    if (row && row.content) return row.content;
  } catch (e) {}
  const found = DEFAULT_MESSAGE_TEMPLATES.find(t => t.id === id);
  return found ? found.content : '';
}

db.getMessageTemplate = getMessageTemplate;
db.DEFAULT_MESSAGE_TEMPLATES = DEFAULT_MESSAGE_TEMPLATES;

module.exports = db;


const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const dbPath = path.join(__dirname, 'database.sqlite');
const db = new DatabaseSync(dbPath);

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
  insertSetting.run('mock_payment_enabled', 'true');
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

module.exports = db;


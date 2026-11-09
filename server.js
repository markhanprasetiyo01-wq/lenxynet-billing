const express = require('express');
const path = require('path');
const db = require('./db');
const { 
  syncFromMikrotik, 
  testMikrotikConnection, 
  setMikrotikSecretStatus, 
  addCustomerToMikrotik, 
  removeCustomerFromMikrotik, 
  updateCustomerPhoneInMikrotik, 
  updateCustomerDueDateInMikrotik,
  updateCustomerInMikrotik,
  getMikrotikLiveStatus,
  getMikrotikInterfaces,
  getMikrotikTraffic,
  getMikrotikActiveSessions
} = require('./mikrotik');
const { runAutoIsolirCheck, startCronJobs } = require('./cron');
const { initWhatsApp, getWAStatus, logoutWhatsApp, sendPaymentSuccessNotice, sendReminderHMinus3, sendReminderHPlus1, sendPromoNotice, sendWhatsAppMessage, sendNotificationToAdmin } = require('./wa');
const { getTelegramConfig, testTelegramConnection, sendTelegramPhoto, backupDatabaseToTelegram, backupMikrotikToTelegram } = require('./telegram');

const crypto = require('crypto');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

// Helper Standardisasi Format Nomor WhatsApp Lokal (08xxxxxxxxx)
function normalizePhoneNumber(phone) {
  if (!phone || phone === '-') return '-';
  let cleaned = String(phone).replace(/\D/g, '');
  if (cleaned.startsWith('62')) {
    cleaned = '0' + cleaned.substring(2);
  } else if (cleaned.startsWith('8')) {
    cleaned = '0' + cleaned;
  }
  return cleaned;
}

// Helper Cek Duplikasi Nomor WhatsApp di Database
function findPhoneDuplicate(phone, excludeCustomerId = null) {
  if (!phone || phone === '-' || String(phone).trim() === '') return null;
  const clean = normalizePhoneNumber(phone);
  if (clean === '-' || clean.length < 8) return null;

  const noZero = clean.replace(/^0/, '');
  const with62 = '62' + noZero;
  const with0 = '0' + noZero;

  let sql = `
    SELECT id, name, pppoe_username, phone FROM customers 
    WHERE phone != '-' AND phone != '' AND (phone = ? OR phone = ? OR phone = ?)
  `;
  const params = [clean, with62, with0];
  if (excludeCustomerId) {
    sql += ` AND id != ?`;
    params.push(excludeCustomerId);
  }
  return db.prepare(sql).get(...params);
}

// Helper Mendeteksi Seluruh Duplikasi / Konflik Nomor WhatsApp Antar Pelanggan
function getDataConflicts() {
  const customers = db.prepare("SELECT id, name, pppoe_username, phone, status, due_date FROM customers WHERE phone != '-' AND phone != ''").all();
  const phoneMap = {};

  for (const c of customers) {
    const norm = normalizePhoneNumber(c.phone);
    if (!norm || norm === '-' || norm.length < 8) continue;
    if (!phoneMap[norm]) {
      phoneMap[norm] = [];
    }
    phoneMap[norm].push(c);
  }

  const conflicts = [];
  for (const [normPhone, list] of Object.entries(phoneMap)) {
    if (list.length > 1) {
      conflicts.push({
        phone: normPhone,
        count: list.length,
        customers: list
      });
    }
  }
  return conflicts;
}

// Helper Mendapatkan Base URL Portal Pelanggan (Domain Cloudflare / Custom atau Fallback Lokal)
function getPortalBaseUrl(req = null) {
  const publicUrl = db.prepare("SELECT value FROM settings WHERE key = 'public_portal_url'").get()?.value;
  if (publicUrl && publicUrl.trim() !== '') {
    let clean = publicUrl.trim().replace(/\/+$/, '');
    if (!clean.startsWith('http://') && !clean.startsWith('https://')) {
      clean = 'https://' + clean;
    }
    return clean;
  }
  if (req) {
    const host = req.get('host');
    const protocol = req.protocol;
    return `${protocol}://${host}`;
  }
  return 'http://192.168.55.254';
}

// Helper Pencatat Log Aktivitas Sistem
function logActivity(action, details, target = 'SYSTEM', status = 'success') {
  try {
    db.prepare("INSERT INTO activity_logs (action, details, target, status) VALUES (?, ?, ?, ?)").run(action, details, target, status);
  } catch (e) {
    console.error('Failed to log activity:', e.message);
  }
}

// === AUTHENTICATION MIDDLEWARES ===

// Middleware Autentikasi Admin (Token Session Guard)
function requireAdminAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  let token = '';
  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (req.query.token) {
    token = String(req.query.token).trim();
  }

  if (!token) {
    return res.status(401).json({ success: false, error: 'Akses ditolak: Token autentikasi admin tidak ditemukan. Silakan login kembali.' });
  }

  const session = db.prepare("SELECT * FROM admin_sessions WHERE token = ? AND expires_at > datetime('now', 'localtime')").get(token);
  if (!session) {
    return res.status(401).json({ success: false, error: 'Sesi admin telah kedaluwarsa atau tidak valid. Silakan login kembali.' });
  }

  req.adminSession = session;
  next();
}

// Middleware Autentikasi Pelanggan (User Session Guard)
function requireUserAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  let token = '';
  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (req.query.token) {
    token = String(req.query.token).trim();
  }

  if (!token) {
    return res.status(401).json({ success: false, error: 'Akses ditolak: Sesi pelanggan tidak ditemukan. Silakan verifikasi OTP terlebih dahulu.' });
  }

  const session = db.prepare("SELECT * FROM user_sessions WHERE token = ? AND expires_at > datetime('now', 'localtime')").get(token);
  if (!session) {
    return res.status(401).json({ success: false, error: 'Sesi portal telah kedaluwarsa. Silakan verifikasi OTP ulang.' });
  }

  req.userSession = session;
  next();
}

// Middleware Fleksibel: Mengizinkan Sesi Pelanggan atau Sesi Admin
function requireUserOrAdminAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  let token = '';
  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (req.query.token) {
    token = String(req.query.token).trim();
  }

  if (!token) {
    return res.status(401).json({ success: false, error: 'Akses ditolak: Sesi tidak ditemukan. Silakan verifikasi OTP terlebih dahulu.' });
  }

  const userSession = db.prepare("SELECT * FROM user_sessions WHERE token = ? AND expires_at > datetime('now', 'localtime')").get(token);
  if (userSession) {
    req.userSession = userSession;
    return next();
  }

  const adminSession = db.prepare("SELECT * FROM admin_sessions WHERE token = ? AND expires_at > datetime('now', 'localtime')").get(token);
  if (adminSession) {
    req.adminSession = adminSession;
    return next();
  }

  return res.status(401).json({ success: false, error: 'Sesi telah kedaluwarsa atau tidak valid. Silakan verifikasi ulang.' });
}

// Helper & Middleware Cek Status Router MikroTik
function isMikrotikConnected() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'router_connected'").get();
  return row?.value === 'true';
}

function requireMikrotikConnected(req, res, next) {
  if (!isMikrotikConnected()) {
    return res.status(400).json({ success: false, error: 'Router MikroTik sedang terputus / offline. Hubungkan router terlebih dahulu.' });
  }
  next();
}

// === API ROUTES ===

// === ADMIN AUTHENTICATION & SESSION ROUTES ===

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  const currentAdminUser = db.prepare("SELECT value FROM settings WHERE key = 'admin_username'").get()?.value || 'admin';
  const currentAdminPass = db.prepare("SELECT value FROM settings WHERE key = 'admin_password'").get()?.value || 'admin123';

  if (username === currentAdminUser && password === currentAdminPass) {
    // Generate secure crypto session token
    const token = 'lx_adm_' + crypto.randomBytes(24).toString('hex');
    db.prepare("INSERT INTO admin_sessions (token, expires_at) VALUES (?, datetime('now', '+1 day', 'localtime'))").run(token);
    logActivity('LOGIN', `Admin login berhasil (${username})`, 'ADMIN');
    res.json({ success: true, token, username: currentAdminUser, message: 'Login berhasil! Selamat datang Admin LenxyNet.' });
  } else {
    logActivity('LOGIN', `Percobaan login admin gagal (${username})`, 'ADMIN', 'failed');
    res.status(401).json({ success: false, error: 'Username atau Password Admin salah!' });
  }
});

// Route Logout Admin
app.post('/api/admin/logout', (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7).trim();
    db.prepare("DELETE FROM admin_sessions WHERE token = ?").run(token);
  } else if (req.query.token) {
    db.prepare("DELETE FROM admin_sessions WHERE token = ?").run(String(req.query.token).trim());
  }
  res.json({ success: true, message: 'Logout berhasil' });
});

// Pasang proteksi middleware global untuk seluruh endpoint /api/admin/* (kecuali /api/admin/login)
app.use('/api/admin', (req, res, next) => {
  if (req.path === '/login' || req.originalUrl === '/api/admin/login') {
    return next();
  }
  return requireAdminAuth(req, res, next);
});

app.post('/api/admin/update-credentials', requireAdminAuth, (req, res) => {
  const { oldPassword, newUsername, newPassword } = req.body;
  const currentPass = db.prepare("SELECT value FROM settings WHERE key = 'admin_password'").get()?.value || 'admin123';

  if (oldPassword !== currentPass) {
    return res.status(400).json({ success: false, error: 'Password lama salah!' });
  }

  if (newUsername) {
    db.prepare("UPDATE settings SET value = ? WHERE key = 'admin_username'").run(newUsername.trim());
  }
  if (newPassword) {
    db.prepare("UPDATE settings SET value = ? WHERE key = 'admin_password'").run(newPassword.trim());
  }

  res.json({ success: true, message: 'Kredensial Admin berhasil diperbarui!' });
});

// === MIKROTIK SETTINGS & TEST CONNECTION ROUTES ===

app.get('/api/admin/mikrotik/config', requireAdminAuth, (req, res) => {
  const ip = db.prepare("SELECT value FROM settings WHERE key = 'router_ip'").get()?.value || '';
  const user = db.prepare("SELECT value FROM settings WHERE key = 'router_user'").get()?.value || '';
  const pass = db.prepare("SELECT value FROM settings WHERE key = 'router_pass'").get()?.value || '';
  const port = db.prepare("SELECT value FROM settings WHERE key = 'router_port'").get()?.value || '8728';
  const connected = db.prepare("SELECT value FROM settings WHERE key = 'router_connected'").get()?.value || 'false';

  res.json({
    host: ip,
    user: user,
    hasPassword: !!pass,
    password: pass ? '••••••••' : '',
    port: parseInt(port, 10),
    connected: connected === 'true'
  });
});

app.post('/api/admin/mikrotik/test', requireAdminAuth, async (req, res) => {
  const { host, user, password, port } = req.body;
  const currentPass = db.prepare("SELECT value FROM settings WHERE key = 'router_pass'").get()?.value || '';

  let testPass = password;
  if (testPass === '••••••••') {
    testPass = currentPass;
  } else if (testPass === undefined || testPass === null) {
    testPass = '';
  }

  console.log(`[MikroTik Test] Mencoba koneksi ke ${host}:${port || 8728} (User: ${user})...`);
  try {
    const info = await testMikrotikConnection(host, user, testPass, port);
    console.log(`[MikroTik Test] Berhasil terhubung ke ${info.model} (v${info.version})!`);
    res.json({
      success: true,
      message: `Terhubung ke MikroTik ${info.model}! (RouterOS ${info.version})`,
      details: info
    });
  } catch (err) {
    console.warn(`[MikroTik Test] Gagal terhubung ke ${host}:${port || 8728}: ${err.message}`);
    res.status(400).json({ 
      success: false, 
      error: err.message,
      code: err.code || 'CONN_FAILED',
      host: host,
      port: port || 8728
    });
  }
});

app.post('/api/admin/mikrotik/save', requireAdminAuth, async (req, res) => {
  const { host, user, password, port } = req.body;
  if (!host || !user) {
    return res.status(400).json({ error: 'IP Host dan Username MikroTik wajib diisi!' });
  }

  const currentPass = db.prepare("SELECT value FROM settings WHERE key = 'router_pass'").get()?.value || '';
  let savePass = password;
  if (savePass === '••••••••') {
    savePass = currentPass;
  } else if (savePass === undefined || savePass === null) {
    savePass = '';
  }

  try {
    // 1. Tes koneksi dulu sebelum disimpan
    const info = await testMikrotikConnection(host, user, savePass, port);

    // 2. Simpan ke database settings secara permanen
    db.prepare("UPDATE settings SET value = ? WHERE key = 'router_ip'").run(host.trim());
    db.prepare("UPDATE settings SET value = ? WHERE key = 'router_user'").run(user.trim());
    db.prepare("UPDATE settings SET value = ? WHERE key = 'router_pass'").run(savePass);
    db.prepare("UPDATE settings SET value = ? WHERE key = 'router_port'").run(String(port || 8728));
    db.prepare("UPDATE settings SET value = 'true' WHERE key = 'router_connected'").run();

    // 3. Jalankan sinkronisasi otomatis dengan router baru
    const syncRes = await syncFromMikrotik();

    logActivity('CONFIG_CHANGE', `Tersambung ke MikroTik ${info.model} (${host})`, host.trim());

    res.json({
      success: true,
      message: `Konfigurasi tersimpan & tersambung ke ${info.model}! Sinkron ${syncRes.count} user.`,
      routerIp: host.trim(),
      connected: true,
      info
    });
  } catch (err) {
    logActivity('CONFIG_CHANGE', `Gagal konek MikroTik ${host}: ${err.message}`, host.trim(), 'failed');
    res.status(400).json({ success: false, error: 'Koneksi gagal: ' + err.message, code: err.code });
  }
});

app.post('/api/admin/mikrotik/disconnect', requireAdminAuth, (req, res) => {
  db.prepare("UPDATE settings SET value = 'false' WHERE key = 'router_connected'").run();
  logActivity('CONFIG_CHANGE', 'Koneksi MikroTik diputus (Disconnected)', 'ROUTER');
  res.json({ success: true, message: 'Koneksi MikroTik dinonaktifkan (Disconnected).' });
});

// === MIKROTIK MONITORING (TRAFFIC & ACTIVE SESSIONS) ROUTES ===

app.get('/api/admin/mikrotik/interfaces', async (req, res) => {
  const isConn = db.prepare("SELECT value FROM settings WHERE key = 'router_connected'").get()?.value === 'true';
  if (!isConn) return res.json([]);
  try {
    const ifaces = await getMikrotikInterfaces();
    res.json(ifaces);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/mikrotik/traffic', async (req, res) => {
  const isConn = db.prepare("SELECT value FROM settings WHERE key = 'router_connected'").get()?.value === 'true';
  if (!isConn) return res.json({ txBps: 0, rxBps: 0, txPackets: 0, rxPackets: 0 });
  const interfaceName = req.query.interface || 'ether1';
  try {
    const traffic = await getMikrotikTraffic(interfaceName);
    res.json(traffic);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/mikrotik/active-sessions', async (req, res) => {
  const isConn = db.prepare("SELECT value FROM settings WHERE key = 'router_connected'").get()?.value === 'true';
  if (!isConn) return res.json([]);
  try {
    const active = await getMikrotikActiveSessions();
    res.json(active);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === PAYMENT HISTORY & INVOICE ROUTES ===

app.get('/api/admin/payments', (req, res) => {
  try {
    if (!isMikrotikConnected()) return res.json([]);
    const { period, search } = req.query;
    let sql = `
      SELECT b.id, b.customer_id, b.period, b.amount, b.status, b.paid_at, b.payment_method,
             c.name as customer_name, c.pppoe_username, c.phone as customer_phone,
             p.name as plan_name, p.speed as plan_speed
      FROM bills b
      JOIN customers c ON b.customer_id = c.id
      LEFT JOIN plans p ON c.plan_id = p.id
      WHERE b.status = 'paid'
    `;
    const params = [];

    if (period) {
      sql += ' AND b.period = ?';
      params.push(period);
    }
    if (search) {
      sql += ' AND (c.name LIKE ? OR c.pppoe_username LIKE ? OR c.phone LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    sql += ' ORDER BY b.paid_at DESC, b.id DESC';
    const payments = db.prepare(sql).all(...params);
    res.json(payments);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// History Pembayaran untuk Portal Pelanggan (Terlindungi Sesi)
app.get('/api/user/payments', requireUserOrAdminAuth, (req, res) => {
  let cust = null;
  if (req.userSession) {
    cust = db.prepare('SELECT id, name, pppoe_username, phone, plan_id FROM customers WHERE id = ?').get(req.userSession.customer_id);
  } else if (req.adminSession) {
    const { username } = req.query;
    if (username) {
      cust = db.prepare('SELECT id, name, pppoe_username, phone, plan_id FROM customers WHERE pppoe_username = ?').get(username);
    }
  }

  if (!cust) return res.status(404).json({ error: 'Pelanggan tidak ditemukan' });

  const payments = db.prepare(`
    SELECT b.id, b.period, b.amount, b.status, b.paid_at, b.payment_method,
           p.name as plan_name, p.speed as plan_speed
    FROM bills b
    LEFT JOIN customers c ON b.customer_id = c.id
    LEFT JOIN plans p ON c.plan_id = p.id
    WHERE b.customer_id = ? AND b.status = 'paid'
    ORDER BY b.paid_at DESC, b.period DESC
  `).all(cust.id);

  res.json({ customer: cust, payments });
});

// === AUDIT TRAIL / ACTIVITY LOGS ROUTES ===

app.get('/api/admin/activity-logs', (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 100;
    const logs = db.prepare('SELECT * FROM activity_logs ORDER BY id DESC LIMIT ?').all(limit);
    res.json(logs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === EXPORT / BACKUP ROUTES ===

app.get('/api/admin/export/payments.csv', (req, res) => {
  if (!isMikrotikConnected()) return res.status(400).send('Router MikroTik sedang terputus / offline.');
  try {
    const payments = db.prepare(`
      SELECT b.id as bill_id, c.name as customer_name, c.pppoe_username, c.phone,
             b.period, b.amount, b.paid_at, b.payment_method, p.name as plan_name
      FROM bills b
      JOIN customers c ON b.customer_id = c.id
      LEFT JOIN plans p ON c.plan_id = p.id
      WHERE b.status = 'paid'
      ORDER BY b.paid_at DESC
    `).all();

    let csv = 'ID Tagihan,Nama Pelanggan,Username PPPoE,No WA,Periode,Nominal,Tanggal Bayar,Metode Bayar,Paket\n';
    payments.forEach(p => {
      csv += `"${p.bill_id}","${p.customer_name}","${p.pppoe_username}","${p.phone}","${p.period}",${p.amount},"${p.paid_at || '-'}","${p.payment_method || '-'}","${p.plan_name || '-'}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=lenxynet-payments-${Date.now()}.csv`);
    res.send(csv);
  } catch (e) {
    res.status(500).send('Error export: ' + e.message);
  }
});

app.get('/api/admin/export/customers.csv', (req, res) => {
  if (!isMikrotikConnected()) return res.status(400).send('Router MikroTik sedang terputus / offline.');
  try {
    const customers = db.prepare(`
      SELECT c.id, c.name, c.pppoe_username, c.phone, c.due_date, c.status,
             p.name as plan_name, p.price as plan_price, p.speed as plan_speed
      FROM customers c
      LEFT JOIN plans p ON c.plan_id = p.id
      ORDER BY c.id DESC
    `).all();

    let csv = 'ID,Nama Pelanggan,Username PPPoE,No WA,Jatuh Tempo,Status Akun,Paket,Harga,Kecepatan\n';
    customers.forEach(c => {
      csv += `"${c.id}","${c.name}","${c.pppoe_username}","${c.phone}",${c.due_date},"${c.status}","${c.plan_name || '-'}","${c.plan_price || 0}","${c.plan_speed || '-'}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=lenxynet-customers-${Date.now()}.csv`);
    res.send(csv);
  } catch (e) {
    res.status(500).send('Error export: ' + e.message);
  }
});

// Download Full Backup Database SQLite
app.get('/api/admin/backup/database', (req, res) => {
  const dbFile = path.join(__dirname, 'database.sqlite');
  res.download(dbFile, `lenxynet-backup-${new Date().toISOString().slice(0, 10)}.sqlite`);
});

// === WHATSAPP GATEWAY ROUTES ===

app.get('/api/admin/wa-status', (req, res) => {
  res.json(getWAStatus());
});

app.post('/api/admin/wa-logout', async (req, res) => {
  const result = await logoutWhatsApp();
  res.json(result);
});

// Get & Update Promo Template
app.get('/api/admin/promo-template', (req, res) => {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'promo_template'").get();
  res.json({ template: row ? row.value : '' });
});

app.post('/api/admin/promo-template', (req, res) => {
  const { template } = req.body;
  db.prepare("UPDATE settings SET value = ? WHERE key = 'promo_template'").run(template || '');
  res.json({ success: true, message: 'Template promosi & info LenxyNet berhasil disimpan!' });
});

// === FITUR WHATSAPP GLOBAL & BROADCAST (Pemberitahuan, Promo, Filter Target) ===

app.get('/api/admin/whatsapp/target-preview', requireAdminAuth, (req, res) => {
  try {
    const { target = 'all', customerId } = req.query;
    const now = new Date();
    const currentPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    let recipients = [];

    if (target === 'single') {
      if (customerId) {
        recipients = db.prepare(`
          SELECT c.id, c.name, c.phone, c.pppoe_username, c.due_date, c.status,
                 p.name as plan_name, p.price as plan_price,
                 b.amount as bill_amount, b.status as bill_status, b.period as bill_period
          FROM customers c
          LEFT JOIN plans p ON c.plan_id = p.id
          LEFT JOIN bills b ON c.id = b.customer_id AND b.period = ?
          WHERE c.id = ?
        `).all(currentPeriod, customerId);
      }
    } else if (target === 'unpaid') {
      recipients = db.prepare(`
        SELECT c.id, c.name, c.phone, c.pppoe_username, c.due_date, c.status,
               p.name as plan_name, p.price as plan_price,
               b.amount as bill_amount, b.status as bill_status, b.period as bill_period
        FROM customers c
        LEFT JOIN plans p ON c.plan_id = p.id
        LEFT JOIN bills b ON c.id = b.customer_id AND b.period = ?
        WHERE c.phone IS NOT NULL AND c.phone != '' AND c.phone != '-'
          AND (b.status IS NULL OR b.status != 'paid')
        ORDER BY c.name ASC
      `).all(currentPeriod);
    } else if (target === 'paid') {
      recipients = db.prepare(`
        SELECT c.id, c.name, c.phone, c.pppoe_username, c.due_date, c.status,
               p.name as plan_name, p.price as plan_price,
               b.amount as bill_amount, b.status as bill_status, b.period as bill_period
        FROM customers c
        LEFT JOIN plans p ON c.plan_id = p.id
        INNER JOIN bills b ON c.id = b.customer_id AND b.period = ? AND b.status = 'paid'
        WHERE c.phone IS NOT NULL AND c.phone != '' AND c.phone != '-'
        ORDER BY c.name ASC
      `).all(currentPeriod);
    } else if (target === 'isolated') {
      recipients = db.prepare(`
        SELECT c.id, c.name, c.phone, c.pppoe_username, c.due_date, c.status,
               p.name as plan_name, p.price as plan_price,
               b.amount as bill_amount, b.status as bill_status, b.period as bill_period
        FROM customers c
        LEFT JOIN plans p ON c.plan_id = p.id
        LEFT JOIN bills b ON c.id = b.customer_id AND b.period = ?
        WHERE c.phone IS NOT NULL AND c.phone != '' AND c.phone != '-'
          AND c.status = 'isolated'
        ORDER BY c.name ASC
      `).all(currentPeriod);
    } else if (target === 'active') {
      recipients = db.prepare(`
        SELECT c.id, c.name, c.phone, c.pppoe_username, c.due_date, c.status,
               p.name as plan_name, p.price as plan_price,
               b.amount as bill_amount, b.status as bill_status, b.period as bill_period
        FROM customers c
        LEFT JOIN plans p ON c.plan_id = p.id
        LEFT JOIN bills b ON c.id = b.customer_id AND b.period = ?
        WHERE c.phone IS NOT NULL AND c.phone != '' AND c.phone != '-'
          AND (c.status IS NULL OR c.status = 'active')
        ORDER BY c.name ASC
      `).all(currentPeriod);
    } else {
      recipients = db.prepare(`
        SELECT c.id, c.name, c.phone, c.pppoe_username, c.due_date, c.status,
               p.name as plan_name, p.price as plan_price,
               b.amount as bill_amount, b.status as bill_status, b.period as bill_period
        FROM customers c
        LEFT JOIN plans p ON c.plan_id = p.id
        LEFT JOIN bills b ON c.id = b.customer_id AND b.period = ?
        WHERE c.phone IS NOT NULL AND c.phone != '' AND c.phone != '-'
        ORDER BY c.name ASC
      `).all(currentPeriod);
    }

    res.json({
      success: true,
      target,
      count: recipients.length,
      recipients: recipients.map(r => ({
        id: r.id,
        name: r.name,
        phone: r.phone,
        pppoe_username: r.pppoe_username,
        plan_name: r.plan_name || 'Internet PPPoE',
        status: r.status || 'active',
        bill_status: r.bill_status || 'unpaid'
      }))
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/whatsapp/send-broadcast', requireAdminAuth, async (req, res) => {
  try {
    const waStatus = getWAStatus();
    if (waStatus.status !== 'connected') {
      return res.status(400).json({
        success: false,
        error: 'Bot WhatsApp belum terhubung. Silakan buka menu WhatsApp di dashboard dan scan QR code terlebih dahulu.'
      });
    }

    const { target = 'all', customerId, category = 'notice', messageTemplate = '' } = req.body;
    if (!messageTemplate || !messageTemplate.trim()) {
      return res.status(400).json({ success: false, error: 'Isi pesan WhatsApp tidak boleh kosong!' });
    }

    const now = new Date();
    const currentPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    let recipients = [];

    if (target === 'single') {
      if (!customerId) return res.status(400).json({ success: false, error: 'Pilih pelanggan target terlebih dahulu!' });
      recipients = db.prepare(`
        SELECT c.*, p.name as plan_name, p.price as plan_price,
               b.amount as bill_amount, b.status as bill_status, b.period as bill_period
        FROM customers c
        LEFT JOIN plans p ON c.plan_id = p.id
        LEFT JOIN bills b ON c.id = b.customer_id AND b.period = ?
        WHERE c.id = ?
      `).all(currentPeriod, customerId);
    } else if (target === 'unpaid') {
      recipients = db.prepare(`
        SELECT c.*, p.name as plan_name, p.price as plan_price,
               b.amount as bill_amount, b.status as bill_status, b.period as bill_period
        FROM customers c
        LEFT JOIN plans p ON c.plan_id = p.id
        LEFT JOIN bills b ON c.id = b.customer_id AND b.period = ?
        WHERE c.phone IS NOT NULL AND c.phone != '' AND c.phone != '-'
          AND (b.status IS NULL OR b.status != 'paid')
        ORDER BY c.name ASC
      `).all(currentPeriod);
    } else if (target === 'paid') {
      recipients = db.prepare(`
        SELECT c.*, p.name as plan_name, p.price as plan_price,
               b.amount as bill_amount, b.status as bill_status, b.period as bill_period
        FROM customers c
        LEFT JOIN plans p ON c.plan_id = p.id
        INNER JOIN bills b ON c.id = b.customer_id AND b.period = ? AND b.status = 'paid'
        WHERE c.phone IS NOT NULL AND c.phone != '' AND c.phone != '-'
        ORDER BY c.name ASC
      `).all(currentPeriod);
    } else if (target === 'isolated') {
      recipients = db.prepare(`
        SELECT c.*, p.name as plan_name, p.price as plan_price,
               b.amount as bill_amount, b.status as bill_status, b.period as bill_period
        FROM customers c
        LEFT JOIN plans p ON c.plan_id = p.id
        LEFT JOIN bills b ON c.id = b.customer_id AND b.period = ?
        WHERE c.phone IS NOT NULL AND c.phone != '' AND c.phone != '-'
          AND c.status = 'isolated'
        ORDER BY c.name ASC
      `).all(currentPeriod);
    } else if (target === 'active') {
      recipients = db.prepare(`
        SELECT c.*, p.name as plan_name, p.price as plan_price,
               b.amount as bill_amount, b.status as bill_status, b.period as bill_period
        FROM customers c
        LEFT JOIN plans p ON c.plan_id = p.id
        LEFT JOIN bills b ON c.id = b.customer_id AND b.period = ?
        WHERE c.phone IS NOT NULL AND c.phone != '' AND c.phone != '-'
          AND (c.status IS NULL OR c.status = 'active')
        ORDER BY c.name ASC
      `).all(currentPeriod);
    } else {
      recipients = db.prepare(`
        SELECT c.*, p.name as plan_name, p.price as plan_price,
               b.amount as bill_amount, b.status as bill_status, b.period as bill_period
        FROM customers c
        LEFT JOIN plans p ON c.plan_id = p.id
        LEFT JOIN bills b ON c.id = b.customer_id AND b.period = ?
        WHERE c.phone IS NOT NULL AND c.phone != '' AND c.phone != '-'
        ORDER BY c.name ASC
      `).all(currentPeriod);
    }

    if (!recipients.length) {
      return res.status(400).json({ success: false, error: 'Tidak ada pelanggan yang cocok dengan filter target atau nomor WhatsApp belum terisi.' });
    }

    const allPlans = db.prepare("SELECT name, speed, price FROM plans WHERE name NOT IN ('default', 'default-encryption') ORDER BY price ASC, name ASC").all();
    const plansListText = allPlans.map(p => `• *${p.name}* (${p.speed}) - Rp ${Number(p.price).toLocaleString('id-ID')}/bln`).join('\n') || '• Paket LenxyNet Fiber';

    const baseUrl = getPortalBaseUrl(req);

    let sentCount = 0;
    let failedCount = 0;
    const errors = [];

    for (let i = 0; i < recipients.length; i++) {
      const c = recipients[i];
      if (!c.phone || c.phone === '-' || c.phone === 'null') {
        failedCount++;
        continue;
      }

      const phoneParam = (c.phone && c.phone !== '-') ? c.phone : c.pppoe_username;
      const portalUrl = `${baseUrl}/user.html?phone=${encodeURIComponent(phoneParam)}`;
      const amountVal = c.bill_amount || c.plan_price || 150000;
      const nominalStr = `Rp ${Number(amountVal).toLocaleString('id-ID')}`;

      let personalizedMsg = messageTemplate
        .replace(/{nama}/gi, c.name || 'Pelanggan')
        .replace(/{name}/gi, c.name || 'Pelanggan')
        .replace(/{username}/gi, c.pppoe_username || '-')
        .replace(/{phone}/gi, c.phone || '-')
        .replace(/{paket}/gi, c.plan_name || 'Internet PPPoE')
        .replace(/{jatuh_tempo}/gi, `Tgl ${c.due_date || 1}`)
        .replace(/{nominal}/gi, nominalStr)
        .replace(/{portal_url}/gi, portalUrl)
        .replace(/{plans}/gi, plansListText);

      const sendRes = await sendWhatsAppMessage(c.phone, personalizedMsg);
      if (sendRes && sendRes.success) {
        sentCount++;
      } else {
        failedCount++;
        errors.push(`${c.name} (${c.phone}): ${sendRes?.error || 'Gagal'}`);
      }

      // Safe Delay 1.5 detik per pesan agar anti-banned / tidak terkena limit spam WhatsApp
      if (i < recipients.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }

    const catLabel = category === 'promo' ? 'Promosi & Penawaran' : 'Pemberitahuan / Gangguan';
    logActivity('WHATSAPP', `Broadcast WA (${catLabel}) selesai: ${sentCount} berhasil, ${failedCount} gagal (Target: ${target})`, 'ADMIN');

    res.json({
      success: true,
      message: `Pesan broadcast WhatsApp berhasil diproses! Terkirim: ${sentCount}, Gagal: ${failedCount}`,
      total: recipients.length,
      sentCount,
      failedCount,
      errors
    });
  } catch (err) {
    console.error('[Broadcast WA Error]:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Kirim WA Manual per User dari Dashboard (Bisa by Customer ID atau PPPoE Username)
app.post('/api/admin/customers/:id/send-wa', async (req, res) => {
  if (!isMikrotikConnected()) {
    return res.status(400).json({ success: false, error: 'Router MikroTik sedang terputus / offline.' });
  }
  const { id } = req.params;
  const { type, customMessage } = req.body; // 'promo', 'lunas'

  console.log(`[WA Manual] Menerima request kirim WA untuk param id='${id}', type='${type}'`);

  try {
    let cust = null;
    
    // Cek jika numeric ID
    const numId = parseInt(id, 10);
    if (!isNaN(numId)) {
      cust = db.prepare(`
        SELECT c.*, p.name as plan_name, b.amount as bill_amount, b.period as bill_period, b.payment_method
        FROM customers c
        LEFT JOIN plans p ON c.plan_id = p.id
        LEFT JOIN bills b ON c.id = b.customer_id
        WHERE c.id = ?
        ORDER BY b.id DESC LIMIT 1
      `).get(numId);
    }

    // Jika tidak ketemu by numeric ID, cari berdasarkan username PPPoE atau nama
    if (!cust) {
      cust = db.prepare(`
        SELECT c.*, p.name as plan_name, b.amount as bill_amount, b.period as bill_period, b.payment_method
        FROM customers c
        LEFT JOIN plans p ON c.plan_id = p.id
        LEFT JOIN bills b ON c.id = b.customer_id
        WHERE c.pppoe_username = ? OR c.name = ?
        ORDER BY b.id DESC LIMIT 1
      `).get(id, id);
    }

    if (!cust) {
      console.warn(`[WA Manual] Customer tidak ditemukan untuk query: '${id}'`);
      return res.status(404).json({ error: `Customer '${id}' tidak ditemukan di database` });
    }
    if (!cust.phone || cust.phone === '-') {
      return res.status(400).json({ error: 'Nomor WhatsApp pelanggan belum diisi!' });
    }

    // Pastikan nominal tagihan valid
    const billAmount = cust.bill_amount || 150000;
    const billPeriod = cust.bill_period || '2026-11';

    const baseUrl = getPortalBaseUrl(req);
    const phoneParam = (cust.phone && cust.phone !== '-') ? cust.phone : cust.pppoe_username;
    const portalUrl = `${baseUrl}/user.html?phone=${encodeURIComponent(phoneParam)}`;

    let sendRes;
    if (type === 'promo') {
      // Dapatkan daftar paket aktif untuk dimasukkan ke variabel {plans}
      const allPlans = db.prepare("SELECT name, speed, price FROM plans WHERE name NOT IN ('default', 'default-encryption') ORDER BY price ASC, name ASC").all();
      const plansListText = allPlans.map(p => `• *${p.name}* (${p.speed}) - Rp ${Number(p.price).toLocaleString('id-ID')}/bln`).join('\n');

      // Ambil template dari settings jika tidak disediakan custom di body
      let promoMsg = customMessage;
      if (!promoMsg) {
        promoMsg = db.prepare("SELECT value FROM settings WHERE key = 'promo_template'").get()?.value;
      }

      sendRes = await sendPromoNotice(cust, promoMsg, plansListText, portalUrl);
    } else {
      // Pembayaran Manual / Cash: Mendukung multi-bulan (1, 2, 3, 6, 12 bulan)
      const duration = parseInt(req.body.durationMonths, 10) || 1;
      const singleMonthPrice = cust.bill_amount || 150000;
      const totalAmount = singleMonthPrice * duration;

      const now = new Date();
      const currentMonth = now.getMonth();
      const currentYear = now.getFullYear();

      // Loop buat atau update tagihan bulan-bulan ke depan menjadi 'paid'
      const periodsPaid = [];
      for (let i = 0; i < duration; i++) {
        const targetDate = new Date(currentYear, currentMonth + i, 1);
        const pYear = targetDate.getFullYear();
        const pMonth = String(targetDate.getMonth() + 1).padStart(2, '0');
        const periodKey = `${pYear}-${pMonth}`;
        periodsPaid.push(periodKey);

        const existingBill = db.prepare('SELECT id FROM bills WHERE customer_id = ? AND period = ?').get(cust.id, periodKey);
        if (existingBill) {
          db.prepare("UPDATE bills SET status = 'paid', amount = ?, paid_at = datetime('now', 'localtime'), payment_method = 'Cash / Tunai' WHERE id = ?")
            .run(singleMonthPrice, existingBill.id);
        } else {
          db.prepare("INSERT INTO bills (customer_id, period, amount, status, paid_at, payment_method) VALUES (?, ?, ?, 'paid', datetime('now', 'localtime'), 'Cash / Tunai')")
            .run(cust.id, periodKey, singleMonthPrice);
        }
      }

      // Update status customer di database menjadi 'active'
      db.prepare("UPDATE customers SET status = 'active' WHERE id = ?").run(cust.id);

      // Otomatis ENABLE Secret di router MikroTik (Buka Isolir)
      try {
        await setMikrotikSecretStatus(cust.pppoe_username, true);
        console.log(`[Bayar Cash] Secret ${cust.pppoe_username} otomatis di-ENABLE di MikroTik!`);
      } catch (errMikrotik) {
        console.error(`[Bayar Cash] Gagal enable secret di MikroTik:`, errMikrotik.message);
      }

      // Kirim ucapan terima kasih via WhatsApp
      const periodLabel = periodsPaid.length > 1 
        ? `${periodsPaid[0]} s/d ${periodsPaid[periodsPaid.length - 1]}`
        : periodsPaid[0];

      logActivity('PAYMENT', `Pembayaran Tunai ${cust.name} sebesar Rp ${totalAmount.toLocaleString('id-ID')} (${periodLabel})`, cust.pppoe_username);

      sendRes = await sendPaymentSuccessNotice(cust, { 
        amount: totalAmount, 
        period: periodLabel, 
        durationMonths: duration,
        payment_method: 'Tunai / Cash (Kasir)' 
      });
    }

    if (sendRes.success) {
      const successMsg = type === 'lunas' 
        ? `Pembayaran Cash tercatat lunas! Akun ${cust.pppoe_username} otomatis di-ENABLE di MikroTik & bukti terima kasih terkirim ke WhatsApp.`
        : `Pesan Info & Promo LenxyNet berhasil dikirim ke WhatsApp ${cust.phone}!`;
      res.json({ success: true, message: successMsg });
    } else {
      res.status(400).json({ success: false, error: sendRes.error });
    }
  } catch (err) {
    console.error('[WA Manual] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
app.post('/api/admin/sync-mikrotik', async (req, res) => {
  if (!isMikrotikConnected()) {
    return res.status(400).json({ success: false, error: 'Router MikroTik sedang terputus / offline. Hubungkan router terlebih dahulu.' });
  }
  try {
    const result = await syncFromMikrotik();
    res.json({ success: true, message: `Berhasil sinkronisasi ${result.count} data dari MikroTik!`, count: result.count });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Gagal terhubung ke MikroTik: ' + err.message });
  }
});

// Trigger Manual Pengecekan Auto-Isolir (Untuk tombol di Dashboard)
app.post('/api/admin/trigger-autoisolir', async (req, res) => {
  if (!isMikrotikConnected()) {
    return res.status(400).json({ success: false, error: 'Router MikroTik sedang terputus / offline.' });
  }
  try {
    const baseUrl = getPortalBaseUrl(req);
    const result = await runAutoIsolirCheck(baseUrl);
    let msg = `Cek Isolir selesai! Isolir baru: ${result.isolatedCount}`;
    if (result.waHMinus3Count > 0 || result.waHPlus1Count > 0) {
      msg += ` | Terkirim WA Reminder: ${result.waHMinus3Count + result.waHPlus1Count} pesan`;
    }
    res.json({ success: true, message: msg, details: result });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Gagal menjalankan Auto-Isolir: ' + err.message });
  }
});

// 2. Get Dashboard Stats & Customers
app.get('/api/admin/stats', async (req, res) => {
  try {
    const toleranceDays = db.prepare("SELECT value FROM settings WHERE key = 'tolerance_days'").get()?.value || '3';
    const waStatus = db.prepare("SELECT value FROM settings WHERE key = 'wa_status'").get()?.value || 'disconnected';
    const routerIp = db.prepare("SELECT value FROM settings WHERE key = 'router_ip'").get()?.value || '';
    const routerConnected = db.prepare("SELECT value FROM settings WHERE key = 'router_connected'").get()?.value === 'true';

    // Jika koneksi MikroTik terputus, jangan tampilkan data statistik apapun
    if (!routerConnected) {
      return res.json({
        totalCustomers: 0,
        activeCustomers: 0,
        isolatedCustomers: 0,
        unpaidCount: 0,
        unpaidAmount: 0,
        pendingCount: 0,
        conflictCount: 0,
        toleranceDays: parseInt(toleranceDays),
        waStatus,
        routerIp,
        routerConnected: false
      });
    }

    const totalCustomers = db.prepare('SELECT COUNT(*) as count FROM customers').get().count;
    const activeCustomers = db.prepare("SELECT COUNT(*) as count FROM customers WHERE status = 'active'").get().count;
    const isolatedCustomers = db.prepare("SELECT COUNT(*) as count FROM customers WHERE status = 'isolated'").get().count;
    const unpaidBills = db.prepare("SELECT COUNT(*) as count, SUM(amount) as total FROM bills WHERE status = 'unpaid'").get();
    const pendingBills = db.prepare("SELECT COUNT(*) as count FROM bills WHERE status = 'pending_verification'").get();
    const conflicts = getDataConflicts();

    res.json({
      totalCustomers,
      activeCustomers,
      isolatedCustomers,
      unpaidCount: unpaidBills.count || 0,
      unpaidAmount: unpaidBills.total || 0,
      pendingCount: pendingBills.count || 0,
      conflictCount: conflicts.length,
      toleranceDays: parseInt(toleranceDays),
      waStatus,
      routerIp,
      routerConnected: true
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper ekstrak harga paket dari comment MikroTik atau pola nama profile
function extractPriceFromProfile(p) {
  // 1. Prioritas Utama: Baca Comment dari MikroTik (misal: 150000, 150.000, 150k, 150rb)
  if (p && p.comment !== undefined && p.comment !== null) {
    const strComment = String(p.comment).trim();
    if (strComment !== '') {
      // Cek pola angka + 'k' atau 'rb' (misal: 150k, 150rb, 59k)
      const kMatch = strComment.match(/^(\d+)\s*(k|rb)$/i);
      if (kMatch) {
        return parseInt(kMatch[1], 10) * 1000;
      }
      // Ambil hanya digit angka (misal "150000", "150.000", "Rp 150.000")
      const digits = strComment.replace(/\D/g, '');
      if (digits) {
        const val = parseInt(digits, 10);
        if (!isNaN(val) && val > 0) return val;
      }
    }
  }

  // 2. Fallback: Ekstrak dari Nama Profile jika comment kosong (misal "150rb" atau "150k")
  if (p && p.name) {
    const nameMatch = String(p.name).match(/(\d+)\s*(rb|k)/i);
    if (nameMatch) {
      return parseInt(nameMatch[1], 10) * 1000;
    }
  }

  // 3. Nilai default jika comment dan nama tidak mengandung angka harga
  return 100000;
}

// Get Available Profiles/Plans (Real-Time from MikroTik)
app.get('/api/admin/plans', async (req, res) => {
  const isConn = db.prepare("SELECT value FROM settings WHERE key = 'router_connected'").get()?.value === 'true';
  if (!isConn) {
    const offlinePlans = db.prepare('SELECT * FROM plans ORDER BY price ASC, name ASC').all();
    return res.json(offlinePlans);
  }
  try {
    // Ambil profile langsung dari MikroTik
    const { api, client } = await require('./mikrotik').getMikrotikClient();
    const mikrotikProfiles = await client.menu('/ppp profile').get();
    api.close();

    // Filter hanya profile paket asli (Hilangkan default dan default-encryption)
    const validProfiles = mikrotikProfiles.filter(p => p.name !== 'default' && p.name !== 'default-encryption');
    
    // Sinkronkan ke tabel plans (otomatis update harga dari comment MikroTik)
    validProfiles.forEach(p => {
      const speed = p['rate-limit'] || p.rateLimit || 'Unlimited';
      const price = extractPriceFromProfile(p);
      const existing = db.prepare('SELECT id FROM plans WHERE profile = ?').get(p.name);
      if (existing) {
        db.prepare('UPDATE plans SET price = ?, speed = ?, name = ? WHERE id = ?').run(price, speed, p.name, existing.id);
      } else {
        db.prepare('INSERT INTO plans (name, profile, price, speed) VALUES (?, ?, ?, ?)').run(p.name, p.name, price, speed);
      }
    });

    const profileNames = validProfiles.map(p => p.name);
    let plans = [];
    if (profileNames.length > 0) {
      const placeholders = profileNames.map(() => '?').join(',');
      plans = db.prepare(`SELECT * FROM plans WHERE profile IN (${placeholders}) ORDER BY price ASC, name ASC`).all(...profileNames);
    } else {
      plans = db.prepare('SELECT * FROM plans ORDER BY price ASC, name ASC').all();
    }
    res.json(plans);
  } catch (err) {
    // Fallback ke database jika MikroTik timeout, urutkan harga terendah
    const plans = db.prepare('SELECT * FROM plans ORDER BY price ASC, name ASC').all();
    res.json(plans);
  }
});

// Tambah Pelanggan Baru (Otomatis ke MikroTik + SQLite)
app.post('/api/admin/customers', async (req, res) => {
  const isConn = db.prepare("SELECT value FROM settings WHERE key = 'router_connected'").get()?.value === 'true';
  if (!isConn) {
    return res.status(400).json({ error: 'Router MikroTik sedang terputus / offline. Hubungkan router terlebih dahulu sebelum menambah pelanggan.' });
  }

  const { name, password, profile, phone, dueDate, comment, initialPayment } = req.body;
  if (!name || !password) {
    return res.status(400).json({ error: 'Nama/Username dan Password wajib diisi!' });
  }

  const cleanName = name.trim();

  // Validasi awal: Cek apakah nama sudah ada di Database
  const existingCust = db.prepare('SELECT id FROM customers WHERE pppoe_username = ?').get(cleanName);
  if (existingCust) {
    return res.status(400).json({ error: `Username/Nama '${cleanName}' sudah terdaftar di sistem! Gunakan nama yang berbeda.` });
  }

  // Validasi awal: Cek apakah nomor WhatsApp sudah terdaftar di Database / sistem
  if (phone && phone.trim() !== '-' && phone.trim() !== '') {
    const dupPhone = findPhoneDuplicate(phone);
    if (dupPhone) {
      return res.status(400).json({ 
        success: false, 
        error: `Nomor WhatsApp '${phone}' sudah terdaftar pada pelanggan '${dupPhone.name}' (${dupPhone.pppoe_username})! Nomor WhatsApp tidak boleh sama.` 
      });
    }
  }

  try {
    await addCustomerToMikrotik({
      name: cleanName,
      password: String(password).trim(),
      profile,
      phone: phone ? phone.trim() : '-',
      dueDate: parseInt(dueDate) || 10,
      comment,
      initialPayment: initialPayment || 'unpaid'
    });
    res.json({ success: true, message: `Pelanggan '${cleanName}' berhasil ditambahkan ke MikroTik & Database!` });
  } catch (err) {
    // Tangani error duplikat nama di MikroTik dengan bahasa yang ramah
    if (err.message && err.message.includes('already exists')) {
      return res.status(400).json({ success: false, error: `Nama/Secret '${cleanName}' sudah ada di dalam router MikroTik!` });
    }
    res.status(500).json({ success: false, error: 'Gagal menambahkan ke MikroTik: ' + err.message });
  }
});

// Update Nomor WA Pelanggan (Sync ke Caller ID MikroTik)
app.post('/api/admin/customers/:id/update-phone', requireAdminAuth, requireMikrotikConnected, async (req, res) => {
  const { id } = req.params;
  const { phone } = req.body;
  const cust = db.prepare('SELECT pppoe_username FROM customers WHERE id = ?').get(id);
  if (!cust) return res.status(404).json({ error: 'Customer not found' });

  // Validasi duplikasi nomor WhatsApp dengan pelanggan lain
  if (phone && phone.trim() !== '-' && phone.trim() !== '') {
    const dupPhone = findPhoneDuplicate(phone, id);
    if (dupPhone) {
      return res.status(400).json({ 
        success: false, 
        error: `Nomor WhatsApp '${phone}' sudah digunakan oleh pelanggan '${dupPhone.name}' (${dupPhone.pppoe_username})!` 
      });
    }
  }

  try {
    await updateCustomerPhoneInMikrotik(cust.pppoe_username, phone || '');
    logActivity('UPDATE_CUSTOMER', `Update nomor WA ${cust.pppoe_username} -> ${phone || '-'}`, cust.pppoe_username);
    res.json({ success: true, message: 'Nomor WhatsApp berhasil disinkronkan ke Caller ID MikroTik!' });
  } catch (err) {
    res.status(500).json({ error: 'Gagal update Caller ID di MikroTik: ' + err.message });
  }
});

// Update Tanggal Jatuh Tempo Pelanggan (Sync ke Comment MikroTik & Database)
app.post('/api/admin/customers/:id/update-due-date', requireAdminAuth, requireMikrotikConnected, async (req, res) => {
  const { id } = req.params;
  const { dueDate } = req.body;
  const cust = db.prepare('SELECT id, name, pppoe_username, due_date FROM customers WHERE id = ?').get(id);
  if (!cust) return res.status(404).json({ error: 'Pelanggan tidak ditemukan!' });

  const numDue = parseInt(dueDate, 10);
  if (isNaN(numDue) || numDue < 1 || numDue > 31) {
    return res.status(400).json({ error: 'Tanggal jatuh tempo harus berupa angka antara 1 sampai 31!' });
  }

  try {
    await updateCustomerDueDateInMikrotik(cust.pppoe_username, numDue);
    logActivity('UPDATE_CUSTOMER', `Ubah jatuh tempo ${cust.pppoe_username} dari tgl ${cust.due_date} ke tgl ${numDue}`, cust.pppoe_username);
    res.json({ 
      success: true, 
      message: `Tanggal jatuh tempo ${cust.pppoe_username} berhasil diubah ke tgl ${numDue} dan disinkronkan ke MikroTik!`,
      dueDate: numDue
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Gagal update ke MikroTik: ' + err.message });
  }
});

// Update Data Pelanggan Lengkap (Jatuh Tempo, No WA, Password, Paket Profile)
app.put('/api/admin/customers/:id', requireAdminAuth, requireMikrotikConnected, async (req, res) => {
  const { id } = req.params;
  const { dueDate, phone, password, profile } = req.body;
  const cust = db.prepare('SELECT id, name, pppoe_username, due_date, phone, plan_id FROM customers WHERE id = ?').get(id);
  if (!cust) return res.status(404).json({ error: 'Pelanggan tidak ditemukan!' });

  // Validasi duplikasi nomor WhatsApp dengan pelanggan lain
  if (phone && phone.trim() !== '-' && phone.trim() !== '') {
    const dupPhone = findPhoneDuplicate(phone, id);
    if (dupPhone) {
      return res.status(400).json({ 
        success: false, 
        error: `Nomor WhatsApp '${phone}' sudah digunakan oleh pelanggan lain: '${dupPhone.name}' (${dupPhone.pppoe_username})!` 
      });
    }
  }

  try {
    await updateCustomerInMikrotik(cust.pppoe_username, { dueDate, phone, password, profile });
    logActivity('UPDATE_CUSTOMER', `Update data ${cust.pppoe_username} (Jatuh Tempo: ${dueDate || cust.due_date})`, cust.pppoe_username);
    res.json({ 
      success: true, 
      message: `Data pelanggan '${cust.pppoe_username}' berhasil diperbarui dan disinkronkan ke MikroTik & Database!` 
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Gagal update ke MikroTik: ' + err.message });
  }
});

app.post('/api/admin/customers/:id/update', requireAdminAuth, requireMikrotikConnected, async (req, res) => {
  // Alias POST untuk klien yang kesulitan dengan method PUT
  const { id } = req.params;
  const { dueDate, phone, password, profile } = req.body;
  const cust = db.prepare('SELECT id, name, pppoe_username, due_date, phone, plan_id FROM customers WHERE id = ?').get(id);
  if (!cust) return res.status(404).json({ error: 'Pelanggan tidak ditemukan!' });

  // Validasi duplikasi nomor WhatsApp dengan pelanggan lain
  if (phone && phone.trim() !== '-' && phone.trim() !== '') {
    const dupPhone = findPhoneDuplicate(phone, id);
    if (dupPhone) {
      return res.status(400).json({ 
        success: false, 
        error: `Nomor WhatsApp '${phone}' sudah digunakan oleh pelanggan lain: '${dupPhone.name}' (${dupPhone.pppoe_username})!` 
      });
    }
  }

  try {
    await updateCustomerInMikrotik(cust.pppoe_username, { dueDate, phone, password, profile });
    logActivity('UPDATE_CUSTOMER', `Update data ${cust.pppoe_username} (Jatuh Tempo: ${dueDate || cust.due_date})`, cust.pppoe_username);
    res.json({ 
      success: true, 
      message: `Data pelanggan '${cust.pppoe_username}' berhasil diperbarui dan disinkronkan ke MikroTik & Database!` 
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Gagal update ke MikroTik: ' + err.message });
  }
});

// Hapus Pelanggan
app.delete('/api/admin/customers/:id', requireMikrotikConnected, async (req, res) => {
  const { id } = req.params;
  const cust = db.prepare('SELECT pppoe_username FROM customers WHERE id = ?').get(id);
  if (!cust) return res.status(404).json({ error: 'Customer not found' });

  try {
    const result = await removeCustomerFromMikrotik(cust.pppoe_username, id);
    let message = `Pelanggan ${cust.pppoe_username}, database, dan seluruh file bukti pembayaran berhasil dihapus bersih!`;
    if (result.warning) {
      message = `Pelanggan ${cust.pppoe_username}, database, dan seluruh file bukti pembayaran berhasil dihapus bersih. (Catatan: ${result.warning})`;
    }
    res.json({ success: true, message });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper menghitung tanggal lengkap jatuh tempo berikutnya (Tgl Bulan Tahun)
function formatNextDueDate(dueDate, lastPaidPeriod) {
  if (!dueDate || dueDate === 0 || dueDate === 'null') {
    return 'Belum Diatur';
  }
  const monthNames = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  const day = String(dueDate).padStart(2, '0');

  if (lastPaidPeriod) {
    const parts = lastPaidPeriod.split('-').map(Number);
    const target = new Date(parts[0], parts[1], dueDate); // parts[1] otomatis jadi bulan berikutnya
    return `${String(target.getDate()).padStart(2, '0')} ${monthNames[target.getMonth()]} ${target.getFullYear()}`;
  } else {
    const now = new Date();
    return `${day} ${monthNames[now.getMonth()]} ${now.getFullYear()}`;
  }
}

app.get('/api/admin/customers', async (req, res) => {
  try {
    const isConn = db.prepare("SELECT value FROM settings WHERE key = 'router_connected'").get()?.value === 'true';
    if (!isConn) {
      return res.json({ connected: false, customers: [] });
    }

    const now = new Date();
    const currentPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const query = `
      SELECT c.*, p.name as plan_name, p.speed as plan_speed, p.price as plan_price,
             b.id as bill_id, b.status as bill_status, b.amount as bill_amount, b.period as bill_period, b.paid_at
      FROM customers c
      LEFT JOIN plans p ON c.plan_id = p.id
      LEFT JOIN bills b ON c.id = b.customer_id AND b.period = ?
      ORDER BY c.id DESC
    `;
    const customers = db.prepare(query).all(currentPeriod);

    // Ambil data konflik nomor telepon
    const conflicts = getDataConflicts();
    const conflictPhoneSet = new Set(conflicts.map(item => item.phone));

    // Dapatkan data live dari MikroTik
    let liveMikrotik = [];
    try {
      liveMikrotik = await getMikrotikLiveStatus();
    } catch (e) {
      console.warn('Could not fetch live mikrotik status:', e.message);
    }
    const liveMap = new Map(liveMikrotik.map(m => [m.name, m]));

    // Gabungkan data
    const enriched = customers.map(c => {
      const live = liveMap.get(c.pppoe_username) || {};

      // Cek periode terakhir yang sudah lunas untuk pelanggan ini
      const lastPaid = db.prepare("SELECT period FROM bills WHERE customer_id = ? AND status = 'paid' ORDER BY period DESC LIMIT 1").get(c.id);
      const nextDueFull = formatNextDueDate(c.due_date, lastPaid ? lastPaid.period : null);
      const normPhone = normalizePhoneNumber(c.phone);

      return {
        ...c,
        service: live.service || 'pppoe',
        localAddress: live.localAddress || '-',
        remoteAddress: live.remoteAddress || '-',
        callerId: live.callerId || '-',
        uptime: live.uptime || '-',
        isOnline: live.isOnline || false,
        comment: live.comment || '',
        mikrotikDisabled: live.disabled !== undefined ? live.disabled : (c.status === 'isolated'),
        nextDueDateFull: nextDueFull,
        paidUntilPeriod: lastPaid ? lastPaid.period : null,
        isConflictPhone: normPhone !== '-' && conflictPhoneSet.has(normPhone)
      };
    });

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint Daftar Konflik / Duplikasi Nomor WhatsApp
app.get('/api/admin/data-conflicts', requireAdminAuth, (req, res) => {
  if (!isMikrotikConnected()) {
    return res.json({ success: true, count: 0, conflicts: [] });
  }
  try {
    const conflicts = getDataConflicts();
    res.json({
      success: true,
      count: conflicts.length,
      conflicts: conflicts
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update Tolerance Days
app.post('/api/admin/settings/tolerance', (req, res) => {
  const { days } = req.body;
  db.prepare("UPDATE settings SET value = ? WHERE key = 'tolerance_days'").run(String(days));
  res.json({ success: true, toleranceDays: days });
});

// Fitur Darurat Admin: Ubah Status Tagihan Secara Manual (Lunas <-> Belum Bayar)
app.post('/api/admin/customers/:id/toggle-bill-status', requireAdminAuth, requireMikrotikConnected, async (req, res) => {
  try {
    const { id } = req.params;
    const { targetStatus, unisolir, sendWaReceipt, period } = req.body; // targetStatus: 'paid' | 'unpaid'

    const cust = db.prepare(`
      SELECT c.*, p.price as plan_price, p.name as plan_name 
      FROM customers c 
      LEFT JOIN plans p ON c.plan_id = p.id 
      WHERE c.id = ?
    `).get(id);

    if (!cust) {
      return res.status(404).json({ success: false, error: 'Pelanggan tidak ditemukan!' });
    }

    const now = new Date();
    const curPeriod = period || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    let bill = db.prepare('SELECT * FROM bills WHERE customer_id = ? AND period = ?').get(id, curPeriod);

    if (targetStatus === 'paid') {
      const amount = bill ? bill.amount : (cust.plan_price || 100000);
      if (!bill) {
        db.prepare(`
          INSERT INTO bills (customer_id, period, amount, status, payment_method, paid_at)
          VALUES (?, ?, ?, 'paid', 'Manual Admin (Darurat)', datetime('now', 'localtime'))
        `).run(id, curPeriod, amount);
      } else {
        db.prepare(`
          UPDATE bills 
          SET status = 'paid',
              paid_at = datetime('now', 'localtime'),
              payment_method = 'Manual Admin (Darurat)'
          WHERE id = ?
        `).run(bill.id);
      }

      let mikrotikUpdated = false;
      if (unisolir !== false) {
        db.prepare("UPDATE customers SET status = 'active' WHERE id = ?").run(id);
        try {
          await setMikrotikSecretStatus(cust.pppoe_username, true);
          mikrotikUpdated = true;
        } catch (e) {
          console.error('[Manual Payment] Gagal unisolir MikroTik:', e.message);
        }
      }

      logActivity('PAYMENT', `Admin secara manual mengubah status tagihan menjadi LUNAS (${curPeriod})`, cust.pppoe_username);

      // Kirim struk WhatsApp jika dipilih
      if (sendWaReceipt && cust.phone && cust.phone !== '-') {
        try {
          await sendPaymentSuccessNotice(
            { name: cust.name, pppoe_username: cust.pppoe_username, phone: cust.phone, plan_name: cust.plan_name },
            { period: curPeriod, amount: amount, durationMonths: 1, payment_method: 'Manual Admin (Darurat)' }
          );
        } catch (errWa) {
          console.warn('[WhatsApp] Gagal kirim struk lunas manual:', errWa.message);
        }
      }

      return res.json({
        success: true,
        message: `Status tagihan ${cust.name} berhasil diubah menjadi LUNAS!${mikrotikUpdated ? ' Layanan MikroTik telah diaktifkan.' : ''}`
      });
    } else {
      // Ubah status menjadi BELUM BAYAR (unpaid)
      if (bill) {
        db.prepare(`
          UPDATE bills 
          SET status = 'unpaid',
              paid_at = NULL,
              payment_method = NULL
          WHERE id = ?
        `).run(bill.id);
      } else {
        const amount = cust.plan_price || 100000;
        db.prepare(`
          INSERT INTO bills (customer_id, period, amount, status)
          VALUES (?, ?, ?, 'unpaid')
        `).run(id, curPeriod, amount);
      }

      // Otomatis ubah status pelanggan jadi 'isolated' dan isolir di MikroTik (Disable + Kick Sesi Aktif)
      db.prepare("UPDATE customers SET status = 'isolated' WHERE id = ?").run(id);
      let mikrotikIsolated = false;
      try {
        await setMikrotikSecretStatus(cust.pppoe_username, false);
        mikrotikIsolated = true;
      } catch (e) {
        console.error('[Manual Payment] Gagal isolir MikroTik saat ubah ke Belum Bayar:', e.message);
      }

      logActivity('PAYMENT', `Admin secara manual mengubah status tagihan menjadi BELUM BAYAR (${curPeriod}) & mengisolir layanan`, cust.pppoe_username);

      return res.json({
        success: true,
        message: `Status tagihan ${cust.name} berhasil diubah menjadi BELUM BAYAR.${mikrotikIsolated ? ' Layanan MikroTik telah diisolir & koneksi aktif diputus.' : ''}`
      });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Manual Toggle Status (Isolir / Aktifkan) - SINKRON KE MIKROTIK LANGSUNG
app.post('/api/admin/customers/:id/toggle-status', requireMikrotikConnected, async (req, res) => {
  const { id } = req.params;
  const cust = db.prepare('SELECT pppoe_username, status FROM customers WHERE id = ?').get(id);
  if (!cust) return res.status(404).json({ error: 'Customer not found' });

  const willBeActive = cust.status === 'isolated';
  const newStatus = willBeActive ? 'active' : 'isolated';

  try {
    // 1. Ubah di RouterOS MikroTik
    await setMikrotikSecretStatus(cust.pppoe_username, willBeActive);

    // 2. Simpan perubahan ke SQLite
    db.prepare('UPDATE customers SET status = ? WHERE id = ?').run(newStatus, id);

    res.json({
      success: true,
      status: newStatus,
      message: willBeActive 
        ? `User ${cust.pppoe_username} berhasil DI-AKTIFKAN di MikroTik!`
        : `User ${cust.pppoe_username} berhasil DI-ISOLIR & koneksi aktif diputus di MikroTik!`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Gagal mengubah status di MikroTik: ' + err.message });
  }
});

// === ENDPOINT VERIFIKASI OTP WHATSAPP UNTUK USER PORTAL ===

// 1. Request OTP ke nomor WhatsApp (Dengan Cooldown 60 Detik Anti-Spam)
app.post('/api/user/request-otp', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Nomor WhatsApp wajib diisi!' });

  const cleanPhone = normalizePhoneNumber(phone);
  if (cleanPhone === '-' || cleanPhone.length < 9) {
    return res.status(400).json({ error: 'Format nomor WhatsApp tidak valid!' });
  }

  try {
    // 1. Cek apakah nomor WA ini terdaftar di database
    const cust = db.prepare(`
      SELECT * FROM customers 
      WHERE phone = ? OR phone = ? OR phone = ?
    `).get(cleanPhone, cleanPhone.replace(/^0/, ''), '62' + cleanPhone.replace(/^0/, ''));

    if (!cust) {
      return res.status(404).json({ 
        error: 'Nomor WhatsApp tidak terdaftar di sistem LenxyNet. Pastikan nomor sesuai dengan yang didaftarkan pada pemasangan.' 
      });
    }

    // 2. Cooldown check: Cek apakah ada request OTP sebelumnya dalam kurun waktu 60 detik
    const prevOTP = db.prepare('SELECT * FROM otp_codes WHERE phone = ?').get(cleanPhone);
    if (prevOTP && prevOTP.last_requested_at) {
      const lastReqTime = new Date(prevOTP.last_requested_at).getTime();
      const nowTime = Date.now();
      const elapsedSec = Math.floor((nowTime - lastReqTime) / 1000);
      const cooldownSec = 60;
      if (elapsedSec < cooldownSec) {
        const remaining = cooldownSec - elapsedSec;
        return res.status(429).json({ 
          error: `Harap tunggu ${remaining} detik sebelum meminta kode OTP baru.` 
        });
      }
    }

    // 3. Generate 4 digit OTP acak & masa berlaku 5 menit
    const otp = String(Math.floor(1000 + Math.random() * 9000));
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    // Simpan ke SQLite otp_codes dengan reset attempts = 0 dan last_requested_at = now
    db.prepare(`
      INSERT INTO otp_codes (phone, code, customer_id, expires_at, attempts, last_requested_at)
      VALUES (?, ?, ?, ?, 0, datetime('now', 'localtime'))
      ON CONFLICT(phone) DO UPDATE SET 
        code = excluded.code, 
        customer_id = excluded.customer_id, 
        expires_at = excluded.expires_at, 
        attempts = 0,
        last_requested_at = datetime('now', 'localtime')
    `).run(cleanPhone, otp, cust.id, expiresAt);

    // 4. Kirim pesan OTP via Bot WhatsApp
    const otpMessage = `*KODE VERIFIKASI LENXYNET* 🔐
Halo Bapak/Ibu *${cust.name}*,

Kode OTP untuk masuk ke Portal Pelanggan Anda adalah:
👉 *${otp}*

_Kode ini bersifat rahasia dan hanya berlaku selama 5 menit. Jangan berikan kode ini kepada siapa pun demi keamanan akun Anda._`;

    const sendRes = await require('./wa').sendWhatsAppMessage(cust.phone, otpMessage);
    if (!sendRes.success) {
      return res.status(500).json({ error: 'Gagal mengirim kode ke WhatsApp: ' + sendRes.error });
    }

    logActivity('WA_SENT', `Kirim OTP ke pelanggan ${cust.name}`, cust.pppoe_username);

    res.json({ 
      success: true, 
      message: `Kode OTP 4 digit telah dikirim ke WhatsApp ${cust.phone}!`,
      phone: cust.phone
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Verifikasi OTP dan Login ke Portal (Batas Salah Tebak Max 3x)
app.post('/api/user/verify-otp', (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) return res.status(400).json({ error: 'Nomor WhatsApp dan kode OTP wajib diisi!' });

  const cleanPhone = normalizePhoneNumber(phone);
  const record = db.prepare('SELECT * FROM otp_codes WHERE phone = ?').get(cleanPhone);
  if (!record) {
    return res.status(400).json({ error: 'Permintaan OTP tidak ditemukan atau telah kedaluwarsa. Silakan minta kode OTP baru.' });
  }

  // Cek jika sudah melebihi 3x salah tebak
  if (record.attempts >= 3) {
    db.prepare('DELETE FROM otp_codes WHERE phone = ?').run(record.phone);
    return res.status(429).json({ error: 'Terlalu banyak percobaan salah (3x). Kode OTP dibatalkan demi keamanan, silakan minta kode baru.' });
  }

  // Cek masa berlaku (5 menit)
  const now = new Date();
  const expireDate = new Date(record.expires_at);
  if (now > expireDate) {
    db.prepare('DELETE FROM otp_codes WHERE phone = ?').run(record.phone);
    return res.status(400).json({ error: 'Kode OTP telah kadaluarsa. Silakan minta kode baru.' });
  }

  // Cek kecocokan kode OTP
  if (record.code !== String(code).trim()) {
    const newAttempts = (record.attempts || 0) + 1;
    db.prepare('UPDATE otp_codes SET attempts = ? WHERE phone = ?').run(newAttempts, record.phone);
    const remaining = 3 - newAttempts;
    if (remaining <= 0) {
      db.prepare('DELETE FROM otp_codes WHERE phone = ?').run(record.phone);
      return res.status(400).json({ error: 'Kode OTP salah 3 kali! Kode telah hangus demi keamanan, silakan minta kode baru.' });
    }
    return res.status(400).json({ error: `Kode OTP salah! Sisa percobaan: ${remaining} kali.` });
  }

  // OTP Benar! Ambil data customer & hapus OTP
  const cust = db.prepare('SELECT id, name, pppoe_username, phone FROM customers WHERE id = ?').get(record.customer_id);
  db.prepare('DELETE FROM otp_codes WHERE phone = ?').run(record.phone);

  if (!cust) {
    return res.status(404).json({ error: 'Akun pelanggan tidak ditemukan.' });
  }

  // Terbitkan token sesi pelanggan persisten (berlaku 180 hari / tersimpan permanen di browser)
  const userToken = 'lx_usr_' + crypto.randomBytes(24).toString('hex');
  db.prepare("INSERT INTO user_sessions (token, customer_id, pppoe_username, expires_at) VALUES (?, ?, ?, datetime('now', '+180 days', 'localtime'))")
    .run(userToken, cust.id, cust.pppoe_username);

  logActivity('LOGIN', `Pelanggan login ke portal (${cust.name})`, cust.pppoe_username);

  res.json({
    success: true,
    message: 'Verifikasi berhasil! Selamat datang di Portal LenxyNet.',
    token: userToken,
    user: cust
  });
});

// Route Logout Portal Pelanggan
app.post('/api/user/logout', (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7).trim();
    db.prepare("DELETE FROM user_sessions WHERE token = ?").run(token);
  }
  res.json({ success: true, message: 'Logout berhasil' });
});

// 3. User Portal Data (Terlindungi Sesi Handshake)
app.get('/api/user/portal', requireUserOrAdminAuth, async (req, res) => {
  try {
    let customerId = null;
    let identifier = null;

    if (req.userSession) {
      // Pelanggan hanya boleh mengakses data miliknya sendiri
      customerId = req.userSession.customer_id;
    } else if (req.adminSession) {
      // Admin diizinkan melihat data pelanggan via query ?id=
      identifier = req.query.id;
    }

    let user = null;
    if (customerId) {
      const query = `
        SELECT c.*, p.name as plan_name, p.speed as plan_speed, p.price as plan_price,
               b.id as bill_id, b.status as bill_status, b.amount as bill_amount, b.period as bill_period, b.paid_at,
               b.proof_image, b.proof_uploaded_at, b.rejection_reason
        FROM customers c
        LEFT JOIN plans p ON c.plan_id = p.id
        LEFT JOIN bills b ON c.id = b.customer_id
        WHERE c.id = ?
        ORDER BY b.id DESC LIMIT 1
      `;
      user = db.prepare(query).get(customerId);
    } else if (identifier) {
      const query = `
        SELECT c.*, p.name as plan_name, p.speed as plan_speed, p.price as plan_price,
               b.id as bill_id, b.status as bill_status, b.amount as bill_amount, b.period as bill_period, b.paid_at,
               b.proof_image, b.proof_uploaded_at, b.rejection_reason
        FROM customers c
        LEFT JOIN plans p ON c.plan_id = p.id
        LEFT JOIN bills b ON c.id = b.customer_id
        WHERE c.pppoe_username = ? OR c.name = ? OR c.phone = ?
        ORDER BY b.id DESC LIMIT 1
      `;
      user = db.prepare(query).get(identifier, identifier, identifier);
    }

    if (!user) return res.status(404).json({ error: 'Pelanggan tidak ditemukan' });

    // Jika belum ada tagihan sama sekali, buatkan tagihan default periode berjalan
    if (!user.bill_id) {
      const now = new Date();
      const currentPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const amount = user.plan_price || 150000;
      const insertBill = db.prepare('INSERT INTO bills (customer_id, period, amount, status) VALUES (?, ?, ?, ?)').run(user.id, currentPeriod, amount, 'unpaid');
      user.bill_id = insertBill.lastInsertRowid;
      user.bill_status = 'unpaid';
      user.bill_amount = amount;
      user.bill_period = currentPeriod;
      user.proof_image = null;
      user.proof_uploaded_at = null;
      user.rejection_reason = null;
    }

    // Dapatkan data tanggal jatuh tempo lengkap dan periode yang sudah dibayar
    const lastPaid = db.prepare("SELECT period FROM bills WHERE customer_id = ? AND status = 'paid' ORDER BY period DESC LIMIT 1").get(user.id);
    const nextDueFull = formatNextDueDate(user.due_date, lastPaid ? lastPaid.period : null);

    // Dapatkan data live koneksi dari MikroTik untuk user ini
    let liveData = { isOnline: false, uptime: '-', remoteAddress: '-' };
    if (isMikrotikConnected()) {
      try {
        const { api, client } = await require('./mikrotik').getMikrotikClient();
        const actives = await client.menu('/ppp active').get();
        const activeSession = actives.find(a => a.name === user.pppoe_username);
        if (activeSession) {
          liveData = {
            isOnline: true,
            uptime: activeSession.uptime || '-',
            remoteAddress: activeSession.address || '-'
          };
        }
        api.close();
      } catch (e) {
        console.warn('Could not fetch active status for user portal:', e.message);
      }
    }

    const toleranceDays = parseInt(db.prepare("SELECT value FROM settings WHERE key = 'tolerance_days'").get()?.value || '3');
    const qrisImage = db.prepare("SELECT value FROM settings WHERE key = 'qris_image'").get()?.value || '/uploads/qris/default-qris.png';
    const mockPaymentEnabled = db.prepare("SELECT value FROM settings WHERE key = 'mock_payment_enabled'").get()?.value === 'true';

    res.json({
      user: {
        ...user,
        isOnline: liveData.isOnline,
        uptime: liveData.uptime,
        remoteAddress: liveData.remoteAddress,
        nextDueDateFull: nextDueFull,
        paidUntilPeriod: lastPaid ? lastPaid.period : null
      },
      toleranceDays,
      qrisImage,
      mockPaymentEnabled
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mock Pay via QRIS - SAAT LUNAS OTOMATIS ENABLE DI MIKROTIK (Terlindungi Sesi & Setting)
app.post('/api/user/pay-qris', requireUserOrAdminAuth, async (req, res) => {
  const mockEnabled = db.prepare("SELECT value FROM settings WHERE key = 'mock_payment_enabled'").get()?.value === 'true';
  if (!mockEnabled) {
    return res.status(403).json({ error: 'Simulasi pelunasan QRIS mandiri dinonaktifkan oleh administrator.' });
  }

  const { bill_id, durationMonths } = req.body;
  if (!bill_id) return res.status(400).json({ error: 'Bill ID required' });

  // Validasi kepemilikan tagihan: user hanya bisa melunasi tagihannya sendiri
  let bill = null;
  if (req.userSession) {
    bill = db.prepare('SELECT customer_id, period, amount FROM bills WHERE id = ? AND customer_id = ?').get(bill_id, req.userSession.customer_id);
  } else if (req.adminSession) {
    bill = db.prepare('SELECT customer_id, period, amount FROM bills WHERE id = ?').get(bill_id);
  }

  if (!bill) {
    return res.status(403).json({ error: 'Tagihan tidak ditemukan atau Anda tidak memiliki akses ke tagihan ini.' });
  }

  const duration = parseInt(durationMonths, 10) || 1;
  const cust = db.prepare('SELECT * FROM customers WHERE id = ?').get(bill.customer_id);
  const singleMonthPrice = bill.amount;
  const totalAmount = singleMonthPrice * duration;

  const now = new Date();
  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();

  // Loop lunasi atau buat periode ke depan
  const periodsPaid = [];
  for (let i = 0; i < duration; i++) {
    const targetDate = new Date(currentYear, currentMonth + i, 1);
    const pYear = targetDate.getFullYear();
    const pMonth = String(targetDate.getMonth() + 1).padStart(2, '0');
    const periodKey = `${pYear}-${pMonth}`;
    periodsPaid.push(periodKey);

    const existingBill = db.prepare('SELECT id FROM bills WHERE customer_id = ? AND period = ?').get(bill.customer_id, periodKey);
    if (existingBill) {
      db.prepare("UPDATE bills SET status = 'paid', amount = ?, paid_at = datetime('now', 'localtime'), payment_method = 'QRIS' WHERE id = ?")
        .run(singleMonthPrice, existingBill.id);
    } else {
      db.prepare("INSERT INTO bills (customer_id, period, amount, status, paid_at, payment_method) VALUES (?, ?, ?, 'paid', datetime('now', 'localtime'), 'QRIS')")
        .run(bill.customer_id, periodKey, singleMonthPrice);
    }
  }
  
  // Auto unisolir customer jika sebelumnya terisolir
  db.prepare("UPDATE customers SET status = 'active' WHERE id = ?").run(bill.customer_id);
  
  logActivity('PAYMENT', `Pembayaran Mandiri QRIS sebesar Rp ${totalAmount.toLocaleString('id-ID')} (${duration} bln)`, cust ? cust.pppoe_username : 'USER');
  
  // Aktifkan kembali di MikroTik
  if (cust) {
    try {
      await setMikrotikSecretStatus(cust.pppoe_username, true);
    } catch (e) {
      console.error('Failed to enable secret on MikroTik upon payment:', e.message);
    }

    // Kirim Notifikasi WhatsApp Terima Kasih & Bukti Pembayaran Lunas
    if (cust.phone && cust.phone !== '-') {
      try {
        const periodLabel = periodsPaid.length > 1 
          ? `${periodsPaid[0]} s/d ${periodsPaid[periodsPaid.length - 1]}`
          : periodsPaid[0];

        await sendPaymentSuccessNotice(cust, { 
          period: periodLabel, 
          amount: totalAmount, 
          durationMonths: duration,
          payment_method: 'QRIS Instan' 
        });
        console.log(`[WhatsApp] Bukti bayar terkirim ke ${cust.phone}`);
      } catch (e) {
        console.warn('[WhatsApp] Gagal kirim bukti bayar:', e.message);
      }
    }
  }

  res.json({ success: true, message: 'Pembayaran QRIS Berhasil! Akun MikroTik otomatis aktif kembali.' });
});

// === ENDPOINTS SISTEM QRIS STATIS TOKO & VERIFIKASI BUKTI TRANSFER ===

// 1. Ambil Pengaturan QRIS Toko & Domain Publik Portal
app.get('/api/settings/qris', (req, res) => {
  try {
    const qrisImage = db.prepare("SELECT value FROM settings WHERE key = 'qris_image'").get()?.value || '/uploads/qris/default-qris.png';
    const adminWaNumber = db.prepare("SELECT value FROM settings WHERE key = 'admin_wa_number'").get()?.value || '';
    const mockPaymentEnabled = db.prepare("SELECT value FROM settings WHERE key = 'mock_payment_enabled'").get()?.value === 'true';
    const publicPortalUrl = db.prepare("SELECT value FROM settings WHERE key = 'public_portal_url'").get()?.value || '';
    res.json({
      qrisImage,
      adminWaNumber,
      mockPaymentEnabled,
      publicPortalUrl
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Simpan Pengaturan QRIS Toko, WhatsApp Admin, dan Domain Publik Portal
app.post('/api/admin/settings/qris', requireAdminAuth, (req, res) => {
  try {
    const { admin_wa_number, mock_payment_enabled, qris_image_data, public_portal_url } = req.body;

    if (admin_wa_number !== undefined) {
      db.prepare("INSERT INTO settings (key, value) VALUES ('admin_wa_number', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(String(admin_wa_number).trim());
    }

    if (public_portal_url !== undefined) {
      db.prepare("INSERT INTO settings (key, value) VALUES ('public_portal_url', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(String(public_portal_url).trim());
    }

    if (mock_payment_enabled !== undefined) {
      db.prepare("INSERT INTO settings (key, value) VALUES ('mock_payment_enabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(mock_payment_enabled ? 'true' : 'false');
    }

    if (qris_image_data && typeof qris_image_data === 'string' && qris_image_data.startsWith('data:image/')) {
      const matches = qris_image_data.match(/^data:image\/([a-zA-Z0-9]+);base64,(.+)$/);
      if (matches) {
        const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
        const buffer = Buffer.from(matches[2], 'base64');
        const filename = `qris_custom_${Date.now()}.${ext}`;
        const filePath = path.join(__dirname, 'public', 'uploads', 'qris', filename);
        fs.writeFileSync(filePath, buffer);

        const publicUrl = `/uploads/qris/${filename}`;
        db.prepare("INSERT INTO settings (key, value) VALUES ('qris_image', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .run(publicUrl);
      }
    }

    logActivity('CONFIG_CHANGE', 'Pengaturan QRIS Toko, Domain Portal & WA Admin diperbarui', 'ADMIN');
    res.json({ success: true, message: 'Pengaturan QRIS Toko & Domain Portal berhasil disimpan!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === PENGATURAN INTEGRASI TELEGRAM BOT & CLOUD BACKUP ===
app.get('/api/admin/settings/telegram', requireAdminAuth, (req, res) => {
  const cfg = getTelegramConfig();
  res.json({
    success: true,
    settings: {
      bot_token: cfg.botToken,
      chat_id: cfg.chatId,
      enabled: cfg.enabled
    },
    bot_token: cfg.botToken,
    chat_id: cfg.chatId,
    botToken: cfg.botToken,
    chatId: cfg.chatId,
    enabled: cfg.enabled
  });
});

app.post('/api/admin/settings/telegram', requireAdminAuth, (req, res) => {
  try {
    const { bot_token, chat_id, enabled } = req.body;
    if (bot_token !== undefined) {
      db.prepare("INSERT INTO settings (key, value) VALUES ('telegram_bot_token', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(String(bot_token).trim());
    }
    if (chat_id !== undefined) {
      db.prepare("INSERT INTO settings (key, value) VALUES ('telegram_chat_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(String(chat_id).trim());
    }
    if (enabled !== undefined) {
      db.prepare("INSERT INTO settings (key, value) VALUES ('telegram_backup_enabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(enabled ? 'true' : 'false');
    }

    logActivity('CONFIG_CHANGE', `Update pengaturan integrasi Telegram Bot (Enabled: ${!!enabled})`, 'TELEGRAM');
    res.json({ success: true, message: 'Pengaturan Telegram Bot berhasil disimpan!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/telegram/test', requireAdminAuth, async (req, res) => {
  try {
    const { bot_token, chat_id } = req.body;
    const testResult = await testTelegramConnection(bot_token, chat_id);
    res.json(testResult);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/backup/telegram', requireAdminAuth, async (req, res) => {
  try {
    const result = await backupDatabaseToTelegram();
    if (result.success) {
      logActivity('CONFIG_CHANGE', 'Backup manual database terkirim ke Telegram', 'BACKUP');
      res.json({ success: true, message: 'Database LenxyNet berhasil di-backup dan dikirim ke Telegram Anda!' });
    } else {
      res.status(400).json({ success: false, error: result.error || result.message || 'Gagal mengirim backup ke Telegram' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/backup/mikrotik', requireAdminAuth, async (req, res) => {
  try {
    const result = await backupMikrotikToTelegram();
    if (result.success) {
      logActivity('CONFIG_CHANGE', `Backup full MikroTik (${result.routerIdentity || 'Router'}) terkirim ke Telegram`, 'BACKUP');
      res.json({
        success: true,
        message: result.message || 'Backup MikroTik (.backup & .rsc) berhasil dikirim ke Telegram!',
        data: result
      });
    } else {
      res.status(400).json({ success: false, error: result.error || result.message || 'Gagal mengirim backup MikroTik ke Telegram' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Pelanggan Mengunggah Bukti Pembayaran QRIS
app.post('/api/user/upload-proof', requireUserOrAdminAuth, async (req, res) => {
  try {
    const { bill_id, proof_image, durationMonths } = req.body;
    if (!bill_id) return res.status(400).json({ error: 'ID Tagihan diperlukan!' });
    if (!proof_image || !proof_image.startsWith('data:image/')) {
      return res.status(400).json({ error: 'File gambar bukti transfer wajib di-upload!' });
    }

    // Cek kepemilikan tagihan
    let bill = null;
    if (req.userSession) {
      bill = db.prepare('SELECT b.*, c.name, c.pppoe_username, c.phone FROM bills b JOIN customers c ON b.customer_id = c.id WHERE b.id = ? AND b.customer_id = ?')
        .get(bill_id, req.userSession.customer_id);
    } else if (req.adminSession) {
      bill = db.prepare('SELECT b.*, c.name, c.pppoe_username, c.phone FROM bills b JOIN customers c ON b.customer_id = c.id WHERE b.id = ?')
        .get(bill_id);
    }

    if (!bill) {
      return res.status(403).json({ error: 'Tagihan tidak ditemukan atau Anda tidak memiliki akses.' });
    }

    // Decode & Simpan gambar ke public/uploads/proofs/
    const matches = proof_image.match(/^data:image\/([a-zA-Z0-9]+);base64,(.+)$/);
    if (!matches) {
      return res.status(400).json({ error: 'Format gambar tidak valid!' });
    }
    const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
    const buffer = Buffer.from(matches[2], 'base64');

    if (buffer.length > 10 * 1024 * 1024) {
      return res.status(400).json({ error: 'Ukuran foto maksimal 10MB!' });
    }

    const proofsDir = path.join(__dirname, 'public', 'uploads', 'proofs');
    if (!fs.existsSync(proofsDir)) fs.mkdirSync(proofsDir, { recursive: true });

    // Hapus bukti lama untuk bill ini jika ada agar disk tidak boros
    if (bill.proof_image && bill.proof_image.startsWith('/uploads/proofs/')) {
      const oldFilePath = path.join(__dirname, 'public', bill.proof_image);
      try {
        if (fs.existsSync(oldFilePath)) fs.unlinkSync(oldFilePath);
      } catch (errDel) {}
    }

    // Sanitasi penamaan file yang rapi & ramah Windows Explorer
    const cleanPart = (str) => {
      return String(str || '')
        .trim()
        .replace(/[\\/:*?"<>|#%&+]/g, '')
        .replace(/\s+/g, '_')
        .replace(/[^a-zA-Z0-9_\-]/g, '')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');
    };

    const cleanPeriod = cleanPart(bill.period) || 'Tagihan';
    const cleanName = cleanPart(bill.name) || cleanPart(bill.pppoe_username) || 'Pelanggan';
    const rawPhone = (bill.phone && bill.phone !== '-' && String(bill.phone).trim().length > 0) ? bill.phone : bill.pppoe_username;
    const cleanPhone = cleanPart(rawPhone) || `ID${bill.customer_id}`;

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const timeStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    const filename = `Bukti_${cleanPeriod}_${cleanName}_${cleanPhone}_${timeStr}.${ext}`;
    const filePath = path.join(proofsDir, filename);

    try {
      fs.writeFileSync(filePath, buffer);
    } catch (fsErr) {
      if (fsErr.code === 'ENOSPC') {
        console.error('CRITICAL: Server storage is full (ENOSPC)!');
        return res.status(507).json({ error: 'Kapasitas penyimpanan server penuh. Harap hubungi administrator.' });
      }
      throw fsErr;
    }
    const publicUrl = `/uploads/proofs/${filename}`;

    const duration = parseInt(durationMonths, 10) || 1;
    const finalAmount = bill.amount * duration;

    // Update status bill menjadi pending_verification
    db.prepare(`
      UPDATE bills 
      SET status = 'pending_verification',
          amount = ?,
          proof_image = ?,
          proof_uploaded_at = datetime('now', 'localtime'),
          rejection_reason = NULL
      WHERE id = ?
    `).run(finalAmount, publicUrl, bill.id);

    logActivity('PAYMENT', `Upload bukti transfer tagihan Rp ${finalAmount.toLocaleString('id-ID')} (${duration} bln)`, bill.pppoe_username);

    // Kirim notifikasi WhatsApp ke Diri Sendiri (Bot WA) & Admin Terdaftar
    try {
      const nowStr = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
      const adminMsg = `🔔 *BUKTI PEMBAYARAN BARU DITERIMA*\n\n` +
        `Ada pelanggan telah mengunggah bukti transfer QRIS Toko:\n` +
        `• *Pelanggan:* ${bill.name} (${bill.pppoe_username})\n` +
        `• *No. WhatsApp:* ${bill.phone || '-'}\n` +
        `• *Periode:* ${bill.period}\n` +
        `• *Total Tagihan:* Rp ${finalAmount.toLocaleString('id-ID')} (${duration} bulan)\n` +
        `• *Waktu Upload:* ${nowStr}\n\n` +
        `Silakan buka *Dashboard Admin LenxyNet* > Tab *Verifikasi QRIS* untuk memeriksa bukti transfer dan menyetujui aktivasi internet.`;

      await sendNotificationToAdmin(adminMsg);
      console.log(`[WhatsApp] Notifikasi bukti bayar baru terkirim ke Admin / WhatsApp Bot!`);
    } catch (errWa) {
      console.warn('[WhatsApp] Gagal kirim notif ke admin/bot:', errWa.message);
    }

    res.json({
      success: true,
      message: 'Bukti pembayaran berhasil di-upload! Admin sedang memverifikasi transaksi Anda.',
      proof_image: publicUrl,
      status: 'pending_verification'
    });
  } catch (err) {
    console.error('Error uploading proof:', err);
    res.status(500).json({ error: err.message });
  }
});

// 4. Daftar Pembayaran Menunggu Verifikasi (Khusus Admin)
app.get('/api/admin/pending-payments', requireAdminAuth, (req, res) => {
  if (!isMikrotikConnected()) return res.json([]);
  try {
    const list = db.prepare(`
      SELECT b.id, b.customer_id, b.period, b.amount, b.status, b.proof_image, b.proof_uploaded_at, b.rejection_reason,
             c.name as customer_name, c.pppoe_username, c.phone as customer_phone, c.status as customer_status,
             p.name as plan_name, p.speed as plan_speed
      FROM bills b
      JOIN customers c ON b.customer_id = c.id
      LEFT JOIN plans p ON c.plan_id = p.id
      WHERE b.status = 'pending_verification'
      ORDER BY b.proof_uploaded_at DESC, b.id DESC
    `).all();

    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Admin Menyetujui Pembayaran (Lunas & Unisolir MikroTik Otomatis)
app.post('/api/admin/payments/:id/approve', requireAdminAuth, requireMikrotikConnected, async (req, res) => {
  try {
    const { id } = req.params;
    const bill = db.prepare(`
      SELECT b.*, c.name as customer_name, c.pppoe_username, c.phone as customer_phone
      FROM bills b
      JOIN customers c ON b.customer_id = c.id
      WHERE b.id = ?
    `).get(id);

    if (!bill) {
      return res.status(404).json({ error: 'Tagihan tidak ditemukan' });
    }

    // Update status bill to 'paid'
    db.prepare(`
      UPDATE bills
      SET status = 'paid',
          paid_at = datetime('now', 'localtime'),
          payment_method = 'QRIS Toko'
      WHERE id = ?
    `).run(id);

    // Update customer status to active
    db.prepare("UPDATE customers SET status = 'active' WHERE id = ?").run(bill.customer_id);

    // Unisolir MikroTik
    try {
      await setMikrotikSecretStatus(bill.pppoe_username, true);
    } catch (e) {
      console.error('Failed to enable secret on MikroTik upon approval:', e.message);
    }

    logActivity('PAYMENT', `Admin menyetujui pembayaran QRIS Toko Rp ${bill.amount.toLocaleString('id-ID')} (${bill.period})`, bill.pppoe_username);

    // Auto-Backup Bukti Transfer ke Telegram & Hapus dari Local Storage STB
    if (bill.proof_image && bill.proof_image.startsWith('/uploads/proofs/')) {
      const localFilePath = path.join(__dirname, 'public', bill.proof_image.replace(/^\/+/, ''));
      if (fs.existsSync(localFilePath)) {
        try {
          const caption = `🟢 <b>[PEMBAYARAN QRIS DISETUJUI / LUNAS]</b>\n\n` +
            `• <b>Pelanggan:</b> ${bill.customer_name} (<code>${bill.pppoe_username}</code>)\n` +
            `• <b>Nominal:</b> Rp ${Number(bill.amount).toLocaleString('id-ID')}\n` +
            `• <b>Periode:</b> ${bill.period}\n` +
            `• <b>Metode:</b> QRIS Toko (Terverifikasi)\n` +
            `• <b>Waktu:</b> ${new Date().toLocaleString('id-ID')}`;
          await sendTelegramPhoto(localFilePath, caption);
        } catch (errTg) {
          console.warn('[Telegram] Gagal backup foto bukti approved:', errTg.message);
        }
        try {
          fs.unlinkSync(localFilePath);
          console.log(`[Storage] Berhasil menghapus file bukti transfer lokal: ${localFilePath}`);
        } catch (e) {
          console.warn('[Storage] Gagal menghapus file bukti lokal:', e.message);
        }
      }
    }

    // Kirim notifikasi WhatsApp ke pelanggan
    if (bill.customer_phone && bill.customer_phone !== '-') {
      try {
        await sendPaymentSuccessNotice(
          { name: bill.customer_name, pppoe_username: bill.pppoe_username, phone: bill.customer_phone },
          { period: bill.period, amount: bill.amount, durationMonths: 1, payment_method: 'QRIS Toko (Terverifikasi)' }
        );
      } catch (errWa) {
        console.warn('[WhatsApp] Gagal kirim struk lunas ke pelanggan:', errWa.message);
      }
    }

    res.json({ success: true, message: `Pembayaran ${bill.customer_name} berhasil disetujui & layanan MikroTik aktif!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Admin Menolak Bukti Pembayaran
app.post('/api/admin/payments/:id/reject', requireAdminAuth, requireMikrotikConnected, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const rejectReason = reason && reason.trim() ? reason.trim() : 'Bukti transfer tidak valid atau dana belum masuk.';

    const bill = db.prepare(`
      SELECT b.*, c.name as customer_name, c.pppoe_username, c.phone as customer_phone
      FROM bills b
      JOIN customers c ON b.customer_id = c.id
      WHERE b.id = ?
    `).get(id);

    if (!bill) {
      return res.status(404).json({ error: 'Tagihan tidak ditemukan' });
    }

    // Kembalikan status bill ke unpaid
    db.prepare(`
      UPDATE bills
      SET status = 'unpaid',
          rejection_reason = ?
      WHERE id = ?
    `).run(rejectReason, id);

    logActivity('PAYMENT', `Admin menolak bukti bayar ${bill.customer_name} (${rejectReason})`, bill.pppoe_username, 'failed');

    // Auto-Backup Bukti Transfer ke Telegram & Hapus dari Local Storage STB
    if (bill.proof_image && bill.proof_image.startsWith('/uploads/proofs/')) {
      const localFilePath = path.join(__dirname, 'public', bill.proof_image.replace(/^\/+/, ''));
      if (fs.existsSync(localFilePath)) {
        try {
          const caption = `🔴 <b>[PEMBAYARAN QRIS DITOLAK]</b>\n\n` +
            `• <b>Pelanggan:</b> ${bill.customer_name} (<code>${bill.pppoe_username}</code>)\n` +
            `• <b>Nominal:</b> Rp ${Number(bill.amount).toLocaleString('id-ID')}\n` +
            `• <b>Alasan Ditolak:</b> ${rejectReason}\n` +
            `• <b>Periode:</b> ${bill.period}\n` +
            `• <b>Waktu:</b> ${new Date().toLocaleString('id-ID')}`;
          await sendTelegramPhoto(localFilePath, caption);
        } catch (errTg) {
          console.warn('[Telegram] Gagal backup foto bukti rejected:', errTg.message);
        }
        try {
          fs.unlinkSync(localFilePath);
          console.log(`[Storage] Berhasil menghapus file bukti transfer lokal ditolak: ${localFilePath}`);
        } catch (e) {
          console.warn('[Storage] Gagal menghapus file bukti lokal:', e.message);
        }
      }
    }

    // Kirim WhatsApp pemberitahuan penolakan ke pelanggan
    if (bill.customer_phone && bill.customer_phone !== '-') {
      try {
        const baseUrl = getPortalBaseUrl(req);
        const phoneParam = (bill.customer_phone && bill.customer_phone !== '-') ? bill.customer_phone : bill.pppoe_username;
        const portalUrl = `${baseUrl}/user.html?phone=${encodeURIComponent(phoneParam)}`;
        const rejectMsg = `Halo Bapak/Ibu *${bill.customer_name}*,\n\n` +
          `Pemberitahuan dari *LenxyNet Fiber*.\n` +
          `Mohon maaf, bukti pembayaran yang Anda unggah untuk periode *${bill.period}* sebesar *Rp ${bill.amount.toLocaleString('id-ID')}* belum dapat disetujui.\n\n` +
          `❌ *Alasan Penolakan:* ${rejectReason}\n\n` +
          `Silakan periksa mutasi rekening / riwayat transfer Anda dan unggah bukti transfer yang benar melalui tautan portal berikut:\n` +
          `👉 ${portalUrl}\n\n` +
          `💡 _Tips: Jika tautan di atas belum bisa diklik, simpan nomor ini ke kontak atau balas pesan ini (ketik OK)._\n\n` +
          `Hubungi Customer Service jika Anda membutuhkan bantuan lebih lanjut.\n` +
          `_Customer Service LenxyNet_`;

        await sendWhatsAppMessage(bill.customer_phone, rejectMsg);
      } catch (errWa) {
        console.warn('[WhatsApp] Gagal kirim notif penolakan ke pelanggan:', errWa.message);
      }
    }

    res.json({ success: true, message: `Bukti transfer ditolak dan pelanggan telah diberitahu via WhatsApp.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cek status router tersimpan saat server start
const initialConnected = db.prepare("SELECT value FROM settings WHERE key = 'router_connected'").get()?.value;
if (initialConnected === 'true') {
  syncFromMikrotik().then(async (res) => {
    console.log(`[Auto-Sync] Berhasil membaca ${res.count} secret dari MikroTik!`);
    await runAutoIsolirCheck();
  }).catch(err => {
    console.warn(`[Auto-Sync] Gagal membaca MikroTik saat start:`, err.message);
  });
} else {
  console.log(`[MikroTik] Status awal: Disconnected. Menunggu konfigurasi & koneksi dari Dashboard Admin.`);
}

// Background Auto-Sync 2-Arah (MikroTik -> SQLite) setiap 10 detik (Real-Time Sync)
// Menjamin MikroTik tetap menjadi Single Source of Truth jika ada perubahan langsung via Winbox
let isSyncing = false;
setInterval(async () => {
  if (isSyncing) return;
  try {
    const isConn = db.prepare("SELECT value FROM settings WHERE key = 'router_connected'").get()?.value;
    if (isConn === 'true') {
      isSyncing = true;
      await syncFromMikrotik();
    }
  } catch (e) {
    // Diamkan bila router offline sementara
  } finally {
    isSyncing = false;
  }
}, 10 * 1000);

// Jalankan Scheduler Cron Job
startCronJobs();

// Inisialisasi WhatsApp Gateway Bot
initWhatsApp();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`🚀 LenxyNet Billing & ISP Management Running!`);
  console.log(`🌐 Localhost (PC Ini)   : http://localhost:${PORT}`);
  console.log(`📱 User Portal Localhost: http://localhost:${PORT}/user.html`);
  console.log(`-------------------------------------------------------`);
  console.log(`📡 Akses Jaringan Sama (HP / Laptop Pelanggan di WiFi/LAN):`);
  console.log(`👉 Dashboard Admin : http://192.168.55.254:${PORT}`);
  console.log(`👉 Portal Pelanggan: http://192.168.55.254:${PORT}/user.html`);
  console.log(`=======================================================`);
});

// Dengarkan juga pada Port 80 standar jika tersedia (sehingga tidak perlu ketik :3000)
try {
  app.listen(80, '0.0.0.0', () => {
    console.log(`⚡ Port 80 Aktif: Akses langsung tanpa port di http://192.168.55.254/user.html`);
  }).on('error', () => {
    // Port 80 dilewati jika ada service Windows lain yang menggunakannya
  });
} catch (e) {}

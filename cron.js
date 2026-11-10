const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { setMikrotikSecretStatus, getEffectiveDueDate, isBillOverdueForPeriod } = require('./mikrotik');
const { sendReminderHMinus3, sendReminderHPlus1 } = require('./wa');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatLocalDate(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getLocalBaseUrl(baseUrl) {
  if (baseUrl && !baseUrl.includes('localhost')) {
    return baseUrl.replace(/\/+$/, '');
  }
  const savedPublicUrl = db.prepare("SELECT value FROM settings WHERE key = 'public_portal_url'").get()?.value;
  if (savedPublicUrl && savedPublicUrl.trim() !== '') {
    let clean = savedPublicUrl.trim().replace(/\/+$/, '');
    if (!clean.startsWith('http://') && !clean.startsWith('https://')) {
      clean = 'https://' + clean;
    }
    return clean;
  }
  const savedUrl = db.prepare("SELECT value FROM settings WHERE key = 'app_base_url'").get()?.value;
  if (savedUrl && savedUrl.trim() !== '') return savedUrl.trim().replace(/\/+$/, '');

  // Auto-detect LAN IP fallback daripada hardcode IP PC lama
  try {
    const os = require('os');
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          return `http://${net.address}`;
        }
      }
    }
  } catch (e) {}
  return 'http://192.168.55.254';
}

// Fungsi Inti Pemeriksaan & Auto-Isolir Pelanggan + WhatsApp Reminder (Anti-Spam & Lintas Bulan Akurat)
async function runAutoIsolirCheck(baseUrl, options = {}) {
  const sendWa = options.sendWa === true;
  const isConn = db.prepare("SELECT value FROM settings WHERE key = 'router_connected'").get()?.value === 'true';
  if (!isConn) {
    console.log('[Auto-Isolir] Router MikroTik sedang offline / terputus. Pengecekan dilewati.');
    return { success: true, isolatedCount: 0, waHMinus3Count: 0, waHPlus1Count: 0 };
  }

  const resolvedBaseUrl = getLocalBaseUrl(baseUrl);
  const now = new Date();
  const currentDay = now.getDate();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();
  const currentPeriod = `${currentYear}-${String(currentMonth).padStart(2, '0')}`;
  const todayStr = formatLocalDate(now);
  const todayTime = new Date(currentYear, currentMonth - 1, currentDay);

  // Target tanggal untuk H-3 (3 hari dari sekarang) & H+1 (kemarin jatuh tempo) - akurat lintas bulan & tahun!
  const in3Days = new Date(todayTime);
  in3Days.setDate(in3Days.getDate() + 3);
  const hMinus3Year = in3Days.getFullYear();
  const hMinus3Month = in3Days.getMonth() + 1;
  const hMinus3Day = in3Days.getDate();
  const hMinus3Period = `${hMinus3Year}-${String(hMinus3Month).padStart(2, '0')}`;

  const yesterday = new Date(todayTime);
  yesterday.setDate(yesterday.getDate() - 1);
  const hPlus1Year = yesterday.getFullYear();
  const hPlus1Month = yesterday.getMonth() + 1;
  const hPlus1Day = yesterday.getDate();
  const hPlus1Period = `${hPlus1Year}-${String(hPlus1Month).padStart(2, '0')}`;

  const toleranceDays = parseInt(db.prepare("SELECT value FROM settings WHERE key = 'tolerance_days'").get()?.value || '3', 10);
  console.log(`[Auto-Isolir & WA] Pengecekan per ${todayStr} WIB (Toleransi: ${toleranceDays} hari, Kirim WA: ${sendWa ? 'YA' : 'TIDAK'})...`);

  const query = `
    SELECT c.*, p.name as plan_name, p.price as plan_price
    FROM customers c
    LEFT JOIN plans p ON c.plan_id = p.id
  `;
  const customers = db.prepare(query).all();

  let isolatedCount = 0;
  let waHMinus3Count = 0;
  let waHPlus1Count = 0;

  for (const c of customers) {
    const unitPrice = c.plan_price || 100000;

    // Pastikan pelanggan punya tagihan untuk bulan berjalan
    let currentBill = db.prepare('SELECT * FROM bills WHERE customer_id = ? AND period = ?').get(c.id, currentPeriod);
    if (!currentBill) {
      const ins = db.prepare('INSERT INTO bills (customer_id, period, amount, status) VALUES (?, ?, ?, ?)').run(c.id, currentPeriod, unitPrice, 'unpaid');
      currentBill = { id: ins.lastInsertRowid, period: currentPeriod, amount: unitPrice, status: 'unpaid', last_hminus3_sent: null, last_hplus1_sent: null };
    }

    const configuredDueDate = c.due_date;
    if (!configuredDueDate) {
      // Pelanggan yang belum diatur tanggal jatuh temponya dilewati dari auto-isolir dan reminder
      continue;
    }

    const phoneParam = (c.phone && c.phone !== '-') ? c.phone : c.pppoe_username;
    const portalUrl = `${resolvedBaseUrl}/user.html?phone=${encodeURIComponent(phoneParam)}`;

    // 1. CEK PENGIRIMAN WHATSAPP REMINDER (Hanya pada jadwal 08:30 pagi atau pemicu eksplisit, + cegah duplikat di hari yang sama)
    if (sendWa && c.phone && c.phone !== '-') {
      // A. Cek Reminder H-3 (Mendukung tanggal jatuh tempo tgl 1, 2, 3 lintas bulan!)
      const effHMinus3Day = getEffectiveDueDate(hMinus3Year, hMinus3Month, configuredDueDate);
      if (effHMinus3Day === hMinus3Day) {
        let targetBill = db.prepare('SELECT * FROM bills WHERE customer_id = ? AND period = ?').get(c.id, hMinus3Period);
        if (!targetBill) {
          // Siapkan tagihan periode mendatang lebih awal agar pelanggan bisa langsung bayar H-3
          const insNext = db.prepare('INSERT INTO bills (customer_id, period, amount, status) VALUES (?, ?, ?, ?)').run(c.id, hMinus3Period, unitPrice, 'unpaid');
          targetBill = { id: insNext.lastInsertRowid, period: hMinus3Period, amount: unitPrice, status: 'unpaid', last_hminus3_sent: null };
        }
        if (targetBill.status === 'unpaid' && targetBill.last_hminus3_sent !== todayStr) {
          console.log(`[WA] Mengirim Reminder H-3 ke ${c.name} (${c.phone}) untuk periode ${hMinus3Period}...`);
          const resWa = await sendReminderHMinus3(c, { amount: targetBill.amount, period: hMinus3Period }, portalUrl);
          if (resWa && resWa.success) {
            db.prepare('UPDATE bills SET last_hminus3_sent = ? WHERE id = ?').run(todayStr, targetBill.id);
            waHMinus3Count++;
            await sleep(1800); // Jeda anti-banned WhatsApp
          }
        }
      }

      // B. Cek Peringatan Keterlambatan H+1 (Mendukung jatuh tempo tgl 28-31 lintas bulan!)
      const effHPlus1Day = getEffectiveDueDate(hPlus1Year, hPlus1Month, configuredDueDate);
      if (effHPlus1Day === hPlus1Day) {
        const overdueBill = db.prepare('SELECT * FROM bills WHERE customer_id = ? AND period = ?').get(c.id, hPlus1Period);
        if (overdueBill && overdueBill.status === 'unpaid' && overdueBill.last_hplus1_sent !== todayStr) {
          console.log(`[WA] Mengirim Peringatan H+1 ke ${c.name} (${c.phone}) untuk periode ${hPlus1Period}...`);
          const resWa = await sendReminderHPlus1(c, { amount: overdueBill.amount, period: hPlus1Period }, toleranceDays, portalUrl);
          if (resWa && resWa.success) {
            db.prepare('UPDATE bills SET last_hplus1_sent = ? WHERE id = ?').run(todayStr, overdueBill.id);
            waHPlus1Count++;
            await sleep(1800); // Jeda anti-banned WhatsApp
          }
        }
      }
    }

    // 2. CEK ISOLIR JATUH TEMPO (Cek seluruh tagihan unpaid dengan deadline persis per periodenya + toleransi)
    const unpaidBills = db.prepare("SELECT id, period FROM bills WHERE customer_id = ? AND status = 'unpaid'").all(c.id);
    const hasOverdueUnpaid = unpaidBills.some(ub => isBillOverdueForPeriod(ub.period, configuredDueDate, toleranceDays, todayTime));
    const hasPending = Boolean(db.prepare("SELECT id FROM bills WHERE customer_id = ? AND status = 'pending_verification' LIMIT 1").get(c.id));

    if (hasOverdueUnpaid && !hasPending) {
      if (c.status !== 'isolated') {
        try {
          await setMikrotikSecretStatus(c.pppoe_username, false);
          db.prepare("UPDATE customers SET status = 'isolated' WHERE id = ?").run(c.id);
          isolatedCount++;
          try {
            db.prepare("INSERT INTO activity_logs (action, details, target, status) VALUES ('ISOLIR', ?, ?, 'success')")
              .run(`Pelanggan diisolir otomatis karena melewati jatuh tempo + toleransi (${toleranceDays} hari)`, c.pppoe_username);
          } catch (e) {}
          console.log(`[Auto-Isolir] Berhasil mengisolir ${c.name} (${c.pppoe_username}).`);
        } catch (err) {
          console.error(`[Auto-Isolir] Gagal isolir ${c.pppoe_username}:`, err.message);
        }
      }
    }
  }

  console.log(`[Auto-Isolir] Selesai. Isolir baru: ${isolatedCount}, WA H-3: ${waHMinus3Count}, WA H+1: ${waHPlus1Count}`);
  return { success: true, isolatedCount, waHMinus3Count, waHPlus1Count };
}

// Helper: Cek apakah otomasi cron job diaktifkan di settings database
function isCronEnabled() {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'cron_enabled'").get();
    return row ? row.value !== 'false' : true;
  } catch (e) {
    return true;
  }
}

// Jadwal Otomatis (Selalu terkunci di zona waktu WIB Asia/Jakarta walaupun OS Linux STB baru di-install!)
function startCronJobs() {
  const tzOpts = { timezone: 'Asia/Jakarta' };

  // Jam 00:01 WIB - Cek Isolir Tengah Malam (HANYA Isolir, TANPA kirim WA malam hari!)
  cron.schedule('1 0 * * *', async () => {
    if (!isCronEnabled()) {
      console.log('[Cron Job] Dilewati: Otomasi Cron Job (Auto-Isolir) sedang NONAKTIF (OFF).');
      return;
    }
    console.log('[Cron Job] Menjalankan Auto-Isolir tengah malam (00:01 WIB)...');
    await runAutoIsolirCheck(null, { sendWa: false });
  }, tzOpts);

  // Jam 08:30 Pagi WIB - Cek Pengiriman WA Reminder H-3 & H+1 Pagi Hari
  cron.schedule('30 8 * * *', async () => {
    if (!isCronEnabled()) {
      console.log('[Cron Job] Dilewati: Otomasi Cron Job (WA Reminder) sedang NONAKTIF (OFF).');
      return;
    }
    console.log('[Cron Job] Menjalankan pengiriman WA Reminder pagi (08:30 WIB)...');
    await runAutoIsolirCheck(null, { sendWa: true });
  }, tzOpts);

  // Jam 03:00 Dini Hari WIB - Maintenance Disk STB, Prune Log/Sesi Kedaluwarsa & Auto-Backup DB ke Telegram
  cron.schedule('0 3 * * *', () => {
    cleanOldProofFiles(60);
    runDatabaseMaintenance();

    // Auto-Backup database ke Telegram jika diaktifkan
    try {
      const { backupDatabaseToTelegram } = require('./telegram');
      backupDatabaseToTelegram().then(res => {
        if (res && res.success) console.log('[Auto-Backup Telegram] Database berhasil dikirim ke Telegram!');
      }).catch(e => console.warn('[Auto-Backup Telegram] Gagal backup database:', e.message));
    } catch (e) {}
  }, tzOpts);

  // Jam 03:05 Dini Hari WIB - Auto-Backup MikroTik (.backup & .rsc) ke Telegram
  cron.schedule('5 3 * * *', () => {
    try {
      const { backupMikrotikToTelegram } = require('./telegram');
      backupMikrotikToTelegram().then(res => {
        if (res && res.success) console.log('[Auto-Backup Telegram] Konfigurasi & Full System MikroTik berhasil dikirim ke Telegram!');
      }).catch(e => console.warn('[Auto-Backup Telegram] Gagal backup MikroTik:', e.message));
    } catch (e) {}
  }, tzOpts);

  console.log('⏰ Scheduler Cron Job aktif (Asia/Jakarta): Isolir 00:01 WIB, Maintenance & Backup DB 03:00 WIB, Backup MikroTik 03:05 WIB, WA Reminder 08:30 WIB.');
}

// Perawatan Jangka Panjang Database (Penting agar server STB tetap kencang & hemat eMMC bertahun-tahun)
function runDatabaseMaintenance() {
  try {
    const delAdmin = db.prepare("DELETE FROM admin_sessions WHERE expires_at <= datetime('now', 'localtime')").run();
    const delUser = db.prepare("DELETE FROM user_sessions WHERE expires_at <= datetime('now', 'localtime')").run();
    const delOtp = db.prepare("DELETE FROM otp_codes WHERE (julianday('now', 'localtime') - julianday(last_requested_at)) > 1").run();
    const delLogs = db.prepare("DELETE FROM activity_logs WHERE (julianday('now', 'localtime') - julianday(created_at)) > 90").run();

    // Checkpoint WAL agar ukuran file database.sqlite-wal tidak membengkak di eMMC
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');

    console.log(`[DB Maintenance] Sesi kadaluwarsa dihapus (Admin: ${delAdmin.changes}, User: ${delUser.changes}, OTP: ${delOtp.changes}), Log >90 hari dihapus: ${delLogs.changes}`);
  } catch (err) {
    console.warn('[DB Maintenance] Gagal membersihkan tabel periodik:', err.message);
  }
}

// Pembersihan Otomatis File Bukti Transfer Usang (> 60 hari) & File Orphan (Aman terhadap .gitkeep)
function cleanOldProofFiles(retentionDays = 60) {
  try {
    const proofsDir = path.join(__dirname, 'public', 'uploads', 'proofs');
    if (!fs.existsSync(proofsDir)) return;

    const oldBills = db.prepare(`
      SELECT id, proof_image FROM bills 
      WHERE status = 'paid' 
        AND proof_image IS NOT NULL 
        AND proof_image != 'ARCHIVED'
        AND paid_at IS NOT NULL
        AND (julianday('now', 'localtime') - julianday(paid_at)) > ?
    `).all(retentionDays);

    let deletedCount = 0;
    for (const b of oldBills) {
      if (b.proof_image && b.proof_image.startsWith('/uploads/proofs/')) {
        const safeName = path.basename(b.proof_image);
        const filePath = path.join(proofsDir, safeName);
        try {
          if (fs.existsSync(filePath) && path.resolve(filePath).startsWith(path.resolve(proofsDir))) {
            fs.unlinkSync(filePath);
            deletedCount++;
          }
        } catch (e) {}
        db.prepare("UPDATE bills SET proof_image = 'ARCHIVED' WHERE id = ?").run(b.id);
      }
    }

    // Bersihkan file orphan di folder proofs (tetap pertahankan .gitkeep)
    try {
      const activeProofRecords = db.prepare("SELECT proof_image FROM bills WHERE proof_image IS NOT NULL AND proof_image != 'ARCHIVED'").all();
      const validProofFilenames = new Set(
        activeProofRecords
          .map(r => r.proof_image)
          .filter(p => p && p.startsWith('/uploads/proofs/'))
          .map(p => path.basename(p))
      );

      const diskFiles = fs.readdirSync(proofsDir);
      let orphanCount = 0;
      for (const file of diskFiles) {
        if (file === '.gitkeep') continue;
        if (!validProofFilenames.has(file)) {
          const orphanPath = path.join(proofsDir, file);
          try {
            fs.unlinkSync(orphanPath);
            orphanCount++;
          } catch (e) {}
        }
      }
      if (orphanCount > 0) {
        console.log(`[Disk Maintenance] Berhasil membersihkan ${orphanCount} file bukti transfer tak bertuan (orphan) dari disk.`);
      }
    } catch (orphanErr) {
      console.warn('[Disk Maintenance] Gagal cek file bukti orphan:', orphanErr.message);
    }

    if (deletedCount > 0) {
      console.log(`[Disk Maintenance] Berhasil membersihkan ${deletedCount} file bukti transfer lama (> ${retentionDays} hari).`);
    }
  } catch (err) {
    console.warn('[Disk Maintenance] Gagal membersihkan file bukti:', err.message);
  }
}

module.exports = {
  runAutoIsolirCheck,
  startCronJobs,
  cleanOldProofFiles,
  runDatabaseMaintenance
};

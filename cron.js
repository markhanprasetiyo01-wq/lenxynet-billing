const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { setMikrotikSecretStatus } = require('./mikrotik');
const { sendReminderHMinus3, sendReminderHPlus1 } = require('./wa');

// Helper: Menentukan tanggal jatuh tempo efektif (mencegah bug tanggal 31 pada bulan pendek seperti Feb/Apr)
function getEffectiveDueDate(year, month, configuredDueDate) {
  const daysInMonth = new Date(year, month, 0).getDate();
  return Math.min(configuredDueDate, daysInMonth);
}

// Fungsi Inti Pemeriksaan & Auto-Isolir Pelanggan + WhatsApp Reminder
async function runAutoIsolirCheck(baseUrl) {
  const isConn = db.prepare("SELECT value FROM settings WHERE key = 'router_connected'").get()?.value === 'true';
  if (!isConn) {
    console.log('[Auto-Isolir] Router MikroTik sedang offline / terputus. Pengecekan dilewati.');
    return { isolatedCount: 0, waHMinus3Count: 0, waHPlus1Count: 0 };
  }

  if (!baseUrl || baseUrl.includes('localhost')) {
    const savedPublicUrl = db.prepare("SELECT value FROM settings WHERE key = 'public_portal_url'").get()?.value;
    const savedUrl = db.prepare("SELECT value FROM settings WHERE key = 'app_base_url'").get()?.value;
    baseUrl = (savedPublicUrl && savedPublicUrl.trim() !== '') 
      ? savedPublicUrl.trim().replace(/\/+$/, '') 
      : (savedUrl || 'http://192.168.55.254');
  }
  const now = new Date();
  const currentDay = now.getDate();
  const currentMonth = now.getMonth() + 1; // 1 - 12
  const currentYear = now.getFullYear();
  const currentPeriod = `${currentYear}-${String(currentMonth).padStart(2, '0')}`;

  // Ambil toleransi hari dari settings
  const toleranceDays = parseInt(db.prepare("SELECT value FROM settings WHERE key = 'tolerance_days'").get()?.value || '3');

  console.log(`[Auto-Isolir & WA] Pengecekan per ${currentYear}-${currentMonth}-${currentDay} (Toleransi: ${toleranceDays} hari)...`);

  // Ambil semua pelanggan aktif beserta tagihan periode ini
  const query = `
    SELECT c.*, p.name as plan_name, b.id as bill_id, b.status as bill_status, b.amount as bill_amount
    FROM customers c
    LEFT JOIN plans p ON c.plan_id = p.id
    LEFT JOIN bills b ON c.id = b.customer_id AND b.period = ?
  `;
  const customers = db.prepare(query).all(currentPeriod);

  let isolatedCount = 0;
  let waHMinus3Count = 0;
  let waHPlus1Count = 0;

  for (const c of customers) {
    if (!c.bill_id) {
      const plan = db.prepare('SELECT price FROM plans WHERE id = ?').get(c.plan_id);
      const amount = plan ? plan.price : 150000;
      db.prepare('INSERT INTO bills (customer_id, period, amount, status) VALUES (?, ?, ?, ?)').run(c.id, currentPeriod, amount, 'unpaid');
      c.bill_status = 'unpaid';
      c.bill_amount = amount;
    }

    const configuredDueDate = c.due_date;
    if (!configuredDueDate) {
      // Pelanggan yang belum diatur tanggal jatuh temponya dilewati dari auto-isolir dan reminder
      continue;
    }

    // Periksa apakah ada tanggal spesifik lengkap di comment pelanggan (misal: 09-10-2026)
    let fullDueYear = null;
    let fullDueMonth = null;
    if (c.comment && String(c.comment).trim() !== '') {
      const fullDateMatch = String(c.comment).trim().match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
      if (fullDateMatch) {
        fullDueMonth = parseInt(fullDateMatch[2], 10);
        fullDueYear = parseInt(fullDateMatch[3], 10);
      }
    }

    const calcYear = fullDueYear || currentYear;
    const calcMonth = fullDueMonth || currentMonth;
    const effectiveDueDate = getEffectiveDueDate(calcYear, calcMonth, configuredDueDate);

    // Tanggal jatuh tempo & deadline toleransi isolir
    const dueDateTime = new Date(calcYear, calcMonth - 1, effectiveDueDate);
    const deadlineTime = new Date(dueDateTime);
    deadlineTime.setDate(deadlineTime.getDate() + toleranceDays);

    const todayTime = new Date(currentYear, currentMonth - 1, currentDay);

    const hMinus3Time = new Date(dueDateTime);
    hMinus3Time.setDate(hMinus3Time.getDate() - 3);

    const hPlus1Time = new Date(dueDateTime);
    hPlus1Time.setDate(hPlus1Time.getDate() + 1);

    const isHMinus3 = todayTime.getTime() === hMinus3Time.getTime();
    const isHPlus1 = todayTime.getTime() === hPlus1Time.getTime();
    const isOverdue = todayTime.getTime() > deadlineTime.getTime();
    const deadlineFormatted = `${deadlineTime.getDate()}/${deadlineTime.getMonth() + 1}/${deadlineTime.getFullYear()}`;
    const phoneParam = (c.phone && c.phone !== '-') ? c.phone : c.pppoe_username;
    const portalUrl = `${baseUrl}/user.html?phone=${encodeURIComponent(phoneParam)}`;

    // 1. CEK NOTIFIKASI WHATSAPP
    if (c.bill_status === 'unpaid' && c.phone && c.phone !== '-') {
      // H-3 Sebelum Jatuh Tempo:
      if (isHMinus3) {
        console.log(`[WA] Mengirim Reminder H-3 ke ${c.name} (${c.phone})...`);
        await sendReminderHMinus3(c, { amount: c.bill_amount, period: currentPeriod }, portalUrl);
        waHMinus3Count++;
      }

      // H+1 Setelah Jatuh Tempo:
      if (isHPlus1) {
        console.log(`[WA] Mengirim Peringatan H+1 ke ${c.name} (${c.phone})...`);
        await sendReminderHPlus1(c, { amount: c.bill_amount, period: currentPeriod }, toleranceDays, portalUrl);
        waHPlus1Count++;
      }
    }

    // 2. CEK ISOLIR JATUH TEMPO (Tegakkan Konsistensi Antara MikroTik & Database)
    if (c.bill_status === 'unpaid' && isOverdue) {
      try {
        // Selalu pastikan secret di MikroTik dalam kondisi disabled & sesi aktif ditendang
        await setMikrotikSecretStatus(c.pppoe_username, false);
        if (c.status !== 'isolated') {
          console.log(`[Auto-Isolir] Mengisolir ${c.name} (${c.pppoe_username}) karena telat bayar melewati batas tgl ${deadlineFormatted}`);
          db.prepare("UPDATE customers SET status = 'isolated' WHERE id = ?").run(c.id);
          isolatedCount++;
          try {
            db.prepare("INSERT INTO activity_logs (action, details, target, status) VALUES ('ISOLIR', ?, ?, 'success')")
              .run(`Pelanggan diisolir otomatis (lewat batas tgl ${deadlineFormatted})`, c.pppoe_username);
          } catch(e) {}
        }
      } catch (err) {
        console.error(`[Auto-Isolir] Gagal isolir ${c.pppoe_username}:`, err.message);
      }
    } else if (c.bill_status === 'paid' && c.status === 'isolated') {
      console.log(`[Auto-Isolir] Memulihkan akses ${c.name} (${c.pppoe_username}) karena sudah lunas.`);
      try {
        await setMikrotikSecretStatus(c.pppoe_username, true);
        db.prepare("UPDATE customers SET status = 'active' WHERE id = ?").run(c.id);
      } catch (err) {
        console.error(`[Auto-Isolir] Gagal buka isolir ${c.pppoe_username}:`, err.message);
      }
    }
  }

  console.log(`[Auto-Isolir] Selesai. Isolir: ${isolatedCount}, WA H-3: ${waHMinus3Count}, WA H+1: ${waHPlus1Count}`);
  return { success: true, isolatedCount, waHMinus3Count, waHPlus1Count };
}

// Jadwal Otomatis: Berjalan setiap hari pada jam 08:00 pagi untuk WA Reminder dan 00:01 untuk Isolir
function startCronJobs() {
  // Jam 00:01 WIB - Cek Isolir
  cron.schedule('1 0 * * *', async () => {
    console.log('[Cron Job] Menjalankan Auto-Isolir tengah malam...');
    await runAutoIsolirCheck();
  });

  // Jam 08:30 Pagi WIB - Cek Pengiriman WA Reminder H-3 & H+1
  cron.schedule('30 8 * * *', async () => {
    console.log('[Cron Job] Menjalankan pengiriman WA Reminder pagi...');
    await runAutoIsolirCheck();
  });

  // Jam 03:00 Dini Hari WIB - Pembersihan Otomatis Bukti Transfer Lunas & Auto-Backup Database ke Telegram
  cron.schedule('0 3 * * *', () => {
    cleanOldProofFiles(60);

    // Auto-Backup database ke Telegram jika diaktifkan
    try {
      const { backupDatabaseToTelegram } = require('./telegram');
      backupDatabaseToTelegram().then(res => {
        if (res && res.success) console.log('[Auto-Backup Telegram] Database berhasil dikirim ke Telegram!');
      }).catch(e => console.warn('[Auto-Backup Telegram] Gagal backup database:', e.message));
    } catch(e) {}
  });

  // Jam 03:05 Dini Hari WIB - Auto-Backup MikroTik (.backup & .rsc) ke Telegram
  cron.schedule('5 3 * * *', () => {
    try {
      const { backupMikrotikToTelegram } = require('./telegram');
      backupMikrotikToTelegram().then(res => {
        if (res && res.success) console.log('[Auto-Backup Telegram] Konfigurasi & Full System MikroTik berhasil dikirim ke Telegram!');
      }).catch(e => console.warn('[Auto-Backup Telegram] Gagal backup MikroTik:', e.message));
    } catch(e) {}
  });

  console.log('⏰ Scheduler Cron Job aktif: Isolir 00:01 WIB, Backup DB 03:00 WIB, Backup MikroTik 03:05 WIB, WA Reminder 08:30 WIB & Clean Bukti.');
}

// Pembersihan Otomatis File Bukti Transfer Usang (> 60 hari) & File Tak Bertuan (Orphan) untuk Menjaga Kapasitas Disk
function cleanOldProofFiles(retentionDays = 60) {
  try {
    const proofsDir = path.join(__dirname, 'public', 'uploads', 'proofs');
    if (!fs.existsSync(proofsDir)) return;

    // 1. Ambil tagihan lunas yang umurnya > retentionDays
    const oldBills = db.prepare(`
      SELECT id, proof_image FROM bills 
      WHERE status = 'paid' 
        AND proof_image IS NOT NULL 
        AND proof_image != 'ARCHIVED'
        AND (julianday('now') - julianday(paid_at)) > ?
    `).all(retentionDays);

    let deletedCount = 0;
    for (const b of oldBills) {
      if (b.proof_image && b.proof_image.startsWith('/uploads/proofs/')) {
        const filePath = path.join(__dirname, 'public', b.proof_image);
        try {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            deletedCount++;
          }
        } catch (e) {}
        db.prepare("UPDATE bills SET proof_image = 'ARCHIVED' WHERE id = ?").run(b.id);
      }
    }

    // 2. Bersihkan file tak bertuan (orphan) di folder proofs yang tidak ada di database
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
        if (!validProofFilenames.has(file)) {
          const orphanPath = path.join(proofsDir, file);
          try {
            fs.unlinkSync(orphanPath);
            orphanCount++;
          } catch(e) {}
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
  cleanOldProofFiles
};


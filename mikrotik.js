const { RouterOSClient } = require('routeros-client');
const fs = require('fs');
const path = require('path');
const db = require('./db');

// Helper Hapus Seluruh Data Pelanggan Lokal (SQLite & File Bukti Pembayaran di Storage Disk)
function deleteCustomerLocalData(customerId, username = '') {
  // 1. Hapus semua file fisik bukti transfer milik pelanggan ini dari server storage
  try {
    const billsWithProof = db.prepare('SELECT proof_image FROM bills WHERE customer_id = ? AND proof_image IS NOT NULL').all(customerId);
    for (const b of billsWithProof) {
      if (b.proof_image && b.proof_image.startsWith('/uploads/proofs/')) {
        const proofsDir = path.join(__dirname, 'public', 'uploads', 'proofs');
        const safeFilename = path.basename(b.proof_image);
        const filePath = path.join(proofsDir, safeFilename);
        try {
          if (fs.existsSync(filePath) && path.resolve(filePath).startsWith(path.resolve(proofsDir))) {
            fs.unlinkSync(filePath);
            console.log(`[Storage Cleanup] File bukti transfer berhasil dihapus: ${filePath}`);
          }
        } catch (errUnlink) {
          console.warn(`[Storage Cleanup] Gagal menghapus file bukti ${filePath}:`, errUnlink.message);
        }
      }
    }
  } catch (errFile) {
    console.warn('[Storage Cleanup] Gagal query file bukti transfer saat hapus user:', errFile.message);
  }

  // 2. Hapus seluruh data berelasi dari database SQLite
  try { db.prepare('DELETE FROM user_sessions WHERE customer_id = ?').run(customerId); } catch(e) {}
  try { db.prepare('DELETE FROM otp_codes WHERE customer_id = ?').run(customerId); } catch(e) {}
  try { db.prepare('DELETE FROM bills WHERE customer_id = ?').run(customerId); } catch(e) {}
  try { db.prepare('DELETE FROM customers WHERE id = ?').run(customerId); } catch(e) {}

  // 3. Catat riwayat aktivitas audit
  try {
    db.prepare('INSERT INTO activity_logs (action, details, target, status) VALUES (?, ?, ?, ?)').run(
      'CUSTOMER_DELETED',
      `Pelanggan '${username || customerId}' (ID: ${customerId}) dan seluruh file bukti tagihan berhasil dihapus dari sistem.`,
      username || String(customerId),
      'success'
    );
  } catch(e) {}
}

function getRouterConfig() {
  const ip = db.prepare("SELECT value FROM settings WHERE key = 'router_ip'").get()?.value || '';
  const user = db.prepare("SELECT value FROM settings WHERE key = 'router_user'").get()?.value || '';
  const pass = db.prepare("SELECT value FROM settings WHERE key = 'router_pass'").get()?.value || '';
  const port = parseInt(db.prepare("SELECT value FROM settings WHERE key = 'router_port'").get()?.value || '8728', 10);
  const connected = db.prepare("SELECT value FROM settings WHERE key = 'router_connected'").get()?.value;
  return { host: ip, user: user, password: pass, port: port, timeout: 10, isConfigured: Boolean(ip && user), isConnected: connected === 'true' };
}

// Helper Ekstraksi & Deteksi Harga Paket dari Comment / Nama Profile MikroTik
function extractPrice(str) {
  if (!str) return null;
  const clean = String(str).replace(/rp\.?/gi, '').trim();

  // Pola A: Ada akhiran 'k', 'rb', atau 'ribu' (contoh: 150k, 150rb, 150 ribu, 59k, 80k, 120k)
  const matchK = clean.match(/(\d+(?:[.,]\d+)?)\s*(?:k|rb|ribu)\b/i);
  if (matchK) {
    const val = parseFloat(matchK[1].replace(',', '.'));
    if (!isNaN(val) && val > 0) return Math.round(val * 1000);
  }

  // Pola B: Format angka ribuan dengan titik/koma (contoh: 150.000, 150,000, 1.000.000)
  const matchThousands = clean.match(/\b(\d{1,3}(?:[.,]\d{3})+)\b/);
  if (matchThousands) {
    const num = parseInt(matchThousands[1].replace(/[.,]/g, ''), 10);
    if (!isNaN(num) && num >= 10000) return num;
  }

  // Pola C: Angka utuh >= 10000 (contoh: 100000, 150000, 200000)
  const matchFullNum = clean.match(/\b(\d{5,})\b/);
  if (matchFullNum) {
    const num = parseInt(matchFullNum[1], 10);
    if (!isNaN(num)) return num;
  }

  // Pola D: Singkatan ratusan/puluhan ribu di comment MikroTik (contoh admin isi comment: 100, 150, 200, 50, 80, 250)
  const matchShort = clean.match(/\b(\d{2,4})\b/);
  if (matchShort) {
    const num = parseInt(matchShort[1], 10);
    if (num >= 20 && num <= 999) return num * 1000;
    if (num >= 1000 && num <= 2000) return num * 1000;
  }

  return null;
}

function parsePlanPrice(comment, name) {
  // 1. Prioritaskan comment di MikroTik terlebih dahulu
  if (comment !== undefined && comment !== null) {
    const p = extractPrice(String(comment));
    if (p !== null) return p;
  }

  // 2. Jika comment kosong, ekstrak dari nama profile (misal: "PAKET 150K", "150rb", dll.)
  if (name !== undefined && name !== null) {
    const p = extractPrice(String(name));
    if (p !== null) return p;
  }

  // 3. Fallback default
  return 100000;
}

// Helper Normalisasi Nomor Telepon Lokal (Mengabaikan MAC Address yang ber-titik dua)
function normalizePhoneLocal(phone) {
  if (!phone || phone === '-') return '-';
  const raw = String(phone).trim();
  if (raw.includes(':')) return '-'; // MAC Address bukan nomor HP
  let cleaned = raw.replace(/\D/g, '');
  if (!cleaned || cleaned.length < 8) return '-';
  if (cleaned.startsWith('62')) cleaned = '0' + cleaned.substring(2);
  else if (cleaned.startsWith('8')) cleaned = '0' + cleaned;
  return cleaned;
}

// Helper Tanggal Jatuh Tempo Efektif (mencegah bug tanggal 31 pada bulan pendek)
function getEffectiveDueDate(year, month, configuredDueDate) {
  const daysInMonth = new Date(year, month, 0).getDate();
  return Math.min(configuredDueDate, daysInMonth);
}

// Helper Cek Keterlambatan Per Periode Tagihan (YYYY-MM) termasuk Masa Toleransi Lintas Bulan
function isBillOverdueForPeriod(periodStr, dueDate, toleranceDays, todayTime) {
  if (!periodStr || !dueDate) return false;
  const parts = String(periodStr).split('-').map(Number);
  if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) return false;
  const [bYear, bMonth] = parts;
  const effDay = getEffectiveDueDate(bYear, bMonth, dueDate);
  const dueDt = new Date(bYear, bMonth - 1, effDay);
  const deadlineDt = new Date(dueDt);
  deadlineDt.setDate(deadlineDt.getDate() + toleranceDays);
  return todayTime.getTime() > deadlineDt.getTime();
}

// Cache ringan Live Status MikroTik agar multiple tab admin tidak membanjiri API router
let liveStatusCache = { data: [], updatedAt: 0 };

function formatRosError(err, host = '', port = 8728) {
  let errCode = err.code || err.errno;
  if (typeof errCode === 'number') {
    try {
      const util = require('util');
      errCode = util.getSystemErrorName(errCode);
    } catch(e) {}
  }

  let friendlyMsg = '';
  if (errCode === 'ECONNREFUSED') {
    friendlyMsg = `Koneksi ditolak (${host}:${port}). Service API MikroTik (/ip service api) belum aktif atau port ${port} tidak terbuka di router target.`;
  } else if (errCode === 'ETIMEDOUT' || errCode === 'SOCKTMOUT') {
    friendlyMsg = `Koneksi timeout (${host}:${port}). Router tidak merespons dalam 8 detik. Pastikan router menyala, kabel/WiFi terhubung, dan PC dapat menjangkau IP tersebut.`;
  } else if (errCode === 'EHOSTUNREACH' || errCode === 'ENETUNREACH') {
    friendlyMsg = `Host/Network tidak terjangkau (${host}). PC tidak memiliki rute ke subnet ini. Pastikan IP router target satu jaringan dengan PC atau rute gateway sudah benar.`;
  } else if (errCode === 'CANTLOGIN' || (err.message && /invalid/i.test(err.message))) {
    friendlyMsg = `Username atau Password salah! Pastikan username dan password MikroTik target sudah benar dan memiliki akses API.`;
  } else if (err.message && err.message.trim().length > 0) {
    friendlyMsg = err.message;
  } else {
    friendlyMsg = `Gagal terhubung ke router MikroTik (${errCode || 'Koneksi gagal'}). Periksa IP, Port, dan Service API di MikroTik target.`;
  }

  const enhancedErr = new Error(friendlyMsg);
  enhancedErr.code = errCode || 'CONN_ERROR';
  enhancedErr.originalMessage = err.message;
  enhancedErr.host = host;
  enhancedErr.port = port;
  return enhancedErr;
}

async function testMikrotikConnection(host, user, password, port = 8728) {
  const cleanHost = (host || '').trim();
  const cleanUser = (user || '').trim();
  const cleanPort = parseInt(port, 10) || 8728;
  const cleanPass = password || '';

  if (!cleanHost) throw new Error('Host IP MikroTik wajib diisi!');
  if (!cleanUser) throw new Error('Username MikroTik wajib diisi!');

  const api = new RouterOSClient({
    host: cleanHost,
    user: cleanUser,
    password: cleanPass,
    port: cleanPort,
    timeout: 8
  });
  api.on('error', () => {});

  try {
    const client = await api.connect();
    // Ambil info resource router (Model, Versi RouterOS, Uptime)
    const resource = await client.menu('/system resource').get();
    let rbData = {};
    try {
      const routerboard = await client.menu('/system routerboard').get();
      rbData = routerboard[0] || {};
    } catch (e) {
      // Pada MikroTik CHR (Cloud Hosted Router) atau x86 VM, menu /system routerboard tidak tersedia
    }
    api.close();

    const resData = resource[0] || {};

    return {
      success: true,
      model: rbData.model || resData.boardName || resData.platform || 'MikroTik CHR / x86',
      version: resData.version || 'RouterOS',
      uptime: resData.uptime || '-',
      cpuLoad: resData.cpuLoad !== undefined ? resData.cpuLoad + '%' : '-'
    };
  } catch (err) {
    if (api) try { api.close(); } catch(e) {}
    throw formatRosError(err, cleanHost, cleanPort);
  }
}

async function getMikrotikClient(customTimeout = 10) {
  const config = getRouterConfig();
  if (!config.host || !config.user) {
    throw new Error('MikroTik belum dikonfigurasi. Silakan atur koneksi MikroTik terlebih dahulu di Dashboard.');
  }
  if (!config.isConnected) {
    throw new Error('MikroTik sedang dalam status tidak terhubung (Disconnected).');
  }
  const api = new RouterOSClient({ ...config, timeout: customTimeout });
  api.on('error', (err) => {
    // Tangani event error agar tidak menjadi Unhandled Exception di Node.js
    console.warn('[MikroTik API Error]', err.message || err);
  });
  try {
    const client = await api.connect();
    return { api, client };
  } catch (err) {
    if (api) try { api.close(); } catch(e) {}
    throw formatRosError(err, config.host, config.port);
  }
}

// Sinkronisasi data dari MikroTik ke Database SQLite (Hemat eMMC dengan Dirty-Check & Transaction)
async function syncFromMikrotik() {
  let apiInstance = null;
  let inTransaction = false;
  try {
    const { api } = await getMikrotikClient();
    apiInstance = api;

    // 1. Ambil Profiles, Secrets, dan Active Sessions SEKALI SAJA via raw rosApi (presisi string terjaga & beban CPU router 50% lebih ringan)
    const [profiles, rawSecrets, activeSessions] = await Promise.all([
      api.rosApi.write(['/ppp/profile/print']),
      api.rosApi.write(['/ppp/secret/print']),
      api.rosApi.write(['/ppp/active/print'])
    ]);

    const activeUsernames = new Map(activeSessions.map(s => [s.name, s]));
    const currentMikrotikUsernames = new Set(rawSecrets.map(s => s.name).filter(Boolean));
    const toleranceDays = parseInt(db.prepare("SELECT value FROM settings WHERE key = 'tolerance_days'").get()?.value || '3', 10);

    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;
    const currentDay = now.getDate();
    const currentPeriod = `${currentYear}-${String(currentMonth).padStart(2, '0')}`;
    const todayTime = new Date(currentYear, currentMonth - 1, currentDay);

    const callerIdsToClear = [];
    const pendingMikrotikActions = [];
    const liveStatusSnapshot = [];

    db.exec('BEGIN IMMEDIATE');
    inTransaction = true;

    // A. Sinkronkan Profile PPPoE (dengan Dirty-Check)
    for (const p of profiles) {
      if (!p.name || p.name === 'default' || p.name === 'default-encryption') continue;
      const speed = p['rate-limit'] || 'Unlimited';
      const price = parsePlanPrice(p.comment, p.name);

      const existingPlan = db.prepare('SELECT id, name, profile, price, speed FROM plans WHERE name = ? OR profile = ?').get(p.name, p.name);
      if (!existingPlan) {
        db.prepare('INSERT INTO plans (name, profile, price, speed) VALUES (?, ?, ?, ?)').run(p.name, p.name, price, speed);
      } else if (existingPlan.profile !== p.name || existingPlan.speed !== speed || existingPlan.price !== price) {
        db.prepare('UPDATE plans SET profile = ?, speed = ?, price = ? WHERE id = ?').run(p.name, speed, price, existingPlan.id);
      }
    }

    // B. Hapus pelanggan di SQLite yang SUDAH TIDAK ADA di MikroTik (Dengan Safety Guard anti-glitch router kosong)
    const existingDbCustomers = db.prepare('SELECT id, pppoe_username FROM customers').all();
    if (rawSecrets.length === 0 && existingDbCustomers.length > 0) {
      console.warn('[Sync Safety] MikroTik mengembalikan 0 secret sementara DB punya pelanggan. Penghapusan otomatis dilewati.');
    } else {
      const missingCustomers = existingDbCustomers.filter(dbCust => !currentMikrotikUsernames.has(dbCust.pppoe_username));
      if (existingDbCustomers.length >= 10 && missingCustomers.length > existingDbCustomers.length * 0.5) {
        console.warn(`[Sync Safety] Terdeteksi ${missingCustomers.length}/${existingDbCustomers.length} pelanggan hilang mendadak! Penghapusan massal otomatis ditahan demi keamanan.`);
      } else {
        for (const dbCust of missingCustomers) {
          console.log(`[Sync] Pelanggan '${dbCust.pppoe_username}' dihapus dari Database karena sudah tidak ada di MikroTik.`);
          deleteCustomerLocalData(dbCust.id, dbCust.pppoe_username);
        }
      }
    }

    // C. Masukkan atau update pelanggan yang ada di MikroTik (Hemat Disk Write: hanya UPDATE jika data berubah)
    for (const rawS of rawSecrets) {
      const username = rawS.name;
      if (!username) continue;

      const secretId = rawS['.id'];
      const password = String(rawS.password || '');
      const profileName = rawS.profile || 'default';
      const comment = rawS.comment !== undefined ? String(rawS.comment) : '';
      const rawCaller = rawS['caller-id'] !== undefined ? String(rawS['caller-id']).trim() : '';

      // Cek MAC Address dulu sebelum normalisasi nomor HP agar binding MAC teknisi tidak pernah terhapus!
      const isMacBinding = rawCaller.includes(':');
      const phoneFromCaller = isMacBinding ? '-' : normalizePhoneLocal(rawCaller);
      if (!isMacBinding && phoneFromCaller !== '-' && secretId) {
        // Jika caller-id terisi nomor HP (bukan MAC), jadwalkan pembersihan di MikroTik
        callerIdsToClear.push(secretId);
      }

      const isDisabled = rawS.disabled === true || rawS.disabled === 'true';
      const status = isDisabled ? 'isolated' : 'active';
      const act = activeUsernames.get(username);

      liveStatusSnapshot.push({
        name: username,
        service: rawS.service || 'pppoe',
        profile: profileName,
        localAddress: rawS['local-address'] || (act ? act.address : '-'),
        remoteAddress: rawS['remote-address'] || (act ? act.address : '-'),
        callerId: act ? (act['caller-id'] || '-') : (rawCaller || '-'),
        uptime: act ? (act.uptime || '-') : '-',
        disabled: isDisabled,
        isOnline: !!act,
        comment: comment
      });

      // Tgl Jatuh Tempo diambil dari Comment di MikroTik (DD-MM-YYYY atau angka tanggal)
      let dueDate = null;
      let fullDueYear = null;
      let fullDueMonth = null;
      if (comment.trim() !== '') {
        const fullDateMatch = comment.trim().match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
        if (fullDateMatch) {
          dueDate = parseInt(fullDateMatch[1], 10);
          fullDueMonth = parseInt(fullDateMatch[2], 10);
          fullDueYear = parseInt(fullDateMatch[3], 10);
        } else {
          const dateMatch = comment.match(/^(\d{1,2})[-/]/);
          if (dateMatch) {
            dueDate = parseInt(dateMatch[1], 10);
          } else {
            const numMatch = comment.match(/\b(\d{1,2})\b/);
            if (numMatch) {
              const parsed = parseInt(numMatch[1], 10);
              if (parsed >= 1 && parsed <= 31) dueDate = parsed;
            }
          }
        }
      }

      const plan = db.prepare('SELECT id, price FROM plans WHERE name = ? OR profile = ?').get(profileName, profileName);
      const planId = plan ? plan.id : null;
      const planPrice = plan ? plan.price : 100000;

      let customer = db.prepare('SELECT id, name, phone, pppoe_password, plan_id, due_date, status, comment FROM customers WHERE pppoe_username = ?').get(username);
      if (!customer) {
        const info = db.prepare(`
          INSERT INTO customers (name, phone, pppoe_username, pppoe_password, plan_id, due_date, status, comment)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(username, phoneFromCaller, username, password, planId, dueDate, status, comment);
        customer = { id: info.lastInsertRowid, name: username, phone: phoneFromCaller, pppoe_password: password, plan_id: planId, due_date: dueDate, status, comment };
      } else {
        const finalPhone = (customer.phone && customer.phone !== '-') ? customer.phone : phoneFromCaller;
        const hasChanged =
          customer.name !== username ||
          customer.phone !== finalPhone ||
          customer.pppoe_password !== password ||
          customer.plan_id !== planId ||
          customer.due_date !== dueDate ||
          customer.status !== status ||
          (customer.comment || '') !== comment;

        if (hasChanged) {
          db.prepare(`
            UPDATE customers 
            SET name = ?, phone = ?, pppoe_password = ?, plan_id = ?, due_date = ?, status = ?, comment = ?
            WHERE id = ?
          `).run(username, finalPhone, password, planId, dueDate, status, comment, customer.id);
          customer.status = status;
        }
      }

      // Cek / Buat Tagihan Bulan Berjalan (Tagihan baru masuk bulan baru WAJIB 'unpaid'!)
      let bill = db.prepare('SELECT id, status, amount, duration_months FROM bills WHERE customer_id = ? AND period = ?').get(customer.id, currentPeriod);
      if (!bill) {
        let isFutureCommentPaid = false;
        if (fullDueYear && fullDueMonth) {
          const commentPeriod = `${fullDueYear}-${String(fullDueMonth).padStart(2, '0')}`;
          if (commentPeriod > currentPeriod) {
            isFutureCommentPaid = true;
          }
        }
        const billStatus = isFutureCommentPaid ? 'paid' : 'unpaid';
        const infoBill = db.prepare(`
          INSERT INTO bills (customer_id, period, amount, status, paid_at, payment_method)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          customer.id,
          currentPeriod,
          planPrice,
          billStatus,
          isFutureCommentPaid ? db.prepare("SELECT datetime('now', 'localtime') as t").get().t : null,
          isFutureCommentPaid ? 'Comment MikroTik' : null
        );
        bill = { id: infoBill.lastInsertRowid, status: billStatus, amount: planPrice, duration_months: 1 };
      } else if (bill.status === 'unpaid' && bill.amount !== planPrice && (bill.duration_months || 1) === 1) {
        db.prepare('UPDATE bills SET amount = ? WHERE id = ?').run(planPrice, bill.id);
        bill.amount = planPrice;
      }

      // Cek keterlambatan lintas bulan per tagihan (mempertahankan masa toleransi tgl 28-31!)
      let hasOverdueUnpaid = false;
      if (dueDate) {
        const unpaidBills = db.prepare("SELECT id, period FROM bills WHERE customer_id = ? AND status = 'unpaid'").all(customer.id);
        hasOverdueUnpaid = unpaidBills.some(ub => isBillOverdueForPeriod(ub.period, dueDate, toleranceDays, todayTime));
      }

      const pendingBill = db.prepare("SELECT id FROM bills WHERE customer_id = ? AND status = 'pending_verification' LIMIT 1").get(customer.id);

      // KONSISTENSI DATA DATABASE VS MIKROTIK:
      // 1. Jika ada tagihan belum bayar & sudah lewat jatuh tempo + toleransi (dan tidak sedang review bukti baru jika masih aktif) -> WAJIB TERISOLIR
      if (hasOverdueUnpaid && !pendingBill) {
        if (customer.status !== 'isolated') {
          db.prepare("UPDATE customers SET status = 'isolated' WHERE id = ?").run(customer.id);
        }
        if (!isDisabled && secretId) {
          pendingMikrotikActions.push({ username, secretId, enable: false });
        }
      } else if (!hasOverdueUnpaid && bill.status === 'paid' && isDisabled && customer.status === 'active' && secretId) {
        // 2. Self-healing jika approve gagal buka isolir karena router sempat offline
        pendingMikrotikActions.push({ username, secretId, enable: true });
      }
    }

    db.exec('COMMIT');
    inTransaction = false;

    // Update live cache
    liveStatusCache = { data: liveStatusSnapshot, updatedAt: Date.now() };

    // D. Eksekusi perintah MikroTik yang tertunda secara berurutan pada koneksi yang sama
    for (const cid of callerIdsToClear) {
      try {
        await api.rosApi.write(['/ppp/secret/set', '=.id=' + cid, '=caller-id=']);
      } catch (e) {}
    }

    for (const act of pendingMikrotikActions) {
      try {
        if (act.enable) {
          await api.rosApi.write(['/ppp/secret/enable', '=.id=' + act.secretId]);
          console.log(`[Sync Self-Heal] Secret '${act.username}' diaktifkan kembali di MikroTik.`);
        } else {
          await api.rosApi.write(['/ppp/secret/disable', '=.id=' + act.secretId]);
          const activeToKick = activeSessions.filter(a => a.name === act.username);
          for (const sess of activeToKick) {
            if (sess['.id']) {
              await api.rosApi.write(['/ppp/active/remove', '=.id=' + sess['.id']]);
            }
          }
          console.log(`[Sync Enforce Isolir] Secret '${act.username}' dinonaktifkan & sesi aktif diputus di MikroTik.`);
        }
      } catch (e) {
        console.warn(`[Sync Action Error] '${act.username}':`, e.message);
      }
    }

    apiInstance.close();
    return { success: true, count: rawSecrets.length };
  } catch (err) {
    if (inTransaction) {
      try { db.exec('ROLLBACK'); } catch (e) {}
    }
    if (apiInstance) try { apiInstance.close(); } catch (e) {}
    console.error('Error syncing with MikroTik:', err.message);
    throw err;
  }
}

// Fungsi Ubah Status di MikroTik (Enable / Disable Secret + Kick Session jika isolir)
async function setMikrotikSecretStatus(username, enable) {
  let apiInstance = null;
  try {
    const { api, client } = await getMikrotikClient();
    apiInstance = api;

    const secretMenu = client.menu('/ppp secret');
    const secrets = await secretMenu.get();
    const targetSecret = secrets.find(s => s.name === username);

    if (targetSecret) {
      const ros = api.rosApi;
      const secretId = targetSecret['.id'] || targetSecret.id;
      if (enable) {
        // Aktifkan Secret di MikroTik via RouterOS API command
        await ros.write(['/ppp/secret/enable', '=.id=' + secretId]);
        console.log(`[Unisolir] Secret '${username}' berhasil diaktifkan kembali (enable) di MikroTik.`);
      } else {
        // Matikan Secret di MikroTik via RouterOS API command
        await ros.write(['/ppp/secret/disable', '=.id=' + secretId]);
        console.log(`[Isolir] Secret '${username}' berhasil dinonaktifkan (disable) di MikroTik.`);

        // Tendang SEMUA koneksi aktif seketika (Kill Active Session)
        try {
          const activeMenu = client.menu('/ppp active');
          const actives = await activeMenu.get();
          const targetActives = actives.filter(a => a.name === username);
          for (const act of targetActives) {
            const actId = act['.id'] || act.id;
            await ros.write(['/ppp/active/remove', '=.id=' + actId]);
            console.log(`[Isolir] Berhasil memutus koneksi aktif '${username}' (ID: ${actId}) dari /ppp active.`);
          }
          if (targetActives.length === 0) {
            console.log(`[Isolir] Pelanggan '${username}' tidak sedang memiliki sesi online di /ppp active.`);
          }
        } catch (e) {
          console.warn(`[Isolir] Gagal me-remove active session '${username}':`, e.message);
        }
      }
    }

    liveStatusCache.updatedAt = 0;
    apiInstance.close();
    return { success: true };
  } catch (err) {
    if (apiInstance) try { apiInstance.close(); } catch (e) {}
    console.error('Error setting MikroTik secret status:', err.message);
    throw err;
  }
}

// Tambah Pelanggan Baru (Input via Web App -> Kirim ke MikroTik & Simpan ke SQLite)
async function addCustomerToMikrotik({ name, password, profile, phone, dueDate, comment, initialPayment }) {
  let apiInstance = null;
  try {
    const { api, client } = await getMikrotikClient();
    apiInstance = api;

    // Format comment tgl jatuh tempo (misal: 01-11-2026 atau tanggal pilihan)
    let formattedComment = comment;
    if (!formattedComment) {
      const padDay = String(dueDate || 10).padStart(2, '0');
      const now = new Date();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const year = now.getFullYear();
      formattedComment = `${padDay}-${month}-${year}`;
    }

    const isPaid = initialPayment !== 'unpaid';
    const status = isPaid ? 'active' : 'isolated';
    const disabledFlag = isPaid ? 'no' : 'yes'; // Default: Sudah bayar (Aktif / disabled='no')

    // 1. Buat Secret baru di MikroTik
    const secretMenu = client.menu('/ppp secret');
    const secretData = {
      name: name,
      password: String(password),
      profile: profile || 'default',
      service: 'pppoe',
      comment: formattedComment,
      'caller-id': '', // Wajib kosong agar tidak memblokir MAC Address PPPoE klien
      disabled: disabledFlag
    };

    await secretMenu.add(secretData);

    // 2. Ambil data plan
    const plan = db.prepare('SELECT id, price FROM plans WHERE name = ? OR profile = ?').get(profile, profile);
    const planId = plan ? plan.id : null;
    const planPrice = plan ? plan.price : 150000;

    // 3. Simpan ke SQLite (Status sesuai pembayaran awal + comment & nomor WA ternormalisasi)
    const normalizedPhone = normalizePhoneLocal(phone);
    const info = db.prepare(`
      INSERT INTO customers (name, phone, pppoe_username, pppoe_password, plan_id, due_date, status, comment)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, normalizedPhone, name, password, planId, dueDate || 10, status, formattedComment);

    // Buat tagihan bulan berjalan (status: paid atau unpaid)
    const nowTime = new Date();
    const curPeriodKey = `${nowTime.getFullYear()}-${String(nowTime.getMonth() + 1).padStart(2, '0')}`;
    if (isPaid) {
      db.prepare(`
        INSERT INTO bills (customer_id, period, amount, status, paid_at, payment_method)
        VALUES (?, ?, ?, 'paid', datetime('now', 'localtime'), 'Manual Kasir')
      `).run(info.lastInsertRowid, curPeriodKey, planPrice);
    } else {
      db.prepare(`
        INSERT INTO bills (customer_id, period, amount, status)
        VALUES (?, ?, ?, 'unpaid')
      `).run(info.lastInsertRowid, curPeriodKey, planPrice);
    }

    liveStatusCache.updatedAt = 0;
    apiInstance.close();
    return { success: true };
  } catch (err) {
    if (apiInstance) apiInstance.close();
    console.error('Error adding customer to MikroTik:', err.message);
    throw err;
  }
}

// Hapus Pelanggan dari MikroTik, SQLite & Bersihkan File Bukti di Storage
async function removeCustomerFromMikrotik(username, id) {
  let apiInstance = null;
  let mikrotikSuccess = false;
  let mikrotikWarning = '';

  // 1. Coba hapus akun dari MikroTik (jika router terhubung)
  try {
    const { api, client } = await getMikrotikClient();
    apiInstance = api;

    const secretMenu = client.menu('/ppp secret');
    const secrets = await secretMenu.get();
    const target = secrets.find(s => s.name === username);
    if (target) {
      await api.rosApi.write(['/ppp/secret/remove', '=.id=' + target.id]);
    }

    // Tendang sesi aktif jika ada
    try {
      const activeMenu = client.menu('/ppp active');
      const actives = await activeMenu.get();
      const targetActives = actives.filter(a => a.name === username);
      for (const act of targetActives) {
        const actId = act['.id'] || act.id;
        await api.rosApi.write(['/ppp/active/remove', '=.id=' + actId]);
      }
    } catch (e) {}

    mikrotikSuccess = true;
    apiInstance.close();
  } catch (errRos) {
    if (apiInstance) {
      try { apiInstance.close(); } catch (e) {}
    }
    console.warn(`[Remove Customer] Router MikroTik tidak terjangkau / offline saat menghapus '${username}':`, errRos.message);
    mikrotikWarning = `Router MikroTik tidak terjangkau (${errRos.message}).`;
  }

  // 2. Selalu bersihkan file fisik di storage server & data di database SQLite
  deleteCustomerLocalData(id, username);

  return { success: true, mikrotikSuccess, warning: mikrotikWarning };
}

// Ambil Status Real-Time Detail dari MikroTik untuk Semua Pelanggan (Dengan 4s Cache & Single Fetch)
async function getMikrotikLiveStatus(forceRefresh = false) {
  const config = getRouterConfig();
  if (!config.isConnected || !config.host) {
    return [];
  }
  if (!forceRefresh && liveStatusCache.data.length > 0 && (Date.now() - liveStatusCache.updatedAt) < 4000) {
    return liveStatusCache.data;
  }
  let apiInstance = null;
  try {
    const { api } = await getMikrotikClient(3);
    apiInstance = api;

    const [rawSecrets, active] = await Promise.all([
      api.rosApi.write(['/ppp/secret/print']),
      api.rosApi.write(['/ppp/active/print'])
    ]);
    const activeMap = new Map(active.map(a => [a.name, a]));

    const result = rawSecrets.map(raw => {
      const act = activeMap.get(raw.name);
      const rawCaller = raw['caller-id'] !== undefined ? String(raw['caller-id']).trim() : '';
      const callerIdDisplay = act ? (act['caller-id'] || '-') : (rawCaller || '-');
      return {
        name: raw.name,
        service: raw.service || 'pppoe',
        profile: raw.profile || 'default',
        localAddress: raw['local-address'] || (act ? act.address : '-'),
        remoteAddress: raw['remote-address'] || (act ? act.address : '-'),
        callerId: callerIdDisplay,
        uptime: act ? (act.uptime || '-') : '-',
        disabled: raw.disabled === true || raw.disabled === 'true',
        isOnline: !!act,
        comment: raw.comment || ''
      };
    });

    liveStatusCache = { data: result, updatedAt: Date.now() };
    apiInstance.close();
    return result;
  } catch (err) {
    if (apiInstance) try { apiInstance.close(); } catch (e) {}
    throw err;
  }
}

// Update No HP Pelanggan di SQLite (dan bersihkan caller-id di MikroTik jika sebelumnya terisi no HP)
async function updateCustomerPhoneInMikrotik(username, phone) {
  let apiInstance = null;
  try {
    const { api, client } = await getMikrotikClient();
    apiInstance = api;

    const secretMenu = client.menu('/ppp secret');
    const secrets = await secretMenu.get();
    const target = secrets.find(s => s.name === username);
    if (target) {
      // Pastikan caller-id di MikroTik bersih / kosong agar tidak memblokir MAC Address PPPoE
      const targetId = target['.id'] || target.id;
      await api.rosApi.write(['/ppp/secret/set', '=.id=' + targetId, '=caller-id=']);
    }

    // Update SQLite dengan nomor ternormalisasi
    const normalized = normalizePhoneLocal(phone);
    db.prepare('UPDATE customers SET phone = ? WHERE pppoe_username = ?').run(normalized, username);

    liveStatusCache.updatedAt = 0;
    apiInstance.close();
    return { success: true };
  } catch (err) {
    if (apiInstance) try { apiInstance.close(); } catch (e) {}
    throw err;
  }
}

// Update Tanggal Jatuh Tempo Pelanggan (Sync ke Comment MikroTik & SQLite)
async function updateCustomerDueDateInMikrotik(username, newDueDate) {
  let apiInstance = null;
  const numDueDate = parseInt(newDueDate, 10);
  if (isNaN(numDueDate) || numDueDate < 1 || numDueDate > 31) {
    throw new Error('Tanggal jatuh tempo harus berupa angka antara 1 sampai 31!');
  }

  try {
    const { api, client } = await getMikrotikClient();
    apiInstance = api;

    const secretMenu = client.menu('/ppp secret');
    const secrets = await secretMenu.get();
    const target = secrets.find(s => s.name === username);
    
    if (target) {
      const padDay = String(numDueDate).padStart(2, '0');
      let newComment = '';
      const existingComment = target.comment || '';
      
      if (existingComment.match(/^(\d{1,2})([-/.])(.*)/)) {
        newComment = existingComment.replace(/^(\d{1,2})([-/.])(.*)/, `${padDay}$2$3`);
      } else if (existingComment) {
        newComment = `${padDay} - ${existingComment}`;
      } else {
        const now = new Date();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const year = now.getFullYear();
        newComment = `${padDay}-${month}-${year}`;
      }

      const targetId = target['.id'] || target.id;
      await api.rosApi.write(['/ppp/secret/set', '=.id=' + targetId, '=comment=' + newComment]);
    }

    // Update SQLite database
    db.prepare('UPDATE customers SET due_date = ?, comment = COALESCE(comment, ?) WHERE pppoe_username = ?').run(numDueDate, String(numDueDate), username);

    liveStatusCache.updatedAt = 0;
    apiInstance.close();
    return { success: true, dueDate: numDueDate };
  } catch (err) {
    if (apiInstance) apiInstance.close();
    throw err;
  }
}

// Update Data Pelanggan Lengkap (Jatuh Tempo, WA, Password, Profile Paket)
async function updateCustomerInMikrotik(username, { dueDate, phone, password, profile }) {
  let apiInstance = null;
  try {
    const { api, client } = await getMikrotikClient();
    apiInstance = api;

    const secretMenu = client.menu('/ppp secret');
    const secrets = await secretMenu.get();
    const target = secrets.find(s => s.name === username);
    if (!target) {
      throw new Error(`Pelanggan '${username}' tidak ditemukan di MikroTik!`);
    }

    const targetId = target['.id'] || target.id;
    const rosCmd = ['/ppp/secret/set', '=.id=' + targetId];
    let numDueDate = null;

    if (dueDate !== undefined && dueDate !== null && dueDate !== '') {
      numDueDate = parseInt(dueDate, 10);
      if (isNaN(numDueDate) || numDueDate < 1 || numDueDate > 31) {
        throw new Error('Tanggal jatuh tempo harus antara 1 sampai 31!');
      }
      const padDay = String(numDueDate).padStart(2, '0');
      let newComment = '';
      const existingComment = target.comment || '';
      if (existingComment.match(/^(\d{1,2})([-/.])(.*)/)) {
        newComment = existingComment.replace(/^(\d{1,2})([-/.])(.*)/, `${padDay}$2$3`);
      } else if (existingComment) {
        newComment = `${padDay} - ${existingComment}`;
      } else {
        const now = new Date();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const year = now.getFullYear();
        newComment = `${padDay}-${month}-${year}`;
      }
      rosCmd.push('=comment=' + newComment);
    }

    if (phone !== undefined) {
      // Pastikan caller-id di MikroTik tetap kosong agar autentikasi MAC PPPoE tidak tertolak
      rosCmd.push('=caller-id=');
    }

    if (password) {
      rosCmd.push('=password=' + String(password).trim());
    }

    if (profile) {
      rosCmd.push('=profile=' + String(profile).trim());
    }

    // Kirim update ke MikroTik
    await api.rosApi.write(rosCmd);

    // Update SQLite database
    const updates = [];
    const params = [];

    if (numDueDate !== null) {
      updates.push('due_date = ?');
      params.push(numDueDate);
    }
    if (phone !== undefined) {
      updates.push('phone = ?');
      params.push(normalizePhoneLocal(phone));
    }
    if (password) {
      updates.push('pppoe_password = ?');
      params.push(String(password).trim());
    }
    if (profile) {
      const plan = db.prepare('SELECT id, price FROM plans WHERE name = ? OR profile = ?').get(profile, profile);
      if (plan) {
        updates.push('plan_id = ?');
        params.push(plan.id);

        const now = new Date();
        const curPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const cust = db.prepare('SELECT id FROM customers WHERE pppoe_username = ?').get(username);
        if (cust) {
          db.prepare("UPDATE bills SET amount = ?, duration_months = 1 WHERE customer_id = ? AND period = ? AND status = 'unpaid'")
            .run(plan.price, cust.id, curPeriod);
        }
      }
    }

    if (updates.length > 0) {
      params.push(username);
      db.prepare(`UPDATE customers SET ${updates.join(', ')} WHERE pppoe_username = ?`).run(...params);
    }

    liveStatusCache.updatedAt = 0;
    apiInstance.close();
    return { success: true };
  } catch (err) {
    if (apiInstance) apiInstance.close();
    throw err;
  }
}

// Ambil Daftar Interface & Real-time Traffic Monitor
async function getMikrotikInterfaces() {
  let apiInstance = null;
  try {
    const { api, client } = await getMikrotikClient();
    apiInstance = api;
    const ifaces = await client.menu('/interface').get();
    apiInstance.close();
    return ifaces.map(i => ({
      name: i.name,
      type: i.type,
      running: i.running === 'true' || i.running === true,
      disabled: i.disabled === 'true' || i.disabled === true,
      comment: i.comment || ''
    }));
  } catch (err) {
    if (apiInstance) apiInstance.close();
    throw err;
  }
}

async function getMikrotikTraffic(interfaceName = 'ether1') {
  let apiInstance = null;
  try {
    const { api } = await getMikrotikClient();
    apiInstance = api;
    const res = await api.rosApi.write(['/interface/monitor-traffic', `=interface=${interfaceName}`, '=once=']);
    apiInstance.close();
    const data = res[0] || {};
    return {
      interface: interfaceName,
      rxBps: parseInt(data['rx-bits-per-second'] || 0, 10),
      txBps: parseInt(data['tx-bits-per-second'] || 0, 10),
      rxPackets: parseInt(data['rx-packets-per-second'] || 0, 10),
      txPackets: parseInt(data['tx-packets-per-second'] || 0, 10)
    };
  } catch (err) {
    if (apiInstance) apiInstance.close();
    throw err;
  }
}

// Ambil Sesi User PPPoE yang Sedang Aktif
async function getMikrotikActiveSessions() {
  let apiInstance = null;
  try {
    const { api, client } = await getMikrotikClient();
    apiInstance = api;
    const active = await client.menu('/ppp active').get();
    apiInstance.close();
    return active.map(a => ({
      name: a.name,
      service: a.service || 'pppoe',
      callerId: a.callerId || '-',
      address: a.address || '-',
      uptime: a.uptime || '-',
      sessionId: a.sessionId || '-'
    }));
  } catch (err) {
    if (apiInstance) apiInstance.close();
    throw err;
  }
}

module.exports = {
  getMikrotikClient,
  testMikrotikConnection,
  syncFromMikrotik,
  setMikrotikSecretStatus,
  addCustomerToMikrotik,
  removeCustomerFromMikrotik,
  updateCustomerPhoneInMikrotik,
  updateCustomerDueDateInMikrotik,
  updateCustomerInMikrotik,
  getMikrotikLiveStatus,
  getMikrotikInterfaces,
  getMikrotikTraffic,
  getMikrotikActiveSessions,
  getRouterConfig,
  parsePlanPrice,
  normalizePhoneLocal,
  getEffectiveDueDate,
  isBillOverdueForPeriod
};

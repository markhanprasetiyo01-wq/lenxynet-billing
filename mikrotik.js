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
        const filePath = path.join(__dirname, 'public', b.proof_image);
        try {
          if (fs.existsSync(filePath)) {
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

// Sinkronisasi data dari MikroTik ke Database SQLite
async function syncFromMikrotik() {
  let apiInstance = null;
  try {
    const { api, client } = await getMikrotikClient();
    apiInstance = api;

    // 1. Ambil semua Profile PPPoE dari MikroTik
    const profiles = await client.menu('/ppp profile').get();

    for (const p of profiles) {
      if (p.name === 'default' || p.name === 'default-encryption') continue;
      
      const speed = p.rateLimit || 'Unlimited';
      // Coba ekstrak harga jika ada pola angka di nama profile (misal "Paket 150rb/10Mbps")
      let price = 100000;
      const matchPrice = p.name.match(/(\d+)rb/i);
      if (matchPrice) {
        price = parseInt(matchPrice[1]) * 1000;
      } else {
        const matchNum = p.name.match(/(\d{5,})/);
        if (matchNum) price = parseInt(matchNum[1]);
      }

      // Cek apakah sudah ada plan dengan nama ini di SQLite
      const existingPlan = db.prepare('SELECT id FROM plans WHERE name = ? OR profile = ?').get(p.name, p.name);
      if (!existingPlan) {
        db.prepare('INSERT INTO plans (name, profile, price, speed) VALUES (?, ?, ?, ?)').run(p.name, p.name, price, speed);
      } else {
        db.prepare('UPDATE plans SET profile = ?, speed = ?, price = ? WHERE id = ?').run(p.name, speed, price, existingPlan.id);
      }
    }

    // 2. Ambil semua PPP Secret dari MikroTik
    const secrets = await client.menu('/ppp secret').get();
    const activeSessions = await client.menu('/ppp active').get();
    const activeUsernames = new Map(activeSessions.map(s => [s.name, s]));
    const currentMikrotikUsernames = new Set(secrets.map(s => s.name));

    // A. Hapus pelanggan di SQLite yang SUDAH TIDAK ADA di MikroTik
    const existingDbCustomers = db.prepare('SELECT id, pppoe_username FROM customers').all();
    let deletedCount = 0;
    for (const dbCust of existingDbCustomers) {
      if (!currentMikrotikUsernames.has(dbCust.pppoe_username)) {
        console.log(`[Sync] Pelanggan '${dbCust.pppoe_username}' dihapus dari Database karena sudah tidak ada di MikroTik.`);
        deleteCustomerLocalData(dbCust.id, dbCust.pppoe_username);
        deletedCount++;
      }
    }

    // Ambil data raw dari rosApi agar string '085...' tidak otomatis diubah menjadi angka 85...
    const rawSecrets = await api.rosApi.write(['/ppp/secret/print']);
    const secretsMap = new Map(rawSecrets.map(s => [s.name, s]));

    // B. Masukkan atau update pelanggan yang ada di MikroTik
    for (const s of secrets) {
      const rawS = secretsMap.get(s.name) || {};
      const username = s.name;
      const password = String(s.password || '');
      const profileName = s.profile || 'default';
      const service = s.service || 'any';
      const localAddress = s.localAddress || '';
      const remoteAddress = s.remoteAddress || '';
      const comment = s.comment || '';
      // Prioritaskan string caller-id mentah dari MikroTik agar awalan 0 tidak hilang
      let rawCaller = rawS['caller-id'] !== undefined ? String(rawS['caller-id']).trim() : '';
      if (!rawCaller && s.callerId !== undefined && s.callerId !== null) {
        rawCaller = String(s.callerId);
      }
      // Normalkan format nomor: pastikan selalu berawalan 08xxxxxxxxx
      if (rawCaller && rawCaller !== '-') {
        rawCaller = rawCaller.replace(/\D/g, '');
        if (rawCaller.startsWith('62')) {
          rawCaller = '0' + rawCaller.substring(2);
        } else if (!rawCaller.startsWith('0')) {
          rawCaller = '0' + rawCaller;
        }
      }
      let phone = rawCaller || '-'; // No WA terhubung
      if (rawCaller && !rawCaller.includes(':') && rawCaller.length >= 8) {
        // Jika caller-id di MikroTik terisi nomor HP, bersihkan di MikroTik agar tidak memblokir MAC Address PPPoE
        try {
          const secretId = rawS['.id'] || s.id;
          if (secretId) {
            await api.rosApi.write(['/ppp/secret/set', '=.id=' + secretId, '=caller-id=']);
          }
        } catch (e) {}
      }
      const isDisabled = s.disabled === true || s.disabled === 'true';
      const status = isDisabled ? 'isolated' : 'active';
      const activeSession = activeUsernames.get(username);
      const isOnline = !!activeSession;
      const uptime = activeSession ? activeSession.uptime : '';

      // Tgl Jatuh Tempo diambil dari Comment di MikroTik (format: DD-MM-YYYY atau angka tanggal)
      // Jika comment di MikroTik kosong, dueDate bernilai null (Belum Diatur)
      let dueDate = null;
      let fullDueYear = null;
      let fullDueMonth = null;
      if (comment && String(comment).trim() !== '') {
        const fullDateMatch = String(comment).trim().match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
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
              if (parsed >= 1 && parsed <= 31) {
                dueDate = parsed;
              }
            }
          }
        }
      }

      // Cari plan_id yang cocok
      const plan = db.prepare('SELECT id, price FROM plans WHERE name = ? OR profile = ?').get(profileName, profileName);
      const planId = plan ? plan.id : null;
      const planPrice = plan ? plan.price : 100000;

      // Cek apakah pelanggan sudah ada di database
      let customer = db.prepare('SELECT id, phone, name FROM customers WHERE pppoe_username = ?').get(username);
      if (!customer) {
        // Buat data pelanggan baru dari MikroTik (Pelanggan = Name di MikroTik, Phone = Caller ID)
        const info = db.prepare(`
          INSERT INTO customers (name, phone, pppoe_username, pppoe_password, plan_id, due_date, status, comment)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(username, phone, username, password, planId, dueDate, status, comment);
        customer = { id: info.lastInsertRowid, phone: phone };
      } else {
        // Update data jika sudah ada (Pertahankan nomor WA jika sudah ada di SQLite)
        const finalPhone = (customer.phone && customer.phone !== '-') ? customer.phone : phone;
        db.prepare(`
          UPDATE customers 
          SET name = ?, phone = ?, pppoe_password = ?, plan_id = ?, due_date = ?, status = ?, comment = ?
          WHERE id = ?
        `).run(username, finalPhone, password, planId, dueDate, status, comment, customer.id);
      }

      // Pastikan ada tagihan untuk bulan berjalan (Dinamis: Tahun-Bulan saat ini)
      const now = new Date();
      const currentYear = now.getFullYear();
      const currentMonth = now.getMonth() + 1;
      const currentDay = now.getDate();
      const currentPeriod = `${currentYear}-${String(currentMonth).padStart(2, '0')}`;

      // Cek apakah pelanggan nunggak bulan lalu atau sudah lewat jatuh tempo bulan ini + masa toleransi
      let isCustomerOverdue = false;
      if (dueDate) {
        const toleranceDays = parseInt(db.prepare("SELECT value FROM settings WHERE key = 'tolerance_days'").get()?.value || '1', 10);
        const daysInMonth = new Date(currentYear, currentMonth, 0).getDate();
        const effectiveDueDate = Math.min(dueDate, daysInMonth);
        const dueDateTime = new Date(currentYear, currentMonth - 1, effectiveDueDate);
        const deadlineTime = new Date(dueDateTime);
        deadlineTime.setDate(deadlineTime.getDate() + toleranceDays);
        const todayTime = new Date(currentYear, currentMonth - 1, currentDay);

        // Cek apakah ada tunggakan tagihan dari bulan-bulan sebelumnya
        const unpaidOldBill = db.prepare("SELECT id FROM bills WHERE customer_id = ? AND period < ? AND status = 'unpaid' LIMIT 1").get(customer.id, currentPeriod);

        isCustomerOverdue = Boolean(unpaidOldBill) || (todayTime.getTime() > deadlineTime.getTime());
      }

      let bill = db.prepare('SELECT id, status FROM bills WHERE customer_id = ? AND period = ?').get(customer.id, currentPeriod);
      if (!bill) {
        // Tagihan baru dibuat sebagai 'unpaid' jika sudah lewat jatuh tempo atau MikroTik disabled
        const billStatus = (isDisabled || isCustomerOverdue) ? 'unpaid' : 'unpaid';
        const infoBill = db.prepare(`
          INSERT INTO bills (customer_id, period, amount, status)
          VALUES (?, ?, ?, ?)
        `).run(customer.id, currentPeriod, planPrice, billStatus);
        bill = { id: infoBill.lastInsertRowid, status: billStatus };
      }

      // KONSISTENSI DATA DATABASE VS MIKROTIK:
      // 1. Jika tagihan belum bayar & sudah lewat jatuh tempo + toleransi -> WAJIB TERISOLIR
      if (bill.status === 'unpaid' && isCustomerOverdue) {
        db.prepare("UPDATE customers SET status = 'isolated' WHERE id = ?").run(customer.id);
        if (!isDisabled) {
          // Jika di MikroTik masih menyala, matikan seketika dan putus sesi aktif
          setMikrotikSecretStatus(username, false).catch(e => {
            console.warn(`[Sync Enforce Isolir] Gagal matikan MikroTik untuk ${username}:`, e.message);
          });
        }
      } else if (bill.status === 'paid' && isDisabled) {
        // 2. Jika tagihan sudah lunas tetapi di MikroTik masih disabled -> Pulihkan / Buka isolir
        db.prepare("UPDATE customers SET status = 'active' WHERE id = ?").run(customer.id);
        setMikrotikSecretStatus(username, true).catch(e => {
          console.warn(`[Sync Enforce Unisolir] Gagal aktifkan MikroTik untuk ${username}:`, e.message);
        });
      }
    }

    apiInstance.close();
    return { success: true, count: secrets.length };
  } catch (err) {
    if (apiInstance) apiInstance.close();
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

    apiInstance.close();
    return { success: true };
  } catch (err) {
    if (apiInstance) apiInstance.close();
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

    // 3. Simpan ke SQLite (Status sesuai pembayaran awal)
    const info = db.prepare(`
      INSERT INTO customers (name, phone, pppoe_username, pppoe_password, plan_id, due_date, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(name, phone ? String(phone).trim() : '-', name, password, planId, dueDate || 10, status);

    // Buat tagihan bulan berjalan (status: paid atau unpaid)
    const nowTime = new Date();
    const curPeriodKey = `${nowTime.getFullYear()}-${String(nowTime.getMonth() + 1).padStart(2, '0')}`;
    db.prepare(`
      INSERT INTO bills (customer_id, period, amount, status, paid_at, payment_method)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      info.lastInsertRowid, 
      curPeriodKey,
      planPrice, 
      isPaid ? 'paid' : 'unpaid', 
      isPaid ? new Date().toISOString() : null, 
      isPaid ? 'Manual Kasir' : null
    );

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

// Ambil Status Real-Time Detail dari MikroTik untuk Semua Pelanggan
async function getMikrotikLiveStatus() {
  const config = getRouterConfig();
  if (!config.isConnected || !config.host) {
    return [];
  }
  let apiInstance = null;
  try {
    const { api, client } = await getMikrotikClient(3);
    apiInstance = api;

    const secrets = await client.menu('/ppp secret').get();
    const rawSecrets = await api.rosApi.write(['/ppp/secret/print']);
    const rawMap = new Map(rawSecrets.map(s => [s.name, s]));

    const active = await client.menu('/ppp active').get();
    const activeMap = new Map(active.map(a => [a.name, a]));

    const result = secrets.map(s => {
      const act = activeMap.get(s.name);
      const raw = rawMap.get(s.name) || {};
      let callerIdDisplay = act ? act.callerId : (raw['caller-id'] || s.callerId || '-');
      if (callerIdDisplay && callerIdDisplay !== '-' && typeof callerIdDisplay === 'number') {
        callerIdDisplay = '0' + callerIdDisplay;
      }
      return {
        name: s.name,
        service: s.service,
        profile: s.profile,
        localAddress: s.localAddress || (act ? act.address : '-'),
        remoteAddress: s.remoteAddress || (act ? act.address : '-'),
        callerId: callerIdDisplay,
        uptime: act ? act.uptime : '-',
        disabled: s.disabled === true || s.disabled === 'true',
        isOnline: !!act,
        comment: s.comment || ''
      };
    });

    apiInstance.close();
    return result;
  } catch (err) {
    if (apiInstance) apiInstance.close();
    throw err;
  }
}

// Update Nomor WA Pelanggan (Caller ID di MikroTik)
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

    // Update SQLite
    db.prepare('UPDATE customers SET phone = ? WHERE pppoe_username = ?').run(String(phone).trim(), username);

    apiInstance.close();
    return { success: true };
  } catch (err) {
    if (apiInstance) apiInstance.close();
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

      await api.rosApi.write(['/ppp/secret/set', '=.id=' + target.id, '=comment=' + newComment]);
    }

    // Update SQLite database
    db.prepare('UPDATE customers SET due_date = ? WHERE pppoe_username = ?').run(numDueDate, username);

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

    const rosCmd = ['/ppp/secret/set', '=.id=' + target.id];
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
      params.push(String(phone || '').trim() || '-');
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
          db.prepare("UPDATE bills SET amount = ? WHERE customer_id = ? AND period = ? AND status = 'unpaid'")
            .run(plan.price, cust.id, curPeriod);
        }
      }
    }

    if (updates.length > 0) {
      params.push(username);
      db.prepare(`UPDATE customers SET ${updates.join(', ')} WHERE pppoe_username = ?`).run(...params);
    }

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
  getRouterConfig
};

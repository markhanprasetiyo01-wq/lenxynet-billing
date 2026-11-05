# 🚀 LenxyNet - MikroTik ISP & Billing Management System

Sistem manajemen pelanggan ISP & penagihan billing otomatis terintegrasi dengan Router MikroTik, Portal Pelanggan QRIS, WhatsApp Gateway (Baileys), dan Auto-Backup ke Telegram.

---

## ✨ Fitur Utama

- **🌐 Dashboard Admin Komprehensif**:
  - Manajemen Pelanggan PPPoE (Tambah, Edit, Hapus, Isolir / Buka Isolir instan).
  - Monitoring Trafik & Status Router MikroTik secara real-time.
  - Verifikasi Bukti Pembayaran QRIS dari pelanggan (Setujui / Tolak).
  - Manajemen Paket & Profil Kecepatan Internet.
- **📱 Portal Mandiri Pelanggan (`/user.html`)**:
  - Cek tagihan internet bulanan berdasarkan nomor WhatsApp / username PPPoE.
  - Pembayaran QRIS Dinamis & upload bukti transfer.
  - Notifikasi real-time tanpa perlu refresh halaman saat pembayaran disetujui admin.
- **💬 WhatsApp Gateway Otomatis (Baileys Multi-Device)**:
  - Notifikasi Pembayaran Berhasil langsung ke nomor pelanggan.
  - Pengingat Jatuh Tempo H-3 & Peringatan Isolir H+1 otomatis.
  - Notifikasi instan ke Admin saat ada pelanggan yang mengunggah bukti bayar baru.
- **⏰ Scheduler Otomatis (Cron Job)**:
  - **00:01 WIB**: Auto-Isolir pelanggan yang menunggak melewati masa toleransi.
  - **03:00 WIB**: Auto-Backup Database SQLite ke Telegram & pembersihan berkas bukti transfer lama.
  - **03:05 WIB**: Auto-Backup Full System MikroTik (`.backup` dan `.rsc`) ke Telegram.
  - **08:30 WIB**: Pengiriman otomatis WhatsApp Reminder tagihan pagi hari.
- **🔒 Keamanan & Zero Waste Storage**:
  - Validasi integritas database otomatis (`PRAGMA integrity_check`).
  - Zero-waste storage: Berkas backup sementara di router dan server langsung dihapus setelah terkirim ke Telegram.

---

## 🛠️ Persyaratan Sistem

- **Node.js**: Versi 20.x ke atas (menggunakan engine bawaan `node:sqlite`).
- **MikroTik RouterOS**: v6.x atau v7.x dengan layanan API (`port 8728`) dan FTP (`port 21`) aktif.
- **Platform**: Mendukung Windows, Linux, Armbian (STB / Raspberry Pi / Server).

---

## 🚀 Cara Menjalankan

1. **Clone repositori**:
   ```bash
   git clone <url-repository>
   cd Microtik_Management
   ```

2. **Install dependensi**:
   ```bash
   npm install
   ```

3. **Jalankan server**:
   ```bash
   node server.js
   ```

4. **Akses Dashboard**:
   - **Dashboard Admin**: `http://localhost:3000` (Default: `lenxyadm` / `lenxyadm`)
   - **Portal Pelanggan**: `http://localhost:3000/user.html`

---

## 📄 Lisensi
Hak Cipta © 2026 LenxyNet Management.

# 🚀 LenxyNet - MikroTik ISP & Billing Management System

Sistem manajemen pelanggan ISP & penagihan billing otomatis terintegrasi dengan **Router MikroTik**, **Portal Mandiri Pelanggan QRIS**, **WhatsApp Gateway (Baileys Multi-Device)**, **Cloudflare Zero Trust Tunnel**, dan **Auto-Backup ke Telegram**.

---

## 📑 Daftar Isi
1. [Fitur Utama](#-fitur-utama)
2. [Keunggulan Keamanan & Anti-Hacking](#-keunggulan-keamanan--anti-hacking)
3. [Arsitektur & Persyaratan Sistem](#-arsitektur--persyaratan-sistem)
4. [Panduan Instalasi di PC Windows Baru](#-panduan-instalasi-di-pc-windows-baru)
5. [Panduan Instalasi di STB HG680P (Armbian Linux) 24 Jam Non-Stop](#-panduan-instalasi-di-stb-hg680p-armbian-linux-24-jam-non-stop)
6. [Setup Cloudflare Zero Trust Tunnel (Domain Pribadi)](#-setup-cloudflare-zero-trust-tunnel-domain-pribadi)
7. [Restore & Migrasi Data dari Backup Telegram](#-restore--migrasi-data-dari-backup-telegram)
8. [Pengaturan Dashboard & Koneksi Awal](#-pengaturan-dashboard--koneksi-awal)
9. [Jadwal Otomatis (Cron Job)](#-jadwal-otomatis-cron-job)

---

## ✨ Fitur Utama

- **🌐 Dashboard Admin Lengkap**:
  - Manajemen Pelanggan PPPoE (Tambah, Edit, Hapus, Isolir / Buka Isolir instan).
  - Monitoring Trafik & Status Router MikroTik secara real-time.
  - Verifikasi Bukti Pembayaran QRIS dari pelanggan (Setujui / Tolak tanpa reload halaman).
  - Manajemen Paket & Profil Kecepatan Internet.
- **📱 Portal Mandiri Pelanggan (`/user.html`)**:
  - Cek tagihan internet bulanan berdasarkan nomor WhatsApp atau username PPPoE.
  - Pembayaran QRIS Dinamis & upload bukti transfer.
  - Sinkronisasi real-time via WebSocket/Polling: UI otomatis berubah saat pembayaran disetujui admin.
- **💬 WhatsApp Gateway Otomatis (Baileys Multi-Device)**:
  - Notifikasi pembayaran berhasil terkirim instan ke nomor WhatsApp pelanggan.
  - Pengingat Jatuh Tempo H-3 dan Peringatan Isolir H+1 otomatis setiap pagi.
  - Notifikasi instan ke Admin saat ada pelanggan yang mengunggah bukti bayar baru.
- **⏰ Scheduler Otomatis (Cron Job)**:
  - **00:01 WIB**: Auto-Isolir pelanggan yang menunggak melewati batas toleransi.
  - **03:00 WIB**: Auto-Backup Database SQLite ke Telegram & pembersihan berkas bukti transfer lama.
  - **03:05 WIB**: Auto-Backup Full System MikroTik (`.backup` dan `.rsc` portable) ke Telegram.
  - **08:30 WIB**: Pengiriman otomatis WhatsApp Reminder tagihan pagi hari.
- **🔒 Keamanan & Zero Waste Storage**:
  - Validasi integritas database otomatis sebelum kirim (`PRAGMA integrity_check`).
  - Zero-waste storage: File backup sementara di router dan server langsung dihapus setelah terkirim ke Telegram.

---

## 🛡️ Keunggulan Keamanan & Anti-Hacking

Sistem ini dirancang dengan prinsip **Defense-in-Depth** (keamanan berlapis) untuk menjamin keamanan operasional ISP Anda:

1. **🌐 Zero Open Ports & Proteksi Cloudflare Tunnel**:
   - **Tanpa Port Forwarding**: Router/modem rumah Anda tidak perlu membuka port publik (Port 80, 443, dan 3000 ditutup total dari internet publik).
   - **Penyembunyian IP Asli**: Penyerang tidak bisa melacak atau memindai (*port scanning*) alamat IP publik asli rumah/server Anda.
   - **Perlindungan DDoS & WAF**: Seluruh akses luar disaring oleh jaringan global Cloudflare yang secara otomatis memblokir serangan brute force, bot jahat, dan serangan DDoS.
   - **Enkripsi SSL/TLS Penuh**: Akses via domain resmi (misal `https://emailgratisan.fun`) terenkripsi HTTPS secara otomatis.

2. **💉 100% Kebal Serangan SQL Injection**:
   - Seluruh kueri ke database SQLite menggunakan **Prepared Statements / Parameterized Queries** (`db.prepare('... ?').run(...)`).
   - Karakter input berbahaya tidak akan pernah dieksekusi sebagai perintah SQL, sehingga data pelanggan dan tagihan aman dari peretasan database.

3. **🔑 Kontrol Akses & Sesi Bertingkat (RBAC)**:
   - **Dashboard Admin**: Dilindungi middleware `requireAdminAuth` berbasis token acak berkriptografi tinggi dengan masa kedaluwarsa waktu (*session expiry guard*).
   - **Portal Pelanggan**: Menggunakan verifikasi **OTP WhatsApp**. Pelanggan hanya bisa masuk jika menerima kode di nomor telepon yang sah.
   - **Anti-IDOR (Insecure Direct Object Reference)**: Pelanggan hanya dapat melihat dan melunasi tagihannya sendiri (`WHERE id = ? AND customer_id = userSession.customer_id`). Pelanggan tidak bisa mengintip atau mengubah data pengguna lain.

4. **🚫 Proteksi Server-Side pada Mode Simulasi Bayar Demo**:
   - Fitur simulasi demo tidak hanya disembunyikan di tampilan antarmuka (UI), tetapi **dikunci ketat di level backend / API**.
   - Ketika mode demo dimatikan (`mock_payment_enabled = false`), upaya penembakan endpoint `POST /api/user/pay-qris` secara langsung lewat curl, Postman, atau bot peretas akan langsung ditolak server dengan respon **`403 Forbidden`**.
   - Pengaturan bawaan sistem terkunci secara aman ke status nonaktif (*secure-by-default*).

5. **📁 Keamanan Sanitasi File Upload (Anti-Webshell / Backdoor)**:
   - Sistem upload bukti transfer menggunakan pustaka `multer` dengan validasi ganda:
     - **Filter Ekstensi & MIME-Type Ketat**: Hanya menerima berkas gambar asli (`.jpg`, `.jpeg`, `.png`, `.webp`). Berkas berbahaya seperti script PHP, Shell, Python, atau Executable otomatis diblokir.
     - **Limit Ukuran**: Ukuran berkas dibatasi maksimal 5 MB untuk mencegah serangan pengurasan penyimpanan (*storage exhaustion*).
     - **Random Hash Filename**: Nama berkas diacak ulang menggunakan kriptografi acak saat disimpan untuk mencegah serangan *Directory Traversal*.

6. **🔒 Isolasi Port API MikroTik**:
   - Port API RouterOS (`8728`) hanya dibuka untuk segmen jaringan lokal privat dan hanya dapat dihubungi oleh IP internal server Node.js.
   - Port manajemen router tidak pernah diekspos ke publik internet luar.

7. **💾 Integritas Data & Auto-Backup Terdistribusi**:
   - Database diperiksa integritasnya secara otomatis (`PRAGMA integrity_check`) sebelum dicadangkan.
   - Backup otomatis database SQLite dan skrip konfigurasi MikroTik dikirimkan setiap subuh ke akun Telegram Bot pribadi, menjamin data Anda dapat dipulihkan dalam hitungan menit jika terjadi musibah pada hardware fisik.

---

## 🛠️ Arsitektur & Persyaratan Sistem

- **Node.js**: Versi 20.x atau 22.x LTS ke atas (menggunakan native driver `node:sqlite`).
- **MikroTik RouterOS**: v6.x atau v7.x dengan port **API (8728)** dan **FTP (21)** aktif.
- **Perangkat**:
  - PC Laptop / Desktop (Windows 10/11).
  - STB B860H / HG680P / Raspberry Pi / TV Box (Armbian Server Linux).

---

## 💻 Panduan Instalasi di PC Windows Baru

Jika Anda ingin menjalankan project ini di komputer/laptop Windows yang baru:

### 1. Pasang Software yang Dibutuhkan
1. Download & install **Node.js (LTS)** dari [nodejs.org](https://nodejs.org/).
2. Download & install **Git for Windows** dari [git-scm.com](https://git-scm.com/).

### 2. Download Project dari GitHub
Buka **PowerShell** atau **Terminal**, lalu jalankan:
```bash
cd Documents
git clone https://github.com/markhanprasetiyo01-wq/lenxynet-billing.git
cd lenxynet-billing
```
*(Masukkan kredensial login GitHub Anda jika diminta karena repo bersifat Private)*.

### 3. Install Dependensi Library
```bash
npm install
```

### 4. Pulihkan Database Lama (Opsional)
Jika ingin membawa data pelanggan lama dari Telegram, ikuti [Langkah Restore Database](#-restore--migrasi-data-dari-backup-telegram).

### 5. Jalankan Server
```bash
node server.js
```
Akses di browser:
- **Dashboard Admin**: `http://localhost:3000` (Default: `lenxyadm` / `lenxyadm`)
- **Portal Pelanggan**: `http://localhost:3000/user.html`

---

## 🐧 Panduan Instalasi di STB HG680P (Armbian Linux) 24 Jam Non-Stop

Panduan ini khusus untuk STB HG680P / B860H berbasis **Armbian Server (CLI Tanpa Desktop)** agar server hemat daya, stabil, dan menyala 24 jam non-stop:

### 1. Update Sistem & Install Paket Pendukung
Login ke terminal STB via SSH (menggunakan PuTTY atau terminal):
```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl wget build-essential
```

### 2. Install Node.js 22 LTS di Armbian (Arsitektur ARM64)
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```
Pastikan instalasi sukses dengan mengecek versinya:
```bash
node -v
npm -v
```

### 3. Clone Repositori Project
Masuk ke direktori home (bebas di folder mana saja):
```bash
cd ~
git clone https://github.com/markhanprasetiyo01-wq/lenxynet-billing.git
cd lenxynet-billing
```

### 4. Install Dependensi
```bash
npm install
```

### 5. Pasang PM2 & Konfigurasi Auto-Start (Server Otomatis Hidup Saat STB Nyala / Mati Lampu)
Di Armbian, wajib gunakan **PM2 (Production Process Manager)** agar server:
1. Otomatis berjalan di background 24 jam non-stop (terminal boleh ditutup).
2. Otomatis menyala sendiri begitu STB mendapat aliran listrik / setelah mati lampu.
3. Otomatis me-restart aplikasi jika terjadi error/crash.

Jalankan urutan perintah berikut:
```bash
# 1. Install PM2 secara global
sudo npm install -g pm2

# 2. Masuk ke folder project & daftarkan aplikasi ke PM2
cd ~/lenxynet-billing
pm2 start server.js --name "lenxynet"

# 3. Simpan daftar proses agar PM2 selalu mengingatnya
pm2 save

# 4. Generate perintah auto-start sistem Linux
pm2 startup
```

> [!IMPORTANT]
> **Langkah Kunci Auto-Start:**
> Setelah Anda menjalankan `pm2 startup`, di layar terminal paling bawah akan muncul **1 baris perintah khusus** yang diawali dengan `sudo env PATH=...`.
> 
> **Copy baris perintah yang muncul tersebut, paste ke terminal, lalu tekan Enter.**
> 
> *Contoh baris perintah yang dimunculkan:*
> ```bash
> sudo env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u root --hp /root
> ```

#### 🧪 Cara Menguji Auto-Start:
Restart STB Anda dengan perintah:
```bash
sudo reboot
```
Tunggu 1–2 menit sampai STB booting, lalu buka browser di HP/laptop dan akses `https://emailgratisan.fun` atau `http://IP_STB:3000`. Dashboard langsung bisa diakses tanpa perlu menyentuh terminal lagi!

#### 📋 Perintah Berguna PM2 Sehari-hari:
- **Melihat status & penggunaan CPU/RAM:** `pm2 status`
- **Melihat log live (real-time):** `pm2 logs lenxynet` *(keluar dengan `Ctrl + C`)*
- **Restart server (misal setelah ubah setting):** `pm2 restart lenxynet`
- **Stop server sementara:** `pm2 stop lenxynet`

---

## 🌐 Setup Cloudflare Zero Trust Tunnel (Domain Pribadi)

Karena Anda menggunakan domain pribadi (misal: `emailgratisan.fun`), Anda **TIDAK MEMERLUKAN** file `cloudflared.exe`.

### Langkah Memasang Connector di STB Armbian:

1. Buka browser di PC/HP, login ke [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/).
2. Masuk ke menu **Networks** -> **Tunnels**.
3. Klik Tunnel yang sudah Anda buat sebelumnya (yang mengarah ke domain Anda).
4. Klik tab **"Install and run a connector"**:
   - Pilih OS: **Debian**
   - Pilih Arsitektur: **arm64 64-bit** (sesuai chipset STB HG680P).
5. Cloudflare akan menampilkan **satu baris perintah panjang** yang berisi token otentikasi unik Anda, contohnya:
   ```bash
   curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb && sudo dpkg -i cloudflared.deb && sudo cloudflared service install eyJhIjoiYmE5Mm...TOKEN_ANDA...
   ```
6. **Jalankan Perintah Tersebut di Terminal STB**:
   - Anda bebas menjalankannya di folder mana saja (bahkan di folder default `~`).
   - Perintah tersebut akan otomatis mengunduh, menginstall, dan mendaftarkan Cloudflared sebagai **system service background Linux**.
7. Pastikan konfigurasi **Public Hostname** di Cloudflare Dashboard mengarah ke port lokal STB:
   - **Service Type**: `HTTP`
   - **URL**: `localhost:3000` *(atau `127.0.0.1:3000`)*
8. Selesai! Domain Anda (misal `https://emailgratisan.fun`) kini langsung terhubung ke STB tanpa perlu setting port forwarding di router modem!

---

## 📦 Restore & Migrasi Data dari Backup Telegram

Karena database (`database.sqlite`) dan file bukti transfer sengaja tidak di-commit ke GitHub demi keamanan privasi pelanggan, ikuti langkah ini untuk mengembalikan data lama ke PC/STB baru:

1. Buka aplikasi Telegram di HP atau PC Anda.
2. Masuk ke chat Bot Backup Anda (`@lendatabackup_bot`).
3. Cari pesan **`[AUTO-BACKUP DATABASE LENXYNET]`** terbaru.
4. Download file dokumen yang berekstensi `.sqlite` (contoh: `lenxynet-backup-2026-11-04-1793829746.sqlite`).
5. Ubah nama (Rename) file tersebut menjadi:
   ```text
   database.sqlite
   ```
6. Pindahkan file `database.sqlite` tersebut ke dalam folder project `lenxynet-billing/`.
   - *Jika di STB via SSH:* Anda bisa upload file via **WinSCP** atau **FileZilla** (SFTP port 22).
7. Restart server (`node server.js` atau `pm2 restart lenxynet`).
8. Seluruh data pelanggan, tagihan, paket internet, dan pengaturan bot langsung pulih 100%!

---

## ⚙️ Pengaturan Dashboard & Koneksi Awal

Setelah server berjalan di PC baru / STB:

1. **Akses Dashboard Admin**:
   - Buka browser: `http://IP_STB_ANDA:3000` (contoh: `http://192.168.55.254:3000`).
   - Login dengan username `lenxyadm` dan password `lenxyadm`.
2. **Koneksi WhatsApp (Baileys Multi-Device)**:
   - Dashboard akan menampilkan QR Code WhatsApp.
   - Buka WhatsApp di HP Anda -> Titik Tiga Kanan Atas -> **Perangkat Tertaut** -> **Tautkan Perangkat** -> Scan QR code.
   - Status akan otomatis berubah menjadi **Terhubung** (indikator hijau).
3. **Koneksi Router MikroTik**:
   - Klik tombol **Pengaturan Router** (icon gear router di header dashboard).
   - Masukkan IP Router (misal `192.168.55.1`), port API (`8728`), username router (`admin`), dan password.
   - Klik **Simpan & Hubungkan**.
4. **Domain Publik untuk Notifikasi WA Pelanggan**:
   - Masuk ke Tab **Pengaturan** di dashboard.
   - Pada kolom **Public Portal URL (Domain Luar)**, isi domain Cloudflare Anda:
     ```text
     https://emailgratisan.fun
     ```
   - Klik **Simpan Pengaturan**. Sekarang tautan cek tagihan dan bayar QRIS yang dikirimkan via WhatsApp ke pelanggan otomatis menggunakan domain resmi Anda!

---

## ⏰ Jadwal Otomatis (Cron Job)

Sistem sudah dilengkapi dengan scheduler otomatis di [`cron.js`](cron.js):

| Jam (WIB) | Fungsi Otomatis | Keterangan |
| :--- | :--- | :--- |
| **00:01** | **Auto-Isolir Pelanggan** | Mematikan secret PPPoE pelanggan yang jatuh tempo melewati toleransi hari. |
| **03:00** | **Auto-Backup Database** | Snapshot SQLite aman (`VACUUM INTO`) + kirim file `.sqlite` ke Telegram. |
| **03:00** | **Clean Bukti Usang** | Membersihkan foto bukti transfer lunas yang berusia > 60 hari dari disk. |
| **03:05** | **Auto-Backup MikroTik** | Mengirimkan 2 file ke Telegram: Full System (`.backup`) dan Portable Script (`.rsc`). |
| **08:30** | **WhatsApp Reminder** | Mengirimkan notifikasi tagihan H-3 jatuh tempo dan peringatan isolir H+1. |

---

## 📄 Lisensi & Hak Cipta
Hak Cipta © 2026 **LenxyNet Management**. Dikelola secara mandiri oleh `markhanprasetiyo01-wq`.

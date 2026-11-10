# 🚀 LenxyNet - MikroTik ISP & Billing Management System

Sistem manajemen pelanggan ISP & penagihan billing otomatis terintegrasi dengan **Router MikroTik RouterOS**, **Portal Mandiri Pelanggan QRIS**, **WhatsApp Gateway (Baileys Multi-Device)**, **Cloudflare Zero Trust Tunnel**, dan **Auto-Backup ke Telegram**.

---

## 📑 Daftar Isi
1. [Fitur Utama & Pembaruan](#-fitur-utama--pembaruan)
2. [Arsitektur Jaringan & IP Pool PPPoE (Standar 2.000++ User)](#-arsitektur-jaringan--ip-pool-pppoe-standar-2000-user)
3. [Panduan Lengkap Setup STB Fiberhome HG680P Sebagai Server 24 Jam](#-panduan-lengkap-setup-stb-fiberhome-hg680p-sebagai-server-24-jam)
   - [A. Persiapan Bahan & OS Armbian](#a-persiapan-bahan--os-armbian)
   - [B. Flashing OS ke MicroSD & Konfigurasi DTB](#b-flashing-os-ke-microsd--konfigurasi-dtb)
   - [C. Booting Awal & Login SSH STB](#c-booting-awal--login-ssh-stb)
   - [D. Pindahkan OS ke Memori Internal eMMC (Opsional tapi Sangat Direkomendasikan)](#d-pindahkan-os-ke-memori-internal-emmc)
   - [E. Instalasi Node.js & Dependency di Armbian Linux](#e-instalasi-nodejs--dependency-di-armbian-linux)
   - [F. Deploy Aplikasi LenxyNet & Konfigurasi Auto-Start PM2](#f-deploy-aplikasi-lenxynet--konfigurasi-auto-start-pm2)
   - [G. Pasang Cloudflare Tunnel ARM64 (Domain https://lenxynet.store)](#g-pasang-cloudflare-tunnel-arm64)
4. [Panduan Instalasi di PC Windows Baru (Alternatif)](#-panduan-instalasi-di-pc-windows-baru-alternatif)
5. [Restore & Migrasi Data dari Backup Telegram](#-restore--migrasi-data-dari-backup-telegram)
6. [Jadwal Otomatis Cron Job & Fitur Toggle ON / OFF](#-jadwal-otomatis-cron-job--fitur-toggle-on--off)
7. [Editor Massal 394 Pelanggan (`/editor.html`)](#-editor-massal-394-pelanggan-editorhtml)

---

## ✨ Fitur Utama & Pembaruan

- **🌐 Dashboard Admin Modern & Ramping**:
  - **Navbar Responsif**: Tombol pengaturan dirampingkan ke dalam **Dropdown Pengaturan** (*Koneksi MikroTik, QRIS & WA Admin, Integrasi Telegram, Template WhatsApp, Editor Massal, dan Portal Pelanggan*) sehingga tidak penuh dan tidak meluber di layar laptop/tablet.
  - **Paginasi Cerdas 50 Pelanggan/Halaman**: List pelanggan PPPoE dibagi rapi maksimal 50 user per halaman, berpindah halaman **secara instan (0ms), bebas reload halaman, dan anti-blink**.
  - **100% Pembayaran Nyata**: Mode simulasi demo telah dihapus total. Sistem murni memproses konfirmasi transfer asli dengan bukti foto transfer yang diverifikasi admin.
- **📱 Portal Mandiri Pelanggan (`https://lenxynet.store/user.html`)**:
  - Cek tagihan internet bulanan berdasarkan nomor WhatsApp atau username PPPoE.
  - Pembayaran QRIS Dinamis & upload bukti transfer.
  - Sinkronisasi real-time via WebSocket/Polling: UI otomatis berubah saat pembayaran disetujui admin.
- **💬 WhatsApp Gateway Otomatis (Baileys Multi-Device)**:
  - Notifikasi pembayaran berhasil terkirim instan ke nomor WhatsApp pelanggan.
  - Pengingat Jatuh Tempo H-3 dan Peringatan Isolir H+1 otomatis setiap pagi jam 08:30 WIB.
  - Notifikasi instan ke Admin saat ada pelanggan yang mengunggah bukti bayar baru.
- **⏰ Scheduler Otomatis (Cron Job) + Toggle Switch ON/OFF**:
  - Dilengkapi tombol switch **Toggle Cron Job** di 3 tempat (Kartu Toleransi Dashboard, Dropdown Pengaturan, dan Drawer Mobile) untuk menjeda atau mengaktifkan otomatisasi sewaktu-waktu.
  - **00:01 WIB**: Auto-Isolir pelanggan menunggak lewat toleransi + putus sesi aktif router seketika.
  - **03:00 WIB**: Auto-Backup Database SQLite ke Telegram + pembersihan bukti transfer lama (> 60 hari).
  - **03:05 WIB**: Auto-Backup Full System MikroTik (`.backup` dan `.rsc` portable) ke Telegram.
  - **08:30 WIB**: Pengiriman otomatis WhatsApp Reminder tagihan pagi hari.
- **🔒 Keamanan Zero Open Ports**:
  - Seluruh akses publik luar dilindungi oleh **Cloudflare Zero Trust Tunnel** (`https://lenxynet.store`).
  - Port lokal 3000 dan port API MikroTik 8728 tidak pernah dibuka ke publik internet luar.

---

## 🌐 Arsitektur Jaringan & IP Pool PPPoE (Standar 2.000++ User)

Sistem menggunakan konfigurasi IP Pool Kelas A profesional untuk menampung skala ribuan pelanggan tanpa tabrakan IP:
- **Subnet PPPoE**: `10.10.0.0/21` (Netmask: `255.255.248.0`)
- **Gateway MikroTik (Local Address)**: `10.10.0.1`
- **Rentang IP Pelanggan (`pool-pppoe`)**: `10.10.0.2 - 10.10.7.254` (**Kapasitas: 2.046 IP Pelanggan**)
- **NAT Masquerade**: `chain=srcnat action=masquerade out-interface=ether1-ISP` (Otomatis mencakup semua IP pelanggan).
- **Remote Router Pelanggan**: Remote Web Management router modem pelanggan (seperti TP-Link TL-WR820N) diakses via IP PPPoE port **80** (contoh: `http://10.10.7.254`) langsung dari jaringan kantor/server tanpa harus datang ke rumah pelanggan.

---

## 🐧 Panduan Lengkap Setup STB Fiberhome HG680P Sebagai Server 24 Jam

STB **Fiberhome HG680P** (RAM 2 GB, SoC Amlogic S905X) adalah pilihan terbaik untuk menjalankan server ini non-stop 24 jam dengan konsumsi daya sangat rendah (**~4 Watt** / biaya listrik hanya ~Rp 5.000 - Rp 10.000 per bulan).

```
[ Router MikroTik ]
        │ (Kabel LAN)
        ▼
[ STB HG680P (Armbian Linux) ] ──> Menjalankan Node.js + Billing Server 24 Jam
```

### A. Persiapan Bahan & OS Armbian
1. **1 unit STB Fiberhome HG680P** + adaptor daya 12V 1A.
2. **1 unit MicroSD** (Kapasitas minimal 16 GB atau 32 GB, disarankan Class 10 / SanDisk Ultra).
3. **Card Reader** USB.
4. **Software di PC:** [BalenaEtcher](https://etcher.balena.io/) atau [Rufus](https://rufus.ie/).
5. **File Image OS:** Unduh image **Armbian Linux Amlogic S905X** (Pilih varian *Debian Bookworm/Bullseye Server* atau *Ubuntu Jammy Server* tanpa desktop GUI).

---

### B. Flashing OS ke MicroSD & Konfigurasi DTB
1. Tancapkan MicroSD ke PC menggunakan Card Reader.
2. Buka BalenaEtcher atau Rufus, pilih file image Armbian (`.img` atau `.img.xz`), pilih drive MicroSD, lalu klik **Flash**.
3. Setelah proses flash selesai, buka partisi bernama **`BOOT`** di Windows Explorer:
4. Cari file bernama **`uEnv.txt`** (atau `extlinux/extlinux.conf`), buka dengan Notepad.
5. Pastikan baris FDT mengarah ke DTB board HG680P:
   ```text
   FDT=/dtb/amlogic/meson-gxl-s905x-p212.dtb
   ```
6. Simpan file, lalu cabut MicroSD secara aman (*Eject*).

---

### C. Booting Awal & Login SSH STB
1. Masukkan MicroSD ke slot kartu memori STB HG680P.
2. Hubungkan kabel LAN dari port LAN STB ke salah satu port LAN **MikroTik** (misal ether2).
3. Nyalakan STB.
4. Buka Winbox di menu **IP -> DHCP Server -> Leases** atau **IP -> ARP**:
   - Cari perangkat dengan nama `armbian` dan catat alamat IP yang didapat (contoh: `192.168.55.200`).
5. Buka **PowerShell** atau **PuTTY** di PC/Laptop Anda, lalu remote STB via SSH:
   ```bash
   ssh root@192.168.55.200
   ```
6. **Password default:** `1234`
7. Sistem akan meminta Anda memasukkan password baru dan membuat user baru (lewati pembuatan user biasa dengan menekan `Ctrl + C` jika ingin tetap memakai user `root`).

---

### D. Pindahkan OS ke Memori Internal eMMC
*(Sangat disarankan agar MicroSD bisa dicabut dan STB bisa hidup mandiri tanpa kartu memori)*:
1. Di terminal SSH STB, jalankan perintah:
   ```bash
   armbian-install
   ```
2. Pilih nomor tipe SoC: **Amlogic S905X (p212)**.
3. Pilih tipe partisi: **ext4**.
4. Tunggu hingga proses penyalinan selesai 100%.
5. Matikan STB dengan perintah `poweroff`, cabut kabel daya, cabut MicroSD dari slot, lalu hidupkan kembali STB. STB sekarang sudah menjadi server Linux murni!

---

### E. Instalasi Node.js 22+ & Konfigurasi STB Armbian Linux
> [!IMPORTANT]
> Aplikasi ini menggunakan modul bawaan `node:sqlite` sehingga **WAJIB memakai Node.js v22.13+ / v24 LTS** (JANGAN pakai Node v20).

Jalankan rentetan perintah berikut di terminal SSH STB:

```bash
# 1. Set Zona Waktu Indonesia (WIB) agar jadwal Cron Job & Log akurat
timedatectl set-timezone Asia/Jakarta

# 2. Update paket sistem Linux
apt update && apt upgrade -y

# 3. Pasang Git, Curl, dan Build Tools
apt install -y git curl wget build-essential

# 4. Pasang Node.js v22 LTS (ARM64 - Wajib v22+ untuk node:sqlite)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# 5. Verifikasi instalasi Node.js (Pastikan muncul v22.x.x atau lebih baru)
node -v
npm -v

# 6. Pasang PM2 + Auto-Rotate Log (Mencegah file log memenuhi eMMC STB)
npm install -g pm2
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 5
```

---

### F. Deploy Aplikasi LenxyNet & Konfigurasi Auto-Start PM2

1. **Clone Repositori Project ke Folder `/var/www/`:**
   ```bash
   mkdir -p /var/www
   cd /var/www
   git clone https://github.com/markhanprasetiyo01-wq/lenxynet-billing.git lenxynet
   cd lenxynet
   ```

2. **Pasang Library Dependensi:**
   ```bash
   npm install --no-audit --no-fund
   ```

3. **Salin Database SQLite Lama (Disarankan via Download Backup di Dashboard Admin):**
   - Klik **Download Backup DB** dari Dashboard Admin lama (atau ambil snapshot terbaru dari Telegram Backup), lalu upload ke `/var/www/lenxynet/database.sqlite` via **WinSCP**.
   - *(Jika menyalin manual langsung dari folder PC lama saat server aktif, hentikan dulu `server.js` di PC atau salin bersama `database.sqlite-wal` dan `database.sqlite-shm` agar transaksi terakhir tidak hilang).*

4. **Jalankan Aplikasi dengan PM2 (Dengan Batas Memori Aman STB 2GB RAM):**
   ```bash
   pm2 start server.js --name "lenxynet" --max-memory-restart 500M --node-args="--max-old-space-size=512"
   ```

5. **Kunci Auto-Start Saat STB Menyala / Setelah Mati Lampu:**
   ```bash
   pm2 save
   pm2 startup
   ```
   *Salin dan jalankan perintah `sudo env PATH=...` yang dimunculkan oleh PM2 di layar Anda.*

---

### G. Pasang Cloudflare Tunnel ARM64 (Domain https://lenxynet.store)
Agar domain Anda aktif 24 jam langsung dari STB tanpa perlu komputer menyala:

1. Di terminal SSH STB, unduh binary resmi Cloudflared versi ARM64:
   ```bash
   curl -L --output /usr/local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64
   chmod +x /usr/local/bin/cloudflared
   ```
2. Pasang Service Tunnel dengan token Cloudflare Anda:
   ```bash
   cloudflared service install <TOKEN_CLOUDFLARE_ANDA>
   ```
3. Mulai service:
   ```bash
   systemctl start cloudflared
   systemctl enable cloudflared
   ```
4. Buka **https://lenxynet.store** di browser HP/PC — Server billing kini aktif online 24 jam non-stop dari STB!

---

## 💻 Panduan Instalasi di PC Windows Baru (Alternatif)

Jika Anda ingin menjalankan project ini di komputer/laptop Windows:
1. Pasang **Node.js LTS** dari [nodejs.org](https://nodejs.org/).
2. Pasang **Git for Windows** dari [git-scm.com](https://git-scm.com/).
3. Buka PowerShell dan clone repositori:
   ```powershell
   git clone https://github.com/markhanprasetiyo01-wq/lenxynet-billing.git
   cd lenxynet-billing
   npm install
   node server.js
   ```

---

## 📦 Restore & Migrasi Data dari Backup Telegram

1. Buka aplikasi Telegram, masuk ke chat Bot Backup Anda (`@lendatabackup_bot`).
2. Unduh file `.sqlite` terbaru (misal: `lenxynet-backup-YYYY-MM-DD.sqlite`).
3. Ubah nama (*rename*) menjadi **`database.sqlite`**.
4. Letakkan file `database.sqlite` ke dalam direktori project.
5. Restart server (`pm2 restart lenxynet` atau `node server.js`). Seluruh data pelanggan dan tagihan langsung pulih 100%!

---

## ⏰ Jadwal Otomatis Cron Job & Fitur Toggle ON / OFF

Sistem menjalankan jadwal otomatis di latar belakang yang dikelola oleh [`cron.js`](cron.js):

| Jam (WIB) | Fungsi Otomatis | Pengaruh Toggle Cron |
| :--- | :--- | :--- |
| **00:01** | **Auto-Isolir Pelanggan** (Memutus secret PPPoE & kick active session bagi yang lewat batas jatuh tempo + toleransi). | **Dijeda jika Toggle OFF** |
| **08:30** | **WhatsApp Reminder Pagi** (Notifikasi tagihan H-3 sebelum jatuh tempo & peringatan isolir H+1). | **Dijeda jika Toggle OFF** |
| **03:00** | **Pembersihan Disk Storage** (Menghapus bukti transfer lunas > 60 hari & file orphan tak terdaftar). | Tetap Berjalan |
| **03:00** | **Cloud Backup Database SQLite** (Kirim file snapshot aman ke bot Telegram). | Tetap Berjalan |
| **03:05** | **Cloud Backup MikroTik** (Ekspor `.backup` & `.rsc` portable dan kirim ke Telegram). | Tetap Berjalan |

> [!TIP]
> **Di mana Toggle Cron Job Berada?**
> Toggle switch ON/OFF dapat ditemukan di:
> 1. Kartu **Toleransi Isolir** di halaman utama dashboard.
> 2. Menu **Dropdown Pengaturan** di header atas desktop.
> 3. Menu drawer navigasi mobile/tablet.

---

## 📝 Editor Massal 394 Pelanggan (`/editor.html`)

Tersedia spreadsheet online bawaan di `https://lenxynet.store/editor.html` untuk mengedit tanggal jatuh tempo dan nomor WhatsApp seluruh 394 pelanggan secara cepat:
- **Pencarian Real-Time**: Cari username atau nama paket instan.
- **Unduh Excel**: Ekspor data ke format `.csv` siap buka di Microsoft Excel.
- **1-Click Winbox Script Generator**: Tombol **"Buat Script Winbox (.rsc)"** menghasilkan perintah RouterOS siap paste ke *New Terminal* MikroTik untuk memperbarui komentar jatuh tempo dan nomor HP secara massal dalam hitungan detik.

---

## 📄 Lisensi & Hak Cipta
Hak Cipta © 2026 **LenxyNet Billing & Management System**. Dikelola secara mandiri oleh `markhanprasetiyo01-wq`.

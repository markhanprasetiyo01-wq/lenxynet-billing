# 🚀 LenxyNet — Sistem Billing & Manajemen ISP MikroTik

Aplikasi manajemen pelanggan internet (PPPoE) dan penagihan otomatis untuk **Router MikroTik**, dilengkapi **Portal Pelanggan QRIS**, **Bot WhatsApp Otomatis**, **Auto-Isolir**, **Cloudflare Tunnel**, dan **Backup Telegram**.

---

## ✨ Fitur Utama

* **Sinkronisasi Otomatis MikroTik:** Baca paket, harga (dari *comment* profile), status online/offline, isolir, dan buka isolir langsung ke RouterOS.
* **Portal Pelanggan QRIS (`https://lenxynet.store/user.html`):** Pelanggan login pakai OTP WhatsApp, bayar 1 bulan atau multi-bulan (2, 3, 6, 12 bulan sekaligus), dan upload bukti transfer asli untuk diverifikasi Admin.
* **Bot WhatsApp Otomatis:** Kirim OTP login, tagihan H-3 sebelum jatuh tempo, peringatan H+1, struk lunas, info bukti masuk ke Admin, dan broadcast massal.
* **Auto-Isolir & Toleransi Lintas Bulan:** Otomatis memutus koneksi PPPoE jika menunggak melewati masa toleransi (akurat untuk tanggal jatuh tempo 1–31, termasuk bulan Februari 28/29 hari).
* **Backup Otomatis ke Telegram:** Backup database SQLite dan konfigurasi MikroTik (`.backup` & `.rsc`) otomatis setiap dini hari.

---

## 🐧 Panduan Setup STB HG680P Sebagai Server 24 Jam

STB **Fiberhome HG680P** (RAM 2 GB, daya hanya ~4 Watt) sangat cocok jadi server 24 jam pengganti PC Windows. Ikuti **6 langkah urut** di bawah ini:

```text
[ Router MikroTik ] ─── Kabel LAN ───► [ STB HG680P (Armbian) ] ───► Online 24 Jam via Cloudflare
```

### Langkah 1: Siapkan MicroSD Armbian
1. Siapkan **MicroSD min. 16 GB**, Card Reader, dan download image **Armbian Linux Amlogic S905X** (pilih varian **Debian Server** atau **Ubuntu Server** tanpa GUI).
2. Flash image ke MicroSD pakai [BalenaEtcher](https://etcher.balena.io/) atau [Rufus](https://rufus.ie/).
3. Buka partisi **`BOOT`** di Windows Explorer, buka file **`uEnv.txt`** (atau `extlinux/extlinux.conf`) pakai Notepad, lalu pastikan baris `FDT` tertulis:
   ```text
   FDT=/dtb/amlogic/meson-gxl-s905x-p212.dtb
   ```
4. Simpan file, lalu *Eject* MicroSD dengan aman.

---

### Langkah 2: Nyalakan STB, Login SSH & Pindah ke Memori Internal
1. Masukkan MicroSD ke STB, colok **kabel LAN dari MikroTik ke STB**, lalu nyalakan STB.
2. Cek IP STB di Winbox (**IP $\rightarrow$ DHCP Server $\rightarrow$ Leases** atau **IP $\rightarrow$ ARP**), cari nama `armbian` (misal dapat IP `192.168.55.200`).
3. Buka PowerShell di PC lalu masuk ke STB:
   ```bash
   ssh root@192.168.55.200
   ```
   * **Password awal:** `1234` *(lalu buat password baru; saat diminta buat user tambahan, tekan `Ctrl + C` saja jika ingin tetap pakai `root`)*.
4. Pindahkan OS ke memori internal STB (**eMMC**) agar MicroSD bisa dicabut:
   ```bash
   armbian-install
   ```
   * Pilih tipe SoC: **Amlogic S905X (p212)** $\rightarrow$ Pilih partisi: **ext4**.
   * Setelah selesai 100%, ketik `poweroff`, cabut adaptor, **cabut MicroSD**, lalu nyalakan STB lagi.

---

### Langkah 3: Install Node.js 22 & PM2 di STB
> [!IMPORTANT]
> Aplikasi wajib memakai **Node.js versi 22 ke atas** (jangan versi 20) agar database bawaan `node:sqlite` bisa berjalan.

Login SSH ke STB lagi, lalu **copy-paste** seluruh perintah di bawah ini sekaligus:

```bash
timedatectl set-timezone Asia/Jakarta
apt update && apt upgrade -y
apt install -y git curl wget build-essential
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
node -v
npm install -g pm2
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 5
```
*(Pastikan hasil `node -v` menunjukkan `v22.x.x` atau lebih baru).*

---

### Langkah 4: Pasang & Jalankan Aplikasi LenxyNet
1. Unduh aplikasi dari GitHub dan install paketnya:
   ```bash
   mkdir -p /var/www && cd /var/www
   git clone https://github.com/markhanprasetiyo01-wq/lenxynet-billing.git lenxynet
   cd lenxynet
   npm install --no-audit --no-fund
   ```
2. **Pindahkan Data Lama:**
   * Dari Dashboard Admin lama (atau Telegram Backup), klik **Download Backup DB**, ubah namanya menjadi **`database.sqlite`**.
   * Upload ke folder `/var/www/lenxynet/database.sqlite` di STB memakai **WinSCP**.
3. **Jalankan Aplikasi 24 Jam + Auto-Start Saat Mati Lampu:**
   ```bash
   pm2 start server.js --name "lenxynet" --max-memory-restart 500M --node-args="--max-old-space-size=512"
   pm2 save
   pm2 startup
   ```
   *(Jika `pm2 startup` memunculkan baris perintah `sudo env PATH=...`, copy & jalankan baris tersebut satu kali).*

---

### Langkah 5: Hubungkan Domain (`https://lenxynet.store`) via Cloudflare
Tidak perlu setting IP Publik atau buka port di MikroTik—cukup pakai cara **2 Kotak** dari Cloudflare:

1. Buka [Dashboard Cloudflare](https://dash.cloudflare.com/) $\rightarrow$ **Networking** $\rightarrow$ **Tunnels** $\rightarrow$ klik tunnel **LenxyNet**.
2. Di tab **Routes**, pastikan tujuan `lenxynet.store` mengarah ke **`http://localhost:3000`**.
3. Kembali ke tab **Overview**, klik tombol **`+ Add a replica`**.
4. Pilih OS **`Debian`** dan Architecture **`arm64`**.
5. **Copy-Paste ke terminal SSH STB:**
   * Klik **Copy** pada **Kotak 1 (`Install cloudflared`)** $\rightarrow$ paste di STB lalu Enter *(otomatis menginstall cloudflared ARM64)*.
   * Klik **Copy** pada **Kotak 2 (`Install as service`)** $\rightarrow$ paste di STB lalu Enter *(otomatis menyalakan tunnel 24 jam)*.
6. Cek status tunnel di STB:
   ```bash
   systemctl status cloudflared
   ```
   * Jika muncul **`active (running)`**, buka **`https://lenxynet.store`** di HP/PC!
   * **Terakhir:** Matikan `Cloudflared` di PC Windows lama (`cloudflared service uninstall` via PowerShell Administrator) supaya hanya STB yang aktif melayani domain.

---

### Langkah 6: Scan WhatsApp Bot
Buka `https://lenxynet.store`, login ke Dashboard Admin, buka menu **WhatsApp**, lalu scan QR Code sekali menggunakan HP WhatsApp toko/admin. **Selesai!**

---

## 🛠️ Perintah Harian & Cara Update Aplikasi di STB

| Keperluan | Perintah di Terminal SSH STB |
| :--- | :--- |
| **Cek status aplikasi** | `pm2 status` |
| **Lihat log aktivitas & error** | `pm2 logs lenxynet --lines 50` |
| **Restart aplikasi** | `pm2 restart lenxynet` |
| **Update versi terbaru dari GitHub** | `cd /var/www/lenxynet && git pull && npm install --no-audit --no-fund && pm2 restart lenxynet` |
| **Cek status Cloudflare Tunnel** | `systemctl status cloudflared` |

---

## ⏰ Jadwal Otomatis (Cron Job WIB)

Bisa diaktifkan / dijeda kapan saja lewat tombol saklar **Toggle Cron Job (ON/OFF)** di Dashboard Admin:

| Jam (WIB) | Tugas Otomatis | Pengaruh Toggle ON/OFF |
| :--- | :--- | :--- |
| **00:01** | **Auto-Isolir** (Memutus PPPoE yang lewat jatuh tempo + toleransi). *Tidak kirim WA.* | **Berhenti jika OFF** |
| **08:30** | **Kirim WA Reminder** (Tagihan H-3 & Peringatan H+1, max 1x/hari + jeda aman). | **Berhenti jika OFF** |
| **03:00** | **Perawatan & Backup DB:** Hapus foto lama (>60 hari), sesi usang, & kirim DB ke Telegram. | Tetap berjalan |
| **03:05** | **Backup MikroTik:** Ekspor `.backup` & `.rsc` lalu kirim ke Telegram. | Tetap berjalan |

---

## 📦 Cara Restore Jika STB Rusak / Pindah Mesin
1. Ambil file `.sqlite` terbaru dari **Bot Telegram Backup** (`@lendatabackup_bot`).
2. Ubah nama file menjadi **`database.sqlite`** dan letakkan di folder project.
3. Jalankan `pm2 restart lenxynet`. Seluruh data pelanggan, tagihan, dan riwayat pembayaran langsung pulih 100%.

---

## 🌐 Info Standar IP Pool PPPoE & Alternatif PC Windows

* **IP Pool PPPoE:** Subnet `10.10.0.0/21` (Gateway `10.10.0.1`, rentang IP pelanggan `10.10.0.2 - 10.10.7.254` untuk **2.046 user**). Remote modem router pelanggan diakses via IP PPPoE port `80`.
* **Editor Massal (`/editor.html`):** Spreadsheet online terproteksi login Admin untuk edit jatuh tempo / export script Winbox `.rsc`.
* **Alternatif PC Windows Baru:** Install [Node.js v22+ LTS](https://nodejs.org/) & [Git](https://git-scm.com/), lalu jalankan di PowerShell:
  ```powershell
  git clone https://github.com/markhanprasetiyo01-wq/lenxynet-billing.git
  cd lenxynet-billing
  npm install
  node server.js
  ```

---
Hak Cipta © 2026 **LenxyNet Billing & Management System** — `markhanprasetiyo01-wq`

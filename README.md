# 🚀 LenxyNet — Sistem Billing & Manajemen ISP MikroTik

Aplikasi manajemen pelanggan internet (PPPoE) dan penagihan otomatis untuk **Router MikroTik**, dilengkapi **Portal Pelanggan QRIS**, **Bot WhatsApp Otomatis**, **Auto-Isolir**, **Cloudflare Tunnel**, dan **Backup Telegram**.

---

## ✨ Fitur Utama

* **Sinkronisasi Otomatis MikroTik:** Baca paket, harga (dari *comment* profile), status online/offline, isolir, dan buka isolir langsung ke RouterOS.
* **Filter Pelanggan Lengkap & Kolom Alamat:** Cari nama/PPPoE/WA/alamat serta filter kombinasi **Tagihan**, **Status Akun**, **Paket**, dan **Koneksi Live (Online / Offline)**, dilengkapi ekspor CSV (termasuk alamat & koordinat).
* **Peta Titik Lokasi Pelanggan (`Peta Lokasi`):** Lihat semua rumah pelanggan di peta (*Peta Jalan* & *Satelit*) dengan pin warna real-time (*Hijau Online*, *Kuning Offline*, *Merah Isolir*), tombol **Rute Maps**, serta dukungan paste **Share Lokasi WhatsApp**, shortlink `maps.app.goo.gl`, Google Maps, Apple Maps, OSM, Waze, maupun koordinat manual.
* **Portal Pelanggan QRIS (`https://lenxynet.store/user.html`):** Pelanggan login lewat nomor WhatsApp dengan opsi toggle di Dashboard Admin (**Wajib OTP WA** atau **Langsung Tanpa OTP** selama nomor WA terdaftar), bayar 1 bulan atau multi-bulan (2, 3, 6, 12 bulan sekaligus), dan upload bukti transfer asli untuk diverifikasi Admin.
* **Bot WhatsApp Otomatis:** Kirim OTP login, tagihan H-3 sebelum jatuh tempo, peringatan H+1, struk lunas, info bukti masuk ke Admin, dan broadcast massal.
* **Auto-Isolir & Toleransi Lintas Bulan:** Otomatis memutus koneksi PPPoE jika menunggak melewati masa toleransi (akurat untuk tanggal jatuh tempo 1–31, termasuk bulan Februari 28/29 hari).
* **Backup Otomatis ke Telegram:** Backup database SQLite dan konfigurasi MikroTik (`.backup` & `.rsc`) otomatis setiap dini hari.

---

## 💻 Panduan Menjalankan di PC Linux Server (24 Jam)

Untuk PC/Mini PC khusus server, gunakan **Linux versi CLI saja (tanpa Desktop/GUI)** agar lebih ringan, stabil 24/7, dan minim hang. Semua kontrol aplikasi tetap lewat browser (`http://<IP-Server>:3000` atau `https://lenxynet.store`), dan WhatsApp Bot (`@whiskeysockets/baileys`) berjalan murni tanpa browser/Chrome.

### Rekomendasi OS Linux
* **Ubuntu Server 24.04 LTS (CLI)** — *Pilihan utama:* paling ramah, dukungan driver LAN/hardware luas, dan instalasi Node.js/Cloudflared sangat mudah. Saat install, centang **Install OpenSSH server**.
* **Debian 12 (Bookworm) CLI** — *Pilihan hemat RAM:* cocok untuk PC spek pas-pasan (RAM 2–4 GB); saat instalasi hilangkan centang *Debian desktop environment* dan sisakan **SSH server** + **standard system utilities**.
* *(Jika PC tetap dipakai kerja harian memakai monitor/mouse, gunakan desktop ringan seperti **Linux Mint XFCE** atau **Xubuntu 24.04 LTS** — perintah di bawah tetap sama).*

### Langkah 1: Siapkan Timezone WIB, Node.js 22+ & PM2
> [!IMPORTANT]
> Aplikasi wajib memakai **Node.js `>= 22.13.0`** agar modul SQLite bawaan (`node:sqlite`) berjalan. Jangan gunakan Node.js bawaan `apt` jika masih versi 18/20.

Login ke server via terminal atau SSH (`ssh user@<IP-SERVER>`), lalu jalankan:
```bash
# Set timezone ke WIB (penting untuk jadwal Cron 00:01 & 08:30)
sudo timedatectl set-timezone Asia/Jakarta

# Update sistem & instal alat dasar
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git netcat-openbsd

# Instal Node.js 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v

# Instal PM2 untuk auto-run 24/7 & auto-rotate log
sudo npm install -g pm2
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 5
```

### Langkah 2: Ambil Source Code & Instal Dependensi
```bash
sudo mkdir -p /var/www && sudo chown -R $USER:$USER /var/www
cd /var/www
git clone https://github.com/markhanprasetiyo01-wq/lenxynet-billing.git lenxynet
cd lenxynet
npm install --omit=dev
```
*(Jangan menyalin `node_modules/` atau `cloudflared.exe` dari Windows ke Linux).*

### Langkah 3: Pindahkan Data dari PC Windows ke Linux
Karena data lokal tidak di-upload ke GitHub (lihat `.gitignore`), salin data berikut jika tidak ingin mulai dari nol:
1. **Di PC Windows**, hentikan dulu `node server.js` (`Ctrl+C`) agar file `database.sqlite-wal` dan `database.sqlite-shm` tersimpan utuh ke `database.sqlite`.
2. Salin ke folder `/var/www/lenxynet/` di Linux (pakai `scp`, WinSCP, atau flashdisk):
   * `database.sqlite` *(wajib agar seluruh pelanggan, tagihan, & pengaturan ikut pindah)*
   * `public/uploads/` *(gambar QRIS toko & bukti transfer yang masih tersimpan lokal)*
   * `wa_session/` *(opsional — jika disalin, bot WA langsung aktif tanpa scan QR ulang)*
   * `backups/` *(opsional)*

### Langkah 4: Jalankan Otomatis 24/7 dengan PM2
```bash
cd /var/www/lenxynet
pm2 start server.js --name lenxynet
pm2 save
pm2 startup
```
* Jika `pm2 startup` menampilkan perintah `sudo env PATH=...`, copy & jalankan baris tersebut satu kali agar aplikasi otomatis hidup setelah mati lampu/reboot.
* **Firewall & Port:** Saat dijalankan sebagai user biasa, port **`3000`** langsung aktif (port `80` dilewati otomatis dan aman). Jika UFW firewall aktif dan ingin diakses dari jaringan LAN:
  ```bash
  sudo ufw allow 3000/tcp
  ```

### Langkah 5: Pindahkan Cloudflare Tunnel (`https://lenxynet.store`) ke Linux
> [!WARNING]
> Pastikan service `Cloudflared` di **PC Windows lama dimatikan/di-uninstall** sebelum atau sesudah pindah (`cloudflared.exe service uninstall` via PowerShell Administrator) agar tidak bentrok memakai token tunnel yang sama di 2 mesin.

Untuk PC Linux 64-bit (`amd64`):
```bash
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
rm cloudflared.deb

# Pasang token tunnel dari Cloudflare Zero Trust -> Tunnels
sudo cloudflared service install <TOKEN_TUNNEL_ANDA>
sudo systemctl status cloudflared
```
Pastikan *Public Hostname* domain Anda di Cloudflare Zero Trust tetap diarahkan ke **`http://localhost:3000`**.

### Langkah 6: Pastikan Koneksi LAN ke MikroTik Lancar
Hubungkan PC Linux ke jaringan **LAN yang satu rute dengan MikroTik** (hindari memakai dua default gateway sekaligus antara WiFi/tethering HP dan kabel LAN agar tunnel Cloudflare & koneksi API MikroTik tidak timeout/Error `1033`). Cek dari terminal Linux:
```bash
nc -zv <IP_MIKROTIK> 8728
```
Jika muncul `succeeded`, buka **`https://lenxynet.store`** atau **`http://<IP-LINUX>:3000`**, lalu cek menu **Pengaturan → Koneksi MikroTik** dan **WhatsApp** (scan QR jika tidak menyalin `wa_session/`).

### Perintah Harian di Linux Server (SSH)
| Keperluan | Perintah |
| :--- | :--- |
| **Cek status aplikasi** | `pm2 status` |
| **Lihat log real-time** | `pm2 logs lenxynet --lines 50` |
| **Restart aplikasi** | `pm2 restart lenxynet` |
| **Update versi terbaru dari GitHub** | `cd /var/www/lenxynet && git pull && npm install --omit=dev && pm2 restart lenxynet` |
| **Cek status Cloudflare Tunnel** | `sudo systemctl status cloudflared` |

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
* **Alternatif PC Windows Baru (Satu Kali Klik):**
  1. Install [Node.js v22+ LTS](https://nodejs.org/) & [Git](https://git-scm.com/).
  2. Clone repo ini ke folder (misal `D:\Microtik_Management`):
     ```powershell
     git clone https://github.com/markhanprasetiyo01-wq/lenxynet-billing.git D:\Microtik_Management
     ```
  3. Taruh file `database.sqlite` Anda ke dalam folder tersebut.
  4. **Jalankan Server:** Cukup **dobel klik `START_SERVER.bat`** (otomatis install npm jika belum ada).
  5. **Pasang Cloudflare Tunnel (Opsional):** Klik kanan `PASANG_CLOUDFLARE.bat` $\rightarrow$ **Run as Administrator** (otomatis mengunduh `cloudflared.exe` & memasang service dengan token).

---
Hak Cipta © 2026 **LenxyNet Billing & Management System** — `markhanprasetiyo01-wq`

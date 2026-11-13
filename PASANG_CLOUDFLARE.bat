@echo off
title Setup Cloudflare Tunnel LenxyNet

REM 1. Cek Hak Akses Administrator
net session >nul 2>&1
if errorlevel 1 (
    echo ========================================================
    echo [PERHATIAN] Skrip ini membutuhkan Hak Administrator!
    echo ========================================================
    echo Silakan klik kanan file ini lalu pilih:
    echo "Run as Administrator" / "Jalankan sebagai administrator"
    echo ========================================================
    echo.
    pause
    exit /b 1
)

REM 2. Tentukan folder project dengan path relatif (%~dp0)
set "TARGET_DIR=%~dp0"
if exist "%TARGET_DIR%server.js" goto FOUND
if exist "%TARGET_DIR%Microtik_Management\server.js" (
    set "TARGET_DIR=%TARGET_DIR%Microtik_Management\"
    goto FOUND
)
if exist "%TARGET_DIR%Microtic_Management\server.js" (
    set "TARGET_DIR=%TARGET_DIR%Microtic_Management\"
    goto FOUND
)
:FOUND
cd /d "%TARGET_DIR%"

cls
echo ========================================================
echo        SETUP CLOUDFLARE TUNNEL (LENXYNET FIBER)
echo ========================================================
echo Lokasi Folder : %TARGET_DIR%
echo.

REM 3. Cek file cloudflared.exe, unduh otomatis jika belum ada
if not exist "cloudflared.exe" (
    echo [INFO] File cloudflared.exe belum ada di folder ini.
    echo Mengunduh cloudflared-windows-amd64.exe otomatis dari Cloudflare...
    curl.exe -L --progress-bar -o "cloudflared.exe" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
    if not exist "cloudflared.exe" (
        echo.
        echo [ERROR] Gagal mengunduh cloudflared.exe!
        echo Pastikan komputer terhubung ke internet.
        pause
        exit /b 1
    )
    echo.
    echo [SUKSES] cloudflared.exe berhasil diunduh ke folder project!
    echo.
)

REM 4. Menu Pilihan
echo Pilih tindakan yang diinginkan:
echo [1] Pasang Service Baru dengan Token (Otomatis Aktif 24 Jam)
echo [2] Hapus / Uninstall Service Cloudflared Lama
echo [3] Jalankan Tunnel Langsung di Jendela Ini (Tanpa Service)
echo [4] Cek Status Service Cloudflared
echo [5] Keluar
echo.
set /p CHOICE="Pilihan Anda (1-5): "

if "%CHOICE%"=="1" (
    echo(
    echo Silakan copy token dari Cloudflare Zero Trust [Tunnels ^> Overview]
    set /p CF_TOKEN="Tempel (Paste) Token di sini: "
    if "%CF_TOKEN%"=="" (
        echo [ERROR] Token tidak boleh kosong!
        pause
        exit /b 1
    )
    echo(
    echo Menghapus service lama jika ada...
    cloudflared.exe service uninstall >nul 2>&1
    echo Memasang service Cloudflared...
    cloudflared.exe service install %CF_TOKEN%
    echo Menyalakan service...
    cloudflared.exe service start
    echo(
    echo ========================================================
    echo [SUKSES] Service Cloudflare Tunnel telah aktif!
    echo Silakan buka web di: https://lenxynet.store
    echo ========================================================
    pause
    exit /b 0
)

if "%CHOICE%"=="2" (
    echo(
    echo Menghentikan dan menghapus service Cloudflared...
    cloudflared.exe service stop >nul 2>&1
    cloudflared.exe service uninstall
    echo [SUKSES] Service Cloudflared berhasil dihapus.
    pause
    exit /b 0
)

if "%CHOICE%"=="3" (
    echo(
    set /p CF_TOKEN="Tempel (Paste) Token di sini: "
    if "%CF_TOKEN%"=="" (
        echo [ERROR] Token tidak boleh kosong!
        pause
        exit /b 1
    )
    cls
    echo Menjalankan Cloudflare Tunnel secara langsung...
    echo [Tekan Ctrl + C untuk mematikan tunnel]
    cloudflared.exe tunnel run --token %CF_TOKEN%
    pause
    exit /b 0
)

if "%CHOICE%"=="4" (
    echo.
    sc query Cloudflared
    echo.
    pause
    exit /b 0
)

exit /b 0

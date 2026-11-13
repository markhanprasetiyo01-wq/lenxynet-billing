@echo off
title LenxyNet 24/7 PM2 Server Manager

REM 1. Cek Hak Akses Administrator (dibutuhkan untuk auto-startup Windows)
net session >nul 2>&1
if errorlevel 1 (
    echo ========================================================
    echo [PERHATIAN] Skrip ini membutuhkan Hak Administrator!
    echo ========================================================
    echo Silakan klik kanan file ini lalu pilih:
    echo "Run as Administrator" / "Jalankan sebagai administrator"
    echo ========================================================
    echo(
    pause
    exit /b 1
)

REM 2. Tentukan folder target secara relatif (%~dp0)
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
echo        LENXYNET 24/7 PM2 SERVER MANAGER (WINDOWS)
echo ========================================================
echo Lokasi Folder : %TARGET_DIR%
echo(

REM 3. Cek apakah Node.js dan npm sudah ada
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js belum terinstall! Install Node.js v22 LTS terlebih dahulu.
    pause
    exit /b 1
)

REM 4. Cek apakah PM2 sudah terinstall secara global
where pm2 >nul 2>nul
if errorlevel 1 (
    echo [INFO] PM2 belum terpasang di komputer ini.
    echo Menginstall PM2 secara global via npm...
    call npm install -g pm2
    if errorlevel 1 (
        echo [ERROR] Gagal menginstall PM2! Pastikan koneksi internet aktif.
        pause
        exit /b 1
    )
    echo [SUKSES] PM2 berhasil diinstall!
    echo(
)

REM 5. Cek folder node_modules aplikasi
if not exist "node_modules\" (
    echo [INFO] Mengunduh dependensi aplikasi via npm install...
    call npm install --no-audit --no-fund
)

REM 6. Menu Kontrol PM2
echo Menu Kontrol PM2 24/7:
echo [1] Jalankan Server 24/7 + Auto-Start saat PC Restart/Mati Lampu (Rekomendasi)
echo [2] Lihat Status Server (pm2 status)
echo [3] Lihat Log Aktivitas / Error Real-time (pm2 logs)
echo [4] Restart Server (pm2 restart)
echo [5] Hentikan / Matikan Server (pm2 stop)
echo [6] Keluar
echo(
set "CHOICE="
set /p CHOICE="Pilihan Anda (1-6): "

if "%CHOICE%"=="1" goto START_ALWAYS_ON
if "%CHOICE%"=="2" goto VIEW_STATUS
if "%CHOICE%"=="3" goto VIEW_LOGS
if "%CHOICE%"=="4" goto DO_RESTART
if "%CHOICE%"=="5" goto DO_STOP
if "%CHOICE%"=="6" goto DO_EXIT
echo Pilihan tidak valid.
pause
exit /b 0

:START_ALWAYS_ON
cls
echo ========================================================
echo  MENGAKTIFKAN SERVER 24/7 ANTI-MATI DENGAN PM2
echo ========================================================
echo(
echo 1. Menghentikan proses lenxynet lama jika ada...
call pm2 delete lenxynet >nul 2>&1

echo 2. Menjalankan server.js dengan auto-restart on crash...
call pm2 start server.js --name "lenxynet" --max-memory-restart 500M --time

echo 3. Menyimpan daftar proses PM2...
call pm2 save

echo 4. Memasang pm2-startup untuk Windows...
call npm install -g pm2-windows-startup >nul 2>&1
call pm2-startup install >nul 2>&1
call pm2 save

echo(
echo ========================================================
echo [SUKSES] SERVER LENXYNET SEKARANG AKTIF 24 JAM!
echo ========================================================
echo - Jika server crash/error -> PM2 otomatis hidupkan ulang instan
echo - Jika PC restart / mati lampu -> Server otomatis nyala sendiri saat booting
echo - Dashboard Admin : http://localhost:3000
echo - Portal User     : http://localhost:3000/user.html
echo ========================================================
echo(
call pm2 status
echo(
pause
exit /b 0

:VIEW_STATUS
cls
call pm2 status
echo(
pause
exit /b 0

:VIEW_LOGS
cls
echo Menampilkan 50 baris log terakhir (Tekan Ctrl + C untuk keluar dari log)...
call pm2 logs lenxynet --lines 50
pause
exit /b 0

:DO_RESTART
cls
echo Merestart server LenxyNet di PM2...
call pm2 restart lenxynet
echo(
call pm2 status
echo(
pause
exit /b 0

:DO_STOP
cls
echo Menghentikan server LenxyNet di PM2...
call pm2 stop lenxynet
echo(
call pm2 status
echo(
pause
exit /b 0

:DO_EXIT
exit /b 0

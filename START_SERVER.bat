@echo off
setlocal enabledelayedexpansion
title LenxyNet Server Launcher

REM 1. Deteksi lokasi project menggunakan path relatif (%~dp0)
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
if exist "%TARGET_DIR%lenxynet-billing\server.js" (
    set "TARGET_DIR=%TARGET_DIR%lenxynet-billing\"
    goto FOUND
)

echo ========================================================
echo [ERROR] File server.js tidak ditemukan!
echo ========================================================
echo Pastikan file START_SERVER.bat ditaruh di:
echo 1. Di dalam folder Microtik_Management, ATAU
echo 2. Di drive D:\ berdampingan dengan folder Microtik_Management.
echo.
echo Lokasi bat saat ini: %~dp0
echo ========================================================
echo(
pause
exit /b 1

:FOUND
cd /d "%TARGET_DIR%"

REM 2. Cek apakah Node.js sudah terpasang di sistem
where node >nul 2>nul
if errorlevel 1 (
    echo ========================================================
    echo [ERROR] Node.js belum terinstall atau belum masuk ke PATH!
    echo ========================================================
    echo Silakan install Node.js versi 22 LTS terlebih dahulu:
    echo https://nodejs.org
    echo ========================================================
    echo(
    pause
    exit /b 1
)

REM 3. Peringatan jika Node.js di bawah versi 22 (karena modul node:sqlite bawaan)
for /f "tokens=1,2 delims=v." %%a in ('node -v 2^>nul') do set "NODE_MAJOR=%%a"
if defined NODE_MAJOR (
    if !NODE_MAJOR! LSS 22 (
        echo ========================================================
        echo [PERINGATAN] Versi Node.js Anda adalah v!NODE_MAJOR!
        echo Aplikasi ini membutuhkan Node.js versi 22 ke atas
        echo agar database SQLite bawaan berjalan lancar.
        echo Jika terjadi error, silakan install Node.js 22 LTS.
        echo ========================================================
        echo(
    )
)

REM 4. Cek folder node_modules
if not exist "node_modules\" (
    if exist "package.json" (
        echo ========================================================
        echo [INFO] Folder node_modules belum ditemukan.
        echo Mengunduh dependensi via npm install...
        echo ========================================================
        call npm install --no-audit --no-fund
        if errorlevel 1 (
            echo(
            echo [ERROR] Gagal menginstall dependensi via npm!
            echo Pastikan komputer terhubung ke internet.
            echo(
            pause
            exit /b 1
        )
    )
)

REM 5. Jalankan Server LenxyNet
cls
echo ========================================================
echo        LENXYNET BILLING ^& MIKROTIK MANAGEMENT
echo ========================================================
echo Lokasi Folder  : %TARGET_DIR%
for /f "tokens=*" %%v in ('node -v 2^>nul') do echo Versi Node.js  : %%v
echo(
echo Akses Web:
echo - Dashboard Admin : http://localhost:3000
echo - Portal User     : http://localhost:3000/user.html
echo(
if not exist "cloudflared.exe" (
    echo Tips Cloudflare: Jika ingin menghubungkan https://lenxynet.store,
    echo jalankan skrip PASANG_CLOUDFLARE.bat [Run as Administrator]
    echo --------------------------------------------------------
)
echo Catatan: Jendela ini adalah server aktif.
echo Jangan ditutup selama ingin server tetap online!
echo Tekan Ctrl + C di jendela ini untuk mematikan server.
echo ========================================================
echo(

node server.js

if errorlevel 1 (
    echo(
    echo ========================================================
    echo [PERINGATAN] Server berhenti dengan kode error.
    echo ========================================================
)

echo(
pause

@echo off
rem かざすだけスキャン(HTTPS)用の自己署名証明書を作り直す
rem サーバーPCのIPが 192.168.1.107 から変わったときに実行してください（要 Git for Windows）
setlocal
set IP=192.168.1.107
if not "%~1"=="" set IP=%~1
set TLSDIR=%~dp0..\server\data\tls
if not exist "%TLSDIR%" mkdir "%TLSDIR%"
"C:\Program Files\Git\usr\bin\openssl.exe" req -x509 -newkey rsa:2048 ^
  -keyout "%TLSDIR%\key.pem" -out "%TLSDIR%\cert.pem" -days 3650 -nodes ^
  -subj "/CN=kyoshin-steel" -addext "subjectAltName=IP:%IP%,DNS:localhost,IP:127.0.0.1"
echo.
echo 完了: %TLSDIR%
echo サーバーを再起動すると反映されます（各スマホで警告の許可をやり直し）
pause

@echo off
rem HTTPS用の証明書を作り直す（社内CA方式）
rem  ・CA（kyoshin-ca）は既にあれば再利用。無ければ新規作成（作り直すと全端末で信頼のやり直し）
rem  ・サーバー証明書は800日有効（iPhoneの制限で825日以下が必須）。期限が切れたら本batを再実行
rem  ・サーバーPCのIPが 192.168.1.107 から変わったときも再実行（引数でIP指定可）
setlocal
set IP=192.168.1.107
if not "%~1"=="" set IP=%~1
set TLSDIR=%~dp0..\server\data\tls
if not exist "%TLSDIR%" mkdir "%TLSDIR%"
set OPENSSL="C:\Program Files\Git\usr\bin\openssl.exe"

if not exist "%TLSDIR%\ca.pem" (
  echo CAを新規作成します...
  %OPENSSL% req -x509 -newkey rsa:2048 -keyout "%TLSDIR%\ca-key.pem" -out "%TLSDIR%\ca.pem" -days 3650 -nodes -subj "/CN=Kyoshin Steel Local CA" -addext "basicConstraints=critical,CA:true" -addext "keyUsage=critical,keyCertSign,cRLSign"
)

(
  echo subjectAltName=IP:%IP%,DNS:localhost,IP:127.0.0.1
  echo extendedKeyUsage=serverAuth
  echo keyUsage=critical,digitalSignature,keyEncipherment
  echo basicConstraints=CA:false
) > "%TLSDIR%\ext.cnf"

%OPENSSL% req -newkey rsa:2048 -keyout "%TLSDIR%\key.pem" -out "%TLSDIR%\srv.csr" -nodes -subj "/CN=kyoshin-steel"
%OPENSSL% x509 -req -in "%TLSDIR%\srv.csr" -CA "%TLSDIR%\ca.pem" -CAkey "%TLSDIR%\ca-key.pem" -CAcreateserial -out "%TLSDIR%\cert.pem" -days 800 -extfile "%TLSDIR%\ext.cnf"

echo.
echo 完了: %TLSDIR%
echo サーバーを再起動すると反映されます。
echo 各端末へのCA配布は https://%IP%/ca.crt （またはhttp）からダウンロード。
pause

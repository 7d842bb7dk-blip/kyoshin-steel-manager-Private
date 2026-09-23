@echo off
rem 鋼材在庫システム：ドメイン（DuckDNS）＋ Let's Encrypt 証明書の初期設定
rem  一度実行すれば、以後の更新はサーバーが自動で行います。各端末の設定は不要になります。
chcp 65001 >nul
cd /d %~dp0..
node tools\domain-setup.js
echo.
pause

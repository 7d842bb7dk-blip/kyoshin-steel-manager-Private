#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
鋼材管理システム ビルドスクリプト
-----------------------------------
index.html / styles.css / js/app.js / assets/logo.png を 1 つの
自己完結型 HTML（dist/鋼材管理システム.html）にまとめます。

依存ライブラリなし。プロジェクト直下で実行してください：

    python build.py

ソース（上記4ファイル）を編集したら、本スクリプトを再実行して
配布用の 1 ファイル版を作り直します。
"""
import base64
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent


def read(rel):
    return (ROOT / rel).read_text(encoding="utf-8")


def main():
    html = read("index.html")
    css = read("styles.css")
    js = read("js/app.js")
    logo_b64 = base64.b64encode((ROOT / "assets/logo.png").read_bytes()).decode()

    # inline CSS
    link_tag = '<link rel="stylesheet" href="styles.css">'
    if link_tag not in html:
        raise SystemExit("index.html に CSS の link タグが見つかりません: " + link_tag)
    html = html.replace(link_tag, "<style>\n" + css + "\n</style>", 1)

    # inline JS
    script_tag = '<script src="js/app.js"></script>'
    if script_tag not in html:
        raise SystemExit("index.html に script タグが見つかりません: " + script_tag)
    html = html.replace(script_tag, "<script>\n" + js + "\n</script>", 1)

    # inline logo
    asset_ref = 'src="assets/logo.png"'
    if asset_ref not in html:
        raise SystemExit("index.html にロゴ参照が見つかりません: " + asset_ref)
    html = html.replace(asset_ref, 'src="data:image/png;base64,' + logo_b64 + '"', 1)

    out = ROOT / "dist" / "鋼材管理システム.html"
    out.parent.mkdir(exist_ok=True)
    out.write_text(html, encoding="utf-8")
    print("ビルド完了 →", out, "(", len(html.encode("utf-8")), "bytes )")


if __name__ == "__main__":
    main()

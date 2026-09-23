#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
鋼材管理システム ビルドスクリプト
-----------------------------------
index.html / styles.css / js/app.js / assets/logo.png に加え、
QR読み取り用の js/jsqr.js・js/vendor/zxing-reader.js・zxing_reader.wasm
（base64 埋め込み）を 1 つの自己完結型 HTML（dist/鋼材管理システム.html）に
まとめます。file:// で開いても QR 画像の読み取りが動きます。

依存ライブラリなし。プロジェクト直下で実行してください：

    python build.py

ソースを編集したら、本スクリプトを再実行して配布用の 1 ファイル版を
作り直します。
"""
import base64
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent


def read(rel):
    return (ROOT / rel).read_text(encoding="utf-8")


def inline_js(src):
    # <script> 内に "</script" が現れるとそこで HTML が閉じてしまうため念のためエスケープ
    # （JS の文字列・正規表現内では "<\/script" と等価）
    return src.replace("</script", "<\\/script")


def main():
    html = read("index.html")
    css = read("styles.css")
    logo_b64 = base64.b64encode((ROOT / "assets/logo.png").read_bytes()).decode()
    wasm_b64 = base64.b64encode(
        (ROOT / "js/vendor/zxing_reader.wasm").read_bytes()
    ).decode()

    # inline CSS
    link_tag = '<link rel="stylesheet" href="styles.css">'
    if link_tag not in html:
        raise SystemExit("index.html に CSS の link タグが見つかりません: " + link_tag)
    html = html.replace(link_tag, "<style>\n" + css + "\n</style>", 1)

    # inline JS（jsQR / zxing-reader / app.js の3本。app.js の prepZxing が
    # window.__ZXING_WASM_B64 を見て wasm を base64 から直接ロードする）
    scripts = [
        ("js/jsqr.js", ""),
        (
            "js/vendor/zxing-reader.js",
            "<script>window.__ZXING_WASM_B64=" + repr(wasm_b64).replace("'", '"')
            + ";</script>\n",
        ),
        ("js/app.js", ""),
    ]
    for rel, prefix in scripts:
        script_tag = '<script src="' + rel + '"></script>'
        if script_tag not in html:
            raise SystemExit("index.html に script タグが見つかりません: " + script_tag)
        html = html.replace(
            script_tag,
            prefix + "<script>\n" + inline_js(read(rel)) + "\n</script>",
            1,
        )

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

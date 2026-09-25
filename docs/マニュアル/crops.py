# -*- coding: utf-8 -*-
"""
マニュアルの拡大図（切り抜き画像）を作り直すスクリプト。

PDFを開くアプリによっては「SVGの中に入れた画像（切り抜き）」が表示されないため、
切り抜きは前もって普通のPNGにしておき、HTMLからは普通の <img> で読み込む。

  ・HTML の <img data-crop="shots/元画像.png x y 幅 高さ"> を見て、shots/crop/ に切り抜きを作る
  ・古い書き方 <svg viewBox="x y w h"><image href="shots/..."/></svg> が残っていれば <img> に置き換える
スクリーンショット（shots/*.png）を撮り直したら、このスクリプトを実行してからPDFを作ること。
    python crops.py
"""
import os
import re
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
HTML = os.path.join(HERE, "使い方マニュアル.html")
CROP_DIR = os.path.join(HERE, "shots", "crop")

SVG_RE = re.compile(
    r'<svg viewBox="(-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+)"[^>]*>'
    r'<image href="(shots/[^"]+)" width="(\d+)" height="(\d+)"/></svg>'
)
IMG_RE = re.compile(r'<img([^>]*?)data-crop="([^"]+)"([^>]*)>')


def crop_name(src, x, y, w, h):
    base = os.path.splitext(os.path.basename(src))[0]
    return "shots/crop/%s_%d_%d_%d_%d.png" % (base, x, y, w, h)


def make_crop(src, x, y, w, h):
    """元画像から (x, y, w, h) を切り抜いてPNG（RGB・透明なし）で保存。はみ出した分は白で埋める"""
    im = Image.open(os.path.join(HERE, src)).convert("RGB")
    out = Image.new("RGB", (w, h), (255, 255, 255))
    out.paste(im.crop((x, y, x + w, y + h)), (0, 0))
    dst = crop_name(src, x, y, w, h)
    out.save(os.path.join(HERE, dst), optimize=True)
    return dst


def svg_to_img(m):
    x, y, w, h = (int(float(v)) for v in m.group(1, 2, 3, 4))
    src = m.group(5)
    iw, ih = int(m.group(6)), int(m.group(7))
    if (x, y, w, h) == (0, 0, iw, ih):  # 切り抜きなし＝元画像そのまま
        return '<img src="%s" alt="">' % src
    return '<img class="crop" data-crop="%s %d %d %d %d" src="%s" alt="">' % (src, x, y, w, h, crop_name(src, x, y, w, h))


def main():
    os.makedirs(CROP_DIR, exist_ok=True)
    with open(HTML, encoding="utf-8") as f:
        html = f.read()
    html, n_conv = SVG_RE.subn(svg_to_img, html)
    made = []

    def regen(m):
        src, x, y, w, h = m.group(2).split()
        x, y, w, h = int(x), int(y), int(w), int(h)
        dst = make_crop(src, x, y, w, h)
        made.append(dst)
        attrs = (m.group(1) + m.group(3))
        attrs = re.sub(r'\s*src="[^"]*"', "", attrs)
        return '<img%s data-crop="%s %d %d %d %d" src="%s"%s>' % (
            "", src, x, y, w, h, dst, attrs.rstrip().replace("  ", " ") if attrs.strip() else "")

    html = IMG_RE.sub(regen, html)
    # 使われなくなった古い切り抜きを片付ける
    keep = {os.path.basename(p) for p in made}
    for fn in os.listdir(CROP_DIR):
        if fn.endswith(".png") and fn not in keep:
            os.remove(os.path.join(CROP_DIR, fn))
    with open(HTML, "w", encoding="utf-8", newline="") as f:
        f.write(html)
    print("置き換え %d 件 / 切り抜き %d 枚" % (n_conv, len(made)))


if __name__ == "__main__":
    sys.exit(main())

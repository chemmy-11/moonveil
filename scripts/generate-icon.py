#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
AI-GF APK 图标生成脚本
用法: python scripts/generate-icon.py <源图路径>
生成:
  - 各密度 ic_launcher.png / ic_launcher_round.png（旧式方形/圆形）
  - 各密度 ic_launcher_foreground.png（自适应图标前景，66% 安全区缩放）
  - values/ic_launcher_background.xml 背景色（自动取源图主色）
依赖: Pillow (pip install pillow)
"""
import os
import sys
from PIL import Image, ImageDraw, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, 'android', 'app', 'src', 'main', 'res')

# 各密度 → 图标尺寸
DENSITIES = {
    'mdpi': 48,
    'hdpi': 72,
    'xhdpi': 96,
    'xxhdpi': 144,
    'xxxhdpi': 192,
}


def pick_background_color(img):
    """从源图取主色（缩小后中值颜色）"""
    small = img.resize((32, 32), Image.LANCZOS)
    px = list(small.getdata())
    px.sort(key=lambda p: sum(p[:3]))
    r, g, b = px[len(px) // 2][:3]
    return '#{:02X}{:02X}{:02X}'.format(r, g, b)


def square_cover(img, size):
    """cover 裁切到正方形并缩放"""
    w, h = img.size
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    return img.crop((left, top, left + side, top + side)).resize((size, size), Image.LANCZOS)


def round_mask(size):
    mask = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.ellipse((0, 0, size - 1, size - 1), fill=255)
    return mask


def main():
    if len(sys.argv) < 2:
        print('用法: python scripts/generate-icon.py <源图路径>')
        sys.exit(1)
    src = sys.argv[1]
    if not os.path.exists(src):
        print('源图不存在:', src)
        sys.exit(1)

    img = Image.open(src).convert('RGBA')
    print('源图:', src, img.size)

    bg = pick_background_color(img)
    print('背景主色:', bg)

    for density, size in DENSITIES.items():
        mipmap = os.path.join(RES, 'mipmap-' + density)
        os.makedirs(mipmap, exist_ok=True)

        # 旧式方形图标
        square = square_cover(img, size)
        square.save(os.path.join(mipmap, 'ic_launcher.png'))

        # 旧式圆形图标
        rounded = square.copy()
        rounded.putalpha(round_mask(size))
        rounded.save(os.path.join(mipmap, 'ic_launcher_round.png'))

        # 自适应图标前景：108dp 画布，66% 安全区缩放（四周留白防被系统裁切）
        canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        content = int(size * 0.62)  # 略小于 66% 留余量
        fg = square_cover(img, content)
        canvas.paste(fg, ((size - content) // 2, (size - content) // 2))
        canvas.save(os.path.join(mipmap, 'ic_launcher_foreground.png'))

        print('  {}: ic_launcher/round/foreground ({})'.format(density, size))

    # 更新自适应图标背景色
    colors_xml = os.path.join(RES, 'values', 'ic_launcher_background.xml')
    with open(colors_xml, 'w', encoding='utf-8') as f:
        f.write('<?xml version="1.0" encoding="utf-8"?>\n')
        f.write('<resources>\n')
        f.write('    <color name="ic_launcher_background">{}</color>\n'.format(bg))
        f.write('</resources>\n')
    print('背景色已写入:', colors_xml)

    print('完成！重新构建 APK 即可生效: bash scripts/build.sh')


if __name__ == '__main__':
    main()

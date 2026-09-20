#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
make_icon.py — 从一张源图生成 Android 各密度的启动图标

为什么用 Python 而不是继续用 Node 那个自写 PNG 编码器：
  tools/make-icon.js 是自己画图标的（自写 PNG 编码器画波形图），
  那种方式只能画简单几何图形。现在用户给了一张真实插画，
  需要解码 → 缩放 → 重编码，用 PIL 最省事（本机已装 12.3.0）。

用法：
  python tools/make_icon.py --src docs/icon-source.png
  python tools/make_icon.py --src xxx.png --out android/res
"""

import argparse
import os
import sys


def main():
    ap = argparse.ArgumentParser(description='生成 Android 各密度图标')
    ap.add_argument('--src', required=True, help='源图（正方形，建议 ≥512×512）')
    ap.add_argument('--out', default='android/res', help='输出的 res 目录')
    ap.add_argument('--round', action='store_true', help='裁成圆形（部分启动器要求）')
    args = ap.parse_args()

    from PIL import Image, ImageDraw

    if not os.path.isfile(args.src):
        print('[错误] 找不到源图：%s' % args.src)
        sys.exit(1)

    img = Image.open(args.src).convert('RGBA')
    w, h = img.size
    print('[源图] %d×%d  %s' % (w, h, os.path.basename(args.src)))

    # 裁成正方形（取中心）
    if w != h:
        side = min(w, h)
        left = (w - side) // 2
        top = (h - side) // 2
        img = img.crop((left, top, left + side, top + side))
        print('       裁成正方形 %d×%d' % (side, side))

    # 各密度对应的启动器图标尺寸
    #   mdpi 48 / hdpi 72 / xhdpi 96 / xxhdpi 144 / xxxhdpi 192
    targets = [
        ('mipmap-mdpi', 48),
        ('mipmap-hdpi', 72),
        ('mipmap-xhdpi', 96),
        ('mipmap-xxhdpi', 144),
        ('mipmap-xxxhdpi', 192),
    ]

    for folder, size in targets:
        out_dir = os.path.join(args.out, folder)
        os.makedirs(out_dir, exist_ok=True)

        # LANCZOS 缩放质量最好
        icon = img.resize((size, size), Image.LANCZOS)

        if args.round:
            mask = Image.new('L', (size, size), 0)
            ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
            icon.putalpha(mask)

        path = os.path.join(out_dir, 'ic_launcher.png')
        icon.save(path, 'PNG', optimize=True)
        print('       %-18s %3d×%-3d  %6d B' % (folder, size, size, os.path.getsize(path)))

    # 同时更新前台图标（部分配置引用）
    fg_dir = os.path.join(args.out, 'mipmap-xxxhdpi')
    img.resize((432, 432), Image.LANCZOS).save(
        os.path.join(fg_dir, 'ic_launcher_foreground.png'), 'PNG', optimize=True)
    print('       已生成 ic_launcher_foreground.png (432×432)')
    print('[完成] 图标写入 %s' % args.out)


if __name__ == '__main__':
    main()

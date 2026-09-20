#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
ocr_pdf.py — 用 OCR 从扫描/坏文字层的 PDF 里抽取文本，并做双栏版面重排

为什么需要它：
  《剑桥雅思》答案页的 PDF 有两类问题：
    1. 部分书是纯扫描图（剑9/16/18/20），根本没有文字层；
    2. 部分书虽然有文字层，但提取结果是坏的 —— 实测剑10 抽出来是
         "S ection 2，Q ue stion s 11-20"（字母被拆开）
         且【题号整个丢失】，只剩裸答案 "A  c  health problems"。
       这种文字层没法用来对齐题号，只能靠 OCR。

关键设计：**按位置重排**
  答案页是双栏排版，而文字层/OCR 的默认输出顺序会把两栏交错。
  所以这里保留每个文本框的坐标，先按 x 判断属于左栏还是右栏，
  再在栏内按 y 从上到下排序，最后左栏在前、右栏在后。
  这是把题号还原出来的前提。

用法：
  # 单页试跑（看识别质量）
  python tools/ocr_pdf.py --pdf "听力真题/剑10真题_answers.pdf" --pages 1 --dump

  # 导出全部页面文本
  python tools/ocr_pdf.py --pdf "..." --out build/剑10-answers.txt

  # 批量处理整个目录
  python tools/ocr_pdf.py --dir "听力真题" --outdir build/ocr --pattern "*answers*.pdf"
"""

import argparse
import os
import sys
import time


def iter_pages(pdf_path, dpi=300, first=None, last=None):
    """
    逐页产出 (页码, 图像)，不一次性渲染整本。

    为什么必须流式：原题 PDF 有 24–32 页，300dpi 灰度约 50 MB/页，
    一次性渲染要 1.3 GB 以上；本机可用内存只有 4 GB 左右，整本渲染会 OOM。
    逐页处理时每页用完即弃，峰值只有单页大小。
    """
    import fitz
    import numpy as np

    doc = fitz.open(pdf_path)
    try:
        total = doc.page_count
        i0 = 0 if first is None else max(0, first - 1)
        i1 = total if last is None else min(total, last)
        for i in range(i0, i1):
            page = doc.load_page(i)
            pix = page.get_pixmap(dpi=dpi, colorspace=fitz.csGRAY)
            img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width)
            yield (i + 1, total, img)
            del img, pix
    finally:
        doc.close()


def render_pages(pdf_path, dpi=300, first=None, last=None):
    """兼容旧接口：返回 [(页码, 图像)] 列表（仅适合小 PDF）"""
    out = []
    for pno, _total, img in iter_pages(pdf_path, dpi=dpi, first=first, last=last):
        out.append((pno, img))
    return out, (out[0] if out else 0)


def ocr_image(engine, img):
    """对单张图跑 OCR，返回 [(box, text, score)]"""
    result, _ = engine(img)
    if not result:
        return []
    out = []
    for item in result:
        # rapidocr 返回 [box, text, score]，box 是四个角点
        box, text, score = item[0], item[1], item[2]
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        out.append({
            'x0': min(xs), 'x1': max(xs),
            'y0': min(ys), 'y1': max(ys),
            'cx': sum(xs) / 4.0, 'cy': sum(ys) / 4.0,
            'text': str(text).strip(),
            'score': float(score),
        })
    return [o for o in out if o['text']]


def reorder_columns(items, page_width):
    """
    双栏版面重排。

    做法：
      1. 用每个文本框的中心 x 判断栏属；
      2. 找「栏间空白」——把所有文本框按 cx 排序，相邻间距最大的那条缝就是栏分界；
         若最大间距不明显（< 页宽 8%），就认为不是双栏，直接按 y 排序。
      3. 左栏先输出，右栏后输出，各栏内按 y 排。
    """
    if not items:
        return []

    xs = sorted(o['cx'] for o in items)
    if len(xs) < 4:
        return sorted(items, key=lambda o: (o['y0'], o['x0']))

    # 找最大间距
    best_gap, best_at = 0.0, None
    for a, b in zip(xs, xs[1:]):
        gap = b - a
        if gap > best_gap:
            best_gap, best_at = gap, (a + b) / 2.0

    if best_at is None or best_gap < page_width * 0.08:
        # 不是明显的双栏
        return sorted(items, key=lambda o: (o['y0'], o['x0']))

    left = [o for o in items if o['cx'] < best_at]
    right = [o for o in items if o['cx'] >= best_at]

    # 若某一栏过少，说明误判，回退单栏
    if len(left) < 2 or len(right) < 2:
        return sorted(items, key=lambda o: (o['y0'], o['x0']))

    left.sort(key=lambda o: (o['y0'], o['x0']))
    right.sort(key=lambda o: (o['y0'], o['x0']))
    return left + right


def render_text(items, min_score=0.0, join_gap=None):
    """
    把排序后的文本块拼成文本。

    注意：RapidOCR 是把一行切成多个文本框返回的（比如 "1" 和 "Ardleigh" 是两块），
    直接拼接会得到 "1Ardleigh"。所以块与块之间要按水平间距决定加不加空格：
    间距大于字高的一半 → 加空格；否则视为同一个词被切开 → 直接连。
    """
    lines = []
    buf = []
    last_y = None
    last_x1 = None
    last_h = None

    for o in items:
        if o['score'] < min_score:
            continue
        h = o['y1'] - o['y0']
        same_line = last_y is not None and abs(o['y0'] - last_y) <= max(6, h * 0.6)

        if not same_line:
            if buf:
                lines.append(''.join(buf))
                buf = []
        else:
            # 同一行内的相邻块：按水平间距决定是否补空格
            ref_h = last_h or h
            gap = o['x0'] - (last_x1 if last_x1 is not None else o['x0'])
            if gap > ref_h * 0.28:
                buf.append(' ')

        buf.append(o['text'])
        last_y = o['y0']
        last_x1 = o['x1']
        last_h = h

    if buf:
        lines.append(''.join(buf))
    return '\n'.join(lines)


def process_pdf(engine, pdf_path, dpi=300, first=None, last=None, min_score=0.0, verbose=True):
    """逐页 OCR（流式，内存友好）"""
    chunks = []
    total = 0
    for pno, total_pages, img in iter_pages(pdf_path, dpi=dpi, first=first, last=last):
        total = total_pages
        h, w = img.shape[:2]
        items = ocr_image(engine, img)
        ordered = reorder_columns(items, w)
        text = render_text(ordered, min_score=min_score)
        chunks.append('━━━━━ 第 %d 页 ━━━━━\n%s' % (pno, text))
        if verbose:
            print('    第 %d/%d 页: %d 个文本框, %d 字符' % (pno, total, len(items), len(text)), flush=True)
        del img, items, ordered
    return '\n\n'.join(chunks), total


def main():
    ap = argparse.ArgumentParser(description='OCR 抽取 PDF 文本（含双栏重排）')
    ap.add_argument('--pdf', help='单个 PDF')
    ap.add_argument('--dir', help='批量：目录')
    ap.add_argument('--pattern', default='*.pdf', help='批量时的文件名通配')
    ap.add_argument('--out', help='单文件输出路径')
    ap.add_argument('--outdir', default='build/ocr', help='批量输出目录')
    ap.add_argument('--pages', type=int, default=0, help='只处理前 N 页（0=全部）')
    ap.add_argument('--dpi', type=int, default=300, help='渲染 DPI，默认 300')
    ap.add_argument('--dump', action='store_true', help='把结果打印到屏幕')
    ap.add_argument('--min-score', type=float, default=0.0, help='低于该置信度的结果丢弃')
    args = ap.parse_args()

    if not args.pdf and not args.dir:
        ap.error('需要 --pdf 或 --dir')

    from rapidocr_onnxruntime import RapidOCR
    engine = RapidOCR()
    print('[引擎] RapidOCR 就绪', flush=True)

    targets = []
    if args.pdf:
        targets.append(args.pdf)
    else:
        import glob
        targets = sorted(glob.glob(os.path.join(args.dir, args.pattern)))
    if not targets:
        print('[错误] 没有找到 PDF')
        sys.exit(1)

    for i, p in enumerate(targets, 1):
        base = os.path.splitext(os.path.basename(p))[0]
        print('[%d/%d] %s' % (i, len(targets), base), flush=True)
        t0 = time.time()
        try:
            text, total = process_pdf(
                engine, p, dpi=args.dpi,
                first=1, last=(args.pages or None),
                min_score=args.min_score,
            )
        except Exception as e:
            print('    [失败] %s' % e, flush=True)
            continue

        out = args.out if args.pdf and args.out else os.path.join(args.outdir, base + '.ocr.txt')
        os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
        with open(out, 'w', encoding='utf-8') as f:
            f.write(text)
        print('    → %s  (%d 字符, 共 %d 页, 耗时 %.1fs)' % (out, len(text), total, time.time() - t0), flush=True)

        if args.dump:
            print('')
            print(text[:3000])
            print('')


if __name__ == '__main__':
    main()

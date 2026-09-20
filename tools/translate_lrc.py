#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
translate_lrc.py — 把英文 LRC 逐句机翻成中文，产出 .translation.lrc

设计取舍：
  · 用 CTranslate2 + 量化后的 Opus-MT（en→zh）模型，**完全离线**，模型仅 76 MB
  · 不用 whisper 的 task='translate'：那要对 30 分钟音频重跑一遍，慢且吃内存；
    我们已经有转写好的 LRC，直接逐句翻译即可
  · CPU int8 推理，不占 GPU（GPU 留给需要时的转写）

⚠️ 输出会带机器翻译声明。用户明确要求：机翻必须加声明，
   除非用户自己上传了中文原文（那种情况不要用本工具）。

用法：
  # 单个课程
  python tools/translate_lrc.py --lrc "audio/IELTS-剑桥真题/C10-Test1.lrc"

  # 批量（处理目录下所有 .lrc，跳过已有译文的）
  python tools/translate_lrc.py --dir "audio/IELTS-剑桥真题" --only-missing

  # 只翻前 20 行试效果
  python tools/translate_lrc.py --lrc "..." --limit 20 --dump
"""

import argparse
import glob
import os
import re
import sys
import time

MODEL_DIR_DEFAULT = 'models/opus-mt-en-zh-ct2'
DISCLAIMER = '⚠ 机器翻译（Opus-MT 离线模型），仅供理解参考，请以英文原文为准'


def load_translator(model_dir):
    """加载 CTranslate2 模型与 SentencePiece 分词器"""
    import ctranslate2
    import sentencepiece as spm

    if not os.path.isdir(model_dir):
        raise SystemExit('模型目录不存在：%s\n请先下载模型（见 tools/HANDOFF.md）' % model_dir)

    translator = ctranslate2.Translator(model_dir, device='cpu', compute_type='int8')
    src_sp = spm.SentencePieceProcessor()
    tgt_sp = spm.SentencePieceProcessor()
    src_sp.load(os.path.join(model_dir, 'source.spm'))
    tgt_sp.load(os.path.join(model_dir, 'target.spm'))
    return translator, src_sp, tgt_sp


def translate_batch(translator, src_sp, tgt_sp, sentences, beam_size=2, batch_size=32):
    """批量翻译，返回中文句子列表"""
    out = []
    for i in range(0, len(sentences), batch_size):
        chunk = sentences[i:i + batch_size]
        # Opus-MT 要求句尾带 </s>
        batch = [src_sp.encode(s, out_type=str) + ['</s>'] for s in chunk]
        results = translator.translate_batch(
            batch, beam_size=beam_size, max_batch_size=batch_size,
            max_decoding_length=256,
        )
        for r in results:
            toks = [t for t in r.hypotheses[0] if t not in ('</s>', '<s>', '<pad>')]
            text = tgt_sp.decode(toks)
            out.append(text.replace(' ', '').strip())
    return out


# ---------------------------------------------------------------- LRC 处理

LRC_META = re.compile(r'^\[(ti|ar|al|by|offset|re|ve|length):', re.I)
LRC_TIME = re.compile(r'^\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\](.*)$')


def parse_lrc(text):
    """返回 [{time, text, raw}]，跳过元信息行"""
    rows = []
    for raw in text.replace('\r\n', '\n').split('\n'):
        line = raw.strip()
        if not line or LRC_META.match(line):
            continue
        m = LRC_TIME.match(line)
        if not m:
            continue
        t = int(m.group(1)) * 60 + float(m.group(2).replace(':', '.'))
        body = m.group(3).strip()
        if body:
            rows.append({'time': t, 'text': body, 'raw': raw})
    return rows


def fmt_time(sec):
    m = int(sec // 60)
    s = sec - m * 60
    return '%02d:%05.2f' % (m, s)


def is_mostly_english(s):
    """判断是否值得翻译（含足够英文字母）"""
    letters = len(re.findall(r'[A-Za-z]', s))
    return letters >= 4 and letters / max(1, len(s)) > 0.3


def translate_lrc_file(translator, src_sp, tgt_sp, lrc_path, out_path=None,
                       limit=0, beam=2, verbose=True):
    with open(lrc_path, encoding='utf-8') as f:
        text = f.read()

    rows = parse_lrc(text)
    if not rows:
        return {'ok': False, 'error': '没有可翻译的行'}

    to_tr = [r for r in rows if is_mostly_english(r['text'])]
    if limit:
        to_tr = to_tr[:limit]

    if not to_tr:
        return {'ok': False, 'error': '没有英文内容'}

    t0 = time.time()
    zh = translate_batch(translator, src_sp, tgt_sp, [r['text'] for r in to_tr], beam_size=beam)
    dt = time.time() - t0

    # 组装译文 LRC（保留原时间戳）
    lines = [
        '[ti:%s · 中文译文]' % os.path.splitext(os.path.basename(lrc_path))[0],
        '[by:listening-player translate_lrc.py]',
        '[re:%s]' % DISCLAIMER,
    ]
    for r, z in zip(to_tr, zh):
        if z:
            lines.append('[%s]%s' % (fmt_time(r['time']), z))

    out_path = out_path or (os.path.splitext(lrc_path)[0] + '.translation.lrc')
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')

    if verbose:
        print('    %d 句  耗时 %.1fs  (%.1f 句/秒)' % (len(to_tr), dt, len(to_tr) / max(0.1, dt)), flush=True)

    return {'ok': True, 'count': len(to_tr), 'seconds': dt, 'out': out_path, 'sample': list(zip(to_tr[:3], zh[:3]))}


def main():
    ap = argparse.ArgumentParser(description='英文 LRC → 中文译文 LRC（离线机翻）')
    ap.add_argument('--lrc', help='单个 LRC 文件')
    ap.add_argument('--dir', help='批量：目录')
    ap.add_argument('--only-missing', action='store_true', help='已有 .translation.lrc 的跳过')
    ap.add_argument('--limit', type=int, default=0, help='每个文件只翻前 N 句（试效果用）')
    ap.add_argument('--out', help='输出路径（仅 --lrc 单文件时有效）')
    ap.add_argument('--beam', type=int, default=2)
    ap.add_argument('--model', default=MODEL_DIR_DEFAULT)
    ap.add_argument('--dump', action='store_true', help='打印样例')
    args = ap.parse_args()

    if not args.lrc and not args.dir:
        ap.error('需要 --lrc 或 --dir')

    print('[模型] 加载 %s …' % args.model, flush=True)
    translator, src_sp, tgt_sp = load_translator(args.model)
    print('[模型] 就绪（CPU int8）', flush=True)

    targets = []
    if args.lrc:
        targets = [args.lrc]
    else:
        targets = sorted(f for f in glob.glob(os.path.join(args.dir, '*.lrc'))
                         if not f.endswith('.translation.lrc'))

    if args.only_missing:
        targets = [t for t in targets
                   if not os.path.exists(os.path.splitext(t)[0] + '.translation.lrc')]

    print('待翻译 %d 个文件' % len(targets), flush=True)

    done = 0
    for i, p in enumerate(targets, 1):
        print('[%d/%d] %s' % (i, len(targets), os.path.basename(p)), flush=True)
        try:
            r = translate_lrc_file(translator, src_sp, tgt_sp, p,
                                   out_path=args.out if args.lrc else None,
                                   limit=args.limit, beam=args.beam)
        except Exception as e:
            print('    [失败] %s' % e, flush=True)
            continue
        if not r['ok']:
            print('    [跳过] %s' % r['error'], flush=True)
            continue
        done += 1
        if args.dump:
            for row, dst in r['sample']:
                print('      EN: %s' % str(row['text'])[:78])
                print('      ZH: %s' % str(dst)[:78])

    print('')
    print('完成 %d / %d' % (done, len(targets)))


if __name__ == '__main__':
    main()

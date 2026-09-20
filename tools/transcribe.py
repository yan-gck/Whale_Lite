#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
transcribe.py — 用 faster-whisper 把听力音频转成带句级时间戳的字幕

用途：
  给「有音频、没原文」的材料生成逐句文字 + 时间戳，
  输出 TSV（起始秒 <TAB> 结束秒 <TAB> 文本），可直接喂给：
      node tools/lrc-from-srt.js out.tsv out.lrc
  这样歌词就能跟着音频滚动。

为什么用 faster-whisper：
  · 纯 Python/CTranslate2 实现，不需要单独装 ffmpeg（自带 PyAV 解 mp3）
  · 支持 GPU 加速，RTX 4060 上比 CPU 快十倍以上

用法：
  # 先小规模验证（只转前 90 秒）
  python tools/transcribe.py --audio "xxx.mp3" --limit 90 --out test.tsv

  # 正式转写一整个文件
  python tools/transcribe.py --audio "xxx.mp3" --out xxx.tsv

  # 批量：转写一个目录（可递归），每个音频产出一个同名 .tsv
  python tools/transcribe.py --dir "audio/IELTS-剑桥真题" --outdir transcripts

  # 常用参数
  --model small.en        模型（small.en 快，medium.en 更准，large-v3 最准）
  --device auto           auto / cuda / cpu
  --compute int8_float16  GPU 用 int8_float16 或 float16；CPU 用 int8
  --lang en               语言
  --limit 90              只处理前 N 秒（验证用）
  --start 0               从第 N 秒开始
"""

import argparse
import gc
import re
import os
import sys
import time

def fmt_ts(sec):
    """秒 → TSV 用的秒字符串（保留两位小数）"""
    return f"{max(0.0, sec):.2f}"

def load_model(model_name, device, compute, quiet=False):
    from faster_whisper import WhisperModel

    if device == 'auto':
        try:
            import ctranslate2
            device = 'cuda' if ctranslate2.get_cuda_device_count() > 0 else 'cpu'
        except Exception:
            device = 'cpu'

    if compute is None:
        compute = 'int8_float16' if device == 'cuda' else 'int8'

    if not quiet:
        print(f"[模型] {model_name}  设备={device}  精度={compute}", flush=True)
    if device == 'cuda':
        # 显式带上 cudnn/cublas 的 DLL 目录（pip 装的 nvidia-* 包）
        _preload_cuda_dlls()

    def _tag(m, d):
        # 把实际设备记在模型对象上：free_model 自己就能取到，
        # 调用方不必再单独维护 device 变量（少一个出错的地方）
        try:
            m._dsh_device = d
        except Exception:
            pass
        return m

    try:
        return _tag(WhisperModel(model_name, device=device, compute_type=compute), device)
    except Exception as e:
        if device == 'cuda':
            print(f"[警告] GPU 初始化失败（{e}），回退到 CPU", flush=True)
            return _tag(WhisperModel(model_name, device='cpu', compute_type='int8'), 'cpu')
        raise

def free_model(model, device=None):
    """
    释放模型与显存。

    为什么必须做：批量转写时实测【每处理一个文件显存涨约 420MB】，
    到第 3 个文件就报
        Unable to allocate 418. MiB for an array with shape (1,136389,201) complex128
    根因是 VAD 的 ONNX 会话与 CTranslate2 的显存没被回收，模型常驻也一直占着。
    所以批量模式下改成【每个文件重建模型】，用完立即释放。
    """
    if device is None:
        device = getattr(model, '_dsh_device', None)
    try:
        del model
    except Exception:
        pass
    gc.collect()
    try:
        import torch
        if device == 'cuda' and torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
    except Exception:
        pass
    gc.collect()

def _preload_cuda_dlls():
    """
    把 pip 安装的 nvidia 库目录加入 DLL 搜索路径。

    坑：nvidia.cublas / nvidia.cudnn 是【命名空间包】，它的 __file__ 是 None，
    必须用 __path__ 才能拿到真实目录（否则会报
    "expected str, bytes or os.PathLike object, not NoneType"）。
    """
    try:
        import importlib
        for pkg in ('cublas', 'cudnn'):
            try:
                mod = importlib.import_module(f'nvidia.{pkg}')
            except Exception:
                continue
            bases = list(getattr(mod, '__path__', []) or [])
            if not bases and getattr(mod, '__file__', None):
                bases = [os.path.dirname(mod.__file__)]
            for base in bases:
                for sub in ('bin', 'lib'):
                    d = os.path.join(base, sub)
                    if os.path.isdir(d):
                        try:
                            os.add_dll_directory(d)
                        except Exception:
                            pass
                        os.environ['PATH'] = d + os.pathsep + os.environ.get('PATH', '')
    except Exception:
        pass

def transcribe_one(model, audio, out_path, lang, limit, start, verbose=True, max_chars=90,
                   use_vad=True, beam_size=5):
    """
    转写单个音频。

    为什么开启 word_timestamps 并按标点切句：
      whisper 默认按「停顿」分段。而雅思听力里的长对话经常连绵不断，
      实测会出现单段跨 62 秒的情况（[63.19 - 125.96]），一段几十句挤在一起，
      做滚动歌词完全没法用。
      开启词级时间戳后，可以拿到每个词的时间，再按标点/字数重新切成短句。

    use_vad 参数说明：
      VAD（静音检测）能把静音段切掉、减少幻觉，但它的 ONNX 会话【会泄漏内存】——
      实测跑几个文件后开始报
          Unable to allocate 369. MiB ... complex128
          mkl_malloc: failed to allocate memory
      内存紧张或长批量时建议关掉（--no-vad）。对听力材料影响不大，
      因为考试录音本身就带明显停顿，且我们随后会按标点切句。
    """
    t0 = time.time()
    kwargs = dict(
        language=lang,
        beam_size=beam_size,
        condition_on_previous_text=False,     # 长音频下更稳，避免错误累积
        word_timestamps=True,                 # 需要它才能按标点重新切句
    )
    if use_vad:
        kwargs['vad_filter'] = True
        kwargs['vad_parameters'] = dict(min_silence_duration_ms=500)

    segments, info = model.transcribe(audio, **kwargs)

    rows = []
    for seg in segments:
        if limit and seg.start > (start + limit):
            break
        if seg.end < start:
            continue
        for s, e, text in split_segment(seg, max_chars):
            rows.append((fmt_ts(s), fmt_ts(e), text))

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, 'w', encoding='utf-8') as f:
        for s, e, t in rows:
            f.write(f"{s}\t{e}\t{t}\n")

    dt = time.time() - t0
    audio_dur = info.duration
    speed = (audio_dur / dt) if dt > 0 else 0
    longest = max((float(e) - float(s) for s, e, _ in rows), default=0)
    print(f"[完成] {os.path.basename(out_path)}  "
          f"{len(rows)} 句  最长句 {longest:.1f}s  音频 {audio_dur:.0f}s  耗时 {dt:.1f}s  速度 {speed:.1f}x",
          flush=True)

    if verbose and rows:
        print("  前 3 句:")
        for s, e, t in rows[:3]:
            print(f"    [{s}-{e}] {t[:80]}")
    return len(rows)


def split_segment(seg, max_chars=90):
    """
    把一个 whisper 段按标点和长度重新切成短句，用词级时间戳定界。
    返回 [(start, end, text), ...]

    额外保护：whisper 在 VAD 边界偶尔会给出异常的词级时间戳
    （实测有一条 1 秒的句子被标成 69.7 秒）。这里做个合理性检查：
    某个词若跨度超过 MAX_WORD_SPAN 秒，就把它压到与前一个词相同的时刻，
    避免长出荒谬的区间。
    """
    MAX_WORD_SPAN = 5.0

    words = getattr(seg, 'words', None)
    if not words:
        text = (seg.text or '').strip()
        return [(seg.start, seg.end, text)] if text else []

    # 归一化词级时间戳
    fixed = []
    for i, w in enumerate(words):
        s, e = float(w.start), float(w.end)
        if e - s > MAX_WORD_SPAN or e < s:
            # 异常跨度：退回紧邻上一个词的结束时刻
            prev_end = fixed[-1][1] if fixed else s
            s = max(prev_end, s)
            e = s + 0.3
        if fixed and s < fixed[-1][1]:
            s = fixed[-1][1]
            if e < s:
                e = s + 0.3
        fixed.append((s, e, w.word))

    chunks = []
    cur = []

    def flush():
        if not cur:
            return
        text = ''.join(x[2] for x in cur).strip()
        if text:
            chunks.append((cur[0][0], cur[-1][1], text))
        cur.clear()

    for s, e, tok in fixed:
        cur.append((s, e, tok))
        text_len = sum(len(x[2]) for x in cur)
        if tok.rstrip().endswith(('.', '?', '!')) or text_len >= max_chars:
            flush()
    flush()

    if not chunks:
        text = (seg.text or '').strip()
        return [(seg.start, seg.end, text)] if text else []

    return redistribute_long(chunks)


def redistribute_long(chunks, max_span=12.0, hard_cap=15.0):
    """
    处理 whisper 对齐失败的过长块。

    现象：偶尔会把很短的句子标成超长区间。实测 322 句里有 1 句
    「listen carefully and answer questions 31 to 40.」被标成 [1352-1417]（64 秒），
    原因是 VAD 把一整段静音也算进了该段，跨度被拉满。

    处理：
      1. 能按逗号/分号切就切，按字符数分摊；
      2. 切不动就按长度平均切；
      3. 关键在于最后一步 —— 无论怎么切，这段的【总显示时长】封顶到
         按字符数估算的合理值（听力语速约 15 字符/秒，上限 hard_cap 秒）。
         起始时间保持真实，所以它仍出现在正确位置，只是不会在歌词面板里霸占一分钟。
    """
    out = []
    for s, e, text in chunks:
        span = e - s
        if span <= max_span or len(text) < 30:
            out.append((s, e, text))
            continue

        parts = [p for p in re.split(r'(?<=[,;:])\s+', text) if p.strip()]
        if len(parts) < 2:
            n = max(2, int(span / max_span) + 1)
            size = max(1, len(text) // n)
            parts = [text[i:i + size] for i in range(0, len(text), size)]

        total = sum(len(p) for p in parts) or 1
        est = min(span, max(1.5, len(text) / 15.0), hard_cap)
        t = s
        for p in parts:
            share = est * (len(p) / total)
            out.append((t, t + share, p.strip()))
            t += share
    return out

def main():
    ap = argparse.ArgumentParser(description='用 faster-whisper 生成句级时间戳字幕')
    ap.add_argument('--audio', help='单个音频文件')
    ap.add_argument('--dir', help='批量：目录（可递归）')
    ap.add_argument('--out', help='单文件模式的输出 TSV')
    ap.add_argument('--outdir', default='transcripts', help='批量模式的输出目录')
    ap.add_argument('--model', default='small.en', help='模型名，默认 small.en')
    ap.add_argument('--device', default='auto', choices=['auto', 'cuda', 'cpu'])
    ap.add_argument('--compute', default=None, help='int8_float16 / float16 / int8')
    ap.add_argument('--lang', default='en')
    ap.add_argument('--limit', type=float, default=0, help='只处理前 N 秒（0=全部）')
    ap.add_argument('--start', type=float, default=0, help='从第 N 秒开始')
    ap.add_argument('--skip-existing', action='store_true', help='批量时跳过已有 tsv')
    ap.add_argument('--beam', type=int, default=5,
                    help='束搜索宽度；内存紧张时降到 1，能显著降低内存占用')
    ap.add_argument('--no-vad', action='store_true',
                    help='关闭静音检测（内存紧张时用，可避免 ONNX 会话内存泄漏）')
    args = ap.parse_args()

    if not args.audio and not args.dir:
        ap.error('需要 --audio 或 --dir')

    if args.audio:
        if not os.path.isfile(args.audio):
            print(f"[错误] 找不到音频：{args.audio}")
            sys.exit(1)
        model = load_model(args.model, args.device, args.compute)
        out = args.out or (os.path.splitext(args.audio)[0] + '.tsv')
        transcribe_one(model, args.audio, out, args.lang, args.limit, args.start,
                       use_vad=not args.no_vad, beam_size=args.beam)
        print(f"\n转 LRC：node tools/lrc-from-srt.js \"{out}\"")
        return

    # 批量
    exts = ('.mp3', '.m4a', '.wav', '.ogg', '.flac', '.opus', '.webm', '.mp4')
    files = []
    for root, _dirs, names in os.walk(args.dir):
        for n in sorted(names):
            if n.lower().endswith(exts):
                files.append(os.path.join(root, n))

    if not files:
        print(f"[错误] {args.dir} 下没找到音频")
        sys.exit(1)

    print(f"[批量] 共 {len(files)} 个音频，输出到 {args.outdir}")
    print("[批量] 每个文件会重建模型并释放显存（避免长批量显存泄漏）\n", flush=True)
    total_seg = 0
    t_all = time.time()
    for i, f in enumerate(files, 1):
        rel = os.path.relpath(f, args.dir)
        out = os.path.join(args.outdir, os.path.splitext(rel)[0] + '.tsv')
        if args.skip_existing and os.path.exists(out):
            print(f"[{i}/{len(files)}] 跳过（已存在）{rel}", flush=True)
            continue
        print(f"[{i}/{len(files)}] {rel}", flush=True)
        model = None
        device = None
        try:
            # 每个文件重建模型：显存泄漏的根治办法（见 free_model 的注释）
            model = load_model(args.model, args.device, args.compute, quiet=True)
            total_seg += transcribe_one(model, f, out, args.lang, args.limit, args.start,
                                        use_vad=not args.no_vad, beam_size=args.beam)
        except Exception as e:
            print(f"  [失败] {e}", flush=True)
        finally:
            if model is not None:
                free_model(model, device)

    dt = time.time() - t_all
    print(f"\n[全部完成] {len(files)} 个文件，{total_seg} 句，总耗时 {dt/60:.1f} 分钟")
    print(f"输出目录：{args.outdir}")

if __name__ == '__main__':
    main()

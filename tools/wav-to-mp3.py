#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
wav-to-mp3.py — 把演示语料的 WAV 转成 MP3（为了 APK 体积）

为什么要做这件事：
    APK 里的音频**必须不压缩存放**（STORED），因为 MainActivity 用
    getAssets().openFd() 定位字节区间来实现进度条拖动 —— 压缩过的资源拿不到
    FileDescriptor，播放和拖动都会坏。于是 WAV 的体积就原样进了安装包：
    四套演示语料 51 MB，占了精简版 APK 的绝大部分。

    演示语料是 16 kHz 单声道 SAPI 合成音，对语音来说 64 kbps MP3 完全够用，
    体积能降到约 1/4（51 MB → 13 MB）。

注意：
    · 只动 audio/ 下的 .wav（演示语料），转完删掉原 WAV（同名 .wav 和 .mp3
      会同时被扫描成两门课）。
    · LRC 时间轴不受影响（时间戳与容器无关），MP3 编码器延迟约 26ms，可忽略。
    · 其它素材（雅思/六级 mp3）本来就是 mp3，不会碰。

用法：
    python tools/wav-to-mp3.py                 # 转 audio/ 下全部 .wav（dry-run 报告）
    python tools/wav-to-mp3.py --write         # 真正转换并删除原 WAV
    python tools/wav-to-mp3.py --bitrate 48    # 改码率（默认 64k）
"""

import argparse
import os
import sys

import av

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUDIO = os.path.join(ROOT, 'audio')


def transcode(src, dst, bitrate='64k'):
    """WAV → MP3（单声道，保持原采样率）"""
    inp = av.open(src, 'r')
    out = av.open(dst, 'w', format='mp3')
    try:
        istream = inp.streams.audio[0]
        ostream = out.add_stream('libmp3lame', rate=istream.codec_context.sample_rate)
        ostream.bit_rate = int(bitrate.rstrip('k')) * 1000
        ostream.layout = 'mono'

        resampler = av.AudioResampler(format='s16p', layout='mono',
                                      rate=istream.codec_context.sample_rate)
        for frame in inp.decode(istream):
            for rf in resampler.resample(frame):
                for packet in ostream.encode(rf):
                    out.mux(packet)
        for packet in ostream.encode(None):
            out.mux(packet)
    finally:
        out.close()
        inp.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--write', action='store_true', help='真正转换（默认只看报告）')
    ap.add_argument('--bitrate', default='64k', help='MP3 码率，默认 64k')
    args = ap.parse_args()

    targets = []
    for dirpath, _dirs, files in os.walk(AUDIO):
        for name in files:
            if name.lower().endswith('.wav'):
                targets.append(os.path.join(dirpath, name))

    if not targets:
        print('audio/ 下没有 .wav 文件。')
        return 0

    total = sum(os.path.getsize(p) for p in targets)
    print(f'\n找到 {len(targets)} 个 WAV，合计 {total / 1048576:.1f} MB')
    print(f'码率 {args.bitrate}（单声道）\n')

    saved = 0
    for src in targets:
        dst = src[:-4] + '.mp3'
        size = os.path.getsize(src)
        if not args.write:
            print(f'  {os.path.relpath(src, ROOT)}  {size / 1048576:.1f} MB → (dry-run)')
            continue
        try:
            transcode(src, dst, args.bitrate)
        except Exception as e:                       # noqa: BLE001
            print(f'  [失败] {os.path.relpath(src, ROOT)}：{e}')
            if os.path.exists(dst):
                os.remove(dst)
            continue
        new_size = os.path.getsize(dst)
        saved += size - new_size
        os.remove(src)                               # 同名 .wav/.mp3 会变成两门课
        print(f'  {os.path.relpath(src, ROOT)}  {size / 1048576:.1f} MB → '
              f'{new_size / 1048576:.1f} MB')

    if args.write:
        print(f'\n共省下 {saved / 1048576:.1f} MB。')
        print('接着重建 APK：node tools/build-apk.js --audio-set=CET4-演示,... --out=…\n')
    else:
        print('\n这是 dry-run；加 --write 才会真的转换。\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())

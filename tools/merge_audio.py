#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
merge_audio.py — 把同一个 Test 的 Part1-4 音频合并成一个整卷文件

背景：
  素材里有一批是按 Part 拆开的（IELTS20_Test1_Part1..Part4），
  播放器里希望和别的整卷格式统一，所以需要真正拼成一个文件。

为什么不能直接字节拼接：
  mp3 每段都有自己的 ID3 头与帧边界，简单拼接会得到能播但时长错乱、
  进度条乱跳的文件。这里用 PyAV 解码后重新编码，保证结果规整。

用法：
  python tools/merge_audio.py --out "C20-Test1.mp3" part1.mp3 part2.mp3 part3.mp3 part4.mp3
  python tools/merge_audio.py --out out.mp3 --bitrate 128k *.mp3
"""

import argparse
import os
import sys

import av


def merge(parts, out_path, bitrate='128k'):
    parts = [p for p in parts if os.path.isfile(p)]
    if not parts:
        raise SystemExit('没有可用的输入文件')

    # 探测第一个文件的参数，作为输出参数
    with av.open(parts[0]) as first:
        in_stream = first.streams.audio[0]
        rate = in_stream.codec_context.sample_rate
        layout = in_stream.codec_context.layout

    print(f"[合并] {len(parts)} 个文件 → {os.path.basename(out_path)}")
    print(f"       采样率 {rate}  声道布局 {layout}  码率 {bitrate}")

    out = av.open(out_path, mode='w', format='mp3')
    try:
        ostream = out.add_stream('mp3', rate=rate)
        ostream.bit_rate = int(bitrate.rstrip('k')) * 1000
        try:
            ostream.layout = layout
        except Exception:
            pass

        total_sec = 0.0
        for i, p in enumerate(parts, 1):
            with av.open(p) as container:
                st = container.streams.audio[0]
                st.thread_type = 'AUTO'
                n = 0
                for frame in container.decode(st):
                    total_sec += float(frame.samples) / float(frame.sample_rate or rate)
                    # 统一成输出流的格式，避免参数不一致
                    frame.pts = None
                    for packet in ostream.encode(frame):
                        out.mux(packet)
                    n += 1
                dur = 0.0
                if st.duration and st.time_base:
                    dur = float(st.duration * st.time_base)
                print(f"       [{i}/{len(parts)}] {os.path.basename(p)[:56]}  "
                      f"{n} 帧  约 {dur:.1f}s")

        for packet in ostream.encode(None):
            out.mux(packet)
    finally:
        out.close()

    size = os.path.getsize(out_path)
    print(f"[完成] {os.path.basename(out_path)}  {size/1048576:.1f} MB  约 {total_sec:.0f}s")
    return total_sec


def main():
    ap = argparse.ArgumentParser(description='合并多个音频为一个 MP3')
    ap.add_argument('--out', required=True, help='输出文件')
    ap.add_argument('--bitrate', default='128k')
    ap.add_argument('parts', nargs='+', help='按顺序排列的输入文件')
    args = ap.parse_args()

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    merge(args.parts, args.out, args.bitrate)


if __name__ == '__main__':
    main()

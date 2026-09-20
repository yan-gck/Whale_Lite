#!/usr/bin/env node
/**
 * media-duration.js — 读取音频文件时长（只用内置模块，不解码音频）
 *
 * 为什么需要：播放器列表要显示时长，此前只有 WAV 能解析（而且 SAPI 的
 * 18 字节 fmt chunk 还踩过坑）。美国国务院的对话、VOA 节目都是 MP3，
 * 没有时长就没法做估算时间轴，列表上也是空白。
 *
 * 支持：
 *   .wav    遍历 RIFF chunk 取 byteRate 与 data 长度
 *   .mp3    解析帧头；支持 Xing/Info（VBR）与 VBRI 头，无则按 CBR 估算
 *   .flac   读 STREAMINFO 的 total samples 与 sample rate
 *   .m4a/.mp4  解析 moov/mvhd 的时长
 *
 * CLI：
 *   node tools/media-duration.js <文件…>         打印时长
 *   node tools/media-duration.js --json <文件…> 输出 JSON
 */

'use strict';

const fs = require('node:fs');

// ---------------------------------------------------------------- WAV

function wavDuration(buf) {
  if (buf.length < 12) return 0;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return 0;

  let pos = 12;
  let byteRate = 0;
  let dataBytes = 0;

  while (pos < buf.length - 8) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readInt32LE(pos + 4);
    if (size < 0) break;

    if (id === 'fmt ') {
      // WAVEFORMATEX: nAvgBytesPerSec 在偏移 8
      if (size >= 12 && pos + 8 + 12 <= buf.length) byteRate = buf.readInt32LE(pos + 8 + 8);
    } else if (id === 'data') {
      dataBytes = size;
      break;
    }
    pos += 8 + size + (size % 2);
  }

  return byteRate > 0 && dataBytes > 0 ? dataBytes / byteRate : 0;
}

// ---------------------------------------------------------------- MP3

const MPEG_VERSIONS = { 0: 2.5, 2: 2, 3: 1 };
const LAYERS = { 1: 3, 2: 2, 3: 1 };
// [version][layer] → 比特率表索引
const BITRATES = {
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const SAMPLE_RATES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 2.5: [11025, 12000, 8000] };

/** 在 [from, to) 里找下一个合法帧头，返回帧信息 */
function findFrame(buf, from, to) {
  for (let i = from; i < to - 4; i++) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;

    const b1 = buf[i + 1];
    const b2 = buf[i + 2];
    const versionBits = (b1 >> 3) & 0x03;
    const layerBits = (b1 >> 1) & 0x03;
    if (versionBits === 1 || layerBits === 0) continue;   // 保留值

    const version = MPEG_VERSIONS[versionBits];
    const layer = LAYERS[layerBits];
    const brKey = `${version === 1 ? 1 : 2}-${layer}`;
    const brIdx = (b2 >> 4) & 0x0f;
    const srIdx = (b2 >> 2) & 0x03;
    if (brIdx === 0 || brIdx === 15 || srIdx === 3) continue;

    const bitrate = BITRATES[brKey] && BITRATES[brKey][brIdx];
    const sampleRate = SAMPLE_RATES[version] && SAMPLE_RATES[version][srIdx];
    if (!bitrate || !sampleRate) continue;

    const padding = (b2 >> 1) & 0x01;
    const samplesPerFrame = layer === 1 ? 384 : (layer === 3 && version !== 1 ? 576 : 1152);
    const frameLen = layer === 1
      ? Math.floor((12 * bitrate * 1000 / sampleRate + padding) * 4)
      : Math.floor(samplesPerFrame / 8 * bitrate * 1000 / sampleRate + padding);

    if (frameLen < 24) continue;
    return { offset: i, bitrate, sampleRate, samplesPerFrame, frameLen, version, layer, channelMode: (buf[i + 3] >> 6) & 0x03 };
  }
  return null;
}

function mp3Duration(buf) {
  // ID3v2 头：跳过
  let start = 0;
  if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'ID3') {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    start = 10 + size;
  }

  const first = findFrame(buf, start, Math.min(buf.length, start + 200000));
  if (!first) return 0;

  // Xing / Info 头（VBR）：位于第一帧内，跳过帧头与边信息
  const sideInfo = first.version === 1
    ? (first.channelMode === 3 ? 17 : 32)
    : (first.channelMode === 3 ? 9 : 17);
  const tagOffset = first.offset + 4 + sideInfo;

  if (tagOffset + 12 <= buf.length) {
    const tag = buf.toString('ascii', tagOffset, tagOffset + 4);
    if (tag === 'Xing' || tag === 'Info') {
      const flags = buf.readUInt32BE(tagOffset + 4);
      let p = tagOffset + 8;
      if (flags & 0x0001) {   // 有帧数
        const frames = buf.readUInt32BE(p);
        if (frames > 0) return (frames * first.samplesPerFrame) / first.sampleRate;
      }
    }
    // VBRI 头（Fraunhofer VBR）：固定在第一帧偏移 32 处
    const vbri = buf.toString('ascii', first.offset + 4 + 32, first.offset + 4 + 36);
    if (vbri === 'VBRI') {
      const frames = buf.readUInt32BE(first.offset + 4 + 32 + 14);
      if (frames > 0) return (frames * first.samplesPerFrame) / first.sampleRate;
    }
  }

  // CBR：用文件剩余长度 / 码率
  const dataBytes = buf.length - first.offset;
  return dataBytes / (first.bitrate * 1000 / 8);
}

// ---------------------------------------------------------------- FLAC

function flacDuration(buf) {
  if (buf.length < 42 || buf.toString('ascii', 0, 4) !== 'fLaC') return 0;

  // 第一个 metadata block 头在偏移 4，块数据从偏移 8 开始。
  // STREAMINFO 布局（共 34 字节）：
  //   0-1   minBlockSize
  //   2-3   maxBlockSize
  //   4-6   minFrameSize
  //   7-9   maxFrameSize      ← 之前把这里误当成 totalSamples，算出了荒谬的时长
  //   10-12 20bit sampleRate + 3bit channels + 5bit bps 的高位
  //   13-17 4bit bps 低位 + 36bit totalSamples
  const type = buf[4] & 0x7f;
  if (type !== 0) return 0;

  const p = 8;   // STREAMINFO 数据起点

  const b10 = buf[p + 10], b11 = buf[p + 11], b12 = buf[p + 12];
  const sampleRate = (b10 << 12) | (b11 << 4) | (b12 >> 4);

  const b13 = buf[p + 13];
  const totalSamples =
      (b13 & 0x0f) * 2 ** 32
    + buf[p + 14] * 2 ** 24
    + buf[p + 15] * 2 ** 16
    + buf[p + 16] * 2 ** 8
    + buf[p + 17];

  return sampleRate > 0 && totalSamples > 0 ? totalSamples / sampleRate : 0;
}

// ---------------------------------------------------------------- M4A / MP4

function mp4Duration(buf) {
  // 递归找 moov → mvhd，读 timescale 与 duration
  function findBox(from, to, name) {
    let p = from;
    while (p + 8 <= to) {
      const size = buf.readUInt32BE(p);
      const type = buf.toString('ascii', p + 4, p + 8);
      if (size < 8) break;
      if (type === name) return { start: p + 8, end: Math.min(p + size, to) };
      p += size;
    }
    return null;
  }

  const moov = findBox(0, buf.length, 'moov');
  if (!moov) return 0;
  const mvhd = findBox(moov.start, moov.end, 'mvhd');
  if (!mvhd) return 0;

  const version = buf[mvhd.start];
  if (version === 1) {
    const timescale = buf.readUInt32BE(mvhd.start + 20);
    const duration = Number(buf.readBigUInt64BE(mvhd.start + 24));
    return timescale > 0 ? duration / timescale : 0;
  }
  const timescale = buf.readUInt32BE(mvhd.start + 12);
  const duration = buf.readUInt32BE(mvhd.start + 16);
  return timescale > 0 ? duration / timescale : 0;
}

// ---------------------------------------------------------------- 统一入口

/**
 * 判断真实容器格式。
 *
 * 实测坑：有些文件扩展名写着 .mp3，内容却是 MP4 容器（开头是 00 00 00 xx 'ftyp'），
 * 按 MP3 帧头去找永远找不到，时长就算不出来。所以必须按【内容】判断，别信扩展名。
 */
function sniffFormat(buf) {
  if (buf.length < 12) return 'unknown';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') return 'wav';
  if (buf.toString('ascii', 0, 4) === 'fLaC') return 'flac';
  if (buf.toString('ascii', 4, 8) === 'ftyp') return 'mp4';
  // ID3v2 标签后面跟的才是 MP3
  if (buf.toString('ascii', 0, 3) === 'ID3') return 'mp3';
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3';
  // 有些 MP4 前面塞了别的 box，往后找一下 ftyp
  const head = buf.subarray(0, 4096).toString('latin1');
  if (head.includes('ftyp')) return 'mp4';
  return 'unknown';
}

function mediaDuration(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return 0; }

  const fmt = sniffFormat(buf);

  try {
    if (fmt === 'wav') return wavDuration(buf);
    if (fmt === 'flac') return flacDuration(buf);
    if (fmt === 'mp4') return mp4Duration(buf);
    if (fmt === 'mp3') return mp3Duration(buf);
  } catch { return 0; }

  // 内容也认不出来时，按扩展名再赌一次
  const ext = file.toLowerCase().slice(file.lastIndexOf('.'));
  try {
    if (ext === '.wav') return wavDuration(buf);
    if (ext === '.mp3') return mp3Duration(buf);
    if (ext === '.flac') return flacDuration(buf);
    if (ext === '.m4a' || ext === '.mp4' || ext === '.aac') return mp4Duration(buf);
  } catch { return 0; }

  return 0;
}

/** 返回 {format, duration}，便于诊断 */
function analyze(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return { format: 'unreadable', duration: 0 }; }
  return { format: sniffFormat(buf), duration: mediaDuration(file) };
}

function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--json');
  const asJson = process.argv.includes('--json');

  if (!args.length) {
    console.log(`用法：node tools/media-duration.js [--json] <音频文件…>

支持 .wav / .mp3 / .flac / .m4a / .mp4（只读头部，不解码音频）
mp3 支持 Xing/Info（VBR）与 VBRI 头，无则按 CBR 估算。`);
    process.exit(1);
  }

  const out = [];
  for (const f of args) {
    const secs = mediaDuration(f);
    out.push({ file: f, duration: Number(secs.toFixed(2)) });
    if (!asJson) {
      console.log(secs > 0
        ? `${secs.toFixed(2)}s\t${f}`
        : `未知\t${f}`);
    }
  }
  if (asJson) console.log(JSON.stringify(out, null, 2));
}

if (require.main === module) main();

module.exports = { mediaDuration, analyze, sniffFormat, wavDuration, mp3Duration, flacDuration, mp4Duration };

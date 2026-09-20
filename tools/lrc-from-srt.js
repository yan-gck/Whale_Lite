#!/usr/bin/env node
/**
 * lrc-from-srt.js — 字幕 / 字幕 JSON  →  LRC 时间轴
 *
 * 支持的输入：
 *   .srt            标准 SubRip
 *   .vtt            WebVTT（含 <00:00:01.000> 行内时间标签，会转成 LRC 逐词标记）
 *   .json           TED 官方字幕（{captions:[{startTime,duration,content}]}，毫秒）
 *   .tsv / .txt     每行 "start<TAB>end<TAB>text"，或 "start<TAB>text"
 *
 * 用法：
 *   node tools/lrc-from-srt.js <输入文件> [输出.lrc]
 *   node tools/lrc-from-srt.js in.srt out.lrc --offset=1.25 --merge=3 --maxlen=90
 *
 * 选项：
 *   --offset=<秒>     整体平移时间轴（正数=字幕往后挪）
 *   --merge=<秒>      相邻字幕间隔小于该值就合并成一行（默认 0.6，设 0 关闭）
 *   --maxlen=<字符数> 超过则另起一行（默认 100）
 *   --title=<文本>    写入 [ti:] 元信息
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ------------------------------------------------------------ 参数解析

function parseArgs(argv) {
  const opts = { offset: 0, merge: 0.6, maxlen: 100, title: '' };
  const positional = [];
  for (const a of argv) {
    const m = /^--([a-zA-Z]+)=(.*)$/.exec(a);
    if (m) {
      const [, k, v] = m;
      if (k === 'offset') opts.offset = Number(v) || 0;
      else if (k === 'merge') opts.merge = Number(v);
      else if (k === 'maxlen') opts.maxlen = Number(v) || 100;
      else if (k === 'title') opts.title = v;
      else console.warn(`[warn] 未知选项 --${k}，已忽略`);
    } else {
      positional.push(a);
    }
  }
  if (!Number.isFinite(opts.merge)) opts.merge = 0.6;
  return { opts, positional };
}

// ------------------------------------------------------------ 时间解析

/** "00:01:02,500" / "01:02.500" / "62.5" → 秒 */
function parseTimestamp(str) {
  const s = String(str).trim().replace(',', '.');
  const parts = s.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return NaN;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return NaN;
}

// ------------------------------------------------------------ 各格式解析

/** SRT / VTT 通用：返回 [{start,end,text,words?}] */
function parseSrtLike(content) {
  const text = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  // 按空行切块
  const blocks = text.split(/\n{2,}/);
  const cues = [];

  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    if (/^WEBVTT/i.test(lines[0])) continue;

    // 找时间行
    let ti = lines.findIndex((l) => l.includes('-->'));
    if (ti === -1) continue;

    const [rawStart, rawRest] = lines[ti].split('-->');
    const start = parseTimestamp(rawStart);
    const end = parseTimestamp((rawRest || '').trim().split(/\s+/)[0]);
    if (!Number.isFinite(start)) continue;

    const bodyLines = lines.slice(ti + 1);
    const body = bodyLines.join(' ').replace(/<v[^>]*>|<\/v>|<c[^>]*>|<\/c>/g, '').trim();
    if (!body) continue;

    cues.push({
      start,
      end: Number.isFinite(end) ? end : start + 2,
      text: body.replace(/\s+/g, ' ').trim(),
      raw: body,
    });
  }

  // VTT 行内时间标签 → 逐词
  for (const cue of cues) {
    const wordRe = /<(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})>([^<]*)/g;
    const words = [];
    for (const m of cue.raw.matchAll(wordRe)) {
      const t = parseTimestamp(m[1]);
      if (Number.isFinite(t)) words.push({ time: t, text: m[2] });
    }
    if (words.length >= 2) {
      cue.words = words;
      cue.text = words.map((w) => w.text).join('').trim();
    }
    delete cue.raw;
  }

  return cues.sort((a, b) => a.start - b.start);
}

/** TED 官方字幕 JSON（毫秒） */
function parseTedJson(content) {
  let doc;
  try {
    doc = JSON.parse(content);
  } catch (err) {
    throw new Error('JSON 解析失败：' + err.message);
  }
  const caps = doc.captions || doc.subtitles || (Array.isArray(doc) ? doc : null);
  if (!Array.isArray(caps)) throw new Error('未找到 captions 数组');

  const cues = caps.map((c) => {
    // 毫秒字段：startTime / duration；秒字段：start / dur 兜底
    const start = c.startTime != null ? c.startTime / 1000
      : c.start != null ? c.start
        : NaN;
    const dur = c.duration != null ? c.duration / 1000
      : c.dur != null ? c.dur
        : 2;
    return {
      start,
      end: start + dur,
      text: String(c.content != null ? c.content : c.text || '').replace(/\n/g, ' ').trim(),
    };
  }).filter((c) => Number.isFinite(c.start) && c.text);

  return cues.sort((a, b) => a.start - b.start);
}

/** TSV / 纯文本："start<TAB>end<TAB>text" 或 "start<TAB>text" 或 "text" */
function parseTsv(content) {
  const cues = [];
  let last = 0;
  for (const raw of content.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const cols = line.split('\t');

    if (cols.length >= 3 && Number.isFinite(parseTimestamp(cols[0]))) {
      const start = parseTimestamp(cols[0]);
      const end = parseTimestamp(cols[1]);
      cues.push({ start, end: Number.isFinite(end) ? end : start + 2, text: cols.slice(2).join(' ').trim() });
    } else if (cols.length === 2 && Number.isFinite(parseTimestamp(cols[0]))) {
      const start = parseTimestamp(cols[0]);
      cues.push({ start, end: start + 2, text: cols[1].trim() });
    } else if (Number.isFinite(parseTimestamp(cols[0])) && cols.length === 1) {
      // 只有时间没有文本 → 视为分段点
      continue;
    } else {
      // 无时间戳：按每行 2 秒平均分配
      cues.push({ start: last, end: last + 2, text: line });
      last += 2;
    }
  }
  return cues;
}

// ------------------------------------------------------------ 合并 / 输出

/** 若上一条与当前条之间几乎没有停顿，且合计不过长，则合并为同一行 */
function mergeCues(cues, gap, maxlen) {
  const out = [];
  let buf = null;

  for (const cue of cues) {
    const plain = cue.text.replace(/\s+/g, ' ').trim();
    if (!plain) continue;

    if (buf && (cue.start - buf.end) <= gap && (buf.text.length + plain.length + 1) <= maxlen) {
      buf.text = (buf.text + ' ' + plain).trim();
      buf.end = Math.max(buf.end, cue.end);
    } else {
      if (buf) out.push(buf);
      buf = { start: cue.start, end: cue.end, text: plain, words: cue.words };
    }
  }
  if (buf) out.push(buf);
  return out;
}

function lrcTime(sec) {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${String(m).padStart(2, '0')}:${rest.toFixed(2).padStart(5, '0')}`;
}

/** 把一行内部按标点切成不超过 maxlen 的片段，返回 [{start,end,text}] */
function splitLongLine(cue, maxlen) {
  if (cue.text.length <= maxlen) return [cue];

  // 优先在 。.!?;； 处切
  const parts = cue.text.split(/(?<=[.!?;；。！？])\s+/).filter(Boolean);
  if (parts.length <= 1) return [cue];

  const dur = Math.max(0.5, cue.end - cue.start);
  const totalChars = parts.reduce((n, p) => n + p.length, 0) || 1;
  const out = [];
  let t = cue.start;
  for (const p of parts) {
    const d = dur * (p.length / totalChars);
    out.push({ start: t, end: t + d, text: p });
    t += d;
  }
  return out;
}

function toLrc(cues, opts) {
  const lines = [];
  if (opts.title) lines.push(`[ti:${opts.title}]`);
  lines.push('[by:listening-player lrc-from-srt]');
  if (opts.offset) lines.push(`[offset:${Math.round(opts.offset * 1000)}]`);

  for (const cue of cues) {
    const start = cue.start + opts.offset;
    if (start < 0) continue;

    if (cue.words && cue.words.length >= 2) {
      // 增强型 LRC：<mm:ss.xx> 逐词
      const body = cue.words
        .map((w) => `<${lrcTime(w.time + opts.offset)}>${w.text}`)
        .join('');
      lines.push(`[${lrcTime(start)}]${body}`);
    } else {
      lines.push(`[${lrcTime(start)}]${cue.text}`);
    }
  }
  return lines.join('\n') + '\n';
}

// ------------------------------------------------------------ main

function main() {
  const { opts, positional } = parseArgs(process.argv.slice(2));

  if (!positional.length) {
    console.log(`用法：node tools/lrc-from-srt.js <输入文件> [输出.lrc] [选项]

输入格式（按扩展名自动识别）：
  .srt            标准 SubRip 字幕
  .vtt            WebVTT（支持行内时间标签 → 逐词高亮）
  .json           TED 官方字幕 JSON
  .tsv / .txt     "起始秒<TAB>结束秒<TAB>文本"

选项：
  --offset=<秒>      整体平移时间轴（音频与字幕不同源时用来对齐）
  --merge=<秒>       间隔小于该值则合并成一行（默认 0.6，0 = 不合并）
  --maxlen=<字符数>  单行最长字符（默认 100）
  --title=<文本>     写入 [ti:] 标题`);
    process.exit(1);
  }

  const input = path.resolve(positional[0]);
  if (!fs.existsSync(input)) {
    console.error(`[error] 输入文件不存在：${input}`);
    process.exit(1);
  }

  const output = positional[1]
    ? path.resolve(positional[1])
    : path.join(path.dirname(input), path.basename(input, path.extname(input)) + '.lrc');

  const content = fs.readFileSync(input, 'utf8');
  const ext = path.extname(input).toLowerCase();

  let cues;
  try {
    if (ext === '.json') cues = parseTedJson(content);
    else if (ext === '.srt' || ext === '.vtt') cues = parseSrtLike(content);
    else cues = parseTsv(content);
  } catch (err) {
    console.error('[error] 解析失败：' + err.message);
    process.exit(1);
  }

  if (!cues.length) {
    console.error('[error] 没有解析出任何字幕条目，请检查文件格式。');
    process.exit(1);
  }

  let processed = mergeCues(cues, opts.merge, opts.maxlen);
  processed = processed.flatMap((c) => splitLongLine(c, opts.maxlen));

  const lrc = toLrc(processed, opts);
  fs.writeFileSync(output, lrc, 'utf8');

  const last = processed[processed.length - 1];
  console.log(`✅ 已生成 ${output}`);
  console.log(`   原始字幕条数：${cues.length}`);
  console.log(`   输出行数：${processed.length}`);
  console.log(`   时间跨度：${lrcTime(processed[0].start)} → ${lrcTime(last.start)}`);
  const wordLines = processed.filter((c) => c.words && c.words.length >= 2).length;
  if (wordLines) console.log(`   其中逐词高亮行：${wordLines}`);
}

if (require.main === module) main();

module.exports = { parseSrtLike, parseTedJson, parseTsv, mergeCues, toLrc, parseTimestamp, lrcTime };

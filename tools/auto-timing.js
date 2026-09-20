#!/usr/bin/env node
/**
 * auto-timing.js — 给「有原文但没时间轴」的资料包生成【估算】时间轴
 *
 * 为什么要这个：
 *   美国国务院的对话素材、VOA 的节目音频都只有音频（和文本），没有时间戳。
 *   没有 .lrc 时歌词面板就是空白的，"按时间戳滚动"这个核心体验直接消失。
 *   这里按【行长度加权】把原文铺满音频时长，得到一条能用的近似时间轴。
 *
 * ⚠️ 必须如实说明：这是**估算**，不是对齐结果。
 *    生成的行会在 meta.json 里标 autoTiming: "estimated"，
 *    播放器里该课程的元信息也会显示"时间轴为估算值"，避免误导。
 *    想要真正对齐，请用 faster-whisper 等工具出字幕，再用 lrc-from-srt.js 转换。
 *
 * 安全边界：
 *   · 只处理【没有时间轴】或【时间轴少于 2 行】的包
 *   · 已有 questions.json 的包一律跳过（那些题的 start/end 是精确校准过的，不能被覆盖）
 *   · 默认 dry-run，加 --write 才真正写文件
 *
 * 时长来源：
 *   1. meta.json 里的 duration
 *   2. 同名 .duration 缓存
 *   3. 都不存在则需用 --duration=<秒> 指定（脚本无法解码 mp3）
 *
 * 用法：
 *   node tools/auto-timing.js audio                 # 报告哪些包需要处理
 *   node tools/auto-timing.js audio --write         # 生成估算时间轴
 *   node tools/auto-timing.js audio --write --folder=AmericanEnglish
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga', '.opus', '.flac', '.webm', '.mp4']);

function arg(name, def) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return def;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
}

const WRITE = Boolean(arg('write', false));
const ONLY_FOLDER = arg('folder', '');
const FORCE_DURATION = Number(arg('duration', 0)) || 0;
const LEAD_IN = Number(arg('lead-in', 0.4)) || 0.4;   // 开头留白
const TAIL = Number(arg('tail', 0.6)) || 0.6;         // 结尾留白

function lrcTime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
}

/** 扫描资料包 */
function collect(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.isFile() || !AUDIO_EXT.has(path.extname(e.name).toLowerCase())) continue;

      const base = full.slice(0, full.length - path.extname(full).length);
      out.push({
        audio: full,
        base,
        name: path.basename(base),
        folder: path.basename(d),
      });
    }
  };
  walk(dir);
  return out;
}

function readMaybe(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
}

function countLrcLines(lrc) {
  if (!lrc) return 0;
  return lrc.split(/\r?\n/).filter((l) => {
    const t = l.trim();
    return t && !/^\[(ti|ar|al|by|offset|re|ve|length):/i.test(t) && /\[\d{1,3}:\d{1,2}/.test(t);
  }).length;
}

/** 按行长度加权，把各行铺满 [start, end] */
function distribute(lines, start, end) {
  const total = lines.reduce((n, l) => n + Math.max(1, l.length), 0);
  const span = Math.max(0.5, end - start);
  let t = start;
  return lines.map((l) => {
    const w = Math.max(1, l.length);
    const at = t;
    t += span * (w / total);
    return { time: Number(at.toFixed(2)), text: l };
  });
}

function main() {
  const target = process.argv[2] && !process.argv[2].startsWith('--')
    ? process.argv[2]
    : path.resolve(__dirname, '..', 'audio');

  if (!fs.existsSync(target)) {
    console.error('目录不存在：' + target);
    process.exit(1);
  }

  console.log('');
  console.log(WRITE ? '模式：写入（--write）' : '模式：仅报告（加 --write 才会写文件）');
  console.log('目录：' + target);
  console.log('');

  const packs = collect(target);
  let need = 0, done = 0, skipped = 0, noText = 0;

  console.log('资料包'.padEnd(46) + '时间轴行  文本行  时长    处理');
  console.log('─'.repeat(88));

  for (const p of packs) {
    if (ONLY_FOLDER && p.folder !== ONLY_FOLDER) continue;

    const lrcPath = p.base + '.lrc';
    const txtPath = p.base + '.txt';
    const qPath = p.base + '.questions.json';
    const metaPath = p.base + '.meta.json';

    const lrcLines = countLrcLines(readMaybe(lrcPath));
    if (lrcLines >= 2) continue;   // 已有可用时间轴

    // 有题目的包跳过：那些题的 start/end 是精确校准过的
    if (fs.existsSync(qPath)) {
      console.log(p.name.slice(0, 44).padEnd(46) + String(lrcLines).padStart(8)
        + '  —        —       跳过（有精确校准的题目）');
      skipped++;
      continue;
    }

    const raw = readMaybe(txtPath);
    if (!raw) {
      console.log(p.name.slice(0, 44).padEnd(46) + String(lrcLines).padStart(8)
        + '  无        —       跳过（没有原文）');
      noText++;
      continue;
    }

    // 拆行：去掉明显不是正文的行（来源说明、括号注释、超短行）
    const lines = raw.split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && l.length >= 2 && !/^[（(【\[]/.test(l) && !/^https?:/i.test(l))
      .slice(0, 60);

    if (lines.length < 2) {
      console.log(p.name.slice(0, 44).padEnd(46) + String(lrcLines).padStart(8)
        + '  ' + String(lines.length).padStart(6) + '   —       跳过（原文行数不足）');
      noText++;
      continue;
    }

    // 时长
    let dur = FORCE_DURATION;
    if (!dur) {
      const meta = readMaybe(metaPath);
      if (meta) { try { dur = Number(JSON.parse(meta).duration) || 0; } catch { /* 忽略 */ } }
    }
    if (!dur) dur = Number((readMaybe(p.base + '.duration') || '').trim()) || 0;

    if (!dur) {
      console.log(p.name.slice(0, 44).padEnd(46) + String(lrcLines).padStart(8)
        + '  ' + String(lines.length).padStart(6) + '   ?       跳过（时长未知，播放器首次播放后会回写）');
      noText++;
      continue;
    }

    need++;
    const timed = distribute(lines, LEAD_IN, Math.max(LEAD_IN + 1, dur - TAIL));

    console.log(p.name.slice(0, 44).padEnd(46) + String(lrcLines).padStart(8)
      + '  ' + String(lines.length).padStart(6) + '  ' + dur.toFixed(0).padStart(4) + 's   '
      + (WRITE ? '写入估算时间轴' : '待处理（估算）'));

    if (WRITE) {
      const title = (() => {
        const meta = readMaybe(metaPath);
        if (meta) { try { return JSON.parse(meta).title || p.name; } catch { /* 忽略 */ } }
        return p.name;
      })();

      const body = [
        `[ti:${title}]`,
        '[by:listening-player auto-timing]',
        '[re:时间轴为按行长度估算，非声学对齐]',
        `[length:${lrcTime(dur)}]`,
        ...timed.map((t) => `[${lrcTime(t.time)}]${t.text}`),
      ].join('\n') + '\n';

      fs.writeFileSync(lrcPath, body, 'utf8');

      // 在 meta 里标记，界面上会提示"时间轴为估算值"
      if (fs.existsSync(metaPath)) {
        try {
          const m = JSON.parse(readMaybe(metaPath));
          m.autoTiming = 'estimated';
          m.autoTimingNote = '时间轴由 tools/auto-timing.js 按行长度加权估算，未做声学对齐。';
          fs.writeFileSync(metaPath, JSON.stringify(m, null, 2), 'utf8');
        } catch { /* meta 损坏就不改 */ }
      }
      done++;
    }
  }

  console.log('─'.repeat(88));
  console.log(`需要处理：${need} 个　已写入：${done} 个　跳过（有题目）：${skipped} 个　无文本/无时长：${noText} 个`);
  console.log('');
  if (!WRITE && need) {
    console.log('确认后加 --write 写入。');
    console.log('提醒：生成的是【估算】时间轴，只保证"能滚、大致对得上"，');
    console.log('      要做精听请用 faster-whisper 出字幕再走 lrc-from-srt.js。');
    console.log('');
  }
}

if (require.main === module) main();

module.exports = { distribute, lrcTime, countLrcLines };

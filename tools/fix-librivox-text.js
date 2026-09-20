#!/usr/bin/env node
/**
 * fix-librivox-text.js — 用 Project Gutenberg 全文替换 archive.org 的 OCR 残片
 *
 * 背景（一次真实的踩坑）：
 *   LibriVox 的 archive.org 条目里带一个 `_djvu.txt`，看起来是"全文"，
 *   但它其实只是 LibriVox CD 封面 + 目录的 OCR 残片（实测仅 1383 字符，
 *   还夹杂 "KI®1LK] Eg" 这类乱码）。按它生成的时间轴是垃圾。
 *
 *   正确做法：LibriVox 朗读的都是公有领域文本，直接去 Project Gutenberg
 *   取权威全文（本书为 PG #1661，59 万字符），按故事切分后写入对应章节。
 *
 * 用法：node tools/fix-librivox-text.js [--dry-run]
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const LIBRIVOX_DIR = path.join(ROOT, 'audio', 'LibriVox');
const DRY = process.argv.includes('--dry-run');

// 本书对应 Project Gutenberg 编号
const PG_ID = 1661;
const PG_URL = `https://www.gutenberg.org/cache/epub/${PG_ID}/pg${PG_ID}.txt`;

/**
 * 故事定位。
 *
 * Gutenberg #1661 的结构：先是一份目录（"I.  A Scandal in Bohemia" 混合大小写），
 * 正文才是全大写标题（"I. A SCANDAL IN BOHEMIA"）。所以直接全文匹配
 * 大写罗马数字标题会先撞上目录，必须从正文的第一处开始切。
 */
const STORY_ORDER = [
  'A Scandal in Bohemia',
  'The Red-Headed League',
  'A Case of Identity',
  'The Boscombe Valley Mystery',
  'The Five Orange Pips',
  'The Man with the Twisted Lip',
  'The Adventure of the Blue Carbuncle',
  'The Adventure of the Speckled Band',
  'The Adventure of the Engineer\u2019s Thumb',
  'The Adventure of the Noble Bachelor',
  'The Adventure of the Beryl Coronet',
  'The Adventure of the Copper Beeches',
];

/** 每个故事被拆成几个音频章节（LibriVox 的分章方式） */
const PARTS = {
  'A Scandal in Bohemia': 3,
  'The Red-Headed League': 1,
};

/** 按正文里的全大写罗马数字标题切出各故事 */
function splitStories(text) {
  // 正文起点：第一次出现全大写标题的地方
  const bodyRe = /^\s*([IVX]+)\.\s+([A-Z][A-Z\u2019' \-]+)\s*$/gm;
  const all = [...text.matchAll(bodyRe)];
  if (!all.length) return {};

  const startIdx = all[0].index;
  const body = text.slice(startIdx);

  const marks = [...body.matchAll(/^\s*([IVX]+)\.\s+([A-Z][A-Z\u2019' \-]+)\s*$/gm)]
    .map((m) => ({ roman: m[1], title: m[2].trim(), index: m.index, end: m.index + m[0].length }));

  const out = {};
  marks.forEach((mk, i) => {
    out[mk.roman] = {
      title: mk.title,
      text: body.slice(mk.end, i + 1 < marks.length ? marks[i + 1].index : body.length).trim(),
    };
  });
  return out;
}

/** 罗马数字 → 序号 */
function romanToInt(s) {
  const map = { I: 1, V: 5, X: 10, L: 50, C: 100 };
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const cur = map[s[i]] || 0;
    const next = map[s[i + 1]] || 0;
    n += cur < next ? -cur : cur;
  }
  return n;
}

function main() {
  if (!fs.existsSync(LIBRIVOX_DIR)) {
    console.error('找不到目录：' + LIBRIVOX_DIR);
    process.exit(1);
  }

  const { download } = require('./fetch-resources.js');

  console.log('正在获取 Project Gutenberg 全文 …');
  return download(PG_URL, { expectBinary: false, timeoutMs: 300000 }).then((raw) => {
    // 去掉 PG 的页眉页脚
    let text = raw;
    const startMark = /\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*\*\*/i.exec(text);
    if (startMark) text = text.slice(startMark.index + startMark[0].length);
    const endMark = /\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK/i.exec(text);
    if (endMark) text = text.slice(0, endMark.index);
    text = text.replace(/\r\n?/g, '\n').trim();

    console.log(`全文 ${text.length} 字符`);

    const stories = splitStories(text);
    const romans = Object.keys(stories);
    if (!romans.length) {
      console.error('在全文里切不出故事，放弃处理');
      process.exit(1);
    }
    console.log(`切出 ${romans.length} 个故事：${romans.map((r) => `${r}=${stories[r].title}`).join('  ')}`);

    // 处理每个 LibriVox 章节包
    const files = fs.readdirSync(LIBRIVOX_DIR).filter((f) => f.endsWith('.meta.json'));
    let updated = 0;

    for (const mf of files) {
      const base = mf.replace(/\.meta\.json$/, '');
      const metaPath = path.join(LIBRIVOX_DIR, mf);
      let meta;
      try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { continue; }

      const title = String(meta.title || '');

      // 从标题里认出属于哪个故事。
      // 注意：LibriVox 的章节标题与 Gutenberg 的标题标点不一致
      // （"The Red Headed League" vs "The Red-Headed League"），
      // 所以先归一化掉连字符、撇号与多余空格再比较。
      const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
      const normTitle = norm(title);
      const idx = STORY_ORDER.findIndex((t) => normTitle.includes(norm(t)));
      if (idx < 0) {
        console.log(`  · 跳过（未能识别故事）：${title}`);
        continue;
      }
      const storyTitle = STORY_ORDER[idx];
      const roman = romans.find((r) => romanToInt(r) === idx + 1);
      const story = roman ? stories[roman] : null;
      if (!story || !story.text) {
        console.log(`  · 跳过（全文里没有第 ${idx + 1} 个故事）：${title}`);
        continue;
      }

      // 该章是故事的第几部分（LibriVox 把长故事拆成 Part 1/2/3）
      const partMatch = /Part\s+(\d+)/i.exec(title);
      const part = partMatch ? Number(partMatch[1]) : 1;
      const parts = PARTS[storyTitle] || 1;
      const perPart = Math.ceil(story.text.length / parts);
      const slice = story.text.slice((part - 1) * perPart, part * perPart);

      const txtPath = path.join(LIBRIVOX_DIR, `${base}.txt`);
      const body = [
        `${storyTitle}（第 ${part}/${parts} 部分）`,
        '',
        `本文件来自 Project Gutenberg #${PG_ID}（公有领域全文），对应本音频章节的朗读内容。`,
        `音频：LibriVox（公有领域录音）。章内无逐句时间戳，如需精确对齐请用 faster-whisper 生成字幕。`,
        '',
        '─'.repeat(60),
        '',
        slice.trim(),
      ].join('\n');

      if (DRY) {
        console.log(`  · [dry-run] ${base}.txt  ← ${storyTitle} 第 ${part} 部分，${slice.length} 字符`);
      } else {
        fs.writeFileSync(txtPath, body + '\n', 'utf8');
      }

      // 修 meta：说明原文来源与时间轴状态
      meta.source = `LibriVox / archive.org（${'the_adventures_of_sherlock_holmes_v5_1904_librivox'}）+ Project Gutenberg #${PG_ID} 全文`;
      meta.license = '音频：Public Domain（LibriVox）｜文本：Public Domain（Project Gutenberg）';
      meta.notes = `公有领域有声书，适合长时听力与泛听。章内无逐句时间戳；`
        + `原文为 Project Gutenberg 对应故事的第 ${part}/${parts} 部分。`;
      delete meta.autoTiming;
      delete meta.autoTimingNote;

      if (!DRY) fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');

      // 删掉基于 OCR 残片生成的垃圾时间轴（只留一个章节起点）
      const lrcPath = path.join(LIBRIVOX_DIR, `${base}.lrc`);
      if (fs.existsSync(lrcPath)) {
        const lrc = [
          `[ti:${meta.title}]`,
          '[by:listening-player]',
          '[re:章节级时间轴，章内无逐句时间戳]',
          `[length:${String(Math.floor((meta.duration || 0) / 60)).padStart(2, '0')}:${String(Math.round((meta.duration || 0) % 60)).padStart(2, '0')}.00]`,
          `[00:00.00]— ${storyTitle}（第 ${part}/${parts} 部分）—`,
        ].join('\n') + '\n';
        if (!DRY) fs.writeFileSync(lrcPath, lrc, 'utf8');
      }

      updated++;
      console.log(`  ✓ ${base}  ← ${storyTitle} 第 ${part} 部分（${slice.length} 字符）`);
    }

    console.log('');
    console.log(`处理完成：${updated} 个章节包${DRY ? '（dry-run，未写文件）' : ''}`);
    console.log('');
  });
}

if (require.main === module) {
  main().catch((e) => { console.error('[error] ' + e.message); process.exit(1); });
}

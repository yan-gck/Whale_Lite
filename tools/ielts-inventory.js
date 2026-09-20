#!/usr/bin/env node
/**
 * ielts-inventory.js — 清点并统一雅思听力素材
 *
 * 背景：素材来自多个渠道，命名五花八门，还有重叠：
 *   · 【雅思听力】…剑雅真题1-19（64集）   → "1.1.C 19-Test 01"      整卷，C4–C19
 *   · 【雅思听力剑雅真题】…1-20（80集）    → "69.18.C 03-Test 01"    整卷，但与上面重叠
 *   · 【IELTS合集】…中英字幕              → "1.IELTS21_Test1_Part1" 按 Part 拆分，C20/C21
 * 需要：识别重复、合并拆分、统一成一致命名。
 *
 * 用法：
 *   node tools/ielts-inventory.js scan              清点（按来源分组 + 找重复）
 *   node tools/ielts-inventory.js plan              给出统一命名与合并方案
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SRC_DIRS = [
  'F:/DSH workshop/【雅思听力】《剑雅真题1-19》听力+音频合集（共64集）_雅思听力磨耳朵素材',
];

const { mediaDuration } = require('./media-duration.js');

// ---------------------------------------------------------------- 文件名解析

/**
 * 从文件名里解析出 (书号, Test, Part)。
 *
 * ⚠️ 这里有个很容易搞错的陷阱：
 *   A 组（剑雅真题1-20 合集）的文件名形如
 *       "… - 69.18.C 03-Test 01(Av…,P69).mp3"
 *   里面的 "C 03" 是【合集内的编号】，不是剑桥书号！真正的书号要看最前面的序号：
 *       序号 = (书号 - 1) * 4 + Test
 *   69 → C18-Test1，77 → C20-Test1。
 *   我第一版就是把 "C 03" 当成书号，得出"C1"这种结论，幸好用「开头第一个词」核对音频时发现了。
 *
 *   对照：C 组（剑雅1-19 合集）形如 "… - 1.1.C 19-Test 01(Av…,P1).mp3"，
 *   这里的 "C 19" 才是真书号；两者格式相似但语义不同。
 *
 * 判定规则：只要文件名最前面有序号，就用序号推算书号；否则才用 "C nn"。
 */
function parseFile(name) {
  const base = name.replace(/\.(mp3|m4a|wav|flac|ogg)$/i, '');

  // 形式三：IELTS21_Test1_Part1（B 组，明写书号，最可靠）
  let m = /IELTS\s*(\d{1,2})\s*_?\s*Test\s*(\d)\s*_?\s*Part\s*(\d)/i.exec(base);
  if (m) {
    return { book: Number(m[1]), test: Number(m[2]), part: Number(m[3]), style: 'part', bookFrom: 'IELTSxx' };
  }

  // 最前面的序号
  const seqM = /-\s*(\d{1,3})\./.exec(base);
  const seq = seqM ? Number(seqM[1]) : null;

  // 是否属于「1-20 合集」（该合集用序号表示书号）
  const isSeqStyle = /剑雅真题1-20/.test(base) && seq !== null && seq >= 1 && seq <= 80;

  if (isSeqStyle) {
    const book = Math.floor((seq - 1) / 4) + 1;
    const test = ((seq - 1) % 4) + 1;
    return { book, test, part: null, style: 'full', bookFrom: 'seq', seq };
  }

  // 形式一：C 19-Test 01（明写书号）
  m = /C\s*(\d{1,2})\s*-\s*Test\s*0?(\d)/i.exec(base);
  if (m) {
    return { book: Number(m[1]), test: Number(m[2]), part: null, style: 'full', bookFrom: 'Cxx', seq };
  }

  return null;
}

/** 推测来源分组 */
function sourceOf(name) {
  if (/中英字幕/.test(name)) return 'B-中英字幕（按Part拆分）';
  if (/剑雅真题1-20/.test(name)) return 'A-1-20合集（整卷，与之重叠）';
  if (/剑雅真题1-19/.test(name)) return 'C-1-19合集（整卷）';
  return 'D-未知';
}

function main() {
  const cmd = process.argv[2] || 'scan';

  // 收集
  const items = [];
  for (const dir of SRC_DIRS) {
    if (!fs.existsSync(dir)) { console.log('目录不存在：' + dir); continue; }
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(mp3|m4a|wav|flac|ogg)$/i.test(f)) continue;
      const full = path.join(dir, f);
      const parsed = parseFile(f);
      const stat = fs.statSync(full);
      items.push({
        name: f, path: full, size: stat.size,
        source: sourceOf(f),
        ...(parsed || { book: null, test: null, part: null, style: 'unknown' }),
      });
    }
  }

  console.log('');
  console.log(`扫描到 ${items.length} 个音频，合计 ${(items.reduce((n, x) => n + x.size, 0) / 1048576).toFixed(0)} MB`);
  console.log('');

  // 分组统计
  const bySource = new Map();
  for (const it of items) {
    if (!bySource.has(it.source)) bySource.set(it.source, []);
    bySource.get(it.source).push(it);
  }
  console.log('=== 按来源 ===');
  for (const [s, list] of [...bySource].sort()) {
    const books = [...new Set(list.map((x) => x.book).filter(Boolean))].sort((a, b) => a - b);
    console.log(`  ${s}`);
    console.log(`      ${list.length} 个  ${(list.reduce((n, x) => n + x.size, 0) / 1048576).toFixed(0)} MB  `
      + `书号 ${books.join(', ') || '(未识别)'}`);
  }
  console.log('');

  // 按 (book, test) 归并，找重复
  const byTest = new Map();
  for (const it of items) {
    if (!it.book || !it.test) continue;
    const key = `C${it.book}-Test${it.test}`;
    if (!byTest.has(key)) byTest.set(key, []);
    byTest.get(key).push(it);
  }

  const dup = [];
  const partOnly = [];
  const single = [];
  for (const [key, list] of [...byTest].sort()) {
    const fulls = list.filter((x) => x.part === null);
    const parts = list.filter((x) => x.part !== null);
    if (fulls.length > 1) dup.push({ key, fulls, parts });
    else if (fulls.length === 0 && parts.length > 1) partOnly.push({ key, parts });
    else single.push({ key, list });
  }

  console.log('=== 重复（同一份 Test 有多个整卷文件）===');
  if (!dup.length) console.log('  无');
  for (const d of dup) {
    console.log(`  ${d.key}  →  ${d.fulls.length} 份整卷`);
    // 用前 512KB 的哈希判断内容是否相同
    const hashes = d.fulls.map((f) => ({
      f,
      h: crypto.createHash('md5').update(fs.readFileSync(f.path).subarray(0, 524288)).digest('hex').slice(0, 10),
    }));
    const same = new Set(hashes.map((x) => x.h)).size === 1;
    for (const x of hashes) {
      console.log(`      ${x.h}  ${(x.f.size / 1048576).toFixed(1).padStart(5)} MB  ${path.basename(x.f.path).slice(0, 70)}`);
    }
    console.log(`      内容${same ? '完全相同 → 保留一份即可' : '不同 → 需人工确认哪份更好'}`);
  }
  console.log('');

  console.log('=== 按 Part 拆分、需要合并的 ===');
  if (!partOnly.length) console.log('  无');
  for (const p of partOnly) {
    console.log(`  ${p.key}  →  ${p.parts.length} 个 Part  ${p.parts.map((x) => 'P' + x.part).join(' ')}`);
  }
  console.log('');

  // 汇总成一张"最终应有哪些课程"的表
  const finalTests = new Map();
  for (const it of items) {
    if (!it.book || !it.test) continue;
    const key = `C${it.book}-Test${it.test}`;
    const e = finalTests.get(key) || { key, book: it.book, test: it.test, best: null, parts: [] };
    if (it.part === null && (!e.best || it.size > e.best.size)) e.best = it;
    if (it.part !== null) e.parts.push(it);
    finalTests.set(key, e);
  }

  console.log('=== 统一后的课程清单 ===');
  console.log('  课程名            来源            大小     说明');
  console.log('  ' + '-'.repeat(66));
  let needMerge = 0, haveFull = 0;
  for (const e of [...finalTests.values()].sort((a, b) => a.book - b.book || a.test - b.test)) {
    if (e.best) {
      haveFull++;
      console.log(`  ${e.key.padEnd(16)} 整卷 ${(e.best.size / 1048576).toFixed(1).padStart(6)} MB  ${e.best.source.slice(0, 2)}`);
    } else if (e.parts.length) {
      needMerge++;
      const tot = e.parts.reduce((n, x) => n + x.size, 0);
      console.log(`  ${e.key.padEnd(16)} ${e.parts.length} 个 Part 合并 ${(tot / 1048576).toFixed(1).padStart(6)} MB  ← 需合并`);
    }
  }
  console.log('  ' + '-'.repeat(66));
  console.log(`  共 ${finalTests.size} 个 Test：其中整卷 ${haveFull} 个，需合并 ${needMerge} 个`);
  console.log('');

  if (cmd === 'plan') {
    console.log('=== 合并方法 ===');
    console.log('  同一 Test 的 Part1-4 是【同一次录音切成的四段】，直接按序拼接即可，');
    console.log('  但 mp3 不能简单字节拼接（每段都有 ID3 头）。需要用 PyAV（已随 faster-whisper 装好）');
    console.log('  解码后重编码，或用「播放器多轨」方式：把 4 个 Part 作为同一课程的 4 条音轨。');
    console.log('');
    console.log('  推荐后者 —— 无损、不用重编码、也不必重新转写：');
    console.log('    课程 C20-Test1 = Part1.mp3 + Part2.mp3 + Part3.mp3 + Part4.mp3');
    console.log('    播放器按顺序连续播放，字幕按累计偏移拼接。');
    console.log('');
  }
}

if (require.main === module) main();

module.exports = { parseFile, sourceOf };

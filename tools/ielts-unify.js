#!/usr/bin/env node
/**
 * ielts-unify.js — 统一雅思听力素材：命名规范、合并拆分、去重、导入播放器
 *
 * 素材现状（实测）：
 *   C 组  「剑雅真题1-19」64 集   → 文件名 "1.1.C 19-Test 01"      整卷，C4–C19
 *   A 组  「剑雅真题1-20」80 集   → 文件名 "69.18.C 03-Test 01"    整卷，但与 C 组重叠
 *   B 组  「中英字幕」           → 文件名 "1.IELTS21_Test1_Part1"  按 Part 拆分，C20/C21
 *
 * 三件要处理的事：
 *   1. 命名统一     → 输出一律 "C<书号>-Test<套号>.mp3"，与播放器里的既有课程一致
 *   2. 合并拆分     → B 组的 Part1-4 用 PyAV 真正拼成一个整卷（不是字节拼接）
 *   3. 处理重复     → 同一 Test 有多份时，保留体积更大（码率更高）的那份，其余报告出来
 *
 * ⚠️ 解析书号的陷阱（踩过一次）：
 *   A 组文件名里的 "C 03" 是【合集内编号】不是书号，真书号要看最前面的序号：
 *       序号 = (书号 - 1) * 4 + Test     69 → C18-Test1
 *   C 组里的 "C 19" 才是真书号。两者格式相似，语义完全不同。
 *
 * 用法：
 *   node tools/ielts-unify.js plan            只出方案，不动文件
 *   node tools/ielts-unify.js run             执行（复制/合并到 audio/IELTS-剑桥真题）
 *   node tools/ielts-unify.js run --keep-dup   重复的也保留（默认只留体积最大的）
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'audio', 'IELTS-剑桥真题');
const SRC_DIR = 'F:/DSH workshop/【雅思听力】《剑雅真题1-19》听力+音频合集（共64集）_雅思听力磨耳朵素材';

const DRY = process.argv.includes('plan') || !process.argv.includes('run');
const KEEP_DUP = process.argv.includes('--keep-dup');

const AUDIO_EXT = /\.(mp3|m4a|wav|flac|ogg)$/i;

// ---------------------------------------------------------------- 解析

/**
 * 解析文件名 → { book, test, part }
 * 详见文件头「解析书号的陷阱」。
 */
function parseFile(name) {
  const base = name.replace(AUDIO_EXT, '');

  // B 组：明写 IELTS21_Test1_Part1，最可靠
  let m = /IELTS\s*(\d{1,2})\s*_?\s*Test\s*(\d)\s*_?\s*Part\s*(\d)/i.exec(base);
  if (m) return { book: +m[1], test: +m[2], part: +m[3], bookFrom: 'IELTSxx' };

  const seqM = /-\s*(\d{1,3})\./.exec(base);
  const seq = seqM ? +seqM[1] : null;

  // A 组：1-20 合集，序号才是书号
  if (/剑雅真题1-20/.test(base) && seq !== null && seq >= 1 && seq <= 80) {
    return { book: Math.floor((seq - 1) / 4) + 1, test: ((seq - 1) % 4) + 1, part: null, bookFrom: 'seq', seq };
  }

  // C 组：明写 C 19-Test 01
  m = /C\s*(\d{1,2})\s*-\s*Test\s*0?(\d)/i.exec(base);
  if (m) return { book: +m[1], test: +m[2], part: null, bookFrom: 'Cxx', seq };

  return null;
}

function sourceOf(name) {
  if (/中英字幕/.test(name)) return 'B';
  if (/剑雅真题1-20/.test(name)) return 'A';
  if (/剑雅真题1-19/.test(name)) return 'C';
  return '?';
}

// ---------------------------------------------------------------- 扫描

function scan() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error('素材目录不存在：' + SRC_DIR);
    process.exit(1);
  }

  const items = [];
  for (const f of fs.readdirSync(SRC_DIR)) {
    if (!AUDIO_EXT.test(f)) continue;
    const p = parseFile(f);
    if (!p) { console.log(`  [跳过·认不出] ${f.slice(0, 80)}`); continue; }
    const full = path.join(SRC_DIR, f);
    items.push({ file: f, path: full, size: fs.statSync(full).size, src: sourceOf(f), ...p });
  }
  return items;
}

/** 归并成「每个 Test 一组素材」 */
function groupByTest(items) {
  const map = new Map();
  for (const it of items) {
    const key = `C${it.book}-Test${it.test}`;
    if (!map.has(key)) map.set(key, { key, book: it.book, test: it.test, fulls: [], parts: [] });
    const e = map.get(key);
    if (it.part === null) e.fulls.push(it);
    else e.parts.push(it);
  }
  for (const e of map.values()) {
    e.fulls.sort((a, b) => b.size - a.size);          // 体积大的优先（码率更高）
    e.parts.sort((a, b) => a.part - b.part);
  }
  return map;
}

// ---------------------------------------------------------------- 执行

/** 用 merge_audio.py 把多个 Part 拼成一个整卷 */
function mergeParts(parts, outPath) {
  const py = process.platform === 'win32' ? 'python' : 'python3';
  const args = [path.join(__dirname, 'merge_audio.py'), '--out', outPath, ...parts.map((p) => p.path)];
  execFileSync(py, args, { stdio: 'pipe', encoding: 'utf8' });
}

function main() {
  console.log('');
  console.log(DRY ? '模式：方案预览（加 run 才执行）' : '模式：执行');
  console.log('');

  const items = scan();
  const groups = groupByTest(items);

  // 统计
  const srcStat = {};
  for (const it of items) {
    srcStat[it.src] = srcStat[it.src] || { n: 0, mb: 0, books: new Set() };
    srcStat[it.src].n++;
    srcStat[it.src].mb += it.size / 1048576;
    srcStat[it.src].books.add(it.book);
  }
  console.log('=== 素材来源 ===');
  for (const [s, v] of Object.entries(srcStat).sort()) {
    const books = [...v.books].sort((a, b) => a - b);
    console.log(`  ${s} 组  ${v.n} 个  ${v.mb.toFixed(0)} MB  书号 ${books.join(', ')}`);
  }
  console.log('');

  // 计划
  const plan = { copy: [], merge: [], skipDup: [], skipped: [] };
  for (const e of [...groups.values()].sort((a, b) => a.book - b.book || a.test - b.test)) {
    const outName = `${e.key}.mp3`;
    const outPath = path.join(OUT_DIR, outName);

    if (e.fulls.length) {
      plan.copy.push({ key: e.key, src: e.fulls[0], outPath, outName });
      for (const d of e.fulls.slice(1)) {
        plan.skipDup.push({ key: e.key, dup: d, kept: e.fulls[0], outName });
      }
    } else if (e.parts.length >= 2) {
      plan.merge.push({ key: e.key, parts: e.parts, outPath, outName });
    } else {
      plan.skipped.push(e);
    }
  }

  console.log(`=== 计划 ===`);
  console.log(`  直接复制（已有整卷）：${plan.copy.length}`);
  console.log(`  需要合并（按 Part 拆分）：${plan.merge.length}`);
  console.log(`  重复而舍弃：${plan.skipDup.length}`);
  console.log(`  无法处理：${plan.skipped.length}`);
  console.log('');

  if (plan.merge.length) {
    console.log('  待合并：');
    for (const m of plan.merge) {
      const tot = m.parts.reduce((n, x) => n + x.size, 0) / 1048576;
      console.log(`    ${m.key}  ← ${m.parts.map((p) => 'Part' + p.part).join(' + ')}  （合计 ${tot.toFixed(0)} MB）`);
    }
    console.log('');
  }

  if (plan.skipDup.length) {
    console.log('  重复舍弃（同名 Test 有多份，保留体积更大的）：');
    for (const d of plan.skipDup) {
      console.log(`    ${d.key}  保留 ${(d.kept.size / 1048576).toFixed(1)} MB（${d.kept.src} 组）  舍弃 ${(d.dup.size / 1048576).toFixed(1)} MB（${d.dup.src} 组）`);
    }
    console.log('');
    if (KEEP_DUP) console.log('  （--keep-dup 已开启，重复的会改名保留）\n');
  }

  if (DRY) {
    console.log('确认后执行：node tools/ielts-unify.js run');
    return;
  }

  // 执行
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let copied = 0, merged = 0, failed = 0;

  console.log('=== 执行 ===');
  for (const c of plan.copy) {
    try {
      if (!fs.existsSync(c.outPath) || fs.statSync(c.outPath).size !== c.src.size) {
        fs.copyFileSync(c.src.path, c.outPath);
      }
      copied++;
    } catch (e) {
      console.log(`  ✗ 复制失败 ${c.outName} :: ${e.message}`);
      failed++;
    }
  }
  console.log(`  复制完成 ${copied} 个`);

  for (const m of plan.merge) {
    process.stdout.write(`  合并 ${m.key} … `);
    try {
      if (fs.existsSync(m.outPath) && fs.statSync(m.outPath).size > 1000000) {
        console.log('已存在，跳过');
        merged++;
        continue;
      }
      mergeParts(m.parts, m.outPath);
      console.log('ok');
      merged++;
    } catch (e) {
      console.log('失败：' + String(e.stderr || e.message).slice(0, 200));
      failed++;
    }
  }
  console.log(`  合并完成 ${merged} 个`);

  if (KEEP_DUP) {
    for (const d of plan.skipDup) {
      const alt = path.join(OUT_DIR, `${d.key}__alt-${d.dup.src}.mp3`);
      try {
        if (!fs.existsSync(alt)) fs.copyFileSync(d.dup.path, alt);
      } catch { /* 忽略 */ }
    }
    console.log(`  重复副本另存 ${plan.skipDup.length} 个（__alt-<来源>.mp3）`);
  }

  console.log('');
  console.log('─'.repeat(64));
  console.log(`输出目录：${OUT_DIR}`);
  console.log(`成功 ${copied + merged} 个，失败 ${failed} 个`);
  console.log('');
}

if (require.main === module) main();

module.exports = { parseFile, sourceOf, groupByTest };

#!/usr/bin/env node
/**
 * parse-paper.js — 从原题 PDF 的 OCR 文本里抽取「题干与选项」，补进题库
 *
 * 输入：
 *   build/ocr-listening/剑N*_listening.ocr.txt   （tools/ocr_pdf.py 产出）
 *   build/cambridge-answers.json                 （题号 → 答案）
 * 输出：
 *   build/cambridge-papers.json  { book: { test: { instructions, groups, stems } } }
 *
 * ── OCR 出来的结构（实测）──────────────────────────────
 *   Test 1
 *   LISTENING
 *   SECTION 1 Questions 1-10
 *   Questions 1-6                     ← 题目组（题号区间）
 *   Complete the notes below.          ← 题型指令
 *   Write ONE WORD for each answer.    ← 字数要求
 *   SELF-DRIVE TOURS IN THE USA        ← 表格/笔记标题
 *   Example
 *   Name: Andrea Brown
 *   Address: 24 1 Road                 ← 空格处的题号 1
 *   Phone: (mobile) 077 8664 3091
 *   Heard about company from: 2        ← 题号 2
 *   ...
 *   Questions 7-10                     ← 下一个题组
 *   Choose TWO letters A-E             ← 选择题
 *   Which two facilities ... improved?
 *   A the gym                          ← 选项
 *   B the tracks
 *
 * ── 难点 ────────────────────────────────────────────
 * 1. 题号在文本里的位置很随意：可能在行首（"2"）、行尾（"525km7"）、
 *    甚至粘在词里（"24 1 Road" 里的 1 是题号 1）。
 *    → 不追求精确切分题干，改为【按题号区间把整块文本存下来】，
 *      界面上作为该组的「题目原文」展示，用户对照做题。
 * 2. OCR 会把空格吃掉（"Completethetablebelow."），不影响理解。
 * 3. 剑13 被手写填过答案，会有噪声字符，展示时保留但不解析。
 *
 * 用法：
 *   node tools/parse-paper.js scan          解析概况
 *   node tools/parse-paper.js json          输出 build/cambridge-papers.json
 *   node tools/parse-paper.js dump 10       看某一本
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OCR_DIR = path.join(ROOT, 'build', 'ocr-listening');

// ---------------------------------------------------------------- 解析

/** 分页 */
function splitPages(text) {
  const out = [];
  const re = /━+\s*第\s*(\d+)\s*页\s*━+/g;
  const marks = [...text.matchAll(re)].map((m) => ({ pno: Number(m[1]), index: m.index, end: m.index + m[0].length }));
  marks.forEach((mk, i) => {
    out.push({ pno: mk.pno, text: text.slice(mk.end, i + 1 < marks.length ? marks[i + 1].index : text.length).trim() });
  });
  return out;
}

/** 找 Test 分隔：页面上会出现 "Test N" */
function markTestBoundaries(pages) {
  // 每个 Test 的第一页顶部会印 "Test N"
  return pages.map((p) => {
    const m = /^\s*Test\s*(\d)\s*$/im.exec(p.text);
    return { ...p, test: m ? Number(m[1]) : null };
  });
}

const RE_SECTION = /(?:SECTION|Part)\s*([1-4])\s*Questions?\s*(\d{1,2})\s*[-–—]\s*(\d{1,2})/i;
const RE_GROUP = /^\s*Questions?\s*(\d{1,2})\s*[-–—]\s*(\d{1,2})\s*$/im;

/** 从一页文本里抽出 Section 标记与题组 */
function extractFromPage(text) {
  const secM = RE_SECTION.exec(text);
  const section = secM ? { num: Number(secM[1]), from: Number(secM[2]), to: Number(secM[3]) } : null;

  const groups = [];
  const matches = [...text.matchAll(/Questions?\s*(\d{1,2})\s*[-–—]\s*(\d{1,2})/gi)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const from = Number(m[1]), to = Number(m[2]);
    if (from < 1 || to > 40 || to < from) continue;
    const body = text.slice(m.index + m[0].length, i + 1 < matches.length ? matches[i + 1].index : text.length).trim();
    groups.push({ from, to, text: body });
  }
  return { section, groups };
}

/**
 * 从题组文本里拆出「指令」与「内容」。
 * 指令通常是开头那几行：Complete the notes below. / Write ONE WORD ... /
 * Choose TWO letters ... / Label the map below. 等。
 */
function splitInstructions(body) {
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  const instrRe = /^(Complete|Write|Choose|Label|Select|Answer|Match|Which|What|According)/i;
  const instr = [];
  let i = 0;
  while (i < lines.length && instr.length < 5) {
    if (instrRe.test(lines[i]) || /^(ONE|TWO|THREE|NO MORE)/i.test(lines[i])) {
      instr.push(lines[i]);
      i++;
    } else break;
  }
  return { instructions: instr, content: lines.slice(i) };
}

/** 把题干内容里的选项行提出来（A/B/C/D ...） */
function extractOptions(lines) {
  const out = [];
  for (const l of lines) {
    const m = /^([A-H])\s+(.{2,80})$/.exec(l);
    if (m) out.push({ key: m[1], text: m[2].trim() });
  }
  return out;
}

/** 主解析：一个 OCR 文件 → 4 个 Test */
function parsePaper(ocrText) {
  const pages = markTestBoundaries(splitPages(ocrText));

  // 按 Test 分组（页面上没标 Test 的归到上一个）
  const byTest = new Map();
  let curTest = 1;
  for (const p of pages) {
    if (p.test) curTest = p.test;
    if (!byTest.has(curTest)) byTest.set(curTest, []);
    byTest.get(curTest).push(p);
  }

  const tests = {};
  for (const [t, ps] of byTest) {
    const full = ps.map((p) => p.text).join('\n');
    const { groups } = extractFromPage(full);

    // 同一区间可能重复出现（页眉重复），去重保留最长的那份
    const merged = new Map();
    for (const g of groups) {
      const key = `${g.from}-${g.to}`;
      const prev = merged.get(key);
      if (!prev || g.text.length > prev.text.length) merged.set(key, g);
    }

    const outGroups = [...merged.values()].sort((a, b) => a.from - b.from).map((g) => {
      const { instructions, content } = splitInstructions(g.text);
      return {
        from: g.from,
        to: g.to,
        instructions,
        options: extractOptions(content),
        content,
      };
    });

    if (outGroups.length) tests[t] = { groups: outGroups, pages: ps.map((p) => p.pno) };
  }
  return tests;
}

// ---------------------------------------------------------------- 主流程

function listOcr() {
  if (!fs.existsSync(OCR_DIR)) return [];
  return fs.readdirSync(OCR_DIR)
    .filter((f) => f.endsWith('.ocr.txt'))
    .map((f) => {
      const m = /剑\s*(\d+)/.exec(f);
      return { file: f, path: path.join(OCR_DIR, f), book: m ? Number(m[1]) : 0 };
    })
    .filter((x) => x.book)
    .sort((a, b) => a.book - b.book);
}

function main() {
  const cmd = process.argv[2] || 'scan';
  const files = listOcr();
  if (!files.length) {
    console.error('没有 OCR 产物。请先跑：');
    console.error('  python tools/ocr_pdf.py --dir "F:/DSH workshop/听力真题" --pattern "*listening*.pdf" --outdir build/ocr-listening');
    process.exit(1);
  }

  const all = [];
  for (const f of files) {
    const text = fs.readFileSync(f.path, 'utf8');
    const tests = parsePaper(text);
    all.push({ book: f.book, file: f.file, tests });
  }

  if (cmd === 'json') {
    fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true });
    const out = path.join(ROOT, 'build', 'cambridge-papers.json');
    fs.writeFileSync(out, JSON.stringify(all, null, 2), 'utf8');
    console.log('已写出 ' + out);
    return;
  }

  if (cmd === 'dump') {
    const want = Number(process.argv[3]);
    const r = all.find((x) => x.book === want);
    if (!r) { console.error('没有这一本：' + want); process.exit(1); }
    console.log('');
    console.log(`剑${r.book}`);
    for (const [t, v] of Object.entries(r.tests).sort()) {
      console.log('');
      console.log(`══ Test ${t} ══  （页 ${v.pages.join(',')}）  题组 ${v.groups.length} 个`);
      for (const g of v.groups) {
        console.log(`  ── Q${g.from}-${g.to} ──`);
        if (g.instructions.length) console.log('     指令: ' + g.instructions.join(' | '));
        if (g.options.length) console.log('     选项: ' + g.options.map((o) => `${o.key}.${o.text}`).join('  '));
        const preview = g.content.slice(0, 3).join(' / ');
        console.log('     内容: ' + preview.slice(0, 110));
      }
    }
    console.log('');
    return;
  }

  // scan
  console.log('');
  console.log('书号  Test 数  题组数  覆盖题号              指令样例');
  console.log('-'.repeat(84));
  let totalGroups = 0, booksWithTests = 0;

  for (const r of all) {
    const tks = Object.keys(r.tests).sort();
    if (tks.length) booksWithTests++;
    const groups = tks.reduce((n, t) => n + r.tests[t].groups.length, 0);
    totalGroups += groups;

    const covered = new Set();
    for (const t of tks) for (const g of r.tests[t].groups) {
      for (let i = g.from; i <= g.to; i++) covered.add(i);
    }
    const instr = tks.length && r.tests[tks[0]].groups[0]
      ? (r.tests[tks[0]].groups[0].instructions[0] || '').slice(0, 26)
      : '';

    console.log(`剑${String(r.book).padEnd(3)} ${String(tks.length).padStart(4)}  ${String(groups).padStart(5)}   `
      + `覆盖 ${String(covered.size).padStart(2)}/40 题`.padEnd(18) + `  ${instr}`);
  }

  console.log('-'.repeat(84));
  console.log(`${all.length} 本（已 OCR），其中 ${booksWithTests} 本解析出 Test，共 ${totalGroups} 个题组`);
  console.log('');
}

if (require.main === module) main();

module.exports = { splitPages, parsePaper, splitInstructions, extractOptions, extractFromPage };

#!/usr/bin/env node
/**
 * parse-answers.js — 解析《剑桥雅思》答案页 PDF，提取「每个 Test 的 1–40 题答案」
 *
 * 输入：F:/DSH workshop/听力真题/剑N*_answers.pdf（每份 4 页 = 4 个 Test）
 * 输出：{ book: { test: [ {num, answer, alternatives}, ... ] } }
 *
 * ══ 实测的页面结构（这是解析的依据）══════════════════════
 *
 *   Answer key              ← 有的书是 "Answer Key"
 *   LISTENING
 *   Section I, Questions 1-10        ← 注意：剑5 用罗马数字 I，剑4 用阿拉伯数字 1
 *   1 by minibus I a minibus         ← 这个 I 其实是 | ，表示两个答案都算对
 *   2 15115 people
 *   5-6 IN EITHER ORDER              ← 题号区间 + 特殊标注
 *   B
 *   D
 *   Section 2, Questions 11-20
 *   …
 *   TEST 1                           ← ⚠️ TEST 标记【不一定在最前面】
 *
 * ══ 三个必须处理的麻烦 ══════════════════════════════════
 *
 * 1. **TEST 标记位置不可靠**
 *    文字层顺序是乱的：TEST 1 可能出现在它自己那段答案的【后面】。
 *    所以不能按 TEST 切分。改用 **Section 锚点**：「Section N, Questions a-b」
 *    是权威分节标记，可靠得多。
 *
 * 2. **题号回绕 = 新的 Test**
 *    每个 Test 的题号都是 1→40。所以按文档顺序扫 Section 锚点时，
 *    一旦「上一个 Section 的结束题号 > 这个 Section 的起始题号」，
 *    就说明进入了一个新的 Test。例如 …Section 4 (31-40) 之后出现
 *    Section 1 (1-10)，就切一刀。
 *
 * 3. **双栏交错 + OCR 噪声**
 *    双栏排版会让文本交错（"coal 33 humid" 这种，题号前粘了上一题的尾字）。
 *    所以扫答案时【不依赖行首】，而是全文找「数字 + 内容」。
 *    OCR 噪声规律：
 *      | → I 或 l        （"shopping I variety"）
 *      1 → I 或 l        （"I C" 实为 "1 C"，"I 0" 实为 "10"）
 *      行首 1 → 7 或 l   （"1 Bristol" 实为 "7 Bristol"）
 *    噪声用 normalizeOcr() 处理，再用「题号必须落在 Section 区间内」做校验。
 *
 * 用法：
 *   node tools/parse-answers.js scan            解析概况（各书各 Test 命中多少题）
 *   node tools/parse-answers.js dump 剑4        打印某一本的全部答案
 *   node tools/parse-answers.js json            输出 build/cambridge-answers.json
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PDF_DIR = 'F:/DSH workshop/听力真题';

const { extractPdfText } = require('./pdf-text.js');

// ---------------------------------------------------------------- OCR 归一化

/** 罗马数字 → 阿拉伯数字（Section 编号用） */
const ROMAN = { I: 1, V: 5, X: 10, L: 50, C: 100 };

function romanToInt(s) {
  let n = 0;
  const up = String(s).toUpperCase();
  for (let i = 0; i < up.length; i++) {
    const cur = ROMAN[up[i]] || 0;
    const next = ROMAN[up[i + 1]] || 0;
    n += cur < next ? -cur : cur;
  }
  return n;
}

/**
 * 全文级 OCR 归一化。
 * 关键：把「单独成词的 I / l / O」在数字语境里纠正成 1 / 0，
 * 以及把作分隔符的竖线统一成 |。
 */
function normalizeOcr(text) {
  let t = String(text);

  // 全角 → 半角
  t = t.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  // 各种竖线/断裂符统一
  t = t.replace(/[¦￨│┃]/g, '|');

  // "I 0" 形式的 10：字母 I 后面跟空格再跟 0
  t = t.replace(/\b[Il]\s+(\d)/g, '1 $1');
  // "I C" / "I B" / "I A" / "I D"（答案字母）→ "1 C"
  t = t.replace(/\b[Il]\s+([A-D])\b/g, '1 $1');
  // 行首的 "I Bristol" → "1 Bristol"（题号 1）；由 Section 区间校验兜底
  t = t.replace(/(^|\n)\s*[Il]\s+(?=[A-Z(])/g, '$1 1 ');

  // 行内 "I" 作为「或」分隔符：两侧是空白且不是答案字母
  t = t.replace(/\s[Il]\s(?!$)/g, ' | ');

  // 数字之间的 O → 0
  t = t.replace(/(?<=\d)\s*O\b/g, '0');

  return t;
}

// ---------------------------------------------------------------- Section 锚点

/**
 * 找出所有 Section/Part 锚点。
 *
 * ⚠️ 新版书（约剑11 起）把 "Section" 改称 **"Part"**，两种都要认：
 *       Section 1, Questions 1-10        （旧版，剑4–剑10）
 *       Part 3, Questions 21-30Part 1, Questions 1-10   （新版，两栏紧贴，中间无空格）
 * 所以：
 *   · 关键词用 (?:Section|Part)
 *   · 逗号可选（实测有 "Part4,Questions31-40" 这种完全没空格的）
 *   · 用零宽前瞻切分紧贴的下一个锚点
 */
function findSections(text) {
  const out = [];
  const re = /(?:Section|Part)\s*([IVXLCividxlc]+|\d)\s*[,.]?\s*Questions?\s*(\d{1,2})\s*[-–—~]\s*(\d{1,2})/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1];
    const sec = /^\d+$/.test(raw) ? Number(raw) : romanToInt(raw);
    if (sec < 1 || sec > 4) continue;
    out.push({
      section: sec,
      from: Number(m[2]),
      to: Number(m[3]),
      index: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

/**
 * 按 Section/Part 锚点切分 Test。
 *
 * 剑桥雅思听力固定结构：每个 Test 含 4 个 Section/Part（各 10 题）。
 * 所以最稳的切分是 **每 4 个锚点一组**。
 *
 * 为什么不用「题号回绕」判断：
 *   新版书两栏紧贴，同一页会依次出现 4 个锚点，例如
 *       Part 3, Questions 21-30Part 1, Questions 1-10
 *   题号序列会是 21→1→11→31，用「回绕」判断会误切成多个 Test
 *   （实测剑15–20 被切成 8–9 段，每段只有十几题）。
 */
function splitTests(text) {
  const secs = findSections(text);
  if (!secs.length) return [];

  const PER_TEST = 4;
  const tests = [];

  for (let i = 0; i < secs.length; i += PER_TEST) {
    const group = secs.slice(i, i + PER_TEST);
    tests.push({
      sections: group,
      start: group[0].index,
      end: i + PER_TEST < secs.length ? secs[i + PER_TEST].index : text.length,
    });
  }
  return tests;
}

// ---------------------------------------------------------------- 答案扫描

/** 已知的特殊标注（不是答案本身） */
const SPECIAL = /^IN EITHER ORDER|^IN ANY ORDER|^(BOTH|ALL)\s+(REQUIRED|NEEDED)|^BOTH REQUIRED/i;

/**
 * 在给定区间文本里扫出「题号 → 答案」。
 *
 * 两种输入都要能吃：
 *   A) PDF 文字层（质量参差）：行首是题号，可能有 OCR 噪声
 *   B) OCR 输出（质量好，但题号可能在行尾）
 *      实测 OCR 会给出 "fishing37" 这种「答案在前、题号在后」的行
 *      （因为原版式里题号在右列，重排后落到行尾）。
 *
 * 策略：对每一行，找出其中【所有】1–2 位数字，取落在 [lo, hi] 区间内的那个当题号，
 *       剩下的文本当答案。找不到合法题号的行则跳过（大多是小标题/说明）。
 */
function scanRange(body, lo, hi) {
  const found = new Map();
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);

  for (const line of lines) {
    // 跳过明显不是答案的行
    if (/^(Section|Test|Listening|Reading|Answer|If you score|you are|examination|conditions|recommend|English before|lot of time|more practice|institutions|scores acceptable|remember)/i.test(line)) {
      continue;
    }

    // 行内的所有数字（含紧跟文字的情况，如 "fishing37"、"11&12"）
    const nums = [...line.matchAll(/\d{1,2}/g)]
      .map((m) => ({ v: Number(m[0]), i: m.index, len: m[0].length }));

    let pick = null;
    for (const n of nums) {
      if (n.v >= lo && n.v <= hi) { pick = n; break; }
    }

    // 特殊：区间题号 "11&12 IN EITHER ORDER"
    const rangeM = /^(\d{1,2})\s*[&,-]\s*(\d{1,2})\b(.*)$/.exec(line);
    if (rangeM) {
      const a = Number(rangeM[1]), b = Number(rangeM[2]);
      if (a >= lo && a <= hi) {
        const note = (rangeM[3] || '').trim();
        for (let k = a; k <= Math.min(b, hi); k++) {
          if (!found.has(k)) found.set(k, SPECIAL.test(note) ? '' : note);
          if (SPECIAL.test(note)) found.set('__special_' + k, true);
        }
        continue;
      }
    }

    if (!pick) continue;

    // 答案 = 去掉该题号后的剩余文本
    let ans = (line.slice(0, pick.i) + ' ' + line.slice(pick.i + pick.len)).replace(/\s+/g, ' ').trim();
    ans = ans.replace(/^[|:.\-–—]\s*/, '').trim();
    if (!ans) continue;
    if (/^(marks?|questions?|score|IELTS|Section|Test)\b/i.test(ans)) continue;

    if (!found.has(pick.v)) found.set(pick.v, ans);
  }

  // 补：区间标注后面跟着的裸字母行（B / D）分配给缺答案的题号
  const bare = [...body.matchAll(/^\s*([A-D])\s*$/gm)].map((x) => x[1]);
  if (bare.length) {
    let bi = 0;
    for (let n = lo; n <= hi && bi < bare.length; n++) {
      if (found.get(n) === '') found.set(n, bare[bi++]);
    }
  }

  return found;
}

/** 把答案文本拆成可接受答案列表 */
function splitAlternatives(ans) {
  if (ans == null) return [];
  return String(ans)
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^\(([^)]*)\)\s*/, '$1 ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------- 主流程

function listAnswerPdfs() {
  if (!fs.existsSync(PDF_DIR)) return [];
  return fs.readdirSync(PDF_DIR)
    .filter((f) => /answers?\.pdf$/i.test(f))
    .map((f) => {
      const m = /剑\s*(\d+)/.exec(f);
      return { file: f, path: path.join(PDF_DIR, f), book: m ? Number(m[1]) : 0 };
    })
    .filter((x) => x.book)
    .sort((a, b) => a.book - b.book);
}

async function parseBook(entry, opts = {}) {
  const ocrDir = path.join(ROOT, 'build', 'ocr-answers');
  const ocrFile = path.join(ocrDir, entry.file.replace(/\.pdf$/i, '') + '.ocr.txt');

  let raw;
  let source;

  if (fs.existsSync(ocrFile)) {
    // 优先用 OCR 结果：实测文字层对部分书是坏的（题号丢失、字母被拆开）
    raw = fs.readFileSync(ocrFile, 'utf8');
    source = 'ocr';
  } else {
    const r = await extractPdfText(entry.path);
    raw = r.pages.map((p) => p.text).join('\n');
    source = 'textlayer';
  }

  const text = normalizeOcr(raw);
  const testBlocks = splitTests(text);
  const tests = [];

  testBlocks.forEach((tb, ti) => {
    const qs = [];
    for (const s of tb.sections) {
      // 区间：从本 Section 锚点到下一个锚点（或 Test 末尾）
      const body = text.slice(s.index, Math.min(tb.end, s.index + 5000));
      const map = scanRange(body, s.from, s.to);
      for (let n = s.from; n <= s.to; n++) {
        const a = map.has(n) ? map.get(n) : null;
        if (a == null || a === '') continue;
        qs.push({ num: n, section: s.section, answer: a, alternatives: splitAlternatives(a) });
      }
    }
    const seen = new Set();
    const uniq = qs.filter((q) => (seen.has(q.num) ? false : (seen.add(q.num), true)))
      .sort((a, b) => a.num - b.num);
    tests.push({ index: ti + 1, questions: uniq });
  });

  return { book: entry.book, file: entry.file, source, tests };
}

async function main() {
  const cmd = process.argv[2] || 'scan';
  const pdfs = listAnswerPdfs();
  if (!pdfs.length) { console.error('没找到答案 PDF：' + PDF_DIR); process.exit(1); }

  const ocrDir = path.join(ROOT, 'build', 'ocr-answers');
  const ocrCount = fs.existsSync(ocrDir)
    ? fs.readdirSync(ocrDir).filter((f) => f.endsWith('.ocr.txt')).length
    : 0;
  if (cmd !== 'json') {
    console.log('');
    console.log(`答案 PDF 共 ${pdfs.length} 本；已有 OCR 结果 ${ocrCount} 本`);
    if (ocrCount < pdfs.length) {
      console.log('（未 OCR 的会用 PDF 文字层，质量可能较差。建议先跑：');
      console.log('  python tools/ocr_pdf.py --dir "F:/DSH workshop/听力真题" --pattern "*answers*.pdf" --outdir build/ocr-answers）');
    }
    console.log('');
    console.log('书号  来源      Test 数  解析题数    各 Test');
    console.log('-'.repeat(72));
  }

  const all = [];
  let grandTotal = 0, grandIdeal = 0;

  for (const e of pdfs) {
    let res;
    try { res = await parseBook(e); }
    catch (err) { console.log(`剑${e.book} 读取失败: ${err.message}`); continue; }

    all.push(res);

    if (cmd === 'dump' && Number(process.argv[3]) === res.book) {
      console.log('');
      console.log(`剑${res.book}  ${res.file}  来源=${res.source}  切出 ${res.tests.length} 个 Test`);
      res.tests.forEach((t, i) => {
        console.log('');
        console.log(`══ Test ${i + 1} ══  解析到 ${t.questions.length} 题`);
        for (let n = 1; n <= 40; n++) {
          const q = t.questions.find((x) => x.num === n);
          console.log(`  ${String(n).padStart(2)}. ${q ? q.answer : '—— 缺失'}`);
        }
      });
      return;
    }

    const counts = res.tests.map((t) => t.questions.length);
    const total = counts.reduce((a, b) => a + b, 0);
    const ideal = res.tests.length * 40;
    grandTotal += total; grandIdeal += ideal;

    const flag = ideal === 0 ? '✗' : (total >= ideal * 0.9 ? '✓' : (total >= ideal * 0.6 ? '⚠' : '✗'));
    console.log(`剑${String(res.book).padEnd(3)} ${res.source.padEnd(9)} ${String(res.tests.length).padStart(4)}  `
      + `${String(total).padStart(3)}/${String(ideal).padEnd(3)}    ${counts.join(', ')}  ${flag}`);
  }

  if (cmd === 'json') {
    fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true });
    const out = path.join(ROOT, 'build', 'cambridge-answers.json');
    fs.writeFileSync(out, JSON.stringify(all, null, 2), 'utf8');
    console.log('已写出 ' + out);
    return;
  }

  console.log('-'.repeat(72));
  console.log(`合计 ${all.length} 本，解析 ${grandTotal}/${grandIdeal} 题（${(grandTotal / Math.max(1, grandIdeal) * 100).toFixed(1)}%）`);
  console.log('');
}

if (require.main === module) main().catch((e) => { console.error('[error] ' + e.message); process.exit(1); });

module.exports = { normalizeOcr, findSections, splitTests, scanRange, splitAlternatives, parseBook, listAnswerPdfs };

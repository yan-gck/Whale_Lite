#!/usr/bin/env node
/**
 * calibrate-questions.js — 用 LRC 词级时间轴校准题目片段（含答案句）的起止时间
 *
 * 为什么不是简单地在词流里搜题目文本：
 *   题目里的 transcript / explain 往往是【改写】或【截取】过的，与音频并非逐字一致，
 *   直接在词流里匹配会大量失败。
 *
 * 本工具的做法（三步）：
 *   1. LCS 对齐：把同名 .txt 全文与 .lrc 词流做最长公共子序列对齐，
 *      得到「原文第 i 个词 → 音频第 j 个词」的映射（skip 双方各自的插入/删除）。
 *   2. 定位：在 .txt 全文里搜索题目的 transcript（允许小改写的模糊匹配），
 *      找到它在原文中的词区间。
 *   3. 换算：通过第 1 步的映射把原文词区间换算成音频时间区间。
 *
 * 用法：
 *   node tools/calibrate-questions.js <目录或.questions.json> [选项]
 *
 * 选项：
 *   --write            写回文件（默认 dry-run）
 *   --pad=<秒>         片段前后余量（默认 0.4）
 *   --min-score=0.72   匹配率低于该值则跳过（默认 0.72）
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ------------------------------------------------------------ 解析

const toSec = (m, s) => Number(m) * 60 + Number(String(s).replace(':', '.'));

/** 解析 LRC，返回扁平词流 [{time, text(已归一化)}] */
function parseLrcWords(text) {
  const words = [];
  const timeRe = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;
  const wordRe = /<(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)>([^<]*)/g;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^\[(ti|ar|al|by|offset|re|ve|length):/i.test(line)) continue;

    const stamps = [...line.matchAll(timeRe)];
    if (!stamps.length) continue;
    const lineTime = toSec(stamps[0][1], stamps[0][2]);
    const body = line.replace(timeRe, '');

    if (body.includes('<')) {
      for (const m of body.matchAll(wordRe)) {
        const t = toSec(m[1], m[2]);
        for (const tok of m[3].trim().split(/\s+/)) {
          if (tok) words.push({ time: t, text: normalizeToken(tok) });
        }
      }
    } else {
      for (const tok of body.trim().split(/\s+/)) {
        if (tok) words.push({ time: lineTime, text: normalizeToken(tok) });
      }
    }
  }

  return words.filter((w) => w.text);
}

function normalizeToken(tok) {
  return String(tok).toLowerCase().replace(/[^a-z0-9']/g, '').trim();
}

function tokenize(str) {
  return String(str).split(/\s+/).map(normalizeToken).filter(Boolean);
}

// ------------------------------------------------------------ LCS 对齐

/**
 * 以 a 为参照做 LCS 对齐。
 * 返回 mapA：长度 = a.length，mapA[i] = b 中与 a[i] 对齐的下标，未对齐为 -1。
 *
 * 用完整 (n+1)×(m+1) 矩阵。语料规模在万词以内，内存完全够用，
 * 换来的是回溯逻辑可以直接读、不需要处理滚动数组的边界。
 */
function lcsAlign(a, b) {
  const n = a.length, m = b.length;
  if (!n || !m) return new Array(n).fill(-1);

  const dp = [];
  for (let i = 0; i <= n; i++) dp.push(new Int32Array(m + 1));

  for (let i = 1; i <= n; i++) {
    const ai = a[i - 1];
    const rowCur = dp[i], rowPrev = dp[i - 1];
    for (let j = 1; j <= m; j++) {
      rowCur[j] = ai === b[j - 1]
        ? rowPrev[j - 1] + 1
        : (rowPrev[j] >= rowCur[j - 1] ? rowPrev[j] : rowCur[j - 1]);
    }
  }

  const mapA = new Int32Array(n).fill(-1);
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      mapA[i - 1] = j - 1;
      i--; j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return mapA;
}

// ------------------------------------------------------------ 模糊匹配

/**
 * 在 haystack 中寻找 needle 的最佳位置，允许少量改写。
 * 只从与 needle 首词相同的候选起点开始，用「可跳词消费」策略评分。
 *
 * fromIndex：搜索下界。听力题目必然按音频顺序出现，传入上一题的起点就能
 * 排除「匹配到前面重复片段」导致的乱序（例如两处都讲了 same lesson）。
 *
 * 评分用「F1 × 连续性」而不是单纯的匹配率：
 *   像 in / the 这种高频词开头的句子一旦匹配失败，纯匹配率会给一个
 *   跨越几千词的垃圾片段打出还行的小数分。乘上连续性因子后，
 *   这类散落式匹配会立刻掉到阈值以下。
 */
function findBestSpan(haystack, needle, fromIndex = 0, maxSkip = 8) {
  if (!needle.length || !haystack.length) return null;
  const lo = Math.max(0, Math.min(fromIndex, haystack.length - 1));

  if (needle.length === 1) {
    for (let i = lo; i < haystack.length; i++) {
      if (haystack[i] === needle[0]) return { start: i, end: i, score: 1, contiguity: 1 };
    }
    return null;
  }

  let best = null;
  for (let s = lo; s < haystack.length; s++) {
    if (haystack[s] !== needle[0]) continue;

    let hi = s, matched = 1, last = s;
    for (let ni = 1; ni < needle.length; ni++) {
      const target = needle[ni];
      let found = -1;
      const limit = Math.min(hi + 1 + maxSkip, haystack.length);
      for (let k = hi + 1; k < limit; k++) {
        if (haystack[k] === target) { found = k; break; }
      }
      if (found === -1) continue;
      matched++; last = found; hi = found;
    }

    const precision = matched / (last - s + 1);   // 命中词 / 跨越的词
    const recall = matched / needle.length;
    const score = precision + recall > 0
      ? (2 * precision * recall) / (precision + recall) * precision
      : 0;

    if (!best || score > best.score) {
      best = { start: s, end: last, score, contiguity: precision };
    }
    if (best.score >= 0.97) break;
  }
  return best;
}

// ------------------------------------------------------------ 校准

function calibrateDoc(doc, lrcWords, srcTokens, mapA, opts) {
  const results = [];

  for (const q of doc.questions || []) {
    const entry = {
      number: q.number,
      oldStart: q.start,
      oldEnd: q.end,
      newStart: null,
      newEnd: null,
      score: 0,
      status: 'skipped',
      note: '',
    };

    // 优先用 transcript（就是原文句子）；没有才退回 explain
    let query = q.transcript && q.transcript.trim() ? q.transcript : '';
    let usedField = 'transcript';
    if (!query) { query = q.explain || ''; usedField = 'explain'; }

    let needle = tokenize(query);
    if (!needle.length) {
      entry.note = '既无 transcript 也无 explain，无法定位';
      results.push(entry); continue;
    }

    // explain 往往夹杂中文，先把非英文片段去掉
    if (usedField === 'explain') {
      needle = tokenize(String(query).replace(/[^\x00-\x7F]+/g, ' '));
    }
    if (!needle.length) {
      entry.note = 'explain 中没有可用的英文片段';
      results.push(entry); continue;
    }

    // 注意：这里刻意【不加】单调约束。题目在音频里按题号顺序宣读，
    // 但答案句在原文中的位置可以不按顺序 —— 例如 IELTS 最后一题问"讲座的主旨"，
    // 它引用的句子出现在倒数第二题之前。加单调约束会把这些题逼到错误的片段上。
    // 匹配质量由 findBestSpan 的「F1 × 连续性」评分保证。
    const span = findBestSpan(srcTokens, needle, 0);
    if (!span) {
      entry.note = `全文（${srcTokens.length} 词）中找不到该片段`;
      results.push(entry); continue;
    }

    entry.score = Number(span.score.toFixed(3));
    if (span.score < opts.minScore) {
      entry.note = `匹配率 ${entry.score} 低于阈值 ${opts.minScore}`;
      results.push(entry); continue;
    }

    // 原文词区间 → 音频词流区间：取区间内所有已对齐的下标
    let firstIdx = -1, lastIdx = -1;
    for (let k = span.start; k <= span.end; k++) {
      const j = mapA[k];
      if (j >= 0) {
        if (firstIdx === -1) firstIdx = j;
        lastIdx = j;
      }
    }
    // 若整段都没对齐上，就往后找最近的已对齐词
    if (firstIdx === -1) {
      for (let k = span.start; k < srcTokens.length; k++) {
        if (mapA[k] >= 0) { firstIdx = mapA[k]; break; }
      }
      for (let k = span.end; k >= 0; k--) {
        if (mapA[k] >= 0) { lastIdx = mapA[k]; break; }
      }
    }
    if (firstIdx === -1 || lastIdx === -1 || lastIdx < firstIdx) {
      entry.note = '该片段在音频中未对齐上';
      results.push(entry); continue;
    }

    const startSec = lrcWords[firstIdx].time;
    // 结束时间 = 区间末词之后的下一个音频词，保证答案句完整
    const nextIdx = Math.min(lastIdx + 1, lrcWords.length - 1);
    const endSec = nextIdx > lastIdx ? lrcWords[nextIdx].time : lrcWords[lastIdx].time + 2;

    entry.newStart = Number(Math.max(0, startSec - opts.pad).toFixed(2));
    entry.newEnd = Number((endSec + opts.pad).toFixed(2));
    entry.status = 'calibrated';
    entry.usedField = usedField;
    entry.srcSpan = [span.start, span.end];

    q.start = entry.newStart;
    q.end = entry.newEnd;
    results.push(entry);
  }

  return results;
}

// ------------------------------------------------------------ CLI

function collectTargets(target) {
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) throw new Error('路径不存在：' + abs);
  if (fs.statSync(abs).isFile()) return [abs];

  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.questions.json')) out.push(full);
    }
  };
  walk(abs);
  return out.sort();
}

function main() {
  const opts = { write: false, pad: 0.4, minScore: 0.72 };
  const positional = [];

  for (const a of process.argv.slice(2)) {
    const m = /^--([a-zA-Z-]+)(?:=(.*))?$/.exec(a);
    if (!m) { positional.push(a); continue; }
    if (m[1] === 'write') opts.write = true;
    else if (m[1] === 'pad') opts.pad = Number(m[2]);
    else if (m[1] === 'min-score') opts.minScore = Number(m[2]);
  }

  if (!positional.length) {
    console.log(`用法：node tools/calibrate-questions.js <目录或.questions.json> [选项]

选项：
  --write            写回文件（默认只报告）
  --pad=<秒>         片段前后余量（默认 0.4）
  --min-score=0.72   匹配率阈值（默认 0.72）

原理：.txt 全文 ↔ .lrc 词流做 LCS 对齐，再把题目 transcript 定位到原文、
      经对齐表换算成音频时间。`);
    process.exit(1);
  }

  const targets = collectTargets(positional[0]);
  if (!targets.length) { console.error('[error] 没有找到 .questions.json'); process.exit(1); }

  let totalCal = 0, totalSkip = 0;

  for (const qPath of targets) {
    const base = qPath.replace(/\.questions\.json$/, '');
    const lrcPath = base + '.lrc';
    const txtPath = base + '.txt';

    if (!fs.existsSync(lrcPath)) {
      console.log(`\n⚠ ${path.basename(qPath)}：缺少同名 .lrc，跳过`);
      totalSkip++; continue;
    }

    const lrcWords = parseLrcWords(fs.readFileSync(lrcPath, 'utf8'));
    if (!lrcWords.length) {
      console.log(`\n⚠ ${path.basename(lrcPath)}：解析不出词级时间戳，跳过`);
      totalSkip++; continue;
    }

    // 全文：优先同名 .txt，否则退回用 LRC 自身的词流作为参照
    let srcTokens;
    let srcName;
    if (fs.existsSync(txtPath)) {
      srcTokens = tokenize(fs.readFileSync(txtPath, 'utf8'));
      srcName = path.basename(txtPath);
    } else {
      srcTokens = lrcWords.map((w) => w.text);
      srcName = path.basename(lrcPath) + '（无 .txt）';
    }

    const mapA = lcsAlign(srcTokens, lrcWords.map((w) => w.text));
    const aligned = mapA.reduce((n, v) => n + (v >= 0 ? 1 : 0), 0);

    const doc = JSON.parse(fs.readFileSync(qPath, 'utf8'));
    const results = calibrateDoc(doc, lrcWords, srcTokens, mapA, opts);

    console.log(`\n📄 ${path.basename(qPath)}`);
    console.log(`   参照：${srcName}  ${srcTokens.length} 词 ｜ 词流 ${lrcWords.length} 词 ｜ 对齐 ${aligned} 词 (${(aligned / srcTokens.length * 100).toFixed(1)}%)`);

    for (const r of results) {
      if (r.status === 'calibrated') {
        totalCal++;
        const delta = (r.oldStart != null && !Number.isNaN(Number(r.oldStart)))
          ? `  原 ${Number(r.oldStart).toFixed(1)}s（差 ${(r.newStart - Number(r.oldStart)).toFixed(1)}s）`
          : '';
        console.log(`   #${String(r.number).padStart(2)}  ${String(r.newStart).padStart(7)}s → ${String(r.newEnd).padStart(7)}s   匹配 ${r.score}${delta}`);
      } else {
        totalSkip++;
        console.log(`   #${String(r.number).padStart(2)}  ⚠ 跳过：${r.note}`);
      }
    }

    if (opts.write) {
      fs.writeFileSync(qPath, JSON.stringify(doc, null, 2), 'utf8');
      console.log('   ✅ 已写回');
    }
  }

  console.log(`\n校准完成：成功 ${totalCal} 题，跳过 ${totalSkip} 题`);
  if (!opts.write) console.log('（dry-run，加 --write 才写回）');
}

if (require.main === module) main();

module.exports = { parseLrcWords, tokenize, lcsAlign, findBestSpan, calibrateDoc };

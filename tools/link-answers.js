#!/usr/bin/env node
/**
 * link-answers.js — 把每道题的答案关联到【原文的哪一句】，供「点答案跳转播放」使用
 *
 * 为什么不能直接字符串匹配：
 *   答案页写的是 "160"、"13th February"、"B"，而原文里念的是
 *   "one hundred and sixty"、"the thirteenth of February"，问答题更是整句话。
 *   直接搜必然大量落空。
 *
 * 三级回退策略（从精确到粗略）：
 *   1. 精确匹配答案文本（标准化后）出现在某句原文里
 *   2. 数字/日期转成口语形式再匹配（160 → "one hundred and sixty"）
 *   3. 按 Section 兜底：第 N 题属于 Section S（1-10=S1, 11-20=S2, 21-30=S3, 31-40=S4），
 *      用原文里 "Section N" / "Part N" 的念白时间定位该 Section 的起点
 *
 * 产出写进 questions.json 的每题：
 *   {
 *     "answerLine": 137,        // 原文行索引（用于跳转）
 *     "answerTime": 412.5,      // 原文该行的时间戳
 *     "linkMethod": "exact" | "spoken" | "section"
 *   }
 *
 * 用法：
 *   node tools/link-answers.js audio/IELTS-剑桥真题/C10-Test1.mp3
 *   node tools/link-answers.js --all            处理 IELTS-剑桥真题 下全部
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const LESSON_DIR = path.join(ROOT, 'audio', 'IELTS-剑桥真题');

// ---------------------------------------------------------------- 文本处理

/** 标准化：小写、去标点、压缩空白 */
function norm(s) {
  return String(s)
    .toLowerCase()
    .replace(/[’'`]/g, "'")
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** 整数 → 英文口语形式（用于匹配被念出来的数字） */
function numberToWords(n) {
  n = Number(n);
  if (!Number.isFinite(n) || n < 0 || n > 999999) return '';
  if (n < 20) return ONES[n];
  if (n < 100) {
    const t = TENS[Math.floor(n / 10)];
    const o = n % 10;
    return o ? `${t} ${ONES[o]}` : t;
  }
  if (n < 1000) {
    const h = `${ONES[Math.floor(n / 100)]} hundred`;
    const r = n % 100;
    return r ? `${h} and ${numberToWords(r)}` : h;
  }
  const th = `${numberToWords(Math.floor(n / 1000))} thousand`;
  const r = n % 1000;
  return r ? `${th} ${numberToWords(r)}` : th;
}

/** 序数词（13th → thirteenth） */
const ORDINALS = {
  1: 'first', 2: 'second', 3: 'third', 4: 'fourth', 5: 'fifth', 6: 'sixth', 7: 'seventh',
  8: 'eighth', 9: 'ninth', 10: 'tenth', 11: 'eleventh', 12: 'twelfth', 13: 'thirteenth',
  14: 'fourteenth', 15: 'fifteenth', 16: 'sixteenth', 17: 'seventeenth', 18: 'eighteenth',
  19: 'nineteenth', 20: 'twentieth', 21: 'twenty first', 22: 'twenty second',
  23: 'twenty third', 24: 'twenty fourth', 25: 'twenty fifth', 26: 'twenty sixth',
  27: 'twenty seventh', 28: 'twenty eighth', 29: 'twenty ninth', 30: 'thirtieth', 31: 'thirty first',
};

const MONTHS = {
  jan: 'january', feb: 'february', mar: 'march', apr: 'april', may: 'may', jun: 'june',
  jul: 'july', aug: 'august', sep: 'september', oct: 'october', nov: 'november', dec: 'december',
};

/**
 * 把一条答案展开成多个「可能的匹配形态」。
 * 例："13th February" → ["13th february", "thirteenth of february", "february thirteenth"]
 *     "160"          → ["160", "one hundred and sixty"]
 *     "beach/beaches"→ ["beach", "beaches"]
 */
function answerVariants(ans) {
  const out = new Set();
  const a = String(ans).trim();
  if (!a) return [];

  // 斜杠/竖线分隔的多个可接受答案
  const alts = a.split(/[/|]/).map((s) => s.trim()).filter(Boolean);
  const bases = alts.length ? alts : [a];

  for (const b of bases) {
    const raw = b.replace(/^\(([^)]*)\)\s*/, '$1 ').replace(/[()]/g, ' ').trim();
    if (!raw) continue;
    out.add(norm(raw));

    // 纯数字
    const numM = /^(\d{1,6})$/.exec(raw.replace(/,/g, ''));
    if (numM) {
      const w = numberToWords(Number(numM[1]));
      if (w) out.add(w);
      continue;
    }

    // 序数 + 月份："13th February"
    const dm = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)$/.exec(raw);
    if (dm) {
      const d = Number(dm[1]);
      const monRaw = dm[2].toLowerCase();
      const mon = MONTHS[monRaw.slice(0, 3)] || monRaw;
      const ord = ORDINALS[d];
      if (ord) {
        out.add(`${ord} of ${mon}`);
        out.add(`${ord} ${mon}`);
        out.add(`${mon} ${ord}`);
        out.add(`${mon} the ${ord}`);
      }
      out.add(`${d} ${mon}`);
      out.add(`${d}th ${mon}`);
    }

    // 含数字的混合项："more than 12" → 补 "more than twelve"
    const mix = raw.match(/\d{1,6}/g);
    if (mix) {
      for (const g of mix) {
        const w = numberToWords(Number(g));
        if (w) out.add(norm(raw.replace(g, w)));
      }
    }
  }

  return [...out].filter((s) => s.length >= 2);
}

// ---------------------------------------------------------------- 定位

/** 在原文行里找 Section 起点（音频里会念 "Section 1" / "Part one"） */
function findSectionStarts(lines) {
  const starts = {};
  const wordNum = { one: 1, two: 2, three: 3, four: 4, 1: 1, 2: 2, 3: 3, 4: 4 };
  const re = /\b(?:section|part)\s+(one|two|three|four|[1-4])\b/i;

  lines.forEach((l, i) => {
    const m = re.exec(l.text);
    if (!m) return;
    const n = wordNum[m[1].toLowerCase()];
    // 只记第一次出现（后面的 "Section 1" 往往是回顾）
    if (n && starts[n] == null) starts[n] = i;
  });
  return starts;
}

/** 题号 → Section（剑桥雅思固定：1-10=S1, 11-20=S2, 21-30=S3, 31-40=S4） */
function sectionOf(num) {
  return Math.min(4, Math.floor((num - 1) / 10) + 1);
}

/**
 * 取题号。
 * ⚠️ 字段名在项目里有两种：题库用 `number`，而解析器内部用 `num`。
 * 早先这里只读 `q.num`，导致 sectionOf(undefined) = NaN，
 * Section 兜底【全部失效】（表现为"选择题一个都定位不到"）。两种都要认。
 */
function qNum(q, fallbackIndex) {
  const v = q.number != null ? q.number : (q.num != null ? q.num : null);
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n;
  return fallbackIndex != null ? fallbackIndex + 1 : NaN;
}

/**
 * 为一批题目计算 answerLine / answerTime / linkMethod
 */
function linkQuestions(questions, lines) {
  const lineNorms = lines.map((l) => norm(l.text));
  const allText = lineNorms.join(' ');
  const secStarts = findSectionStarts(lines);

  let exact = 0, spoken = 0, section = 0, none = 0;

  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi];
    q.answerLine = null;
    q.answerTime = null;
    q.linkMethod = null;

    const num = qNum(q, qi);
    const ans = String(q.answer || '').trim();
    const variants = answerVariants(ans);

    // ⚠️ 选择题（答案是单个字母 A/B/C/D）没有可匹配的文本 —— 选项内容在题干 PDF 里，
    //    不在答案页。这类题【必须】走 Section 兜底，不能因为 variants 为空就 continue。
    //    （早先版本在这里 continue，导致所有选择题都定位失败，兜底形同虚设。）
    const isChoice = /^[A-D]$/i.test(ans);

    // ── 1/2 级：在原文行里找答案文本（仅对非选择题有意义）
    let hitLine = -1;
    if (!isChoice && variants.length) {
      for (const v of variants) {
        if (!v) continue;
        for (let i = 0; i < lineNorms.length; i++) {
          if (lineNorms[i].includes(v)) { hitLine = i; break; }
        }
        if (hitLine >= 0) break;
      }

      // 精确没中，试「答案里的实词是否都在同一句里」
      if (hitLine < 0) {
        const keys = norm(ans).split(' ').filter((w) => w.length >= 4);
        if (keys.length >= 2) {
          for (let i = 0; i < lineNorms.length; i++) {
            if (keys.every((k) => lineNorms[i].includes(k))) { hitLine = i; break; }
          }
        }
      }
    }

    if (hitLine >= 0) {
      q.answerLine = hitLine;
      q.answerTime = lines[hitLine].time;
      q.linkMethod = 'exact';
      exact++;
      continue;
    }

    // ── 3 级：按 Section 兜底（选择题的唯一途径，也是其它题的最后保险）
    const sec = sectionOf(num);
    if (secStarts[sec] != null) {
      q.answerLine = secStarts[sec];
      q.answerTime = lines[secStarts[sec]].time;
      q.linkMethod = isChoice ? 'section-choice' : 'section';
      section++;
    } else {
      none++;
    }
  }

  return { exact, spoken, section, none, secStarts };
}

// ---------------------------------------------------------------- 主流程

function loadLesson(mp3Path) {
  const base = mp3Path.slice(0, mp3Path.length - path.extname(mp3Path).length);
  const lrcPath = base + '.lrc';
  const qPath = base + '.questions.json';

  if (!fs.existsSync(lrcPath)) return { error: '缺少 .lrc' };
  if (!fs.existsSync(qPath)) return { error: '缺少 .questions.json' };

  const { parseLrc } = require(path.join(ROOT, 'lib', 'library.js'));
  const lines = parseLrc(fs.readFileSync(lrcPath, 'utf8'));
  const qDoc = JSON.parse(fs.readFileSync(qPath, 'utf8'));
  return { base, lrcPath, qPath, lines, qDoc };
}

function processOne(mp3Path, opts = {}) {
  const L = loadLesson(mp3Path);
  if (L.error) return { error: L.error };

  const { base, qPath, lines, qDoc } = L;
  const questions = qDoc.questions || [];
  if (!questions.length) return { error: '没有题目' };
  if (!lines.length) return { error: '时间轴为空' };

  const stat = linkQuestions(questions, lines);
  qDoc.answerIndex = {
    generatedAt: new Date().toISOString().slice(0, 10),
    method: 'tools/link-answers.js（答案文本匹配 + Section 兜底）',
    exact: stat.exact, section: stat.section, unresolved: stat.none,
    sectionStarts: stat.secStarts,
  };

  if (!opts.dry) fs.writeFileSync(qPath, JSON.stringify(qDoc, null, 2), 'utf8');

  return {
    name: path.basename(base),
    total: questions.length,
    ...stat,
  };
}

function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const all = args.includes('--all');

  let targets = [];
  if (all) {
    targets = fs.readdirSync(LESSON_DIR)
      .filter((f) => /\.mp3$/i.test(f))
      .map((f) => path.join(LESSON_DIR, f));
  } else {
    const p = args.find((a) => !a.startsWith('--'));
    if (!p) {
      console.log(`用法：
  node tools/link-answers.js <音频路径>     处理单个课程
  node tools/link-answers.js --all          处理 IELTS-剑桥真题 下全部
  node tools/link-answers.js --all --dry    只统计不写回`);
      process.exit(1);
    }
    targets = [path.resolve(p)];
  }

  console.log('');
  console.log(`关联答案到原文：${targets.length} 个课程${dry ? '（--dry 不写回）' : ''}`);
  console.log('');

  let sumTotal = 0, sumExact = 0, sumSec = 0, sumNone = 0, ok = 0, fail = 0;

  for (const t of targets) {
    const r = processOne(t, { dry });
    if (r.error) { console.log(`  ✗ ${path.basename(t)} :: ${r.error}`); fail++; continue; }
    ok++;
    sumTotal += r.total; sumExact += r.exact; sumSec += r.section; sumNone += r.none;
    const pct = ((r.exact / r.total) * 100).toFixed(0);
    console.log(`  ✓ ${r.name.padEnd(14)} ${String(r.total).padStart(2)} 题  `
      + `精确 ${String(r.exact).padStart(2)}  Section 兜底 ${String(r.section).padStart(2)}  `
      + `未定位 ${String(r.none).padStart(2)}  精确率 ${pct}%`);
  }

  console.log('');
  console.log('─'.repeat(66));
  console.log(`成功 ${ok}，失败 ${fail}`);
  console.log(`合计 ${sumTotal} 题：精确匹配 ${sumExact}（${(sumExact / Math.max(1, sumTotal) * 100).toFixed(1)}%），`
    + `Section 兜底 ${sumSec}，未定位 ${sumNone}`);
  console.log('');
}

if (require.main === module) main();

module.exports = { norm, numberToWords, answerVariants, findSectionStarts, sectionOf, qNum, linkQuestions };

#!/usr/bin/env node
/**
 * polish-lrc.js — 审校并修正 Whisper 转写的原文
 *
 * 为什么需要：
 *   Whisper 的转写整体可用，但有一批【可预期的系统性错误】，人工逐条改不现实。
 *   实测常见问题：
 *     · 专有名词错拼：IELTS 被写错、Cambridge 大小写混乱
 *     · 英式拼写被美式化（centre → center，而雅思听力用英式）
 *     · 数字写法不统一（2020 有时写成 "twenty twenty"）
 *     · 重复词（"the the"）、多余空格、破折号被拆成两个词
 *     · 句尾缺少标点
 *   这些都改不掉"听不懂"的部分，但能消掉一眼可见的机械错误。
 *
 * ⚠️ 两条硬性原则：
 *   1. **只做可逆、可解释的替换**，不做"改写"。
 *      原文的价值在于忠实于音频，擅自润色反而会误导听力练习。
 *   2. **不覆盖原文件**。修正写到 <name>.lrc.polished.json，
 *      经人工抽查确认后再用 --apply 应用（仍可通过修订机制还原）。
 *
 * 用法：
 *   node tools/polish-lrc.js --scan              扫描，统计各类问题有多少
 *   node tools/polish-lrc.js --dry <课程>        看某个课程会改什么（不写文件）
 *   node tools/polish-lrc.js --all --dry         全量预览
 *   node tools/polish-lrc.js --all               写出修正文件
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const LESSON_DIR = path.join(ROOT, 'audio', 'IELTS-剑桥真题');

// ---------------------------------------------------------------- 修正规则
//
// 每条规则都是「确定的错误 → 确定的正确形式」，不做语义改写。
// 按类别分组，便于 --scan 统计和人工复核。

const RULES = [
  {
    name: '专有名词',
    // 雅思听力反复出现这些词，Whisper 偶有错拼
    apply: (s) => s
      .replace(/\bI\.?E\.?L\.?T\.?S\b/gi, 'IELTS')
      .replace(/\bIELTS\s*(\d)/g, 'IELTS $1')
      .replace(/\bIelts\b/g, 'IELTS')
      .replace(/\bCambrige\b|\bCambride\b|\bCambrdige\b/gi, 'Cambridge')
      .replace(/\bCambrdige\s+University\b/gi, 'Cambridge University')
      .replace(/\bAssesment\b/gi, 'Assessment')
      .replace(/\bUniveristy\b/gi, 'University')
      .replace(/\bExaminations?\s+English\b/gi, 'English Examinations'),
  },
  {
    name: '英式拼写（雅思用英式）',
    // 注意：只在明确是名词/动词时替换，避免误改其它词
    apply: (s) => s
      .replace(/\bcenter\b/g, 'centre').replace(/\bCenter\b/g, 'Centre')
      .replace(/\bcenters\b/g, 'centres').replace(/\bCenters\b/g, 'Centres')
      .replace(/\btheater\b/g, 'theatre').replace(/\bTheater\b/g, 'Theatre')
      .replace(/\bcolor\b/g, 'colour').replace(/\bColor\b/g, 'Colour')
      .replace(/\bcolors\b/g, 'colours').replace(/\bColors\b/g, 'Colours')
      .replace(/\bfavorite\b/g, 'favourite').replace(/\bFavorite\b/g, 'Favourite')
      .replace(/\borganiz(e|ed|ing|ation)\b/g, (m, x) => 'organis' + x)
      .replace(/\brealiz(e|ed|ing)\b/g, (m, x) => 'realis' + x)
      .replace(/\brecogniz(e|ed|ing)\b/g, (m, x) => 'recognis' + x)
      .replace(/\bprogram\b(?!me)/g, 'programme')
      .replace(/\bmetre\b/g, 'metre'),
  },
  {
    name: '机械错误（重复词 / 空格 / 破折号）',
    apply: (s) => {
      let t = s;
      // 连续重复的同一个词（"the the"），保留一个
      t = t.replace(/\b(\w+)(\s+\1\b)+/gi, '$1');
      // 两个及以上空格压成一个
      t = t.replace(/[ \t]{2,}/g, ' ');
      // 句中的 " - " 或 "--" 统一成破折号前后的规范写法
      t = t.replace(/\s+-\s+/g, ' — ');
      t = t.replace(/\s*--+\s*/g, ' — ');
      // 逗号句号前的多余空格
      t = t.replace(/\s+([,.;:!?])/g, '$1');
      // 括号内侧空格
      t = t.replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');
      return t;
    },
  },
  {
    name: 'IELTS 固定说法',
    // 听力录音里的固定念白，Whisper 常把词粘连或拆错
    apply: (s) => s
      .replace(/\bSection\s*(\d)\b/g, 'Section $1')
      .replace(/\bPart\s*(\d)\b/g, 'Part $1')
      .replace(/\bONE WORD AND\/?OR A NUMBER\b/gi, 'ONE WORD AND/OR A NUMBER')
      .replace(/\bNO MORE THAN (\w+) WORDS?\b/gi, (m, n) => `NO MORE THAN ${n.toUpperCase()} WORDS`)
      .replace(/\bIN EITHER ORDER\b/gi, 'IN EITHER ORDER')
      .replace(/\bIN ANY ORDER\b/gi, 'IN ANY ORDER')
      .replace(/\bWrite\s+ONE WORD\b/gi, 'Write ONE WORD')
      .replace(/\bIELTS listening test\b/gi, 'IELTS listening test'),
  },
  {
    name: '标点收尾',
    // ⚠️ 这条规则很危险，必须配合 mergeContinuations 用。
    //    Whisper 常把一句话切成几行，例如
    //        [42.06] …transfer your answers to an
    //        [44.10] answer sheet.
    //    如果直接给第一行补句号，就变成 "…to an."，制造出错误断句。
    //    所以只在【这一行确实是完整句】时才补 —— 由调用方通过
    //    polishDocument 的合并步骤保证：合并后的行才是完整句。
    apply: (s) => {
      const t = s.trim();
      if (!t) return t;
      if (/[.!?。？！:;,"']$/.test(t)) return t;   // 已有标点或以引号/逗号结尾，不动
      if (/^(what|why|how|when|where|who|which|do|does|did|is|are|was|were|can|could|would|should|will)\b/i.test(t)) {
        return t + '?';
      }
      return t + '.';
    },
  },
];

/**
 * 合并被 Whisper 切碎的续行。
 *
 * 判断依据：
 *   1. 上一行结尾没有句末标点（. ! ? : ; " ）
 *   2. 下一行以**小写字母**开头  ← 最强信号，正常新句都大写开头
 *   3. 间隔不超过 MAX_GAP
 *
 * ⚠️ MAX_GAP 不能设小。实测雅思录音里的「读题停顿」很长：
 *      [42.06] …you will be given ten minutes to transfer your answers to an
 *      [48.50] answer sheet.          ← 中间隔了 6.44 秒
 *    一开始按「停顿短才算续行」设成 2.5 秒，这种就没合并上，
 *    紧接着的补句号规则把 "…to an" 变成 "…to an."，制造出错误断句。
 *    小写开头本身已经是很强的判据，所以间隔放宽到 10 秒。
 */
const MAX_GAP = 10.0;

function isContinuation(prevText, nextText, gap) {
  const p = String(prevText).trim();
  const n = String(nextText).trim();
  if (!p || !n) return false;
  if (/[.!?。？！:;,"')\]—]$/.test(p)) return false;   // 上一行已收尾
  if (!/^[a-z]/.test(n)) return false;                 // 下一行不是小写开头
  if (gap > MAX_GAP) return false;                     // 间隔太久，可能是新段落
  return true;
}

/** 对整篇时间轴做「先合并续行，再套规则」 */
function polishDocument(rows) {
  // rows: [{time, text}]
  const merged = [];
  for (const r of rows) {
    const last = merged[merged.length - 1];
    if (last && isContinuation(last.text, r.text, r.time - last.time)) {
      last.text = (last.text.replace(/\s+$/, '') + ' ' + r.text.trim()).replace(/\s+/g, ' ');
      last.mergedCount = (last.mergedCount || 1) + 1;
      continue;
    }
    merged.push({ time: r.time, text: r.text.trim() });
  }

  const stat = {};
  let touched = 0;
  const out = merged.map((r) => {
    const { text, changes } = polishLine(r.text);
    if (text !== r.text) {
      touched++;
      for (const c of changes) stat[c] = (stat[c] || 0) + 1;
    }
    return { ...r, text };
  });

  return { rows: out, mergedFrom: rows.length, mergedTo: merged.length, touched, stat };
}

/** 对一行文本应用全部规则，返回 {text, changes:[规则名]} */
function polishLine(text) {
  let cur = String(text);
  const changes = [];
  for (const r of RULES) {
    const next = r.apply(cur);
    if (next !== cur) { changes.push(r.name); cur = next; }
  }
  return { text: cur, changes };
}

// ---------------------------------------------------------------- LRC 读写

const LRC_TIME = /^\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/;

function parseTime(stamp) {
  const m = /^\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/.exec(stamp);
  if (!m) return 0;
  return Number(m[1]) * 60 + parseFloat(String(m[2]).replace(':', '.'));
}

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  return `[${String(m).padStart(2, '0')}:${(sec - m * 60).toFixed(2).padStart(5, '0')}]`;
}

/** 读出时间轴行与元信息行 */
function splitLrc(text) {
  const rows = [];
  const meta = [];
  for (const raw of String(text).replace(/\r\n/g, '\n').split('\n')) {
    const t = raw.trim();
    if (!t) continue;
    const stamp = LRC_TIME.exec(t);
    if (!stamp) { meta.push(raw); continue; }
    const idx = t.indexOf(']');
    rows.push({ time: parseTime(t.slice(0, idx + 1)), text: t.slice(idx + 1) });
  }
  return { rows, meta };
}

/** 完整流程：合并续行 → 套规则 → 重新拼 LRC */
function polishLrc(text) {
  const { rows, meta } = splitLrc(text);
  const r = polishDocument(rows);
  const lines = [
    ...meta,
    ...r.rows.map((x) => fmtTime(x.time) + x.text),
  ];
  return {
    text: lines.join('\n'),
    total: rows.length,
    finalLines: r.rows.length,
    merged: r.mergedFrom - r.mergedTo,
    touched: r.touched,
    stat: r.stat,
    rows: r.rows,
  };
}

// ---------------------------------------------------------------- 主流程

function listLessons() {
  if (!fs.existsSync(LESSON_DIR)) return [];
  return fs.readdirSync(LESSON_DIR)
    .filter((f) => /^C\d+-Test\d\.lrc$/i.test(f))
    .sort();
}

function main() {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const dry = args.includes('--dry');
  const scan = args.includes('--scan');

  const files = listLessons();
  if (!files.length) { console.error('没找到课程 LRC：' + LESSON_DIR); process.exit(1); }

  const targets = all ? files : files.filter((f) => args.includes(f) || args.includes(f.replace('.lrc', '')));
  if (!targets.length && !scan) {
    console.log(`用法：
  node tools/polish-lrc.js --scan            统计各类问题
  node tools/polish-lrc.js --all --dry       全量预览改动
  node tools/polish-lrc.js --all             写出修正文件
  node tools/polish-lrc.js C10-Test1.lrc     只处理某个课程`);
    process.exit(1);
  }

  console.log('');
  console.log(`课程 ${files.length} 个${all ? '（全部）' : targets.length ? `（选中 ${targets.length} 个）` : ''}`);
  console.log('');

  const grand = {};
  let grandTotal = 0, grandTouched = 0;
  let written = 0;

  const show = scan ? files : targets;

  for (const f of show) {
    const p = path.join(LESSON_DIR, f);
    const text = fs.readFileSync(p, 'utf8');
    const r = polishLrc(text);
    grandTotal += r.total;
    grandTouched += r.touched;
    for (const [k, v] of Object.entries(r.stat)) grand[k] = (grand[k] || 0) + v;

    if (scan) continue;

    if (dry) {
      // 只打印前几处改动
      const orig = text.split('\n');
      const fixed = r.text.split('\n');
      console.log(`── ${f}  ${r.touched}/${r.total} 行有改动`);
      let shown = 0;
      for (let i = 0; i < orig.length && shown < 4; i++) {
        if (orig[i] !== fixed[i]) {
          console.log(`   - ${orig[i].slice(0, 100)}`);
          console.log(`   + ${fixed[i].slice(0, 100)}`);
          shown++;
        }
      }
      if (r.touched > shown) console.log(`   …还有 ${r.touched - shown} 处`);
      console.log('');
    } else {
      const out = path.join(LESSON_DIR, f.replace(/\.lrc$/, '.lrc.polished.json'));
      fs.writeFileSync(out, JSON.stringify({
        generatedAt: new Date().toISOString(),
        note: 'Whisper 转写的机械性错误修正（专有名词/英式拼写/重复词/标点）。未改动语义。',
        tool: 'tools/polish-lrc.js',
        stats: {
          total: r.total,          // 原始行数
          finalLines: r.finalLines, // 合并后的行数
          merged: r.merged,         // 因续行合并而减少的行数
          touched: r.touched,       // 被规则改动的行数
          byRule: r.stat,
        },
        text: r.text,
      }, null, 2), 'utf8');
      written++;
    }
  }

  console.log('─'.repeat(64));
  console.log(`时间轴行合计 ${grandTotal}，其中有机械性错误的 ${grandTouched} 行（${(grandTouched / grandTotal * 100).toFixed(1)}%）`);
  console.log('');
  console.log('按类别：');
  for (const [k, v] of Object.entries(grand).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(24)} ${String(v).padStart(5)} 行`);
  }
  if (!scan && !dry) console.log(`\n已写出 ${written} 个修正文件（*.lrc.polished.json）`);
  console.log('');
}

if (require.main === module) main();

module.exports = { polishLine, polishLrc, polishDocument, isContinuation, splitLrc, RULES };

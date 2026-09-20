#!/usr/bin/env node
/**
 * parse-qstem.js — 把「题干 + 答案」纯文本转成播放器的 questions.json
 *
 * 适用格式（四六级真题归档里很常见）：
 *
 *   1. A) They reward businesses that eliminate food waste
 *      B) They prohibit the sale of foods that have gone stale
 *      C) They facilitate the donation of unsold foods to the needy
 *      D) They forbid businesses to produce more foods than needed
 *
 *   答案文件形如：1. C   2. B   3. A ...
 *
 * 生成的是「题干 + 选项 + 答案」，没有逐题解析（原始文件里也没有）。
 * start/end 留待 tools/calibrate-questions.js 用真实时间轴自动校准。
 *
 * 用法：
 *   node tools/parse-qstem.js --stem=<题干.txt> --answer=<答案.txt> --audio=<音频>
 *   node tools/parse-qstem.js --stem=... --answer=... --audio=... --write
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

function arg(name, def) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return def;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
}

const WRITE = Boolean(arg('write', false));

/** 解析题干：返回 [{number, stem, options:[{key,text}]}] */
function parseStem(text) {
  const lines = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let cur = null;

  // 四六级题库的实际排版有三种行，必须按下面的顺序判断，
  // 否则 "1. A) xxx" 会被误当成题干（A) 部分当题干、选项只剩 3 个）：
  //   1) "1. A) 选项"   ← 题号与第一个选项同一行（最常见）
  //   2) "1. 题干文字"  ← 题号与题干同一行
  //   3) "   A) 选项"   ← 纯选项行
  const qWithOptRe = /^\s*(\d{1,2})\s*[.、)]\s*([A-D])\s*[.、)]\s*(.*)$/;
  const qRe = /^\s*(\d{1,2})\s*[.、)]\s*(.*)$/;
  const optRe = /^\s*([A-D])\s*[.、)]\s*(.*)$/;

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;

    // 1) 题号 + 首个选项在同一行
    const qo = qWithOptRe.exec(line);
    if (qo) {
      cur = { number: Number(qo[1]), stem: '', options: [{ key: qo[2], text: qo[3].trim() }] };
      out.push(cur);
      continue;
    }

    // 2) 纯选项行（必须早于题干规则，否则 "A) ..." 不会被识别）
    const om = optRe.exec(line);
    if (om && cur) {
      cur.options.push({ key: om[1], text: om[2].trim() });
      continue;
    }

    // 3) 题号 + 题干
    const qm = qRe.exec(line);
    if (qm) {
      cur = { number: Number(qm[1]), stem: qm[2].trim(), options: [] };
      out.push(cur);
      continue;
    }

    // 续行：接到最后一个选项，或接回题干
    if (cur) {
      if (cur.options.length) {
        const last = cur.options[cur.options.length - 1];
        last.text = (last.text + ' ' + line.trim()).replace(/\s+/g, ' ').trim();
      } else {
        cur.stem = (cur.stem + ' ' + line.trim()).replace(/\s+/g, ' ').trim();
      }
    }
  }

  return out.filter((q) => q.options.length >= 2);
}

/** 解析答案："1. C 2. B" 或每行一个 "1 C" */
function parseAnswers(text) {
  const map = new Map();
  const s = String(text).replace(/^\uFEFF/, '');
  for (const m of s.matchAll(/(\d{1,2})\s*[.、:)]?\s*([A-D])\b/g)) {
    const n = Number(m[1]);
    if (!map.has(n)) map.set(n, m[2]);
  }
  return map;
}

/**
 * 从句 transcript markdown 里抽出「题号 → 答案句」。
 *
 * 这类真题解析文件用行内标记指认答案出处，形如：
 *   W: ... New laws have been put into place that will make it easier for farms
 *      and supermarkets to [1] donate unsold foods to those who are in need.
 * 这里的 [1] 就表示「第 1 题的答案在这句」。
 *
 * 拿到答案句有两个用处：
 *   1. 填进 questions.json 的 transcript，答题后可以直接看到原文依据；
 *   2. 作为 tools/calibrate-questions.js 的定位依据，自动算出每题的音频片段。
 * 请注意题干本身通常不在这类文件里（四六级的提问是录音念的），
 * 所以 stem 会留空，由界面提示「题干见音频」。
 */
function parseRefs(markdown) {
  const map = new Map();
  const text = String(markdown).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!/\[\d{1,2}\]/.test(line)) continue;

    // 去掉说话人前缀（M: / W: / Speaker:）
    const body = line.replace(/^[MW]\s*:\s*/i, '').replace(/^[A-Za-z ]{2,20}:\s*/, '');

    for (const m of body.matchAll(/\[(\d{1,2})\]/g)) {
      const n = Number(m[1]);
      if (map.has(n)) continue;
      // 取标记所在的那一句（以句末标点切分）
      const start = body.lastIndexOf('.', m.index) + 1;
      let end = body.indexOf('.', m.index);
      if (end === -1) end = body.length;
      const sentence = body.slice(start, end + 1).replace(/\[\d{1,2}\]/g, '').replace(/\s+/g, ' ').trim();
      if (sentence) map.set(n, sentence);
    }
  }
  return map;
}

function main() {
  const stemPath = arg('stem');
  const answerPath = arg('answer');
  const refsPath = arg('refs');
  const audioPath = arg('audio');

  if (!stemPath) {
    console.log(`用法：node tools/parse-qstem.js --stem=<题干.txt> [选项]

选项：
  --answer=<文件>   答案文件（"1. C  2. B" 形式）
  --refs=<文件>     真题解析 md，内含 [1] [2] 这类答案句标记
  --audio=<音频>    用于确定输出文件名（配 --write）
  --exam= / --source= / --license=
  --write           写回 <音频同名>.questions.json

生成的题干可能为空（四六级的提问是录音念的，题库文件里通常没有题干），
此时界面会提示"题干见音频"；答案句会填进 transcript，
再用 node tools/calibrate-questions.js audio --write 就能自动算出每题的音频片段。`);
    process.exit(1);
  }

  if (!fs.existsSync(stemPath)) { console.error('题干文件不存在：' + stemPath); process.exit(1); }

  const questions = parseStem(fs.readFileSync(stemPath, 'utf8'));
  const answers = answerPath && fs.existsSync(answerPath)
    ? parseAnswers(fs.readFileSync(answerPath, 'utf8'))
    : new Map();
  const refs = refsPath && fs.existsSync(refsPath)
    ? parseRefs(fs.readFileSync(refsPath, 'utf8'))
    : new Map();

  console.log('');
  console.log(`解析出 ${questions.length} 道题　答案 ${answers.size} 条　原文依据句 ${refs.size} 条`);
  console.log('');

  const doc = {
    title: (audioPath ? path.basename(String(audioPath), path.extname(String(audioPath))) : '导入的真题'),
    exam: String(arg('exam', 'cet6')).toLowerCase(),
    section: '',
    source: String(arg('source', '')),
    license: String(arg('license', '')),
    questions: questions.map((q) => {
      const ans = answers.get(q.number) || '';
      const ref = refs.get(q.number) || '';
      return {
        number: q.number,
        tag: '',
        stem: q.stem || '',
        options: q.options.map((o) => o.text),
        answer: ans,
        explain: ans ? '' : '答案未从答案文件解析到，请手工补填。',
        start: null,
        end: null,
        transcript: ref,
      };
    }),
  };

  // 抽样打印
  for (const q of doc.questions.slice(0, 3)) {
    console.log(`  #${q.number}  ${q.stem.slice(0, 70)}`);
    q.options.forEach((o, i) => console.log(`      ${String.fromCharCode(65 + i)}) ${o.slice(0, 66)}`));
    console.log(`      答案：${q.answer || '(缺)'}`);
    console.log('');
  }

  const missing = doc.questions.filter((q) => !q.answer).length;
  if (missing) console.log(`  ⚠ 有 ${missing} 题没解析到答案`);

  // 写文件
  if (WRITE) {
    if (!audioPath) { console.error('--write 需要同时给 --audio，才能确定输出文件名'); process.exit(1); }
    const audioAbs = path.resolve(String(audioPath));
    const base = audioAbs.slice(0, audioAbs.length - path.extname(audioAbs).length);
    const outPath = base + '.questions.json';
    fs.writeFileSync(outPath, JSON.stringify(doc, null, 2), 'utf8');
    console.log('');
    console.log(`已写出 ${outPath}`);
    console.log('下一步（用真实时间轴校准每题的回放片段）：');
    console.log('  node tools/calibrate-questions.js audio --write');
  } else {
    console.log('');
    console.log('（这是 dry-run，加 --write --audio=<音频> 才会写文件）');
  }
  console.log('');
}

if (require.main === module) main();

module.exports = { parseStem, parseAnswers };

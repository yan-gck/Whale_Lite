#!/usr/bin/env node
/**
 * merge-paper.js — 把原题 PDF 抽出的题干/选项/指令，合并进各课程的 questions.json
 *
 * 输入：
 *   build/cambridge-papers.json          （tools/parse-paper.js json）
 *   build/cambridge-answers.json         （tools/parse-answers.js json）
 *   audio/IELTS-剑桥真题/C<书号>-Test<套号>.questions.json
 * 输出：更新 questions.json，每题补上：
 *   group        所属题组（如 "Q21-25"）
 *   instructions 该题组的题型指令（如 "Choose the correct letter, A, B or C."）
 *   optionsText  该题组的选项原文（选择题用）
 *
 * 一个重要收益：
 *   选择题的答案是字母（A/B/C），之前无法匹配到原文、也无法展示选项内容。
 *   有了原题 PDF 的选项文字后，可以把字母换成实际选项内容展示，
 *   并把它作为答案文本参与原文定位（比只靠 Section 兜底精确得多）。
 *
 * 用法：
 *   node tools/merge-paper.js            合并
 *   node tools/merge-paper.js --dry      只看会改什么
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const LESSON_DIR = path.join(ROOT, 'audio', 'IELTS-剑桥真题');
const PAPERS = path.join(ROOT, 'build', 'cambridge-papers.json');
const ANSWERS = path.join(ROOT, 'build', 'cambridge-answers.json');

const DRY = process.argv.includes('--dry');

/** 判断题号属于哪个题组 */
function groupOf(groups, num) {
  return groups.find((g) => num >= g.from && num <= g.to) || null;
}

function main() {
  if (!fs.existsSync(PAPERS)) {
    console.error('缺少 ' + PAPERS + '\n请先运行：node tools/parse-paper.js json');
    process.exit(1);
  }

  const papers = JSON.parse(fs.readFileSync(PAPERS, 'utf8'));
  const answers = fs.existsSync(ANSWERS) ? JSON.parse(fs.readFileSync(ANSWERS, 'utf8')) : [];

  const paperByBook = new Map(papers.map((p) => [p.book, p]));
  const ansByBook = new Map(answers.map((a) => [a.book, a.tests || []]));

  const files = fs.readdirSync(LESSON_DIR).filter((f) => /^C\d+-Test\d\.questions\.json$/i.test(f));
  console.log('');
  console.log(`课程题库 ${files.length} 个；原题 ${papers.length} 本；答案 ${answers.length} 本`);
  console.log('');

  let updated = 0, choiceWithText = 0, totalChoice = 0, noPaper = 0;

  for (const f of files.sort()) {
    const m = /^C(\d+)-Test(\d)\./i.exec(f);
    const book = Number(m[1]), test = Number(m[2]);
    const qPath = path.join(LESSON_DIR, f);
    const doc = JSON.parse(fs.readFileSync(qPath, 'utf8'));

    const paper = paperByBook.get(book);
    const paperTest = paper && paper.tests ? paper.tests[String(test)] : null;
    if (!paperTest) { noPaper++; continue; }

    // 过滤掉内容过少的题组，但要保留「有指令」的组。
    // 之前只看内容长度（>10 字符），把内容恰好是页眉的题组误删了：
    // 例如 OCR 出的 "Questions 11-12" 组正文只有 "SECTION 2"（9 字符），
    // 结果该组题号全部拿不到题组信息。
    const groups = (paperTest.groups || []).filter((g) =>
      (g.content && g.content.join('').length > 10)
      || (g.instructions && g.instructions.length)
      || (g.options && g.options.length >= 2));

    let touched = 0;
    for (const q of doc.questions || []) {
      const num = Number(q.number);
      if (!Number.isFinite(num)) continue;

      const g = groupOf(groups, num);
      if (!g) continue;

      q.group = `Q${g.from}-${g.to}`;
      if (g.instructions && g.instructions.length) q.instructions = g.instructions;
      if (g.options && g.options.length) q.optionsText = g.options;

      // 选择题：把字母答案换成实际选项内容
      const ansLetter = String(q.answer || '').trim().toUpperCase();
      if (/^[A-H]$/.test(ansLetter) && g.options && g.options.length) {
        totalChoice++;
        const hit = g.options.find((o) => o.key === ansLetter);
        if (hit) {
          q.answerText = hit.text;
          choiceWithText++;
        }
      }
      touched++;
    }

    const withGroup = (doc.questions || []).filter((q) => q.group).length;
    doc.paperSource = {
      kind: 'cambridge-question-paper',
      from: 'tools/parse-paper.js（原题 PDF OCR）',
      groups: groups.length,
      questionsWithGroup: withGroup,
      generatedAt: new Date().toISOString().slice(0, 10),
    };

    // 原题全文写成一个可读文本，界面里对照着看（题目面板只放指令，正文太长）
    if (!DRY && groups.length) {
      const txt = [];
      txt.push(`剑桥雅思 ${book} · Test ${test} 听力原题`);
      txt.push('来源：用户提供的原题 PDF，经 OCR 识别（可能有识别错误，以 PDF 原件为准）');
      txt.push('');
      txt.push('═'.repeat(58));
      for (const g of groups) {
        txt.push('');
        txt.push(`【Questions ${g.from}-${g.to}】`);
        if (g.instructions && g.instructions.length) {
          for (const s of g.instructions) txt.push('  ' + s);
          txt.push('');
        }
        for (const l of g.content) txt.push('  ' + l);
      }
      fs.writeFileSync(path.join(LESSON_DIR, `C${book}-Test${test}.paper.txt`), txt.join('\n') + '\n', 'utf8');
    }

    if (!DRY) fs.writeFileSync(qPath, JSON.stringify(doc, null, 2), 'utf8');
    updated++;
    console.log(`  ✓ ${f.replace('.questions.json', '').padEnd(14)} 题组 ${String(groups.length).padStart(2)}  `
      + `覆盖 ${String(withGroup).padStart(2)}/40 题  选择题带上选项文字 ${(doc.questions || []).filter((q) => q.answerText).length}`);
  }

  console.log('');
  console.log('─'.repeat(64));
  console.log(`更新 ${updated} 个课程；选择题 ${choiceWithText}/${totalChoice} 拿到了选项文字`
    + (noPaper ? `；${noPaper} 个课程暂无原题数据` : ''));
  console.log(DRY ? '（--dry，未写文件）' : '');
  console.log('');
}

if (require.main === module) main();

module.exports = { groupOf };

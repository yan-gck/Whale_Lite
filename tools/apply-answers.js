#!/usr/bin/env node
/**
 * apply-answers.js — 把解析出的《剑桥雅思》答案写进各课程的 questions.json
 *
 * 输入：
 *   build/cambridge-answers.json      （tools/parse-answers.js json 产出）
 *   audio/IELTS-剑桥真题/C<书号>-Test<套号>.{questions.json,lrc}
 * 输出：
 *   更新 questions.json —— 每题补上 answer / alternatives / section / tag
 *
 * 题目结构说明：
 *   剑桥雅思听力固定 40 题、4 个 Section（各 10 题），但**题干需要看原题 PDF**，
 *   这里只用「题号 + 答案」建骨架；题干留空由界面提示。
 *   同时把 Section 边界标注进每题（tag: "Section 1" 等），便于分组显示。
 *
 * 用法：
 *   node tools/apply-answers.js            写入
 *   node tools/apply-answers.js --dry      只看会改什么
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const LESSON_DIR = path.join(ROOT, 'audio', 'IELTS-剑桥真题');
const ANSWERS = path.join(ROOT, 'build', 'cambridge-answers.json');

const DRY = process.argv.includes('--dry');

function sectionOf(num) {
  return Math.min(4, Math.floor((num - 1) / 10) + 1);
}

/** 判断题号区间：剑桥雅思固定 1-40 */
const TOTAL_Q = 40;

function main() {
  if (!fs.existsSync(ANSWERS)) {
    console.error('缺少 ' + ANSWERS);
    console.error('请先运行：node tools/parse-answers.js json');
    process.exit(1);
  }

  const parsed = JSON.parse(fs.readFileSync(ANSWERS, 'utf8'));

  // book -> [ {questions} x 4 ]
  const byBook = new Map();
  for (const b of parsed) byBook.set(b.book, b.tests || []);

  const files = fs.readdirSync(LESSON_DIR).filter((f) => /\.mp3$/i.test(f));
  console.log('');
  console.log(`课程 ${files.length} 个；答案来源 ${parsed.length} 本`);
  console.log('');

  let updated = 0, noAnswer = 0, noFile = 0;
  let totalFilled = 0, totalQ = 0;

  for (const f of files.sort()) {
    const m = /^C(\d+)-Test(\d)\.mp3$/i.exec(f);
    if (!m) { console.log(`  · 跳过（命名不符）${f}`); noFile++; continue; }

    const book = Number(m[1]), test = Number(m[2]);
    const base = f.replace(/\.mp3$/i, '');
    const qPath = path.join(LESSON_DIR, `${base}.questions.json`);

    const tests = byBook.get(book);
    const ansTest = tests && tests[test - 1];
    if (!ansTest || !ansTest.questions || !ansTest.questions.length) {
      console.log(`  ✗ 剑${book} Test${test}：没有对应答案，跳过`);
      noAnswer++;
      continue;
    }

    // 读现有 questions.json（可能是骨架），没有就现建
    let qDoc;
    if (fs.existsSync(qPath)) {
      try { qDoc = JSON.parse(fs.readFileSync(qPath, 'utf8')); }
      catch { qDoc = null; }
    }
    if (!qDoc) {
      qDoc = {
        title: `剑桥雅思 ${book} · Test ${test} 听力`,
        exam: 'ielts',
        section: 'Listening Test（Section 1-4，Q1-40）',
        paper: `剑桥雅思 ${book} Test ${test}`,
        source: '用户自备音频（《剑桥雅思》Cambridge University Press）',
        license: '题目与答案版权属剑桥大学出版社，仅供个人学习使用，请勿分发',
        questions: [],
      };
    }

    // 以 40 题为准重建（保留已有题干/选项/解析，若有）
    const old = new Map((qDoc.questions || []).map((q) => [q.number, q]));
    const ansMap = new Map(ansTest.questions.map((q) => [q.num, q]));

    const questions = [];
    let filled = 0;
    for (let n = 1; n <= TOTAL_Q; n++) {
      const prev = old.get(n) || {};
      const a = ansMap.get(n);
      const q = {
        number: n,
        tag: prev.tag || `Section ${sectionOf(n)}`,
        section: sectionOf(n),
        stem: prev.stem || '',
        options: prev.options || [],
        answer: (a && a.answer) || prev.answer || '',
        alternatives: (a && a.alternatives) || prev.alternatives || [],
        explain: prev.explain || '',
        start: prev.start != null ? prev.start : null,
        end: prev.end != null ? prev.end : null,
        transcript: prev.transcript || '',
      };
      if (q.answer) filled++;
      questions.push(q);
    }

    qDoc.questions = questions;
    qDoc.answerSource = {
      kind: 'cambridge-answer-key',
      parsedFrom: ansTest.source || 'textlayer',
      filled,
      total: TOTAL_Q,
      generatedAt: new Date().toISOString().slice(0, 10),
      tool: 'tools/apply-answers.js',
    };

    if (!DRY) fs.writeFileSync(qPath, JSON.stringify(qDoc, null, 2), 'utf8');

    totalFilled += filled; totalQ += TOTAL_Q;
    updated++;
    const flag = filled >= TOTAL_Q * 0.9 ? '✓' : (filled >= TOTAL_Q * 0.6 ? '⚠' : '✗');
    console.log(`  ${flag} ${base.padEnd(14)} 填入 ${String(filled).padStart(2)}/40 答案`);
  }

  console.log('');
  console.log('─'.repeat(60));
  console.log(`更新 ${updated} 个课程，共填入 ${totalFilled}/${totalQ} 个答案`
    + (noAnswer ? `；${noAnswer} 个课程无答案` : '')
    + (noFile ? `；${noFile} 个命名不符` : ''));
  console.log(DRY ? '（--dry，未写文件）' : '');
  console.log('');
}

if (require.main === module) main();

module.exports = { sectionOf };

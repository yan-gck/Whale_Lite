#!/usr/bin/env node
/**
 * import-ielts-cambridge.js — 把《剑桥雅思真题》听力音频整理成播放器课程
 *
 * 来源：用户自备的音频文件（文件名含 "C19-Test 01" 这类编号）
 *
 * ⚠️ 关于"对应的文字题目"：
 *   剑桥雅思（Cambridge IELTS）的题目、答案、听力原文都收录在正式出版的书中，
 *   版权属于剑桥大学出版社。网上没有可合法抓取的全套题目文本。
 *   所以本脚本只做三件事：
 *     1. 把音频按「书号 + Test 号」规范化命名并导入播放器
 *     2. 生成符合真实考试的题目结构骨架（Section 1-4 / Q1-40），你照着书填空
 *     3. 把官方音频里自带的考试指令（Directions）文本写进原文，方便对照
 *   题目内容需要你自己从书上录入，或用 tools/parse-qstem.js 从你已有的文本导入。
 *
 * 用法：
 *   node tools/import-ielts-cambridge.js list            列出识别出的书与 Test
 *   node tools/import-ielts-cambridge.js import          导入到 audio/IELTS-剑桥真题/
 *   node tools/import-ielts-cambridge.js import --dry    只预览
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'audio', 'IELTS-剑桥真题');
const DRY = process.argv.includes('--dry');

// 音频所在目录（用户放在工作区根目录）
const SRC_DIR = process.argv.find((a) => a.startsWith('--src='))
  ? path.resolve(process.argv.find((a) => a.startsWith('--src=')).slice(6))
  : path.resolve('F:/DSH workshop/【雅思听力】《剑雅真题1-19》听力+音频合集（共64集）_雅思听力磨耳朵素材');

const { mediaDuration } = require('./media-duration.js');

/** 从文件名解析出书号与 Test 号 */
function parseName(file) {
  // 形如：... - 1.1.C 19-Test 01(Av...,P1).mp3  或  ... - 10.10.C17-Test 2(...).mp3
  const m = /C\s*(\d{1,2})\s*-\s*Test\s*0?(\d)/i.exec(file);
  if (!m) return null;
  const seq = /-\s*(\d+)\.\d+\./.exec(file);
  return {
    book: Number(m[1]),
    test: Number(m[2]),
    seq: seq ? Number(seq[1]) : 0,
  };
}

/** 官方音频开头会念这段指令，写进原文方便对照 */
const DIRECTIONS = [
  'SECTION 1',
  'You will hear a number of different recordings and you will have to answer questions on what you hear.',
  'There will be time for you to read the instructions and questions and you will have a chance to check your work.',
  'All the recordings will be played ONCE only.',
  'The test is in four parts. At the end of the test you will be given ten minutes to transfer your answers to an answer sheet.',
  'Now turn to Section 1.',
  '',
  'SECTION 2',
  'You will hear a talk. First you have some time to look at Questions 11 to 20.',
  '',
  'SECTION 3',
  'You will hear a conversation. First you have some time to look at Questions 21 to 30.',
  '',
  'SECTION 4',
  'You will hear part of a lecture. First you have some time to look at Questions 31 to 40.',
].join('\n');

/**
 * 生成题目结构骨架。
 * 剑桥雅思听力的题型与题号区间是固定的：
 *   Section 1  Q1-10   日常场景对话（多为表格/笔记填空）
 *   Section 2  Q11-20  独白（地图/多选/匹配）
 *   Section 3  Q21-30  学术讨论（多选/匹配）
 *   Section 4  Q31-40  学术讲座（笔记填空）
 * 具体题干与选项需要按书填写，这里只给出结构，避免把猜测内容当成真题。
 */
function skeletonQuestions() {
  const qs = [];
  let n = 1;
  for (let s = 1; s <= 4; s++) {
    for (let i = 0; i < 10; i++, n++) {
      qs.push({
        number: n,
        tag: `Section ${s}`,
        stem: '（题干请按《剑桥雅思》原书填写）',
        options: [],
        answer: '',
        explain: '',
        start: null,
        end: null,
        transcript: '',
      });
    }
  }
  return qs;
}

function listAudio() {
  if (!fs.existsSync(SRC_DIR)) return [];
  return fs.readdirSync(SRC_DIR)
    .filter((f) => /\.(mp3|m4a|wav|ogg|flac)$/i.test(f))
    .map((f) => ({ file: f, parsed: parseName(f) }))
    .filter((x) => x.parsed)
    .sort((a, b) => a.parsed.book - b.parsed.book || a.parsed.test - b.parsed.test);
}

function main() {
  const cmd = process.argv[2] || 'list';

  if (!fs.existsSync(SRC_DIR)) {
    console.error('音频目录不存在：' + SRC_DIR);
    console.error('用 --src=<目录> 指定。');
    process.exit(1);
  }

  const audios = listAudio();
  if (!audios.length) {
    console.error('没有识别出任何音频（文件名需要含 "C<书号>-Test <套号>"）。');
    process.exit(1);
  }

  // 按书分组统计
  const byBook = new Map();
  for (const a of audios) {
    if (!byBook.has(a.parsed.book)) byBook.set(a.parsed.book, []);
    byBook.get(a.parsed.book).push(a.parsed.test);
  }

  console.log('');
  console.log(`识别出 ${audios.length} 个音频，覆盖 ${byBook.size} 本书：`);
  console.log('');
  console.log('  书号   已识别的 Test      缺哪些');
  console.log('  ' + '-'.repeat(46));
  for (const book of [...byBook.keys()].sort((a, b) => b - a)) {
    const tests = byBook.get(book).sort();
    const missing = [1, 2, 3, 4].filter((t) => !tests.includes(t));
    console.log(`  C${String(book).padEnd(5)} Test ${tests.join(', ').padEnd(14)} ${missing.length ? '缺 Test ' + missing.join(', ') : '完整'}`);
  }
  console.log('');

  if (cmd === 'list') {
    console.log('导入：node tools/import-ielts-cambridge.js import');
    return;
  }

  if (cmd !== 'import') {
    console.log('用法：node tools/import-ielts-cambridge.js [list|import] [--dry] [--src=<目录>]');
    return;
  }

  if (!DRY) fs.mkdirSync(OUT_DIR, { recursive: true });

  let made = 0;
  let totalBytes = 0;

  for (const a of audios) {
    const { book, test } = a.parsed;
    const base = `C${book}-Test${test}`;
    const title = `剑桥雅思 ${book} · Test ${test} 听力`;
    const src = path.join(SRC_DIR, a.file);
    const destAudio = path.join(OUT_DIR, `${base}${path.extname(a.file)}`);

    let dur = 0;
    try { dur = mediaDuration(src); } catch { /* 忽略 */ }

    if (!DRY) {
      // 复制音频（已存在且体积一致就跳过）
      const needCopy = !fs.existsSync(destAudio) || fs.statSync(destAudio).size !== fs.statSync(src).size;
      if (needCopy) fs.copyFileSync(src, destAudio);

      // 时间轴：没有官方时间戳，先放一个起点标记，避免歌词面板全空
      fs.writeFileSync(path.join(OUT_DIR, `${base}.lrc`),
        `[ti:${title}]\n[by:listening-player import-ielts-cambridge]\n`
        + `[re:无官方时间戳；可用 tools/lrc-from-srt.js 从字幕生成，或先跑 auto-timing]\n`
        + `[length:${String(Math.floor(dur / 60)).padStart(2, '0')}:${String(Math.round(dur % 60)).padStart(2, '0')}.00]\n`
        + `[00:00.00]— 剑桥雅思 ${book} Test ${test} 听力 —\n`, 'utf8');

      // 原文：先写官方考试指令，方便对照；真实原文需另配
      fs.writeFileSync(path.join(OUT_DIR, `${base}.txt`),
        `${title}\n\n`
        + `音频：你自备的《剑桥雅思真题${book}》Test ${test} 听力录音。\n\n`
        + `考试结构与指令（音频开头会念到）：\n\n${DIRECTIONS}\n\n`
        + `${'─'.repeat(60)}\n\n`
        + `听力原文（transcript）需要另行获取：\n`
        + `  · 官方原文在《剑桥雅思》书末的 "Audioscripts" 章节\n`
        + `  · 或用 faster-whisper 自行转写后配合 tools/lrc-from-srt.js 生成时间轴\n`, 'utf8');

      fs.writeFileSync(path.join(OUT_DIR, `${base}.questions.json`), JSON.stringify({
        title,
        exam: 'ielts',
        section: 'Listening Test（Section 1-4，Q1-40）',
        paper: `剑桥雅思 ${book} Test ${test}`,
        source: '用户自备音频（《剑桥雅思》Cambridge University Press）',
        license: '题目与原文版权属剑桥大学出版社，仅供个人学习使用',
        questions: skeletonQuestions(),
      }, null, 2), 'utf8');

      fs.writeFileSync(path.join(OUT_DIR, `${base}.meta.json`), JSON.stringify({
        title,
        exam: 'ielts',
        section: 'Listening Test（Section 1-4，Q1-40）',
        paper: `剑桥雅思 ${book} Test ${test}`,
        year: '',
        source: '用户自备音频（《剑桥雅思》Cambridge University Press）',
        license: '题目与原文版权属剑桥大学出版社，仅供个人学习使用，请勿分发',
        sourceUrl: 'https://www.cambridge.org/',
        duration: dur,
        notes: '音频来自用户自备的剑桥雅思真题合集。题目为结构骨架（Section 1-4 / Q1-40），'
          + '题干与答案需按原书填写；官方无时间戳，歌词暂不滚动。',
        importedAt: new Date().toISOString().slice(0, 10),
        generator: 'tools/import-ielts-cambridge.js',
        axisQuality: 'none',
      }, null, 2), 'utf8');
    }

    totalBytes += fs.statSync(src).size;
    made++;
    console.log(`  ${base.padEnd(14)} ${String(Math.round(dur)).padStart(4)}s  ${(fs.statSync(src).size / 1048576).toFixed(1).padStart(5)} MB  ${title}`);
  }

  console.log('');
  console.log('─'.repeat(70));
  console.log(`导入 ${made} 个课程，共 ${(totalBytes / 1048576).toFixed(0)} MB${DRY ? '（--dry 预览，未写文件）' : ''}`);
  console.log(`输出：${OUT_DIR}`);
  console.log('');
  if (!DRY) {
    console.log('下一步：');
    console.log('  1. 打开 http://127.0.0.1:4180 就能听（题目是骨架，需按书填空）');
    console.log('  2. 若你有原文/字幕：node tools/import.js --audio=<音频> --sub=<字幕> 可生成滚动歌词');
    console.log('  3. 若有题目文本：node tools/parse-qstem.js --stem=<题干> --answer=<答案> --write --audio=<音频>');
    console.log('');
  }
}

if (require.main === module) main();

module.exports = { parseName, skeletonQuestions };

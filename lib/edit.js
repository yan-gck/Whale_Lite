/**
 * lib/edit.js — 处理「手动修订原文与题目」的保存请求
 *
 * 为什么需要：原文来自 Whisper 转写、原题来自 PDF 的 OCR，两者都会出错
 * （实测 "Complete the table below." 被识别成 "Completethetablebelow."，
 * 专有名词也常错）。用户要能自己改。
 *
 * 保存策略（**保留原始文件**）：
 *   修订不覆盖机器生成的文件，而是写到独立文件：
 *     <base>.lrc          → <base>.lrc.override.json   { lines: [...] }
 *     <base>.questions.json → <base>.questions.json.override.json
 *   读取时 lib/library.js 先看 override，有就用它。
 *   这样：
 *     · 重新跑转写/OCR 不会冲掉用户的手工修订
 *     · 想还原成机器版本，删掉 override 文件即可
 *   这是有意为之 —— 直接覆盖会让用户的心血在下次批量处理时丢失。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const AUDIO_ROOT = path.join(ROOT, 'audio');

/** 把课程 id（相对 audio/ 的路径）解析成绝对路径，并做目录穿越防护 */
function resolveLesson(lessonId) {
  const rel = String(lessonId || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel || rel.includes('..')) throw new Error('课程 id 不合法');
  const abs = path.resolve(AUDIO_ROOT, rel);
  if (!abs.startsWith(AUDIO_ROOT)) throw new Error('课程 id 越界');
  if (!fs.existsSync(abs)) throw new Error('找不到课程：' + rel);
  return abs;
}

function baseOf(audioPath) {
  const ext = path.extname(audioPath);
  return audioPath.slice(0, audioPath.length - ext.length);
}

/**
 * 保存原文修订。
 * @param {string} lessonId 课程 id
 * @param {Array<{time:number,text:string}>} lines 修订后的行
 */
function saveTranscript(lessonId, lines) {
  const audioPath = resolveLesson(lessonId);
  const base = baseOf(audioPath);

  if (!Array.isArray(lines) || !lines.length) throw new Error('没有可保存的内容');

  const clean = lines
    .map((l) => ({
      time: Math.max(0, Number(l.time) || 0),
      text: String(l.text == null ? '' : l.text).replace(/\s+$/, ''),
    }))
    .filter((l) => l.text.length || l.time >= 0)
    .sort((a, b) => a.time - b.time);

  const out = path.join(path.dirname(audioPath), path.basename(base) + '.lrc.override.json');
  fs.writeFileSync(out, JSON.stringify({
    savedAt: new Date().toISOString(),
    note: '用户在播放器里手动修订的原文（覆盖机器生成的 .lrc）。删掉本文件即可还原。',
    lines: clean,
  }, null, 2), 'utf8');

  return { ok: true, file: path.basename(out), lines: clean.length };
}

/**
 * 保存题目修订。
 * @param {string} lessonId
 * @param {Array} questions 修订后的题目数组
 */
function saveQuestions(lessonId, questions) {
  const audioPath = resolveLesson(lessonId);
  const base = baseOf(audioPath);

  if (!Array.isArray(questions) || !questions.length) throw new Error('没有可保存的题目');

  const clean = questions.map((q, i) => ({
    number: Number(q.number) || i + 1,
    tag: q.tag || '',
    section: Number(q.section) || Math.min(4, Math.floor(i / 10) + 1),
    stem: String(q.stem || ''),
    options: Array.isArray(q.options) ? q.options.map(String) : [],
    answer: String(q.answer || ''),
    alternatives: Array.isArray(q.alternatives) ? q.alternatives.map(String) : [],
    explain: String(q.explain || ''),
    start: q.start != null ? Number(q.start) : null,
    end: q.end != null ? Number(q.end) : null,
    transcript: String(q.transcript || ''),
    // 修订时保留这些定位/展示字段，否则改完就丢失跳转能力
    group: q.group || '',
    instructions: Array.isArray(q.instructions) ? q.instructions.map(String) : [],
    optionsText: Array.isArray(q.optionsText) ? q.optionsText : [],
    answerText: q.answerText || '',
    answerLine: q.answerLine != null ? Number(q.answerLine) : null,
    answerTime: q.answerTime != null ? Number(q.answerTime) : null,
    linkMethod: q.linkMethod || '',
  }));

  const out = path.join(path.dirname(audioPath), path.basename(base) + '.questions.json.override.json');
  fs.writeFileSync(out, JSON.stringify({
    savedAt: new Date().toISOString(),
    note: '用户在播放器里手动修订的题目（覆盖机器生成的 .questions.json）。删掉本文件即可还原。',
    questions: clean,
  }, null, 2), 'utf8');

  return { ok: true, file: path.basename(out), questions: clean.length };
}

/** 删除修订，还原成机器生成的版本 */
function revert(lessonId, what) {
  const audioPath = resolveLesson(lessonId);
  const base = baseOf(audioPath);
  const dir = path.dirname(audioPath);
  const name = path.basename(base);
  const removed = [];

  const targets = what === 'questions'
    ? [name + '.questions.json.override.json']
    : what === 'transcript'
      ? [name + '.lrc.override.json']
      : [name + '.lrc.override.json', name + '.questions.json.override.json'];

  for (const t of targets) {
    const p = path.join(dir, t);
    if (fs.existsSync(p)) { fs.unlinkSync(p); removed.push(t); }
  }
  return { ok: true, removed };
}

module.exports = { saveTranscript, saveQuestions, revert, resolveLesson };

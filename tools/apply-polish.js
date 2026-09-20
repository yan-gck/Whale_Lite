#!/usr/bin/env node
/**
 * apply-polish.js — 把审校后的原文应用到课程（写成 override，不动原文件）
 *
 * 为什么不直接覆盖 .lrc：
 *   审校结果的正确性需要人工抽查确认。写成 override 后：
 *     · 播放器读 override（lib/library.js 已支持）
 *     · 想反悔就删掉 override，机器原文还在
 *     · 重跑转写/OCR 不会冲掉审校结果
 *
 * ⚠️ 合并续行会【改变行数】，题目的 answerLine 是按旧行号算的，会错位。
 *    所以应用之后必须重跑：node tools/link-answers.js --all
 *
 * 用法：
 *   node tools/apply-polish.js            应用全部
 *   node tools/apply-polish.js --dry      预览
 *   node tools/apply-polish.js --revert   撤销（删掉 override）
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const LESSON_DIR = path.join(ROOT, 'audio', 'IELTS-剑桥真题');

const DRY = process.argv.includes('--dry');
const REVERT = process.argv.includes('--revert');

const LRC_TIME = /^\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/;

function parseTime(stamp) {
  const m = /^\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/.exec(stamp);
  if (!m) return 0;
  return Number(m[1]) * 60 + parseFloat(String(m[2]).replace(':', '.'));
}

/** 从审校后的 LRC 文本里抽出 {time, text} */
function toLines(text) {
  const out = [];
  for (const raw of String(text).replace(/\r\n/g, '\n').split('\n')) {
    const t = raw.trim();
    if (!t) continue;
    const m = LRC_TIME.exec(t);
    if (!m) continue;
    const idx = t.indexOf(']');
    out.push({ time: parseTime(t.slice(0, idx + 1)), text: t.slice(idx + 1) });
  }
  return out;
}

function main() {
  const files = fs.readdirSync(LESSON_DIR).filter((f) => f.endsWith('.lrc.polished.json'));
  if (!files.length) {
    console.error('没有审校文件。请先运行：node tools/polish-lrc.js --all');
    process.exit(1);
  }

  console.log('');
  console.log(REVERT ? '撤销审校（删除 override）' : `应用审校 ${files.length} 个课程${DRY ? '（--dry）' : ''}`);
  console.log('');

  let applied = 0, reverted = 0, linesBefore = 0, linesAfter = 0;

  for (const f of files.sort()) {
    const base = f.replace(/\.lrc\.polished\.json$/, '');
    const src = path.join(LESSON_DIR, f);
    const outPath = path.join(LESSON_DIR, `${base}.lrc.override.json`);

    if (REVERT) {
      if (fs.existsSync(outPath)) {
        if (!DRY) fs.unlinkSync(outPath);
        reverted++;
      }
      continue;
    }

    const doc = JSON.parse(fs.readFileSync(src, 'utf8'));
    const lines = toLines(doc.text);
    if (!lines.length) { console.log(`  ✗ ${base} 解析不出行`); continue; }

    const origPath = path.join(LESSON_DIR, `${base}.lrc`);
    const origCount = fs.existsSync(origPath)
      ? fs.readFileSync(origPath, 'utf8').split('\n').filter((l) => LRC_TIME.test(l.trim())).length
      : 0;

    linesBefore += origCount;
    linesAfter += lines.length;

    if (!DRY) {
      fs.writeFileSync(outPath, JSON.stringify({
        savedAt: new Date().toISOString(),
        note: '原文审校结果（合并 Whisper 切碎的续行 + 修正专有名词/英式拼写/标点）。'
          + '删掉本文件即可还原成机器转写版本。',
        source: 'tools/polish-lrc.js',
        lines,
      }, null, 2), 'utf8');
    }
    applied++;
    console.log(`  ✓ ${base.padEnd(14)} ${String(origCount).padStart(3)} → ${String(lines.length).padStart(3)} 行`);
  }

  console.log('');
  console.log('─'.repeat(60));
  if (REVERT) console.log(`撤销 ${reverted} 个`);
  else {
    console.log(`应用 ${applied} 个课程：${linesBefore} → ${linesAfter} 行（合并掉 ${linesBefore - linesAfter} 行）`);
    console.log('');
    console.log('⚠️ 行数变了，题目定位会错位。请立刻重跑关联：');
    console.log('   node tools/link-answers.js --all');
  }
  console.log('');
}

if (require.main === module) main();

module.exports = { toLines };

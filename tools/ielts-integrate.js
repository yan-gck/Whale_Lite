#!/usr/bin/env node
/**
 * ielts-integrate.js — 把转写结果整合进播放器课程，并统一元信息
 *
 * 做四件事：
 *   1. 为 audio/IELTS-剑桥真题 里的每个 Test 生成/更新 .meta.json、.lrc、.txt、
 *      .questions.json（题目为结构骨架，题干需按书填写）
 *   2. 若有 transcripts/<Test>.tsv，转成 LRC 并【明确标注为 Whisper 转写】
 *   3. 顺带修正 whisper 偶发的超长句（>18 秒的按字符数封顶显示时长）
 *   4. 若有 .translation.lrc（中文译文），保留并供界面做英中对照
 *
 * 标识要求（用户明确提出）：
 *   凡是机器转写的课程，meta 里写 transcriptSource，界面据此显示
 *   「🎙 Whisper 转写」徽标，原文抽屉顶部也加免责声明。
 *
 * 用法：
 *   node tools/ielts-integrate.js             生成/更新全部课程
 *   node tools/ielts-integrate.js --no-text   不写 .txt（只更新 lrc/meta）
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const LESSON_DIR = path.join(ROOT, 'audio', 'IELTS-剑桥真题');
const TSV_DIR = path.join(ROOT, 'transcripts');

const WRITE_TEXT = !process.argv.includes('--no-text');
const MAX_LINE_SEC = 18.0;     // 单行显示时长上限

const { mediaDuration } = require('./media-duration.js');

function lrcTime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
}

/** 解析 TSV */
function parseTsv(text) {
  const rows = [];
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const p = raw.split('\t');
    if (p.length < 3) continue;
    const s = Number(p[0]), e = Number(p[1]);
    const t = p.slice(2).join('\t').trim();
    if (!Number.isFinite(s) || !t) continue;
    rows.push({ s, e: Number.isFinite(e) ? e : s + 2, t });
  }
  return rows;
}

/**
 * 限制单行显示时长。
 * whisper 偶尔把一句话对齐到一个很长的区间（实测有 32 秒的），
 * 在滚动歌词里会一直卡着不动。按字符数（约 15 字符/秒）估算合理时长。
 */
function capDuration(rows, maxSec = MAX_LINE_SEC) {
  let fixed = 0;
  for (const r of rows) {
    const span = r.e - r.s;
    if (span <= maxSec) continue;
    const est = Math.max(1.2, r.t.length / 15.0);
    if (est < span) { r.e = r.s + Math.min(span, est); fixed++; }
  }
  return fixed;
}

/** 生成题目结构骨架（剑桥雅思听力固定 4 个 Section、40 题） */
function skeletonQuestions() {
  const qs = [];
  let n = 1;
  for (let s = 1; s <= 4; s++) {
    for (let i = 0; i < 10; i++, n++) {
      qs.push({
        number: n,
        tag: `Section ${s}`,
        stem: '',
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

const DIRECTIONS = [
  'SECTION 1  （Q1-10）日常场景对话',
  'SECTION 2  （Q11-20）独白，常配地图/多选',
  'SECTION 3  （Q21-30）学术讨论，常配匹配题',
  'SECTION 4  （Q31-40）学术讲座，笔记填空',
  '',
  '录音播放顺序：先念 Section 1 指令 → Section 1 内容 → … → Section 4。',
  '每段只播一次。',
].join('\n');

function main() {
  if (!fs.existsSync(LESSON_DIR)) {
    console.error('找不到课程目录：' + LESSON_DIR);
    process.exit(1);
  }

  const files = fs.readdirSync(LESSON_DIR).filter((f) => /\.(mp3|m4a)$/i.test(f));
  console.log('');
  console.log(`课程目录：${LESSON_DIR}`);
  console.log(`音频 ${files.length} 个，转写目录：${TSV_DIR}`);
  console.log('');

  let withWhisper = 0, withLine = 0, noAxis = 0, capped = 0;

  for (const file of files.sort()) {
    const base = file.slice(0, file.length - path.extname(file).length);
    const audioPath = path.join(LESSON_DIR, file);
    const m = /^C(\d+)-Test(\d)$/.exec(base);
    const book = m ? Number(m[1]) : null;
    const test = m ? Number(m[2]) : null;
    const title = book ? `剑桥雅思 ${book} · Test ${test} 听力` : base;

    const dur = (() => { try { return mediaDuration(audioPath); } catch { return 0; } })();

    // ---- 时间轴来源
    const tsvPath = path.join(TSV_DIR, `${base}.tsv`);
    let rows = [];
    let transcriptSource = null;

    if (fs.existsSync(tsvPath)) {
      rows = parseTsv(fs.readFileSync(tsvPath, 'utf8'));
      capped += capDuration(rows);
      if (rows.length) {
        transcriptSource = {
          kind: 'whisper',
          model: 'faster-whisper medium.en',
          generatedAt: new Date(fs.statSync(tsvPath).mtime).toISOString().slice(0, 10),
          note: 'OpenAI Whisper 自动语音识别，非官方原文',
        };
      }
    }

    // ---- 写 LRC
    if (rows.length) {
      const lrc = [
        `[ti:${title}]`,
        '[by:listening-player ielts-integrate]',
        '[re:⚠ 歌词为 OpenAI Whisper 机器转写，可能有错字，非官方原文]',
        `[length:${lrcTime(dur)}]`,
        ...rows.map((r) => `[${lrcTime(r.s)}]${r.t}`),
      ].join('\n') + '\n';
      fs.writeFileSync(path.join(LESSON_DIR, `${base}.lrc`), lrc, 'utf8');
      withWhisper++;
    } else {
      // 没有转写：给一个起点标记，并说明原因
      const existing = path.join(LESSON_DIR, `${base}.lrc`);
      const hasReal = fs.existsSync(existing) && /\[\d{1,3}:\d{1,2}/.test(fs.readFileSync(existing, 'utf8'));
      if (!hasReal) {
        fs.writeFileSync(existing,
          `[ti:${title}]\n[by:listening-player ielts-integrate]\n`
          + `[re:暂无时间轴；转写后可滚动：python tools/transcribe.py --audio "<音频>" --out "transcripts/${base}.tsv"]\n`
          + `[length:${lrcTime(dur)}]\n[00:00.00]— ${title} —\n`, 'utf8');
        noAxis++;
      } else {
        withLine++;
      }
    }

    // ---- 写原文
    if (WRITE_TEXT) {
      const out = [];
      if (transcriptSource) {
        out.push('⚠️ 以下文本由 OpenAI Whisper 自动语音识别生成，非《剑桥雅思》官方原文。');
        out.push(`   模型：${transcriptSource.model}　生成：${transcriptSource.generatedAt}`);
        out.push('   机器转写可能存在错字、漏词或专有名词错误，请以音频与官方材料为准。');
        out.push('');
        out.push('─'.repeat(56));
        out.push('');
        out.push(DIRECTIONS);
        out.push('');
        out.push('─'.repeat(56));
        out.push('');
        out.push(...rows.map((r) => `[${lrcTime(r.s)}] ${r.t}`));
      } else {
        out.push(`${title}`);
        out.push('');
        out.push('音频已导入，但还没有原文与时间轴。');
        out.push('');
        out.push('生成方式（本机已装好 faster-whisper + GPU 加速）：');
        out.push(`  python tools/transcribe.py --audio "audio/IELTS-剑桥真题/${file}" --out "transcripts/${base}.tsv"`);
        out.push('  node tools/ielts-integrate.js');
        out.push('');
        out.push(DIRECTIONS);
      }
      fs.writeFileSync(path.join(LESSON_DIR, `${base}.txt`), out.join('\n') + '\n', 'utf8');
    }

    // ---- 写题目骨架（只在不存在时创建，避免覆盖手工录入的内容）
    const qPath = path.join(LESSON_DIR, `${base}.questions.json`);
    if (!fs.existsSync(qPath)) {
      fs.writeFileSync(qPath, JSON.stringify({
        title,
        exam: 'ielts',
        section: 'Listening Test（Section 1-4，Q1-40）',
        paper: book ? `剑桥雅思 ${book} Test ${test}` : base,
        source: '用户自备音频（《剑桥雅思》Cambridge University Press）',
        license: '题目与原文版权属剑桥大学出版社，仅供个人学习使用，请勿分发',
        questions: skeletonQuestions(),
      }, null, 2), 'utf8');
    }

    // ---- 元信息
    const meta = {
      title,
      exam: 'ielts',
      section: 'Listening Test（Section 1-4，Q1-40）',
      paper: book ? `剑桥雅思 ${book} Test ${test}` : base,
      year: '',
      source: '用户自备音频（《剑桥雅思》Cambridge University Press）'
        + (transcriptSource ? ' ／ 原文为 Whisper 机器转写' : ''),
      license: '音频版权属剑桥大学出版社，仅供个人学习使用，请勿分发',
      sourceUrl: 'https://www.cambridge.org/',
      duration: dur,
      notes: (transcriptSource
        ? `歌词与原文由 OpenAI Whisper（faster-whisper ${transcriptSource.model}）在本机自动转写，${rows.length} 句，带句级时间戳。机器转写可能有错字。`
        : '暂无原文与时间轴。')
        + ' 题目为结构骨架（Section 1-4 / Q1-40），题干与答案需按原书填写。',
      transcriptSource,
      axisQuality: transcriptSource ? 'sentence' : 'none',
      hasTranslation: fs.existsSync(path.join(LESSON_DIR, `${base}.translation.lrc`)),
      importedAt: new Date().toISOString().slice(0, 10),
      generator: 'tools/ielts-integrate.js',
    };
    fs.writeFileSync(path.join(LESSON_DIR, `${base}.meta.json`), JSON.stringify(meta, null, 2), 'utf8');
  }

  console.log('─'.repeat(60));
  console.log(`已整合 ${files.length} 个课程：`);
  console.log(`  带 Whisper 句级时间轴：${withWhisper}`);
  console.log(`  已有行级时间轴：      ${withLine}`);
  console.log(`  暂无时间轴（占位）：  ${noAxis}`);
  console.log(`  修正的超长句：        ${capped}`);
  console.log('');
  console.log('启动播放器查看：node server.js   →  http://127.0.0.1:4180');
  console.log('');
}

if (require.main === module) main();

module.exports = { parseTsv, capDuration, skeletonQuestions };

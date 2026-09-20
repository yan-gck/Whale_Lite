#!/usr/bin/env node
/**
 * from-cet-timings.js — 把 cet-listening 的 timings.json 转成播放器资料包
 *
 * 为什么需要这个适配器：
 *   3056810551/cet-listening（MIT）用 faster-whisper 给四六级真题做了【句级时间戳】，
 *   形如 {"text":"...","start":40.54,"end":48.46,"speaker":"M:","translation":"中文"}，
 *   但它的 schema 与播放器不同，且仓库本身不含音频（audio/ 被 .gitignore）。
 *   于是必须解决一个关键问题：**时间戳只对同一份录音有效**。
 *   timings.json 里有 source.audio.size 记录了它对齐时用的音频字节数，
 *   本工具用这个字节数校验你给的音频，不一致就明确报错 —— 否则歌词会整体错位。
 *
 * 用法：
 *   node tools/from-cet-timings.js <timings.json> --audio=<对应的mp3> [选项]
 *
 * 选项：
 *   --audio=<文件>      必需，要配的音频
 *   --out=<目录>        输出根目录，默认 audio/
 *   --title=<标题>      默认由文件名推导
 *   --skip-size-check   跳过音频字节数校验（明知不是同一份录音时使用，风险自负）
 *   --no-translation    不生成译文文件
 *   --force             覆盖已存在文件
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// ------------------------------------------------------------ 工具

function parseArgs(argv) {
  const o = { _: [] };
  for (const a of argv) {
    const m = /^--([a-zA-Z][a-zA-Z0-9-]*)(?:=(.*))?$/.exec(a);
    if (m) o[m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = m[2] === undefined ? true : m[2];
    else o._.push(a);
  }
  return o;
}

function lrcTime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
}

/** 从 timings.json 的文件名推考试类型与套数，例如 "2017-12-1" → cet6 */
function guessExam(fileName) {
  const m = /(\d{4})-(\d{1,2})-(\d+)/.exec(fileName);
  if (!m) return { exam: 'other', year: '', paper: '' };
  const [, y, mo, set] = m;
  return {
    exam: 'cet6',   // 该仓库的 transcripts/cet4/ 为空，实际只有六级
    year: y,
    paper: `${y}年${Number(mo)}月 第${set}套`,
  };
}

const EXAM_LABEL = { cet4: '四级', cet6: '六级', ielts: '雅思', toefl: '托福', other: '其他' };

// ------------------------------------------------------------ 主流程

function main() {
  const o = parseArgs(process.argv.slice(2));

  if (!o._.length || o.help) {
    console.log(`用法：node tools/from-cet-timings.js <timings.json> --audio=<对应的mp3> [选项]

选项：
  --audio=<文件>      必需，要配的音频文件
  --out=<目录>        输出根目录，默认 audio/
  --title=<标题>      默认由文件名推导
  --skip-size-check   跳过音频字节数校验（时间戳可能整体错位，风险自负）
  --no-translation    不生成译文文件
  --force             覆盖已存在文件

背景：cet-listening 仓库只提供 timings.json，不含音频（audio/ 被 .gitignore）。
      timings.json 里的 source.audio.size 是它对齐时所用音频的字节数，
      本工具据此校验你给的音频是否为同一份录音 —— 这一步不能省，
      换一份录音（哪怕同名同集）时间戳就会整体漂移。`);
    process.exit(o._.length ? 0 : 1);
  }

  const timingsPath = path.resolve(String(o._[0]));
  if (!fs.existsSync(timingsPath)) throw new Error(`找不到 timings 文件：${timingsPath}`);

  const doc = JSON.parse(fs.readFileSync(timingsPath, 'utf8').replace(/^\uFEFF/, ''));
  if (!Array.isArray(doc.lines) || !doc.lines.length) {
    throw new Error('timings.json 里没有 lines 数组，格式可能已变');
  }

  // ---- 音频校验
  if (!o.audio) {
    throw new Error('必须用 --audio=<文件> 指定要配的音频。\n'
      + '（该仓库不含音频，音频需另行获取；timings 只对同一份录音有效）');
  }
  const audio = path.resolve(String(o.audio));
  if (!fs.existsSync(audio)) throw new Error(`找不到音频：${audio}`);

  const actualBytes = fs.statSync(audio).size;
  const expectedBytes = doc.source && doc.source.audio && Number(doc.source.audio.size);

  if (expectedBytes && !o.skipSizeCheck) {
    if (actualBytes !== expectedBytes) {
      const diff = actualBytes - expectedBytes;
      throw new Error(
        `音频与时间戳不匹配，已中止。\n`
        + `  timings 期望字节数：${expectedBytes.toLocaleString()}\n`
        + `  你提供的音频字节数：${actualBytes.toLocaleString()}（差 ${diff > 0 ? '+' : ''}${diff.toLocaleString()}）\n\n`
        + `  这说明两份录音不是同一个文件，直接套用会导致歌词整体错位。\n`
        + `  请换用字节数一致的那份音频；若你确认就是同一录音（例如只是重新封装容器），\n`
        + `  可加 --skip-size-check 强制继续。`
      );
    }
    console.log(`✓ 音频字节数校验通过（${actualBytes.toLocaleString()} 字节，与 timings 记录一致）`);
  } else if (!expectedBytes) {
    console.log('⚠ timings.json 未记录音频字节数，无法校验；若歌词错位请更换音频。');
  } else {
    console.log('⚠ 已跳过字节数校验，时间戳可能不准确。');
  }

  // ---- 基本信息
  const stem = path.basename(timingsPath, '.timings.json');
  const guess = guessExam(stem);
  const exam = String(o.exam || guess.exam).toLowerCase();
  const paper = o.paper ? String(o.paper) : guess.paper;
  const title = o.title
    ? String(o.title)
    : `${EXAM_LABEL[exam] || ''}听力 · ${paper || stem}`;

  const folder = o.folder ? String(o.folder) : (exam === 'cet6' ? 'CET6' : exam === 'cet4' ? 'CET4' : '其他');
  const outRoot = o.out ? path.resolve(String(o.out)) : path.join(ROOT, 'audio');
  const outDir = path.join(outRoot, folder);
  fs.mkdirSync(outDir, { recursive: true });

  const baseName = path.basename(audio, path.extname(audio));
  const destAudio = path.join(outDir, path.basename(audio));
  if (fs.existsSync(destAudio) && !o.force) {
    throw new Error(`目标已存在：${destAudio}\n（加 --force 覆盖）`);
  }

  // ---- 组装 LRC
  // 说话人前缀保留在正文里（"M: xxx"），这样一眼能看出是谁在说
  const lrcLines = [
    `[ti:${title}]`,
    `[by:cet-listening timings.json → listening-player]`,
    `[length:${lrcTime(doc.duration)}]`,
  ];

  let lastSection = null;
  for (const line of doc.lines) {
    if (line.start == null) continue;

    // 段落变化时插入一行章节标题。
    // 时间戳刻意前移 0.01 秒：若与首句完全相同，播放器按「最后一个 time <= t」
    // 命中时会选中标题行而不是正文，高亮就落在标题上了。
    if (line.sectionTitle && line.sectionTitle !== lastSection) {
      lrcLines.push(`[${lrcTime(Math.max(0, line.start - 0.01))}]-- ${line.sectionTitle} --`);
      lastSection = line.sectionTitle;
    }

    const speaker = line.speaker && line.speaker !== 'narrator' ? `${line.speaker} ` : '';
    const text = String(line.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    lrcLines.push(`[${lrcTime(line.start)}]${speaker}${text}`);
  }

  // ---- 译文（与原文逐行对齐，供对照阅读）
  const trLines = [`[ti:${title} · 译文]`];
  for (const line of doc.lines) {
    if (line.start == null) continue;
    const t = String(line.translation || '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    const speaker = line.speaker && line.speaker !== 'narrator' ? `${line.speaker} ` : '';
    trLines.push(`[${lrcTime(line.start)}]${speaker}${t}`);
  }

  // ---- 原文 txt
  const txtOut = [];
  lastSection = null;
  for (const line of doc.lines) {
    if (line.sectionTitle && line.sectionTitle !== lastSection) {
      txtOut.push(`\n=== ${line.sectionTitle} ===\n`);
      lastSection = line.sectionTitle;
    }
    const speaker = line.speaker && line.speaker !== 'narrator' ? `${line.speaker} ` : '';
    txtOut.push(`${speaker}${String(line.text || '').trim()}`);
    if (line.translation) txtOut.push(`    ${String(line.translation).trim()}`);
  }

  // ---- 题目模板：把 timings 里的 question 行提出来当题干参考
  const questionLines = doc.lines.filter((l) => l.type === 'question');
  const questions = questionLines.map((l, i) => ({
    number: i + 1,
    tag: '待补选项',
    stem: String(l.text || '').trim(),
    options: ['A. ', 'B. ', 'C. ', 'D. '],
    answer: '',
    explain: '题目来源：cet-listening timings.json。选项与答案请按真题补全。',
    start: Number(l.start) || 0,
    end: Number(l.end) || 0,
    transcript: '',
  }));

  // ---- 写文件
  const created = [];

  if (path.resolve(destAudio) !== audio) {
    fs.copyFileSync(audio, destAudio);
  }
  created.push(`${path.basename(destAudio)}（${(actualBytes / 1048576).toFixed(1)} MB）`);

  fs.writeFileSync(path.join(outDir, `${baseName}.lrc`), lrcLines.join('\n') + '\n', 'utf8');
  created.push(`${baseName}.lrc（${lrcLines.length - 3} 行原文，句级时间戳）`);

  if (!o.noTranslation && trLines.length > 1) {
    fs.writeFileSync(path.join(outDir, `${baseName}.translation.lrc`), trLines.join('\n') + '\n', 'utf8');
    created.push(`${baseName}.translation.lrc（${trLines.length - 1} 行中文译文）`);
  }

  fs.writeFileSync(path.join(outDir, `${baseName}.txt`), txtOut.join('\n') + '\n', 'utf8');
  created.push(`${baseName}.txt（原文＋译文对照）`);

  const qDoc = {
    title,
    exam,
    section: (doc.sections || []).map((s) => s.title).join(' / '),
    source: '3056810551/cet-listening（faster-whisper 时间戳）',
    license: 'MIT（仓库代码与 timings 数据）',
    sourceUrl: 'https://github.com/3056810551/cet-listening',
    questions,
  };
  fs.writeFileSync(path.join(outDir, `${baseName}.questions.json`), JSON.stringify(qDoc, null, 2), 'utf8');
  created.push(`${baseName}.questions.json（${questions.length} 题，选项答案待补）`);

  const meta = {
    title,
    exam,
    section: (doc.sections || []).map((s) => s.title).join(' / '),
    paper,
    year: guess.year,
    source: '3056810551/cet-listening timings.json',
    license: 'MIT（timings 数据）；音频版权状况取决于其原始来源',
    sourceUrl: 'https://github.com/3056810551/cet-listening',
    duration: Number(doc.duration) || 0,
    notes: `由 tools/from-cet-timings.js 生成。时间戳由 ${doc.mode || '?'} / ${doc.model || '?'} 生成，`
      + `句级精度。原文 ${doc.lines.length} 行、${doc.lines.reduce((n, l) => n + (Number(l.words) || 0), 0)} 词。`
      + (expectedBytes ? ` 音频字节数已校验（${expectedBytes}）。` : ' 音频字节数未记录，未经校验。'),
    importedAt: new Date().toISOString().slice(0, 10),
    generator: 'tools/from-cet-timings.js',
  };
  fs.writeFileSync(path.join(outDir, `${baseName}.meta.json`), JSON.stringify(meta, null, 2), 'utf8');
  created.push(`${baseName}.meta.json`);

  // ---- 汇总
  console.log('');
  console.log(`✅ 已生成到 ${outDir}`);
  for (const c of created) console.log(`   · ${c}`);
  console.log('');
  console.log(`   段落划分：${(doc.sections || []).map((s) => s.title).join(' / ')}`);
  console.log(`   音频时长记录：${lrcTime(doc.duration)}`);
  if (questions.length) {
    console.log(`   发现 ${questions.length} 个 question 片段，已作为题目骨架；选项与答案需按真题补全。`);
  }
  console.log('');
  console.log('   启动播放器：node server.js   然后打开 http://127.0.0.1:4180');
  console.log('');
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('\n[error] ' + err.message + '\n');
    process.exit(1);
  }
}

module.exports = { lrcTime, guessExam };

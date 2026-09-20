#!/usr/bin/env node
/**
 * import.js — 把散装听力素材整理成播放器能识别的资料包
 *
 * 输入什么：
 *   --audio=<文件>       音频（必需）
 *   --lrc=<文件>         已有 LRC 时间轴
 *   --sub=<文件>         字幕，支持 .srt / .vtt / TED 字幕 .json / .tsv，会自动转成 LRC
 *   --text=<文件>        完整原文（.txt / .md），会成为「原文」抽屉的内容
 *   --questions=<文件>   题目 JSON
 *   --out=<目录>         输出目录（默认 audio/）
 *   --exam=cet4|cet6|ielts|toefl|other
 *   --title=<标题>  --section=  --source=  --license=  --source-url=  --year=  --paper=
 *
 * 做什么：
 *   1. 复制音频到 <out>/<子目录>/，四种附属文件统一改成同名（不同扩展名）
 *   2. 字幕转 LRC（复用 lrc-from-srt.js）
 *   3. 没有 --questions 时生成一份模板 questions.json（选择题与填空题各一例）
 *   4. 没有 --text 时用 LRC 文本拼一份 .txt
 *   5. 写入 .meta.json，其中 duration 若能从 WAV 头读出就自动填
 *
 * 用法示例：
 *   node tools/import.js --audio="D:\听力\2024年6月四级.mp3" ^
 *        --sub="D:\听力\2024年6月四级.srt" --exam=cet4 --year=2024 --paper="2024年6月第1套"
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { parseSrtLike, parseTedJson, parseTsv, mergeCues, toLrc } = require('./lrc-from-srt');

// ------------------------------------------------------------ 参数

function parseArgs(argv) {
  const opts = { _: [] };
  for (const a of argv) {
    const m = /^--([a-zA-Z][a-zA-Z0-9-]*)(?:=(.*))?$/.exec(a);
    if (m) opts[m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = m[2] === undefined ? true : m[2];
    else opts._.push(a);
  }
  return opts;
}

function usage() {
  console.log(`用法：node tools/import.js --audio=<音频文件> [选项]

必需：
  --audio=<文件>        音频文件（mp3 / wav / m4a / ogg / flac …）

时间轴（二选一，都没有则只能播放不能滚动）：
  --lrc=<文件>          已有 LRC
  --sub=<文件>          字幕，自动转换：.srt .vtt TED字幕.json .tsv

可选：
  --text=<文件>         完整原文，供「原文」抽屉显示
  --questions=<文件>    题目 JSON（不给则生成模板）
  --out=<目录>          输出根目录，默认 audio/
  --folder=<子目录>     输出到 audio/<子目录>/，默认按考试类型自动命名
  --exam=cet4|cet6|ielts|toefl|other     默认 other
  --title=<标题>        默认取音频文件名
  --section=<章节>  --source=<来源>  --license=<许可>  --source-url=<链接>
  --year=<年份>  --paper=<试卷名>  --notes=<备注>
  --sub-offset=<秒>     字幕整体平移，用于音频与字幕不同源时对齐
  --force               覆盖已存在的文件`);
}

// ------------------------------------------------------------ 工具

/**
 * 读音频时长。
 *
 * 早先只实现了 WAV 解析，导致 mp3/m4a 一律报"时长未知"。
 * 现在统一走 tools/media-duration.js（支持 wav/mp3/flac/m4a，只读头部不解码）。
 */
function readDuration(file) {
  try {
    const { mediaDuration } = require('./media-duration.js');
    return mediaDuration(file);
  } catch {
    return 0;   // 拿不到就算了，播放器首次播放时会自动回写 .duration
  }
}

function isAudioExt(name) {
  return ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.webm', '.mp4']
    .includes(path.extname(name).toLowerCase());
}

/** 从音频文件名猜一个干净的题目标题 */
function guessTitle(file) {
  return path.basename(file, path.extname(file))
    .replace(/[_]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** LRC → 纯文本（供 .txt 使用） */
function lrcToText(lrc) {
  const out = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^\[(ti|ar|al|by|offset|re|ve|length):/i.test(line)) continue;
    const body = line
      .replace(/\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/g, '')
      .replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '')
      .trim();
    if (body) out.push(body);
  }
  return out.join('\n\n') + '\n';
}

function questionsTemplate(title) {
  return {
    title,
    exam: '',
    section: '',
    source: '',
    license: '',
    questions: [
      {
        number: 1,
        tag: '示例·选择题',
        stem: '在这里写题干。填空处可写成连续下划线，播放器会自动高亮：The speaker mentions ______ in the first part.',
        options: ['选项 A', '选项 B', '选项 C', '选项 D'],
        answer: 'B',
        explain: '写解析。原文依据：……（可留空）',
        start: 0,
        end: 0,
        transcript: '这一题对应的听力原句，写在这里。播放器会用它做「回放片段」。',
      },
      {
        number: 2,
        tag: '示例·填空题',
        stem: '填空题把答案放进 options 的第一项即可（雅思听力常用）：The tour costs £______ per person.',
        options: ['25', '20', '30', '15'],
        answer: 'A',
        explain: '原文：it costs twenty five pounds per person.',
        start: 0,
        end: 0,
        transcript: 'it costs twenty five pounds per person.',
      },
    ],
  };
}

// ------------------------------------------------------------ 主流程

function main() {
  const o = parseArgs(process.argv.slice(2));

  if (o.help || !o.audio) {
    usage();
    process.exit(o.audio ? 0 : 1);
  }

  const audio = path.resolve(String(o.audio));
  if (!fs.existsSync(audio)) throw new Error(`音频文件不存在：${audio}`);
  if (!isAudioExt(audio)) {
    console.warn(`[warn] ${path.extname(audio)} 可能不是浏览器支持的音频格式，仍继续处理。`);
  }

  const exam = String(o.exam || 'other').toLowerCase();
  const title = String(o.title || guessTitle(audio));

  // 输出目录
  const defaultFolder = {
    cet4: 'CET4', cet6: 'CET6', ielts: 'IELTS', toefl: 'TOEFL', other: '其他',
  }[exam] || '其他';

  const outRoot = o.out ? path.resolve(String(o.out)) : path.join(ROOT, 'audio');
  const folder = String(o.folder || defaultFolder);
  const outDir = path.join(outRoot, folder);
  fs.mkdirSync(outDir, { recursive: true });

  // 目标文件名：与音频同名，只换扩展名
  const baseName = path.basename(audio, path.extname(audio));
  const destAudio = path.join(outDir, path.basename(audio));

  if (fs.existsSync(destAudio) && !o.force) {
    throw new Error(`目标已存在：${destAudio}\n（加 --force 覆盖）`);
  }

  const created = [];

  // 1) 音频
  if (path.resolve(destAudio) !== audio) {
    fs.copyFileSync(audio, destAudio);
    created.push(path.basename(destAudio));
  } else {
    created.push(`${path.basename(destAudio)}（已在目标位置）`);
  }

  // 2) 时间轴
  let lrcText = null;
  if (o.lrc) {
    const src = path.resolve(String(o.lrc));
    if (!fs.existsSync(src)) throw new Error(`LRC 不存在：${src}`);
    lrcText = fs.readFileSync(src, 'utf8').replace(/^\uFEFF/, '');
    fs.writeFileSync(path.join(outDir, `${baseName}.lrc`), lrcText, 'utf8');
    created.push(`${baseName}.lrc（直接复制）`);
  } else if (o.sub) {
    const src = path.resolve(String(o.sub));
    if (!fs.existsSync(src)) throw new Error(`字幕不存在：${src}`);
    const content = fs.readFileSync(src, 'utf8').replace(/^\uFEFF/, '');
    const ext = path.extname(src).toLowerCase();

    let cues;
    if (ext === '.json') cues = parseTedJson(content);
    else if (ext === '.srt' || ext === '.vtt') cues = parseSrtLike(content);
    else cues = parseTsv(content);

    if (!cues.length) throw new Error('字幕里没解析出任何条目，请检查格式');

    const offset = Number(o.subOffset || 0) || 0;
    const merged = mergeCues(cues, 0.6, 100);
    lrcText = toLrc(merged, { offset, title, merge: 0.6, maxlen: 100 });
    fs.writeFileSync(path.join(outDir, `${baseName}.lrc`), lrcText, 'utf8');
    created.push(`${baseName}.lrc（由 ${path.basename(src)} 转换，${merged.length} 行${offset ? `，偏移 ${offset}s` : ''}）`);
  }

  // 3) 原文
  const textPath = path.join(outDir, `${baseName}.txt`);
  if (o.text) {
    const src = path.resolve(String(o.text));
    if (!fs.existsSync(src)) throw new Error(`原文不存在：${src}`);
    fs.writeFileSync(textPath, fs.readFileSync(src, 'utf8'), 'utf8');
    created.push(`${baseName}.txt（来自 ${path.basename(src)}）`);
  } else if (lrcText) {
    fs.writeFileSync(textPath, lrcToText(lrcText), 'utf8');
    created.push(`${baseName}.txt（由 LRC 生成）`);
  }

  // 4) 题目
  const qPath = path.join(outDir, `${baseName}.questions.json`);
  if (o.questions) {
    const src = path.resolve(String(o.questions));
    if (!fs.existsSync(src)) throw new Error(`题目文件不存在：${src}`);
    const doc = JSON.parse(fs.readFileSync(src, 'utf8').replace(/^\uFEFF/, ''));
    fs.writeFileSync(qPath, JSON.stringify(doc, null, 2), 'utf8');
    created.push(`${baseName}.questions.json（来自 ${path.basename(src)}，${(doc.questions || []).length} 题）`);
  } else if (!fs.existsSync(qPath) || o.force) {
    const tpl = questionsTemplate(title);
    fs.writeFileSync(qPath, JSON.stringify(tpl, null, 2), 'utf8');
    created.push(`${baseName}.questions.json（模板，2 道示例题）`);
  }

  // 5) 元信息
  const duration = readDuration(destAudio);
  const meta = {
    title,
    exam,
    section: o.section ? String(o.section) : '',
    paper: o.paper ? String(o.paper) : '',
    year: o.year ? String(o.year) : '',
    source: o.source ? String(o.source) : '',
    license: o.license ? String(o.license) : '',
    sourceUrl: o.sourceUrl ? String(o.sourceUrl) : '',
    duration: duration ? Number(duration.toFixed(2)) : 0,
    notes: o.notes ? String(o.notes) : '',
    importedAt: new Date().toISOString().slice(0, 10),
    generator: 'tools/import.js',
  };
  fs.writeFileSync(path.join(outDir, `${baseName}.meta.json`), JSON.stringify(meta, null, 2), 'utf8');
  created.push(`${baseName}.meta.json`);

  // 汇总
  console.log('');
  console.log(`✅ 已导入到 ${outDir}`);
  for (const c of created) console.log(`   · ${c}`);
  console.log('');
  if (!duration) {
    console.log('   时长未知（非 WAV 或非 PCM）。播放器首次播放时会自动探测并回写 .duration 缓存。');
  } else {
    console.log(`   音频时长：${duration.toFixed(1)} 秒（已写入 meta）`);
  }
  if (!lrcText) {
    console.log('   ⚠ 没有时间轴：能播放，但歌词不会滚动。可补一个 .lrc 或用 --sub 从字幕转换。');
  }
  console.log('');
  console.log('   启动播放器：node server.js   然后打开 http://127.0.0.1:4180');
  console.log('   校准题目时间：node tools/calibrate-questions.js audio --write');
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

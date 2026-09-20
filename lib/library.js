/**
 * lib/library.js — 素材扫描与解析
 *
 * 把「文件系统 → 课程数据」这段逻辑独立出来，好处是：
 *   · server.js 只负责 HTTP，测试只 require 本模块，不会意外起服务
 *   · 解析规则（LRC 格式、元信息文件名约定）集中在一处，便于扩展
 *
 * 目录约定（audio/ 下，可再分子目录）：
 *   <name>.mp3 / .wav / .m4a ...   音频（必需）
 *   <name>.lrc                     时间轴，支持增强型逐词 <mm:ss.xx>
 *   <name>.questions.json          原题 + 答案 + 解析
 *   <name>.meta.json               标题 / 考试类型 / 来源 / 许可
 *   <name>.txt                     完整原文（可选，用于「原文」抽屉）
 */

'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const AUDIO_EXT = new Set([
  '.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga', '.opus', '.flac', '.webm', '.mp4',
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.lrc': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
  '.mp4': 'video/mp4',
};

// ---------------------------------------------------------------- 读取

function readFileMaybe(file) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
}

function readJsonMaybe(file) {
  const raw = readFileMaybe(file);
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[warn] JSON 解析失败 ${path.basename(file)}: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------- LRC

/**
 * 解析 LRC，支持三种写法：
 *   [mm:ss.xx]文本                      标准行时间戳
 *   [mm:ss.xx]<mm:ss.xx>词 <mm:ss.xx>词  增强型，逐词高亮
 *   [mm:ss.xx][mm:ss.xx]文本            一行多时间戳（重复段）
 */
function parseLrc(text) {
  if (!text) return [];

  const lines = [];
  const timeRe = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;
  const wordRe = /<(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)>([^<]*)/g;
  const metaRe = /^\[(ti|ar|al|by|offset|re|ve|length):/i;

  const toSec = (m, s) => Number(m) * 60 + Number(String(s).replace(':', '.'));

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || metaRe.test(line)) continue;

    const stamps = [...line.matchAll(timeRe)];
    if (!stamps.length) continue;

    const body = line.replace(timeRe, '').trim();

    // 逐词时间戳。
    // 注意：这里必须用一个【全新的】正则实例来做 replace。
    // 若复用上面 matchAll 用过的带 g 的正则，它的 lastIndex 已被推进到字符串末尾，
    // replace 会从末尾开始扫描，结果一个标签都替换不掉，text 就变成空串。
    const words = [];
    let plain = body.replace(/\s+/g, ' ').trim();
    if (body.includes('<')) {
      for (const m of body.matchAll(wordRe)) {
        const t = toSec(m[1], m[2]);
        // 一个 <t> 之后可能跟随多个词（含空格），逐个展开并共用该时间戳
        const toks = m[3].trim().split(/\s+/).filter(Boolean);
        for (const tok of toks) words.push({ time: t, text: tok });
      }
      plain = body.replace(/<(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)>/g, '').replace(/\s+/g, ' ').trim();
    }

    for (const s of stamps) {
      lines.push({
        time: toSec(s[1], s[2]),
        text: plain,
        ...(words.length ? { words: words.map((w) => ({ ...w })) } : {}),
      });
    }
  }

  return lines.sort((a, b) => a.time - b.time);
}

// ---------------------------------------------------------------- 扫描

/** 由单个音频文件推导出完整课程数据 */
async function makeLesson(dir, audioName, audioRoot) {
  const abs = path.join(dir, audioName);
  let stat;
  try {
    stat = await fsp.stat(abs);
  } catch {
    return null;
  }

  const base = audioName.slice(0, audioName.length - path.extname(audioName).length);
  const meta = readJsonMaybe(path.join(dir, `${base}.meta.json`)) || {};
  let questionsDoc = readJsonMaybe(path.join(dir, `${base}.questions.json`)) || {};
  const lrcText = readFileMaybe(path.join(dir, `${base}.lrc`));
  const transcriptText = readFileMaybe(path.join(dir, `${base}.txt`));

  // 用户手动修订优先。修订放在独立的 override 文件里，不改动机器生成的原文件：
  //   · 重跑转写/OCR 不会冲掉手工修改
  //   · 想还原就删掉 override
  const lrcOverride = readJsonMaybe(path.join(dir, `${base}.lrc.override.json`));
  const qOverride = readJsonMaybe(path.join(dir, `${base}.questions.json.override.json`));
  const hasLrcOverride = !!(lrcOverride && Array.isArray(lrcOverride.lines) && lrcOverride.lines.length);
  const hasQOverride = !!(qOverride && Array.isArray(qOverride.questions) && qOverride.questions.length);
  if (hasQOverride) questionsDoc = { ...questionsDoc, questions: qOverride.questions };

  // id 用可读的相对路径（保留中文），URL 里再由前端编码一次。
  // 若 id 预先编码过，前端再 encodeURIComponent 就成了双重编码，会查不到课程。
  const relRaw = path.relative(audioRoot, abs).split(path.sep).join('/');
  const relUrl = path.relative(audioRoot, abs).split(path.sep).map(encodeURIComponent).join('/');

  // 时长：优先 meta.duration，其次同名 .duration 缓存文件
  let duration = Number(meta.duration) || 0;
  if (!duration) {
    const cached = readFileMaybe(path.join(dir, `${base}.duration`));
    if (cached) duration = Number(cached.trim()) || 0;
  }

  const lines = hasLrcOverride ? lrcOverride.lines.map((l) => ({
    time: Number(l.time) || 0,
    text: String(l.text || ''),
    words: [],
  })) : parseLrc(lrcText);
  const questions = Array.isArray(questionsDoc.questions) ? questionsDoc.questions : [];
  // 题组正文（原题 OCR 的版式化文本）：题目面板按题组贴出来给用户对照。
  // 没有它的话，雅思题在界面上就只剩「题号 + 答案」，用户看到的就是「题目没显示」。
  const questionGroups = Array.isArray(questionsDoc.questionGroups) ? questionsDoc.questionGroups : [];

  // 译文时间轴（可选）：<name>.translation.lrc，与主时间轴同一套时间戳
  const translationText = readFileMaybe(path.join(dir, `${base}.translation.lrc`));
  const translationLines = parseLrc(translationText);
  // 机翻标识：译文文件里带 [re:...机器翻译...] 元信息就认为是机器翻译。
  // 用户自己上传的中文原文不会有这个标记，界面据此区分（用户明确要求：
  // 机翻必须加声明，人工译文则不加）。
  const translationIsMachine = /机器翻译|machine\s*translat/i.test(translationText || '');

  // 原题全文（可选）：<name>.paper.txt，来自原题 PDF 的 OCR
  const paperText = readFileMaybe(path.join(dir, `${base}.paper.txt`));

  return {
    id: relRaw,
    manifest: {
      id: relRaw,
      title: meta.title || questionsDoc.title || base,
      exam: String(meta.exam || questionsDoc.exam || 'other').toLowerCase(),
      section: meta.section || questionsDoc.section || '',
      paper: meta.paper || questionsDoc.paper || '',
      year: meta.year || questionsDoc.year || '',
      source: meta.source || questionsDoc.source || '',
      license: meta.license || questionsDoc.license || '',
      sourceUrl: meta.sourceUrl || questionsDoc.sourceUrl || '',
      audioUrl: `/media/${relUrl}`,
      audioName,
      folder: path.relative(audioRoot, dir).split(path.sep).filter(Boolean).join('/'),
      duration,
      sizeBytes: stat.size,
      transcriptUrl: transcriptText != null
        ? `/media/${path.relative(audioRoot, path.join(dir, `${base}.txt`)).split(path.sep).map(encodeURIComponent).join('/')}`
        : null,
      hasLrc: lines.length > 0,
      lineCount: lines.length,
      questionCount: questions.length,
      notes: meta.notes || '',
      importedAt: meta.importedAt || '',
      // 原文/时间轴的来源与可信度，界面据此显示标识
      transcriptSource: meta.transcriptSource || null,
      axisQuality: meta.axisQuality || (lines.length ? 'line' : 'none'),
      hasTranslation: translationLines.length > 0,
      translationIsMachine,
      hasPaper: paperText != null,
      editedTranscript: hasLrcOverride,
      editedQuestions: hasQOverride,
      paperUrl: paperText != null
        ? `/media/${path.relative(audioRoot, path.join(dir, `${base}.paper.txt`)).split(path.sep).map(encodeURIComponent).join('/')}`
        : null,
    },
    lines,
    translationLines,
    questions,
    questionGroups,
    transcript: transcriptText || '',
    paper: paperText || '',
  };
}

/** 扫描 audio/ 目录，递归一层子目录 */
async function buildLibrary(audioRoot) {
  let entries = [];
  try {
    entries = await fsp.readdir(audioRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const lessons = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const sub = path.join(audioRoot, entry.name);
      let files = [];
      try {
        files = await fsp.readdir(sub, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const f of files) {
        if (f.isFile() && AUDIO_EXT.has(path.extname(f.name).toLowerCase())) {
          const lesson = await makeLesson(sub, f.name, audioRoot);
          if (lesson) lessons.push(lesson);
        }
      }
    } else if (entry.isFile() && AUDIO_EXT.has(path.extname(entry.name).toLowerCase())) {
      const lesson = await makeLesson(audioRoot, entry.name, audioRoot);
      if (lesson) lessons.push(lesson);
    }
  }

  const order = { cet4: 0, cet6: 1, ielts: 2, toefl: 3, other: 4 };
  lessons.sort((a, b) => {
    const oa = order[a.manifest.exam] ?? 9;
    const ob = order[b.manifest.exam] ?? 9;
    if (oa !== ob) return oa - ob;
    return a.manifest.title.localeCompare(b.manifest.title, 'zh-Hans-CN');
  });

  return lessons;
}

module.exports = {
  AUDIO_EXT,
  MIME,
  parseLrc,
  readFileMaybe,
  readJsonMaybe,
  makeLesson,
  buildLibrary,
};

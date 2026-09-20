/**
 * lib/import.js — 处理「导入听力资料」请求
 *
 * 用户在前端选择四样东西：
 *   ① 音频（必需）  ② 原文（可选，缺则用 Whisper）  ③ 解析（可选）  ④ 原题（可选）
 *
 * 服务端要做的：
 *   1. 音频 base64 解码落盘到 audio/<分类>/
 *   2. 原文按扩展名分派：
 *        .json         → TED 风格字幕（{captions:[{startTime,duration,content}]}）
 *        .tsv          → 起始秒<TAB>结束秒<TAB>文本
 *        .srt / .vtt   → 标准字幕
 *        .lrc          → 直接复制
 *        其它（.txt/.md）→ 纯文本，没有时间戳，此时尝试自动生成
 *   3. 没有原文 / 没有时间戳时，调用 tools/transcribe.py 用 Whisper 生成
 *      （本机有 GPU，实测约 25 倍实时）
 *   4. 解析（.txt/.md）写进 .txt 或合并进 questions.json 的 explain
 *   5. 原题按扩展名分派（.json 直接用；文本走 parse-qstem 风格解析）
 *   6. 写 meta.json，标注 transcriptSource
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga', '.opus', '.flac', '.webm', '.mp4']);

function safeName(s) {
  return String(s || 'imported')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'imported';
}

function lrcTime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
}

/** 运行转写脚本（同步等待；音频一般 30 分钟内，耗时约 1-2 分钟） */
function runTranscribe(root, audioPath, tsvOut, onLog) {
  return new Promise((resolve) => {
    const py = process.platform === 'win32' ? 'python' : 'python3';
    const script = path.join(root, 'tools', 'transcribe.py');
    if (!fs.existsSync(script)) return resolve({ ok: false, error: '找不到 transcribe.py' });

    const args = [
      script,
      '--audio', audioPath,
      '--out', tsvOut,
      '--model', 'medium.en',
      '--no-vad',       // 实测 VAD 的 ONNX 会话会泄漏内存
      '--beam', '1',    // 束搜索吃内存，长音频容易失败
    ];

    const child = execFile(py, args, { cwd: root, timeout: 30 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return resolve({ ok: false, error: String(stderr || err.message).slice(0, 400) });
        resolve({ ok: true, log: String(stdout).slice(-800) });
      });
    if (onLog && child.stdout) child.stdout.on('data', (d) => onLog(String(d)));
  });
}

/** TSV → LRC 行 */
function tsvToLines(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const p = raw.split('\t');
    if (p.length < 3) continue;
    const t = Number(p[0]);
    const s = p.slice(2).join('\t').trim();
    if (Number.isFinite(t) && s) out.push({ time: t, text: s });
  }
  return out;
}

/** SRT/VTT → LRC 行（复用已有工具） */
function subtitleToLines(root, text, ext) {
  try {
    const tool = require(path.join(root, 'tools', 'lrc-from-srt.js'));
    const cues = (ext === '.json') ? tool.parseTedJson(text)
      : (ext === '.srt' || ext === '.vtt') ? tool.parseSrtLike(text)
        : tool.parseTsv(text);
    return cues.map((c) => ({ time: c.start, text: c.text }));
  } catch {
    return [];
  }
}

/** 简易原题解析（题号 + 选项） */
function parseQuestionsLoose(text) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  const out = [];
  let cur = null;
  const qRe = /^\s*(\d{1,2})\s*[.、)]\s*(.*)$/;
  const optRe = /^\s*([A-D])\s*[.、)]\s*(.*)$/;

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    const om = optRe.exec(line);
    if (om && cur) { cur.options.push(om[2].trim()); continue; }
    const qm = qRe.exec(line);
    if (qm) {
      cur = { number: Number(qm[1]), stem: qm[2].trim(), options: [] };
      out.push(cur);
    } else if (cur) {
      if (cur.options.length) cur.options[cur.options.length - 1] += ' ' + line.trim();
      else cur.stem = (cur.stem + ' ' + line.trim()).trim();
    }
  }
  return out;
}

/**
 * 主入口
 * @param {object} deps  { root, audioRoot, payload }
 */
async function handleImport(deps) {
  const { root, audioRoot, payload } = deps;

  const audioName = safeName(payload.audioName || 'imported.mp3');
  const ext = path.extname(audioName).toLowerCase();
  if (!AUDIO_EXT.has(ext)) throw new Error('不支持的音频格式：' + ext);

  const base = audioName.slice(0, audioName.length - ext.length);
  const exam = String(payload.exam || 'other').toLowerCase();
  const folderName = { cet4: 'CET4', cet6: 'CET6', ielts: 'IELTS', toefl: 'TOEFL' }[exam] || '导入';
  const dir = path.join(audioRoot, folderName);
  fs.mkdirSync(dir, { recursive: true });

  // ── 1. 音频落盘
  if (!payload.audioBase64) throw new Error('缺少音频数据');
  const buf = Buffer.from(payload.audioBase64, 'base64');
  if (buf.length < 1024) throw new Error('音频数据过小，可能读取失败');
  const audioPath = path.join(dir, audioName);
  fs.writeFileSync(audioPath, buf);

  const result = {
    lessonId: `${folderName}/${audioName}`,
    title: payload.title || base,
    base,
    audioPath,
    transcriptGenerated: false,
    needsTranscription: false,
  };

  // ── 2. 原文 / 时间轴
  let lines = [];
  let transcriptText = null;
  let transcriptKind = null;

  if (payload.transcript && payload.transcript.trim()) {
    const t = payload.transcript;
    const looksJson = /^\s*[{[]/.test(t);
    const looksTsv = /^\s*\d+(\.\d+)?\t/m.test(t);
    const looksSrt = /-->/.test(t);
    const looksLrc = /^\s*\[\d{1,3}:\d{1,2}/m.test(t);

    if (looksLrc) {
      fs.writeFileSync(path.join(dir, `${base}.lrc`), t, 'utf8');
      const { parseLrc } = require(path.join(root, 'lib', 'library.js'));
      lines = parseLrc(t);
      transcriptKind = 'official';
      transcriptText = t.replace(/^\[[^\]]*\]/gm, '').trim();
    } else if (looksJson || looksSrt || looksTsv) {
      const fakeExt = looksJson ? '.json' : (looksSrt ? '.srt' : '.tsv');
      lines = subtitleToLines(root, t, fakeExt);
      transcriptKind = 'official';
    } else {
      // 纯文本：没有时间戳
      transcriptText = t.trim();
      transcriptKind = 'official';
    }
  }

  // 没有可用时间轴 → 跑 Whisper
  if (lines.length < 2) {
    const tsvRel = path.join('transcripts', `${base}.tsv`);
    const tsvAbs = path.join(root, tsvRel);
    fs.mkdirSync(path.dirname(tsvAbs), { recursive: true });

    const r = await runTranscribe(root, audioPath, tsvAbs);
    if (r.ok && fs.existsSync(tsvAbs)) {
      lines = tsvToLines(fs.readFileSync(tsvAbs, 'utf8'));
      transcriptKind = 'whisper';
      result.transcriptGenerated = true;
    } else {
      result.needsTranscription = true;
      result.transcribeError = r.error || '转写未完成';
    }
  }

  // 写 LRC
  if (lines.length >= 2) {
    fs.writeFileSync(path.join(dir, `${base}.lrc`), [
      `[ti:${result.title}]`,
      '[by:listening-player import]',
      transcriptKind === 'whisper'
        ? '[re:⚠ 原文与时间轴由 OpenAI Whisper 自动语音识别生成，非官方原文，可能有错字]'
        : '[re:用户提供的原文与时间轴]',
      `[length:${lrcTime(lines[lines.length - 1].time)}]`,
      ...lines.map((l) => `[${lrcTime(l.time)}]${l.text}`),
    ].join('\n') + '\n', 'utf8');
  }

  // 写原文 txt（用户提供的文本优先；否则从时间轴拼）
  const textOut = transcriptText || (lines.length ? lines.map((l) => l.text).join('\n') : '');
  if (textOut) fs.writeFileSync(path.join(dir, `${base}.txt`), textOut + '\n', 'utf8');

  // ── 3. 解析
  if (payload.explain && payload.explain.trim()) {
    fs.writeFileSync(path.join(dir, `${base}.explain.txt`), payload.explain.trim() + '\n', 'utf8');
  }

  // ── 4. 原题
  let questions = [];
  if (payload.questions && payload.questions.trim()) {
    const q = payload.questions.trim();
    if (/^\s*[{[]/.test(q)) {
      try {
        const doc = JSON.parse(q);
        questions = Array.isArray(doc) ? doc : (doc.questions || []);
      } catch { /* 当纯文本处理 */ }
    }
    if (!questions.length) questions = parseQuestionsLoose(q);
  }

  // 没有原题也要有骨架，否则做题流程跑不起来
  if (!questions.length) {
    questions = [];
    for (let n = 1; n <= 40; n++) {
      questions.push({
        number: n,
        tag: `Section ${Math.min(4, Math.floor((n - 1) / 10) + 1)}`,
        section: Math.min(4, Math.floor((n - 1) / 10) + 1),
        stem: '', options: [], answer: '', alternatives: [],
        explain: '', start: null, end: null, transcript: '',
      });
    }
  } else {
    // 补全字段 + Section
    questions = questions.map((q, i) => ({
      number: q.number != null ? q.number : i + 1,
      tag: q.tag || `Section ${Math.min(4, Math.floor(i / 10) + 1)}`,
      section: q.section || Math.min(4, Math.floor(i / 10) + 1),
      stem: q.stem || '',
      options: q.options || [],
      answer: q.answer || '',
      alternatives: q.alternatives || [],
      explain: q.explain || '',
      start: q.start != null ? q.start : null,
      end: q.end != null ? q.end : null,
      transcript: q.transcript || '',
    }));
  }

  fs.writeFileSync(path.join(dir, `${base}.questions.json`), JSON.stringify({
    title: result.title,
    exam,
    section: 'Section 1-4',
    source: '用户导入',
    license: '用户自备素材',
    questions,
  }, null, 2), 'utf8');

  // ── 5. 元信息
  const meta = {
    title: result.title,
    exam,
    section: 'Section 1-4',
    paper: '',
    year: '',
    source: '用户导入' + (result.transcriptGenerated ? '（原文由 Whisper 生成）' : ''),
    license: '用户自备素材，仅供个人学习使用',
    sourceUrl: '',
    duration: 0,
    notes: result.transcriptGenerated
      ? '原文与逐句时间轴由本机 Whisper 自动转写生成，请以官方材料为准。'
      : (lines.length >= 2 ? '使用用户提供的原文与时间轴。' : '未生成时间轴（转写未完成）。'),
    transcriptSource: result.transcriptGenerated
      ? { kind: 'whisper', model: 'faster-whisper medium.en', generatedAt: new Date().toISOString().slice(0, 10), note: '机器转写，非官方原文' }
      : (transcriptKind === 'official'
        ? { kind: 'official', note: '用户提供' }
        : null),
    axisQuality: lines.length >= 2 ? 'sentence' : 'none',
    hasTranslation: false,
    importedAt: new Date().toISOString().slice(0, 10),
    generator: 'tools/import 接口',
  };
  fs.writeFileSync(path.join(dir, `${base}.meta.json`), JSON.stringify(meta, null, 2), 'utf8');

  return result;
}

module.exports = { handleImport };

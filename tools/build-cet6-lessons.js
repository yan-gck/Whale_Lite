#!/usr/bin/env node
/**
 * build-cet6-lessons.js — 把下载好的六级原始素材编译成播放器课程
 *
 * 输入（由 tools/fetch-cet6-full.js 与 tools/cet6-timings.js 准备）：
 *   audio/_cet6-raw/CET6_YYYY.MM/   音频 + transcription.md + 题干 + 答案 + 可选 LRC
 *   audio/_timings/*.timings.json   句级时间戳 + 中文译文（3056810551/cet-listening, MIT）
 *
 * 输出：audio/CET6-真题/  每套一个课程（音频 + lrc + txt + questions.json + meta.json）
 *
 * 三类时间轴，按质量从高到低优先采用：
 *   1. 句级时间戳（timings.json）—— 有中文译文，最好
 *   2. 行级时间轴（仓库自带 .lrc）
 *   3. 无 —— 歌词不滚动，但原文仍可在「原文」抽屉里读
 *
 * ⚠️ 上游数据缺陷（实测发现，必须告知使用者）：
 *   CET6_2017.06 的两个音频与 CET6_2017.12 的【完全相同】（字节数与 MD5 前缀都一致），
 *   说明 6 月那套的音频是错放的副本。本脚本会检出并排除，避免把 12 月的音频
 *   配上 6 月的原文（那样时间轴和内容都会错）。
 *
 * 用法：
 *   node tools/build-cet6-lessons.js           生成
 *   node tools/build-cet6-lessons.js --dry     只报告
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const RAW_DIR = path.join(ROOT, 'audio', '_cet6-raw');
const TIMINGS_DIR = path.join(ROOT, 'audio', '_timings');
const OUT_DIR = path.join(ROOT, 'audio', 'CET6-真题');

const DRY = process.argv.includes('--dry');
const ZENODO = 'https://doi.org/10.5281/zenodo.20474009';

// ---------------------------------------------------------------- 工具

function lrcTime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
}

function readUtf8(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
}

/** 旧编码转 UTF-8：先看 BOM → 再严格试 UTF-8 → 最后按 GBK */
function toUtf8(buf) {
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.subarray(3);
  try {
    const s = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    if (!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(s)) return Buffer.from(s, 'utf8');
  } catch { /* 继续 */ }
  try { return Buffer.from(new TextDecoder('gbk').decode(buf), 'utf8'); } catch { return buf; }
}

function labelOfSet(set) {
  const m = /CET6_(\d{4})\.(\d{2})/.exec(set);
  return m ? `${m[1]}年${Number(m[2])}月` : set;
}

function labelOfFile(name) {
  const s = /set(\d)/i.exec(name);
  if (s) return `第${s[1]}套`;
  return parseFileLabel(name);
}

/**
 * 从文件名或标签里取「第N套 / 全N套」。
 * 注意：既可能是中文数字（第1套 来自仓库文件名），
 * 也可能是阿拉伯数字（第一套 来自我自己生成的文件名），两种都要认。
 */
const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function parseFileLabel(name) {
  const s = String(name);
  let m = /第(\d+)套/.exec(s);
  if (m) return { label: `第${m[1]}套`, idx: m[1] };
  m = /第([一二三四五六七八九])套/.exec(s);
  if (m) return { label: `第${CN_NUM[m[1]]}套`, idx: String(CN_NUM[m[1]]) };
  m = /全(\d*)套/.exec(s);
  if (m) return { label: m[1] ? `全${m[1]}套` : '全1套', idx: null };
  return { label: '全1套', idx: null };
}

/** 解析课程文件名「2017年12月-第1套」→ 标签（两种数字写法都支持） */
function parseLessonFileName(file) {
  const key = file.replace(/\.(mp3|m4a)$/i, '');
  const m = /^(\d{4})年(\d{1,2})月-(.+)$/.exec(key);
  if (!m) return null;
  const f = parseFileLabel(m[3]);
  return {
    setLabel: `${m[1]}年${Number(m[2])}月`,
    fileLabel: f.label,
    setIdx: f.idx,
  };
}

function parseStem(text) {
  const lines = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let cur = null;
  const qWithOpt = /^\s*(\d{1,2})\s*[.、)]\s*([A-D])\s*[.、)]\s*(.*)$/;
  const optRe = /^\s*([A-D])\s*[.、)]\s*(.*)$/;
  const qRe = /^\s*(\d{1,2})\s*[.、)]\s*(.*)$/;

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;

    const qo = qWithOpt.exec(line);
    if (qo) { cur = { number: Number(qo[1]), stem: '', options: [qo[3].trim()] }; out.push(cur); continue; }

    const om = optRe.exec(line);
    if (om && cur && cur.options.length < 4) { cur.options.push(om[2].trim()); continue; }

    const qm = qRe.exec(line);
    if (qm) { cur = { number: Number(qm[1]), stem: qm[2].trim(), options: [] }; out.push(cur); continue; }

    if (cur && cur.options.length) cur.options[cur.options.length - 1] += ' ' + line.trim();
    else if (cur) cur.stem = (cur.stem + ' ' + line.trim()).trim();
  }
  return out.filter((q) => q.options.length >= 2);
}

function parseAnswers(text) {
  const map = new Map();
  for (const m of String(text).replace(/^\uFEFF/, '').matchAll(/(\d{1,2})\s*[.、:)]?\s*([A-D])\b/g)) {
    const n = Number(m[1]);
    if (!map.has(n)) map.set(n, m[2]);
  }
  return map;
}

/** 从 transcript.md 抽 [N] 标记对应的答案句 */
function parseRefs(md) {
  const map = new Map();
  for (const rawLine of String(md).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line || !/\[\d{1,2}\]/.test(line)) continue;
    const body = line.replace(/^[MW]\s*:\s*/i, '').replace(/^[A-Za-z ]{2,20}:\s*/, '');
    for (const m of body.matchAll(/\[(\d{1,2})\]/g)) {
      const n = Number(m[1]);
      if (map.has(n)) continue;
      const start = body.lastIndexOf('.', m.index) + 1;
      let end = body.indexOf('.', m.index);
      if (end === -1) end = body.length;
      const s = body.slice(start, end + 1).replace(/\[\d{1,2}\]/g, '').replace(/\s+/g, ' ').trim();
      if (s) map.set(n, s);
    }
  }
  return map;
}

function parseLrcLines(text) {
  if (!text) return [];
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^\[(ti|ar|al|by|offset|re|ve|length):/i.test(line)) continue;
    const m = /^\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\](.*)$/.exec(line);
    if (!m) continue;
    out.push({ time: Number(m[1]) * 60 + Number(m[2].replace(':', '.')), text: m[3].trim() });
  }
  return out.sort((a, b) => a.time - b.time);
}

/** 由「YYYY年M月」找到对应的原始下载目录（若有） */
function findRawDir(setLabel) {
  const m = /^(\d{4})年(\d{1,2})月$/.exec(setLabel);
  if (!m || !fs.existsSync(RAW_DIR)) return null;
  const want = `CET6_${m[1]}.${String(m[2]).padStart(2, '0')}`;
  const dir = path.join(RAW_DIR, want);
  return fs.existsSync(dir) ? dir : null;
}

// ---------------------------------------------------------------- 主流程

function main() {
  const { mediaDuration, analyze } = require('./media-duration.js');

  if (!fs.existsSync(RAW_DIR)) {
    console.error('缺少 audio/_cet6-raw，请先运行：node tools/fetch-cet6-full.js down');
    process.exit(1);
  }

  // ---- 1. 收集音频
  //
  // 两种来源：
  //   a) audio/_cet6-raw/ 里的原始下载（首次构建时用）
  //   b) audio/CET6-真题/ 里已经复制好的课程音频（清掉 _cet6-raw 之后仍可重跑）
  // 这样即使用户为了省空间删掉了原始下载目录，重建元信息/题目也不会失败。
  const audios = [];
  const seenOut = new Set();

  for (const set of fs.readdirSync(RAW_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
    const dir = path.join(RAW_DIR, set);
    for (const f of fs.readdirSync(dir).filter((x) => /\.(mp3|m4a)$/i.test(x))) {
      const full = path.join(dir, f);
      const buf = fs.readFileSync(full);
      audios.push({
        set, file: f, path: full, from: 'raw',
        size: buf.length,
        head: crypto.createHash('md5').update(buf.subarray(0, 524288)).digest('hex').slice(0, 12),
      });
    }
  }

  // 已构建的课程音频（仅当 raw 里没有音频时才用，避免重复）
  if (!audios.length && fs.existsSync(OUT_DIR)) {
    for (const f of fs.readdirSync(OUT_DIR).filter((x) => /\.(mp3|m4a)$/i.test(x))) {
      const full = path.join(OUT_DIR, f);
      const buf = fs.readFileSync(full);
      const head = crypto.createHash('md5').update(buf.subarray(0, 524288)).digest('hex').slice(0, 12);
      audios.push({
        set: '', file: f, path: full, from: 'lesson',
        size: buf.length, head,
      });
      seenOut.add(head);
    }
    if (audios.length) {
      console.log('');
      console.log(`_cet6-raw 里已无音频，改为就地更新 ${audios.length} 个已构建课程（不重新复制音频）`);
    }
  }

  const byHead = new Map();
  for (const a of audios) {
    if (!byHead.has(a.head)) byHead.set(a.head, []);
    byHead.get(a.head).push(a);
  }

  // ---- 2. 载入 timings，按字节数建索引（先建，去重要用到）
  const timingsBySize = new Map();
  if (fs.existsSync(TIMINGS_DIR)) {
    for (const f of fs.readdirSync(TIMINGS_DIR).filter((x) => x.endsWith('.timings.json'))) {
      try {
        const doc = JSON.parse(fs.readFileSync(path.join(TIMINGS_DIR, f), 'utf8'));
        const size = doc.source && doc.source.audio ? Number(doc.source.audio.size) : 0;
        if (size) timingsBySize.set(size, { key: f.replace('.timings.json', ''), doc });
      } catch { /* 跳过坏文件 */ }
    }
  }

  /**
   * 同一份录音被放在多个考次目录时，保留哪一份？
   *
   * 实测案例：CET6_2017.06 与 CET6_2017.12 的两个音频内容完全相同
   *（字节数与 MD5 前缀都一致）。目录名差两个月，无法靠日期判断谁对。
   *
   * 最终裁决用【内容证据】：timings 里存着这段录音的逐句文本，
   * 把它和各候选目录的 transcription.md 做词重合度比较，
   * 能对上的那个目录才是正确标签。
   *
   * 实测结论：2017.12 的原文（"欧洲食物浪费"）与 timings 2017-12-1 高度重合，
   * 2017.06 的原文（"Work Place 节目"）几乎不重合 —— 所以 2017.12 才是对的，
   * 2017.06 是错放的副本。
   */
  function transcriptMatchScore(audio) {
    const t = timingsBySize.get(audio.size);
    if (!t || !t.doc.lines) return 0;

    const timingWords = new Set(
      t.doc.lines.flatMap((l) => String(l.text || '').toLowerCase().match(/[a-z']{3,}/g) || []),
    );
    if (!timingWords.size) return 0;

    // 找该目录下的原文文件
    const dir = path.dirname(audio.path);
    const trName = fs.readdirSync(dir).find((f) => /transcript\.md$/i.test(f));
    if (!trName) return 0;

    const md = readUtf8(path.join(dir, trName));
    if (!md) return 0;
    const mdWords = new Set((md.toLowerCase().match(/[a-z']{3,}/g) || []));
    if (!mdWords.size) return 0;

    let inter = 0;
    for (const w of timingWords) if (mdWords.has(w)) inter++;
    // 用 Jaccard 相似度，避免长文本天然占优
    return inter / (timingWords.size + mdWords.size - inter);
  }

  const monthRank = (a) => {
    const m = /CET6_(\d{4})\.(\d{2})/.exec(a.set);
    return m ? Number(m[1]) * 100 + Number(m[2]) : 999999;
  };

  const excluded = [];
  const kept = [];
  for (const [, group] of byHead) {
    if (group.length === 1) { kept.push(group[0]); continue; }

    // 先算内容证据，写进日志便于复核
    const scored = group.map((a) => ({ a, score: transcriptMatchScore(a) }));
    scored.sort((x, y) => (y.score - x.score) || (monthRank(x.a) - monthRank(y.a)));

    const best = scored[0];
    kept.push(best.a);

    for (const s of scored.slice(1)) {
      excluded.push({
        ...s.a,
        reason: `与 ${best.a.set}/${best.a.file} 内容完全相同（MD5 一致）。`
          + `内容证据：${best.a.set} 的原文与时间戳重合度 ${(best.score * 100).toFixed(1)}%，`
          + `而本目录仅 ${(s.score * 100).toFixed(1)}% —— 判定本文件为上游错放的副本。`,
      });
    }
  }

  console.log('');
  console.log(`音频 ${audios.length} 个，按内容去重后保留 ${kept.length} 个`);
  if (excluded.length) {
    console.log('');
    console.log('⚠ 检出上游数据缺陷 —— 以下音频与其它考次的文件内容完全相同，已排除：');
    for (const e of excluded) {
      console.log(`    ${e.set}/${e.file}`);
      console.log(`      ${e.reason}`);
    }
    console.log('    影响：这些考次的音频无法提供，请不要用别的考次音频顶替（时间轴会整体错位）。');
  }

  // ---- 2. 载入 timings，按字节数建索引
  //（已在去重之前建立，见上文）

  // ---- 3. 生成课程
  if (!DRY) fs.mkdirSync(OUT_DIR, { recursive: true });

  let made = 0, qTotal = 0, calOK = 0;
  const stats = { sentence: 0, linelrc: 0, none: 0 };

  for (const a of kept.sort((x, y) => (x.set + x.file).localeCompare(y.set + y.file))) {
    // 课程文件名统一是「YYYY年M月-第N套」，两种来源都能解析出 set/file 标签
    const parsed = parseLessonFileName(a.file);
    if (!parsed) continue;
    const setLabel = a.set ? labelOfSet(a.set) : parsed.setLabel;
    const fileLabel = a.set ? labelOfFile(a.file) : parsed.fileLabel;
    const setIdx = a.set ? (/set(\d)/i.exec(a.file) || [])[1] : parsed.setIdx;

    // 附属文本（原文/题干/答案/仓库LRC）只在原始下载目录里；缺失时降级处理
    let dir = a.set ? path.dirname(a.path) : null;
    if (!dir) dir = findRawDir(setLabel);
    const files = dir && fs.existsSync(dir) ? fs.readdirSync(dir) : [];

    const pick = (arr) => {
      if (setIdx) {
        const hit = arr.find((f) => new RegExp(`set${setIdx}`, 'i').test(f));
        if (hit) return hit;
      }
      return arr[0];
    };

    const stemFile = pick(files.filter((f) => /q_stem\.txt$/i.test(f)));
    const ansFile = pick(files.filter((f) => /q_answer\.txt$/i.test(f)));
    const trFile = pick(files.filter((f) => /transcript\.md$/i.test(f)));
    const lrcFile = (() => {
      const all = files.filter((f) => /\.lrc$/i.test(f));
      if (!all.length) return null;
      if (setIdx) {
        const cn = ['一', '二', '三'][Number(setIdx) - 1];
        return all.find((f) => f.includes(`第${cn}套`)) || all[0];
      }
      return all[0];
    })();

    const base = `${setLabel}-${fileLabel}`;
    const outBase = path.join(OUT_DIR, base);

    // 音频复制
    const destAudio = `${outBase}${path.extname(a.file)}`;
    if (!DRY) fs.copyFileSync(a.path, destAudio);
    const info = analyze(a.path);
    const dur = info.duration;

    // 时间轴：优先句级 timings，其次仓库 LRC
    let lrcLines = [];
    let translation = [];
    let axis = '无';
    const t = timingsBySize.get(a.size);
    if (t && t.doc.lines && t.doc.lines.length) {
      const lines = t.doc.lines.filter((l) => l.start != null && String(l.text || '').trim());
      lrcLines = lines.map((l) => ({
        time: Number(l.start),
        text: (l.speaker && l.speaker !== 'narrator' ? `${l.speaker} ` : '') + String(l.text).replace(/\s+/g, ' ').trim(),
        translation: l.translation || '',
        section: l.sectionTitle || '',
      }));
      translation = lrcLines.filter((l) => l.translation);
      axis = `句级时间戳（timings ${t.key}，配中文译文）`;
      stats.sentence++;
    } else if (lrcFile) {
      lrcLines = parseLrcLines(toUtf8(fs.readFileSync(path.join(dir, lrcFile))).toString('utf8'));
      if (lrcLines.length) { axis = `行级时间轴（仓库自带 ${lrcFile}）`; stats.linelrc++; }
    }
    if (axis === '无') stats.none++;

    // 题目
    let questions = [];
    if (stemFile) {
      const parsed = parseStem(toUtf8(fs.readFileSync(path.join(dir, stemFile))).toString('utf8'));
      const ansMap = ansFile ? parseAnswers(toUtf8(fs.readFileSync(path.join(dir, ansFile))).toString('utf8')) : new Map();
      const refMap = trFile ? parseRefs(toUtf8(fs.readFileSync(path.join(dir, trFile))).toString('utf8')) : new Map();
      questions = parsed.map((q) => ({
        number: q.number, tag: '', stem: q.stem || '',
        options: q.options, answer: ansMap.get(q.number) || '',
        explain: '', start: null, end: null,
        transcript: refMap.get(q.number) || '',
      }));
    }

    // 用时间轴校准题目片段
    if (lrcLines.length >= 2 && questions.length && axis.startsWith('句级')) {
      try {
        const { calibrateDoc, parseLrcWords, tokenize, lcsAlign } = require('./calibrate-questions.js');
        // 句级时间轴没有逐词信息，用句子本身当词流即可
        const words = [];
        for (const l of lrcLines) for (const w of tokenize(l.text)) words.push({ time: l.time, text: w });
        const srcTokens = tokenize(lrcLines.map((l) => l.text).join(' '));
        const mapA = lcsAlign(srcTokens, words.map((w) => w.text));
        const res = calibrateDoc({ questions }, words, srcTokens, mapA, { pad: 0.4, minScore: 0.6 });
        calOK += res.filter((r) => r.status === 'calibrated').length;
      } catch { /* 校准失败不影响课程生成 */ }
    }

    // 原文 txt（英文 + 中文对照）
    const tr = trFile ? toUtf8(fs.readFileSync(path.join(dir, trFile))).toString('utf8') : '';
    let txt;
    if (axis.startsWith('句级') && translation.length) {
      const out = [];
      let lastSec = null;
      for (const l of lrcLines) {
        if (l.section && l.section !== lastSec) { out.push(`\n═══ ${l.section} ═══\n`); lastSec = l.section; }
        out.push(l.text);
        if (l.translation) out.push(`    ${l.translation}`);
      }
      txt = out.join('\n') + '\n';
    } else {
      txt = tr.replace(/^#+\s*/gm, '').replace(/\n{3,}/g, '\n\n').trim() + '\n';
    }

    if (!DRY) {
      // LRC
      fs.writeFileSync(`${outBase}.lrc`, [
        `[ti:六级真题 · ${setLabel} ${fileLabel}]`,
        '[by:listening-player build-cet6-lessons]',
        `[re:${axis}]`,
        `[length:${lrcTime(dur)}]`,
        ...lrcLines.map((l) => `[${lrcTime(l.time)}]${l.text}`),
      ].join('\n') + '\n', 'utf8');

      // 译文
      if (translation.length) {
        fs.writeFileSync(`${outBase}.translation.lrc`, [
          `[ti:六级真题 · ${setLabel} ${fileLabel} · 译文]`,
          ...translation.map((l) => `[${lrcTime(l.time)}]${l.translation.replace(/\s+/g, ' ').trim()}`),
        ].join('\n') + '\n', 'utf8');
      }

      fs.writeFileSync(`${outBase}.txt`, txt, 'utf8');

      fs.writeFileSync(`${outBase}.questions.json`, JSON.stringify({
        title: `六级真题 · ${setLabel} ${fileLabel}`,
        exam: 'cet6', section: '', paper: `${setLabel} ${fileLabel}`,
        source: 'Ysoseri1224/CET-6-Listening-10-Years-Resources-and-Analysis（Zenodo 收录）',
        license: '上传者声明 CC BY 4.0（非考试委员会声明）',
        sourceUrl: ZENODO,
        questions,
      }, null, 2), 'utf8');

      const notes = [
        `时间轴：${axis}。`,
        questions.length ? `题目 ${questions.length} 道；题干为录音念出，故题干字段为空，选项与答案来自仓库文件。` : '本套没有题干文件。',
        translation.length ? `含中文译文 ${translation.length} 行。` : '',
        axis === '无' ? '本套无时间轴，歌词面板不会滚动；原文可在「原文」抽屉阅读。' : '',
      ].filter(Boolean).join('');

      fs.writeFileSync(`${outBase}.meta.json`, JSON.stringify({
        title: `六级真题 · ${setLabel} ${fileLabel}`,
        exam: 'cet6', section: '', paper: `${setLabel} ${fileLabel}`,
        year: setLabel.slice(0, 4),
        source: 'Ysoseri1224/CET-6-Listening-10-Years-Resources-and-Analysis'
          + (axis.startsWith('句级') ? ' ／ 时间戳 3056810551/cet-listening（MIT）' : ''),
        license: '上传者声明 CC BY 4.0（非考试委员会声明；个人学习可用，公开分发请自行判断）'
          + (axis.startsWith('句级') ? '；时间戳数据 MIT' : ''),
        sourceUrl: ZENODO,
        duration: dur,
        notes,
        hasTranslation: translation.length > 0,
        axisQuality: axis.startsWith('句级') ? 'sentence' : (axis === '无' ? 'none' : 'line'),
        importedAt: new Date().toISOString().slice(0, 10),
        generator: 'tools/build-cet6-lessons.js',
      }, null, 2), 'utf8');
    }

    made++; qTotal += questions.length;
    console.log(`  ${axis === '无' ? '·' : '✓'} ${base.padEnd(20)} ${String((a.size / 1048576).toFixed(1)).padStart(5)} MB  `
      + `${String(Math.round(dur)).padStart(4)}s  ${String(lrcLines.length).padStart(3)} 行  ${String(questions.length).padStart(2)} 题  [${axis}]`);
  }

  require('node:fs').writeFileSync(path.join(ROOT, 'audio', '_cet6-build-report.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    lessons: made,
    questions: qTotal,
    calibratedQuestions: calOK,
    axis: stats,
    excludedDuplicates: excluded.map((e) => ({ set: e.set, file: e.file, reason: e.reason })),
  }, null, 2), 'utf8');

  console.log('');
  console.log('─'.repeat(78));
  console.log(`生成 ${made} 个课程，题目 ${qTotal} 道（校准成功 ${calOK}）`);
  console.log(`时间轴质量：句级 ${stats.sentence} 个，行级 ${stats.linelrc} 个，无 ${stats.none} 个`);
  if (excluded.length) console.log(`排除内容重复的音频 ${excluded.length} 个（上游数据缺陷）`);
  console.log(`输出：${OUT_DIR}`);
  console.log('');
}

if (require.main === module) main();

module.exports = { toUtf8, parseStem, parseAnswers, parseRefs };

#!/usr/bin/env node
/**
 * fetch-cet6-full.js — 下载 Ysoseri1224 仓库里的【全部六级真题】并装进播放器
 *
 * 来源：Ysoseri1224/CET-6-Listening-10-Years-Resources-and-Analysis
 *       Zenodo DOI 10.5281/zenodo.20474009，Zenodo 的 license 字段为 cc-by-4.0
 *
 * ⚠️ 许可说明（必须如实告知）：
 *   CC BY 4.0 是**上传者自己声明**的，不是全国大学英语四六级考试委员会声明的。
 *   下游仓库自己都写了 "it is not an independent warranty that every underlying
 *   item is free of third-party rights."。个人学习没有问题，公开分发请自行判断。
 *
 * 两个技术要点：
 *   1. 音频走 Git LFS，必须用 media.githubusercontent.com。
 *      用 raw.githubusercontent.com 会返回 133 字节的指针文件，状态码却是 200。
 *   2. .lrc / 题干 / 答案有 GBK 编码，读之前要探测编码（有的其实是 UTF-8 带 BOM）。
 *
 * 用法：
 *   node tools/fetch-cet6-full.js list             只看会下载什么
 *   node tools/fetch-cet6-full.js down             下载全部（已存在的跳过）
 *   node tools/fetch-cet6-full.js build            生成资料包并装进播放器
 *   node tools/fetch-cet6-full.js all              下载 + 生成
 */

'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RAW_DIR = path.join(ROOT, 'audio', '_cet6-raw');
const OUT_DIR = path.join(ROOT, 'audio', 'CET6-真题');

const REPO = 'Ysoseri1224/CET-6-Listening-10-Years-Resources-and-Analysis';
const BRANCH = 'main';
const ZENODO = 'https://doi.org/10.5281/zenodo.20474009';

const { download } = require('./fetch-resources.js');

// ---------------------------------------------------------------- 拉清单

async function listRepo() {
  const raw = await download(`https://api.github.com/repos/${REPO}/git/trees/HEAD?recursive=1`,
    { expectBinary: false, timeoutMs: 120000 });
  const tree = JSON.parse(raw).tree.filter((x) => x.type === 'blob');

  return tree
    .filter((f) => /\.(mp3|m4a|md|lrc)$/i.test(f.path) || /q_(stem|answer)\.txt$/i.test(f.path))
    .filter((f) => !f.path.startsWith('abandon/'))
    .map((f) => ({
      path: f.path,
      set: f.path.split('/')[0],
      kind: /\.(mp3|m4a)$/i.test(f.path) ? 'audio'
        : /\.lrc$/i.test(f.path) ? 'lrc'
          : /transcript\.md$/i.test(f.path) ? 'transcript'
            : /q_stem\.txt$/i.test(f.path) ? 'stem'
              : /q_answer\.txt$/i.test(f.path) ? 'answer' : 'other',
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** 音频走 LFS 媒体域名，文本走 raw（中文/英文路径都实测可用） */
function urlFor(p) {
  const isAudio = /\.(mp3|m4a)$/i.test(p);
  const base = isAudio
    ? `https://media.githubusercontent.com/media/${REPO}/${BRANCH}`
    : `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;
  return `${base}/${p.split('/').map(encodeURIComponent).join('/')}`;
}

// ---------------------------------------------------------------- 编码

/**
 * 把旧编码字节转成 UTF-8。
 * 先看 BOM（有 BOM 说明本来就是 UTF-8，按 GBK 解会把 BOM 变成 "锘�"），
 * 再用严格模式试 UTF-8，最后才按 GBK 解。
 */
function toUtf8(buf) {
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.subarray(3);
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    try { return Buffer.from(new TextDecoder('utf-16le').decode(buf.subarray(2)), 'utf8'); } catch { return buf; }
  }
  try {
    const strict = new TextDecoder('utf-8', { fatal: true });
    const s = strict.decode(buf);
    if (!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(s)) return Buffer.from(s, 'utf8');
  } catch { /* 不是合法 UTF-8，继续按 GBK */ }
  try { return Buffer.from(new TextDecoder('gbk').decode(buf), 'utf8'); } catch { return buf; }
}

const isLfsPointer = (buf) =>
  /^version https:\/\/git-lfs\.github\.com\/spec\/v1/.test(buf.subarray(0, 200).toString('utf8'));

// ---------------------------------------------------------------- 下载

async function pool(items, limit, worker) {
  let i = 0;
  const out = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try { out[idx] = { ok: true, value: await worker(items[idx], idx) }; }
      catch (e) { out[idx] = { ok: false, error: e.message, item: items[idx] }; }
    }
  }));
  return out;
}

async function cmdDown() {
  const files = await listRepo();
  const audio = files.filter((f) => f.kind === 'audio');
  const text = files.filter((f) => f.kind !== 'audio');

  console.log('');
  console.log(`仓库共 ${files.length} 个文件：音频 ${audio.length}、原文 ${files.filter((f) => f.kind === 'transcript').length}、`
    + `时间轴 ${files.filter((f) => f.kind === 'lrc').length}、题干 ${files.filter((f) => f.kind === 'stem').length}、`
    + `答案 ${files.filter((f) => f.kind === 'answer').length}`);
  console.log(`输出：${RAW_DIR}`);
  console.log('');

  fs.mkdirSync(RAW_DIR, { recursive: true });

  // 文本很小，先下（快），音频并发 4
  let okText = 0, skipText = 0;
  for (const f of text) {
    const dest = path.join(RAW_DIR, f.path);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) { skipText++; continue; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      const buf = toUtf8(await download(urlFor(f.path), { timeoutMs: 120000 }));
      fs.writeFileSync(dest, buf);
      okText++;
    } catch (e) {
      console.log(`  ✗ ${f.path} :: ${e.message.split('::').pop().trim()}`);
    }
  }
  console.log(`文本文件：下载 ${okText}，已存在跳过 ${skipText}`);

  console.log('');
  console.log('开始下载音频（Git LFS，约 700 MB，请耐心等待）…');
  let done = 0, bytes = 0, lfsHit = 0, fail = 0;
  const results = await pool(audio, 4, async (f) => {
    const dest = path.join(RAW_DIR, f.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) {
      const sz = fs.statSync(dest).size;
      if (sz > 100000) { done++; bytes += sz; console.log(`  · 已存在 ${(sz / 1048576).toFixed(1)} MB  ${f.path}`); return sz; }
    }
    const buf = await download(urlFor(f.path), { timeoutMs: 900000 });
    if (isLfsPointer(buf)) throw new Error('拿到 LFS 指针（说明用了 raw 域名）');
    fs.writeFileSync(dest, buf);
    done++; bytes += buf.length;
    console.log(`  ✓ ${String(done).padStart(2)}/${audio.length}  ${(buf.length / 1048576).toFixed(1).padStart(5)} MB  ${f.path}`);
    return buf.length;
  });

  for (const r of results) {
    if (!r.ok) {
      if (/LFS 指针/.test(r.error)) lfsHit++; else fail++;
      console.log(`  ✗ ${r.item.path} :: ${r.error}`);
    }
  }

  console.log('');
  console.log('─'.repeat(60));
  console.log(`音频完成 ${done}/${audio.length}，合计 ${(bytes / 1048576).toFixed(0)} MB`
    + (lfsHit ? `，LFS 指针 ${lfsHit}` : '') + (fail ? `，失败 ${fail}` : ''));
  console.log('');
}

// ---------------------------------------------------------------- 生成资料包

/** 从题干文件解析题目（只有选项，没有题干——四六级的提问是录音念的） */
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

    if (cur && cur.options.length) {
      cur.options[cur.options.length - 1] += ' ' + line.trim();
    } else if (cur) {
      cur.stem = (cur.stem + ' ' + line.trim()).trim();
    }
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

function lrcTime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
}

function readUtf8(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
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

function setLabel(set) {
  // CET6_2017.12 -> 2017年12月
  const m = /CET6_(\d{4})\.(\d{2})/.exec(set);
  return m ? `${m[1]}年${Number(m[2])}月` : set;
}

function fileLabel(name) {
  if (/set(\d)/i.test(name)) return `第${/set(\d)/i.exec(name)[1]}套`;
  if (/第([一二三四五])套/.test(name)) return `第${/第([一二三四五])套/.exec(name)[1]}套`;
  return path.basename(name, path.extname(name));
}

async function cmdBuild() {
  if (!fs.existsSync(RAW_DIR)) {
    console.error('还没下载，先运行：node tools/fetch-cet6-full.js down');
    process.exit(1);
  }

  const { mediaDuration } = require('./media-duration.js');
  const { calibrateDoc, parseLrcWords, tokenize, lcsAlign } = require('./calibrate-questions.js');

  // 收集每个音频对应的附属文件
  const sets = fs.readdirSync(RAW_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('CET6_'))
    .map((d) => d.name).sort();

  fs.mkdirSync(OUT_DIR, { recursive: true });

  let made = 0, totalQ = 0, calOK = 0, calFail = 0, withLrc = 0;

  for (const set of sets) {
    const dir = path.join(RAW_DIR, set);
    const files = fs.readdirSync(dir);

    const audios = files.filter((f) => /\.(mp3|m4a)$/i.test(f));
    const transcripts = files.filter((f) => /transcript\.md$/i.test(f));
    const stems = files.filter((f) => /q_stem\.txt$/i.test(f));
    const answers = files.filter((f) => /q_answer\.txt$/i.test(f));
    const lrcs = files.filter((f) => /\.lrc$/i.test(f));

    if (!audios.length) continue;

    for (const audioName of audios) {
      const label = fileLabel(audioName);

      // 找这一套对应的题干/答案/原文（文件名里通常带 set1/set2）
      const setMatch = /set(\d)/i.exec(audioName);
      const pick = (arr) => {
        if (setMatch) {
          const hit = arr.find((f) => new RegExp(`set${setMatch[1]}`, 'i').test(f));
          if (hit) return hit;
        }
        return arr[0];
      };

      const stemFile = pick(stems);
      const ansFile = pick(answers);
      const trFile = pick(transcripts);
      const lrcFile = lrcs.length === 1 ? lrcs[0] : (setMatch ? lrcs.find((f) => new RegExp(`第${['一', '二', '三'][Number(setMatch[1]) - 1]}套`).test(f)) : null);

      const title = `六级真题 · ${setLabel(set)} ${label}`;
      const base = `${setLabel(set).replace(/[年月]/g, '.')}-${label}`.replace(/\.$/, '');
      const outBase = path.join(OUT_DIR, base);

      // 音频：直接复制
      const srcAudio = path.join(dir, audioName);
      const destAudio = `${outBase}${path.extname(audioName)}`;
      if (!fs.existsSync(destAudio)) fs.copyFileSync(srcAudio, destAudio);

      const dur = mediaDuration(destAudio);

      // 时间轴：有就用真实的，没有就放一个章节标记（避免空面板）
      let lrcLines = [];
      let lrcSource = '无';
      if (lrcFile) {
        lrcLines = parseLrcLines(readUtf8(path.join(dir, lrcFile)));
        if (lrcLines.length) { lrcSource = '真实（仓库自带 LRC）'; withLrc++; }
      }
      if (!lrcLines.length) {
        // 没有时间轴时，至少给一行，让原文面板不是空白
        lrcLines = [];
      }

      // 题目
      let questions = [];
      if (stemFile) {
        const parsed = parseStem(readUtf8(path.join(dir, stemFile)));
        const ansMap = ansFile ? parseAnswers(readUtf8(path.join(dir, ansFile))) : new Map();
        const refMap = trFile ? parseRefs(readUtf8(path.join(dir, trFile))) : new Map();
        questions = parsed.map((q) => ({
          number: q.number,
          tag: '',
          stem: q.stem || '',
          options: q.options,
          answer: ansMap.get(q.number) || '',
          explain: '',
          start: null,
          end: null,
          transcript: refMap.get(q.number) || '',
        }));
      }

      // 用真实 LRC 校准题目时间
      if (lrcLines.length >= 2 && questions.length) {
        const lrcText = readUtf8(path.join(dir, lrcFile));
        const words = parseLrcWords(lrcText);
        const srcTokens = tokenize(lrcLines.map((l) => l.text).join(' '));
        const mapA = lcsAlign(srcTokens, words.map((w) => w.text));
        const res = calibrateDoc({ questions }, words, srcTokens, mapA, { pad: 0.4, minScore: 0.6 });
        for (const r of res) { if (r.status === 'calibrated') calOK++; else calFail++; }
      }

      // 写文件
      const lrcBody = [
        `[ti:${title}]`,
        '[by:listening-player fetch-cet6-full]',
        lrcSource === '无' ? '[re:该套无时间轴，原文请在「原文」抽屉查看]' : `[re:${lrcSource}]`,
        `[length:${lrcTime(dur)}]`,
        ...lrcLines.map((l) => `[${lrcTime(l.time)}]${l.text}`),
      ].join('\n') + '\n';
      fs.writeFileSync(`${outBase}.lrc`, lrcBody, 'utf8');

      // 原文：用 transcript.md（去掉 markdown 标题符号）
      const tr = trFile ? readUtf8(path.join(dir, trFile)) : '';
      const plain = tr.replace(/^#+\s*/gm, '').replace(/\n{3,}/g, '\n\n').trim();
      fs.writeFileSync(`${outBase}.txt`, plain || '（该套没有原文文件）\n', 'utf8');

      const qDoc = {
        title, exam: 'cet6', section: '', paper: `${setLabel(set)} ${label}`,
        source: 'Ysoseri1224/CET-6-Listening-10-Years-Resources-and-Analysis（Zenodo 收录）',
        license: '上传者声明 CC BY 4.0（非考试委员会声明）',
        sourceUrl: ZENODO,
        questions,
      };
      fs.writeFileSync(`${outBase}.questions.json`, JSON.stringify(qDoc, null, 2), 'utf8');

      const meta = {
        title, exam: 'cet6', section: '', paper: `${setLabel(set)} ${label}`, year: setLabel(set).slice(0, 4),
        source: 'Ysoseri1224/CET-6-Listening-10-Years-Resources-and-Analysis',
        license: '上传者声明 CC BY 4.0（非考试委员会声明；个人学习可用，公开分发请自行判断）',
        sourceUrl: ZENODO,
        duration: dur,
        notes: `时间轴：${lrcSource}。`
          + (questions.length ? `题目 ${questions.length} 道（题干为录音念出，故题干字段为空，选项与答案来自仓库文件）。` : '')
          + (lrcSource === '无' ? '本套无时间轴，歌词面板不会滚动；原文可在「原文」抽屉阅读。' : ''),
        importedAt: new Date().toISOString().slice(0, 10),
        generator: 'tools/fetch-cet6-full.js',
      };
      fs.writeFileSync(`${outBase}.meta.json`, JSON.stringify(meta, null, 2), 'utf8');

      made++; totalQ += questions.length;
      console.log(`  ✓ ${base}  音频 ${(fs.statSync(destAudio).size / 1048576).toFixed(1)} MB  ${dur.toFixed(0)}s  `
        + `时间轴 ${lrcLines.length} 行(${lrcSource})  题 ${questions.length}`);
    }
  }

  console.log('');
  console.log('─'.repeat(60));
  console.log(`生成 ${made} 个课程，题目合计 ${totalQ} 道`);
  console.log(`带真实时间轴的：${withLrc} 个；题目时间校准成功 ${calOK}，跳过 ${calFail}`);
  console.log(`输出目录：${OUT_DIR}`);
  console.log('');
}

// ---------------------------------------------------------------- main

async function main() {
  const cmd = process.argv[2] || 'list';

  if (cmd === 'list') {
    const files = await listRepo();
    const sets = [...new Set(files.map((f) => f.set))].sort();
    console.log('');
    console.log(`共 ${sets.length} 个考次，${files.length} 个文件：`);
    console.log('');
    console.log('考次'.padEnd(18) + '音频  原文  时间轴  题干  答案');
    console.log('-'.repeat(48));
    for (const s of sets) {
      const g = files.filter((f) => f.set === s);
      const c = (k) => g.filter((f) => f.kind === k).length;
      console.log(s.padEnd(18) + String(c('audio')).padStart(4) + String(c('transcript')).padStart(6)
        + String(c('lrc')).padStart(8) + String(c('stem')).padStart(6) + String(c('answer')).padStart(6));
    }
    console.log('-'.repeat(48));
    const a = files.filter((f) => f.kind === 'audio').length;
    console.log(`音频 ${a} 个（Git LFS，合计约 700 MB）`);
    console.log('');
    return;
  }

  if (cmd === 'down' || cmd === 'all') await cmdDown();
  if (cmd === 'build' || cmd === 'all') await cmdBuild();
}

if (require.main === module) {
  main().catch((e) => { console.error('[error] ' + e.message); process.exit(1); });
}

module.exports = { listRepo, urlFor, toUtf8, parseStem, parseAnswers, parseRefs };

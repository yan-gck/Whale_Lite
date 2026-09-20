#!/usr/bin/env node
/**
 * cert6-timings.js — 下载 cet-listening 的句级时间戳，按【字节数】配对到已下载的六级音频
 *
 * 为什么必须按字节数配对：
 *   时间戳是对着某一份具体录音生成的。同名不同源的音频（比如"2017年12月第1套"）
 *   在不同仓库里其实是不同录音，时间轴套上去会整体漂移。
 *   timings.json 里的 source.audio.size 就是生成时所用音频的字节数 —— 这是一个可靠的指纹。
 *
 * 来源：3056810551/cet-listening（MIT）
 *   37 份 transcripts/cet6/*.timings.json，含句级 start/end（秒）+ 中文译文
 *   仓库本身不含音频（audio/ 被 .gitignore）
 *
 * 用法：
 *   node tools/cet6-timings.js fetch          下载全部 timings.json
 *   node tools/cet6-timings.js match          把时间戳配对到 audio/CET6-真题 里的音频
 *   node tools/cet6-timings.js all            fetch + match
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RAW_DIR = path.join(ROOT, 'audio', '_cet6-raw');
const TIMINGS_DIR = path.join(ROOT, 'audio', '_timings');
const LESSON_DIR = path.join(ROOT, 'audio', 'CET6-真题');

const REPO = '3056810551/cet-listening';
const BRANCH = 'main';

const { download } = require('./fetch-resources.js');

function lrcTime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
}

// ---------------------------------------------------------------- 下载

async function cmdFetch() {
  const treeRaw = await download(`https://api.github.com/repos/${REPO}/git/trees/HEAD?recursive=1`,
    { expectBinary: false, timeoutMs: 120000 });
  const tree = JSON.parse(treeRaw).tree.filter((x) => x.type === 'blob');
  const files = tree.filter((f) => /timings\.json$/.test(f.path)).map((f) => f.path).sort();

  console.log('');
  console.log(`仓库里共 ${files.length} 份 timings.json`);
  fs.mkdirSync(TIMINGS_DIR, { recursive: true });

  let ok = 0, skip = 0;
  for (const p of files) {
    const dest = path.join(TIMINGS_DIR, path.basename(p));
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) { skip++; continue; }
    const url = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${p.split('/').map(encodeURIComponent).join('/')}`;
    try {
      const buf = await download(url, { timeoutMs: 120000 });
      fs.writeFileSync(dest, buf);
      ok++;
      process.stdout.write(`\r  下载 ${ok + skip}/${files.length} …`);
    } catch (e) {
      console.log(`\n  ✗ ${p} :: ${e.message.split('::').pop().trim()}`);
    }
  }
  console.log(`\r  完成：下载 ${ok}，已存在 ${skip}          `);
  console.log('');
}

// ---------------------------------------------------------------- 配对

function loadTimings() {
  if (!fs.existsSync(TIMINGS_DIR)) return [];
  return fs.readdirSync(TIMINGS_DIR)
    .filter((f) => f.endsWith('.timings.json'))
    .map((f) => {
      const full = path.join(TIMINGS_DIR, f);
      try {
        const doc = JSON.parse(fs.readFileSync(full, 'utf8'));
        const size = doc.source && doc.source.audio ? Number(doc.source.audio.size) : 0;
        const audioName = doc.source && doc.source.audio ? doc.source.audio.name : '';
        return { file: full, key: f.replace('.timings.json', ''), doc, size, audioName };
      } catch { return null; }
    })
    .filter(Boolean);
}

/** 列出所有候选音频（含原始下载目录与已生成的课程目录） */
function listAudio() {
  const out = [];
  for (const dir of [RAW_DIR, LESSON_DIR]) {
    if (!fs.existsSync(dir)) continue;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (e.isFile() && /\.(mp3|m4a)$/i.test(e.name)) {
          out.push({ path: full, size: fs.statSync(full).size, name: e.name, dir: path.basename(d) });
        }
      }
    };
    walk(dir);
  }
  return out;
}

async function cmdMatch() {
  const timings = loadTimings();
  if (!timings.length) {
    console.error('还没有 timings 文件，先运行：node tools/cet6-timings.js fetch');
    process.exit(1);
  }

  const audios = listAudio();
  console.log('');
  console.log(`时间戳 ${timings.length} 份，候选音频 ${audios.length} 个`);
  console.log('按字节数配对（这是判断"是不是同一份录音"的唯一可靠依据）');
  console.log('');
  console.log('时间戳'.padEnd(14) + '需要字节数'.padStart(12) + '  配到的音频');
  console.log('-'.repeat(78));

  const matched = [];
  const unmatched = [];

  for (const t of timings.sort((a, b) => a.key.localeCompare(b.key))) {
    const hit = audios.find((a) => a.size === t.size);
    if (hit) {
      matched.push({ ...t, audio: hit });
      console.log(t.key.padEnd(14) + String(t.size).padStart(12) + '  ✓ ' + path.relative(ROOT, hit.path));
    } else {
      unmatched.push(t);
      console.log(t.key.padEnd(14) + String(t.size).padStart(12) + '  ✗ 没有字节数一致的音频');
    }
  }

  console.log('-'.repeat(78));
  console.log(`配对成功 ${matched.length} / ${timings.length}`);
  console.log('');

  if (!matched.length) {
    console.log('一个都没配上。这说明现有音频与时间戳不是同一批录音。');
    console.log('可以手动核对：下面列出每份时间戳的期望文件名与字节数，你去找对应音频。');
    console.log('');
    for (const t of unmatched.slice(0, 40)) {
      console.log(`  ${t.key.padEnd(14)} 期望 ${t.audioName || '(未记录)'}  ${t.size} 字节`);
    }
    return;
  }

  // 把配对结果写成映射表，供应用步骤使用
  const map = matched.map((m) => ({
    timings: path.relative(ROOT, m.file),
    key: m.key,
    audio: path.relative(ROOT, m.audio.path),
    bytes: m.size,
    duration: m.doc.duration,
    lines: (m.doc.lines || []).length,
    translation: (m.doc.lines || []).filter((l) => l.translation).length,
  }));
  fs.writeFileSync(path.join(ROOT, 'audio', '_timings-map.json'), JSON.stringify(map, null, 2), 'utf8');
  console.log(`映射表已写出 audio/_timings-map.json（${map.length} 条）`);
  console.log('');

  if (unmatched.length) {
    console.log(`未配上的 ${unmatched.length} 份（需要你自己去找对应录音）：`);
    for (const t of unmatched) {
      console.log(`  ${t.key.padEnd(14)} 期望 ${t.audioName || '(未记录)'}  ${t.size} 字节`);
    }
    console.log('');
  }
}

// ---------------------------------------------------------------- apply

/**
 * 把配对好的时间戳写成 LRC + 译文 + 原文，覆盖对应课程的时间轴。
 * 这是质量最好的一种：句级时间戳 + 中文译文。
 */
async function cmdApply() {
  const mapPath = path.join(ROOT, 'audio', '_timings-map.json');
  if (!fs.existsSync(mapPath)) {
    console.error('还没有映射表，先运行：node tools/cet6-timings.js match');
    process.exit(1);
  }
  const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));

  console.log('');
  let done = 0;

  for (const m of map) {
    const doc = JSON.parse(fs.readFileSync(path.join(ROOT, m.timings), 'utf8'));
    const audioAbs = path.join(ROOT, m.audio);
    const base = audioAbs.slice(0, audioAbs.length - path.extname(audioAbs).length);

    const lines = (doc.lines || []).filter((l) => l.start != null && String(l.text || '').trim());
    if (!lines.length) continue;

    // LRC：句级时间戳，保留说话人
    const lrc = [
      `[ti:六级真题 · ${m.key}]`,
      '[by:cet-listening timings.json（faster-whisper 句级时间戳）]',
      '[re:句级时间戳 + 中文译文，非逐词]',
      `[length:${lrcTime(doc.duration)}]`,
      ...lines.map((l) => {
        const sp = l.speaker && l.speaker !== 'narrator' ? `${l.speaker} ` : '';
        return `[${lrcTime(l.start)}]${sp}${String(l.text).replace(/\s+/g, ' ').trim()}`;
      }),
    ].join('\n') + '\n';
    fs.writeFileSync(`${base}.lrc`, lrc, 'utf8');

    // 译文（供「显示模式」切换）
    const tr = [
      `[ti:六级真题 · ${m.key} · 译文]`,
      ...lines.filter((l) => l.translation).map((l) => `[${lrcTime(l.start)}]${String(l.translation).replace(/\s+/g, ' ').trim()}`),
    ].join('\n') + '\n';
    fs.writeFileSync(`${base}.translation.lrc`, tr, 'utf8');

    // 原文（英文 + 中文对照）
    const txt = [];
    let lastSection = null;
    for (const l of lines) {
      if (l.sectionTitle && l.sectionTitle !== lastSection) {
        txt.push(`\n=== ${l.sectionTitle} ===\n`);
        lastSection = l.sectionTitle;
      }
      const sp = l.speaker && l.speaker !== 'narrator' ? `${l.speaker} ` : '';
      txt.push(`${sp}${String(l.text).trim()}`);
      if (l.translation) txt.push(`    ${String(l.translation).trim()}`);
    }
    fs.writeFileSync(`${base}.txt`, txt.join('\n') + '\n', 'utf8');

    // meta：更新说明
    const mp = `${base}.meta.json`;
    if (fs.existsSync(mp)) {
      try {
        const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
        meta.notes = `句级时间戳 + 中文译文，来自 3056810551/cet-listening（MIT，faster-whisper 生成）。`
          + `已按音频字节数 ${m.bytes} 校验为同一份录音。原文 ${lines.length} 行。`;
        meta.source += ' ／ 时间戳 3056810551/cet-listening（MIT）';
        meta.hasTranslation = true;
        fs.writeFileSync(mp, JSON.stringify(meta, null, 2), 'utf8');
      } catch { /* 忽略 */ }
    }

    // 题目时间校准
    const qp = `${base}.questions.json`;
    if (fs.existsSync(qp) && fs.existsSync(`${base}.lrc`)) {
      try {
        const { calibrateDoc, parseLrcWords, tokenize, lcsAlign } = require('./calibrate-questions.js');
        const qDoc = JSON.parse(fs.readFileSync(qp, 'utf8'));
        const words = parseLrcWords(fs.readFileSync(`${base}.lrc`, 'utf8'));
        const srcTokens = tokenize(lines.map((l) => l.text).join(' '));
        const mapA = lcsAlign(srcTokens, words.map((w) => w.text));
        const res = calibrateDoc(qDoc, words, srcTokens, mapA, { pad: 0.4, minScore: 0.6 });
        const okN = res.filter((r) => r.status === 'calibrated').length;
        fs.writeFileSync(qp, JSON.stringify(qDoc, null, 2), 'utf8');
        console.log(`  ✓ ${m.key}  句级 ${lines.length} 行  译文 ${lines.filter((l) => l.translation).length} 行  题目校准 ${okN}`);
      } catch (e) {
        console.log(`  ✓ ${m.key}  句级 ${lines.length} 行（题目校准失败：${e.message}）`);
      }
    } else {
      console.log(`  ✓ ${m.key}  句级 ${lines.length} 行`);
    }
    done++;
  }

  console.log('');
  console.log(`完成 ${done} 个课程的时间轴升级`);
  console.log('');
}

// ---------------------------------------------------------------- main

async function main() {
  const cmd = process.argv[2] || 'all';
  if (cmd === 'fetch' || cmd === 'all') await cmdFetch();
  if (cmd === 'match' || cmd === 'all') await cmdMatch();
  if (cmd === 'apply') await cmdApply();
  if (!['fetch', 'match', 'apply', 'all'].includes(cmd)) {
    console.log(`用法：
  node tools/cet6-timings.js fetch    下载全部 timings.json
  node tools/cet6-timings.js match    按字节数配对到已下载音频
  node tools/cet6-timings.js apply    把配对好的时间戳写入课程（句级 + 中文译文）
  node tools/cet6-timings.js all      fetch + match`);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('[error] ' + e.message); process.exit(1); });
}

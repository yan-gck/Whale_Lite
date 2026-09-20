#!/usr/bin/env node
/**
 * fetch-resources.js — 下载可合法使用的开放听力资源，并直接生成本播放器的资料包
 *
 * 只收录许可明确允许再分发（公有领域 / CC BY / CC BY 4.0）的来源。
 * 每个来源的实测可达性与许可原文见 docs/resources.md。
 *
 * 子命令：
 *   node tools/fetch-resources.js list                  列出所有可用来源与用途
 *   node tools/fetch-resources.js amenglish  [--limit=N] 美国国务院 Everyday Conversations（公有领域，对话+文本）
 *   node tools/fetch-resources.js librivox   [--id=...]  LibriVox 有声书（音频与文本双公有领域）
 *   node tools/fetch-resources.js librispeech[--limit=N] LibriSpeech 句子精听（CC BY 4.0）
 *   node tools/fetch-resources.js voa        [--limit=N] VOA Learning English（美国政府公有领域）
 *   node tools/fetch-resources.js all        [--limit=N] 以上全部
 *
 * 通用选项：
 *   --out=<目录>   输出根目录，默认 audio/
 *   --force        覆盖已存在文件
 *   --dry-run      只显示将要下载什么，不真正下载
 *
 * 只依赖 Node 内置模块（fetch 需要 Node 18+）。
 */

'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');

const ROOT = path.resolve(__dirname, '..');

// 本工具只收录"许可明确允许再分发"的来源，用途与出处在界面上可见
const UA = 'listening-player/1.0 (educational; offline listening practice)';

// ---------------------------------------------------------------- 工具

function arg(name, def) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return def;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
}

const OUT_ROOT = path.resolve(String(arg('out', path.join(ROOT, 'audio'))));
const FORCE = Boolean(arg('force', false));
const DRY = Boolean(arg('dry-run', false));

function log(...a) { console.log(...a); }
function ok(...a) { console.log('  ✓', ...a); }
function warn(...a) { console.log('  ⚠', ...a); }

/**
 * 探测代理。
 *
 * 为什么必须处理：
 *   Windows 上「Internet 选项」里的代理（如 Clash 的 127.0.0.1:7897）会被
 *   PowerShell / .NET 自动使用，但 Node 的 http/https/fetch 默认【不读】系统代理。
 *   于是出现"PowerShell 能下载、Node 报 connect ETIMEDOUT"的诡异现象
 *   （实测 archive.org 直连拿到的是污染 IP）。
 *
 * 优先级：环境变量 > Windows 系统代理 > 直连
 */
function detectProxy() {
  for (const v of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    const val = process.env[v];
    if (val) { try { return new URL(val); } catch { /* 忽略非法值 */ } }
  }

  if (process.platform === 'win32') {
    try {
      const { execFileSync } = require('node:child_process');
      const out = execFileSync('reg', [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v', 'ProxyServer',
      ], { encoding: 'utf8', windowsHide: true });
      const m = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(out);
      if (m) {
        const raw = m[1].trim();
        // 可能是 "127.0.0.1:7897"，也可能是 "http=host:port;https=host:port"
        const httpsPart = /https=([^;]+)/i.exec(raw);
        const candidate = httpsPart ? httpsPart[1] : raw;
        return new URL(candidate.includes('://') ? candidate : `http://${candidate}`);
      }
    } catch { /* 没有代理或读取失败，走直连 */ }
  }
  return null;
}

const PROXY = detectProxy();

function requestOnce(url, { timeoutMs, method = 'GET', redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(url); } catch (e) { return reject(e); }

    const isHttps = target.protocol === 'https:';

    const onResponse = (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, target).toString();
        return resolve(requestOnce(next, { timeoutMs, method, redirects: redirects - 1 }));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    };

    const bail = (req) => {
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`超时（${Math.round(timeoutMs / 1000)}s）`)));
      req.on('error', reject);
      req.end();
    };

    // 走代理：HTTPS 需要先 CONNECT 建隧道
    if (PROXY && isHttps) {
      const connectReq = http.request({
        host: PROXY.hostname,
        port: PROXY.port || 80,
        method: 'CONNECT',
        path: `${target.hostname}:${target.port || 443}`,
        headers: { Host: `${target.hostname}:${target.port || 443}`, 'User-Agent': UA },
        agent: false,
      });
      connectReq.setTimeout(timeoutMs, () => connectReq.destroy(new Error('代理连接超时')));
      connectReq.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          return reject(new Error(`代理 CONNECT 失败：HTTP ${res.statusCode}`));
        }
        const req = https.request({
          socket,
          agent: false,
          servername: target.hostname,
          path: target.pathname + target.search,
          method,
          headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Encoding': 'identity', Host: target.hostname },
        }, onResponse);
        bail(req);
      });
      connectReq.on('error', reject);
      connectReq.end();
      return;
    }

    // 直连（HTTP 走代理时用完整 URL 作为 path）
    const mod = isHttps ? https : http;
    const useProxyForHttp = PROXY && !isHttps;
    const req = mod.request({
      hostname: useProxyForHttp ? PROXY.hostname : target.hostname,
      port: useProxyForHttp ? (PROXY.port || 80) : (target.port || undefined),
      path: useProxyForHttp ? target.toString() : target.pathname + target.search,
      method,
      headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Encoding': 'identity' },
      agent: false,
    }, onResponse);
    bail(req);
  });
}

/** 带重试的下载，返回 Buffer */
async function download(url, { tries = 3, timeoutMs = 300000, expectBinary = true } = {}) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const buf = await requestOnce(url, { timeoutMs });
      return expectBinary ? buf : buf.toString('utf8');
    } catch (err) {
      lastErr = err;
      // 4xx 是永久性错误（URL 拼错、资源不存在），重试没有意义，
      // 否则会像之前那样刷出几百行无用的重试日志。
      if (/^HTTP 4\d\d/.test(err.message)) break;
      if (i < tries) {
        process.stdout.write(`    · 第 ${i} 次失败（${err.message}），重试…\n`);
        await new Promise((r) => setTimeout(r, 1500 * i));
      }
    }
  }
  throw new Error(`下载失败 ${url} :: ${lastErr && lastErr.message}`);
}

/** 并发映射，限制并发数，避免把对方服务器打爆 */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try {
        results[idx] = { ok: true, value: await worker(items[idx], idx) };
      } catch (err) {
        results[idx] = { ok: false, error: err.message };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

function ensureDir(dir) {
  if (!DRY) fs.mkdirSync(dir, { recursive: true });
}

function writeIfChanged(file, buf) {
  if (DRY) return;
  fs.writeFileSync(file, buf);
}

function safeName(s) {
  return String(s).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function lrcTime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
}

/** 写出一个完整资料包（音频 + lrc + txt + meta，可选 questions） */
function writePack(dir, baseName, { audioBuf, audioExt, lines, text, meta, questions }) {
  ensureDir(dir);

  const audioFile = path.join(dir, `${baseName}${audioExt}`);
  const existed = fs.existsSync(audioFile);
  if (!existed || FORCE) writeIfChanged(audioFile, audioBuf);

  // LRC
  const lrc = [`[ti:${meta.title}]`, '[by:listening-player fetch-resources]', `[length:${lrcTime(meta.duration)}]`]
    .concat((lines || []).map((l) => `[${lrcTime(l.time)}]${l.text}`))
    .join('\n') + '\n';
  writeIfChanged(path.join(dir, `${baseName}.lrc`), lrc);

  // 原文
  if (text) writeIfChanged(path.join(dir, `${baseName}.txt`), text.endsWith('\n') ? text : text + '\n');

  // 题目
  if (questions && questions.length) {
    writeIfChanged(
      path.join(dir, `${baseName}.questions.json`),
      JSON.stringify({ ...meta, questions }, null, 2),
    );
  }

  // 元信息
  writeIfChanged(path.join(dir, `${baseName}.meta.json`), JSON.stringify(meta, null, 2));

  return { audioFile, bytes: audioBuf ? audioBuf.length : 0, existed };
}

// ---------------------------------------------------------------- 来源 1：American English

/**
 * 美国国务院 Everyday Conversations：30 段对话，公有领域。
 * 文本来自同页提供的 PDF；PDF 文本抽取是"尽力而为"，失败则退回只给音频+标题。
 */
async function fetchAmEnglish() {
  const PAGE = 'https://americanenglish.state.gov/resources/everyday-conversations-learning-american-english';
  const limit = Number(arg('limit', 30)) || 30;

  log('\n【1】American English · Everyday Conversations（美国国务院，公有领域）');
  log('    来源页：' + PAGE);

  const html = await download(PAGE, { expectBinary: false });
  const mp3s = [...new Set([...html.matchAll(/https:\/\/americanenglish\.state\.gov\/files\/ae\/resource_files\/[^"'\s]+\.mp3/g)].map((m) => m[0]))];
  const pdfs = [...new Set([...html.matchAll(/https:\/\/americanenglish\.state\.gov\/files\/ae\/resource_files\/[^"'\s]+\.pdf/g)].map((m) => m[0]))];

  log(`    页面发现 ${mp3s.length} 个 MP3、${pdfs.length} 个 PDF`);
  if (!mp3s.length) { warn('没有发现音频，页面结构可能已变'); return { packs: 0, bytes: 0 }; }

  // 文本：尽力从同页 PDF 抽取（该 PDF 用子集化嵌入字体，必须走 ToUnicode 解码）
  const dir = path.join(OUT_ROOT, 'AmericanEnglish');
  let dialogues = [];
  let pdfNote = '原文见来源页 PDF：' + (pdfs[0] || '(未找到)');

  if (pdfs.length) {
    try {
      const { extractPdfText, splitDialogues } = require('./pdf-text.js');
      const tmp = path.join(OUT_ROOT, '.cache-ec.pdf');
      if (!DRY) {
        ensureDir(OUT_ROOT);
        fs.writeFileSync(tmp, await download(pdfs[0], { timeoutMs: 300000 }));
      }
      if (!DRY) {
        const res = await extractPdfText(tmp);
        // 抽取质量守门：同一段正文被标到多个编号，说明版面错位，宁可不用
        const raw = splitDialogues(res.text);
        const seen = new Map();
        dialogues = raw.filter((d) => {
          if (d.body.length < 120) return false;
          const key = d.body.slice(0, 80);
          if (seen.has(key)) return false;
          seen.set(key, true);
          return true;
        });
        ok(`PDF 文本抽取成功：${res.totalPages} 页，匹配到 ${dialogues.length}/${raw.length} 段对话`);
        if (dialogues.length < raw.length) {
          warn('部分对话因版面错位或重复被剔除，这些包只给音频与标题（原文仍在 PDF 里）');
        }
      }
      if (!DRY && fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch (err) {
      warn('PDF 文本抽取失败（不影响音频下载）：' + err.message);
    }
  }

  const chosen = mp3s.slice(0, limit);
  let bytes = 0, packs = 0;

  const results = await pool(chosen, 3, async (url) => {
    const file = decodeURIComponent(url.split('/').pop());
    const base = safeName(file.replace(/\.mp3$/i, ''));
    const audio = await download(url, { timeoutMs: 180000 });

    // dialogue_1-01_formal_greetings → 编号 1-1，便于与 PDF 里的 "Dialogue 1-1" 对上
    const m = /^dialogue_(\d+)-(\d+)_(.*)$/i.exec(base);
    const num = m ? `${Number(m[1])}-${Number(m[2])}` : '';
    const slug = m ? m[3] : base;
    // 先把下划线换成空格再做首字母大写，否则 \b\w 匹配不到
    // 下划线两侧的字母，标题会变成 "FormalGreetings"
    const pretty = slug.replace(/_/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase());

    const hit = dialogues.find((d) => d.num === num);
    const text = hit
      ? `Dialogue ${num}: ${hit.title}\n\n${hit.body}`
      : `Dialogue ${num}: ${pretty}\n\n${pdfNote}`;

    const meta = {
      title: `美式英语对话 · ${num ? num + ' ' : ''}${hit ? hit.title : pretty}`,
      exam: 'other',
      section: 'Everyday Conversations',
      source: 'American English, U.S. Department of State（美国政府作品，公有领域）',
      license: 'Public Domain（美国国务院网站内容，除单独标注版权者）',
      sourceUrl: PAGE,
      duration: 0,
      notes: '公有领域日常对话，适合精听与跟读。'
        + (hit ? '原文由同页 PDF 自动抽取。' : '未抽取到对应原文，请见来源页 PDF。'),
      importedAt: new Date().toISOString().slice(0, 10),
      generator: 'tools/fetch-resources.js amenglish',
    };

    writePack(dir, base, {
      audioBuf: audio,
      audioExt: '.mp3',
      lines: [],   // 无时间戳：整段就是一个完整对话
      text,
      meta,
    });
    return audio.length;
  });

  for (const r of results) {
    if (r.ok) { bytes += r.value; packs++; }
    else warn(r.error);
  }
  ok(`下载完成：${packs} 个对话，共 ${(bytes / 1048576).toFixed(1)} MB`);
  return { packs, bytes };
}

// ---------------------------------------------------------------- 来源 2：LibriVox

/**
 * LibriVox：音频公有领域。
 * 用 archive.org 的元数据接口取每章 MP3 与时长，拼出章节级时间轴；
 * 原文用 archive.org 的 OCR 全文（_djvu.txt，同为公有领域）。
 */
async function fetchLibriVox() {
  const id = String(arg('id', 'the_adventures_of_sherlock_holmes_v5_1904_librivox'));
  const maxChapters = Number(arg('limit', 4)) || 4;

  log('\n【2】LibriVox · 公有领域有声书');
  log('    archive.org id：' + id);

  const meta = await (async () => {
    const t = await download(`https://archive.org/metadata/${id}`, { expectBinary: false });
    return JSON.parse(t);
  })();

  const license = (meta.metadata && meta.metadata.licenseurl) || '(未标注)';
  log('    许可：' + license);
  log('    标题：' + ((meta.metadata && (meta.metadata.title || meta.metadata.identifier)) || id));

  // 选 64kbps MP3（体积与音质平衡），按章节序号排序
  const mp3s = (meta.files || [])
    .filter((f) => /_64kb\.mp3$/i.test(f.name))
    .map((f) => ({ name: f.name, length: f.length, title: f.title || '' }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!mp3s.length) { warn('该条目没有 64kbps MP3'); return { packs: 0, bytes: 0 }; }

  log(`    发现 ${mp3s.length} 章，本次取前 ${Math.min(maxChapters, mp3s.length)} 章`);

  // 全文（可选）。
  // ⚠️ 实测坑：LibriVox 条目的 _djvu.txt 常常【不是书的正文】，
  //    而只是 CD 封面 + 目录的 OCR 残片（有的仅 1 千多字符，还夹乱码）。
  //    所以这里加了长度守门：太短就不用，让调用方走 Project Gutenberg 取权威全文。
  let fullText = '';
  const djvu = (meta.files || []).find((f) => /_djvu\.txt$/i.test(f.name));
  if (djvu) {
    try {
      const t = await download(`https://archive.org/download/${id}/${encodeURIComponent(djvu.name)}`, { expectBinary: false });
      if (t.length >= 20000) {
        fullText = t;
        ok(`OCR 全文已获取（${t.length} 字符）`);
      } else {
        warn(`archive.org 的 _djvu.txt 只有 ${t.length} 字符，判断为封面/目录残片而非正文，已忽略。`);
        warn('需要正文请运行 node tools/fix-librivox-text.js 从 Project Gutenberg 取权威全文。');
      }
    } catch (err) { warn('OCR 全文获取失败：' + err.message); }
  }

  const dir = path.join(OUT_ROOT, 'LibriVox');
  let bytes = 0, packs = 0;

  for (const ch of mp3s.slice(0, maxChapters)) {
    try {
      const url = `https://archive.org/download/${id}/${encodeURIComponent(ch.name)}`;
      const audio = await download(url, { timeoutMs: 300000 });

      // "19:39" / "1:02:03" → 秒
      const toSec = (v) => {
        const p = String(v || '').split(':').map(Number);
        if (p.some((n) => !Number.isFinite(n))) return 0;
        return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : p[0];
      };
      const dur = toSec(ch.length);

      const base = safeName(ch.name.replace(/_64kb\.mp3$/i, ''));
      const pretty = (ch.title || base).replace(/_/g, ' ');

      const m = {
        title: `LibriVox · ${pretty}`,
        exam: 'other',
        section: ch.name.match(/_(\d+)_/)?.[1] ? `Chapter ${ch.name.match(/_(\d+)_/)[1]}` : '',
        source: `LibriVox / archive.org（${id}）`,
        license: 'Public Domain（LibriVox 录音全部为公有领域）',
        sourceUrl: `https://archive.org/details/${id}`,
        duration: dur,
        notes: '公有领域有声书，适合长时听力与泛听。章节级时间轴，章内无逐句时间戳。',
        importedAt: new Date().toISOString().slice(0, 10),
        generator: 'tools/fetch-resources.js librivox',
      };

      writePack(dir, base, {
        audioBuf: audio,
        audioExt: '.mp3',
        lines: [{ time: 0, text: `— ${pretty} —` }],   // 章节级：仅一个起点
        text: fullText ? `【本章：${pretty}】\n\n（本书 OCR 全文见下方，章内逐句时间戳需自行对齐）\n\n${fullText.slice(0, 200000)}` : '',
        meta: m,
      });

      bytes += audio.length; packs++;
      ok(`${pretty}  ${(audio.length / 1048576).toFixed(1)} MB  ${ch.length}`);
    } catch (err) {
      warn(`${ch.name} :: ${err.message}`);
    }
  }

  ok(`下载完成：${packs} 章，共 ${(bytes / 1048576).toFixed(1)} MB`);
  return { packs, bytes };
}

// ---------------------------------------------------------------- 来源 3：LibriSpeech

/**
 * LibriSpeech：CC BY 4.0，通过 HuggingFace 数据集行接口取"单句音频 + 逐字稿"。
 * 每个 clip 就是一句话，天生带对齐好的文本（句内无时间戳，但也不需要）。
 * 按说话人分组成"句子精听"包：一个包 = 一组相关句子，逐句一条 LRC。
 */
async function fetchLibriSpeech() {
  const want = Number(arg('limit', 120)) || 120;
  const perPack = 20;

  log('\n【3】LibriSpeech · 句子精听（CC BY 4.0）');
  log('    数据接口：datasets-server.huggingface.co（openslr/librispeech_asr, clean/validation）');

  const ROWS = 100;   // 该接口单次上限
  const rows = [];
  for (let off = 0; off < want; off += ROWS) {
    const n = Math.min(ROWS, want - off);
    const url = `https://datasets-server.huggingface.co/rows?dataset=openslr%2Flibrispeech_asr&config=clean&split=validation&offset=${off}&length=${n}`;
    const doc = JSON.parse(await download(url, { expectBinary: false, timeoutMs: 90000 }));
    rows.push(...(doc.rows || []).map((r) => r.row));
    if ((doc.rows || []).length < n) break;
  }
  log(`    取到 ${rows.length} 条样本`);
  if (!rows.length) { warn('没有取到样本'); return { packs: 0, bytes: 0 }; }

  const dir = path.join(OUT_ROOT, 'LibriSpeech-句子精听');
  ensureDir(dir);

  // 每条样单独成包：文件多但结构最简单、可逐句复读
  let bytes = 0, packs = 0;
  const results = await pool(rows, 4, async (row) => {
    const id = row.id;
    const text = String(row.text || '').trim();
    if (!text) throw new Error('空文本');

    // 注意：该接口的 audio 字段是【数组】，形如 [{src, type}]，
    // 直接读 row.audio.src 会得到 undefined，进而报 "Invalid URL"。
    const audioUrl = Array.isArray(row.audio) ? (row.audio[0] && row.audio[0].src) : (row.audio && row.audio.src);
    if (!audioUrl) throw new Error('没有音频地址');

    const audio = await download(audioUrl, { timeoutMs: 90000 });
    const base = safeName(id);
    const speaker = id.split('-')[0];

    const meta = {
      title: `LibriSpeech 句子精听 · ${id}`,
      exam: 'other',
      section: `说话人 ${speaker}`,
      source: 'LibriSpeech（OpenSLR SLR12，经 HuggingFace openslr/librispeech_asr）',
      license: 'CC BY 4.0',
      sourceUrl: 'https://www.openslr.org/12/',
      duration: 0,
      notes: 'CC BY 4.0 朗读语料，一句一包，适合听写、跟读与复读训练。',
      importedAt: new Date().toISOString().slice(0, 10),
      generator: 'tools/fetch-resources.js librispeech',
    };

    // 单句包：LRC 只有一行，起点 0，即可滚动显示该句
    writePack(dir, base, {
      audioBuf: audio,
      audioExt: '.flac',
      lines: [{ time: 0, text }],
      text,
      meta,
    });
    return audio.length;
  });

  for (const r of results) {
    if (r.ok) { bytes += r.value; packs++; }
    else warn(r.error);
  }
  ok(`下载完成：${packs} 个句子包，共 ${(bytes / 1048576).toFixed(1)} MB`);
  return { packs, bytes };
}

// ---------------------------------------------------------------- 来源 4：VOA

/**
 * VOA Learning English：美国政府作品，公有领域（须署名，且不得包含通讯社稿件）。
 * 播客页提供每日节目的 MP3 直链。注意：VOA 的逐篇文本在服务端取不到
 * （近期 /a/ 页面给非浏览器客户端返回统一 JS 外壳），因此这里只下载音频，
 * 文本留空并在 meta 里说明，避免写入不实信息。
 */
async function fetchVoa() {
  const limit = Number(arg('limit', 5)) || 5;
  const PAGE = 'https://learningenglish.voanews.com/podcast/?zoneId=1689';

  log('\n【4】VOA Learning English（美国政府作品，公有领域）');
  log('    播客页：' + PAGE);

  const html = await download(PAGE, { expectBinary: false, timeoutMs: 90000 });
  const urls = [...new Set([...html.matchAll(/<enclosure[^>]*url="([^"]+\.mp3)"[^>]*type="audio\/mpeg"/g)].map((m) => m[1]))];
  log(`    发现 ${urls.length} 个节目 MP3`);
  if (!urls.length) { warn('没有发现音频'); return { packs: 0, bytes: 0 }; }

  const dir = path.join(OUT_ROOT, 'VOA');
  let bytes = 0, packs = 0;

  for (const url of urls.slice(0, limit)) {
    try {
      const file = decodeURIComponent(url.split('/').pop());
      const audio = await download(url, { timeoutMs: 300000 });
      const base = safeName(file.replace(/_hq\.mp3$/i, ''));
      const date = (base.match(/(\d{8})/) || [])[1] || '';

      const meta = {
        title: `VOA Learning English · ${date ? date.slice(0, 4) + '-' + date.slice(4, 6) + '-' + date.slice(6) : base}`,
        exam: 'other',
        section: 'Learning English 每日节目',
        source: 'VOA Learning English（美国政府作品，公有领域）',
        license: 'Public Domain（须署名 learningenglish.voanews.com；通讯社稿件除外）',
        sourceUrl: 'https://learningenglish.voanews.com/p/6861.html',
        duration: 0,
        notes: '公有领域新闻英语，语速适中，适合泛听。VOA 未提供逐句时间戳，'
          + '且其文章正文无法在服务端抓取，故此处不含文本；'
          + '如需文本请在同名文章页复制后用 tools/import.js --text= 补充。',
        importedAt: new Date().toISOString().slice(0, 10),
        generator: 'tools/fetch-resources.js voa',
      };

      writePack(dir, base, {
        audioBuf: audio,
        audioExt: '.mp3',
        lines: [],
        text: '',
        meta,
      });

      bytes += audio.length; packs++;
      ok(`${meta.title}  ${(audio.length / 1048576).toFixed(1)} MB`);
    } catch (err) {
      warn(`${url} :: ${err.message}`);
    }
  }

  ok(`下载完成：${packs} 个节目，共 ${(bytes / 1048576).toFixed(1)} MB`);
  return { packs, bytes };
}

// ---------------------------------------------------------------- list & main

function listSources() {
  console.log(`
可下载的开放听力资源（全部为公有领域或开放许可，允许再分发）
────────────────────────────────────────────────────────────────
  amenglish    美国国务院 Everyday Conversations
               30 段日常对话 · 公有领域 · 对话+PDF 文本

  librivox     LibriVox / archive.org 有声书
               音频与文本双公有领域 · 章节级时间轴 · 适合长时泛听

  librispeech  LibriSpeech 句子精听
               CC BY 4.0 · 一句一包 · 适合听写与跟读

  voa          VOA Learning English 每日节目
               美国政府作品公有领域 · 新闻英语泛听（无文本）

用法：
  node tools/fetch-resources.js all --limit=20      # 每种少量，快速试跑
  node tools/fetch-resources.js amenglish           # 全量 30 段对话
  node tools/fetch-resources.js librispeech --limit=200
  node tools/fetch-resources.js --dry-run all       # 只看会下载什么

注意：本工具刻意【不】包含四六级/雅思/托福真题音频与 TED。
      原因见 docs/resources.md —— 真题音频版权属考试机构，TED 为 CC BY-NC-ND 且禁止抓取。
`);
}

async function main() {
  const cmd = process.argv[2] || 'list';

  if (cmd === 'list' || cmd === '--help' || cmd === '-h') { listSources(); return; }

  log('输出目录：' + OUT_ROOT);
  if (DRY) log('（dry-run：只探测，不写文件）');
  if (FORCE) log('（--force：覆盖已存在文件）');

  const totals = { packs: 0, bytes: 0 };
  const add = (r) => { totals.packs += r.packs; totals.bytes += r.bytes; };

  // 每个来源单独兜错：某个站点抽风不应该让其余来源一起失败
  // （archive.org 的连接超时曾经中断了后面全部下载）
  const failed = [];
  async function run(label, fn, sink) {
    try {
      sink(await fn());
    } catch (err) {
      failed.push(`${label}: ${err.message}`);
      warn(`【${label}】下载失败，已跳过，继续处理其余来源`);
    }
  }

  try {
    if (cmd === 'amenglish' || cmd === 'all') await run('American English', fetchAmEnglish, add);
    if (cmd === 'librivox' || cmd === 'all') await run('LibriVox', fetchLibriVox, add);
    if (cmd === 'librispeech' || cmd === 'all') await run('LibriSpeech', fetchLibriSpeech, add);
    if (cmd === 'voa' || cmd === 'all') await run('VOA', fetchVoa, add);
  } catch (err) {
    console.error('\n[error] ' + err.message);
    process.exit(1);
  }

  if (cmd !== 'amenglish' && cmd !== 'librivox' && cmd !== 'librispeech' && cmd !== 'voa' && cmd !== 'all') {
    console.error(`\n[error] 未知子命令：${cmd}\n`);
    listSources();
    process.exit(1);
  }

  log('\n' + '─'.repeat(56));
  log(`合计：${totals.packs} 个资料包，${(totals.bytes / 1048576).toFixed(1)} MB`);
  if (failed.length) {
    log('\n以下来源未能完成（其余来源不受影响）：');
    for (const f of failed) log('  ✗ ' + f);
    log('  可以稍后单独重跑，例如：node tools/fetch-resources.js librivox');
  }
  log('启动播放器：node server.js   →  http://127.0.0.1:4180');
  log('');
}

if (require.main === module) main();

module.exports = { download, safeName, writePack, lrcTime };

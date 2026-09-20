#!/usr/bin/env node
/**
 * fetch-manual.js — 按 docs/sources-manual.json 里的清单下载「需要你确认」的素材
 *
 * 为什么单独做一个，而不并进 tools/fetch-resources.js：
 *   这批素材有两个特点，不适合"无脑自动下载"：
 *     1. 一部分（四六级真题）版权属考试机构，不该随项目自动分发；
 *     2. 另一部分链接会失效或返回假内容（Git LFS 指针、网盘、防盗链），
 *        自动跑很容易**静默拿到错误文件**。
 *   所以做成：先展示清单 → 你指定要哪个 → 下载并逐个校验字节数。
 *
 * 核心是【字节数校验】：
 *   GitHub 上大量仓库用 Git LFS，raw.githubusercontent.com 会返回 133 字节的
 *   指针文件，HTTP 状态码仍是 200 —— 看起来成功，其实内容是
 *   "version https://git-lfs.github.com/spec/v1 ..."。比对字节数就能立刻发现。
 *
 * 用法：
 *   node tools/fetch-manual.js list                     列出所有条目
 *   node tools/fetch-manual.js list cet6-zenodo         只看某一组
 *   node tools/fetch-manual.js get  cet6-zenodo         下载该组到 audio/CET6-真题/
 *   node tools/fetch-manual.js get  cet6-zenodo --dry    只校验，不写文件
 *   node tools/fetch-manual.js verify audio/CET6-真题    校验已下载文件的字节数
 *
 * 下载完成后，再用 tools/import.js 或 tools/from-cet-timings.js 装进播放器。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(ROOT, 'docs', 'sources-manual.json');
const OUT_ROOT = path.resolve(arg('out', path.join(ROOT, 'audio', '手动下载')));

function arg(name, def) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return def;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
}

const DRY = Boolean(arg('dry', false));
const FORCE = Boolean(arg('force', false));

function load() {
  if (!fs.existsSync(MANIFEST)) {
    console.error('找不到清单文件：' + MANIFEST);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
}

/** 目标下载目录名 */
const DIR_NAME = {
  'cet6-zenodo': 'CET6-真题',
  'cet6-paired': 'CET6-2017.12-第1套',
  'cet-timings': 'CET6-时间戳',
  'cet-audio-yinsin': 'CET-音频-YinsinSirius',
  'cet-audio-dedidi': 'CET-音频-DieDiDi',
};

/**
 * 把旧编码（GBK 等）字节转成 UTF-8。
 *
 * ⚠️ 两个坑，都是实测撞出来的：
 *   1. 不能只看清单里标的编码就无脑转。有些文件其实是 UTF-8 带 BOM，
 *      按 GBK 解会把 BOM 变成 "锘�" 并破坏后续内容（题干/答案文件就是这样）。
 *   2. 有 BOM 就说明它已经是 UTF-8，直接按 UTF-8 处理即可。
 *
 * 所以策略是：先看 BOM → 再看是不是合法 UTF-8 → 最后才按声明的编码解。
 */
function decodeToUtf8(buf, encoding) {
  // UTF-8 BOM：说明本来就是 UTF-8，去掉 BOM 返回
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return buf.subarray(3);
  }
  // UTF-16 BOM
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    try { return Buffer.from(new TextDecoder('utf-16le').decode(buf.subarray(2)), 'utf8'); } catch { return buf; }
  }

  const enc = String(encoding || '').toLowerCase();
  if (enc !== 'gbk' && enc !== 'gb2312' && enc !== 'gb18030') return buf;

  // 用「严格模式」判断它是否本来就是合法 UTF-8：能解通就不动它
  try {
    const strict = new TextDecoder('utf-8', { fatal: true });
    const asUtf8 = strict.decode(buf);
    // 解通了，且不是一坨乱码控制字符，就认为本来就是 UTF-8
    if (!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(asUtf8)) {
      return Buffer.from(asUtf8, 'utf8');
    }
  } catch {
    // 不是合法 UTF-8，继续按 GBK 处理
  }

  try {
    return Buffer.from(new TextDecoder('gbk').decode(buf), 'utf8');
  } catch {
    return buf;   // 环境不支持 GBK 时原样返回，至少不丢数据
  }
}

// ---------------------------------------------------------------- 下载（带代理）

// Node 不读 Windows 系统代理，这里复用 fetch-resources 的实现
let download;
try {
  ({ download } = require('./fetch-resources.js'));
} catch {
  download = null;
}

// ---------------------------------------------------------------- 校验

/** 判断内容是否是 Git LFS 指针（最典型的"假成功"） */
function isLfsPointer(buf) {
  const head = buf.subarray(0, 200).toString('utf8');
  return /^version https:\/\/git-lfs\.github\.com\/spec\/v1/.test(head);
}

// ---------------------------------------------------------------- 命令

const LFS_EXT = new Set(['.mp3', '.m4a', '.wav', '.flac', '.ogg', '.pdf', '.zip']);

/**
 * 拼下载地址。
 *
 * 两个必须分清的坑：
 *   1. 只有被 Git LFS 跟踪的【二进制大文件】才要走 media.githubusercontent.com。
 *      文本文件（.lrc / .md / .txt）走 media 域名会 404 —— 实测第一套.lrc 就是这样。
 *   2. 中文路径在 media 域名上各种编码方式都试过，全部 404；
 *      同一个路径走 raw.githubusercontent.com 就正常。
 *      所以：LFS 二进制走 media，其余一律走 raw。
 */
function buildUrl(group, item) {
  if (item.url) return item.url;

  const repo = group.repo;
  const branch = group.branch || 'main';
  const p = item.path;
  const ext = path.extname(p).toLowerCase();

  const isLfsTracked = LFS_EXT.has(ext);
  const base = isLfsTracked
    ? `https://media.githubusercontent.com/media/${repo}/${branch}`
    : `https://raw.githubusercontent.com/${repo}/${branch}`;

  // 中文路径逐段编码（raw 域名下这样是可行的）
  const enc = p.split('/').map((seg) => encodeURIComponent(seg)).join('/');
  return `${base}/${enc}`;
}

function cmdList(spec, only) {
  const groups = spec.groups.filter((g) => !only || g.id === only);

  console.log('');
  console.log('可下载素材清单（docs/sources-manual.json）');
  console.log('='.repeat(78));

  for (const g of groups) {
    console.log('');
    console.log(`【${g.id}】${g.label}`);
    console.log(`  许可：${g.license}`);
    if (g.licenseNote) console.log(`        ${g.licenseNote}`);
    if (g.repo) console.log(`  仓库：https://github.com/${g.repo}`);
    if (g.zenodo) console.log(`  归档：${g.zenodo}`);
    if (g.note) console.log(`  说明：${Array.isArray(g.note) ? g.note.join('\n        ') : g.note}`);

    if (g.items && g.items.length) {
      console.log(`  条目（${g.items.length}）：`);
      for (const it of g.items) {
        const sz = it.bytes ? `  ${(it.bytes / 1048576).toFixed(1)} MB` : '';
        console.log(`    · ${it.path}${sz}`);
        if (it.重要) console.log(`      ⚑ ${it.重要}`);
      }
    }
    if (g['配对表']) {
      console.log('  时间戳 ↔ 音频 配对表（必须字节数一致，否则歌词会整体漂移）：');
      for (const r of g['配对表']) {
        console.log(`    ${r.timings.padEnd(12)} 需要 ${String(r['需要字节数']).padStart(11)} 字节  ${r['已实测']}`);
        console.log(`      → ${r['对应音频']}`);
      }
    }
    if (g['已知不匹配']) {
      console.log('  ⚠ 已知不匹配（不要混用）：');
      for (const s of g['已知不匹配']) console.log('    · ' + s);
    }
    if (g['已实测可用']) {
      console.log('  已实测可用的直链：');
      for (const s of g['已实测可用']) console.log('    · ' + s);
    }
    if (g['如何取全部']) console.log(`  取全部：${g['如何取全部']}`);
  }

  console.log('');
  console.log('='.repeat(78));
  console.log('下载某一组：node tools/fetch-manual.js get <组id>');
  console.log('先只校验　：node tools/fetch-manual.js get <组id> --dry');
  console.log('');
}

async function cmdGet(spec, id) {
  const g = spec.groups.find((x) => x.id === id);
  if (!g) {
    console.error(`清单里没有组 "${id}"。可用的组：${spec.groups.map((x) => x.id).join(', ')}`);
    process.exit(1);
  }
  if (!g.repo && !g.items.some((i) => i.url)) {
    console.error(`组 "${id}" 没有可直接下载的地址（把「如何取全部」或「已实测可用」里的链接手动打开）。`);
    process.exit(1);
  }
  if (!download) {
    console.error('无法加载下载模块（tools/fetch-resources.js）。');
    process.exit(1);
  }

  const dir = path.join(OUT_ROOT, DIR_NAME[id] || id);
  if (!DRY) fs.mkdirSync(dir, { recursive: true });

  console.log('');
  console.log(`【${g.id}】${g.label}`);
  console.log(`许可：${g.license}`);
  if (g.licenseNote) console.log(`      ${g.licenseNote}`);
  console.log(`输出：${dir}`);
  if (DRY) console.log('（--dry：只校验，不写文件）');
  console.log('');

  let okCount = 0, sizeMismatch = 0, lfsCount = 0, failCount = 0;

  for (const it of g.items) {
    if (!it.path || it.url === undefined && !g.repo) continue;
    const url = buildUrl(g, it);
    const name = path.basename(it.path);
    const dest = path.join(dir, name);

    process.stdout.write(`  · ${it.path} … `);

    let buf;
    try {
      buf = await download(url, { timeoutMs: 600000 });
    } catch (err) {
      console.log(`失败（${err.message.split('::').pop().trim()}）`);
      failCount++;
      continue;
    }

    // GBK 等旧编码在存盘前转成 UTF-8，否则播放器里是乱码
    if (it.encoding) {
      const before = buf.length;
      buf = decodeToUtf8(buf, it.encoding);
      if (buf.length !== before) process.stdout.write(`[${it.encoding}→utf8] `);
    }

    // 假成功检测
    if (isLfsPointer(buf)) {
      console.log(`⚠ 拿到的是 Git LFS 指针（${buf.length} 字节），不是文件本体`);
      console.log('     该仓库用 Git LFS。二进制文件请走 media.githubusercontent.com。');
      lfsCount++;
      continue;
    }

    if (it.bytes && buf.length !== it.bytes) {
      // 编码转换会改变字节数，这种情况只提示不判失败
      if (it.encoding) {
        console.log(`✓ ${(buf.length / 1024).toFixed(1)} KB（原文 ${it.bytes} 字节，已转码）`);
        if (!DRY) fs.writeFileSync(dest, buf);
        okCount++;
        continue;
      }
      console.log(`⚠ 字节数不符：期望 ${it.bytes}，实得 ${buf.length}（可能是不同版本，请人工确认）`);
      sizeMismatch++;
      if (!DRY) fs.writeFileSync(dest, buf);
      continue;
    }

    if (!DRY) fs.writeFileSync(dest, buf);
    console.log(`✓ ${(buf.length / 1048576).toFixed(2)} MB${it.bytes ? '（与清单一致）' : ''}`);
    okCount++;
  }

  console.log('');
  console.log('─'.repeat(60));
  console.log(`成功 ${okCount}　字节数不符 ${sizeMismatch}　LFS 指针 ${lfsCount}　下载失败 ${failCount}`);
  console.log('');
  if (okCount && !DRY) {
    console.log('下一步 —— 装进播放器：');
    console.log(`  音频 + 字幕：node tools/import.js --audio="${path.join(dir, '<音频>')}" --sub="<字幕>" --exam=cet6`);
    console.log(`  配 timings ：node tools/from-cet-timings.js <timings.json> --audio="${path.join(dir, '<音频>')}"`);
    console.log('');
  }
}

function cmdVerify(spec, dir) {
  const target = path.resolve(dir || OUT_ROOT);
  console.log('');
  console.log('校验目录：' + target);
  console.log('');

  // 把清单里所有已知字节数收成一张表
  const known = new Map();
  for (const g of spec.groups) {
    for (const it of g.items || []) {
      if (it.bytes) known.set(path.basename(it.path), it.bytes);
    }
  }

  let checked = 0, bad = 0, unknown = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.isFile()) continue;

      const buf = fs.readFileSync(full);
      if (isLfsPointer(buf)) {
        console.log(`  ⚠ ${e.name}：是 LFS 指针（${buf.length} 字节），不是文件本体`);
        bad++;
        continue;
      }
      const expect = known.get(e.name);
      if (expect === undefined) { unknown++; continue; }

      checked++;
      if (buf.length === expect) {
        console.log(`  ✓ ${e.name}  ${buf.length} 字节`);
      } else {
        console.log(`  ✗ ${e.name}  期望 ${expect} 实得 ${buf.length}`);
        bad++;
      }
    }
  };
  walk(target);

  console.log('');
  console.log(`已校验 ${checked} 个，异常 ${bad} 个，清单里没记录 ${unknown} 个`);
  console.log('');
}

// ---------------------------------------------------------------- main

async function main() {
  const cmd = process.argv[2] || 'list';
  const spec = load();

  if (cmd === 'list') return cmdList(spec, process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : '');
  if (cmd === 'get') {
    const id = process.argv[3];
    if (!id) { console.error('用法：node tools/fetch-manual.js get <组id>'); process.exit(1); }
    return cmdGet(spec, id);
  }
  if (cmd === 'verify') return cmdVerify(spec, process.argv[3]);

  console.log(`用法：
  node tools/fetch-manual.js list [组id]     列出清单
  node tools/fetch-manual.js get  <组id>     下载某一组（自动校验字节数）
  node tools/fetch-manual.js get  <组id> --dry   只校验不写文件
  node tools/fetch-manual.js verify [目录]   校验已下载文件`);
}

if (require.main === module) {
  main().catch((e) => { console.error('[error] ' + e.message); process.exit(1); });
}

module.exports = { isLfsPointer, buildUrl };

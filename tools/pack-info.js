#!/usr/bin/env node
/**
 * pack-info.js — 查看 / 校验补充包（.lppack）
 *
 * 补充包动辄一两 GB，拷到手机前先在本机确认一下内容对不对，比装上去再排查省事得多。
 * 本工具只读 ZIP 的中央目录与需要的条目，**不会把整包读进内存**
 * （1.8 GB 的包要是整个读进来，本机那点可用内存直接不够）。
 *
 * 用法：
 *   node tools/pack-info.js 雅思听力补充包.lppack
 *   node tools/pack-info.js 雅思听力补充包.lppack --verify     # 逐课程核对素材文件是否齐全
 *   node tools/pack-info.js --all                             # 列出项目目录下所有 .lppack
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const { ROOT, MOBILE_DIR, findPacks, resolveDeliverable } = require(path.join(__dirname, 'paths.js'));
const AUDIO_RE = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|webm|mp4)$/i;

// ---------------------------------------------------------------- 只读 ZIP

/** 打开 ZIP，返回 { read(name), names(), entries }（按需读取，不整包载入） */
function openZip(file) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;

  // EOCD 在文件末尾，但可能有注释，所以从尾部往前找（最多 64 KB）
  const tailLen = Math.min(size, 65536 + 22);
  const tail = Buffer.alloc(tailLen);
  fs.readSync(fd, tail, 0, tailLen, size - tailLen);

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) { fs.closeSync(fd); throw new Error('不是合法的 ZIP（找不到中央目录结尾记录）'); }

  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || count === 0xffff) {
    fs.closeSync(fd);
    throw new Error('这是 ZIP64 格式的包（本工具只处理常规 ZIP）');
  }

  const cd = Buffer.alloc(cdSize);
  fs.readSync(fd, cd, 0, cdSize, cdOffset);

  const entries = new Map();
  let off = 0;
  for (let i = 0; i < count; i++) {
    if (cd.readUInt32LE(off) !== 0x02014b50) throw new Error('中央目录损坏 @' + off);
    const method = cd.readUInt16LE(off + 10);
    const csize = cd.readUInt32LE(off + 20);
    const usize = cd.readUInt32LE(off + 24);
    const nameLen = cd.readUInt16LE(off + 28);
    const extraLen = cd.readUInt16LE(off + 30);
    const commentLen = cd.readUInt16LE(off + 32);
    const localOff = cd.readUInt32LE(off + 42);
    const name = cd.toString('utf8', off + 46, off + 46 + nameLen);
    entries.set(name, { name, method, csize, usize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }

  function read(name) {
    const e = entries.get(name);
    if (!e) return null;
    const head = Buffer.alloc(30);
    fs.readSync(fd, head, 0, 30, e.localOff);
    if (head.readUInt32LE(0) !== 0x04034b50) throw new Error('本地头损坏：' + name);
    const lName = head.readUInt16LE(26);
    const lExtra = head.readUInt16LE(28);
    const data = Buffer.alloc(e.csize);
    fs.readSync(fd, data, 0, e.csize, e.localOff + 30 + lName + lExtra);
    return e.method === 0 ? data : zlib.inflateRawSync(data);
  }

  function readText(name) {
    const buf = read(name);
    return buf == null ? null : buf.toString('utf8');
  }

  return { fd, size, entries, read, readText, close: () => fs.closeSync(fd) };
}

// ---------------------------------------------------------------- 输出

function human(bytes) {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

function inspect(file, verify) {
  const zip = openZip(file);
  try {
    let audioBytes = 0;
    let otherBytes = 0;
    for (const e of zip.entries.values()) {
      if (/^audio\/.*\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|webm|mp4)$/i.test(e.name)) audioBytes += e.usize;
      else otherBytes += e.usize;
    }

    console.log('');
    console.log(`补充包：${path.basename(file)}`);
    console.log(`  文件体积   ${human(zip.size)}`);
    console.log(`  条目数     ${zip.entries.size}（音频 ${human(audioBytes)}，其它 ${human(otherBytes)}）`);

    const manifestText = zip.readText('manifest.json');
    if (!manifestText) throw new Error('缺少 manifest.json —— 不是补充包');
    const manifest = JSON.parse(manifestText);
    console.log(`  格式       ${manifest.format} v${manifest.version}`
      + (manifest.hasLibrary ? '（含课程数据）' : '（旧版：没有课程数据）'));
    console.log(`  素材目录   ${manifest.set || '(未标注)'}`);
    console.log(`  声明课程   ${manifest.lessons || 0}`);

    const libText = zip.readText('library.json');
    if (!libText) {
      console.log('');
      console.log('  ⚠️  包里没有 library.json：App 会把它标成「旧版补充包」，无法读取课程。');
      console.log('      用 node tools/build-pack.js --set=' + (manifest.set || '<目录名>') + ' 重新打包。');
      return 1;
    }

    const lib = JSON.parse(libText);
    const lessons = lib.lessons || [];
    let lines = 0, translations = 0, questions = 0, withPaper = 0;
    for (const l of lessons) {
      lines += (l.lines || []).length;
      translations += (l.translationLines || []).length;
      questions += (l.questions || []).length;
      if (l.paper) withPaper++;
    }
    console.log(`  课程数据   ${human(Buffer.byteLength(libText))}：${lessons.length} 门课，`
      + `${lines} 句时间轴，${translations} 句译文，${questions} 道题，${withPaper} 门有原题`);

    if (!verify) {
      console.log('');
      console.log('  加 --verify 可逐课程核对包内素材文件是否齐全。');
      console.log('');
      return 0;
    }

    // 逐课程核对：音频必须有，其它同名素材看课程数据里是否声明
    const missing = [];
    const names = zip.entries;
    for (const l of lessons) {
      const id = l.manifest && l.manifest.id;
      if (!id) { missing.push('(课程数据里有一条没有 id)'); continue; }
      if (!names.has(`audio/${id}`)) { missing.push(`缺少音频：audio/${id}`); continue; }
      const base = `audio/${id.replace(AUDIO_RE, '')}`;
      if ((l.lines || []).length && !names.has(`${base}.lrc`) && !names.has(`${base}.lrc.override.json`)) {
        missing.push(`有台词却缺 .lrc：${base}.lrc`);
      }
      if ((l.questions || []).length && !names.has(`${base}.questions.json`)
          && !names.has(`${base}.questions.json.override.json`)) {
        missing.push(`有题目却缺 .questions.json：${base}.questions.json`);
      }
    }

    // 反向核对：包里有音频但课程数据里没提到（打漏或命名对不上）
    const known = new Set(lessons.map((l) => `audio/${l.manifest && l.manifest.id}`));
    const orphan = [];
    for (const name of names.keys()) {
      if (!name.startsWith('audio/') || !AUDIO_RE.test(name)) continue;
      if (!known.has(name)) orphan.push(name);
    }

    console.log('');
    if (!missing.length && !orphan.length) {
      console.log(`  ✅ 校验通过：${lessons.length} 门课的素材都在包里，没有多余音频。`);
      console.log('');
      return 0;
    }
    if (missing.length) {
      console.log(`  ⚠️  ${missing.length} 处缺失：`);
      for (const m of missing.slice(0, 20)) console.log('      · ' + m);
      if (missing.length > 20) console.log(`      …还有 ${missing.length - 20} 处`);
    }
    if (orphan.length) {
      console.log(`  ⚠️  ${orphan.length} 个音频没出现在课程数据里（App 里看不到）：`);
      for (const m of orphan.slice(0, 10)) console.log('      · ' + m);
      if (orphan.length > 10) console.log(`      …还有 ${orphan.length - 10} 个`);
    }
    console.log('');
    return 1;
  } finally {
    zip.close();
  }
}

function main() {
  const args = process.argv.slice(2);
  const verify = args.includes('--verify');

  let files = args.filter((a) => !a.startsWith('--'));
  if (args.includes('--all') || !files.length) {
    files = findPacks();
    if (!files.length) {
      console.log('\n没有找到 .lppack 补充包。');
      console.log(`（会在「${MOBILE_DIR}」和项目根目录里找）`);
      console.log('打包：node tools/build-pack.js --set=IELTS-剑桥真题\n');
      return 0;
    }
  }

  let code = 0;
  for (const f of files) {
    const abs = path.isAbsolute(f) ? f : resolveDeliverable(f);
    if (!fs.existsSync(abs)) {
      console.error(`\n找不到文件：${abs}`);
      code = 1;
      continue;
    }
    try {
      if (inspect(abs, verify)) code = 1;
    } catch (err) {
      console.error(`\n[${path.basename(abs)}] 读取失败：${err.message}`);
      code = 1;
    }
  }
  return code;
}

if (require.main === module) process.exit(main());

module.exports = { openZip, inspect };

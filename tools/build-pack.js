#!/usr/bin/env node
/**
 * build-pack.js — 生成「补充包」（APK 装不下的素材单独打包）
 *
 * 背景：
 *   单个 APK 有 **2 GiB 硬上限**（ZIP 中央目录用 32 位记录大小），
 *   而本机素材合计约 3.0 GB，物理上装不进一个包。所以拆成：
 *     · 安装包（APK）    ：前端 + 演示语料，十几 MB，随手就能装
 *     · 补充包（.lppack）：某个素材目录的完整内容，单独下载后在 App 里导入
 *
 * 补充包就是一个标准 ZIP，结构：
 *     manifest.json        包信息（名称、课程数、体积、校验用）
 *     library.json         课程数据（时间轴/译文/题目/原题，App 直接读它建课程列表）
 *     audio/<目录名>/…     与项目 audio/ 下完全一致的结构
 *   App 侧把包放在自己的目录里，读取时优先查补充包（见 MainActivity / PackStore.java）。
 *   用 ZIP 而不是自定义格式，是为了让用户也能用普通解压工具查看内容。
 *
 * ⚠️ 为什么要有 library.json（v2 新增）：
 *   APK 里那份 bundle.json 只含打进去的素材。补充包里的课程要想出现在手机课程列表里，
 *   App 必须能拿到这些课程的「时间轴 / 译文 / 题目 / 原题」。
 *   让 Android 侧去解 LRC、拼元信息既费事又容易和桌面端逻辑走偏，
 *   所以打包时直接用 lib/library.js 生成一份和桌面端完全同源的课程数据塞进包里。
 *   代价很小：雅思包 5.9 MB（deflate 后 2.1 MB），六级包 1.5 MB。
 *
 * 用法：
 *   node tools/build-pack.js --set=IELTS-剑桥真题
 *   node tools/build-pack.js --set=CET6-真题 --out=CET6真题.lppack
 *   node tools/build-pack.js --list                     看有哪些目录、各多大
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const AUDIO_DIR = path.join(ROOT, 'audio');
const BUILD_DIR = path.join(ROOT, 'build', 'packs');

const { ensureMobileDir } = require(path.join(__dirname, 'paths.js'));

// 与 lib/library.js 的 AUDIO_EXT 保持同一套扩展名（少一个就会出现
// 「包里有音频、App 却不认识」的静默不一致）
const AUDIO_RE = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|webm|mp4)$/i;

const FORMAT = 'listening-player-pack';
const FORMAT_VERSION = 2;

// ---------------------------------------------------------------- ZIP 写入
//
// 沿用 build-apk.js 里自写 ZIP 的做法：Node 没有内置创建 ZIP 的 API，
// 而 Windows 上 `jar`/`Compress-Archive` 对超大文件与中文名都不可靠。

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
  return (crc ^ -1) >>> 0;
}

/**
 * 流式写 ZIP。
 *
 * ⚠️ 为什么不用「把全部文件读进内存再写」：
 *    雅思包约 1.9 GB，读进内存会直接 OOM（本机可用内存只有几 GB）。
 *    这里改成写一个文件就落盘一段，内存里只留当前文件与中央目录。
 *    中央目录本身很小（每个条目几十字节），可以留在内存。
 */
function createZip(outPath) {
  const fd = fs.openSync(outPath, 'w');
  const central = [];
  let offset = 0;

  function writeBuf(buf) {
    fs.writeSync(fd, buf);
    offset += buf.length;
  }

  function addFile(name, absPath, compress) {
    const data = fs.readFileSync(absPath);
    const crc = crc32(data);
    const nameBuf = Buffer.from(name, 'utf8');

    let stored = data;
    let method = 0;
    if (compress && data.length > 512) {
      const deflated = zlib.deflateRawSync(data, { level: 6 });
      // 压不小就别压（音频基本压不动，省时间）
      if (deflated.length < data.length * 0.98) { stored = deflated; method = 8; }
    }

    const localOffset = offset;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);            // version needed
    head.writeUInt16LE(0x0800, 6);        // UTF-8 名字标志（中文路径必需）
    head.writeUInt16LE(method, 8);
    head.writeUInt16LE(0, 10);            // time
    head.writeUInt16LE(0x21, 12);         // date（1980-01-01）
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(stored.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    head.writeUInt16LE(0, 28);

    writeBuf(head);
    writeBuf(nameBuf);
    writeBuf(stored);

    central.push({ name: nameBuf, crc, csize: stored.length, usize: data.length, method, localOffset });
    return data.length;
  }

  function finish() {
    const cdStart = offset;
    for (const e of central) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(20, 4);
      h.writeUInt16LE(20, 6);
      h.writeUInt16LE(0x0800, 8);
      h.writeUInt16LE(e.method, 10);
      h.writeUInt16LE(0, 12);
      h.writeUInt16LE(0x21, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.csize, 20);
      h.writeUInt32LE(e.usize, 24);
      h.writeUInt16LE(e.name.length, 28);
      h.writeUInt16LE(0, 30);   // extra
      h.writeUInt16LE(0, 32);   // comment
      h.writeUInt16LE(0, 34);   // disk
      h.writeUInt16LE(0, 36);   // internal attr
      h.writeUInt32LE(0, 38);   // external attr
      h.writeUInt32LE(e.localOffset, 42);
      writeBuf(h);
      writeBuf(e.name);
    }
    const cdSize = offset - cdStart;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(cdSize, 12);
    end.writeUInt32LE(cdStart, 16);
    end.writeUInt16LE(0, 20);
    writeBuf(end);
    fs.closeSync(fd);
  }

  return { addFile, finish, get entries() { return central.length; } };
}

// ---------------------------------------------------------------- 课程数据

/**
 * 用桌面端同一套扫描逻辑（lib/library.js）生成包内课程数据。
 *
 * 关键点：这里【不】复用 build-apk.js 的 bundle.json 写法，而是把
 * lines / translationLines / questions / transcript / paper 全带上。
 * 手机端因此能拿到和电脑上完全一样的内容：滚动时间轴、中英对照、
 * 题目与答案解析、原题全文 —— 不需要 Android 侧再解析任何格式。
 */
async function buildPackLibrary(setName) {
  const { buildLibrary } = require(path.join(ROOT, 'lib', 'library.js'));
  const all = await buildLibrary(AUDIO_DIR);
  const lessons = all.filter((l) => {
    const folder = l.manifest.folder || '';
    return folder === setName || folder.startsWith(setName + '/');
  });

  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    set: setName,
    generatedAt: new Date().toISOString(),
    count: lessons.length,
    lessons: lessons.map((l) => ({
      manifest: l.manifest,
      lines: l.lines,
      translationLines: l.translationLines,
      questions: l.questions,
      // 题组正文：雅思题在界面上全靠它才有「题目」可看（题干本身是占位符）
      questionGroups: l.questionGroups,
      transcript: l.transcript,
      paper: l.paper,
    })),
  };
}

// ---------------------------------------------------------------- 主流程

function listSets() {
  if (!fs.existsSync(AUDIO_DIR)) return [];
  return fs.readdirSync(AUDIO_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
    .map((e) => {
      const dir = path.join(AUDIO_DIR, e.name);
      let bytes = 0, files = 0, lessons = 0;
      const walk = (d) => {
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, f.name);
          if (f.isDirectory()) walk(p);
          else {
            bytes += fs.statSync(p).size;
            files++;
            if (AUDIO_RE.test(f.name)) lessons++;
          }
        }
      };
      walk(dir);
      return { name: e.name, dir, bytes, files, lessons };
    })
    .sort((a, b) => b.bytes - a.bytes);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--list') || !args.length) {
    console.log('');
    console.log('可打包的素材目录：');
    console.log('');
    console.log('  目录                        课程数      体积');
    console.log('  ' + '-'.repeat(52));
    for (const s of listSets()) {
      console.log(`  ${s.name.padEnd(26)} ${String(s.lessons).padStart(5)}  ${(s.bytes / 1048576).toFixed(0).padStart(7)} MB`);
    }
    console.log('');
    console.log('打包示例：');
    console.log('  node tools/build-pack.js --set=IELTS-剑桥真题');
    console.log('  node tools/build-pack.js --set=CET6-真题 --out=CET6真题.lppack');
    console.log('');
    return;
  }

  const setName = (args.find((a) => a.startsWith('--set=')) || '').split('=')[1];
  if (!setName) { console.error('需要 --set=<目录名>'); process.exit(1); }

  const sets = listSets();
  const target = sets.find((s) => s.name === setName);
  if (!target) {
    console.error(`找不到素材目录 "${setName}"。可用：${sets.map((s) => s.name).join(', ')}`);
    process.exit(1);
  }

  const outName = (args.find((a) => a.startsWith('--out=')) || '').split('=')[1]
    || `listening-pack-${setName}.lppack`;
  // 相对路径落在「Whale-Lite-手机版」目录里（手机要用的东西都在那一个文件夹）
  const outPath = path.isAbsolute(outName) ? outName : path.join(ensureMobileDir(), outName);

  fs.mkdirSync(BUILD_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  console.log('');
  console.log(`打包补充包：${setName}`);
  console.log(`  ${target.lessons} 个课程  ${(target.bytes / 1048576).toFixed(0)} MB  →  ${path.basename(outPath)}`);
  console.log('');

  // 先生成课程数据：这一步用桌面端扫描逻辑，App 直接读结果，
  // 因此包里的时间轴/题目与电脑上看到的必然一致。
  const library = await buildPackLibrary(setName);
  if (library.count !== target.lessons) {
    console.warn(`  ⚠ 课程数不一致：扫描到 ${target.lessons} 个音频文件，`
      + `课程数据里 ${library.count} 个（可能有音频缺少同名素材组）`);
  }
  const tmpLibrary = path.join(BUILD_DIR, `_library-${setName}.json`);
  fs.writeFileSync(tmpLibrary, JSON.stringify(library), 'utf8');
  const libBytes = fs.statSync(tmpLibrary).size;

  const zip = createZip(outPath);
  const t0 = Date.now();

  // 先写 manifest 与 library（放 ZIP 最前面：体积小，解析快）
  const manifest = {
    format: FORMAT,
    version: FORMAT_VERSION,
    set: setName,
    lessons: library.count,
    audioFiles: target.lessons,
    sourceBytes: target.bytes,
    hasLibrary: true,
    createdAt: new Date().toISOString(),
    note: 'Whale Lite补充包。在 App 里点右上角「补充包」→「导入 .lppack」选择本文件，即可离线播放。',
  };
  const tmpManifest = path.join(BUILD_DIR, '_manifest.json');
  fs.writeFileSync(tmpManifest, JSON.stringify(manifest, null, 2), 'utf8');
  zip.addFile('manifest.json', tmpManifest, true);
  zip.addFile('library.json', tmpLibrary, true);
  console.log(`  课程数据 ${(libBytes / 1048576).toFixed(2)} MB（${library.count} 门课，含时间轴/译文/题目/原题）`);

  // 递归加入素材（音频不压缩：mp3 已经压过，再压白费时间）
  let n = 0;
  const walk = (dir, relBase) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, e.name);
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(abs, rel); continue; }
      // 跳过中间产物
      if (/\.(duration|tmp|bak|polished\.json)$/i.test(e.name)) continue;
      const isAudio = AUDIO_RE.test(e.name);
      zip.addFile(`audio/${setName}/${rel}`, abs, !isAudio);
      if (++n % 100 === 0) {
        process.stdout.write(`\r  已加入 ${n} 个文件…`);
      }
    }
  };
  walk(target.dir, '');

  zip.finish();
  const dt = (Date.now() - t0) / 1000;
  const size = fs.statSync(outPath).size;

  process.stdout.write('\r');
  console.log(`  完成：${n} 个文件，${(size / 1048576).toFixed(1)} MB，耗时 ${dt.toFixed(0)} 秒`);
  console.log('');
  console.log(`  产物：${outPath}`);
  console.log('');
  console.log('  装到手机：');
  console.log('    A. 数据线：把上面这个文件拷到');
  console.log('       /sdcard/Android/data/com.dsh.listeningplayer/files/packs/');
  console.log('    B. 手机 App 内：右上角「补充包」→「导入 .lppack」选择本文件');
  console.log('');
  console.log(`  自检：node tools/test.js --http（含补充包读写用例）`);
  console.log('');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\n[打包失败] ' + err.message);
    process.exit(1);
  });
}

module.exports = { createZip, listSets, buildPackLibrary, FORMAT, FORMAT_VERSION };

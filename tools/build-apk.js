#!/usr/bin/env node
/**
 * build-apk.js — 把播放器打包成 Android APK
 *
 * 为什么不用 Gradle：
 *   Gradle + Android Gradle Plugin 要拖几百 MB 依赖，而本项目的 Android 侧
 *   只是一个加载 WebView 的壳，用 SDK 自带的 aapt2 / javac / d8 / zipalign / apksigner
 *   直接构建更快、更透明，也便于在没有 Android Studio 的机器上复现。
 *
 * 构建流程：
 *   1. 生成 public/bundle.json（课程数据快照，供离线模式使用）
 *   2. 组装 assets/www：前端 + bundle.json + audio/ 全部素材
 *   3. aapt2 compile/link 资源与清单 → 生成基础 APK（含 assets）
 *   4. javac 编译 Java 源码（classpath 指向 android.jar）→ d8 转 dex
 *   5. 把 classes.dex 打进 APK，zipalign 对齐，apksigner 签名
 *
 * 前置条件：
 *   · JDK（javac / keytool 可用）
 *   · Android SDK（platforms/android-34 与 build-tools/34.0.0）
 *   脚本会自动在常见位置寻找，也可用环境变量指定：
 *     ANDROID_HOME 或 ANDROID_SDK_ROOT
 *     JAVA_HOME
 *
 * 用法：
 *   node tools/build-apk.js                 # 完整构建
 *   node tools/build-apk.js --no-audio      # 不打包音频（产物体积很小，用于验证流程）
 *   node tools/build-apk.js --api=http://192.168.1.10:4180   # 改为连桌面端服务
 *   node tools/build-apk.js --audio-set=IELTS-剑桥真题 --out=listening-player-ielts.apk
 *
 * ⚠️ 单个 APK 有 2 GiB 硬上限（ZIP 格式限制，中央目录用 32 位记录大小）。
 *    本机全部素材约 3.0 GB，**装不进一个 APK**。现在推荐的做法是
 *    「精简版安装包 + 补充包（.lppack，见 tools/build-pack.js）」：
 *      精简版  --audio-set=CET4-演示,CET6-演示,IELTS-演示,TOEFL-演示   ≈ 35 MB
 *      然后按需把 tools/build-pack.js 打好的 .lppack 拷进手机，
 *      App 的「补充包」面板会识别并从 ZIP 里直接读取（含音频 Range）。
 *    仍可用的老分层方式：
 *      六级版  --audio-set=CET6-真题                                    ≈ 900 MB
 *      雅思版  --audio-set=IELTS-剑桥真题                               ≈ 1.7 GB
 *    或者用 --api=<局域网地址>，APK 只装题面与时间轴（几 MB），音频从电脑取。
 */

'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ANDROID_DIR = path.join(ROOT, 'android');
const BUILD_DIR = path.join(ROOT, 'build');
// 构建产物一律放 build/apk/ 子目录：build/ 顶层还住着 OCR 产物与解析结果，
// 不能整个删掉（曾经因为 rmrf(BUILD_DIR) 把 20 分钟的 OCR 成果清空了）。
const APK_BUILD_DIR = path.join(BUILD_DIR, 'apk');
const PUBLIC_DIR = path.join(ROOT, 'public');
const AUDIO_DIR = path.join(ROOT, 'audio');

const { MOBILE_DIR, ensureMobileDir, findPacks } = require(path.join(__dirname, 'paths.js'));

const APP_ID = 'com.dsh.listeningplayer';
const NO_AUDIO = process.argv.includes('--no-audio');
const API_BASE = (process.argv.find((a) => a.startsWith('--api=')) || '').split('=')[1] || '';
// --audio-set=A,B 只打包这些 audio/ 下的顶层目录（分层打包，控制体积）
const AUDIO_SET = ((process.argv.find((a) => a.startsWith('--audio-set=')) || '').split('=')[1] || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
// --out=xxx.apk 指定产物文件名（相对路径落在「Whale-Lite-手机版」目录里）
// 默认名跟着打包范围走：分档打包叫 lite，整包叫 listening-player，避免互相覆盖
const OUT_NAME = (process.argv.find((a) => a.startsWith('--out=')) || '').split('=')[1]
  || (AUDIO_SET.length ? 'listening-player-lite.apk' : 'listening-player.apk');

// ---------------------------------------------------------------- 环境探测

function findSdk() {
  const cands = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    'F:\\DSH workshop\\android-sdk',
    path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk'),
    path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'Android', 'Sdk'),
  ].filter(Boolean);

  for (const c of cands) {
    if (fs.existsSync(path.join(c, 'platforms')) && fs.existsSync(path.join(c, 'build-tools'))) return c;
  }
  return null;
}

function findJavaHome() {
  const cands = [
    process.env.JAVA_HOME,
    'F:\\JAVA',
    'C:\\Program Files\\Java\\jdk-17',
    'C:\\Program Files\\Eclipse Adoptium\\jdk-17.0.13.11-hotspot',
  ].filter(Boolean);
  for (const c of cands) {
    if (c && fs.existsSync(path.join(c, 'bin', 'javac.exe'))) return c;
  }
  // 退回 PATH 上的 javac
  try {
    execFileSync('javac', ['-version'], { stdio: 'ignore' });
    return '';
  } catch { return null; }
}

function newestDir(parent) {
  if (!fs.existsSync(parent)) return null;
  const dirs = fs.readdirSync(parent, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return dirs.length ? path.join(parent, dirs[0]) : null;
}

// ---------------------------------------------------------------- 工具

let runCounter = 0;

function run(cmd, args, opts = {}) {
  // Windows 上 .bat/.cmd 不能被 execFileSync 直接 spawn（会报 EINVAL）。
  // 而用 cmd /c 拼接命令又会被路径里的空格搞乱（本项目路径含 "DSH workshop"），
  // 所以最稳的做法是：把整条命令写进一个临时 .bat，再执行这个 .bat。
  const isBatch = /\.(bat|cmd)$/i.test(cmd);

  if (!isBatch) {
    return execFileSync(cmd, args, {
      stdio: opts.quiet ? 'pipe' : 'inherit',
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 256 * 1024 * 1024,
      ...opts,
    });
  }

  const tmp = path.join(BUILD_DIR, `_cmd-${++runCounter}.bat`);
  const quote = (s) => (/[\s&()^]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
  const line = ['@echo off', [quote(cmd), ...args.map(quote)].join(' '), 'exit /b %errorlevel%'].join('\r\n');
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  fs.writeFileSync(tmp, line + '\r\n', 'utf8');

  try {
    return execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', tmp], {
      stdio: opts.quiet ? 'pipe' : 'inherit',
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 256 * 1024 * 1024,
      ...opts,
    });
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 清理失败无妨 */ }
  }
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function human(bytes) {
  if (bytes > 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
  if (bytes > 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  if (bytes > 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

async function dirSize(dir) {
  let total = 0;
  const walk = async (d) => {
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) { try { total += (await fsp.stat(full)).size; } catch { /* 忽略 */ } }
    }
  };
  await walk(dir);
  return total;
}

async function copyDir(src, dest, filter, rel = '') {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    const r = rel ? rel + '/' + e.name : e.name;
    // ⚠️ 过滤器同时收到绝对路径 s 和【相对路径 r】。
    //    早先只有 s，而 s 是绝对路径（如 "F:\\…\\audio\\CET6-真题"），
    //    按 split()[0] 取顶层目录会得到 "F:"，分层打包的判断永远不成立，
    //    结果是 APK 里一个音频都没有。要用 r 判断。
    if (filter && !filter(s, e, r)) continue;
    if (e.isDirectory()) await copyDir(s, d, filter, r);
    else if (e.isFile()) await fsp.copyFile(s, d);
  }
}

// ---------------------------------------------------------------- 补充包清单
//
// 单个 APK 有 2 GiB 硬上限（ZIP 中央目录用 32 位记录大小），本机素材约 3.0 GB
// 装不进一个安装包，所以拆成「安装包 + 补充包（.lppack）」：
//   安装包  = 前端 + 演示语料（几十 MB），随时能装
//   补充包  = 某个素材目录的完整内容，单独拷进手机后在 App 里读取
// 这里把项目目录下已打好的 .lppack 列成一份清单塞进 APK，
// 好让 App 的「补充包」面板能显示「哪些包可装、哪些还没装」。

/**
 * 只读 ZIP 的第一个条目（补充包把 manifest.json 放在最前面）。
 *
 * ⚠️ 不能 readFileSync：雅思补充包 1.9 GB，整个读进内存会直接把构建搞崩。
 *    这里只读本地头 + 该条目的数据。
 */
function readFirstZipEntry(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(30);
    if (fs.readSync(fd, head, 0, 30, 0) !== 30) return null;
    if (head.readUInt32LE(0) !== 0x04034b50) return null;

    const method = head.readUInt16LE(8);
    const compSize = head.readUInt32LE(18);
    const nameLen = head.readUInt16LE(26);
    const extraLen = head.readUInt16LE(28);
    // 数据描述符（flag bit 3）或超大条目：只可能是异常文件，不猜
    if (compSize === 0 || compSize > 8 * 1024 * 1024) return null;

    const nameBuf = Buffer.alloc(nameLen);
    fs.readSync(fd, nameBuf, 0, nameLen, 30);
    const data = Buffer.alloc(compSize);
    fs.readSync(fd, data, 0, compSize, 30 + nameLen + extraLen);

    const raw = method === 8 ? zlib.inflateRawSync(data) : data;
    return { name: nameBuf.toString('utf8'), text: raw.toString('utf8') };
  } finally {
    fs.closeSync(fd);
  }
}

/** 扫描项目根目录下的 .lppack，生成 { file, set, lessons, sizeBytes } 清单 */
function buildPackCatalog() {
  const packs = [];
  for (const abs of findPacks()) {
    const f = path.basename(abs);
    const entry = { id: f.replace(/\.lppack$/i, ''), file: f, sizeBytes: fs.statSync(abs).size,
      set: '', lessons: 0, version: 0, hasLibrary: false };
    try {
      const first = readFirstZipEntry(abs);
      if (first && first.name === 'manifest.json') {
        const m = JSON.parse(first.text);
        if (m.format === 'listening-player-pack') {
          entry.set = m.set || '';
          entry.lessons = Number(m.lessons) || 0;
          entry.version = Number(m.version) || 0;
          // v1 的包没有 library.json，App 侧会明确报「旧版补充包」
          entry.hasLibrary = m.hasLibrary === true || entry.version >= 2;
        }
      }
    } catch (err) {
      console.log(`      ⚠ 读 ${f} 的 manifest 失败：${err.message}`);
    }
    packs.push(entry);
  }
  return { generatedAt: new Date().toISOString(), packs };
}

// ---------------------------------------------------------------- ZIP 重打包
//
// 为什么自己写：见第 6 步的注释。jar uf 在 Windows 上会写入反斜杠条目名，
// 而 Android 只认正斜杠。这里实现最小的 ZIP 读取 + 写入，只用 node 内置模块。

/** 解析 ZIP，返回 [{name, method, data, crc, size}]（data 为解压后的原始字节） */
function readZip(file) {
  const buf = fs.readFileSync(file);

  // 找中央目录结尾记录（EOCD）
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是合法的 ZIP：' + file);

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('中央目录损坏 @' + off);
    const method = buf.readUInt16LE(off + 10);
    const crc = buf.readUInt32LE(off + 16);
    const compSize = buf.readUInt32LE(off + 20);
    const rawSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);

    // 读本地头，定位数据
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('本地头损坏 @' + localOff);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === 0) data = Buffer.from(comp);
    else if (method === 8) data = zlib.inflateRawSync(comp);
    else throw new Error('不支持的压缩方法 ' + method + '（' + name + '）');

    out.push({ name, method, data, crc, size: rawSize });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** 列出 ZIP 内所有条目名 */
function listZipNames(file) {
  return readZip(file).map((e) => e.name);
}

/**
 * 必须【原样存放】（不压缩）的条目。
 *
 * `resources.arsc` 是硬性要求：targetSdk ≥ 30 时，Android 11+ 的安装器会直接拒绝
 * 「resources.arsc 被压缩或未 4 字节对齐」的 APK（报 -124 Failed parse during installPackageLI）。
 * ⚠️ 这个错误只有在真机/模拟器上 `adb install` 才会暴露，本机怎么构建都是「成功」的。
 */
const MUST_STORE = new Set(['resources.arsc']);

/** 把 entries 追加到 srcZip，输出 dstZip（保留原压缩方式，条目名强制正斜杠） */
function addEntriesToZip(srcZip, entries, dstZip) {
  const existing = readZip(srcZip).filter((e) => !e.name.endsWith('/'));  // 丢掉目录条目

  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of [...existing, ...entries]) {
    const name = Buffer.from(String(e.name).replace(/\\/g, '/'), 'utf8');
    const data = e.data;
    const crc = crc32(data);

    // ⚠️ 保留 aapt2 原本的压缩方式，别一律 deflate：
    //    · 音频/图片等素材 aapt2 本来就按「不压缩」存放，而 MainActivity 是用
    //      getAssets().openFd() 去定位字节区间的 —— 压缩过的条目根本拿不到 FileDescriptor，
    //      结果是「进度条拖不动 / 一播放就报音频加载失败」。
    //    · resources.arsc 一旦被压缩，Android 11+ 直接拒绝安装。
    const store = e.method === 0 || MUST_STORE.has(String(e.name));
    const comp = store ? data : zlib.deflateRawSync(data, { level: 9 });
    const method = store ? 0 : 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // flag: UTF-8 名字
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);          // time
    local.writeUInt16LE(0x21, 12);       // date（固定值，保证可复现）
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);          // extra len

    locals.push(local, name, comp);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);        // version made by
    central.writeUInt16LE(20, 6);        // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);        // extra
    central.writeUInt16LE(0, 32);        // comment
    central.writeUInt16LE(0, 34);        // disk
    central.writeUInt16LE(0, 36);        // internal attrs
    central.writeUInt32LE(0, 38);        // external attrs
    central.writeUInt32LE(offset, 42);

    centrals.push(central, name);
    offset += local.length + name.length + comp.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE((existing.length + entries.length), 8);
  eocd.writeUInt16LE((existing.length + entries.length), 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  fs.writeFileSync(dstZip, Buffer.concat([...locals, centralBuf, eocd]));
}

// ---------------------------------------------------------------- 成品自检
//
// 「构建成功」≠「装得上、播得了」。这两件事只有在 APK 里查才看得见：
//   · resources.arsc 被压缩/没对齐 → Android 11+ 拒绝安装（真机上才报错）
//   · 音频素材被压缩 → getAssets().openFd() 拿不到描述符 → Range 失效、播不出声

/** 只读中央目录与本地头，不把整个 APK 读进内存 */
function inspectZip(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65536 + 22);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是合法的 ZIP：' + file);

    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOff = tail.readUInt32LE(eocd + 16);
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOff);

    const out = [];
    let off = 0;
    for (let i = 0; i < count; i++) {
      const method = cd.readUInt16LE(off + 10);
      const nameLen = cd.readUInt16LE(off + 28);
      const extraLen = cd.readUInt16LE(off + 30);
      const commentLen = cd.readUInt16LE(off + 32);
      const localOff = cd.readUInt32LE(off + 42);
      const name = cd.toString('utf8', off + 46, off + 46 + nameLen);

      const head = Buffer.alloc(30);
      fs.readSync(fd, head, 0, 30, localOff);
      const dataOffset = localOff + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
      out.push({ name, method, dataOffset });
      off += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

/** 检查成品 APK 的打包方式；返回问题列表（空数组 = 没问题） */
function checkPackaging(apk) {
  const entries = inspectZip(apk);
  const problems = [];

  const arsc = entries.find((e) => e.name === 'resources.arsc');
  if (!arsc) {
    problems.push('APK 里找不到 resources.arsc');
  } else if (arsc.method !== 0) {
    problems.push('resources.arsc 被压缩了 —— Android 11+ 会拒绝安装（-124）');
  } else if (arsc.dataOffset % 4 !== 0) {
    problems.push(`resources.arsc 未做 4 字节对齐（数据偏移 ${arsc.dataOffset}）`);
  }

  const media = entries.filter((e) => /^assets\/.*\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|mp4)$/i.test(e.name));
  const packed = media.filter((e) => e.method !== 0);
  if (packed.length) {
    problems.push(`${packed.length}/${media.length} 个音频素材被压缩存放 —— `
      + 'getAssets().openFd() 只能读未压缩资源，会导致音频播不出、进度条拖不动（例：'
      + packed.slice(0, 2).map((e) => e.name).join('、') + '）');
  }

  return { problems, arsc, mediaCount: media.length, entryCount: entries.length };
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------- 主流程

async function main() {
  console.log('\n=== 构建 Android APK ===\n');

  const sdk = findSdk();
  if (!sdk) {
    console.error('[错误] 没有找到 Android SDK。');
    console.error('  请安装 Android SDK（含 platforms/android-34 与 build-tools/34.0.0），');
    console.error('  或设置环境变量 ANDROID_HOME 指向 SDK 目录。');
    process.exit(1);
  }
  const javaHome = findJavaHome();
  if (javaHome === null) {
    console.error('[错误] 没有找到 JDK（需要 javac 与 keytool）。请安装 JDK 17 或设置 JAVA_HOME。');
    process.exit(1);
  }
  // ⚠️ 必须把找到的 JDK **导出到本进程的环境**里。
  //    build-tools 里的 d8.bat / apksigner.bat 自己不找 java，只看 JAVA_HOME 和 PATH；
  //    以前这里只是把 javaHome 用在 javac/keytool 的绝对路径上，于是
  //    「明明找得到 F:\JAVA，却报 JAVA_HOME is not set」—— 构建随机失败，
  //    完全取决于调用它的那个 shell 有没有 JAVA_HOME。踩过一次，别删这两行。
  if (!process.env.JAVA_HOME) process.env.JAVA_HOME = javaHome;
  process.env.PATH = path.join(javaHome, 'bin') + path.delimiter + (process.env.PATH || '');

  const buildTools = newestDir(path.join(sdk, 'build-tools'));
  const platform = newestDir(path.join(sdk, 'platforms'));
  if (!buildTools || !platform) {
    console.error('[错误] SDK 里缺少 build-tools 或 platforms，请用 sdkmanager 安装。');
    process.exit(1);
  }

  const exe = (n) => {
    const p = path.join(buildTools, n);
    return fs.existsSync(p) ? p : path.join(buildTools, n.replace(/\.exe$/, '') + (process.platform === 'win32' ? '.exe' : ''));
  };
  const aapt2 = exe('aapt2.exe');
  const d8 = path.join(buildTools, 'd8.bat');
  const zipalign = exe('zipalign.exe');
  const apksigner = path.join(buildTools, 'apksigner.bat');
  const androidJar = path.join(platform, 'android.jar');
  const javac = javaHome ? path.join(javaHome, 'bin', 'javac.exe') : 'javac';
  const keytool = javaHome ? path.join(javaHome, 'bin', 'keytool.exe') : 'keytool';

  console.log('  SDK       : ' + sdk);
  console.log('  build-tools: ' + path.basename(buildTools));
  console.log('  platform  : ' + path.basename(platform));
  console.log('  JDK       : ' + (javaHome || '(PATH)'));
  console.log('');

  // ⚠️ 只清理【本脚本自己的】构建临时目录，绝不能 rmrf 整个 build/。
  //    build/ 里还放着其它工具的重要产物：
  //      build/ocr-answers/    答案页 OCR（跑一次约 3.5 分钟）
  //      build/ocr-listening/  原题页 OCR（跑一次约 20 分钟）
  //      build/cambridge-answers.json / cambridge-papers.json
  //    早先这里直接 rmrf(BUILD_DIR)，把上面这些全删了，代价是重跑 20 分钟 OCR。
  rmrf(APK_BUILD_DIR);
  fs.mkdirSync(APK_BUILD_DIR, { recursive: true });

  // ---------- 1. 生成 bundle.json ----------
  console.log('[1/6] 生成课程数据 bundle.json …');
  const { buildLibrary } = require(path.join(ROOT, 'lib', 'library.js'));
  let lessons = await buildLibrary(AUDIO_DIR);

  // 分层打包时必须同步过滤课程列表：
  // 否则 bundle.json 里仍列着没打进包的课程，用户点进去只会得到「音频不存在」。
  // manifest.folder 是相对 audio/ 的目录名，与 AUDIO_SET 同口径。
  if (AUDIO_SET.length) {
    const before = lessons.length;
    lessons = lessons.filter((l) => AUDIO_SET.includes(l.manifest.folder));
    console.log(`      按 --audio-set 过滤课程：${before} → ${lessons.length} 个`);
  }

  if (!lessons.length) {
    console.warn('      ⚠ audio/ 里没有素材，APK 装上去会是空的。');
    console.warn('        先运行：node tools/fetch-resources.js all');
  }

  const transcriptBytes = lessons.reduce((n, l) => n + (l.transcript || '').length, 0);
  const dropTranscript = transcriptBytes > 25 * 1024 * 1024;

  const bundle = {
    generatedAt: new Date().toISOString(),
    source: 'listening-player',
    apiBase: API_BASE || '',
    transcriptDropped: dropTranscript,
    count: lessons.length,
    lessons: lessons.map((l) => ({
      manifest: l.manifest,
      lines: l.lines,
      questions: l.questions,
      transcript: dropTranscript ? '' : l.transcript,
    })),
  };
  const bundlePath = path.join(APK_BUILD_DIR, 'bundle.json');
  fs.writeFileSync(bundlePath, JSON.stringify(bundle), 'utf8');
  console.log(`      ${lessons.length} 个课程，bundle ${human(fs.statSync(bundlePath).size)}`
    + (dropTranscript ? '（原文过长已省略）' : ''));

  // ---------- 2. 组装 assets/www ----------
  console.log('[2/6] 组装 assets/www …');
  const assetsWww = path.join(APK_BUILD_DIR, 'assets', 'www');
  await copyDir(PUBLIC_DIR, assetsWww, (s) => !path.basename(s).startsWith('_'));
  fs.copyFileSync(bundlePath, path.join(assetsWww, 'bundle.json'));

  if (!NO_AUDIO) {
    const audioDest = path.join(assetsWww, 'audio');
    // 分层打包：--audio-set=IELTS-剑桥真题,CET6-真题 只打这些目录。
    // 3 GB 素材全打进去不现实（安装体验极差），所以支持按需分档：
    //   精简版 --audio-set=CET4-演示,CET6-演示,IELTS-演示,TOEFL-演示   （几十 MB）
    //   基础版 再加 CET6-真题                                          （约 900 MB）
    //   雅思版 再加 IELTS-剑桥真题                                      （约 2 GB）
    //   完整版 不带该参数
    await copyDir(AUDIO_DIR, audioDest, (s, e, rel) => {
      if (e.isFile() && /\.(duration|tmp|bak)$/i.test(e.name)) return false;
      if (AUDIO_SET.length) {
        // rel 是相对 audio/ 的路径，第一段就是素材目录名
        const top = String(rel).split('/')[0];
        if (!AUDIO_SET.includes(top)) return false;
      }
      return true;
    });
    const audioSize = await dirSize(audioDest);
    console.log(`      音频素材 ${human(audioSize)}${AUDIO_SET.length ? `（仅 ${AUDIO_SET.join(', ')}）` : '（全部）'}`);
  } else {
    console.log('      （--no-audio：未打包音频）');
  }

  // 如果指定了远端 API，写一个覆盖配置让前端优先连它
  if (API_BASE) {
    fs.writeFileSync(path.join(assetsWww, 'config.js'),
      `window.__PLAYER_API_BASE__ = ${JSON.stringify(API_BASE)};\n`, 'utf8');
    console.log(`      API 指向 ${API_BASE}`);
  }

  // 补充包清单：让 App 的「补充包」面板知道有哪些包可装（见本文件上方的说明）
  const catalog = buildPackCatalog();
  fs.writeFileSync(path.join(assetsWww, 'packs-catalog.json'),
    JSON.stringify(catalog, null, 2), 'utf8');
  if (catalog.packs.length) {
    const brief = catalog.packs
      .map((p) => `${p.file}${p.set ? `（${p.set}·${p.lessons} 门课）` : ''}`)
      .join('、');
    console.log(`      补充包清单：${brief}`);
  } else {
    console.log('      补充包清单：项目目录下还没有 .lppack（不影响安装，App 里拷进去也能识别）');
  }

  const assetsSize = await dirSize(path.join(APK_BUILD_DIR, 'assets'));
  console.log(`      assets 合计 ${human(assetsSize)}`);

  // ---------- 3. aapt2 ----------
  console.log('[3/6] 编译资源并链接 APK（aapt2）…');
  const compiledDir = path.join(APK_BUILD_DIR, 'compiled');
  fs.mkdirSync(compiledDir, { recursive: true });

  // 编译 res/ 下所有文件
  const resFiles = [];
  const collectRes = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) collectRes(full);
      else resFiles.push(full);
    }
  };
  const resDir = path.join(ANDROID_DIR, 'res');
  if (fs.existsSync(resDir)) collectRes(resDir);

  if (resFiles.length) {
    run(aapt2, ['compile', '-o', compiledDir, ...resFiles], { quiet: true });
  }

  const flatFiles = [];
  const collectFlat = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) collectFlat(full);
      else if (e.name.endsWith('.flat')) flatFiles.push(full);
    }
  };
  collectFlat(compiledDir);

  const unalignedApk = path.join(APK_BUILD_DIR, 'app-unaligned.apk');
  const linkArgs = [
    'link',
    '-o', unalignedApk,
    '-I', androidJar,
    '--manifest', path.join(ANDROID_DIR, 'AndroidManifest.xml'),
    '-A', path.join(APK_BUILD_DIR, 'assets'),
    '--min-sdk-version', '24',
    '--target-sdk-version', '34',
    '--version-code', '1',
    '--version-name', '1.0',
    ...flatFiles,
  ];
  run(aapt2, linkArgs, { quiet: true });
  console.log(`      基础 APK ${human(fs.statSync(unalignedApk).size)}`);

  // ---------- 4. javac ----------
  console.log('[4/6] 编译 Java 源码 …');
  const classesDir = path.join(APK_BUILD_DIR, 'classes');
  fs.mkdirSync(classesDir, { recursive: true });

  const javaFiles = [];
  const collectJava = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) collectJava(full);
      else if (e.name.endsWith('.java')) javaFiles.push(full);
    }
  };
  collectJava(path.join(ANDROID_DIR, 'src'));

  run(javac, [
    '-source', '8', '-target', '8',
    '-encoding', 'UTF-8',
    '-bootclasspath', androidJar,
    '-classpath', androidJar,
    '-d', classesDir,
    ...javaFiles,
  ], { quiet: true });

  // ---------- 5. d8 ----------
  console.log('[5/6] 转 dex（d8）…');
  const classFiles = [];
  const collectClass = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) collectClass(full);
      else if (e.name.endsWith('.class')) classFiles.push(full);
    }
  };
  collectClass(classesDir);

  const dexOut = path.join(APK_BUILD_DIR, 'dex');
  fs.mkdirSync(dexOut, { recursive: true });
  run(d8, [
    '--min-api', '24',
    '--output', dexOut,
    '--lib', androidJar,
    ...classFiles,
  ], { quiet: true });

  // ---------- 6. 打包 + 对齐 + 签名 ----------
  console.log('[6/6] 打包 classes.dex、对齐并签名 …');

  // 关键点：不能用 jar uf 往 APK 里塞 dex。
  // Windows 上的 jar 会把条目名写成 assets\www\app.js（反斜杠），
  // 而 Android 的 asset 查找只认正斜杠 —— 结果就是装上去白屏。
  // 这里用最小 ZIP 读写自己重打包，保证条目名一律是正斜杠。
  const dexFiles = fs.readdirSync(dexOut).filter((f) => f.endsWith('.dex'));
  const withDex = path.join(APK_BUILD_DIR, 'app-with-dex.apk');
  addEntriesToZip(unalignedApk, dexFiles.map((f) => ({
    name: f,
    data: fs.readFileSync(path.join(dexOut, f)),
  })), withDex);
  console.log(`      并入 ${dexFiles.join(', ')}`);

  // 自检：条目名必须是正斜杠，且不含盘符/绝对路径
  const bad = listZipNames(withDex).filter((n) => n.includes('\\') || /^[A-Za-z]:/.test(n) || n.startsWith('/'));
  if (bad.length) {
    console.error('      [错误] APK 内条目名不合法：' + bad.slice(0, 5).join(', '));
    process.exit(1);
  }

  // zipalign（4 字节对齐；-p 让 .so 页对齐，兼容 mmap 加载）
  const aligned = path.join(APK_BUILD_DIR, 'app-aligned.apk');
  run(zipalign, ['-f', '-p', '4', withDex, aligned], { quiet: true });

  // 签名：没有 keystore 就现场生成一个调试用的
  const ksDir = path.join(ROOT, 'android', 'keystore');
  const ksPath = path.join(ksDir, 'debug.keystore');
  const ksPass = 'android';
  if (!fs.existsSync(ksPath)) {
    fs.mkdirSync(ksDir, { recursive: true });
    console.log('      生成调试签名证书 …');
    run(keytool, [
      '-genkeypair',
      '-keystore', ksPath,
      '-alias', 'androiddebugkey',
      '-storepass', ksPass,
      '-keypass', ksPass,
      '-keyalg', 'RSA',
      '-keysize', '2048',
      '-validity', '10000',
      '-dname', 'CN=Android Debug,O=Android,C=US',
    ], { quiet: true });
  }

  // ⚠️ 签名产物先落在 build/ 下的 ASCII 路径。
  //    apksigner 是通过临时 .bat 调用的，而 cmd 解析含中文的 .bat 会错位
  //    （HANDOFF 踩坑 1）；产物最后再用 Node 的 fs 拷到「Whale-Lite-手机版」。
  const signedApk = path.join(APK_BUILD_DIR, 'signed.apk');
  rmrf(signedApk);

  try {
    run(apksigner, [
      'sign',
      '--ks', ksPath,
      '--ks-pass', `pass:${ksPass}`,
      '--key-pass', `pass:${ksPass}`,
      '--ks-key-alias', 'androiddebugkey',
      '--out', signedApk,
      aligned,
    ], { quiet: true });

    // 校验签名
    run(apksigner, ['verify', '--print-certs', signedApk], { quiet: true });
    console.log('      apksigner 签名与校验通过');
  } catch (err) {
    console.warn('      ⚠ apksigner 失败，退回 jarsigner（v1 签名）：' + String(err.message).split('\n')[0]);
    fs.copyFileSync(aligned, signedApk);
    const jarsigner = javaHome ? path.join(javaHome, 'bin', 'jarsigner.exe') : 'jarsigner';
    run(jarsigner, [
      '-keystore', ksPath,
      '-storepass', ksPass,
      '-keypass', ksPass,
      '-sigalg', 'SHA256withRSA',
      '-digestalg', 'SHA-256',
      signedApk,
      'androiddebugkey',
    ], { quiet: true });
  }

  // 放到交付目录（手机要用的东西都在那一个文件夹里）
  const finalApk = path.isAbsolute(OUT_NAME) ? OUT_NAME : path.join(ensureMobileDir(), OUT_NAME);
  fs.mkdirSync(path.dirname(finalApk), { recursive: true });
  if (path.resolve(finalApk) !== path.resolve(signedApk)) fs.copyFileSync(signedApk, finalApk);

  const size = fs.statSync(finalApk).size;

  // ---------- 7. 成品自检 ----------
  // 这两类问题在构建阶段完全看不出来，只有装到机器上（或在这里查）才会暴露：
  //   · resources.arsc 压缩/未对齐 → Android 11+ 拒绝安装
  //   · 音频素材被压缩 → getAssets().openFd() 拿不到描述符 → 播不出声、进度条拖不动
  const check = checkPackaging(finalApk);
  if (check.problems.length) {
    console.error('');
    console.error('='.repeat(52));
    console.error('  [打包自检失败] 这个 APK 装到 Android 11+ 上会有问题：');
    for (const p of check.problems) console.error('    · ' + p);
    console.error('');
    console.error('  说明：这类问题本机构建不会报错，必须真机/模拟器 adb install 才会暴露。');
    console.error('='.repeat(52));
    process.exit(1);
  }
  console.log(`      打包自检通过：resources.arsc 未压缩且 ${check.arsc.dataOffset % 4 === 0 ? '4 字节对齐' : '对齐异常'}`
    + `，${check.mediaCount} 个音频素材均为未压缩存放`);

  console.log('');
  console.log('='.repeat(52));
  console.log('  APK 构建成功');
  console.log('  文件：' + finalApk);
  console.log('  体积：' + human(size));
  console.log('');
  console.log('  安装到手机（USB 调试打开后）：');
  console.log(`    "${path.join(sdk, 'platform-tools', 'adb.exe')}" install -r "${finalApk}"`);
  console.log('');  if (!NO_AUDIO) {
    console.log('  提示：APK 里已内置所选素材，手机上完全离线可用。');
    console.log('  雅思/六级全量素材走补充包：把 .lppack 拷到');
    console.log('    /sdcard/Android/data/com.dsh.listeningplayer/files/packs/');
    console.log('  或装好 App 后在右上角「补充包」里导入。');
    console.log(`  补充包与 APK 都在：${MOBILE_DIR}`);
  }
  console.log('='.repeat(52));
  console.log('');
}

main().catch((err) => {
  console.error('\n[构建失败] ' + err.message);
  if (err.stdout) console.error(String(err.stdout).slice(-3000));
  if (err.stderr) console.error(String(err.stderr).slice(-3000));
  process.exit(1);
});

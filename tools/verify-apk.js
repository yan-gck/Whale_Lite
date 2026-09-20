#!/usr/bin/env node
/**
 * verify-apk.js — 构建后自检：确认 APK 里真的有该有的东西
 *
 * 为什么需要：APK 构建脚本是自写的（aapt2 + javac + d8 + 自写 ZIP 重打包），
 * 「构建成功」不等于「装上去能用」。这里直接在成品 APK 里查：
 *   · 前端资源是否齐全（app.js / index.html / bundle.json / packs-catalog.json）
 *   · 补充包清单是否带上、中文名有没有坏
 *   · 精简版有没有把雅思/六级素材又塞回来（体积失控的典型症状）
 *   · classes.dex 里有没有补充包相关的类与常量（URL 前缀、JS 桥方法名）
 *
 * 用法：
 *   node tools/verify-apk.js listening-player-lite.apk
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { openZip } = require(path.join(__dirname, 'pack-info.js'));
const { resolveDeliverable, MOBILE_DIR } = require(path.join(__dirname, 'paths.js'));

const apk = process.argv[2]
  ? path.resolve(process.argv[2])
  : resolveDeliverable('listening-player-lite.apk');

if (!fs.existsSync(apk)) {
  console.error(`\n找不到 APK：${apk}`);
  console.error('先构建：node tools/build-apk.js --audio-set=CET4-演示,CET6-演示,IELTS-演示,TOEFL-演示\n');
  process.exit(2);
}
const zip = openZip(apk);
let bad = 0;
const ok = (cond, what) => {
  console.log(`  ${cond ? '✓' : '✗'} ${what}`);
  if (!cond) bad++;
};

console.log(`\n检查 ${path.basename(apk)}（${(zip.size / 1048576).toFixed(1)} MB，${zip.entries.size} 个条目）\n`);

// ---------- assets ----------
const names = [...zip.entries.keys()];
ok(names.includes('assets/www/app.js'), 'assets/www/app.js 存在');
ok(names.includes('assets/www/index.html'), 'assets/www/index.html 存在');
ok(names.includes('assets/www/packs-catalog.json'), 'assets/www/packs-catalog.json 存在');
ok(names.includes('classes.dex'), 'classes.dex 存在');

const catalog = JSON.parse(zip.readText('assets/www/packs-catalog.json'));
ok(catalog.packs.length >= 2, `补充包清单里有 ${catalog.packs.length} 个包`);
for (const p of catalog.packs) {
  ok(!!p.set && p.lessons > 0 && p.hasLibrary, `  清单项：${p.file} → ${p.set} / ${p.lessons} 门课 / v${p.version}`);
}

const appJs = zip.readText('assets/www/app.js');
ok(appJs.includes('AndroidHost'), 'app.js 使用 AndroidHost 桥');
ok(appJs.includes("'pack/'"), 'app.js 拼 pack/ URL 空间');
ok(appJs.includes("'/audio/'"), 'app.js 在包内定位 audio/ 目录');
ok(appJs.includes('__onPackEvent'), 'app.js 处理导入事件回调');

const indexHtml = zip.readText('assets/www/index.html');
for (const id of ['btnPacks', 'packDrawer', 'packList', 'packProgress', 'btnImportPack']) {
  ok(indexHtml.includes(`id="${id}"`), `index.html 里有 #${id}`);
}

const bundle = JSON.parse(zip.readText('assets/www/bundle.json'));
ok(bundle.count === 5, `bundle.json 里是精简版的 5 门演示课（实际 ${bundle.count}）`);

// 精简版不能把雅思/六级素材塞回来
const big = names.filter((n) => /^assets\/www\/audio\/(IELTS-剑桥真题|CET6-真题)\//.test(n));
ok(big.length === 0, `APK 里没有雅思/六级全量素材（找到 ${big.length} 个条目）`);

// ---------- classes.dex ----------
const dex = zip.read('classes.dex');
const dexStr = dex.toString('latin1');
for (const s of [
  'com/dsh/listeningplayer/MainActivity',
  'com/dsh/listeningplayer/MainActivity$HostBridge',
  'com/dsh/listeningplayer/PackStore',
  'com/dsh/listeningplayer/HttpRange',
  'com/dsh/listeningplayer/Streams',
  'com/dsh/listeningplayer/PlaybackService',
  'listening-player-pack',
  '/android_asset/www/pack/',
  'AndroidHost',
  'packTextChunk',
  'importPack',
  'deletePack',
  'rescanPacks',
  'library.json',
  'setPlaybackState',
  'stopPlayback',
  'sendCommand',
]) {
  ok(dexStr.includes(s), `classes.dex 含 ${s}`);
}
// 中文常量（UTF-8 在 dex 里是 MUTF-8，直接找 UTF-8 字节即可）
ok(dex.includes(Buffer.from('补充包', 'utf8')), 'classes.dex 含中文提示文案（补充包）');
ok(dex.includes(Buffer.from('不是补充包：缺少 manifest.json', 'utf8')), 'classes.dex 含校验失败原因');
ok(dex.includes(Buffer.from('上一句', 'utf8')) && dex.includes(Buffer.from('已暂停', 'utf8')),
  'classes.dex 含通知栏文案（上一句/已暂停）');

// ---------- 后台保活：清单必须声明服务类型 ----------
//
// 注意：android:foregroundServiceType 是 flags 属性，aapt2 会把它编译成整数
// （mediaPlayback = 0x2），所以不能在 APK 字节里找 "mediaPlayback" 字符串 ——
// 那正是「看起来检查了、其实永远查不到」的假检查。这里用 aapt2 反解清单。
const AAPT2_CANDIDATES = [
  process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, 'F:\\DSH workshop\\android-sdk',
].filter(Boolean);
let aapt2 = null;
for (const sdk of AAPT2_CANDIDATES) {
  const dir = path.join(sdk, 'build-tools');
  if (!fs.existsSync(dir)) continue;
  const ver = fs.readdirSync(dir).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
  const exe = path.join(dir, ver, 'aapt2.exe');
  if (fs.existsSync(exe)) { aapt2 = exe; break; }
}

if (!aapt2) {
  ok(false, '找不到 aapt2（设置 ANDROID_HOME），无法核对清单里的服务声明');
} else {
  const { execFileSync } = require('node:child_process');
  const tree = execFileSync(aapt2, ['dump', 'xmltree', '--file', 'AndroidManifest.xml', apk],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

  ok(/PlaybackService/.test(tree), '清单里声明了 PlaybackService');
  const svcLine = tree.split(/\r?\n/).find((l) => l.includes('foregroundServiceType')) || '';
  // aapt2 打出来的是 0x00000002 这种补零写法，别写成 0x2 就完事
  ok(/=0x0*2\b/.test(svcLine),
    `foregroundServiceType 是 mediaPlayback（0x2）：${svcLine.trim() || '(没有该属性)'}`);
  for (const p of ['FOREGROUND_SERVICE_MEDIA_PLAYBACK', 'WAKE_LOCK', 'POST_NOTIFICATIONS']) {
    ok(tree.includes(p), `清单里申请了 ${p}`);
  }
  ok(!/READ_EXTERNAL|WRITE_EXTERNAL|MANAGE_EXTERNAL|READ_MEDIA/.test(tree),
    '清单里没有任何存储权限');
}

console.log(`\n${bad ? `✗ ${bad} 项未通过` : '✅ 全部通过'}\n`);
zip.close();
process.exit(bad ? 1 : 0);

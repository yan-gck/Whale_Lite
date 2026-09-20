#!/usr/bin/env node
/**
 * probe-device.js — 在真机 / 模拟器上检查这个 App（走 Chrome DevTools 协议）
 *
 * 为什么需要：
 *   无头浏览器里的探针（tools/probe-frontend.js）验的是「代码逻辑」，
 *   但 WebView 的真实环境是另一回事 —— file:// 的 fetch 被拦、assets 路径、
 *   压缩方式、权限、后台策略，这些只有装到机器上才看得见。
 *   本项目就栽过两次：APK 里 resources.arsc 被压缩（Android 11+ 直接拒绝安装）、
 *   以及 file:// 下 fetch('bundle.json') 被拦（课程列表永远空白）。
 *
 * 前置：MainActivity 里开了 WebView.setWebContentsDebuggingEnabled(true)；
 *       设备已连上 adb（MuMu 模拟器：adb connect 127.0.0.1:7555）。
 *
 * 用法：
 *   node tools/probe-device.js                 # 默认检查：课程列表 / 音频地址 / 播放 / 保活
 *   node tools/probe-device.js --eval "表达式"  # 在页面里跑一段 JS 并打印结果
 *   node tools/probe-device.js --shot 输出.png  # 顺手截个图
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PKG = 'com.dsh.listeningplayer';

function findAdb() {
  const cands = [
    process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, 'platform-tools', 'adb.exe'),
    process.env.ANDROID_SDK_ROOT && path.join(process.env.ANDROID_SDK_ROOT, 'platform-tools', 'adb.exe'),
    'F:\\DSH workshop\\android-sdk\\platform-tools\\adb.exe',
    'E:\\MuMu Player 12\\nx_main\\adb.exe',
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  return 'adb';
}

const ADB = findAdb();
const args = process.argv.slice(2);
let evalArg = (args.find((a) => a.startsWith('--eval=')) || '').slice(7)
  || (args.includes('--eval') ? args[args.indexOf('--eval') + 1] : '');
// --eval-file=xxx.js：复杂脚本请写文件再跑。
// 命令行内联 JS 在 PowerShell 里会被引号转义搞坏（本项目的老教训），
// 一旦脚本里出现 " 或 \"，内联基本必错。
const evalFile = (args.find((a) => a.startsWith('--eval-file=')) || '').slice(12)
  || (args.includes('--eval-file') ? args[args.indexOf('--eval-file') + 1] : '');
if (evalFile) {
  if (!fs.existsSync(evalFile)) {
    console.error(`找不到脚本文件：${evalFile}`);
    process.exit(2);
  }
  evalArg = fs.readFileSync(evalFile, 'utf8');
}
const shotArg = (args.find((a) => a.startsWith('--shot=')) || '').slice(7)
  || (args.includes('--shot') ? args[args.indexOf('--shot') + 1] : '');
// --serial=xxx：同时插着模拟器和真机时，指定要探哪一台（默认优先 MuMu 的 7555）
const serialArg = (args.find((a) => a.startsWith('--serial=')) || '').slice(9)
  || (args.includes('--serial') ? args[args.indexOf('--serial') + 1] : '');

const MUMU_MANAGER = 'E:\\MuMu Player 12\\nx_main\\MuMuManager.exe';

/**
 * 跑一条 adb 命令。
 *
 * ⚠️ 一定要给 timeout：设备掉线时 adb 会一直打印 "waiting for device" 干等，
 *    没有超时就会把整个脚本（以及调用它的会话）挂死 —— 这个坑真踩过，
 *    上一次直接白等了 5 分钟。
 */
function adb(...a) {
  try {
    return execFileSync(ADB, a, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30000,
      killSignal: 'SIGKILL',
    }).trim();
  } catch (err) {
    if (err.killed || err.signal) throw new Error(`adb ${a[0]} 超时（设备可能掉线了）`);
    throw err;
  }
}

function listDevices() {
  let out = '';
  try {
    out = adb('devices');
  } catch {
    return [];
  }
  return out.split(/\r?\n/).slice(1)
    .map((l) => l.trim())
    .filter((l) => /\sdevice$/.test(l))
    .map((l) => l.split(/\s+/)[0]);
}

function pickDevice() {
  let serials = listDevices();
  // 指定了 --serial 就用它（连没连上让下面的调用自己报错，比悄悄换一台好）
  if (serialArg) return serialArg;
  // 没设备时试着自动连一下 MuMu（它监听 7555/5555）
  if (!serials.length) {
    for (const port of ['7555', '5555']) {
      try { adb('connect', `127.0.0.1:${port}`); } catch { /* 连不上就算了 */ }
    }
    serials = listDevices();
  }
  if (!serials.length) return null;
  return serials.find((s) => s.endsWith(':7555')) || serials[0];
}

/** 模拟器没开就把它拉起来（MuMu 开机约 100 秒，耐心等） */
function bootEmulator(waitMs = 240000) {
  if (!fs.existsSync(MUMU_MANAGER)) return false;
  console.log('  模拟器没在运行，尝试用 MuMuManager 启动…');
  try {
    execFileSync(MUMU_MANAGER, ['control', '--vmindex', '0', 'launch'],
      { encoding: 'utf8', timeout: 120000 });
  } catch (err) {
    console.error('  启动失败：' + err.message);
    return false;
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    execFileSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 5'],
      { timeout: 20000 });
    if (pickDevice()) return true;
  }
  return false;
}

/** 页面里跑一段表达式，返回 JSON 化的结果 */
async function evaluate(wsUrl, expression) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
  });
  const result = await new Promise((res) => {
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === 1) res(msg);
    });
    ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true },
    }));
  });
  ws.close();
  if (result.result && result.result.exceptionDetails) {
    throw new Error('页面里报错：' + JSON.stringify(result.result.exceptionDetails.exception || {}));
  }
  return result.result && result.result.result ? result.result.result.value : undefined;
}

/** 锁屏保活实测：播放 → 熄屏 → 检查音频是否还在前进、服务与唤醒锁是否在 */
async function keepAlive(serial, wsUrl) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const state = () => evaluate(wsUrl, `(function(){var a=document.getElementById('audio');
    return {paused:a.paused,t:Math.round((a.currentTime||0)*100)/100,src:a.src,
            title:(document.getElementById('lessonTitle')||{}).textContent||''};})()`);

  console.log('  ① 开始播放');
  await evaluate(wsUrl, `(function(){var a=document.getElementById('audio');
    a.currentTime=5; a.play(); return true;})()`);
  await sleep(2500);
  const before = await state();
  console.log(`     播放中：paused=${before.paused} 位置=${before.t}s`);

  const session = () => adb('-s', serial, 'shell', 'dumpsys', 'media_session')
    .split(/\r?\n/).filter((l) => /state=PlaybackState|package=com\.dsh/.test(l)).slice(0, 4).join(' | ');
  const wake = () => adb('-s', serial, 'shell', 'dumpsys', 'power')
    .split(/\r?\n/).filter((l) => /listening-player:playback/.test(l)).join(' ').trim();

  console.log('  ② 熄屏（input keyevent 26）');
  adb('-s', serial, 'shell', 'input', 'keyevent', '26');
  await sleep(6000);

  const after = await state();
  const advanced = after.t - before.t;
  console.log(`     熄屏 6 秒后：paused=${after.paused} 位置=${after.t}s（前进 ${advanced.toFixed(1)}s）`);
  console.log(`     media_session：${session() || '(没查到)'}`);
  console.log(`     唤醒锁：${wake() || '(没持有)'}`);

  adb('-s', serial, 'shell', 'input', 'keyevent', '26');   // 亮屏
  await sleep(1500);

  let failed = 0;
  const ok = (cond, what) => { console.log(`     ${cond ? '✓' : '✗'} ${what}`); if (!cond) failed++; };
  console.log('  ③ 结论');
  ok(!before.paused, '播放键按下后确实在播放');
  ok(!after.paused, '熄屏后没有被暂停');
  ok(advanced > 3, `熄屏期间音频继续前进（${advanced.toFixed(1)}s ≥ 3s）`);
  ok(/state=PlaybackState \{state=3|state=PLAYING/i.test(session()), 'MediaSession 处于播放状态');

  console.log(failed ? `\n  ✗ ${failed} 项未通过\n` : '\n  ✅ 锁屏保活实测通过\n');
  process.exit(failed ? 1 : 0);
}

async function main() {
  let serial = pickDevice();
  // 设备没连上：--boot 会自动拉起 MuMu；否则给一句明确的提示就退出，别干等
  if (!serial && args.includes('--boot') && bootEmulator()) serial = pickDevice();
  if (!serial) {
    console.error('\n[设备探针] 没有可用的设备。');
    console.error('  · 模拟器没开：node tools/probe-device.js --boot');
    console.error(`  · 或手动拉起："${MUMU_MANAGER}" control --vmindex 0 launch`);
    console.error(`  · 再连一下："${ADB}" connect 127.0.0.1:7555\n`);
    process.exit(2);
  }
  console.log(`\n设备 ${serial}`);

  // 页面进程与调试 socket
  let pid = '';
  try {
    pid = adb('-s', serial, 'shell', 'pidof', PKG).split(/\s+/)[0];
  } catch {
    pid = '';   // pidof 在「进程不存在」时返回非 0，算不上错误
  }
  if (!pid) {
    console.error(`\n[设备探针] App 没在运行。先启动它：`);
    console.error(`  "${ADB}" -s ${serial} shell am start -n ${PKG}/.MainActivity\n`);
    process.exit(2);
  }
  console.log(`  App pid ${pid}`);

  const socket = `webview_devtools_remote_${pid}`;
  const localPort = 9333;
  adb('-s', serial, 'forward', `tcp:${localPort}`, `localabstract:${socket}`);

  // 找页面 target
  let targets = [];
  for (let i = 0; i < 20 && !targets.length; i++) {
    try {
      // ⚠️ 一定要带超时：设备熄屏后 WebView 会被挂起，这个请求会**一直不回**，
      //    整个探针就死等下去（实测在真机上挂了 10 分钟，和踩坑 58 是同一类问题）。
      const res = await fetch(`http://127.0.0.1:${localPort}/json/list`,
        { signal: AbortSignal.timeout(3000) });
      const list = await res.json();
      targets = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch { /* 还没起来，或者设备睡着了 */ }
    if (!targets.length) await new Promise((r) => setTimeout(r, 300));
  }
  if (!targets.length) {
    console.error('\n[设备探针] 连不上 WebView 的调试端口。');
    console.error('  最常见的原因：**设备熄屏了** —— 熄屏后 WebView 被挂起，CDP 不会应答。');
    console.error('  先唤醒并解锁，再重新跑：');
    console.error(`    "${ADB}" -s ${serial} shell input keyevent 224   # 唤醒`);
    console.error(`    "${ADB}" -s ${serial} shell input keyevent 3     # 回桌面（解锁后）`);
    console.error(`    "${ADB}" -s ${serial} shell am start -n ${PKG}/.MainActivity\n`);
    process.exit(3);
  }
  const page = targets[0];
  console.log(`  页面 ${page.url}\n`);

  if (evalArg) {
    const value = await evaluate(page.webSocketDebuggerUrl, evalArg);
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    return;
  }

  // 后台 / 锁屏保活实测：播放 → 熄屏 → 看音频是否还在走
  if (args.includes('--keepalive')) {
    await keepAlive(serial, page.webSocketDebuggerUrl);
    return;
  }

  // 默认体检
  const report = await evaluate(page.webSocketDebuggerUrl, `(function () {
    var out = {};
    out.url = location.href;
    out.hasBridge = typeof window.AndroidHost !== 'undefined';
    out.lessons = document.querySelectorAll('.lesson-item').length;
    out.packLessons = document.querySelectorAll('.lesson-item .badge.pack').length;
    out.rootPath = (document.getElementById('rootPath') || {}).textContent || '';
    out.listText = ((document.getElementById('lessonList') || {}).textContent || '').trim().slice(0, 120);
    var a = document.getElementById('audio');
    out.audioSrc = a ? a.src : null;
    out.audioPaused = a ? a.paused : null;
    out.audioDuration = a ? Math.round(a.duration || 0) : null;
    out.audioCurrent = a ? Math.round((a.currentTime || 0) * 10) / 10 : null;
    out.audioError = a && a.error ? a.error.code : null;
    out.title = (document.getElementById('lessonTitle') || {}).textContent || '';
    out.lines = document.querySelectorAll('#lyrics .line').length;
    out.questions = document.querySelectorAll('#qBody .q-item').length;
    out.packs = (window.AndroidHost && AndroidHost.packs) ? JSON.parse(AndroidHost.packs()) : null;
    return out;
  })()`);

  console.log('体检结果：');
  console.log(JSON.stringify(report, null, 2).split('\n').map((l) => '  ' + l).join('\n'));

  if (shotArg) {
    adb('-s', serial, 'shell', 'screencap', '-p', '/sdcard/_shot.png');
    adb('-s', serial, 'pull', '/sdcard/_shot.png', path.resolve(ROOT, shotArg));
    console.log(`\n  截图已存到 ${shotArg}`);
  }

  console.log('');
}

main().catch((err) => {
  console.error('\n[设备探针失败] ' + err.message + '\n');
  process.exit(1);
});

#!/usr/bin/env node
/**
 * probe-frontend.js — 在无头浏览器里跑真实前端，验证「离线包 + 补充包」这条路
 *
 * 为什么需要它：
 *   补充包功能横跨三层 —— 前端拼 URL、Android 拦截并读 ZIP、以及两者之间的
 *   JS 桥。没有手机时，最容易错的就是「前端拼出来的 URL 和 Java 截获的前缀对不上」，
 *   而这类错误在桌面上点不出来（桌面走 /api + /media，根本不经过补充包）。
 *
 * 做法：起一个本地静态服务，把 APK 用的那套离线资源（build/apk/assets/www）
 *   原样端出来，并模拟 Android 侧的两件事：
 *     ① JS 桥 AndroidHost（packs / packTextLength / packTextChunk …）
 *     ② 自建 URL 空间 /pack/<包名>/<包内路径>（含 206 Range）
 *   然后用无头 Edge 打开页面，点一门补充包课程、打开补充包面板，
 *   把结果写进 DOM 再读出来核对。
 *
 * 前置：先构建一次离线资源（脚本会告诉你命令）。
 *
 * 用法：
 *   node tools/probe-frontend.js                # 有补充包的情况
 *   node tools/probe-frontend.js --no-packs     # 没装补充包的情况（回归：不能把演示课弄坏）
 */

'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { openZip } = require(path.join(__dirname, 'pack-info.js'));

const ROOT = path.resolve(__dirname, '..');
const WWW = path.join(ROOT, 'build', 'apk', 'assets', 'www');
const { resolveDeliverable } = require(path.join(__dirname, 'paths.js'));
const NO_PACKS = process.argv.includes('--no-packs');
// 再模拟一个「坏了 / 旧版」的包：界面上必须明确写出原因，而不是静默不显示
const BAD_PACK = process.argv.includes('--bad-pack');
const PORT = Number((process.argv.find((a) => a.startsWith('--port=')) || '').split('=')[1]) || 4198;

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

let failed = 0;
function ok(cond, what) {
  console.log(`  ${cond ? '✓' : '✗'} ${what}`);
  if (!cond) failed++;
}

/** 把 "rgb(r, g, b)" 解析成三个通道 */
function rgb(text) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(text || ''));
  return m ? { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) } : null;
}
const isGreen = (c) => { const v = rgb(c); return !!v && v.g > 150 && v.r < 150; };
const isRed = (c) => { const v = rgb(c); return !!v && v.r > 180 && v.g < 150; };

// ---------------------------------------------------------------- 补充包数据

/** 打开项目目录下的补充包（模拟 Android 侧的 PackStore） */
function loadPacks() {
  const catalogFile = path.join(WWW, 'packs-catalog.json');
  if (!fs.existsSync(catalogFile)) return [];
  const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));

  return catalog.packs.map((c) => {
    const abs = resolveDeliverable(c.file);
    if (!fs.existsSync(abs)) return null;
    const zip = openZip(abs);
    const library = zip.readText('library.json') || '';
    return {
      id: c.id, file: c.file, sizeBytes: c.sizeBytes, ok: true, error: '',
      format: 'listening-player-pack', version: c.version, set: c.set,
      lessons: c.lessons, hasLibrary: true, zip, library,
      // 音频条目：包内路径 → 文件偏移，用来实现 Range
      dir: path.dirname(abs),
    };
  }).filter(Boolean);
}

const ALL_PACKS = loadPacks();
const PACKS = NO_PACKS ? [] : ALL_PACKS;
const packInfo = {
  supported: true,
  dir: '/sdcard/Android/data/com.dsh.listeningplayer/files/packs',
  freeBytes: 40 * 1024 * 1024 * 1024,
  packs: PACKS.map((p) => ({
    id: p.id, file: p.file, sizeBytes: p.sizeBytes, ok: p.ok, error: p.error,
    format: p.format, version: p.version, set: p.set, lessons: p.lessons, hasLibrary: p.hasLibrary,
  })),
};
if (BAD_PACK) {
  packInfo.packs.push({
    id: '坏包', file: '坏包.lppack', sizeBytes: 1234567, ok: false,
    error: '这是旧版补充包（没有 library.json），请用 node tools/build-pack.js 重新打包后导入',
    format: 'listening-player-pack', version: 1, set: '', lessons: 0, hasLibrary: false,
  });
}

// ---------------------------------------------------------------- HTTP 服务

const requestLog = [];

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function servePackFile(req, res, packId, rel) {
  const pack = PACKS.find((p) => p.id === packId);
  if (!pack) return send(res, 404, {}, 'no pack');
  const entry = pack.zip.entries.get(rel);
  if (!entry) return send(res, 404, {}, 'no entry');
  requestLog.push(`${req.method} ${req.url}${req.headers.range ? ` [${req.headers.range}]` : ''}`);

  const mime = /\.mp3$/i.test(rel) ? 'audio/mpeg'
    : /\.wav$/i.test(rel) ? 'audio/wav'
      : /\.json$/i.test(rel) ? 'application/json' : 'text/plain; charset=utf-8';

  // 和 MainActivity 一样：只服务单区间，越界退回 200
  const total = entry.usize;
  let start = 0; let end = total - 1; let partial = false;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
  if (m) {
    if (m[1] === '' && m[2] !== '') {
      const suffix = Number(m[2]);
      if (suffix > 0) { start = Math.max(0, total - suffix); end = total - 1; partial = true; }
    } else if (m[1] !== '') {
      start = Number(m[1]);
      end = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1);
      if (start < total && start <= end) partial = true;
      else { start = 0; end = total - 1; }
    }
  }

  // STORED 条目：直接从文件偏移处读一段（等价于 Java 侧 skipFully + Bounded）
  const head = Buffer.alloc(30);
  fs.readSync(pack.zip.fd, head, 0, 30, entry.localOff);
  const dataOff = entry.localOff + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);

  if (entry.method !== 0) {          // 压缩条目：整条解压后再切片（文本文件才这样）
    const all = pack.zip.read(rel);
    return send(res, partial ? 206 : 200, {
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(end - start + 1),
      ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {}),
    }, all.subarray(start, end + 1));
  }

  const len = end - start + 1;
  const buf = Buffer.alloc(len);
  fs.readSync(pack.zip.fd, buf, 0, len, dataOff + start);
  return send(res, partial ? 206 : 200, {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Content-Length': String(len),
    ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {}),
  }, buf);
}

/** 模拟 Java 侧的 JS 桥：库文本先取好，再按【字符】分片提供 */
function hostStub() {
  const ids = PACKS.map((p) => p.id);
  return `(function(){
  var info = ${JSON.stringify(packInfo)};
  var ids = ${JSON.stringify(ids)};
  var cache = {};

  // 先把页面里的错误收集起来：前端出错时最怕「什么都没发生」，得看到原因
  window.__errors = [];
  window.addEventListener('error', function (e) {
    window.__errors.push('error: ' + (e.message || e.type));
  });
  window.addEventListener('unhandledrejection', function (e) {
    window.__errors.push('rejection: ' + ((e.reason && (e.reason.stack || e.reason.message)) || e.reason));
  });
  var origError = console.error;
  console.error = function () {
    window.__errors.push('console.error: ' + [].slice.call(arguments).join(' '));
    origError.apply(console, arguments);
  };

  function boot() {
    Promise.all(ids.map(function (id) {
      return fetch('/_packdata/' + encodeURIComponent(id))
        .then(function (r) { return r.text(); })
        .then(function (t) { cache[id] = t; });
    })).then(start);
  }

  window.AndroidHost = {
    packs: function () { return JSON.stringify(info); },
    rescanPacks: function () { return JSON.stringify(info); },
    packsDir: function () { return info.dir; },
    packTextLength: function (id, rel) {
      return (rel === 'library.json' && cache[id]) ? cache[id].length : -1;
    },
    packTextChunk: function (id, rel, from, len) {
      var t = (rel === 'library.json') ? cache[id] : null;
      if (t == null) return null;
      if (from < 0 || from >= t.length) return '';
      return t.substr(from, len);
    },
    importPack: function () { return false; },
    deletePack: function () { return JSON.stringify({ ok: false, error: '探测环境不支持删除' }); },
    // 后台/锁屏保活：记录网页报上来的播放状态
    setPlaybackState: function (playing, title, sub, pos, dur) {
      (window.__hostCalls = window.__hostCalls || []).push({
        playing: !!playing, title: title, sub: sub,
        pos: Math.round((pos || 0) * 10) / 10, dur: Math.round(dur || 0)
      });
    },
    stopPlayback: function () {
      (window.__hostCalls = window.__hostCalls || []).push({ stop: true });
    },
  };

  function start() {
    var s = document.createElement('script');
    s.src = '/app.js';
    s.onload = probe;
    document.body.appendChild(s);
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function readGrade() {
    var el = document.querySelector('#examProgress .accuracy');
    var banner = document.querySelector('#qBody .grade-banner .accuracy.big');
    var res = { pct: null, text: null, color: null, cls: null,
                bannerPct: null, bannerColor: null, bannerClass: null };
    if (el) {
      res.text = el.textContent.trim();
      res.pct = parseInt(res.text, 10);
      res.color = getComputedStyle(el).color;
      res.cls = el.className;
    }
    if (banner) {
      res.bannerPct = parseInt(banner.textContent, 10);
      res.bannerColor = getComputedStyle(banner).color;
      res.bannerClass = banner.className;
    }
    return res;
  }

  /** 直接写入 state.userAnswers（等价于用户逐题点选/输入），再让界面重画 */
  function answerAll(questions, mode) {
    state.userAnswers = new Map();
    questions.forEach(function (q, i) {
      var num = q.number != null ? q.number : i + 1;
      var ans = q.answer || '';
      if (!ans) return;
      if (mode === 'all') state.userAnswers.set(num, ans);
      else if (mode === 'one' && i === 1) state.userAnswers.set(num, ans);
    });
    renderQuestions();
  }

  async function probe() {
    var out = { steps: [] };
    try {
      await run(out);
    } catch (e) {
      // 探针自己出错时必须留下痕迹，否则只会看到「页面里没有探测结果」
      out.fatal = String((e && e.stack) || e);
      out.errors = (window.__errors || []).slice(0, 8);
    }
    var pre = document.createElement('pre');
    pre.id = 'probe';
    pre.textContent = 'PROBE_JSON:' + JSON.stringify(out);
    document.body.appendChild(pre);
  }

  async function run(out) {
    await sleep(1200);
    out.steps.push('app loaded');

    var items = [].slice.call(document.querySelectorAll('.lesson-item'));
    var packItems = items.filter(function (el) { return el.querySelector('.badge.pack'); });
    out.lessons = items.length;
    out.packLessons = packItems.length;
    out.rootPath = (document.getElementById('rootPath') || {}).textContent || '';
    out.errors = window.__errors.slice(0, 6);
    out.listHtml = ((document.getElementById('lessonList') || {}).textContent || '').slice(0, 200);

    var audio = document.getElementById('audio');
    // 应用启动时会自动选中第一门课，所以这里已经能看到音频地址
    out.audioSrcInitial = audio ? audio.src : null;

    // 选一门「带时间轴」的补充包课程 → 检查 audio 地址是不是自建 URL 空间
    // （六级里有些课程没有 .lrc，挑一个有的是为了把时间轴/题目一起验到）
    var first = packItems.filter(function (el) { return /句/.test(el.textContent); })[0] || packItems[0];
    if (first) {
      first.click();
      await sleep(900);
      out.pickedId = first.dataset.id;
      out.pickedPack = (first.querySelector('.badge.pack') || {}).textContent || '';
      out.audioSrc = audio ? audio.src : null;
      out.timeTotal = (document.getElementById('timeTotal') || {}).textContent || '';
      out.lineCount = document.querySelectorAll('#lyrics .line').length;
      out.questionCount = document.querySelectorAll('#qBody .q-item').length;

      // 顺着这个 URL 真取一段（模拟播放器的 Range 请求），验证 URL 与包内偏移
      try {
        var r = await fetch(audio.src, { headers: { Range: 'bytes=1000-1999' } });
        var buf = await r.arrayBuffer();
        out.range = { status: r.status, len: buf.byteLength, cr: r.headers.get('content-range') };
      } catch (e) { out.range = { error: String(e) }; }
    }

    // 演示课（打进 APK 的素材）也必须真的取得到音频。
    // 这里曾经有个老 bug：素材放在 assets/www/audio/ 下，前端却按 assets/www/<课id> 去取，
    // 列表看着正常、一播放就报「音频加载失败」，而且只在 APK 里复现。
    var demoItem = null;
    for (var di = 0; di < items.length; di++) {
      if (!items[di].querySelector('.badge.pack') && /句/.test(items[di].textContent)) { demoItem = items[di]; break; }
    }
    if (demoItem) {
      demoItem.click();
      await sleep(700);
      var da = document.getElementById('audio');
      out.demoId = demoItem.dataset.id;
      out.demoSrc = da ? da.src : null;
      try {
        var dr = await fetch(out.demoSrc, { headers: { Range: 'bytes=2000-2499' } });
        var dbuf = await dr.arrayBuffer();
        out.demoRange = { status: dr.status, len: dbuf.byteLength, cr: dr.headers.get('content-range') };
      } catch (e) { out.demoRange = { error: String(e) }; }
    }

    // ── 后台 / 锁屏保活：状态上报 + 通知栏命令回灌 ──
    //
    // ⚠️ 这里不去「等音频真的往前走」：无头浏览器用的是虚拟时钟，
    //    setTimeout 会瞬间跳过，而音频时钟是真实时间，两者对不上。
    //    所以凡是与播放位置有关的检查，都直接驱动控制函数，结果确定。
    var audioEl = document.getElementById('audio');
    out.bridge = {};
    out.bridge.hasSetter = typeof window.AndroidHost.setPlaybackState === 'function';
    out.bridge.hasCommandEntry = typeof window.__onHostCommand === 'function';

    // 播放 → 页面上报 playing=true（Java 侧据此起前台服务 + 持唤醒锁）
    try { await audioEl.play(); } catch (e) { out.playError = String(e); }
    await sleep(300);
    var calls = window.__hostCalls || [];
    out.bridge.playReports = calls.filter(function (c) { return c.playing; }).length;
    out.bridge.lastPlayingReport = calls.filter(function (c) { return c.playing; }).pop() || null;

    // 锁屏/通知栏「暂停」
    window.__onHostCommand('toggle');
    await sleep(200);
    out.bridge.pausedAfterToggle = audioEl.paused;
    out.bridge.pauseReports = (window.__hostCalls || []).filter(function (c) { return c.playing === false; }).length;

    // 「下一句」：应把播放位置推到下一句的时间戳
    audioEl.currentTime = 5;
    if (typeof findLineIndex === 'function') {
      var idx = findLineIndex(5);
      state.activeIndex = idx;
      var nextTime = (state.lines[idx + 1] || {}).time;
      window.__onHostCommand('nextLine');
      out.bridge.nextLineMoved = nextTime != null && Math.abs(audioEl.currentTime - nextTime) < 0.5;
    }

    // 锁屏拖动进度：seek 到指定秒数
    window.__onHostCommand('seek', 42.5);
    await sleep(120);
    out.bridge.seekedTo = Math.round(audioEl.currentTime * 10) / 10;

    // 熄屏后 rAF 停了：循环控制必须自己把「当前行」补算出来
    // （否则锁屏下的「单句复读」会一直循环切走之前的那一句）
    var realNow = performance.now.bind(performance);
    try { await audioEl.play(); } catch (e) { /* 忽略 */ }
    state.repeat = 'line';
    state.activeIndex = -1;
    // 取一个真的有台词的时刻（第 6 句），别用固定秒数：不同课的开头时间不一样
    var targetTime = (state.lines && state.lines.length > 5) ? state.lines[5].time + 0.1 : 12;
    audioEl.currentTime = targetTime;
    performance.now = function () { return realNow() + 100000; };   // 让 tickControl 认为 rAF 早已停摆
    tickControl();
    performance.now = realNow;
    out.bridge.lineRecomputed = state.activeIndex;
    out.bridge.lineExpected = findLineIndex(targetTime);

    // A-B 循环：位置越过 B 点时必须被拉回 A 点
    state.repeat = 'ab';
    state.ab = { a: 1.0, b: 1.8 };
    audioEl.currentTime = 2.5;      // 越过 B
    tickControl();
    out.bridge.abClamped = Math.round(audioEl.currentTime * 100) / 100;
    state.repeat = 'off';
    audioEl.pause();
    await sleep(150);
    out.bridge.reportsWhilePlaying = (window.__hostCalls || []).length;

    // ── 个性化：自定义背景 / 主题色 / 字号 ──
    var sets = {};
    var settingsBtn = document.getElementById('btnSettings');
    settingsBtn.click();
    await sleep(400);
    sets.panelOpen = document.getElementById('settingsDrawer').hidden === false;

    // 滑杆：改一个值就该立刻落到 CSS 变量上
    var dim = document.getElementById('bgDim');
    dim.value = '70';
    dim.dispatchEvent(new Event('input'));
    sets.dimVar = getComputedStyle(document.documentElement).getPropertyValue('--bg-dim').trim();
    var size = document.getElementById('lyricSize');
    size.value = '22';
    size.dispatchEvent(new Event('input'));
    sets.sizeVar = getComputedStyle(document.documentElement).getPropertyValue('--lyric-size').trim();

    // 主题色：点第三个色块，--accent 应变成橙色系
    var chips = document.querySelectorAll('#accentChips .accent-chip');
    sets.accentChips = chips.length;
    if (chips[2]) chips[2].click();
    await sleep(200);
    sets.accentVar = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();

    // 背景图：造一张真图片塞进 file input，走完整的「压缩 + 存 localStorage + 应用」链路
    await new Promise(function (resolve) {
      var c = document.createElement('canvas');
      c.width = 1200; c.height = 800;
      var g = c.getContext('2d');
      g.fillStyle = '#1d4ed8'; g.fillRect(0, 0, 1200, 800);
      g.fillStyle = '#f97316'; g.fillRect(300, 200, 600, 400);
      c.toBlob(function (blob) {
        var file = new File([blob], 'bg.png', { type: 'image/png' });
        var dt = new DataTransfer();
        dt.items.add(file);
        var input = document.getElementById('fileBg');
        input.files = dt.files;
        input.dispatchEvent(new Event('change'));
        resolve();
      }, 'image/png');
    });
    await sleep(900);
    sets.bgLayerVisible = document.getElementById('bgLayer').hidden === false;
    sets.hasBgClass = document.body.classList.contains('has-bg');
    var stored = null;
    try { stored = JSON.parse(localStorage.getItem('listening-player.settings.v1') || '{}'); } catch (e) { stored = {}; }
    sets.storedBgKB = stored.bgImage ? Math.round(stored.bgImage.length / 1024) : 0;
    sets.storedAccent = stored.accent;
    sets.storedSize = stored.lyricSize;

    // ── 人性化：学习记录 / 续听 / 睡眠定时 ──
    var prog = {};
    var lessonId = (state.lesson && state.lesson.manifest && state.lesson.manifest.id) || null;
    prog.lessonId = lessonId;
    if (lessonId) {
      recordScore(lessonId, 8, 10);          // 80% → 绿色
      recordPosition(lessonId, 123, 600);
      saveProgressNow();
      renderLessonList();
      await sleep(200);
      var item = document.querySelector('.lesson-item[data-id="' + lessonId.replace(/"/g, '\\"') + '"]');
      prog.badgeText = item ? (item.querySelector('.li-progress') || {}).textContent || '' : '';
      prog.accClass = item && item.querySelector('.li-acc') ? item.querySelector('.li-acc').className : '';
      prog.accColor = item && item.querySelector('.li-acc') ? getComputedStyle(item.querySelector('.li-acc')).color : '';

      // 续听条：位置 > 15 秒就该出现，点「继续听」应跳到该位置
      updateResumeBar();
      var bar = document.getElementById('resumeBar');
      prog.resumeShown = bar.hidden === false;
      prog.resumeText = (bar.textContent || '').replace(/\s+/g, ' ').trim();
      var go = bar.querySelector('[data-resume-go]');
      if (go) { go.click(); await sleep(300); }
      prog.resumeSeekedTo = Math.round(document.getElementById('audio').currentTime);
    }

    // 睡眠定时：选 20 分钟应出现倒计时，选回关闭应消失
    var st = document.getElementById('sleepTimer');
    st.value = '20';
    st.dispatchEvent(new Event('change'));
    await sleep(200);
    prog.sleepText = (document.getElementById('sleepLeft') || {}).textContent || '';
    st.value = '0';
    st.dispatchEvent(new Event('change'));
    await sleep(200);
    prog.sleepCleared = ((document.getElementById('sleepLeft') || {}).textContent || '') === '';

    out.settings = sets;
    out.learning = prog;
    document.getElementById('btnCloseSettings').click();

    // ── 模式切换：实战 / 练耳朵 ──
    var modes = {};
    modes.examBarInExam = document.getElementById('examBar').hidden === false;
    document.querySelector('#modeSwitch [data-mode="listen"]').click();
    await sleep(500);
    modes.listenBarHidden = document.getElementById('examBar').hidden === true;
    modes.veilHidden = document.getElementById('examVeil').hidden === true;
    modes.lyricsNotVeiled = !document.getElementById('lyrics').classList.contains('exam-hidden');
    modes.qpanelCollapsed = document.querySelector('.app').classList.contains('no-qpanel');
    modes.modeClass = document.querySelector('.app').classList.contains('mode-listen');
    modes.inputsReadonly = [].slice.call(document.querySelectorAll('#qBody .q-input'))
      .every(function (i) { return i.readOnly; });
    modes.answerRowsShown = document.querySelectorAll('#qBody .q-answer-row').length > 0;
    // 练耳朵模式下点选项不该被记成「作答」
    var opt = document.querySelector('#qBody .q-option');
    var beforeAnswers = state.userAnswers.size;
    if (opt) opt.click();
    modes.answerIgnored = state.userAnswers.size === beforeAnswers;
    modes.storedMode = (JSON.parse(localStorage.getItem('listening-player.settings.v1') || '{}')).mode;
    document.querySelector('#modeSwitch [data-mode="exam"]').click();
    await sleep(500);
    modes.backToExam = document.getElementById('examBar').hidden === false
      && document.getElementById('examVeil').hidden === false;

    // ── 拖动进度条：拖动中只预览，松手才跳一次；松手后自动接着播 ──
    var drag = {};
    var a2 = document.getElementById('audio');
    // ⚠️ 先等音频元数据到位再测。duration 还是 NaN 的时候：
    //    · 写 a2.currentTime = 30 会被静默忽略（位置停在 0）
    //    · Math.round((NaN || 0) * 0.8) 算出目标 0 秒
    //    于是「拖动中没跳」「松手跳到目标」「松手后还在播」「按钮状态」四条会一起假失败。
    //    实测偶发过一次，输出看着像前端坏了，其实只是探针跑太快 —— 不稳定的探针比没有探针更糟。
    //    （注意：这段代码整体是外层模板字符串的一部分，注释里不要出现反引号。）
    for (var w = 0; w < 40 && !(a2.duration > 0); w++) await sleep(250);
    a2.currentTime = 30;
    try { await a2.play(); } catch (e) { /* 忽略 */ }
    await sleep(500);
    var bar = document.getElementById('progress');
    var rect = bar.getBoundingClientRect();
    bar.dispatchEvent(new MouseEvent('mousedown',
      { clientX: rect.left + rect.width * 0.2, clientY: rect.top + 5, bubbles: true }));
    for (var di = 1; di <= 6; di++) {
      window.dispatchEvent(new MouseEvent('mousemove',
        { clientX: rect.left + rect.width * (0.2 + di * 0.08), clientY: rect.top + 5, bubbles: true }));
    }
    drag.timeDuringDrag = Math.round(a2.currentTime * 10) / 10;
    drag.startTime = 30;
    drag.dragTarget = Math.round((a2.duration || 0) * 0.8);
    drag.bubbleShown = document.getElementById('seekBubble').hidden === false;
    drag.bubbleText = (document.getElementById('seekBubble').textContent || '').trim();
    window.dispatchEvent(new MouseEvent('mouseup',
      { clientX: rect.left + rect.width * 0.8, clientY: rect.top + 5, bubbles: true }));
    await sleep(1200);
    drag.timeAfterRelease = Math.round(a2.currentTime);
    drag.expected = Math.round((a2.duration || 0) * 0.8);
    drag.stillPlaying = a2.paused === false;
    drag.bubbleHiddenAfter = document.getElementById('seekBubble').hidden === true;
    drag.playBtn = document.getElementById('btnPlay').textContent.trim();
    a2.pause();

    // ── 文案与侧栏开关 ──
    var labels = {
      back5: document.getElementById('btnBack5').textContent.trim(),
      fwd5: document.getElementById('btnFwd5').textContent.trim(),
      setA: document.getElementById('btnSetA').textContent.trim(),
      setB: document.getElementById('btnSetB').textContent.trim(),
      clearAB: document.getElementById('btnClearAB').textContent.trim(),
      repeatAB: (document.querySelector('#repeatMode option[value="ab"]') || {}).textContent || '',
      expandHiddenAtStart: document.getElementById('btnExpandSidebar').hidden,
    };
    document.getElementById('btnSidebar').click();
    await sleep(250);
    labels.expandAfterCollapse = document.getElementById('btnExpandSidebar').hidden === false;
    document.getElementById('btnExpandSidebar').click();
    await sleep(250);
    labels.expandAfterExpand = document.getElementById('btnExpandSidebar').hidden === true;

    out.modes = modes;
    out.drag = drag;
    out.labels = labels;

    // ── 批改与正确率：≥60% 绿、<60% 红 ──
    var questions = (state.lesson && state.lesson.questions) || [];
    out.questionTotal = questions.length;
    if (questions.length) {
      // ① 全部答对 → 期望 100% 且绿色
      answerAll(questions, 'all');
      document.getElementById('btnSubmit').click();
      await sleep(400);
      out.gradeHigh = readGrade();

      // ② 重做，只答对 1 题 → 期望 <60% 且红色
      //   （未答完的第一次点提交只弹确认，要点两次）
      document.getElementById('btnReset').click();
      await sleep(300);
      answerAll(questions, 'one');
      document.getElementById('btnSubmit').click();
      await sleep(200);
      document.getElementById('btnSubmit').click();
      await sleep(400);
      out.gradeLow = readGrade();
    }

    // ③ 分界线本身：60% 必须算达标（绿），59% 算未达标（红）
    var boundary = {};
    if (typeof accuracyOf === 'function') {
      boundary.exact60 = accuracyOf(3, 5);        // 60%
      boundary.justBelow = accuracyOf(59, 100);   // 59%
      boundary.zero = accuracyOf(0, 25);
      boundary.none = accuracyOf(0, 0);           // 没有题目时不能崩
      boundary.roundUp = accuracyOf(2, 3);        // 66.7% → 67
    }
    out.boundary = boundary;

    // 打开补充包面板
    var btn = document.getElementById('btnPacks');
    if (btn) {
      btn.click();
      await sleep(1200);
      out.panelHidden = document.getElementById('packDrawer').hidden;
      out.panelRows = document.querySelectorAll('#packList .pack-item').length;
      out.panelInstalled = document.querySelectorAll('#packList .badge.official').length;
      out.panelBad = document.querySelectorAll('#packList .pack-item.bad').length;
      out.panelCatalogRows = document.querySelectorAll('#packCatalog .pack-item').length;
      out.packDir = (document.getElementById('packDir') || {}).textContent || '';
      out.panelTitles = [].slice.call(document.querySelectorAll('#packList .pack-title'))
        .map(function (e) { return e.textContent; });
      out.panelSubs = [].slice.call(document.querySelectorAll('#packList .pack-sub'))
        .map(function (e) { return e.textContent.replace(/\\s+/g, ' ').trim(); });
      out.badError = [].slice.call(document.querySelectorAll('#packList .pack-item.bad .pack-error'))
        .map(function (e) { return e.textContent; }).join(' | ');
    }
  }

  boot();
})();`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/' || pathname === '/index.html') {
    let html = fs.readFileSync(path.join(WWW, 'index.html'), 'utf8');
    // 把 app.js 换成「先备好桥数据再加载 app.js」的探针脚本
    html = html.replace('<script src="app.js"></script>', '<script src="/_host-stub.js"></script>');
    return send(res, 200, { 'Content-Type': 'text/html; charset=utf-8' }, html);
  }

  if (pathname === '/_host-stub.js') {
    return send(res, 200, { 'Content-Type': 'text/javascript; charset=utf-8' }, hostStub());
  }

  const dataMatch = /^\/_packdata\/(.+)$/.exec(pathname);
  if (dataMatch) {
    const pack = PACKS.find((p) => p.id === dataMatch[1]);
    if (!pack) return send(res, 404, {}, 'no pack');
    return send(res, 200, { 'Content-Type': 'application/json; charset=utf-8' }, pack.library);
  }

  const packMatch = /^\/pack\/([^/]+)\/(.+)$/.exec(pathname);
  if (packMatch) return servePackFile(req, res, packMatch[1], packMatch[2]);

  // 普通静态资源（app.js / style.css / bundle.json / audio/…）
  const file = path.join(WWW, pathname);
  if (!file.startsWith(WWW) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return send(res, 404, {}, 'not found');
  }
  const mime = pathname.endsWith('.js') ? 'text/javascript; charset=utf-8'
    : pathname.endsWith('.css') ? 'text/css; charset=utf-8'
      : pathname.endsWith('.json') ? 'application/json; charset=utf-8'
        : pathname.endsWith('.html') ? 'text/html; charset=utf-8'
          : pathname.endsWith('.mp3') ? 'audio/mpeg'
            : pathname.endsWith('.wav') ? 'audio/wav' : 'application/octet-stream';
  const stat = fs.statSync(file);
  const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range || '').trim());
  if (range) {
    const start = Number(range[1]);
    const end = range[2] === '' ? stat.size - 1 : Math.min(Number(range[2]), stat.size - 1);
    if (start < stat.size && start <= end) {
      requestLog.push(`${req.method} ${req.url} [${req.headers.range}]`);
      return send(res, 206, {
        'Content-Type': mime,
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': String(end - start + 1),
      }, fs.readFileSync(file).subarray(start, end + 1));
    }
  }
  if (pathname.startsWith('/audio/')) requestLog.push(`${req.method} ${req.url}`);
  return send(res, 200, { 'Content-Type': mime, 'Content-Length': String(stat.size), 'Accept-Ranges': 'bytes' },
    fs.readFileSync(file));
});

// ---------------------------------------------------------------- 跑浏览器

function findBrowser() {
  for (const p of EDGE_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

function main() {
  if (!fs.existsSync(path.join(WWW, 'bundle.json'))) {
    console.error(`\n找不到离线资源：${WWW}`);
    console.error('请先构建一次（它会生成 build/apk/assets/www 与补充包清单）：');
    console.error('  node tools/build-apk.js --audio-set=CET4-演示,CET6-演示,IELTS-演示,TOEFL-演示 '
      + '--out=listening-player-lite.apk\n');
    process.exit(2);
  }

  const browser = findBrowser();
  if (!browser) {
    console.error('找不到 Edge / Chrome，无法做前端探测。');
    process.exit(2);
  }

  console.log(`\n探测前端：${NO_PACKS ? '（模拟「没有补充包」）' : `（${PACKS.length} 个补充包）`}`);
  console.log(`  资源目录 ${WWW}`);
  console.log(`  浏览器   ${path.basename(browser)}\n`);

  server.listen(PORT, '127.0.0.1', async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-probe-'));
    const dbgPort = PORT + 1;

    // ⚠️ 必须用 spawn 而不是 execFileSync：execFileSync 会阻塞 Node 的事件循环，
    //    同进程里的这个 HTTP 服务就没人应答了 —— 浏览器等服务、我们等浏览器，直接死锁。
    //
    // ⚠️ 也不能用 --virtual-time-budget + --dump-dom 那套：
    //    播放器现在有个 250ms 的定时器（熄屏后维持复读/A-B 循环），
    //    虚拟时钟会把预算瞬间烧完，DOM 还没渲染完就 dump 了。
    //    改成走 DevTools 协议：真实时间等待，探针自己把结果写进 DOM 后我们再取。
    const child = spawn(browser, [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--mute-audio',
      // 无头环境没有真实用户手势，不加这个 audio.play() 会直接被策略拒绝
      '--autoplay-policy=no-user-gesture-required',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${dbgPort}`,
      `http://127.0.0.1:${PORT}/`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let errText = '';
    child.stderr.on('data', (d) => { errText += d; });

    let dom = '';
    let probeText = '';
    try {
      const got = await collectViaCdp(dbgPort);
      dom = got.dom;
      probeText = got.probeText;
    } catch (err) {
      console.error('探测失败：' + err.message);
      if (errText) console.error('浏览器 stderr（尾部）：\n' + errText.slice(-1200));
    }
    try { child.kill(); } catch { /* 忽略 */ }
    finish(probeText, dom, errText, profile);
  });
}

// ---------------------------------------------------------------- DevTools 协议
//
// 只用两个 CDP 方法：Runtime.evaluate（读探针结果/DOM）。
// Node 22+ 自带 WebSocket，不必装 puppeteer。

async function waitForTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && String(t.url).includes('127.0.0.1'));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch (err) {
      lastErr = err.message;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('连不上浏览器调试端口 ' + port + (lastErr ? '（' + lastErr + '）' : ''));
}

/** 等页面把探测结果写进 #probe，再取回结果文本与整页 HTML */
async function collectViaCdp(dbgPort, waitMs = 120000) {
  const target = await waitForTarget(dbgPort, 30000);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('调试端口握手失败')), { once: true });
  });

  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });

  const evaluate = (expression) => new Promise((res) => {
    const id = ++seq;
    pending.set(id, (msg) => {
      const r = msg.result && msg.result.result;
      res(r ? r.value : undefined);
    });
    ws.send(JSON.stringify({
      id, method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true },
    }));
  });

  const deadline = Date.now() + waitMs;
  let probeText = '';
  while (Date.now() < deadline) {
    probeText = await evaluate(
      "(function(){var p=document.getElementById('probe');return p?p.textContent:'';})()") || '';
    if (probeText) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const dom = await evaluate('document.documentElement.outerHTML') || '';
  try { ws.close(); } catch { /* 忽略 */ }
  return { probeText, dom };
}

// ---------------------------------------------------------------- 结果核对

function finish(probeText, dom, errText, profile) {
  // 浏览器刚被 kill，可能还占着 profile 目录（Windows 上会 EPERM）。
  // 临时目录清不掉不该让整个探测失败，所以最多重试几次就算了。
  const cleanup = () => {
    server.close();
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch { /* 让系统自己清 Temp */ }
  };

  const m = /PROBE_JSON:([\s\S]*)/.exec(probeText || '');
  if (!m) {
    console.error('页面里没有探测结果 —— 前端可能报错了。');
    if (errText) console.error('浏览器 stderr（尾部）：\n' + errText.slice(-1500));
    console.error('DOM 片段：\n' + String(dom).slice(0, 1500));
    cleanup();
    process.exit(1);
  }
  const out = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  if (out.fatal) {
    console.error('探针自身出错：' + out.fatal);
    if (out.errors && out.errors.length) console.error('页面错误：\n  ' + out.errors.join('\n  '));
  }

  console.log('探测结果：');
  console.log(JSON.stringify(out, null, 2).split('\n').map((l) => '  ' + l).join('\n'));
  console.log('');

  if (NO_PACKS) {
    ok(out.lessons === 5, `没有补充包时仍是 5 门演示课（实际 ${out.lessons}）`);
    ok(out.packLessons === 0, '没有补充包课程');
    ok(out.panelRows === 0, '面板里没有已安装包');
    ok(/还没有补充包/.test(dom), '面板给出「还没有补充包」的提示');
    const src = out.audioSrcInitial || out.audioSrc || '';
    ok(!!src && !src.includes('/pack/'), `演示课音频仍走 assets（不是 pack/）：${src}`);
  } else {
    ok(out.lessons === 5 + 109, `课程列表 = 5 门演示 + 109 门补充包课程（实际 ${out.lessons}）`);
    ok(out.packLessons === 109, `补充包课程 109 门（实际 ${out.packLessons}）`);
    ok(/补充包/.test(out.rootPath), `侧栏数据源标注了补充包：${out.rootPath}`);
    ok(!!out.pickedId && out.pickedId.includes('/'), `能选中补充包课程：${out.pickedId}`);
    ok(/\/pack\/[^/]+\/audio\//.test(out.audioSrc || ''), `音频地址走自建 URL 空间：${out.audioSrc}`);
    ok(out.range && out.range.status === 206 && out.range.len === 1000,
      `对该地址的 Range 请求返回 206 + 1000 字节（${JSON.stringify(out.range)}）`);
    ok(out.lineCount > 0, `补充包课程带时间轴（${out.lineCount} 行）`);
    ok(out.questionCount > 0, `补充包课程带题目（${out.questionCount} 道）`);
    ok(out.panelHidden === false, '补充包面板能打开');
    ok(out.panelRows === PACKS.length + (BAD_PACK ? 1 : 0),
      `面板列出 ${PACKS.length + (BAD_PACK ? 1 : 0)} 个补充包（实际 ${out.panelRows}）`);
    ok(out.panelInstalled === PACKS.length, `可用包标记为已安装（实际 ${out.panelInstalled}）`);
    ok(out.panelBad === (BAD_PACK ? 1 : 0), `坏包数量 ${BAD_PACK ? 1 : 0}（实际 ${out.panelBad}）`);
    ok(out.panelCatalogRows === 0, '清单里的包都已安装，不再提示「未安装」');
    ok(/files\/packs/.test(out.packDir), `面板显示补充包目录：${out.packDir}`);
    if (BAD_PACK) {
      ok(/旧版补充包/.test(dom), '坏包明确写出了失败原因（旧版补充包）');
      ok(out.badError.length > 0, `坏包行里带原因文本：${out.badError}`);
    }
  }

  // ---------- 后台 / 锁屏保活 ----------
  console.log('\n  后台/锁屏保活（状态上报 + 命令回灌 + 熄屏循环）：');
  const br = out.bridge || {};
  ok(br.hasSetter === true, '检测到 JS 桥的 setPlaybackState（Android 侧保活入口）');
  ok(br.hasCommandEntry === true, '检测到 __onHostCommand（通知栏/锁屏命令入口）');
  ok(!out.playError, `音频能播放（${out.playError || '正常'}）`);
  ok(br.playReports > 0, `播放后上报了「正在播放」（${br.playReports} 次）`);
  ok(br.lastPlayingReport && br.lastPlayingReport.dur > 0,
    `上报里带了时长（${br.lastPlayingReport && br.lastPlayingReport.dur} 秒）`);
  ok(br.lastPlayingReport && !!br.lastPlayingReport.title,
    `上报里带了标题（${br.lastPlayingReport && br.lastPlayingReport.title}）`);
  ok(br.pausedAfterToggle === true, '通知栏/锁屏的 toggle 命令能让播放暂停');
  ok(br.pauseReports > 0, '暂停状态也上报了（通知栏才会显示「已暂停」）');
  ok(br.nextLineMoved === true, '「下一句」命令跳到了下一句的时间戳');
  ok(br.seekedTo >= 42 && br.seekedTo <= 44, `锁屏拖动进度的 seek 命令生效（${br.seekedTo}s）`);
  ok(br.lineRecomputed != null && br.lineRecomputed === br.lineExpected && br.lineRecomputed >= 0,
    `rAF 停摆时能自己补算当前行（${br.lineRecomputed} / 期望 ${br.lineExpected}）`);
  ok(Math.abs((br.abClamped || 0) - 1.001) < 0.05,
    `位置越过 B 点时被拉回 A 点（1.0–1.8 窗口，实测 ${br.abClamped}s）`);
  ok(br.reportsWhilePlaying >= 2, `播放期间会周期性上报（累计 ${br.reportsWhilePlaying} 次）`);

  // ---------- 个性化 / 人性化 ----------
  console.log('\n  个性化（自定义背景 · 主题色 · 字号）：');
  const st = out.settings || {};
  ok(st.panelOpen === true, '「设置」面板能打开');
  ok(st.dimVar === '0.70', `暗化滑杆立刻生效（--bg-dim=${st.dimVar}）`);
  ok(st.sizeVar === '22px', `原文字号滑杆立刻生效（--lyric-size=${st.sizeVar}）`);
  ok(st.accentChips === 5, `主题色提供了 ${st.accentChips} 种`);
  ok(st.accentVar && st.accentVar !== '#4ade80', `点色块后主题色变了（--accent=${st.accentVar}）`);
  ok(st.bgLayerVisible === true, '自定义背景层显示出来了');
  ok(st.hasBgClass === true, 'body 带上了 has-bg（面板变半透明，背景透出来）');
  ok(st.storedBgKB > 0 && st.storedBgKB < 3000,
    `背景图经压缩后存进本地存储（约 ${st.storedBgKB} KB，未撑爆 5MB 配额）`);
  ok(st.storedAccent === 'amber', `主题色写进了 localStorage（${st.storedAccent}）`);
  ok(st.storedSize === 22, `字号写进了 localStorage（${st.storedSize}）`);

  console.log('\n  人性化（学习记录 · 续听 · 睡眠定时）：');
  const pg = out.learning || {};
  ok(!!pg.lessonId, `拿到了当前课程 id（${pg.lessonId}）`);
  ok(/正确率 80%/.test(pg.badgeText || ''), `课程列表显示正确率：${(pg.badgeText || '').trim()}`);
  ok(/good/.test(pg.accClass || ''), `80% 用绿色（${pg.accClass}）`);
  ok(isGreen(pg.accColor), `正确率文字真的是绿色（${pg.accColor}）`);
  ok(/上次 02:03/.test(pg.badgeText || ''), `课程列表显示上次听到哪儿：${(pg.badgeText || '').trim()}`);
  ok(pg.resumeShown === true, `续听条出现：${pg.resumeText}`);
  ok(pg.resumeSeekedTo >= 120 && pg.resumeSeekedTo <= 126,
    `点「继续听」跳到了记录的位置（${pg.resumeSeekedTo}s，记录是 123s）`);
  ok(/后暂停/.test(pg.sleepText || ''), `睡眠定时显示倒计时：${pg.sleepText}`);
  ok(pg.sleepCleared === true, '选回「关闭」后倒计时消失');

  // ---------- 模式 / 拖动 / 文案 ----------
  console.log('\n  实战 vs 练耳朵：');
  const md = out.modes || {};
  ok(md.examBarInExam === true, '实战模式下有「做题 → 对答案」流程条');
  ok(md.listenBarHidden === true, '练耳朵模式下流程条收起来了（没有提交这回事）');
  ok(md.veilHidden === true && md.lyricsNotVeiled === true, '练耳朵模式不给原文盖遮罩，直接能看');
  ok(md.modeClass === true && md.qpanelCollapsed === true, '练耳朵模式收起题目面板，把屏幕让给原文');
  ok(md.inputsReadonly === true, '练耳朵模式下填空框是只读的');
  ok(md.answerRowsShown === true, '练耳朵模式直接显示答案（不做题就不必藏）');
  ok(md.answerIgnored === true, '练耳朵模式下点选项不会被记成作答');
  ok(md.storedMode === 'listen', `模式记进了设置（${md.storedMode}）`);
  ok(md.backToExam === true, '切回实战模式后流程条与遮罩都回来了');

  console.log('\n  拖动进度条：');
  const dg = out.drag || {};
  ok(dg.timeDuringDrag - dg.startTime < 3,
    `拖动过程中不跳转（${dg.startTime}s → ${dg.timeDuringDrag}s，只是正常播放推进；`
    + '以前每动一下鼠标就 seek 一次，连续 seek 会把播放卡死）');
  ok(Math.abs(dg.dragTarget - dg.timeDuringDrag) > 30,
    `拖动中也没跳到手指位置（目标 ${dg.dragTarget}s）`);
  ok(dg.bubbleShown === true, `拖动时显示位置气泡：${dg.bubbleText}`);
  ok(Math.abs((dg.timeAfterRelease || 0) - (dg.expected || 0)) <= 2,
    `松手后跳到目标位置（${dg.timeAfterRelease}s ≈ 期望 ${dg.expected}s）`);
  ok(dg.stillPlaying === true, '松手后播放没有被掐断（若被掐会自动续播）');
  ok(dg.bubbleHiddenAfter === true, '松手后气泡消失');
  ok(dg.playBtn === '⏸', `播放按钮状态与实际一致（${dg.playBtn}）`);

  console.log('\n  按钮文案与侧栏开关：');
  const lb = out.labels || {};
  ok(lb.back5 === '−5s' && lb.fwd5 === '+5s', `快退/快进说清楚了（${lb.back5} / ${lb.fwd5}）`);
  ok(lb.setA === '设置循环起点' && lb.setB === '设置循环终点',
    `循环起点/终点写全了（${lb.setA} / ${lb.setB}）`);
  ok(lb.clearAB === '清除循环', `清除按钮：${lb.clearAB}`);
  ok(/A→B/.test(lb.repeatAB || ''), `循环选项也叫 A→B 区间：${lb.repeatAB}`);
  ok(lb.expandHiddenAtStart === true, '侧栏展开时不显示浮动展开按钮');
  ok(lb.expandAfterCollapse === true, '收起侧栏后出现「展开」按钮（以前收起来就回不去了）');
  ok(lb.expandAfterExpand === true, '点展开后按钮消失、侧栏回来');

  // ---------- 批改与正确率（≥60% 绿 / <60% 红）----------
  console.log('\n  批改与正确率：');
  const hi = out.gradeHigh || {};
  const lo = out.gradeLow || {};
  ok(out.questionTotal > 0, `选中的课程有题目（${out.questionTotal} 道）`);
  ok(hi.pct === 100, `全部答对 → 正确率 100%（实际 ${hi.text}）`);
  ok(/good/.test(hi.cls || ''), `100% 用绿色类（${hi.cls}）`);
  ok(isGreen(hi.color), `100% 文字真的是绿色（${hi.color}）`);
  ok(hi.bannerPct === 100 && isGreen(hi.bannerColor),
    `题目面板横幅也显示 100% 且为绿色（${hi.bannerPct} / ${hi.bannerColor}）`);

  ok(lo.pct != null && lo.pct < 60, `只答对 1 题 → 正确率 <60%（实际 ${lo.text}）`);
  ok(/bad/.test(lo.cls || ''), `低分用红色类（${lo.cls}）`);
  ok(isRed(lo.color), `低分文字真的是红色（${lo.color}）`);
  ok(lo.bannerPct === lo.pct, `横幅与流程条数字一致（${lo.bannerPct} vs ${lo.pct}）`);
  ok(/未达标/.test(dom) || /低于 60%/.test(dom), '低分时给出「未达标 / 低于 60%」的提示');
  ok(hi.color !== lo.color, '两档颜色确实不同');

  const b = out.boundary || {};
  ok(b.exact60 && b.exact60.pct === 60 && b.exact60.level === 'good',
    '60% 整好算达标（绿色）');
  ok(b.justBelow && b.justBelow.pct === 59 && b.justBelow.level === 'bad',
    '59% 算未达标（红色）');
  ok(b.zero && b.zero.pct === 0 && b.zero.level === 'bad', '0% 为红色');
  ok(b.none && b.none.pct === 0 && b.none.level === 'bad', '没有题目时不崩（0%）');
  ok(b.roundUp && b.roundUp.pct === 67, `正确率取整（2/3 → ${b.roundUp && b.roundUp.pct}%）`);

  const packReqs = requestLog.filter((r) => r.includes('/pack/'));
  console.log(`\n  （浏览器实际发起的补充包请求 ${packReqs.length} 条）`);
  for (const r of packReqs.slice(0, 5)) console.log('    · ' + r);

  // 演示课（assets 里的素材）也要真的能取到
  console.log('\n  APK 内置素材（演示课）：');
  ok(!!out.demoSrc && /\/audio\//.test(out.demoSrc),
    `演示课音频地址带 audio/ 前缀（${out.demoSrc}）`);
  ok(out.demoRange && out.demoRange.status === 206 && out.demoRange.len === 500,
    `演示课音频能按 Range 取到（${JSON.stringify(out.demoRange)}）`);

  console.log(`\n${failed ? `✗ ${failed} 项未通过` : '✅ 全部通过'}\n`);
  cleanup();
  process.exit(failed ? 1 : 0);
}

main();

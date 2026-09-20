#!/usr/bin/env node
/**
 * probe-layout.js — 在无头浏览器里换着分辨率看前端布局会不会乱
 *
 * 为什么需要它：
 *   用户报过三个「看起来毫无关联」的问题 ——
 *     ·「更多 ▾ 点不动」
 *     ·「题目面板收起来之后就再也打不开」
 *     ·「换个分辨率/换台设备 UI 就乱」
 *   根因其实是同一类：**顶栏按钮被挤出屏幕**（以前 `.topbar-actions` 是
 *   `overflow-x: auto`，横向滚动 = 按钮藏起来 = 点不到），以及**题目面板被
 *   两个互相打架的状态类**（`.no-qpanel` 与 `.mobile-qpanel-open`）同时管着 ——
 *   宽屏下两者恰好不冲突，窄屏下就变成「display:flex 但 transform 还停在屏幕外」。
 *   而原来的 `tools/probe-frontend.js` 只在无头浏览器**默认的 800×600** 下跑过，
 *   从来没验过「按钮有没有被切掉」「抽屉打开后到底在不在视口里」。
 *
 * 做法：起一个本地服务把 APK 用的那套离线资源（build/apk/assets/www）端出来，
 *   只启动**一次**无头 Edge/Chrome，然后用 CDP 的
 *   `Emulation.setDeviceMetricsOverride` 依次切换分辨率，每个尺寸等 400ms
 *   让 resize 监听与过渡动画跑完，再把测量结果取回 Node 侧判定。
 *   （比每个尺寸重启一次浏览器快得多，也避免了「启动时就定死窗口大小」。）
 *
 * 前置：探针端的是 `build/apk/assets/www`，那是**上一次构建的副本**。
 *   改完 `public/` 下的前端必须先重建，否则就是拿旧代码在验（踩坑 33/52）：
 *     node tools/build-apk.js --audio-set=CET4-演示,CET6-演示,IELTS-演示,TOEFL-演示
 *
 * 用法：
 *   node tools/probe-layout.js              # 全通过时每个尺寸打一行汇总
 *   node tools/probe-layout.js --details    # 再把每个尺寸实测到的数打出来（复核判据）
 *   node tools/probe-layout.js --port=4300  # 换端口（默认 4218，+1 给调试端口）
 *
 * 退出码：0 全通过 / 1 有不变量失败 / 2 环境不对（没浏览器、没构建产物）
 */

'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const WWW = path.join(ROOT, 'build', 'apk', 'assets', 'www');

// 端口和 probe-frontend.js（4198/4199）错开，两个探针可以同时跑而不打架
const PORT = Number((process.argv.find((a) => a.startsWith('--port=')) || '').split('=')[1]) || 4218;
// 全通过时默认只打一行汇总；--details 把每个尺寸实测到的数也打出来（复核判据用）
const SHOW_DETAILS = process.argv.includes('--details');

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

// 最少要覆盖这些（CSS px）：小屏安卓竖屏 / 常见手机竖屏 / 用户实际在用的
// MuMu 模拟器竖屏 / 手机横屏（矮窗口）/ 平板竖屏 / 平板横屏 / 小笔记本 / 桌面。
// 860px 是窄屏断点，两边都要有代表尺寸，否则「宽屏的规则漏到窄屏」这种错看不出来。
const SIZES = [
  { w: 360, h: 640, label: '小屏安卓手机竖屏' },
  { w: 390, h: 844, label: '常见手机竖屏' },
  { w: 450, h: 776, label: 'MuMu 模拟器竖屏' },
  { w: 800, h: 360, label: '手机横屏（矮窗口）' },
  { w: 768, h: 1024, label: '平板竖屏' },
  { w: 1024, h: 768, label: '平板横屏' },
  { w: 1280, h: 800, label: '小笔记本' },
  { w: 1920, h: 1080, label: '桌面' },
];

const BREAKPOINT = 860;          // app.js 的 NARROW_MAX，量到的宽窄要跟着它走
const WAIT_MS = 400;             // 换分辨率后等 resize 监听 + .22s 过渡动画跑完
const CLICK_WAIT_MS = 450;       // 点一下按钮后等抽屉动画停稳再量

let failed = 0;
function ok(cond, what) {
  console.log(`  ${cond ? '✓' : '✗'} ${what}`);
  if (!cond) failed++;
}

// ---------------------------------------------------------------- HTTP 服务

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/' || pathname === '/index.html') {
    return send(res, 200, { 'Content-Type': 'text/html; charset=utf-8' },
      fs.readFileSync(path.join(WWW, 'index.html'), 'utf8'));
  }

  // 普通静态资源（app.js / style.css / bundle.json / audio/…）。
  // 这次**不模拟补充包**：内置 5 门演示课足够把布局用例跑满，
  // 补充包那套 URL 空间与 JS 桥是 probe-frontend.js 的职责。
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
  return send(res, 200, { 'Content-Type': mime }, fs.readFileSync(file));
});

// ---------------------------------------------------------------- 浏览器

function findBrowser() {
  for (const p of EDGE_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

// ---------------------------------------------------------------- 页面内测量
//
// 这里只负责「点 + 量」，通过/失败留给 Node 侧判定 ——
// 判定逻辑写在 JS 字符串里既难读也难调试。

/** 把一个元素量成纯数据（量不到就是 null，别让页面侧抛异常） */
const MEASURE = `
function __rect(el) {
  if (!el) return null;
  var r = el.getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom,
           width: r.width, height: r.height };
}
function __vis(el) {
  if (!el) return false;
  if (el.hidden) return false;
  var cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return false;
  return (el.getClientRects() || []).length > 0;
}
/** 把尺寸相关的原始数据一次性取回，避免 Node 侧和页面侧来回问 */
function __state() {
  var warnings = [];
  function __warn(msg) { warnings.push(msg); }
  var de = document.documentElement;
  var wrap = document.querySelector('.lyrics-wrap');
  var topbar = document.querySelector('.topbar');
  var bar = document.querySelector('.topbar-actions');
  var player = document.querySelector('.player');
  var lyrics = document.getElementById('lyrics');
  var panel = document.getElementById('qpanel');
  var overlay = document.querySelector('.sheet-backdrop');
  var pop = document.getElementById('morePop');
  var toggle = document.getElementById('btnToggleQuestions');
  var mobile = document.getElementById('btnMobileQpanel');
  var st = (typeof state === 'object' && state) || {};

  var buttons = [];
  if (bar) {
    [].slice.call(bar.children).forEach(function (el) {
      var cs = getComputedStyle(el);
      var r = el.getBoundingClientRect();
      buttons.push({ id: el.id || ('<' + el.className + '>'), vis: __vis(el),
                     display: cs.display, rect: __rect(el) });
    });
  }

  var toggles = [];
  [].slice.call(document.querySelectorAll('.mobile-toggle')).forEach(function (el) {
    if (!__vis(el)) return;
    toggles.push({ id: el.id, rect: __rect(el) });
  });

  var padVar = lyrics ? lyrics.style.getPropertyValue('--lyric-pad-top').trim() : '';
  if (!bar) __warn('页面上找不到 .topbar-actions');
  if (!document.querySelectorAll('.lesson-item').length) __warn('课程列表是空的（布局是在没有内容的情况下量的）');
  if (!document.querySelectorAll('#lyrics .line').length) __warn('原文区没有渲染出任何句子');

  return {
    vw: de.clientWidth, vh: de.clientHeight,
    innerW: window.innerWidth, innerH: window.innerHeight,
    dpr: window.devicePixelRatio,
    narrow: window.matchMedia('(max-width: 860px)').matches,
    appClass: document.querySelector('.app') ? document.querySelector('.app').className : '',
    stateOpen: st.qpanelOpen === undefined ? null : !!st.qpanelOpen,
    buttons: buttons,
    bar: bar ? { scrollWidth: bar.scrollWidth, clientWidth: bar.clientWidth,
                 rect: __rect(bar), vis: __vis(bar) } : null,
    topbar: topbar ? { rect: __rect(topbar), vis: __vis(topbar) } : null,
    player: player ? { rect: __rect(player), vis: __vis(player) } : null,
    wrap: wrap ? { rect: __rect(wrap), vis: __vis(wrap), h: wrap.clientHeight } : null,
    toggles: toggles,                 // 窄屏浮动的 ☰ / 📝（宽屏下 CSS 不给显示，这里会是空的）
    lines: document.querySelectorAll('#lyrics .line').length,
    qpanel: panel ? { rect: __rect(panel), vis: __vis(panel),
                      display: getComputedStyle(panel).display,
                      transform: getComputedStyle(panel).transform } : null,
    toggleRect: __rect(toggle),
    toggleVis: __vis(toggle),
    mobileRect: __rect(mobile),
    mobileVis: __vis(mobile),
    overlay: overlay ? { vis: __vis(overlay), display: getComputedStyle(overlay).display } : null,
    morePop: pop ? { hidden: pop.hidden, vis: __vis(pop), rect: __rect(pop),
                     display: getComputedStyle(pop).display,
                     text: (pop.textContent || '').replace(/[\\s\\u3000]+/g, ' ').trim().slice(0, 60) } : null,
    warnings: warnings,
    errors: (window.__errors || []).slice(0, 6),
    padVar: padVar,
  };
}
`;

/**
 * 页面内的检查流程。
 *
 * 顺序有讲究：先把题目面板**归零到收起**再量几何不变量 ——
 * 抽屉打开时会盖住正文与浮动按钮，量出来的重叠不能说明布局有问题。
 */
const CHECK = `(async function () {
  ${MEASURE}

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function panel() { return document.getElementById('qpanel'); }
  function appEl() { return document.querySelector('.app'); }

  /** 量布局时出任何岔子都要把「页面当时长什么样」带回来，别留下一堆 undefined */
  function safeState() {
    try {
      var st = __state();
      st.url = document.URL;
      st.title = document.title;
      st.readyState = document.readyState;
      st.hasApp = !!document.querySelector('.app');
      st.hasBar = !!document.querySelector('.topbar-actions');
      return st;
    } catch (e) {
      return { broken: String((e && e.stack) || e), url: document.URL,
               readyState: document.readyState };
    }
  }

  function panelOffscreen() {
    // 窄屏收起时面板被 transform 推进屏幕外；宽屏收起时是 display:none，
    // 那种情况下 rect 全是 0，**不能**当成「在屏幕外」（那是没显示，不是藏起来）
    var el = panel();
    if (!el) return true;
    if (getComputedStyle(el).display === 'none') return true;
    return __rect(el).left >= document.documentElement.clientWidth - 1;
  }

  /**
   * 强制把面板摆回「收起」。
   * 直接用 setQPanel 而不是点按钮：按钮是**开关**，而这里要的是「确保关着」，
   * 点一下可能反倒把它打开（也避开了「点出来的状态和 state 对不上」的干扰）。
   */
  function ensureClosed() {
    if (typeof state !== 'object' || !state) {          // app.js 没加载起来时别把探针带崩
      if (appEl()) appEl().classList.add('no-qpanel');
      return;
    }
    if (typeof setQPanel === 'function') { setQPanel(false); return; }
    state.qpanelOpen = false;
    if (appEl()) appEl().classList.add('no-qpanel');
  }

  var out = { initial: null, checks: [], qpanelEntry: null, morePop: null, geom: null };

  // 等课程列表出来：布局要和**真实内容**一起量（空列表时顶栏没有标题、
  // 正文区是空的，很多问题会被掩盖过去）
  for (var i = 0; i < 80; i++) {
    if (document.querySelectorAll('.lesson-item').length > 0) break;
    await sleep(250);
  }
  var first = document.querySelector('.lesson-item');
  if (first) first.click();
  await sleep(700);

  out.initial = { lines: document.querySelectorAll('#lyrics .line').length,
                  lessons: document.querySelectorAll('.lesson-item').length,
                  mobileVis: __vis(document.getElementById('btnMobileQpanel')) };

  ensureClosed();
  await sleep(300);
  out.geom = safeState();
  out.qpanelEntry = {
    stateOpen: (typeof state === 'object' && state) ? !!state.qpanelOpen : null,
    vis: __vis(panel()), offscreen: panelOffscreen(),
  };

  var toggle = document.getElementById('btnToggleQuestions');
  var mobileBtn = document.getElementById('btnMobileQpanel');

  // ---- 用例 1：顶栏「题目」按钮（每种分辨率都测）----
  var c1 = { name: 'toggle', open: false, closed: false, calls: 0, err: '' };
  try {
    if (!toggle) throw new Error('页面上没有 #btnToggleQuestions');
    toggle.click(); c1.calls++;
    await sleep(${CLICK_WAIT_MS});
    c1.openVis = __vis(panel());
    c1.openRect = __rect(panel());
    c1.open = c1.openVis;                       // 真正的判据（有没有落在视口里）在 Node 侧
    ensureClosed();
    await sleep(${CLICK_WAIT_MS});              // 等过渡动画走完再量下落状态
    c1.closedVis = __vis(panel());
    c1.closedRect = __rect(panel());
    c1.closedDisplay = getComputedStyle(panel()).display;
    c1.closedTransform = getComputedStyle(panel()).transform;
    c1.closed = panelOffscreen();
    toggle.click(); c1.calls++;                 // 点回初始的「展开」。宽屏下这本来就是默认，
    await sleep(${CLICK_WAIT_MS});              // 窄屏下 syncResponsive 进来时会自己收起
    c1.afterRect = __rect(panel());
    c1.afterVis = __vis(panel());
  } catch (e) { c1.err = String((e && e.message) || e); }
  out.checks.push(c1);
  ensureClosed();
  await sleep(150);

  // ---- 用例 2：右下角浮动 📝（宽屏下它是 display:none，跳过）----
  var c2 = { name: 'mobileToggle', skipped: !__vis(mobileBtn), err: '' };
  if (!c2.skipped) {
    try {
      mobileBtn.click(); c2.calls = 1;
      await sleep(${CLICK_WAIT_MS});
      c2.openVis = __vis(panel());
      c2.openRect = __rect(panel());
      c2.open = c2.openVis;
      mobileBtn.click(); c2.calls++;
      await sleep(${CLICK_WAIT_MS});
      c2.closedVis = __vis(panel());
      c2.closedRect = __rect(panel());
      c2.closedDisplay = getComputedStyle(panel()).display;
      c2.closedTransform = getComputedStyle(panel()).transform;
      c2.closed = panelOffscreen();
      ensureClosed();
      await sleep(200);
    } catch (e) { c2.err = String((e && e.message) || e); }
  }
  out.checks.push(c2);

  // ---- 用例 3：「更多 ▾」下拉 ----
  var c3 = { name: 'morePop', err: '' };
  try {
    var more = document.getElementById('btnMore');
    if (!more) throw new Error('页面上没有 #btnMore');
    more.click();
    await sleep(${CLICK_WAIT_MS});
    var pop = document.getElementById('morePop');
    var cs = getComputedStyle(pop);
    c3.visible = (cs.display !== 'none') && !pop.hidden && __vis(pop);
    c3.display = cs.display;
    c3.rect = __rect(pop);
    c3.text = (pop.textContent || '').replace(/[\\s\\u3000]+/g, ' ').trim().slice(0, 60);
    c3.items = [].slice.call(pop.children).map(function (el) { return el.id || el.className; });
    more.click();                                   // 再点一次关掉
    await sleep(250);
    c3.closedHidden = pop.hidden === true;
  } catch (e) { c3.err = String((e && e.message) || e); }
  out.morePop = c3;

  out.errors = (window.__errors || []).slice(0, 6);
  out.dbg = { url: document.URL, readyState: document.readyState,
              hasApp: !!document.querySelector('.app'), lessons: out.initial.lessons,
              lines: out.initial.lines };
  try { return JSON.stringify(out); }
  catch (e) { return JSON.stringify({ fatal: String((e && e.stack) || e) }); }
})()`;

// ---------------------------------------------------------------- 分辨率主循环

/** 判据：矩形有没有完整落在视口里（容 1px 亚像素误差） */
function inViewport(r, vw, vh, slack = 1) {
  if (!r) return false;
  return r.left >= -slack && r.right <= vw + slack && r.top >= -slack && r.bottom <= vh + slack;
}

/** 抽屉打开时：必须在视口里横向放得下（纵向由 position:fixed 保证） */
function drawerVisible(r, vw, slack = 1) {
  return !!r && r.left >= -slack && r.right <= vw + slack;
}

function measureRect(r) {
  if (!r) return 'rect=null';
  return `rect=[${Math.round(r.left)},${Math.round(r.top)} → ${Math.round(r.right)},${Math.round(r.bottom)}]`;
}

/** 掉进「更多 ▾」菜单里的按钮不参与顶栏溢出判定（它们本来就不该在顶栏上） */
function isInMorePop(b) {
  return b.id === 'btnEdit' || b.id === 'btnImport' || b.id === 'btnPacks' || b.id === 'btnFeedback'
    || b.id === 'btnPaper' || b.id === 'btnRaw';
}

/**
 * 给定一个尺寸下的原始测量结果，返回失败项列表（空数组 = 全部通过）。
 * 纯函数，方便出错时把「哪条不变量」说清楚。
 *
 * 入参形状：{ geom: {…__state() 的量测…}, checks: [...], morePop: {...} }
 */
function evaluate(s) {
  const f = [];
  if (!s || !s.geom) return ['拿不到布局测量数据（页面侧没返回 geom）'];
  const g = s.geom;
  const vw = g.vw;
  const vh = g.vh;

  // ⓪ 页面本身得是「我们要的那个页面」，否则后面全是假失败
  if (g.broken) return [`量布局时出错：${g.broken}`];
  if (g.readyState && g.readyState !== 'complete') f.push(`页面还没加载完（readyState=${g.readyState}）`);

  // ① 顶栏：没有任何按钮被切掉 + 不能横向滚动（滚动 = 藏起来 = 点不到）
  const onBar = (g.buttons || []).filter((b) => !isInMorePop(b));
  for (const b of onBar) {
    if (!b.vis) continue;                     // display:none 的按钮不算「被切掉」
    const r = b.rect;
    if (!r) { f.push(`顶栏按钮 ${b.id} 量不到位置（元素塌成 0 高？）`); continue; }
    if (r.left < -1) f.push(`顶栏按钮 ${b.id} 左边被切掉（left=${r.left.toFixed(1)}）`);
    if (r.right > vw + 1) f.push(`顶栏按钮 ${b.id} 右边出屏（right=${r.right.toFixed(1)} > 视口 ${vw}）`);
  }
  if (!g.bar) {
    f.push('页面上找不到 .topbar-actions');
  } else {
    if (g.bar.scrollWidth > g.bar.clientWidth + 1) {
      f.push(`顶栏横向滚动（scrollWidth=${g.bar.scrollWidth} > clientWidth=${g.bar.clientWidth}，`
        + '多出来的按钮等于藏起来）');
    }
    if (onBar.filter((b) => b.vis).length === 0) f.push('顶栏上一个按钮都没有（layoutTopbar 把按钮全搬走了？）');
  }

  // ② 「更多 ▾」点得开、而且整块在屏幕里
  const mp = s.morePop || {};
  if (mp.err) f.push(`点「更多 ▾」出错：${mp.err}`);
  else {
    if (!mp.visible) f.push(`「更多 ▾」点不开（display=${mp.display}，hidden=${mp.hidden}）`);
    else if (!inViewport(mp.rect, vw, vh)) {
      f.push(`「更多 ▾」菜单跑出屏幕 ${measureRect(mp.rect)}（视口 ${vw}×${vh}）`);
    }
    if (mp.closedHidden !== true) f.push('再点一次「更多 ▾」没能关掉');
    if (!mp.items || !mp.items.length) f.push('「更多 ▾」菜单里的按钮一个都不剩（layoutTopbar 没搬东西进来？）');
  }

  // ③ 题目面板两个入口：能开（真的在视口里）、能关
  let mobileSkipped = true;
  for (const c of s.checks || []) {
    if (c.name === 'mobileToggle') mobileSkipped = !!c.skipped;
    if (c.skipped) continue;
    if (c.err) { f.push(`题目面板用例「${c.name}」出错：${c.err}`); continue; }
    if (!c.open) f.push(`题目面板用例「${c.name}」点了没显示`);
    else if (!drawerVisible(c.openRect, vw)) {
      f.push(`题目面板用例「${c.name}」打开了但不在视口里 ${measureRect(c.openRect)}`
        + `（视口宽 ${vw}，展开后从屏幕外开始）`);
    }
    if (!c.closed) {
      f.push(`题目面板用例「${c.name}」再点一次没收起（display=${c.closedDisplay}，`
        + `transform=${c.closedTransform}，${measureRect(c.closedRect)}）`);
    }
    if (c.name === 'toggle' && c.calls !== 2) f.push('题目面板「题目」按钮没被点满两下（探针没跑完）');
    if (c.name === 'mobileToggle' && c.calls !== 2) f.push('题目面板浮动 📝 按钮没被点满两下（探针没跑完）');
  }
  // 宽屏下浮动 📝 本来就是 display:none，用例被跳过是正常的；窄屏下跳过才是探针没测到
  if (mobileSkipped && g.narrow) f.push('窄屏下浮动 📝 用例被跳过了（那个按钮本该可见）');

  if (g.errors && g.errors.length) f.push(`页面里报了错：${g.errors.join(' / ')}`);
  // 前置条件没满足时说清楚（否则「找不到 .topbar-actions」会被当成布局 bug）
  for (const w of g.warnings || []) f.push(`前置条件不满足：${w}`);

  // ④ 窄屏浮动 ☰ / 📝 不能压在播放器上
  if (g.narrow && g.player && g.player.vis) {
    const top = g.player.rect.top;
    if (!g.toggles || !g.toggles.length) {
      f.push('窄屏下浮动开关（☰/📝）一个都没显示');
    } else {
      for (const t of g.toggles) {
        if (t.rect.bottom > top + 1) {
          f.push(`浮动 ${t.id} 压在播放器上（bottom=${t.rect.bottom.toFixed(1)} > `
            + `.player.top=${top.toFixed(1)}）`);
        }
      }
    }
  }
  if (!g.narrow && g.toggles && g.toggles.length) {
    f.push(`宽屏下不该出现浮动开关（${g.toggles.map((t) => t.id).join('、')}）`);
  }

  // ⑤ 正文不能跑到顶栏底下
  if (g.topbar && g.wrap) {
    if (g.wrap.rect.top < g.topbar.rect.bottom - 1) {
      f.push(`正文区跑到顶栏底下（.lyrics-wrap.top=${g.wrap.rect.top.toFixed(1)} < `
        + `.topbar.bottom=${g.topbar.rect.bottom.toFixed(1)}）`);
    }
  } else {
    f.push('页面上找不到 .topbar 或 .lyrics-wrap');
  }

  // ⑥ 原文区上下留白要跟着滚动区高度走
  if (g.wrap && g.wrap.h > 0) {
    const pad = parseFloat(g.padVar);
    if (!Number.isFinite(pad)) {
      f.push(`--lyric-pad-top 没设上（读到 ${JSON.stringify(g.padVar)}）`);
    } else if (pad > g.wrap.h / 2) {
      f.push(`原文区上留白太大（--lyric-pad-top=${pad}px > 滚动区高度 ${g.wrap.h}px 的一半，`
        + '当前句会被顶出可视区）');
    }
  }

  return f;
}

/** 打印该尺寸下所有顶栏按钮的 id + rect（只在失败时打，成功时不刷屏） */
function dumpButtons(s) {
  const g = (s && s.geom) || {};
  if (!g.buttons || !g.buttons.length) { console.log('      （顶栏里一个子元素都没有）'); return; }
  for (const b of g.buttons) {
    const r = b.rect;
    console.log(`      · ${b.id.padEnd(20)} ${b.vis ? '显示' : '隐藏'} `
      + `${r ? `left=${r.left.toFixed(1)} right=${r.right.toFixed(1)} w=${r.width.toFixed(1)}` : 'rect=null'}`
      + ` display=${b.display}`);
  }
  if (g.bar) {
    console.log(`      · .topbar-actions    scrollWidth=${g.bar.scrollWidth} `
      + `clientWidth=${g.bar.clientWidth} ${measureRect(g.bar.rect)}`);
  }
}

/** 一个尺寸一行实测到的数（--details 用，复核「判据到底量到了什么」） */
function detailLine(size, s) {
  const g = (s && s.geom) || {};
  const mark = (b) => (b.vis ? b.id : `${b.id}(显示:${b.display})`);
  const onBar = (g.buttons || []).map(mark).join(',');
  const rng = (r) => (r ? `${Math.round(r.left)}~${Math.round(r.right)}` : '?');
  const ups = (g.toggles || []).map((t) => `${t.id} bottom=${Math.round(t.rect.bottom)}`)
    .join(' ');
  const pad = Number.parseFloat(g.padVar);
  return `    ${String(size.w).padStart(4)}×${String(size.h).padEnd(4)} `
    + `视口 ${g.vw}×${g.vh} 窄屏=${g.narrow} 顶栏[${onBar}] `
    + `scroll=${g.bar ? `${g.bar.scrollWidth}/${g.bar.clientWidth}` : '?'} `
    + `更多 ${rng(s.morePop && s.morePop.rect)} `
    + `题目 开${rng((s.checks[0] || {}).openRect)}/关${rng((s.checks[0] || {}).closedRect)} `
    + `浮动 ${ups || '(无)'} `
    + `正文 top=${g.wrap ? Math.round(g.wrap.rect.top) : '?'}`
    + `(顶栏底=${g.topbar ? Math.round(g.topbar.rect.bottom) : '?'}) `
    + `留白 ${Number.isFinite(pad) ? `${pad}/${g.wrap ? g.wrap.h : '?'}` : JSON.stringify(g.padVar)}`;
}

function finish(details) {
  if (SHOW_DETAILS && details && details.length) {
    console.log('\n  各尺寸实测（--details）：');
    for (const d of details) console.log(d);
    console.log('');
  }
  console.log(`\n${failed ? `✗ 通过 ${passedCount} 项，失败 ${failed} 项` : '✅ 全部通过'}\n`);
  server.close();
  process.exit(failed ? 1 : 0);
}

let passedCount = 0;

// ---------------------------------------------------------------- DevTools 协议
//
// 只用三个 CDP 方法：Emulation.setDeviceMetricsOverride（切分辨率）、
// Page.navigate（把标签页领到目标地址）、Runtime.evaluate（取测量结果）。
// Node 22+ 自带 WebSocket，不必装 puppeteer。

/**
 * 等调试端口起来，挑一个标签页。
 *
 * ⚠️ 不能按 URL 里有没有 127.0.0.1 去挑：Edge 起来时会额外开一个 about:blank
 *    标签页，`/json/list` 里同时躺着好几个 page，按 URL 挑很容易连到那个空白页上 ——
 *    症状是「DOM 里什么都没有、视口 980px、课程列表 0 门」。
 *    所以这里只挑一个 page 目标，**由我们自己 Page.navigate 领它到目标地址**，
 *    再核对 document.URL，连错页这种事就不可能发生了。
 */
async function waitForTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  let saw = [];
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      saw = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (saw.length) {
        const wanted = saw.find((t) => String(t.url).includes('127.0.0.1'));
        return wanted || saw[0];
      }
    } catch (err) {
      lastErr = err.message;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('连不上浏览器调试端口 ' + port + (lastErr ? '（' + lastErr + '）' : ''));
}

/** 连上 CDP：一个连接跑完全部尺寸，不重启浏览器 */
async function connect(dbgPort, url) {
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
      const cb = pending.get(msg.id);
      pending.delete(msg.id);
      cb(msg);
    }
  });

  /** 发一条 CDP 命令，等它自己的应答（切换分辨率要等真的生效，不能只发不等） */
  const send = (method, params) => new Promise((res, rej) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      rej(new Error(`${method} 超时`));
    }, 15000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) rej(new Error(`${method}: ${msg.error.message}`));
      else res(msg.result);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error('页面里抛异常：' + (r.exceptionDetails.exception
        ? (r.exceptionDetails.exception.description || r.exceptionDetails.text)
        : r.exceptionDetails.text));
    }
    return r.result ? r.result.value : undefined;
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const cdp = {
    evaluate,
    sleep,
    setViewport: (w, h) => send('Emulation.setDeviceMetricsOverride',
      { width: w, height: h, deviceScaleFactor: 1, mobile: true }),
    close: () => { try { ws.close(); } catch { /* 忽略 */ } },
  };

  // 不管连到的是哪个标签页，都把它领到目标地址；连错了地址就直接报错，
  // 免得对着一个空白页量半天（那样只会得到一堆「元素不存在」的假失败）
  await send('Page.navigate', { url });
  const deadline = Date.now() + 30000;
  let here = '';
  while (Date.now() < deadline) {
    here = String(await evaluate('document.URL') || '');
    if (here.includes(`127.0.0.1:${PORT}`)) break;
    await sleep(200);
  }
  if (!here.includes(`127.0.0.1:${PORT}`)) {
    throw new Error(`标签页没能打开目标地址（现在停在 ${here || '空白页'}）`);
  }

  // 等页面真的可用：DOMContentLoaded 之后 app.js 才会把本地资源读进来
  const ready = Date.now() + 30000;
  while (Date.now() < ready) {
    const has = await evaluate(
      "!!document.querySelector('.topbar-actions') && document.readyState !== 'loading'");
    if (has) break;
    await sleep(200);
  }
  if (!await evaluate("!!document.querySelector('.topbar-actions')")) {
    throw new Error('页面加载了但没有 .topbar-actions —— app.js 可能没跑起来');
  }

  return cdp;
}

// ---------------------------------------------------------------- 主流程

function main() {
  if (!fs.existsSync(path.join(WWW, 'bundle.json'))) {
    console.error(`\n找不到离线资源：${WWW}`);
    console.error('请先构建一次（探针端的是构建产物，不是 public/）：');
    console.error('  node tools/build-apk.js --audio-set=CET4-演示,CET6-演示,IELTS-演示,TOEFL-演示\n');
    process.exit(2);
  }

  const browser = findBrowser();
  if (!browser) {
    console.error('找不到 Edge / Chrome，无法做布局探测。');
    process.exit(2);
  }

  console.log('\n检查多分辨率布局（顶栏不被切 / 更多菜单 / 题目面板两个入口 / 浮动按钮 / 原文留白）');
  console.log(`  资源目录 ${WWW}`);
  console.log(`  浏览器   ${path.basename(browser)}（无头 + CDP 切换 ${SIZES.length} 种分辨率）\n`);

  server.listen(PORT, '127.0.0.1', async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-layout-'));
    const dbgPort = PORT + 1;

    // ⚠️ 必须用 spawn 而不是 execFileSync：execFileSync 会阻塞 Node 的事件循环，
    //    同进程里的这个 HTTP 服务就没人应答 —— 浏览器等服务、我们等浏览器，直接死锁。
    //
    // ⚠️ 也不用 --virtual-time-budget + --dump-dom：播放器有 250ms 定时器，
    //    虚拟时钟会把预算瞬间烧完，页面还没渲染完就 dump 了。
    //    也不给 --window-size：窗口大小启动后就定死了，切换分辨率得靠 CDP。
    const child = spawn(browser, [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${dbgPort}`,
      `http://127.0.0.1:${PORT}/`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let errText = '';
    child.stderr.on('data', (d) => { errText += d; });

    const cleanup = () => {
      server.close();
      // 浏览器刚被 kill，可能还占着 profile 目录（Windows 上会 EPERM）。
      // 临时目录清不掉不该让整个探测失败，重试几次就算了。
      try {
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch { /* 让系统自己清 Temp */ }
    };

    let cdp = null;
    const details = [];
    try {
      // 连上后由 connect() 自己把标签页领到 / 并等页面可用：
      // 启动参数里的地址只是个「顺手」的提示，Edge 可能另开空白页抢焦点。
      cdp = await connect(dbgPort, `http://127.0.0.1:${PORT}/`);
      await cdp.setViewport(SIZES[0].w, SIZES[0].h);
      await cdp.sleep(600);                       // 等 app.js 起来（课程列表另有一段轮询）

      for (const size of SIZES) {
        await cdp.setViewport(size.w, size.h);
        await cdp.sleep(WAIT_MS);                 // 让 resize 监听与过渡动画跑完
        let s;
        try {
          const raw = await cdp.evaluate(CHECK);
          s = JSON.parse(raw);
        } catch (err) {
          console.log(`  ✗ ${size.w}×${size.h}  ${size.label}：取结果失败 —— ${err.message}`);
          failed++;
          continue;
        }

        if (process.env.PROBE_LAYOUT_DEBUG) {
          // 只在排查探针自身时用：把页面侧整包测量原样打出来
          console.log(`  [调试] ${JSON.stringify(s).slice(0, 4000)}`);
        }
        details.push(detailLine(size, s));
        const fails = evaluate(s);
        const head = `  ${String(size.w).padStart(4)}×${String(size.h).padEnd(4)} ${size.label}`;
        if (!fails.length) {
          passedCount++;
          console.log(`${head}  ✓ 全部通过`);
        } else {
          failed++;
          console.log(`${head}  ✗ ${fails.length} 项不通过：`);
          for (const t of fails) console.log(`      - ${t}`);
          console.log('    该尺寸下的顶栏按钮：');
          dumpButtons(s);
          const g = s.geom || {};
          console.log(`    视口 ${g.vw}×${g.vh}（innerW=${g.innerW}，窄屏=${g.narrow}，`
            + `app.class="${g.appClass}"，正文 ${g.lines} 行，`
            + `.topbar.bottom=${g.topbar ? g.topbar.rect.bottom.toFixed(1) : '?'}，`
            + `.lyrics-wrap.top=${g.wrap ? g.wrap.rect.top.toFixed(1) : '?'}，`
            + `.player.top=${g.player ? g.player.rect.top.toFixed(1) : '?'}，`
            + `--lyric-pad-top=${JSON.stringify(g.padVar)}）`);
          if (s.morePop) {
            console.log(`    「更多 ▾」：${measureRect(s.morePop.rect)} display=${s.morePop.display} `
              + `hidden=${s.morePop.hidden} 内容="${s.morePop.text}"`);
          }
          if (g.qpanel) {
            console.log(`    题目面板：display=${g.qpanel.display} transform=${g.qpanel.transform} `
              + `${measureRect(g.qpanel.rect)}`);
          }
          if (g.url && !String(g.url).includes(`127.0.0.1:${PORT}`)) {
            console.log(`    ⚠️ 量的不是目标页面：${g.url}`);
          }
        }
      }
    } catch (err) {
      console.error('探测失败：' + err.message);
      if (errText) console.error('浏览器 stderr（尾部）：\n' + errText.slice(-1200));
      if (cdp) cdp.close();
      try { child.kill(); } catch { /* 忽略 */ }
      cleanup();
      process.exit(1);
    }

    if (cdp) cdp.close();
    try { child.kill(); } catch { /* 忽略 */ }
    finish(details);
  });
}

main();

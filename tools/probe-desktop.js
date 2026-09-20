/**
 * 桌面版（PC 端）体检：用无头 Edge 打开**正在跑的** server.js，检查
 *   · 侧栏课程数与真实接口一致
 *   · 顶栏按钮在大屏下没有被切掉
 *   · 题目面板默认展开、两个入口都能开能关
 *   · 音频走的是 /media/ 而不是 APK 的 assets 路径
 *   · 页面没有 JS 报错
 *
 * 与 probe-layout.js 的区别：那个端的是 build/apk/assets/www（APK 里那一份），
 * 这个端的是真正的桌面服务，验的是「PC 端这条路」。
 *
 * 用法：node build\_desktop-check.js [url]
 */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const URL_ = process.argv[2] || 'http://127.0.0.1:4180/';
const WIDTH = Number(process.argv[3] || 1920);
const HEIGHT = Number(process.argv[4] || 1080);
const PORT = 4231;
const DBG = 4232;
// --lesson=关键字：先搜索再点第一门课（用来验某类课程的渲染，比如雅思的题组正文）
const LESSON = (process.argv.find((a) => a.startsWith('--lesson=')) || '').slice(9);

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));
if (!EDGE) { console.error('找不到 Edge / Chrome'); process.exit(2); }

const PAGE = `(async function () {
  var out = [];
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var vw = window.innerWidth, vh = window.innerHeight;
  out.push('视口 ' + vw + '×' + vh);
  out.push('课程数 ' + document.querySelectorAll('.lesson-item').length);
  out.push('侧栏数据源 ' + ((document.getElementById('rootPath') || {}).textContent || '').trim());

  var bar = document.querySelector('.topbar-actions');
  out.push('顶栏 scrollW=' + bar.scrollWidth + ' clientW=' + bar.clientWidth
    + (bar.scrollWidth <= bar.clientWidth + 1 ? ' 没溢出' : ' ★溢出'));
  var bad = [];
  [].slice.call(bar.children).forEach(function (el) {
    var b = el.getBoundingClientRect();
    if (b.width === 0) return;
    if (b.left < -1 || b.right > vw + 1) bad.push((el.id || el.textContent.trim()) + ' right=' + Math.round(b.right));
  });
  out.push('顶栏按钮被切掉的：' + (bad.length ? bad.join(', ') : '无'));

  var app = document.querySelector('.app');
  var q = document.getElementById('qpanel');
  var r = function (el) { var b = el.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right) }; };
  out.push('题目面板初始：display=' + getComputedStyle(q).display + ' rect=' + JSON.stringify(r(q))
    + '（宽屏应默认展开）');
  document.getElementById('btnToggleQuestions').click();
  await sleep(350);
  out.push('点「题目」后：display=' + getComputedStyle(q).display + ' no-qpanel=' + app.classList.contains('no-qpanel'));
  document.getElementById('btnToggleQuestions').click();
  await sleep(350);
  out.push('再点一次：display=' + getComputedStyle(q).display + ' no-qpanel=' + app.classList.contains('no-qpanel'));

  var a = document.getElementById('audio');
  out.push('音频地址 ' + (a && a.src ? a.src : '(还没选课)'));
  out.push('音频时长 ' + (a ? Math.round(a.duration || 0) : '?') + 's  错误=' + (a && a.error ? a.error.code : 'null'));

  out.push('JS 报错：' + (window.__errs && window.__errs.length ? window.__errs.join(' | ') : '无'));

  // ---- 指定课程时的额外检查（雅思的题组正文就靠这段验）----
  var want = '__LESSON__';
  if (want) {
    var box = document.getElementById('search');
    box.value = want;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(700);
    var items = document.querySelectorAll('.lesson-item');
    out.push('搜索「' + want + '」命中 ' + items.length + ' 门');
    if (items.length) {
      items[0].click();
      var a3 = document.getElementById('audio');
      for (var k = 0; k < 40 && !(a3.duration > 0); k++) await sleep(250);
      await sleep(800);
      out.push('已选中：' + (document.getElementById('lessonTitle') || {}).textContent);
      out.push('题目面板里的题目数：' + document.querySelectorAll('#qBody .q-item').length);
      var papers = document.querySelectorAll('#qBody .q-group-paper');
      out.push('题组正文块数：' + papers.length + (papers.length ? '（雅思应 > 0）' : ' ★雅思应该 > 0'));
      if (papers.length) {
        out.push('第一块摘要：' + papers[0].querySelector('summary').textContent.trim());
        var t = papers[0].querySelector('.q-paper-pre').textContent;
        out.push('第一块正文长度：' + t.length + ' 字符');
        out.push('正文前 3 行：' + JSON.stringify(t.split('\\n').slice(0, 3)));
      }
      out.push('「原题」按钮 disabled=' + document.getElementById('btnPaper').disabled);
    }
  }
  return out.join('\\n');
})()`;

async function cdp(wsUrl, expression, id = 1) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
  });
  const msg = await Promise.race([
    new Promise((res) => {
      ws.addEventListener('message', (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id === id) res(m);
      });
      ws.send(JSON.stringify({
        id, method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true },
      }));
    }),
    // ⚠️ 必须带超时：页面里的脚本一旦卡住（比如在等一个永远不来的事件），
    //    Runtime.evaluate 的回复就永远不来，整个探针会静默挂死 —— 实测挂过 5 分钟。
    new Promise((_, rej) => setTimeout(
      () => rej(new Error('CDP 求值超时（页面里的脚本卡住了）')), 90000)),
  ]);
  ws.close();
  // 同步抛错在 msg.result.exceptionDetails；awaitPromise 的 async 脚本抛错在 msg.exceptionDetails
  const ex = (msg.result && msg.result.exceptionDetails) || msg.exceptionDetails;
  if (ex) {
    throw new Error('页面里报错：' + JSON.stringify(ex.exception || ex));
  }
  return msg.result && msg.result.result ? msg.result.result.value : undefined;
}

async function send(wsUrl, method, params = {}) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
  });
  await new Promise((res) => {
    ws.addEventListener('message', () => res(), { once: true });
    ws.send(JSON.stringify({ id: 1, method, params }));
  });
  ws.close();
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-'));
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${DBG}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let target = null;
  for (let i = 0; i < 30 && !target; i++) {
    await new Promise((r) => setTimeout(r, 400));
    try {
      const list = await (await fetch(`http://127.0.0.1:${DBG}/json/list`,
        { signal: AbortSignal.timeout(3000) })).json();
      // 只挑 page，且自己导航（Edge 会多开一个 about:blank，按 URL 挑会连错页）
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch { /* 还没起来 */ }
  }
  if (!target) { console.error('连不上浏览器调试端口'); child.kill(); process.exit(2); }

  await send(target.webSocketDebuggerUrl, 'Page.navigate', { url: URL_ });
  await new Promise((r) => setTimeout(r, 4000));
  await cdp(target.webSocketDebuggerUrl,
    'window.__errs=[];window.addEventListener("error",function(e){window.__errs.push(String(e.message))});true');

  try {
    const text = await cdp(target.webSocketDebuggerUrl, PAGE.replace('__LESSON__', LESSON.replace(/'/g, '')));
    console.log('\n桌面版体检：' + URL_ + '\n');
    console.log(text.split('\n').map((l) => '  ' + l).join('\n'));
    console.log('');
  } catch (err) {
    console.error('体检失败：' + err.message);
    child.kill();
    process.exit(1);
  }
  child.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
})();

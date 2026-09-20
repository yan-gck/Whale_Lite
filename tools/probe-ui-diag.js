/**
 * 竖屏 / 窄屏 UI 诊断（配合 node tools/probe-device.js --eval-file= 使用）
 *
 * 用途：定位「更多点不动」「题目面板收起来展不开」「不同分辨率 UI 乱」这类
 *       布局与点击问题。它不改任何状态，只读 DOM + 试一次点击再复原。
 */
(async function () {
  var out = [];
  var log = function (s) { out.push(s); };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  var vw = window.innerWidth;
  var vh = window.innerHeight;
  log('=== 视口 ===');
  log('innerWidth=' + vw + ' innerHeight=' + vh
    + ' dpr=' + window.devicePixelRatio
    + ' 横竖=' + (vw > vh ? '横屏' : '竖屏')
    + ' screen=' + screen.width + 'x' + screen.height);
  log('visualViewport=' + (window.visualViewport
    ? Math.round(window.visualViewport.width) + 'x' + Math.round(window.visualViewport.height)
      + ' scale=' + window.visualViewport.scale : '(无)'));

  var r = function (el) {
    if (!el) return null;
    var b = el.getBoundingClientRect();
    return {
      x: Math.round(b.left), y: Math.round(b.top),
      w: Math.round(b.width), h: Math.round(b.height),
      right: Math.round(b.right), bottom: Math.round(b.bottom),
    };
  };
  var cs = function (el, prop) { return el ? getComputedStyle(el)[prop] : '(无元素)'; };
  var inView = function (el) {
    var b = r(el);
    if (!b || b.w === 0 || b.h === 0) return false;
    return b.x >= 0 && b.y >= 0 && b.right <= vw && b.bottom <= vh;
  };
  var visible = function (el) {
    if (!el) return false;
    var s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    var b = el.getBoundingClientRect();
    return b.width > 0 && b.height > 0;
  };

  // ---------- 1. 顶栏 ----------
  log('');
  log('=== 顶栏按钮 ===');
  var topbar = document.querySelector('.topbar');
  var actions = document.querySelector('.topbar-actions');
  log('topbar ' + JSON.stringify(r(topbar)) + ' overflowX=' + cs(topbar, 'overflowX'));
  log('topbar-actions ' + JSON.stringify(r(actions))
    + ' scrollW=' + (actions ? actions.scrollWidth : '?')
    + ' clientW=' + (actions ? actions.clientWidth : '?')
    + ' overflow=' + ((actions && actions.scrollWidth > actions.clientWidth + 1) ? '★被挤出' : '没挤'));

  var ids = ['btnMore', 'btnSettings', 'btnPaper', 'btnToggleQuestions', 'btnRaw', 'modeSwitch'];
  ids.forEach(function (id) {
    var el = document.getElementById(id);
    log('  ' + id + ' text="' + (el ? (el.textContent || '').trim() : '(没有)') + '"'
      + ' rect=' + JSON.stringify(r(el))
      + ' visible=' + visible(el) + ' 完整在视口内=' + inView(el));
  });

  // ---------- 2. 点「更多」 ----------
  log('');
  log('=== 「更多」菜单 ===');
  var btnMore = document.getElementById('btnMore');
  var morePop = document.getElementById('morePop');
  log('点击前：hidden=' + (morePop ? morePop.hasAttribute('hidden') : '?')
    + ' display=' + cs(morePop, 'display')
    + ' rect=' + JSON.stringify(r(morePop)));
  if (btnMore) {
    btnMore.click();
    await sleep(250);
    log('点击后：hidden=' + morePop.hasAttribute('hidden')
      + ' display=' + cs(morePop, 'display')
      + ' rect=' + JSON.stringify(r(morePop)));
    log('→ ' + (visible(morePop) ? '菜单打开了 ✓' : '★菜单没打开（点了没反应）'));
    // 复原
    btnMore.click();
    await sleep(150);
    log('再点一次复原：hidden=' + morePop.hasAttribute('hidden'));
  } else {
    log('★ 没有 #btnMore');
  }

  // ---------- 3. 题目面板 ----------
  log('');
  log('=== 题目面板 ===');
  var qpanel = document.getElementById('qpanel');
  var btnTQ = document.getElementById('btnToggleQuestions');
  var btnMQ = document.getElementById('btnMobileQpanel');
  var snapQ = function (tag) {
    log(tag + '：qpanel class="' + (qpanel ? qpanel.className : '?') + '"'
      + ' display=' + cs(qpanel, 'display')
      + ' transform=' + cs(qpanel, 'transform')
      + ' rect=' + JSON.stringify(r(qpanel))
      + ' visible=' + visible(qpanel));
  };
  snapQ('初始');
  log('  #btnToggleQuestions visible=' + visible(btnTQ) + ' rect=' + JSON.stringify(r(btnTQ)));
  log('  #btnMobileQpanel  visible=' + visible(btnMQ) + ' rect=' + JSON.stringify(r(btnMQ))
    + ' display=' + cs(btnMQ, 'display'));

  if (btnTQ) {
    btnTQ.click(); await sleep(400); snapQ('点顶栏「题目」后');
    btnTQ.click(); await sleep(400); snapQ('再点一次后');
  }
  if (btnMQ && visible(btnMQ)) {
    btnMQ.click(); await sleep(400); snapQ('点浮动 📝 后');
    btnMQ.click(); await sleep(400); snapQ('再点浮动 📝 后');
  }

  // ---------- 4. 浮动开关与遮罩 ----------
  log('');
  log('=== 移动端浮动开关 / 遮罩 ===');
  ['btnMobileSidebar', 'btnMobileQpanel', 'btnExpandSidebar', 'sheetBackdrop', 'sidebar'].forEach(function (id) {
    var el = document.getElementById(id);
    log('  ' + id + ' visible=' + visible(el)
      + ' display=' + cs(el, 'display')
      + ' rect=' + JSON.stringify(r(el)));
  });

  // ---------- 5. 横向溢出元素 ----------
  log('');
  log('=== 横向溢出视口的元素（前 12 个）===');
  var bad = [];
  document.querySelectorAll('body *').forEach(function (el) {
    var s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return;
    var b = el.getBoundingClientRect();
    if (b.width === 0 || b.height === 0) return;
    if (b.right > vw + 1 || b.left < -1) {
      var id = el.id ? '#' + el.id : '';
      var cls = el.className && typeof el.className === 'string'
        ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
      bad.push(el.tagName.toLowerCase() + id + cls
        + ' left=' + Math.round(b.left) + ' right=' + Math.round(b.right) + ' w=' + Math.round(b.width));
    }
  });
  log(bad.length ? bad.slice(0, 12).join('\n') : '  （没有溢出元素）');
  log('共 ' + bad.length + ' 个');

  return out.join('\n');
})()

/**
 * 竖屏交互全扫：把界面上每个入口都点一遍，检查「能打开 / 能关闭 / 不被挡住」。
 * 用法：node tools/probe-device.js --eval-file=tools/probe-interact.js
 */
(async function () {
  var out = [];
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var vw = window.innerWidth, vh = window.innerHeight;
  var fail = 0;

  var vis = function (el) {
    if (!el) return false;
    var s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    var b = el.getBoundingClientRect();
    return b.width > 0 && b.height > 0;
  };
  var fullyInView = function (el) {
    if (!vis(el)) return false;
    var b = el.getBoundingClientRect();
    return b.left >= -1 && b.right <= vw + 1 && b.top >= -1 && b.bottom <= vh + 1;
  };
  var centerHittable = function (el) {
    if (!vis(el)) return false;
    var b = el.getBoundingClientRect();
    var x = b.left + b.width / 2, y = b.top + b.height / 2;
    if (x < 0 || x > vw || y < 0 || y > vh) return false;
    var hit = document.elementFromPoint(x, y);
    return !!hit && (hit === el || el.contains(hit) || hit.contains(el));
  };
  var check = function (ok, what) {
    if (!ok) fail++;
    out.push((ok ? '  [OK]  ' : '  [★坏] ') + what);
  };
  var closeAll = async function () {
    var pop = document.getElementById('morePop');
    if (pop && !pop.hidden) { document.getElementById('btnMore').click(); await sleep(150); }
    ['rawDrawer', 'paperDrawer', 'importDrawer', 'packDrawer', 'settingsDrawer'].forEach(function (id) {
      var d = document.getElementById(id);
      if (d && !d.hidden) d.hidden = true;
    });
    var app = document.querySelector('.app');
    if (app.classList.contains('mobile-sidebar-open')) document.getElementById('btnMobileSidebar').click();
    if (!app.classList.contains('no-qpanel')) document.getElementById('btnToggleQuestions').click();
    await sleep(400);
  };

  out.push('视口 ' + vw + '×' + vh + '（dpr ' + window.devicePixelRatio + '）');
  await closeAll();

  // ---------- 1. 顶栏每个按钮 ----------
  out.push('');
  out.push('【顶栏】');
  var bar = document.querySelector('.topbar-actions');
  var kids = [].slice.call(bar.children);
  check(bar.scrollWidth <= bar.clientWidth + 1, '顶栏没有横向溢出（scrollW ' + bar.scrollWidth + ' ≤ clientW ' + bar.clientWidth + '）');
  kids.forEach(function (el) {
    if (!vis(el)) return;
    check(fullyInView(el), '按钮「' + (el.textContent || '').trim() + '」完整在屏幕内');
  });

  // ---------- 2. 更多菜单 ----------
  out.push('');
  out.push('【更多 ▾ 菜单】');
  document.getElementById('btnMore').click();
  await sleep(300);
  var pop = document.getElementById('morePop');
  check(vis(pop), '菜单能打开');
  check(fullyInView(pop), '菜单整块在屏幕内');
  var popBtns = [].slice.call(pop.querySelectorAll('button'));
  out.push('  菜单项：' + popBtns.map(function (b) { return b.textContent.trim(); }).join(' / '));
  popBtns.forEach(function (b) { check(centerHittable(b), '菜单项「' + b.textContent.trim() + '」点得到'); });
  document.getElementById('btnMore').click();
  await sleep(250);
  check(!vis(pop), '再点一次能收起');

  // ---------- 3. 侧栏 ----------
  out.push('');
  out.push('【侧栏抽屉 ☰】');
  var sb = document.getElementById('btnMobileSidebar');
  check(centerHittable(sb), '浮动 ☰ 点得到');
  check(!document.querySelector('.player').getBoundingClientRect().top < sb.getBoundingClientRect().bottom,
    '☰ 没有压在播放器上');
  sb.click(); await sleep(450);
  var sidebar = document.getElementById('sidebar');
  check(sidebar.getBoundingClientRect().left >= -1, '侧栏滑出来了（left=' + Math.round(sidebar.getBoundingClientRect().left) + '）');
  check(getComputedStyle(document.getElementById('sheetBackdrop')).display === 'block', '遮罩出现');
  document.getElementById('sheetBackdrop').click(); await sleep(450);
  check(sidebar.getBoundingClientRect().left < -10, '点遮罩能收起侧栏');

  // ---------- 4. 题目抽屉 ----------
  out.push('');
  out.push('【题目抽屉】');
  var q = document.getElementById('qpanel');
  document.getElementById('btnToggleQuestions').click(); await sleep(450);
  check(q.getBoundingClientRect().left >= -1 && q.getBoundingClientRect().right <= vw + 1,
    '顶栏「题目」能打开抽屉');
  check(centerHittable(document.getElementById('btnCloseQpanel')), '抽屉里的 ✕ 点得到');
  document.getElementById('btnCloseQpanel').click(); await sleep(450);
  check(q.getBoundingClientRect().left >= vw, '✕ 能关掉抽屉');
  var mq = document.getElementById('btnMobileQpanel');
  check(centerHittable(mq), '浮动 📝 点得到');
  mq.click(); await sleep(450);
  check(q.getBoundingClientRect().left >= -1 && q.getBoundingClientRect().right <= vw + 1, '浮动 📝 能打开抽屉');
  document.getElementById('sheetBackdrop').click(); await sleep(450);
  check(q.getBoundingClientRect().left >= vw, '点遮罩能收起题目抽屉');

  // ---------- 5. 各个模态抽屉 ----------
  out.push('');
  out.push('【模态抽屉】');
  var modals = [['btnRaw', 'rawDrawer', '原文'], ['btnPaper', 'paperDrawer', '原题']];
  for (var i = 0; i < modals.length; i++) {
    var btnId = modals[i][0], drawerId = modals[i][1], name = modals[i][2];
    var btn = document.getElementById(btnId);
    // 窄屏下这两个被搬进「更多」菜单了
    if (!vis(btn)) {
      document.getElementById('btnMore').click();
      await sleep(300);
    }
    check(vis(btn), name + '的入口找得到（顶栏或「更多」菜单里）');
    // 没有原题的课程（比如六级补充包）会把「原题」按钮正确置灰 —— 这不是 bug，
    // 但也不该拿它去点。探针要认这个状态，否则每次跑都报假失败。
    if (btn.disabled) {
      out.push('  [跳过] 当前课程没有' + name + '数据，「' + name + '」按钮已正确置灰');
      var d0 = document.getElementById(drawerId);
      if (!d0.hidden) { d0.querySelector('.drawer-head .icon-btn').click(); await sleep(300); }
      continue;
    }
    btn.click(); await sleep(400);
    var d = document.getElementById(drawerId);
    check(vis(d), '能打开' + name + '面板');
    var inner = d.querySelector('.drawer-inner');
    check(fullyInView(inner), name + '面板完整在屏幕内');
    // 关闭按钮不能被浮动开关盖住
    var closeBtn = d.querySelector('.drawer-head .icon-btn');
    check(centerHittable(closeBtn), name + '面板的关闭按钮点得到（没被浮动开关盖住）');
    closeBtn.click(); await sleep(350);
    check(!vis(d), '能关掉' + name + '面板');
  }

  // ---------- 6. 设置与反馈 ----------
  out.push('');
  out.push('【设置 / 反馈】');
  document.getElementById('btnSettings').click(); await sleep(500);
  var sd = document.getElementById('settingsDrawer');
  check(vis(sd), '设置面板能打开');
  check(centerHittable(sd.querySelector('.drawer-head .icon-btn')), '设置面板的关闭按钮点得到');
  // 反馈那一节在设置面板靠下的位置，先滚过去再判断 —— 否则量到的是「在折叠下方」，
  // 那是正常的，不是 bug
  var sec = document.getElementById('feedbackSection');
  sec.scrollIntoView({ block: 'center' });
  await sleep(400);
  check(centerHittable(document.getElementById('btnCopyFeedback')), '「复制反馈信息」点得到');
  var fbLink = document.getElementById('btnOpenFeedback');
  check(centerHittable(fbLink), '「去提 issue」点得到');
  check(fbLink && fbLink.tagName === 'A' && fbLink.target === '_blank',
    '反馈入口是真外链（<a target=_blank>），点它会交给系统浏览器');
  var qqEl = document.getElementById('feedbackUrl');
  check(fullyInView(qqEl), '反馈地址完整可见（' + (qqEl ? qqEl.textContent.trim() : '?') + '）');
  sd.querySelector('.drawer-head .icon-btn').click(); await sleep(350);
  check(!vis(sd), '设置面板能关掉');

  // ---------- 7. 补充包 / 导入 ----------
  out.push('');
  out.push('【补充包 / 导入】');
  var pairs = [['btnPacks', 'packDrawer', '补充包'], ['btnImport', 'importDrawer', '导入资料']];
  for (var j = 0; j < pairs.length; j++) {
    var b2 = document.getElementById(pairs[j][0]), d2 = document.getElementById(pairs[j][1]), n2 = pairs[j][2];
    document.getElementById('btnMore').click(); await sleep(300);
    check(centerHittable(b2), '「' + n2 + '」菜单项点得到');
    b2.click(); await sleep(500);
    check(vis(d2), '能打开' + n2 + '面板');
    check(fullyInView(d2.querySelector('.drawer-inner')), n2 + '面板完整在屏幕内');
    d2.querySelector('.drawer-head .icon-btn').click(); await sleep(350);
    check(!vis(d2), '能关掉' + n2 + '面板');
  }

  // ---------- 8. 模式切换 ----------
  out.push('');
  out.push('【模式切换】');
  var app = document.querySelector('.app');
  var mExam = document.querySelector('#modeSwitch [data-mode="exam"]');
  var mListen = document.querySelector('#modeSwitch [data-mode="listen"]');
  mExam.click(); await sleep(400);
  check(app.classList.contains('mode-listen') === false, '能切到实战模式');
  mListen.click(); await sleep(400);
  check(app.classList.contains('mode-listen') === true, '能切到练耳朵模式');

  await closeAll();
  out.push('');
  out.push(fail ? '★ 竖屏交互全扫：' + fail + ' 项有问题' : '✅ 竖屏交互全扫：全部通过');
  return out.join('\n');
})()

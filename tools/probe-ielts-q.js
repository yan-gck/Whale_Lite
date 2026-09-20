/**
 * 端到端验证：雅思补充包课程在 App 里能不能看到「题目」。
 *
 * 背景：雅思的题干是占位符，真正的题目在原题 OCR 的版式化正文里，
 *       现在按题组渲染成可折叠的「原题正文」块。这个脚本就是验它真的出来了。
 *
 * 用法：node tools/probe-device.js --serial=... --eval-file=tools/probe-ielts-q.js
 */
(async function () {
  var out = [];
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var fail = 0;
  var check = function (ok, what) {
    if (!ok) fail++;
    out.push((ok ? '  [OK]  ' : '  [★坏] ') + what);
  };

  // 等课程列表里出现雅思补充包课程
  var ieltsItem = null;
  for (var i = 0; i < 60 && !ieltsItem; i++) {
    var items = document.querySelectorAll('.lesson-item');
    for (var k = 0; k < items.length; k++) {
      var t = items[k].textContent || '';
      if (/Test\s*\d/.test(t) && /雅思|IELTS|剑桥/.test(t)) { ieltsItem = items[k]; break; }
    }
    if (!ieltsItem) {
      // 用搜索框过滤一下更快
      var box = document.getElementById('search');
      if (box && !box.value) {
        box.value = 'Test';
        box.dispatchEvent(new Event('input', { bubbles: true }));
      }
      await sleep(500);
    }
  }
  check(!!ieltsItem, '雅思补充包课程出现在列表里');

  if (!ieltsItem) {
    out.push('  列表里前几门：' + [].slice.call(document.querySelectorAll('.lesson-item'))
      .slice(0, 5).map(function (e) { return (e.textContent || '').trim().slice(0, 20); }).join(' | '));
    return out.join('\n') + '\n\n★ 雅思课程没找到，后面的检查跳过';
  }

  ieltsItem.click();
  var a = document.getElementById('audio');
  for (var w = 0; w < 60 && !(a.duration > 0); w++) await sleep(250);
  await sleep(1200);

  var title = (document.getElementById('lessonTitle') || {}).textContent || '';
  out.push('  已选中：' + title);
  check(/Test/.test(title), '选中的是雅思课程');

  var qItems = document.querySelectorAll('#qBody .q-item');
  check(qItems.length > 0, '题目面板里有题目（' + qItems.length + ' 道）');

  var papers = document.querySelectorAll('#qBody .q-group-paper');
  check(papers.length > 0, '题组正文块渲染出来了（' + papers.length + ' 块）');

  if (papers.length) {
    var first = papers[0];
    var txt = first.querySelector('.q-paper-pre').textContent || '';
    var summary = first.querySelector('summary').textContent.trim();
    out.push('  第一块：' + summary);
    out.push('  正文长度 ' + txt.length + ' 字符，前 3 行：');
    txt.split('\n').slice(0, 3).forEach(function (l) { out.push('    | ' + l); });
    check(txt.length > 30, '正文不是空的（' + txt.length + ' 字符）');
    check(first.open === true, '正文默认展开（用户一眼能看到题目）');
    // 换行必须保留：版式就是信息
    check(txt.indexOf('\n') > 0, '正文保留了换行（版式没被压平）');
    var cs = getComputedStyle(first.querySelector('.q-paper-pre'));
    check(cs.whiteSpace === 'pre-wrap', 'CSS 是 pre-wrap（实际 ' + cs.whiteSpace + '）');
  }

  // 选择题的选项文字也要在
  var opts = document.querySelectorAll('#qBody .q-option');
  out.push('  选择题选项按钮：' + opts.length + ' 个');

  out.push('');
  out.push(fail ? '★ 雅思题目端到端：' + fail + ' 项有问题' : '✅ 雅思题目端到端：全部通过');
  return out.join('\n');
})()

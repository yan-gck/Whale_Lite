#!/usr/bin/env node
/**
 * test.js — 播放器核心逻辑回归测试（零依赖，node tools/test.js）
 *
 * 覆盖：
 *   1. LRC 解析（标准行时间戳 / 增强型逐词时间戳 / 元信息行）
 *   2. 字幕转 LRC（SRT / VTT / TED JSON / TSV）
 *   3. 中文路径与 URL 编码（曾出现 id 双重编码 bug）
 *   4. HTTP 服务的 Range 请求（拖动进度条依赖）与路径穿越防护
 *
 * 用法：
 *   node tools/test.js            # 仅跑不依赖服务的用例
 *   node tools/test.js --http     # 额外起临时服务跑 HTTP 用例
 */

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

// 需要外部进程（Python / JDK）的用例先登记，最后统一 await 执行：
// 文件是 CommonJS，顶层不能 await，而这些用例又必须真的跑完才算数。
const deferred = [];
function defer(name, fn) {
  deferred.push({ name, fn });
}

// ============================================================ 1. LRC 解析

console.log('\n[1] LRC 解析');

const { parseLrc, buildLibrary } = require(path.join(ROOT, 'lib', 'library.js'));
const AUDIO_DIR = path.join(ROOT, 'audio');

test('解析标准行时间戳', () => {
  const lines = parseLrc('[00:12.34]Hello world\n[01:05.00]Second line\n');
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0].time, 12.34);
  assert.strictEqual(lines[0].text, 'Hello world');
  assert.strictEqual(lines[1].time, 65);
  assert.strictEqual(lines[1].text, 'Second line');
});

test('忽略 [ti:]/[ar:]/[length:] 等元信息行', () => {
  const lines = parseLrc('[ti:标题]\n[ar:某人]\n[length:03:00.00]\n[00:01.00]正文\n');
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].text, '正文');
});

test('解析增强型逐词时间戳并保留全文', () => {
  // 真实生成格式：行首一个时间戳，随后逐词 <t>；第一个词的 t 与行首相同
  const lines = parseLrc('[00:01.00]<00:01.00>Good <00:01.50>morning\n');
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].time, 1);
  assert.strictEqual(lines[0].text, 'Good morning');
  assert.strictEqual(lines[0].words.length, 2);
  assert.strictEqual(lines[0].words[0].text, 'Good');
  assert.strictEqual(lines[0].words[0].time, 1);
  assert.strictEqual(lines[0].words[1].text, 'morning');
  assert.strictEqual(lines[0].words[1].time, 1.5);
});

test('一行多时间戳 + 逐词标记可共存', () => {
  const lines = parseLrc('[00:01.00][00:30.00]<00:01.00>Go <00:01.60>now\n');
  assert.strictEqual(lines.length, 2);
  assert.deepStrictEqual(lines.map((l) => l.time), [1, 30]);
  assert.strictEqual(lines[0].text, 'Go now');
  assert.strictEqual(lines[1].words.length, 2);
});

test('一个时间戳后跟多个词时共用该时间戳', () => {
  const lines = parseLrc('[00:02.00]<00:02.00>one two three\n');
  assert.strictEqual(lines[0].words.length, 3);
  assert.deepStrictEqual(lines[0].words.map((w) => w.text), ['one', 'two', 'three']);
  assert.ok(lines[0].words.every((w) => w.time === 2));
});

test('支持一行多个时间戳（重复副歌）', () => {
  const lines = parseLrc('[00:10.00][01:10.00]Chorus line\n');
  assert.strictEqual(lines.length, 2);
  assert.deepStrictEqual(lines.map((l) => l.time), [10, 70]);
});

test('输出按时间升序排列', () => {
  const lines = parseLrc('[00:30.00]b\n[00:10.00]a\n[00:20.00]c\n');
  assert.deepStrictEqual(lines.map((l) => l.text), ['a', 'c', 'b']);
});

test('三点毫秒写法 [mm:ss.xxx] 可用', () => {
  const lines = parseLrc('[01:02.500]X\n');
  assert.strictEqual(lines[0].time, 62.5);
});

test('空输入返回空数组', () => {
  assert.deepStrictEqual(parseLrc(''), []);
  assert.deepStrictEqual(parseLrc(null), []);
  assert.deepStrictEqual(parseLrc('[ti:只有元信息]\n'), []);
});

// ============================================================ 1.5 Python 脚本

console.log('\n[1.5] Python 脚本语法');

test('transcribe.py 语法正确', () => {
  const { execFileSync } = require('node:child_process');
  const py = path.join(ROOT, 'tools', 'transcribe.py');
  // 手改 Python 脚本容易引入缩进/括号错误，这里顺手挡一道
  execFileSync('python', [
    '-c',
    'import ast,sys; ast.parse(open(sys.argv[1],encoding="utf-8").read())',
    py,
  ], { stdio: 'pipe' });
});

test('merge_audio.py 语法正确', () => {
  const { execFileSync } = require('node:child_process');
  const py = path.join(ROOT, 'tools', 'merge_audio.py');
  execFileSync('python', [
    '-c',
    'import ast,sys; ast.parse(open(sys.argv[1],encoding="utf-8").read())',
    py,
  ], { stdio: 'pipe' });
});

test('ocr_pdf.py 语法正确', () => {
  const { execFileSync } = require('node:child_process');
  const py = path.join(ROOT, 'tools', 'ocr_pdf.py');
  execFileSync('python', [
    '-c',
    'import ast,sys; ast.parse(open(sys.argv[1],encoding="utf-8").read())',
    py,
  ], { stdio: 'pipe' });
});

// ============================================================ 1.6 做题流程

console.log('\n[1.6] 做题流程（答案解析 · 原文关联）');

const answerParser = require(path.join(ROOT, 'tools', 'parse-answers.js'));
const linker = require(path.join(ROOT, 'tools', 'link-answers.js'));

test('解析答案页：支持 Section 与 Part 两种写法', () => {
  const text = [
    'Section 1, Questions 1-10',
    '1 Ardleigh',
    '2 newspaper',
    'Section 2, Questions 11-20',
    '11 C',
    'Part 3, Questions 21-30',
    '21 A',
    'Part 4, Questions 31-40',
    '31 gene',
  ].join('\n');
  const secs = answerParser.findSections(text);
  assert.strictEqual(secs.length, 4, '应识别出 4 个 Section/Part 锚点');
  assert.deepStrictEqual(secs.map((s) => s.section), [1, 2, 3, 4]);
  assert.deepStrictEqual(secs.map((s) => s.from), [1, 11, 21, 31]);
});

test('解析答案页：两栏紧贴时仍能切出 4 个 Test', () => {
  // 新版书同页 4 个锚点紧贴，题号序列是 21→1→11→31
  const oneTest = 'Part 3, Questions 21-30Part 1, Questions 1-10' +
    'Part 4, Questions31-40Part 2, Questions 11-20';
  const four = new Array(4).fill(oneTest).join('\n');
  const tests = answerParser.splitTests(four);
  assert.strictEqual(tests.length, 4, '4 组锚点应切成 4 个 Test（不是 8-9 个）');
  for (const t of tests) assert.strictEqual(t.sections.length, 4);
});

test('OCR 归一化：竖线与罗马数字 Section 编号', () => {
  const out = answerParser.normalizeOcr('Section I, Questions 1-10\n1 shopping I variety');
  assert.ok(/Section\s+I/i.test(out), '罗马数字 Section 编号应保留');
  assert.ok(out.includes('|'), '作分隔符的 I 应归一化成 |');
});

test('答案拆成可接受列表（| 分隔）', () => {
  assert.deepStrictEqual(
    linker.__proto__ ? answerParser.splitAlternatives('shopping | variety of shopping') : [],
    ['shopping', 'variety of shopping'],
  );
  assert.deepStrictEqual(answerParser.splitAlternatives('(main) Workshop'), ['main Workshop']);
});

test('数字答案生成口语形式（用于匹配被念出的数字）', () => {
  assert.strictEqual(linker.numberToWords(160), 'one hundred and sixty');
  assert.strictEqual(linker.numberToWords(12), 'twelve');
  assert.strictEqual(linker.numberToWords(2020), 'two thousand twenty');
});

test('Section 归属：1-10=S1 … 31-40=S4', () => {
  assert.strictEqual(linker.sectionOf(1), 1);
  assert.strictEqual(linker.sectionOf(10), 1);
  assert.strictEqual(linker.sectionOf(11), 2);
  assert.strictEqual(linker.sectionOf(31), 4);
  assert.strictEqual(linker.sectionOf(40), 4);
});

test('取题号兼容 number / num 两种字段名', () => {
  // 这个 bug 曾导致 Section 兜底全部失效（表现为选择题一个都定位不到）
  assert.strictEqual(linker.qNum({ number: 7 }), 7);
  assert.strictEqual(linker.qNum({ num: 8 }), 8);
  assert.strictEqual(linker.qNum({}, 4), 5, '缺字段时应按序号兜底');
});

test('选择题答案也能定位到原文（走 Section 兜底）', () => {
  const lines = [
    { time: 0, text: 'Now turn to section one.' },
    { time: 30, text: 'Section 1.' },
    { time: 400, text: 'Now turn to section two.' },
    { time: 410, text: 'Section 2.' },
    { time: 800, text: 'Section 3.' },
    { time: 1200, text: 'Section 4.' },
  ];
  const questions = [
    { number: 1, answer: 'A' },     // 选择题
    { number: 11, answer: 'C' },    // 选择题
  ];
  const stat = linker.linkQuestions(questions, lines);
  assert.strictEqual(stat.none, 0, '不应有未定位的题');
  assert.ok(questions[0].answerLine != null, '第 1 题应有原文定位');
  assert.strictEqual(questions[0].linkMethod, 'section-choice');
  assert.ok(questions[1].answerLine != null, '第 11 题应有原文定位');
  assert.ok(questions[1].answerLine > questions[0].answerLine, 'Q11 应排在 Q1 之后');
});

test('答案文本命中时用精确匹配', () => {
  const lines = [
    { time: 0, text: 'Section 1.' },
    { time: 60, text: 'The theme of the festival is water.' },
  ];
  const questions = [{ number: 3, answer: 'theme' }];
  const stat = linker.linkQuestions(questions, lines);
  assert.strictEqual(stat.exact, 1);
  assert.strictEqual(questions[0].answerLine, 1);
  assert.strictEqual(questions[0].linkMethod, 'exact');
});

// ============================================================ 1.7 前端一致性
//
// 这类检查很值得常驻：前端是 HTML 与 JS 分离的，
// JS 里用 $('xxx') 取元素，一旦 id 拼错或改了 HTML 忘了改 JS，
// 只会在运行时静默失效（拿到 null），排查很费时间。

console.log('\n[1.7] 前端一致性');

test('JS 引用的 DOM id 在 HTML 里都存在', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const used = [...new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]))];
  const missing = used.filter((x) => !ids.has(x));
  assert.deepStrictEqual(missing, [], 'JS 引用了不存在的 id: ' + missing.join(', '));
});

test('CSS 类名在 JS/HTML 与样式表之间对得上', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  // 这些类名是做题流程的核心，两边都必须有定义与使用
  const critical = ['exam-hidden', 'exam-veil', 'q-input', 'q-verdict', 'q-jump',
    'q-answer-row', 'q-group-head', 'section-nav', 'import-body', 'mobile-toggle',
    'sheet-backdrop', 'answer-badges',
    // 补充包面板（新功能的界面部分）
    'pack-item', 'pack-progress', 'pack-dir-row', 'pack-error'];
  const missing = critical.filter((c) => !css.includes('.' + c) || !(js.includes(c) || html.includes(c)));
  assert.deepStrictEqual(missing, [], '这些类名缺定义或没被使用: ' + missing.join(', '));
});

test('index.html 只用相对路径引用资源（APK 里根路径会失效）', () => {
  // 真机实测：file:///android_asset/www/index.html 里写 "/app.js" 会被解析成
  // file:///app.js —— 既不是 assets 根目录、也不会经过 AssetClient 拦截，
  // 结果是装到手机上「没有样式、没有脚本」，整个 App 是死的（桌面上完全正常）。
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const bad = [...html.matchAll(/(?:src|href)="(\/[^"]*)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(bad, [], 'index.html 里不能有根路径引用：' + bad.join(', '));
  assert.ok(/<script src="app\.js"><\/script>/.test(html), '脚本应写成相对路径 app.js');
  assert.ok(/<link rel="stylesheet" href="style\.css">/.test(html), '样式应写成相对路径 style.css');
});

test('个性化：自定义背景 / 主题色 / 字号 的界面与实现都在', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');

  for (const id of ['settingsDrawer', 'btnSettings', 'bgLayer', 'bgPresets', 'fileBg',
    'bgDim', 'bgBlur', 'panelAlpha', 'accentChips', 'lyricSize']) {
    assert.ok(html.includes(`id="${id}"`), `index.html 缺少 #${id}`);
  }
  assert.ok(/function applyAppearance\s*\(/.test(js), '缺少外观应用函数');
  assert.ok(/function readImageAsBackground\s*\(/.test(js), '缺少背景图压缩函数');
  assert.ok(/toDataURL\('image\/jpeg',\s*0\.82\)/.test(js), '背景图应压缩后再存（localStorage 只有 5MB）');
  assert.ok(/BG_PRESETS/.test(js) && /ACCENTS/.test(js), '缺少预设背景 / 主题色定义');

  assert.ok(/\.bg-layer\b/.test(css), '缺少背景层样式');
  assert.ok(/body\.has-bg\s*\{[^}]*--bg-1/.test(css), '开启背景后面板应半透明');
  assert.ok(/--lyric-size/.test(css), '原文字号应走 CSS 变量');
});

test('达标绿是固定色，不跟着主题色变（用户要求 ≥60% 显示绿色）', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
  assert.ok(/--ok:\s*#4ade80/i.test(css), '应定义固定的达标绿 --ok');
  for (const sel of ['.accuracy.good', '.li-acc.good', '.grade-sub .grade-ok']) {
    const re = new RegExp(sel.replace(/\./g, '\\.') + '\\s*\\{[^}]*var\\(--ok\\)');
    assert.ok(re.test(css), `${sel} 必须用 --ok（不能用会随主题变的 --accent）`);
  }
});

test('人性化：续听 / 学习记录 / 睡眠定时 / 习惯记忆 都在', () => {
  const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');

  assert.ok(html.includes('id="resumeBar"'), '缺少续听提示条');
  assert.ok(html.includes('id="sleepTimer"'), '缺少睡眠定时下拉');
  assert.ok(/function readResume\s*\(/.test(js) && /function applyResume\s*\(/.test(js),
    '缺少续听逻辑');
  assert.ok(/function recordPosition\s*\(/.test(js) && /function recordScore\s*\(/.test(js),
    '缺少学习记录写入');
  assert.ok(/function setSleepTimer\s*\(/.test(js), '缺少睡眠定时实现');
  assert.ok(/listening-player\.progress\.v1/.test(js), '学习记录应持久化');
  assert.ok(/listening-player\.lastLesson/.test(js), '应记住上次的课程');
  assert.ok(/function applyPlaybackPrefs\s*\(/.test(js), '播放习惯应能恢复');
  // 习惯要真的写回去（倍速/显示模式/自动滚动/听写/复读）
  const saveCount = (js.match(/settings\.(speed|displayMode|follow|blur|repeat)\s*=/g) || []).length;
  assert.ok(saveCount >= 5, `播放习惯应逐项持久化（只找到 ${saveCount} 处）`);
  assert.ok(/\.resume-bar\b/.test(css) && /\.li-acc\b/.test(css), '缺少续听条 / 进度徽标样式');
});

test('实战 / 练耳朵 两种模式', () => {
  const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
  assert.ok(html.includes('id="modeSwitch"'), 'index.html 缺少模式切换');
  assert.ok(html.includes('data-mode="exam"') && html.includes('data-mode="listen"'), '缺少两个模式按钮');
  assert.ok(/MODE_LISTEN\s*=\s*'listen'/.test(js) && /function isListenMode\s*\(/.test(js), '缺少模式判定');
  assert.ok(/function applyMode\s*\(/.test(js), '缺少模式应用');
  assert.ok(/mode:\s*'exam'/.test(js), '默认应为实战模式');
  assert.ok(/isListenMode\(\)\) return;/.test(js), '练耳朵模式下应忽略作答');
  assert.ok(/\.app\.mode-listen \.exam-bar/.test(css), '练耳朵模式应藏掉流程条');
});

test('进度条拖动：拖动只预览、松手才跳（避免连续 seek 卡死）', () => {
  const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  assert.ok(/function previewSeek\s*\(/.test(js) && /function commitSeek\s*\(/.test(js),
    '拖动应拆成「预览」与「提交」两步');
  // 预览阶段不许写 currentTime
  const preview = /function previewSeek\(ev\) \{([\s\S]*?)\n\}/.exec(js);
  assert.ok(preview, '找不到 previewSeek');
  assert.ok(!/currentTime\s*=/.test(preview[1]), '拖动预览阶段不能改播放位置');
  assert.ok(/touchmove/.test(js), '手机拖动要监听 touchmove（以前只监听 touchstart）');
  assert.ok(/function resumeAfterSeek\s*\(/.test(js), '松手后若被掐断应自动续播');
  assert.ok(/dragWasPlaying/.test(js), '要记住拖动前是否在播放，别把主动暂停的也强行播起来');
});

test('播放按钮状态永远跟着 audio.paused（事件丢了也不会停在 ⏸）', () => {
  const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  assert.ok(/function syncPlayButton\s*\(/.test(js), '缺少按钮状态同步');
  assert.ok(/function tickControl[\s\S]{0,200}syncPlayButton\(\)/.test(js),
    '定时循环里每个周期都要同步一次按钮状态');
  assert.ok(/function watchStall\s*\(/.test(js), '缺少卡顿看门狗');
  assert.ok(/stallRecoveries/.test(js), '看门狗要有分级恢复（重播 → 重新加载）');
});

test('界面文案用用户看得懂的说法', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  // ±5 秒、循环起点/终点要说清楚（以前是 ⟲5 / 5⟳ / 设A / 清A-B）
  assert.ok(html.includes('id="btnBack5" title="后退 5 秒 (←)">−5s'), '快退按钮应写「−5s」');
  assert.ok(html.includes('id="btnFwd5" title="前进 5 秒 (→)">+5s'), '快进按钮应写「+5s」');
  assert.ok(html.includes('>设置循环起点<'), 'A 点应叫「设置循环起点」');
  assert.ok(html.includes('>设置循环终点<'), 'B 点应叫「设置循环终点」');
  assert.ok(html.includes('>清除循环<'), '清 A-B 应叫「清除循环」');
  assert.ok(!/设 A|清 A-B|⟲5|5⟳/.test(html), '不应再出现「设 A / 清 A-B / ⟲5」这种看不懂的写法');
  // 面向用户的说明里不该出现实现细节（先剥掉注释再查：
  // 代码注释里保留这些背景知识是好事，用户看不到）
  const jsCode = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(!/2 GiB|2GiB|APK 装不下/.test(jsCode), '补充包说明不该对用户讲 APK 体积上限');
  assert.ok(/批量导入听力材料/.test(jsCode), '补充包应解释成「批量导入听力材料」');
  // 侧栏收起后要有回来的入口
  assert.ok(html.includes('id="btnExpandSidebar"'), '缺少侧栏展开按钮');
});

test('内置「制作补充包」教程', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.ok(/怎么自己做一个/.test(html), '补充包面板里应有制作教程');
  assert.ok(/tools\/build-pack\.js --set=/.test(html), '教程应给出打包命令');
  assert.ok(/tools\/pack-info\.js/.test(html), '教程应提到打包后校验');
});

// ============================================================ 1.71 布局与抽屉（用户报的 bug）
//
// 这一组全是用户实测报上来的：「更多点不动」「题目收起来再也打不开」
// 「不同分辨率 UI 会乱」「竖屏交互处处是 bug」。
// 根因都不是"逻辑写错"，而是**结构/样式**问题 —— 静态检查正好能盯住，
// 而且比真机探针快得多。下面每一条都对应一次真实的翻车。

test('顶栏按钮不许被挤出屏幕（横向滚动 = 藏起来 = 点不到）', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
  const bar = css.match(/\.topbar-actions\s*\{[\s\S]*?\}/);
  assert.ok(bar, '找不到 .topbar-actions 样式');
  assert.ok(!/overflow-x:\s*auto/.test(bar[0]),
    '顶栏不许横向滚动：窄屏上「原文/更多/设置」会被推到屏幕外，用户完全点不到（用户报的就是「更多点不动」）');
  assert.ok(/flex-wrap:\s*wrap/.test(bar[0]), '顶栏按钮应该换行，而不是滚出去');
});

test('题目面板只有一个状态类（两个类打架 = 收起后打不开）', () => {
  const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  for (const [name, src] of [['app.js', js], ['style.css', css], ['index.html', html]]) {
    // 先剥掉注释再查：代码注释里解释这个坑是好事，用户又看不到（本项目的惯例）
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\/[^\n]*/g, '');
    assert.ok(!/mobile-qpanel-open/.test(code),
      `${name} 里又出现了 mobile-qpanel-open：面板状态必须只由 .no-qpanel 表示`
      + '（两套状态在窄屏下会互相顶掉，表现为「收起来就再也展不开」）');
  }
  assert.ok(/function setQPanel\(/.test(js), '应该有一个统一的 setQPanel()');
  assert.ok(/function toggleQPanel\(/.test(js), '应该有一个统一的 toggleQPanel()');
  // 两个入口（顶栏「题目」和右下角浮动 📝）必须走同一个函数
  assert.ok(/btnToggleQuestions'\)\.addEventListener\('click', toggleQPanel\)/.test(js),
    '顶栏「题目」应调用 toggleQPanel');
  assert.ok(/btnMobileQpanel\?\.addEventListener\('click',[\s\S]{0,200}?toggleQPanel\(\)/.test(js),
    '浮动 📝 应调用 toggleQPanel');
  // 抽屉里要有明确的关闭按钮：面板打开时会盖住右下角的浮动 📝
  assert.ok(html.includes('id="btnCloseQpanel"'), '题目抽屉里缺少关闭按钮');
});

test('抽屉遮罩必须放在 .app 里面（否则选择器永远匹配不到）', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
  const backdrop = html.indexOf('id="sheetBackdrop"');
  const qpanel = html.indexOf('id="qpanel"');
  const rawDrawer = html.indexOf('id="rawDrawer"');   // 它在 .app 外面
  assert.ok(backdrop > 0, '找不到 #sheetBackdrop');
  assert.ok(qpanel > 0 && rawDrawer > qpanel, '页面结构变了，先看一眼 index.html');
  assert.ok(backdrop > qpanel && backdrop < rawDrawer,
    '#sheetBackdrop 必须在 .app 容器内部：样式表里用的是 `.app:not(.no-qpanel) .sheet-backdrop`，'
    + '放在 .app 外面这条选择器永远不成立 —— 遮罩从加进来那天起就是死代码，点空白处关不掉抽屉');
  // 遮罩的显示条件只认 .no-qpanel（配合上面那条「只有一个状态类」）
  assert.ok(/\.app:not\(\.no-qpanel\)\s+\.sheet-backdrop/.test(css),
    '遮罩的显示条件应写成 .app:not(.no-qpanel) .sheet-backdrop');
});

test('浮动开关不能压在模态抽屉上面', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
  const zOf = (sel) => {
    const m = css.match(new RegExp(sel.replace('.', '\\.') + '\\s*\\{[\\s\\S]*?z-index:\\s*(\\d+)'));
    return m ? Number(m[1]) : null;
  };
  const toggle = zOf('.mobile-toggle');
  const drawer = zOf('\n.drawer');
  assert.ok(toggle !== null && drawer !== null, '取不到 .mobile-toggle / .drawer 的 z-index');
  assert.ok(drawer > toggle,
    `模态抽屉的 z-index(${drawer}) 必须高于浮动开关(${toggle})，`
    + '否则竖屏下 ☰ / 📝 会浮在设置面板上挡住文字');
});

test('原文留白跟着滚动区高度走，而不是写死 vh', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const lyrics = css.match(/\.lyrics\s*\{[\s\S]*?\}/);
  assert.ok(lyrics, '找不到 .lyrics 样式');
  const vertical = (lyrics[0].match(/padding:\s*([^;]+);/) || [])[1] || '';
  assert.ok(!/^\s*\d+vh/.test(vertical),
    '原文区的上下留白不能写死 vh：横屏手机上滚动区只有 200 多 px，88vh 的留白会把当前句顶出可视区');
  assert.ok(/--lyric-pad-top/.test(css) && /syncLyricPad/.test(js),
    '留白应该由 syncLyricPad() 按滚动区高度算出来');
});

test('A-B 循环的「终点 / 清除」按钮按需出现（窄屏省一整行）', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  // 起点按钮必须一直在，否则用户没法开始划区间
  assert.ok(/id="btnSetA"[^>]*>设置循环起点</.test(html), '「设置循环起点」必须始终可见');
  assert.ok(/class="ghost-btn ab-extra" id="btnSetB"/.test(html), '「设置循环终点」应带 ab-extra');
  assert.ok(/class="ghost-btn ab-extra" id="btnClearAB"/.test(html), '「清除循环」应带 ab-extra');
  assert.ok(/\.ab-extra\s*\{\s*display:\s*none/.test(css), 'CSS 里 .ab-extra 默认应隐藏');
  assert.ok(/\.app\.has-ab\s+\.ab-extra\s*\{\s*display:\s*inline-flex/.test(css),
    '设了起点之后要能把它们显示出来');
  // 只在 updateLoopUI 里切换，保证「设A → 出现 / 清除 → 收起」两条路都对
  assert.ok(/classList\.toggle\('has-ab',\s*a != null\)/.test(js),
    'updateLoopUI 里应按「有没有起点」切换 has-ab');
  // 关键：只是 display:none，不能真从 DOM 里摘掉（快捷键与探针都按 id 找它们）
  assert.ok(html.includes('id="btnSetB"') && html.includes('id="btnClearAB"'),
    '这两个按钮必须留在 DOM 里');
});

test('雅思题：题组正文要能传到前端并渲染出来', () => {
  const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
  const lib = fs.readFileSync(path.join(ROOT, 'lib', 'library.js'), 'utf8');
  const pack = fs.readFileSync(path.join(ROOT, 'tools', 'build-pack.js'), 'utf8');
  const merge = fs.readFileSync(path.join(ROOT, 'tools', 'merge-paper.js'), 'utf8');

  // 数据链路：merge-paper 产出 → library 读取 → 打包带上 → 前端渲染，四段缺一不可
  assert.ok(/doc\.questionGroups\s*=/.test(merge),
    'merge-paper.js 应把题组正文写进 questions.json（不然雅思题在界面上只有题号+答案）');
  assert.ok(/questionsDoc\.questionGroups/.test(lib),
    'lib/library.js 应把 questionGroups 透出来');
  assert.ok(/questionGroups:\s*l\.questionGroups/.test(pack),
    'build-pack.js 应把 questionGroups 打进 library.json（手机端全靠它）');
  assert.ok(/function renderGroupPaper\s*\(/.test(js), 'app.js 里应有 renderGroupPaper()');
  assert.ok(/renderGroupPaper\(q\.group\)/.test(js), '题目面板换题组时应调用 renderGroupPaper');
  assert.ok(/q-group-paper/.test(css), 'CSS 里应有 .q-group-paper 样式');
  // 正文是 OCR 的版式化文本，必须保留换行（空白和答案在行内是交错的）
  assert.ok(/white-space:\s*pre-wrap/.test(css), '题组正文要 pre-wrap，否则版式信息全丢');
});

test('问题反馈渠道（仓库 Issues）在界面上找得到', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const REPO = 'https://github.com/yan-gck/Whale_Lite';
  assert.ok(html.includes(`${REPO}/issues`), '设置面板里应有仓库 Issues 地址');
  assert.ok(new RegExp(`FEEDBACK_URL\\s*=\\s*'${REPO}/issues'`).test(js),
    'app.js 里应有 FEEDBACK_URL 常量指向 Issues 页');
  assert.ok(html.includes('id="btnCopyFeedback"'), '应有「复制反馈信息」按钮');
  assert.ok(html.includes('id="btnOpenFeedback"'), '应有「去提 issue」入口');
  assert.ok(/id="btnFeedback"/.test(html), '「更多」菜单里应有问题反馈入口');
  // 反馈入口必须是真外链：手机上靠 MainActivity 的 shouldOverrideUrlLoading
  // 交给系统浏览器，电脑上新开标签页；用 button + location.href 会把播放器界面顶掉
  assert.ok(/<a[^>]+id="btnOpenFeedback"[^>]+target="_blank"/.test(html),
    '「去提 issue」应是 target="_blank" 的 <a>，不能是 button');
  assert.ok(/shouldOverrideUrlLoading/.test(
    fs.readFileSync(path.join(ROOT, 'android', 'src', 'com', 'dsh', 'listeningplayer', 'MainActivity.java'), 'utf8')),
    'MainActivity 应重写 shouldOverrideUrlLoading，否则手机点外链会把 App 界面顶掉');
  // 反馈信息里要带上版本号与机型，否则拿到一句「打不开」根本没法定位
  assert.ok(/APP_VERSION/.test(js), '反馈信息里应带版本号');
  assert.ok(/navigator\.userAgent/.test(js), '反馈信息里应带环境信息');
  assert.ok(/window\.innerWidth/.test(js), '反馈信息里应带屏幕尺寸');
  // 版本号两边要对得上：用户截图报「v1.3」时，装的必须真的是 1.3
  const manifest = fs.readFileSync(path.join(ROOT, 'android', 'AndroidManifest.xml'), 'utf8');
  const appVer = (js.match(/APP_VERSION\s*=\s*'([\d.]+)'/) || [])[1];
  const apkVer = (manifest.match(/android:versionName="([\d.]+)"/) || [])[1];
  assert.ok(appVer && apkVer && appVer === apkVer,
    `app.js 的 APP_VERSION(${appVer}) 与清单的 versionName(${apkVer}) 必须一致`);
});

test('wav-to-mp3.py 语法正确', () => {
  const { execFileSync } = require('node:child_process');
  execFileSync('python', [
    '-c',
    'import ast,sys; ast.parse(open(sys.argv[1],encoding="utf-8").read())',
    path.join(ROOT, 'tools', 'wav-to-mp3.py'),
  ], { stdio: 'pipe' });
});

test('做题流程的两个阶段都有对应的界面状态', () => {
  const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  assert.ok(/phase\s*=\s*'answering'/.test(js), '缺少做题阶段');
  assert.ok(/phase\s*=\s*'reviewing'/.test(js), '缺少复盘阶段');
  // 作答阶段必须隐藏原文，否则等于直接给答案
  assert.ok(/exam-hidden/.test(js), '缺少原文隐藏逻辑');
});

test('批改后显示正确率，60% 是颜色分界（≥60 绿 / <60 红）', () => {
  const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');

  // 分界线抽成常量：以后谁改成 50/70 都得先改这里，避免悄悄变卦
  assert.ok(/PASS_RATE\s*=\s*60\b/.test(js), '缺少 60% 分界常量');
  assert.ok(/\?\s*'good'\s*:\s*'bad'/.test(js), '缺少绿/红等级判定');
  assert.ok(/function accuracyOf\s*\(/.test(js), '缺少正确率计算函数');
  assert.ok(/updateExamProgress[\s\S]{0,400}accuracyHtml/.test(js),
    '批改后顶部流程条应显示正确率');
  assert.ok(/grade-banner/.test(js), '题目面板应显示批改结果横幅');
  assert.ok(/正确率 \$\{acc\.pct\}%/.test(js), '批改提示语应含正确率');

  // 颜色定义（两种状态都必须有，且用不同颜色）
  assert.ok(/--red:\s*#ef4444/i.test(css), '样式表应定义红色变量');
  assert.ok(/\.accuracy\.good\s*\{[^}]*var\(--ok\)/.test(css), '.accuracy.good 应为绿色');
  assert.ok(/\.accuracy\.bad\s*\{[^}]*var\(--red\)/.test(css), '.accuracy.bad 应为红色');
  assert.ok(/\.accuracy\.big\s*\{/.test(css), '横幅里的大号正确率样式');
});

// ============================================================ 1.8 原题 PDF 解析

console.log('\n[1.8] 原题抽取与合并');

const paperParser = require(path.join(ROOT, 'tools', 'parse-paper.js'));
const paperMerge = require(path.join(ROOT, 'tools', 'merge-paper.js'));

test('原题 OCR 文本按页切分', () => {
  const text = '━━━━━ 第 1 页 ━━━━━\nTest 1\nSECTION 1 Questions 1-10\n'
    + '━━━━━ 第 2 页 ━━━━━\nQuestions 7-10\nComplete the table below.';
  const pages = paperParser.splitPages(text);
  assert.strictEqual(pages.length, 2);
  assert.strictEqual(pages[0].pno, 1);
  assert.ok(/Test 1/.test(pages[0].text));
  assert.ok(/Complete the table/.test(pages[1].text));
});

test('从题组文本里拆出题型指令', () => {
  const body = [
    'Complete the notes below.',
    'Write ONE WORD AND/OR A NUMBER for each answer.',
    'SELF-DRIVE TOURS IN THE USA',
    'Address: 24 1 Road',
  ].join('\n');
  const r = paperParser.splitInstructions(body);
  assert.strictEqual(r.instructions.length, 2);
  assert.ok(/Complete the notes/.test(r.instructions[0]));
  assert.ok(/Write ONE WORD/.test(r.instructions[1]));
  assert.ok(r.content.includes('SELF-DRIVE TOURS IN THE USA'), '正文应保留在 content 里');
});

test('从题组正文里提出选项', () => {
  const lines = ['A the gym', 'B the tracks', 'C the indoor pool', 'not an option'];
  const opts = paperParser.extractOptions(lines);
  assert.strictEqual(opts.length, 3);
  assert.strictEqual(opts[0].key, 'A');
  assert.strictEqual(opts[0].text, 'the gym');
});

test('题号归属到正确的题组', () => {
  const groups = [{ from: 1, to: 6 }, { from: 7, to: 10 }, { from: 21, to: 25 }];
  assert.strictEqual(paperMerge.groupOf(groups, 3).to, 6);
  assert.strictEqual(paperMerge.groupOf(groups, 8).from, 7);
  assert.strictEqual(paperMerge.groupOf(groups, 23).from, 21);
  assert.strictEqual(paperMerge.groupOf(groups, 15), null, '不在任何题组里应返回 null');
});

// ============================================================ 1.9 补充包
//
// 单个 APK 有 2 GiB 硬上限，素材拆成「安装包 + 补充包（.lppack）」。
// 这里验证三件事：
//   ① 包的格式（中文条目名 UTF-8、音频 STORED、manifest/library 齐全）
//   ② 前端与 Android 侧共用同一段 URL 空间（两边字符串对不上就播不出声）
//   ③ Java 侧真实的读取逻辑（ZIP 随机访问 + 手工 Range）—— 用电脑上的
//      javac/java 直接跑 PackStore，不必刷手机（见 tools/java/PackSelfTest.java）

console.log('\n[1.9] 补充包（.lppack）');

const packTool = require(path.join(ROOT, 'tools', 'build-pack.js'));

const PACK_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-pack-'));
const PACK_SET = '测试-素材';
const PACK_ENTRY = `audio/${PACK_SET}/课程一.mp3`;
const PACK_LRC_ENTRY = `audio/${PACK_SET}/课程一.lrc`;
const PACK_AUDIO_BYTES = Buffer.alloc(200 * 1024);
for (let i = 0; i < PACK_AUDIO_BYTES.length; i++) PACK_AUDIO_BYTES[i] = (i * 31 + 7) & 0xff;
const PACK_AUDIO_FILE = path.join(PACK_TMP, '课程一.mp3');
const PACK_FILE = path.join(PACK_TMP, '测试补充包.lppack');
const PACK_LRC_TEXT = '[00:01.00]第一句中文原文\n[00:03.00]Second line\n'
  // 故意超过 512 字节：打包器对 >512 字节的文本才会 deflate（小文件压了反而更大）
  + Array.from({ length: 80 }, (_, i) => `[01:${String(i).padStart(2, '0')}.00]填充行 filler line ${i}`)
    .join('\n') + '\n';

(function makeTestPack() {
  const setDir = path.join(PACK_TMP, PACK_SET);
  fs.mkdirSync(setDir, { recursive: true });
  fs.writeFileSync(PACK_AUDIO_FILE, PACK_AUDIO_BYTES);
  fs.writeFileSync(path.join(setDir, '课程一.lrc'), PACK_LRC_TEXT, 'utf8');

  const manifest = {
    format: packTool.FORMAT, version: packTool.FORMAT_VERSION, set: PACK_SET,
    lessons: 1, audioFiles: 1, hasLibrary: true,
    note: '单元测试用的最小补充包',
  };
  const manifestFile = path.join(PACK_TMP, 'manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest), 'utf8');
  const libraryFile = path.join(PACK_TMP, 'library.json');
  fs.writeFileSync(libraryFile, JSON.stringify({
    format: packTool.FORMAT, version: packTool.FORMAT_VERSION, set: PACK_SET, count: 1,
    lessons: [{
      manifest: { id: `${PACK_SET}/课程一.mp3`, title: '课程一', exam: 'other', folder: PACK_SET, lineCount: 2 },
      lines: [{ time: 1, text: '第一句中文原文' }, { time: 3, text: 'Second line' }],
      translationLines: [], questions: [], transcript: '', paper: '',
    }],
  }), 'utf8');

  const zip = packTool.createZip(PACK_FILE);
  zip.addFile('manifest.json', manifestFile, true);
  zip.addFile('library.json', libraryFile, true);
  // 音频和真实打包一样走 STORED（不压缩）
  zip.addFile(PACK_ENTRY, PACK_AUDIO_FILE, false);
  zip.addFile(PACK_LRC_ENTRY, path.join(setDir, '课程一.lrc'), true);
  zip.finish();
})();

/** 极简 ZIP 中央目录读取（仅测试用，够校验结构就行） */
function zipEntries(file) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  assert.ok(eocd >= 0, '找不到 EOCD，不是合法 ZIP');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    out.push({
      name: buf.toString('utf8', off + 46, off + 46 + nameLen),
      flags: buf.readUInt16LE(off + 8),
      method: buf.readUInt16LE(off + 10),
      csize: buf.readUInt32LE(off + 20),
      usize: buf.readUInt32LE(off + 24),
      localOff: buf.readUInt32LE(off + 42),
    });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** 读一个条目的原始字节（STORED 直接取，deflate 解压） */
function zipEntryBuffer(file, entry) {
  const buf = fs.readFileSync(file);
  assert.strictEqual(buf.readUInt32LE(entry.localOff), 0x04034b50, '本地头损坏');
  const nameLen = buf.readUInt16LE(entry.localOff + 26);
  const extraLen = buf.readUInt16LE(entry.localOff + 28);
  const start = entry.localOff + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + entry.csize);
  if (entry.method === 0) return Buffer.from(data);
  assert.strictEqual(entry.method, 8, '不支持的压缩方法 ' + entry.method);
  return require('node:zlib').inflateRawSync(data);
}

/** 读一个 STORED 条目的原始字节（不看压缩方法，用来验证音频是原样存放的） */
function zipStoredData(file, entry) {
  assert.strictEqual(entry.method, 0, `${entry.name} 不是 STORED 存放`);
  return zipEntryBuffer(file, entry);
}

test('补充包结构：manifest.json / library.json / audio 条目齐全', () => {
  const names = zipEntries(PACK_FILE).map((e) => e.name);
  for (const need of ['manifest.json', 'library.json', PACK_ENTRY, PACK_LRC_ENTRY]) {
    assert.ok(names.includes(need), `包里缺少 ${need}（实际：${names.join(', ')}）`);
  }
});

test('包内条目名带 UTF-8 标志（中文路径必需）', () => {
  for (const e of zipEntries(PACK_FILE)) {
    assert.ok((e.flags & 0x0800) !== 0, `${e.name} 没有置 UTF-8 名字标志`);
  }
});

test('包内音频用 STORED 存放（Java 侧靠它做廉价 Range skip）', () => {
  const entries = zipEntries(PACK_FILE);
  const audio = entries.find((e) => e.name === PACK_ENTRY);
  assert.strictEqual(audio.method, 0, '音频不应被压缩');
  assert.strictEqual(audio.usize, PACK_AUDIO_BYTES.length, '音频字节数');
  const text = entries.find((e) => e.name === PACK_LRC_ENTRY);
  assert.strictEqual(text.method, 8, '文本条目应当 deflate 压缩');
});

test('包内音频字节与原始文件完全一致', () => {
  const audio = zipEntries(PACK_FILE).find((e) => e.name === PACK_ENTRY);
  assert.ok(zipStoredData(PACK_FILE, audio).equals(PACK_AUDIO_BYTES), 'STORED 数据应逐字节一致');
});

test('manifest.json 记录 set / 版本 / 课程数', () => {
  const e = zipEntries(PACK_FILE).find((x) => x.name === 'manifest.json');
  const m = JSON.parse(zipEntryBuffer(PACK_FILE, e).toString('utf8'));
  assert.strictEqual(m.format, 'listening-player-pack');
  assert.strictEqual(m.version, 2, '当前包格式版本');
  assert.strictEqual(m.hasLibrary, true, 'v2 包必须带 library.json');
  assert.strictEqual(m.set, PACK_SET);
});

defer('buildPackLibrary 产出与桌面端同源的课程数据', async () => {
  const lib = await packTool.buildPackLibrary('CET4-演示');
  assert.strictEqual(lib.format, 'listening-player-pack');
  assert.strictEqual(lib.version, 2);
  assert.strictEqual(lib.set, 'CET4-演示');
  assert.ok(lib.count > 0, '演示语料里应当有课程');
  assert.strictEqual(lib.lessons.length, lib.count);
  for (const l of lib.lessons) {
    assert.ok(l.manifest && l.manifest.id, '每门课都要有 manifest.id');
    assert.ok(Array.isArray(l.lines), '课程数据要带时间轴');
    assert.ok(Array.isArray(l.questions), '课程数据要带题目');
    assert.ok(Array.isArray(l.translationLines), '课程数据要带译文行');
  }
  // 只应包含该素材目录下的课程
  const bad = lib.lessons.filter((l) => {
    const f = l.manifest.folder || '';
    return f !== lib.set && !f.startsWith(lib.set + '/');
  });
  assert.deepStrictEqual(bad.map((l) => l.manifest.id), [], '不能混入其它素材目录的课程');
});

// ---------- 前后端一致性：URL 空间与 JS 桥 ----------

const JAVA_SRC = path.join(ROOT, 'android', 'src', 'com', 'dsh', 'listeningplayer');

test('前端与 Android 侧共用同一段补充包 URL 空间', () => {
  const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const java = fs.readFileSync(path.join(JAVA_SRC, 'MainActivity.java'), 'utf8');

  const m = /PACK_MARKER\s*=\s*"([^"]+)"/.exec(java);
  assert.ok(m, 'MainActivity 里应当定义 PACK_MARKER');
  assert.strictEqual(m[1], '/android_asset/www/pack/', 'URL 空间前缀');

  // 前端拼的必须是 baseUrl + 'pack/' + 包名 + '/audio/' + 课程 id
  assert.ok(/baseUrl\s*\+\s*'pack\/'/.test(js), 'app.js 应把包名拼进 URL');
  assert.ok(js.includes("'/audio/'"), 'app.js 应在包内定位到 audio/ 目录');
  // Java 侧从 URL 里截出来的相对路径是包内路径，直接喂给 ZipFile
  assert.ok(/PACK_MARKER\)/.test(java), 'MainActivity 应按 PACK_MARKER 截取包内路径');
  // 打包工具写入的条目名必须与之一致
  const packJs = fs.readFileSync(path.join(ROOT, 'tools', 'build-pack.js'), 'utf8');
  assert.ok(packJs.includes('`audio/${setName}/${rel}`'), 'build-pack 应把素材放在 audio/<目录名>/ 下');
});

test('JS 桥名称两端一致（AndroidHost）', () => {
  const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const java = fs.readFileSync(path.join(JAVA_SRC, 'MainActivity.java'), 'utf8');
  assert.ok(/addJavascriptInterface\([^,]+,\s*"AndroidHost"\)/.test(java), 'Java 侧应注册 AndroidHost');
  assert.ok(js.includes('window.AndroidHost'), 'app.js 应使用 window.AndroidHost');
  for (const fn of ['packs', 'packTextLength', 'packTextChunk', 'importPack', 'deletePack', 'rescanPacks']) {
    assert.ok(new RegExp(`@JavascriptInterface[\\s\\S]{0,200}?\\b${fn}\\s*\\(`).test(java),
      `Java 桥里缺少 ${fn}()`);
  }
});

test('读取补充包不需要任何存储权限（后台保活需要的那几个除外）', () => {
  // getExternalFilesDir(null) 是 App 私有外部目录：数据线可写、无需权限。
  // 这条是硬约束 —— 一旦有人加了存储权限，用户就得面对授权弹窗。
  const xml = fs.readFileSync(path.join(ROOT, 'android', 'AndroidManifest.xml'), 'utf8');
  const perms = [...xml.matchAll(/uses-permission[^>]*android:name="([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(perms, [
    'android.permission.INTERNET',
    // 后台/锁屏保活所需（都不是存储权限）
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
    'android.permission.WAKE_LOCK',
    'android.permission.POST_NOTIFICATIONS',
  ]);
  const storage = perms.filter((p) => /STORAGE|MANAGE_EXTERNAL|READ_MEDIA/i.test(p));
  assert.deepStrictEqual(storage, [], '不应申请任何存储权限');
});

// ---------- 后台 / 锁屏保活 ----------
//
// 这一块全是「手机上看不见就出错」的逻辑：没开前台服务 → 锁屏就被系统掐掉；
// 少了唤醒锁 → 熄屏后音频断续；WebView.onPause() → 熄屏后歌词/循环停摆。
// 静态检查虽然笨，但正好能挡住这几类回归。

test('清单里声明了播放前台服务（foregroundServiceType=mediaPlayback）', () => {
  const xml = fs.readFileSync(path.join(ROOT, 'android', 'AndroidManifest.xml'), 'utf8');
  assert.ok(/<service[\s\S]*?android:name="\.PlaybackService"/.test(xml), '缺少 PlaybackService 声明');
  assert.ok(/foregroundServiceType="mediaPlayback"/.test(xml),
    'Android 14 起必须声明 mediaPlayback 类型，否则 startForeground 会抛异常');
  assert.ok(/android:exported="false"/.test(xml), '前台服务不应导出给其它 App');
});

test('前台服务持有唤醒锁与媒体会话（熄屏不断音、锁屏可控）', () => {
  const java = fs.readFileSync(path.join(JAVA_SRC, 'PlaybackService.java'), 'utf8');
  assert.ok(/PARTIAL_WAKE_LOCK/.test(java), '缺少 PARTIAL_WAKE_LOCK：熄屏后 CPU 休眠会断音');
  assert.ok(/setReferenceCounted\(false\)/.test(java), '唤醒锁应关闭引用计数，避免泄漏');
  assert.ok(/new MediaSession\(/.test(java), '缺少 MediaSession：锁屏/通知栏无法控制');
  assert.ok(/FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK/.test(java), 'startForeground 要带 mediaPlayback 类型');
  // 只在播放时持有唤醒锁，暂停必须释放（省电）
  assert.ok(/if \(playing\)[\s\S]{0,200}setWakeLock\(true\)/.test(java), '播放时应持有唤醒锁');
  assert.ok(/setWakeLock\(false\)/.test(java), '暂停/销毁时必须释放唤醒锁');
});

test('前台服务不许抢音频焦点（会和 WebView 互抢导致一播放就暂停）', () => {
  // 真机实测：音频由网页里的 <audio> 播放，Chromium 自己会申请音频焦点；
  // 服务再申请一次就变成「自己跟自己抢」——Chromium 收到 AUDIOFOCUS_LOSS 后立刻暂停，
  // 现象是「按下播放约 0.1 秒后自动暂停」。所以这里反过来守住：不许再出现申请焦点的代码。
  const raw = fs.readFileSync(path.join(JAVA_SRC, 'PlaybackService.java'), 'utf8');
  const java = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(!/requestAudioFocus/.test(java), 'PlaybackService 里不应申请音频焦点（交给 Chromium）');
  assert.ok(!/abandonAudioFocus/.test(java), 'PlaybackService 里不应释放音频焦点');
  assert.ok(!/AudioManager/.test(java), 'PlaybackService 里不应依赖 AudioManager');
});

test('MainActivity 不再让 WebView 在后台停摆（onPause 是保活的反面）', () => {
  const raw = fs.readFileSync(path.join(JAVA_SRC, 'MainActivity.java'), 'utf8');
  // 先去掉注释再查：代码里专门写了「这里故意不调 webView.onPause()」的说明，
  // 不剥注释的话这条检查会被自己的注释绊倒
  const java = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(!/webView\.onPause\(\)/.test(java),
    '不能调 webView.onPause()：熄屏/切后台后歌词同步与复读循环会停');
  assert.ok(/PlaybackService\.setBridge/.test(java), 'Activity 应把命令桥交给服务');
  assert.ok(/PlaybackService\.shutdown/.test(java), 'Activity 销毁时应停掉服务');
  assert.ok(/addFlags\(WindowManager\.LayoutParams\.FLAG_KEEP_SCREEN_ON\)/.test(java)
    && /clearFlags\(WindowManager\.LayoutParams\.FLAG_KEEP_SCREEN_ON\)/.test(java),
    '常亮标志应随播放状态开关（暂停就允许息屏）');
  assert.ok(/POST_NOTIFICATIONS/.test(java), 'Android 13+ 要申请通知权限，否则看不到常驻通知');
});

test('前端把播放状态报给 Android，并接收锁屏/通知栏命令', () => {
  const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const java = fs.readFileSync(path.join(JAVA_SRC, 'MainActivity.java'), 'utf8');

  assert.ok(/function reportPlayback\s*\(/.test(js), '缺少状态上报函数');
  assert.ok(/h\.setPlaybackState\(/.test(js), '应调用桥的 setPlaybackState');
  assert.ok(/window\.__onHostCommand\s*=/.test(js), '缺少命令入口 __onHostCommand');
  for (const cmd of ['toggle', 'play', 'pause', 'prevLine', 'nextLine', 'seek']) {
    assert.ok(new RegExp(`case '${cmd}':`).test(js), `命令分发缺少 ${cmd}`);
  }
  // 两端方法名必须一致
  assert.ok(/@JavascriptInterface[\s\S]{0,300}void setPlaybackState\(/.test(java),
    'Java 桥里应有 setPlaybackState');
});

test('复读与 A-B 循环不依赖 requestAnimationFrame', () => {
  const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  // 页面不可见时 rAF 会停；循环控制必须在定时器里（锁屏听听力要用）
  assert.ok(/function tickControl\s*\(/.test(js), '缺少独立的循环控制函数');
  assert.ok(/setInterval\(tickControl/.test(js), '循环控制应挂在定时器上');
  assert.ok(/addEventListener\('timeupdate', tickControl\)/.test(js), '应挂 timeupdate 兜底');

  // rAF 那个 tick 里不应再包含复读逻辑
  const rafTick = /function tick\(\)\s*\{([\s\S]*?)\n\}/.exec(js);
  assert.ok(rafTick, '找不到 tick()');
  assert.ok(!/state\.repeat === 'line'/.test(rafTick[1]), 'tick() 里不该再管复读');
});

// ---------- Java 侧真实读取逻辑 ----------

function findJdk() {
  const cands = [
    process.env.JAVA_HOME,
    'F:\\JAVA',
    'C:\\Program Files\\Java\\jdk-17',
  ].filter(Boolean);
  for (const c of cands) {
    const javac = path.join(c, 'bin', 'javac.exe');
    const java = path.join(c, 'bin', 'java.exe');
    if (fs.existsSync(javac) && fs.existsSync(java)) return { javac, java };
  }
  return null;
}

defer('补充包读取的 Java 实现在电脑上跑通（ZIP 随机访问 + Range）', async () => {
  const jdk = findJdk();
  assert.ok(jdk, '需要 JDK 来验证补充包读取（设置 JAVA_HOME，或把 JDK 放在 F:\\JAVA）');

  const { execFileSync } = require('node:child_process');
  const outDir = path.join(ROOT, 'build', 'test-java');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  execFileSync(jdk.javac, [
    '-encoding', 'UTF-8',
    '-d', outDir,
    path.join(JAVA_SRC, 'Streams.java'),
    path.join(JAVA_SRC, 'HttpRange.java'),
    path.join(JAVA_SRC, 'PackStore.java'),
    path.join(ROOT, 'tools', 'java', 'PackSelfTest.java'),
  ], { stdio: 'pipe' });

  const result = execFileSync(jdk.java, [
    '-Dfile.encoding=UTF-8',
    '-cp', outDir,
    'PackSelfTest',
    PACK_FILE,
    PACK_AUDIO_FILE,
    PACK_ENTRY,
    PACK_TMP,
  ], { stdio: 'pipe', encoding: 'utf8' });

  assert.ok(/JAVA-OK\s+\d+/.test(result), 'Java 自检应输出 JAVA-OK：' + result.trim());
  const n = Number(/JAVA-OK\s+(\d+)/.exec(result)[1]);
  assert.ok(n >= 40, `Java 自检断言数偏少（${n}），可能漏测`);
});

// ============================================================ 2. 字幕转换

console.log('\n[2] 字幕转 LRC');

const lrcTool = require(path.join(ROOT, 'tools', 'lrc-from-srt.js'));

test('SRT 解析', () => {
  const srt = `1
00:00:01,000 --> 00:00:03,500
Hello there.

2
00:00:04,000 --> 00:00:06,000
How are you?
`;
  const cues = lrcTool.parseSrtLike(srt);
  assert.strictEqual(cues.length, 2);
  assert.strictEqual(cues[0].start, 1);
  assert.strictEqual(cues[0].end, 3.5);
  assert.strictEqual(cues[0].text, 'Hello there.');
  assert.strictEqual(cues[1].start, 4);
});

test('VTT 行内时间标签转逐词', () => {
  const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
<00:00:01.000>Good <00:00:01.800>morning <00:00:02.600>all
`;
  const cues = lrcTool.parseSrtLike(vtt);
  assert.strictEqual(cues.length, 1);
  assert.strictEqual(cues[0].text, 'Good morning all');
  assert.strictEqual(cues[0].words.length, 3);
  assert.strictEqual(cues[0].words[2].time, 2.6);
});

test('TED 字幕 JSON（毫秒）解析', () => {
  const json = JSON.stringify({
    captions: [
      { startTime: 960, duration: 4444, content: 'What is the intersection\nbetween things?' },
      { startTime: 6769, duration: 2106, content: 'Curiosity and wonder,' },
    ],
  });
  const cues = lrcTool.parseTedJson(json);
  assert.strictEqual(cues.length, 2);
  assert.strictEqual(cues[0].start, 0.96);
  assert.strictEqual(cues[0].end, 5.404);
  assert.strictEqual(cues[0].text, 'What is the intersection between things?');
  assert.strictEqual(cues[1].start, 6.769);
});

test('TSV 解析（起始/结束/文本）', () => {
  const cues = lrcTool.parseTsv('1.5\t3.0\tFirst line\n4.0\t5.5\tSecond line\n');
  assert.strictEqual(cues.length, 2);
  assert.strictEqual(cues[0].start, 1.5);
  assert.strictEqual(cues[1].text, 'Second line');
});

test('时间戳解析：秒 / mm:ss / hh:mm:ss', () => {
  assert.strictEqual(lrcTool.parseTimestamp('62.5'), 62.5);
  assert.strictEqual(lrcTool.parseTimestamp('01:02.5'), 62.5);
  assert.strictEqual(lrcTool.parseTimestamp('00:01:02.500'), 62.5);
  assert.ok(Number.isNaN(lrcTool.parseTimestamp('abc')));
});

test('紧密相邻字幕合并为一行', () => {
  const cues = [
    { start: 0, end: 1, text: 'Hello' },
    { start: 1.1, end: 2, text: 'world' },
    { start: 10, end: 11, text: 'Far away' },
  ];
  const merged = lrcTool.mergeCues(cues, 0.6, 100);
  assert.strictEqual(merged.length, 2);
  assert.strictEqual(merged[0].text, 'Hello world');
  assert.strictEqual(merged[1].text, 'Far away');
});

test('生成带 offset 的 LRC 文本', () => {
  const lrc = lrcTool.toLrc([{ start: 1, end: 2, text: 'Hi' }], { offset: 2, title: 'T', merge: 0, maxlen: 100 });
  assert.ok(lrc.includes('[ti:T]'));
  assert.ok(lrc.includes('[offset:2000]'));
  assert.ok(lrc.includes('[00:03.00]Hi'));
});

// ============================================================ 3. 中文路径

console.log('\n[3] 中文路径与 URL 编码');

testAsync('课程 id 保留中文（不被预先编码）', async () => {
  const lessons = await buildLibrary(AUDIO_DIR);
  assert.ok(lessons.length > 0, 'audio/ 目录里应当已有示例课程');
  for (const l of lessons) {
    assert.ok(!/%[0-9A-F]{2}/i.test(l.id), `id 不应包含百分号转义：${l.id}`);
    assert.strictEqual(l.manifest.id, l.id);
  }
});

testAsync('audioUrl 是编码过一次的可访问路径', async () => {
  const lessons = await buildLibrary(AUDIO_DIR);
  // 找一个 id 含非 ASCII 的课程（示例语料目录名是中文）
  const withChinese = lessons.find((l) => /[^\x00-\x7F]/.test(l.id));
  assert.ok(withChinese, '应当存在含中文的课程 id 用于验证编码');
  const url = withChinese.manifest.audioUrl;

  // 编码后的 URL 必须全是 ASCII（否则浏览器/HTTP 层会出问题）
  assert.ok(/^[\x00-\x7F]+$/.test(url), `audioUrl 应只含 ASCII：${url}`);
  // 解码一次应当精确还原为 id
  assert.strictEqual(decodeURIComponent(url.replace('/media/', '')), withChinese.id);
  // 不应出现双重编码
  assert.ok(!/%25/i.test(url), 'audioUrl 不应双重编码');
});

testAsync('示例课程的 LRC 拥有逐词时间戳', async () => {
  const lessons = await buildLibrary(AUDIO_DIR);
  const withWords = lessons.find((l) => l.lines.some((x) => x.words && x.words.length > 1));
  assert.ok(withWords, '应当至少有一个课程带逐词时间戳');
  const line = withWords.lines.find((x) => x.words && x.words.length > 1);
  // 逐词时间应当单调不减
  for (let i = 1; i < line.words.length; i++) {
    assert.ok(line.words[i].time >= line.words[i - 1].time, '逐词时间戳应单调不减');
  }
});

testAsync('题目片段时间落在音频时长内，且 start < end', async () => {
  const lessons = await buildLibrary(AUDIO_DIR);
  let checked = 0;
  for (const l of lessons) {
    const dur = l.manifest.duration;
    if (!dur) continue;
    for (const q of l.questions) {
      if (q.start == null) continue;
      assert.ok(q.start >= 0, `${l.id} #${q.number} start 为负`);
      assert.ok(q.start < dur, `${l.id} #${q.number} start ${q.start} 超出时长 ${dur}`);
      if (q.end != null) assert.ok(q.end > q.start, `${l.id} #${q.number} end 应大于 start`);
      checked++;
    }
  }
  assert.ok(checked > 0, '应当检查到题目片段');
});

// ============================================================ 4. HTTP

if (!process.argv.includes('--http')) {
  console.log('\n[4] HTTP 用例已跳过（加 --http 运行）');
} else {
  console.log('\n[4] HTTP 服务');
}

async function httpTests() {
  const { server } = require(path.join(ROOT, 'server.js'));
  const PORT = 4199;
  await new Promise((res) => server.listen(PORT, '127.0.0.1', res));
  const base = `http://127.0.0.1:${PORT}`;

  await testAsync('/api/lessons 返回课程列表', async () => {
    const r = await fetch(`${base}/api/lessons`);
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.ok(j.count > 0);
    assert.ok(Array.isArray(j.lessons));
  });

  await testAsync('/api/lesson/<编码后的中文 id> 可查到课程', async () => {
    const list = await (await fetch(`${base}/api/lessons`)).json();
    const id = list.lessons[0].id;
    const r = await fetch(`${base}/api/lesson/${encodeURIComponent(id)}`);
    assert.strictEqual(r.status, 200, `status=${r.status}`);
    const j = await r.json();
    assert.strictEqual(j.manifest.id, id);
    assert.ok(Array.isArray(j.lines));
  });

  await testAsync('音频支持 Range 请求（返回 206）', async () => {
    const list = await (await fetch(`${base}/api/lessons`)).json();
    const url = base + list.lessons[0].audioUrl;
    const r = await fetch(url, { headers: { Range: 'bytes=100-199' } });
    assert.strictEqual(r.status, 206);
    assert.strictEqual(r.headers.get('content-length'), '100');
    assert.ok(/^bytes 100-199\//.test(r.headers.get('content-range')));
    const buf = await r.arrayBuffer();
    assert.strictEqual(buf.byteLength, 100);
  });

  await testAsync('无 Range 请求返回完整 200', async () => {
    const list = await (await fetch(`${base}/api/lessons`)).json();
    const r = await fetch(base + list.lessons[0].audioUrl);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('accept-ranges'), 'bytes');
    await r.body.cancel();
  });

  await testAsync('拒绝路径穿越', async () => {
    const r = await fetch(`${base}/media/${encodeURIComponent('../../server.js')}`);
    assert.ok(r.status === 403 || r.status === 404, `status=${r.status}`);
  });

  await testAsync('不存在的课程返回 404', async () => {
    const r = await fetch(`${base}/api/lesson/${encodeURIComponent('nope/none.wav')}`);
    assert.strictEqual(r.status, 404);
  });

  await testAsync('静态前端可访问', async () => {
    for (const p of ['/', '/app.js', '/style.css']) {
      const r = await fetch(base + p);
      assert.strictEqual(r.status, 200, `${p} -> ${r.status}`);
      await r.text();
    }
  });

  await new Promise((res) => server.close(res));
}

(async () => {
  // 需要调外部程序（Python 语法检查已在前面的同步段跑，这里主要是 JDK 那几条）
  if (deferred.length) {
    console.log('\n[1.95] 需要外部程序（JDK）的用例');
    for (const d of deferred) await testAsync(d.name, d.fn);
  }

  if (process.argv.includes('--http')) await httpTests();

  console.log(`\n${'─'.repeat(52)}`);
  console.log(`  通过 ${passed} 项，失败 ${failed} 项`);
  if (failed) {
    console.log('\n失败详情：');
    for (const f of failures) console.log(`  · ${f.name}\n    ${f.err.stack.split('\n').slice(0, 3).join('\n    ')}`);
  }
  console.log('');
  process.exit(failed ? 1 : 0);
})();

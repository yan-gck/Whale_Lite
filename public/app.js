/* ============================================================
   Whale Lite · 前端逻辑
   - 歌词按时间戳滚动（二分查找当前行，逐词高亮可选）
   - 点击任意行跳转播放；点击题目时间戳可回放对应片段
   - 支持倍速、单句复读、A-B 区间循环、听写模式
   ============================================================ */

'use strict';

/** 版本号：反馈问题时一并带出去，方便对上「你装的是哪一版」 */
const APP_VERSION = '1.3';

/** 反馈渠道：仓库的 Issues 页（用户提问题、贴复制的环境信息都在那儿） */
const FEEDBACK_URL = 'https://github.com/yan-gck/Whale_Lite/issues';

const $ = (id) => document.getElementById(id);

const audio = $('audio');
const els = {
  app: document.querySelector('.app'),
  lessonList: $('lessonList'),
  search: $('search'),
  examChips: $('examChips'),
  rootPath: $('rootPath'),
  title: $('lessonTitle'),
  meta: $('lessonMeta'),
  lyrics: $('lyrics'),
  lyricsWrap: $('lyricsWrap'),
  follow: $('btnFollow'),
  jumpNow: $('btnJumpNow'),
  play: $('btnPlay'),
  timeNow: $('timeNow'),
  timeTotal: $('timeTotal'),
  progress: $('progress'),
  played: $('progressPlayed'),
  buffer: $('progressBuffer'),
  thumb: $('progressThumb'),
  ab: $('progressAB'),
  speed: $('speed'),
  repeatMode: $('repeatMode'),
  displayMode: $('displayMode'),
  abReadout: $('abReadout'),
  qBody: $('qBody'),
  qCounter: $('qCounter'),
  qpanel: $('qpanel'),
  sectionNav: $('sectionNav'),
  rawDrawer: $('rawDrawer'),
  rawText: $('rawText'),
  rawTitle: $('rawTitle'),
  paperDrawer: $('paperDrawer'),
  paperText: $('paperText'),
  paperTitle: $('paperTitle'),
  btnPaper: $('btnPaper'),
  btnClosePaper: $('btnClosePaper'),
  btnCopyPaper: $('btnCopyPaper'),
  btnDownloadPaper: $('btnDownloadPaper'),
  toast: $('toast'),

  // 做题流程
  examBar: $('examBar'),
  stepAnswer: $('stepAnswer'),
  stepReview: $('stepReview'),
  examProgress: $('examProgress'),
  examVeil: $('examVeil'),
  btnSubmit: $('btnSubmit'),
  btnReset: $('btnReset'),
  btnDownloadRaw: $('btnDownloadRaw'),

  // 修订模式
  btnEdit: $('btnEdit'),
  editBar: $('editBar'),
  editCount: $('editCount'),
  btnSaveEdit: $('btnSaveEdit'),
  btnRevertEdit: $('btnRevertEdit'),
  btnExitEdit: $('btnExitEdit'),

  // 导入
  importDrawer: $('importDrawer'),
  btnImport: $('btnImport'),
  btnCloseImport: $('btnCloseImport'),
  btnDoImport: $('btnDoImport'),
  fileAudio: $('fileAudio'),
  fileTranscript: $('fileTranscript'),
  fileExplain: $('fileExplain'),
  fileQuestions: $('fileQuestions'),
  importTitle: $('importTitle'),
  importExam: $('importExam'),
  importStatus: $('importStatus'),
  importResult: $('importResult'),

  // 补充包
  packDrawer: $('packDrawer'),
  btnPacks: $('btnPacks'),
  btnClosePacks: $('btnClosePacks'),
  btnImportPack: $('btnImportPack'),
  btnRescanPacks: $('btnRescanPacks'),
  btnCopyPackDir: $('btnCopyPackDir'),
  packDir: $('packDir'),
  packHint: $('packHint'),
  packList: $('packList'),
  packCatalog: $('packCatalog'),
  packStatus: $('packStatus'),
  packProgress: $('packProgress'),
  packProgressBar: $('packProgressBar'),

  // 移动端
  btnMobileSidebar: $('btnMobileSidebar'),
  btnMobileQpanel: $('btnMobileQpanel'),
  btnCloseQpanel: $('btnCloseQpanel'),
  sheetBackdrop: $('sheetBackdrop'),

  // 模式切换 / 侧栏展开 / 更多菜单
  modeSwitch: $('modeSwitch'),
  btnExpandSidebar: $('btnExpandSidebar'),
  seekBubble: $('seekBubble'),
  moreMenu: $('moreMenu'),
  btnMore: $('btnMore'),
  morePop: $('morePop'),

  // 问题反馈
  btnFeedback: $('btnFeedback'),
  feedbackSection: $('feedbackSection'),
  btnCopyFeedback: $('btnCopyFeedback'),
  feedbackUrl: $('feedbackUrl'),

  // 外观 / 学习设置
  settingsDrawer: $('settingsDrawer'),
  btnSettings: $('btnSettings'),
  btnCloseSettings: $('btnCloseSettings'),
  btnResetSettings: $('btnResetSettings'),
  bgLayer: $('bgLayer'),
  bgPresets: $('bgPresets'),
  fileBg: $('fileBg'),
  bgDim: $('bgDim'),
  bgDimVal: $('bgDimVal'),
  bgBlur: $('bgBlur'),
  bgBlurVal: $('bgBlurVal'),
  panelAlpha: $('panelAlpha'),
  panelAlphaVal: $('panelAlphaVal'),
  accentChips: $('accentChips'),
  lyricSize: $('lyricSize'),
  lyricSizeVal: $('lyricSizeVal'),
  optAutoResume: $('optAutoResume'),
  optSaveProgress: $('optSaveProgress'),
  btnExportProgress: $('btnExportProgress'),
  btnClearProgress: $('btnClearProgress'),
  progressSummary: $('progressSummary'),

  // 睡眠定时 / 续听
  sleepTimer: $('sleepTimer'),
  sleepLeft: $('sleepLeft'),
  resumeBar: $('resumeBar'),
};

const state = {
  lessons: [],
  exam: 'all',
  query: '',
  lesson: null,
  // 题目面板的**唯一**状态源（true = 展开）。窄屏是右侧抽屉、宽屏是第三栏，
  // 两种布局共用它，不再各自维护一个 class（那正是「收起后打不开」的根因）。
  qpanelOpen: true,
  wasNarrow: null,      // 上一次布局是不是窄屏，用来判断「跨过断点/转屏了」
  lines: [],
  lineEls: [],
  activeIndex: -1,
  follow: true,
  blur: false,
  repeat: 'off',
  ab: { a: null, b: null },
  userScrolling: false,
  scrollTimer: null,
  picked: new Map(),

  // 做题流程
  phase: 'answering',        // answering | reviewing
  userAnswers: new Map(),    // 题号 → 用户作答
  gradeResult: null,         // { right, total, wrong: [] }
  confirmSubmit: false,      // 未答完时需二次确认

  // 修订模式
  editing: false,
  editDirty: 0,

  // 补充包（Android）
  packs: [],          // 已安装的 .lppack
  packCatalog: [],    // 打包时随 APK 带上的「可安装清单」
  packBusy: false,
};

// ------------------------------------------------------------ 小工具

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

let toastTimer = null;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 1700);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const EXAM_LABEL = { cet4: '四级', cet6: '六级', ielts: '雅思', toefl: '托福', other: '其他' };

// ------------------------------------------------------------ 数据源
//
// 播放器有两种运行方式：
//   · 桌面：由 server.js 提供 /api/lessons、/api/lesson/<id>、/media/<path>
//   · 离线（Android APK / 静态托管）：没有 Node 服务，
//     全部课程数据放在同目录的 bundle.json 里，音频走相对路径
//
// 下面这层抽象把两种方式的差异收在一处，其余代码不用关心。

const DATA_SOURCE = {
  mode: 'http',      // 'http' | 'bundle'
  bundle: null,      // bundle 模式下的整包数据
  baseUrl: '',       // bundle 模式下音频的基地址（android_asset 里用绝对 file:// 更稳）
  allLessons: [],    // bundle 模式：APK 内课程 + 补充包课程（已合并去重）
  packLessons: [],   // 补充包带来的课程
  packInfo: null,    // 已安装补充包列表（Android 侧提供）
  packCache: new Map(),   // 包名 → { key, lessons }，避免每次重传几 MB 课程数据
};

/** 探测运行模式：先试 API，失败则退回 bundle.json */
async function detectDataSource() {
  try {
    const res = await fetch('/api/lessons', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      DATA_SOURCE.mode = 'http';
      return { ok: true, lessons: data.lessons || [], root: data.root || '' };
    }
  } catch { /* 没有服务，继续尝试离线包 */ }

  // 离线模式
  try {
    const bundle = await fetchLocalJson('bundle.json');
    if (!bundle) throw new Error('读不到 bundle.json');
    DATA_SOURCE.mode = 'bundle';
    DATA_SOURCE.bundle = bundle;

    // 在 file:// 或 android_asset 下，用当前页面地址拼绝对路径最稳
    DATA_SOURCE.baseUrl = new URL('.', location.href).href;

    // 补充包（Android）：包里装的是 APK 装不下的素材（雅思/六级全量），
    // 读出来并进课程列表。桌面上这一步自然返回空，不影响任何行为。
    const packLessons = await loadPacks();                       // 完整课程对象（含 lines/questions）
    const apkLessons = (bundle.lessons || []).map((l) => ({ ...l, packId: '' }));

    // 课程列表要的是 manifest；补充包课程排在前面（它带译文与全部题目，
    // 而 APK 里的 bundle.json 体积紧张时可能省略了原文 transcriptDropped）
    const packManifests = packLessons.map((l) => ({ ...l.manifest, packId: l.packId }));
    const packIds = new Set(packManifests.map((m) => m.id));
    const apkOnly = apkLessons.filter((l) => !packIds.has(l.manifest.id));

    DATA_SOURCE.allLessons = packLessons.concat(apkOnly);

    return {
      ok: true,
      lessons: packManifests.concat(apkOnly.map((l) => ({ ...l.manifest, packId: '' }))),
      root: '离线包（bundle.json）'
        + (packLessons.length ? ` ＋ 补充包 ${state.packs.filter((p) => p.ok).length} 个 / ${packLessons.length} 门课` : ''),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** 把课程里的相对路径转成当前数据源可用的 URL */
function assetUrl(relPath, packId) {
  const enc = (p) => String(p).split('/').map(encodeURIComponent).join('/');
  if (DATA_SOURCE.mode === 'bundle') {
    // 补充包走自建 URL 空间：.../android_asset/www/pack/<包名>/audio/<课程 id>
    // 由 MainActivity.shouldInterceptRequest 从 .lppack 里直接取（含 206 Range）。
    if (packId) {
      return DATA_SOURCE.baseUrl + 'pack/' + encodeURIComponent(packId) + '/audio/' + enc(relPath);
    }
    // ⚠️ 别漏掉 audio/ 这一段：build-apk.js 把素材放在 assets/www/audio/ 下
    //    （build/apk/assets/www/audio/CET4-演示/xxx.wav），
    //    而课程 id 是相对 audio/ 的（CET4-演示/xxx.wav）。
    //    这里以前少了前缀，导致 APK 里装进去的演示课音频根本取不到
    //    （列表能显示、一播就报「音频加载失败」）。
    return DATA_SOURCE.baseUrl + 'audio/' + enc(relPath);
  }
  return '/media/' + enc(relPath);
}

// ------------------------------------------------------------ 补充包（Android）
//
// 单个 APK 有 2 GiB 硬上限（ZIP 中央目录 32 位），本机素材约 3.0 GB 装不进去，
// 所以拆成「安装包（35 MB：前端 + 演示语料）+ 补充包（.lppack：雅思/六级全量）」。
//
// 补充包放在 App 私有外部目录 /sdcard/Android/data/com.dsh.listeningplayer/files/packs/，
// 数据线可以直接往里拷（不需要任何权限），也可以在 App 里点「导入 .lppack」。
// Android 侧通过 JS 桥 AndroidHost 提供三件事：
//   · packs()                      已安装包列表（JSON 字符串）
//   · packTextLength/packTextChunk 包内课程数据分片读取（library.json 有几 MB，
//                                  分片取比一次传大字符串稳妥）
//   · importPack()/deletePack()    导入与删除，导入进度用 __onPackEvent 回调
// 音频播放走自建 URL 空间（见上面的 assetUrl），Java 侧从 ZIP 里按 Range 取字节。

const PACK_CHUNK = 512 * 1024;      // 每次从 Java 侧取 512K 个字符

function host() {
  return (typeof window.AndroidHost !== 'undefined' && window.AndroidHost) ? window.AndroidHost : null;
}

/**
 * 读一份「随 App 打包的 JSON」（bundle.json / packs-catalog.json）。
 *
 * ⚠️ 优先走 JS 桥，其次才 fetch：
 *    APK 里的页面地址是 `file:///android_asset/www/index.html`，
 *    在这种页面里对 file:// 发 fetch 会被 WebView 直接拦掉
 *    （"Fetch API cannot load file:///... URL scheme file is not supported"），
 *    结果是「课程列表永远空白」—— 桌面上（http://）完全复现不出来，
 *    只有装到手机上才看得见。bundle.json 因此改成从 assets 直接读。
 */
async function fetchLocalJson(relPath) {
  const h = host();
  if (h && typeof h.assetTextLength === 'function') {
    let total;
    try {
      total = h.assetTextLength(relPath);
    } catch (err) {
      total = -1;
    }
    if (total >= 0) {
      let out = '';
      for (let from = 0; from < total; from += PACK_CHUNK) {
        let chunk;
        try {
          chunk = h.assetTextChunk(relPath, from, PACK_CHUNK);
        } catch (err) {
          return null;
        }
        if (chunk == null) return null;
        if (!chunk.length) break;
        out += chunk;
        await new Promise((r) => setTimeout(r, 0));
      }
      try {
        return JSON.parse(out);
      } catch (err) {
        console.warn('[bundle] JSON 解析失败：' + err.message);
        return null;
      }
    }
  }

  try {
    const res = await fetch(relPath, { cache: 'no-store' });
    if (res.ok) return await res.json();
  } catch { /* 桌面上没有这个文件，或 file:// 被拦，都走这里 */ }
  return null;
}

/** 取已安装补充包信息：优先 JS 桥，没有桥时退回 packs.json（静态托管时可用） */
async function fetchPackInfo() {
  const h = host();
  if (h && typeof h.packs === 'function') {
    try {
      const json = h.packs();
      if (json) return JSON.parse(json);
    } catch (err) {
      console.warn('[pack] AndroidHost.packs() 失败：', err);
    }
  }
  try {
    const res = await fetch('packs.json', { cache: 'no-store' });
    if (res.ok) return await res.json();
  } catch { /* 桌面上没有这个文件，正常 */ }
  return null;
}
/**
 * 从补充包里读一个文本文件。
 *
 * 两个要点：
 *   ① 按【字符】分片：UTF-8 多字节序列不会被切断，中文内容安全。
 *   ② 每片之间让出主线程：JS 桥调用是同步的，雅思包的 library.json 有 6 MB，
 *      一口气读完会让界面卡住一两秒。
 */
async function readPackText(packId, relPath) {
  const h = host();
  if (!h || typeof h.packTextLength !== 'function') return null;
  let total;
  try {
    total = h.packTextLength(packId, relPath);
  } catch (err) {
    return null;
  }
  if (total == null || total < 0) return null;

  let out = '';
  for (let from = 0; from < total; from += PACK_CHUNK) {
    let chunk;
    try {
      chunk = h.packTextChunk(packId, relPath, from, PACK_CHUNK);
    } catch (err) {
      return null;
    }
    if (chunk == null) return null;
    if (!chunk.length) break;
    out += chunk;
    await new Promise((r) => setTimeout(r, 0));
  }
  return out;
}

/**
 * 读取所有已安装包的课程数据（library.json），返回带 packId 的课程数组。
 *
 * 读过的包会按「体积 + 是否有课程数据」缓存：打开面板、点「重新扫描素材」
 * 都会走到这里，没缓存的话每次都要重传几 MB。
 */
async function loadPacks(force) {
  const info = await fetchPackInfo();
  DATA_SOURCE.packInfo = info;
  state.packs = (info && info.packs) || [];
  DATA_SOURCE.packLessons = [];

  if (!host()) return [];

  const cache = DATA_SOURCE.packCache || (DATA_SOURCE.packCache = new Map());
  const alive = new Set();
  const merged = [];

  for (const p of state.packs) {
    if (!p.ok) continue;
    alive.add(p.id);

    const key = `${p.sizeBytes}|${p.hasLibrary}`;
    const hit = cache.get(p.id);
    if (!force && hit && hit.key === key) {
      p.loadedLessons = hit.lessons.length;
      p.loadError = '';
      merged.push(...hit.lessons);
      continue;
    }

    if (!p.hasLibrary) { p.loadError = '包内没有课程数据（旧版补充包）'; continue; }
    const text = await readPackText(p.id, 'library.json');
    if (!text) { p.loadError = '课程数据读取失败'; continue; }
    let lib;
    try {
      lib = JSON.parse(text);
    } catch (err) {
      p.loadError = '课程数据解析失败：' + err.message;
      continue;
    }

    const lessons = [];
    for (const l of (lib.lessons || [])) {
      if (!l || !l.manifest) continue;
      lessons.push({ ...l, packId: p.id, packSet: lib.set || p.set || '' });
    }
    p.loadedLessons = lessons.length;
    p.loadError = '';
    cache.set(p.id, { key, lessons });
    merged.push(...lessons);
  }

  // 已经移除的包不要继续占内存
  for (const id of [...cache.keys()]) if (!alive.has(id)) cache.delete(id);

  DATA_SOURCE.packLessons = merged;
  return merged;
}

/**
 * 已安装包列表变化后刷新界面。
 *
 * 注意：不主动重新加载当前课程 —— 补一个包不该把正在做的题清空。
 * 只有当当前课程随补充包一起消失时才切走。
 */
async function refreshPacks(reloadLibraryToo, force) {
  await loadPacks(force);
  if (!reloadLibraryToo) { renderPackPanel(); return; }

  const currentId = state.lesson?.manifest?.id;
  await loadLibrary(true);
  renderPackPanel();

  if (currentId && !state.lessons.some((l) => l.id === currentId)) {
    toast('当前课程的补充包已被移除，已切换到其它课程');
    if (state.lessons[0]) selectLesson(state.lessons[0].id);
  }
}

// ------------------------------------------------------------ 课程库

async function loadLibrary(keepSelection = true) {
  const data = await detectDataSource();

  if (!data.ok) {
    els.lessonList.innerHTML =
      '<div class="empty-hint">没能加载课程数据。<br><br>'
      + '桌面版请确认 <code>server.js</code> 正在运行；'
      + '离线版请确认 <code>bundle.json</code> 与页面在同一目录。</div>';
    return;
  }

  state.lessons = data.lessons || [];
  els.rootPath.textContent = data.root || '';

  if (!state.lessons.length) {
    els.lessonList.innerHTML =
      '<div class="empty-hint">audio/ 目录里还没有素材。<br><br>运行 <code>node tools/make-demo.js</code> 生成示例，或把音频文件（可带同名 .lrc / .questions.json / .meta.json）放进去。</div>';
    return;
  }

  renderLessonList();

  // 支持用 URL 参数直接定位课程，便于分享/自测：?lesson=CET6-真题/xxx.mp3
  const wanted = new URLSearchParams(location.search).get('lesson');
  if (wanted && state.lessons.some((l) => l.id === wanted)) {
    selectLesson(wanted);
    return;
  }

  // 自动续听：回到上次那门课，并接着上次的位置（可以在设置里关掉）
  const last = (() => { try { return localStorage.getItem('listening-player.lastLesson'); } catch { return null; } })();
  const restoreId = state.lessons.some((l) => l.id === last) ? last : null;

  if (!keepSelection || !state.lesson) {
    const first = restoreId ? state.lessons.find((l) => l.id === restoreId) : state.lessons[0];
    if (first) {
      await selectLesson(first.id);
      if (settings.autoResume && restoreId) {
        // 音频元数据可能还没到，稍等一下再跳，否则 duration 未知会判成「已听完」
        setTimeout(() => {
          if (applyResume(true)) toast('已接着上次的位置继续听');
        }, 600);
      }
    }
  }
}

function visibleLessons() {
  const q = state.query.trim().toLowerCase();
  return state.lessons.filter((l) => {
    if (state.exam !== 'all' && l.exam !== state.exam) return false;
    if (!q) return true;
    return [l.title, l.source, l.year, l.paper, l.section, l.folder]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(q));
  });
}

function renderLessonList() {
  const list = visibleLessons();
  if (!list.length) {
    els.lessonList.innerHTML = '<div class="empty-hint">没有匹配的课程。</div>';
    return;
  }

  els.lessonList.innerHTML = list.map((l) => {
    // 学习进度：正确率（≥60 绿 / <60 红）+ 上次听到哪儿
    const pr = settings.saveProgress ? progressOf(l.id) : null;
    const accHtml = (pr && pr.total)
      ? `<span class="li-acc ${(pr.pct || 0) >= PASS_RATE ? 'good' : 'bad'}">正确率 ${pr.pct || 0}%</span>`
      : '';
    const posHtml = (pr && pr.pos > 15) ? `<span class="li-pos">上次 ${fmtTime(pr.pos)}</span>` : '';
    const progHtml = (accHtml || posHtml) ? `<div class="li-progress">${accHtml}${posHtml}</div>` : '';

    return `
    <div class="lesson-item ${state.lesson && state.lesson.manifest.id === l.id ? 'active' : ''}" data-id="${escapeHtml(l.id)}">
      <div class="li-title">${escapeHtml(l.title)}</div>
      <div class="li-sub">
        <span class="badge ${escapeHtml(l.exam)}">${EXAM_LABEL[l.exam] || '其他'}</span>
        ${l.questionCount ? `<span class="badge dim">${l.questionCount} 题</span>` : ''}
        ${l.hasLrc ? `<span class="badge dim">${l.lineCount} 句</span>` : '<span class="badge dim">无时间轴</span>'}
        ${l.packId ? `<span class="badge pack" title="来自补充包：${escapeHtml(l.packId)}">📦 补充包</span>` : ''}
        ${l.folder ? `<span>${escapeHtml(l.folder)}</span>` : ''}
      </div>
      ${progHtml}
    </div>`;
  }).join('');

  els.lessonList.querySelectorAll('.lesson-item').forEach((el) => {
    el.addEventListener('click', () => selectLesson(el.dataset.id));
  });
}

// ------------------------------------------------------------ 加载课程

async function selectLesson(id) {
  let data;

  if (DATA_SOURCE.mode === 'bundle') {
    // 离线模式：直接从内存里的整包取，不再发请求
    // （补充包课程与 APK 内课程都在这份合并列表里）
    const hit = DATA_SOURCE.allLessons.find((l) => l.manifest.id === id);
    if (!hit) { toast('离线包里找不到该课程：' + id); return; }
    // bundle 里的 audioUrl 是 /media/<相对路径>，这里改写成当前数据源可用的地址；
    // 补充包课程会指向 pack/<包名>/audio/<相对路径>，由 Android 侧从 ZIP 里取。
    data = {
      ...hit,
      manifest: { ...hit.manifest, audioUrl: assetUrl(hit.manifest.id, hit.packId) },
    };
  } else {
    try {
      const res = await fetch('/api/lesson/' + encodeURIComponent(id));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      data = await res.json();
    } catch (err) {
      toast('课程加载失败：' + err.message);
      return;
    }
  }

  state.lesson = data;
  state.lines = data.lines || [];
  state.activeIndex = -1;
  state.picked.clear();
  clearAB();

  audio.src = data.manifest.audioUrl;
  audio.load();

  // 标题与元信息
  els.title.textContent = data.manifest.title || '未命名';
  const bits = [];
  bits.push(`<span class="badge ${escapeHtml(data.manifest.exam)}">${EXAM_LABEL[data.manifest.exam] || '其他'}</span>`);
  if (data.manifest.paper) bits.push(`<span>${escapeHtml(data.manifest.paper)}</span>`);
  if (data.manifest.year) bits.push(`<span>${escapeHtml(String(data.manifest.year))}</span>`);
  if (data.manifest.section) bits.push(`<span>${escapeHtml(data.manifest.section)}</span>`);
  if (data.manifest.source) bits.push(`<span>${escapeHtml(data.manifest.source)}</span>`);
  if (data.manifest.license) bits.push(`<span class="badge dim">${escapeHtml(data.manifest.license)}</span>`);

  // 语音转写来源标识 —— 必须显眼，否则用户会把机器听写当成官方原文
  const ts = data.manifest.transcriptSource;
  if (ts && ts.kind === 'whisper') {
    const tip = `由 OpenAI Whisper（faster-whisper 实现）自动语音识别生成`
      + (ts.model ? `，模型 ${ts.model}` : '')
      + (ts.generatedAt ? `，生成于 ${ts.generatedAt}` : '')
      + `。机器转写可能有错字，请勿当作官方原文。`;
    bits.push(`<span class="badge whisper" title="${escapeHtml(tip)}">🎙 Whisper 转写</span>`);
  } else if (ts && ts.kind === 'official') {
    bits.push('<span class="badge official" title="来源提供的官方原文">📄 官方原文</span>');
  } else if (ts && ts.kind === 'estimated') {
    bits.push('<span class="badge dim" title="按行长度加权估算的时间轴，非声学对齐">≈ 估算时间轴</span>');
  }

  if (data.manifest.sourceUrl) {
    bits.push(`<a href="${escapeHtml(data.manifest.sourceUrl)}" target="_blank" rel="noopener" style="color:var(--blue)">来源页</a>`);
  }

  // 译文标识：机翻必须明确声明（用户要求），人工上传的译文不标
  if (data.manifest.hasTranslation && data.manifest.translationIsMachine) {
    bits.push('<span class="badge machine" title="中文译文由 Opus-MT 离线模型自动翻译，仅供理解参考，请以英文原文为准">🌐 机器翻译</span>');
  } else if (data.manifest.hasTranslation) {
    bits.push('<span class="badge official" title="译文由用户提供">中英对照</span>');
  }

  // 手工修订过的标识：让用户知道这里的内容不是机器原始输出
  const editedKinds = [];
  if (data.manifest.editedTranscript) editedKinds.push('原文');
  if (data.manifest.editedQuestions) editedKinds.push('题目');
  if (editedKinds.length) {
    bits.push(`<span class="badge edited" title="本课程的${editedKinds.join('与')}经过手工修订，已覆盖机器生成的内容">✏ 已修订${editedKinds.join('·')}</span>`);
  }

  els.meta.innerHTML = bits.join('');

  els.rawTitle.textContent = (data.manifest.title || '') + ' · 完整原文';
  els.rawText.textContent = buildRawText(data);

  // 原题抽屉
  const hasPaper = !!data.paper;
  if (els.btnPaper) {
    els.btnPaper.disabled = !hasPaper;
    els.btnPaper.title = hasPaper
      ? '查看听力原题（表格式填空题需要看版式）'
      : '该课程没有原题数据';
  }
  if (els.paperTitle) els.paperTitle.textContent = (data.manifest.title || '') + ' · 听力原题';
  if (els.paperText) {
    els.paperText.textContent = hasPaper ? data.paper
      : '该课程暂无原题数据。\n\n原题可从配套的原题 PDF 抽取（见 tools/parse-paper.js），\n或在「导入」里上传原题文件。';
  }

  // 渲染歌词与题目，然后进入新一轮做题（清空上次作答、回到做题阶段）
  // 切课程时先退出修订模式：编辑框还挂在旧 DOM 上，留着会误改新课程
  if (state.editing) setEditMode(false);
  state.editDirty = 0;
  renderLyrics();
  applyDisplayMode();
  renderQuestions();
  renderSectionNav();
  startExam();
  // 记住「最后一门课」并更新进度记录（下次打开能接着听）
  try {
    localStorage.setItem('listening-player.lastLesson', id);
  } catch { /* 存不下无妨 */ }
  recordOpen(id);
  renderLessonList();
  updateResumeBar();
  // 换课了：把新标题同步给常驻通知/锁屏控制条
  reportPlayback(true);
}

// ------------------------------------------------------------ 渲染歌词

/**
 * 组装「原文」抽屉的内容。
 * 机器转写的课程会在最前面加一段醒目声明 —— 避免用户把 ASR 结果当官方原文。
 * 若存在译文（.translation.lrc），按时间轴做英中对照。
 */
function buildRawText(data) {
  const out = [];
  const ts = data.manifest.transcriptSource;

  if (ts && ts.kind === 'whisper') {
    out.push('⚠️ 以下文本由 OpenAI Whisper 自动语音识别生成，非官方原文。');
    out.push(`   模型：${ts.model || '未知'}　生成时间：${ts.generatedAt || '未知'}`);
    out.push('   机器转写可能存在错字、漏词或专有名词错误，请以音频与官方材料为准。');
    out.push('');
    out.push('─'.repeat(56));
    out.push('');
  }

  if (ts && ts.kind === 'estimated') {
    out.push('≈ 时间轴为按行长度估算，仅保证大致对得上，非声学对齐。');
    out.push('');
    out.push('─'.repeat(56));
    out.push('');
  }

  // 有译文且有时间轴时，做英中对照
  const tr = data.translationLines || [];
  if (tr.length && data.lines && data.lines.length) {
    if (data.manifest.translationIsMachine) {
      out.push('🌐 中文译文由 Opus-MT 离线模型自动翻译，未经过人工校对。');
      out.push('   机翻可能存在语义偏差或术语错误，请以英文原文为准。');
      out.push('');
      out.push('─'.repeat(56));
      out.push('');
    }
    const byTime = new Map(tr.map((l) => [Math.round(l.time * 100) / 100, l.text]));
    for (const line of data.lines) {
      out.push(line.text);
      const zh = byTime.get(Math.round(line.time * 100) / 100);
      if (zh) out.push('    ' + zh);
    }
    return out.join('\n');
  }

  out.push(data.transcript || '（该课程没有 .txt 全文文件）');
  return out.join('\n');
}

function renderLyrics() {
  if (!state.lines.length) {
    els.lyrics.innerHTML =
      '<div class="empty-hint big"><p>该课程没有时间轴（.lrc）文件。</p>' +
      '<p class="sub">播放器仍可正常播放音频，并可点右上角「原文」阅读全文。<br>' +
      '想要滚动歌词，请为音频配一个同名 <code>.lrc</code> 文件（可用 <code>node tools/lrc-from-srt.js</code> 从 SRT/VTT/TED 字幕转换）。</p></div>';
    state.lineEls = [];
    return;
  }

  // 译文按时间戳建索引。译文与英文原文时间戳一致，
  // 但为稳妥起见取「最近的」一行（容差 0.6 秒），避免浮点差异导致对不上。
  const trLines = state.lesson?.translationLines || [];
  const zhByTime = new Map();
  trLines.forEach((l) => zhByTime.set(Math.round(l.time * 100), l.text));
  const findZh = (t) => {
    if (!trLines.length) return null;
    const key = Math.round(t * 100);
    if (zhByTime.has(key)) return zhByTime.get(key);
    // 找最近邻（译文文件可能只翻了部分行）
    let best = null, bestD = 0.61;
    for (const l of trLines) {
      const d = Math.abs(l.time - t);
      if (d < bestD) { bestD = d; best = l.text; }
    }
    return best;
  };

  els.lyrics.innerHTML = state.lines.map((line, i) => {
    const ts = fmtTime(line.time);
    let body;
    if (line.words && line.words.length) {
      // 空格必须放进 span 内部：
      //   1) 拼 HTML 时空格会被折叠掉，不处理的话原文会连成一片
      //   2) 放进 span 里，该词高亮时连同它后面的空格一起高亮，断句位置才对
      body = line.words
        .map((w, wi) => {
          const space = wi < line.words.length - 1 ? ' ' : '';
          return `<span class="w" data-t="${w.time}">${escapeHtml(w.text)}${space}</span>`;
        })
        .join('');
    } else {
      body = `<span class="w" data-t="${line.time}">${escapeHtml(line.text)}</span>`;
    }
    const zh = findZh(line.time);
    const zhHtml = zh ? `<div class="zh">${escapeHtml(zh)}</div>` : '';
    return `<div class="line" data-i="${i}" data-t="${line.time}">
      <div class="ts">${ts}</div>
      <div class="txt">${body}${zhHtml}</div>
    </div>`;
  }).join('');

  state.lineEls = [...els.lyrics.querySelectorAll('.line')];

  state.lineEls.forEach((el) => {
    el.addEventListener('click', () => {
      // 修订模式下点击是为了选字改内容，不能触发跳转播放
      if (state.editing) return;
      const t = Number(el.dataset.t);
      const wasPlaying = !audio.paused;
      audio.currentTime = t + 0.001;
      if (!wasPlaying) audio.play().catch(() => {});
      setActive(Number(el.dataset.i), true);
    });
  });

  els.lyrics.scrollTop = 0;

  // 用户手动滚动时暂停自动跟随
  els.lyrics.addEventListener('scroll', () => {
    if (!state.follow) return;
    if (window.__PROBE__) return;   // 自动化自检：程序化写入 scrollTop 不算用户滚动
    state.userScrolling = true;
    clearTimeout(state.scrollTimer);
    state.scrollTimer = setTimeout(() => { state.userScrolling = false; }, 900);
  }, { passive: true });
}

// ------------------------------------------------------------ 做题流程
//
// 两个阶段：
//   answering  做题 —— 只显示题目与播放器，【不显示原文】（避免直接看答案）
//   reviewing  复盘 —— 显示原文、批改结果、解析，且答案可点击跳转到原文并播放
//
// 用户作答存在 state.userAnswers（key 是题号），提交后逐题批改。
//
// 另外有两种「模式」（右上角切换，记在设置里）：
//   实战   —— 上面那套：先作答，提交后才给原文与答案
//   练耳朵 —— 不做题：不给作答区、不显示提交按钮，原文直接按时间戳滚动，
//             题目面板默认收起（想看题目时点「题目」还能翻出来，答案直接给）

const MODE_EXAM = 'exam';
const MODE_LISTEN = 'listen';

function isListenMode() {
  return settings.mode === MODE_LISTEN;
}

/** 切换实战 / 练耳朵 */
function applyMode() {
  const listen = isListenMode();
  els.app.classList.toggle('mode-listen', listen);
  if (els.modeSwitch) {
    els.modeSwitch.querySelectorAll('[data-mode]').forEach((b) => {
      b.classList.toggle('on', b.dataset.mode === settings.mode);
    });
  }
  // 练耳朵：题目面板默认收起，把屏幕让给原文（点「题目」还能翻出来对照）
  if (listen) setQPanel(false);
  startExam();
}

/** 一轮做题的开始：清空作答、回到 answering 阶段 */
function startExam() {
  const qs = state.lesson?.questions || [];
  state.phase = 'answering';
  state.userAnswers = new Map();
  state.gradeResult = null;

  // 做题阶段先把原文藏起来，避免「边听边看原文」失去练习意义
  // （练耳朵模式例外：本来就是边听边看）
  if (!isListenMode()) els.lyrics.classList.add('exam-hidden');
  applyPhaseUI();
  renderQuestions();
  renderSectionNav();
  updateExamProgress();
}

/** 根据阶段 + 模式更新界面的可见性 */
function applyPhaseUI() {
  const listen = isListenMode();
  const reviewing = state.phase === 'reviewing' || listen;
  const hasQ = (state.lesson?.questions || []).length > 0;

  els.stepAnswer?.classList.toggle('active', !reviewing);
  els.stepAnswer?.classList.toggle('done', reviewing);
  els.stepReview?.classList.toggle('active', reviewing);

  if (els.btnSubmit) {
    els.btnSubmit.disabled = !hasQ || reviewing;
    els.btnSubmit.textContent = reviewing ? '已批改' : '提交并批改';
  }
  if (els.btnReset) els.btnReset.hidden = !reviewing || listen;

  // 没有题目时不必显示流程条；练耳朵模式整条都收起来（没有「提交」这回事）
  if (els.examBar) els.examBar.hidden = !hasQ || listen;

  // 复盘阶段才允许看原文（练耳朵模式一直给看）
  const hideLyrics = !reviewing && hasQ && !listen;
  els.lyrics.classList.toggle('exam-hidden', hideLyrics);
  if (els.examVeil) els.examVeil.hidden = !hideLyrics;
  if (els.btnRaw) els.btnRaw.disabled = hideLyrics;
}

/**
 * 正确率：0–100 的整数百分比 + 等级。
 *
 * 等级决定颜色：**≥60% 绿色，<60% 红色**（用户明确要求的分界线）。
 * 抽成一个纯函数，是因为它同时用在顶部流程条、题目面板横幅和提示语三处，
 * 三处各写一遍迟早会不一致。
 */
const PASS_RATE = 60;

function accuracyOf(right, total) {
  const n = Number(total) || 0;
  const pct = n > 0 ? Math.round((Number(right) || 0) / n * 100) : 0;
  return { pct, level: pct >= PASS_RATE ? 'good' : 'bad', pass: pct >= PASS_RATE };
}

/** 正确率的一小段 HTML（数字带颜色），三处共用同一套类名 */
function accuracyHtml(right, total, opts = {}) {
  const { pct, level } = accuracyOf(right, total);
  const tail = opts.withCount === false ? '' : `<span class="accuracy-sub">${right} / ${total} 题</span>`;
  return `<b class="accuracy ${level}">${pct}%</b>${tail}`;
}

/** 统计已作答数量；批改后改成显示正确率 */
function updateExamProgress() {
  const qs = state.lesson?.questions || [];
  if (!els.examProgress) return;
  if (!qs.length) { els.examProgress.textContent = ''; return; }
  if (state.phase === 'reviewing') {
    const r = state.gradeResult;
    if (!r) { els.examProgress.textContent = ''; return; }
    // 数字用 innerHTML 才能带颜色；内容全是数字，无注入风险
    els.examProgress.innerHTML = '正确率 ' + accuracyHtml(r.right, r.total);
  } else {
    els.examProgress.textContent = `已作答 ${state.userAnswers.size} / ${qs.length}`;
  }
}

/** 判断题号所属 Section（剑桥雅思：1-10=S1 … 31-40=S4） */
function sectionOfQ(q, index) {
  if (q.section) return q.section;
  const n = q.number != null ? Number(q.number) : index + 1;
  return Math.min(4, Math.floor((n - 1) / 10) + 1);
}

/** 判定一道题用户是否答对 */
function isCorrect(q, userAns) {
  if (userAns == null || userAns === '') return false;
  const accepted = (q.alternatives && q.alternatives.length)
    ? q.alternatives
    : [q.answer].filter(Boolean);

  const normalize = (s) => String(s)
    .toLowerCase()
    .replace(/[’'`]/g, "'")
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const u = normalize(userAns);
  if (!u) return false;

  return accepted.some((a) => {
    const n = normalize(a);
    if (!n) return false;
    if (n === u) return true;
    // 忽略括号内容与冠词后再比一次
    const strip = (s) => s.replace(/\b(a|an|the)\b/g, '').replace(/\s+/g, ' ').trim();
    return strip(n) === strip(u);
  });
}

// ------------------------------------------------------------ 渲染题目

function renderQuestions() {
  const qs = state.lesson?.questions || [];
  // 练耳朵模式：不做题，题目只当「对照材料」看 —— 按复盘的样子渲染（直接带答案、不可作答）
  const listen = isListenMode();
  const reviewing = state.phase === 'reviewing' || listen;
  els.qCounter.textContent = qs.length ? `${qs.length} 题` : '';

  if (!qs.length) {
    els.qBody.innerHTML = '<div class="empty-hint">该课程暂无题目数据。<br><br>'
      + '剑桥雅思的题干在原题 PDF 里，本课程的题目为「题号 + 答案」骨架。<br>'
      + '可用右上角「导入」补充原题与解析，格式见 <code>docs/format.md</code>。</div>';
    return;
  }

  // 按 Section 分组渲染
  let html = '';

  // 批改结果横幅：正确率是复盘时第一眼要看的东西（≥60% 绿、<60% 红）
  // 练耳朵模式没有作答，就不摆成绩了
  if (reviewing && state.gradeResult && !listen) {
    const r = state.gradeResult;
    const acc = accuracyOf(r.right, r.total);
    const wrong = r.total - r.right;
    html += `<div class="grade-banner ${acc.level}">
      <div class="grade-head">
        <span class="grade-label">正确率</span>
        <b class="accuracy big ${acc.level}">${acc.pct}%</b>
      </div>
      <div class="grade-sub">
        <span class="grade-ok">✓ 答对 ${r.right} 题</span>
        <span class="grade-no">✗ 答错 ${wrong} 题</span>
        <span>共 ${r.total} 题</span>
      </div>
      <div class="grade-hint">${acc.pass
        ? '达标（≥60%）。错题点下面的「跳到原文并播放」逐题复盘，注意同义替换。'
        : '低于 60%，建议把错题所在的原句反复精听几遍再重做一次。'}</div>
    </div>`;
  }

  let lastSection = null;
  let lastGroup = null;

  qs.forEach((q, qi) => {
    const sec = sectionOfQ(q, qi);
    if (sec !== lastSection) {
      html += `<div class="q-section-head" id="qsec-${sec}">Section ${sec}</div>`;
      lastSection = sec;
    }
    // 换题组时插入题型指令（来自原题 PDF），让用户知道这组题怎么答
    if (q.group && q.group !== lastGroup) {
      lastGroup = q.group;
      const ins = (q.instructions || []).map((s) => escapeHtml(s)).join('<br>');
      html += `<div class="q-group-head">
        <span class="q-group-tag">${escapeHtml(q.group)}</span>
        ${ins ? `<div class="q-group-ins">${ins}</div>` : ''}
      </div>`;
    }

    const num = q.number != null ? q.number : qi + 1;
    const userAns = state.userAnswers.get(num) ?? state.userAnswers.get(qi) ?? '';
    const right = reviewing ? isCorrect(q, userAns) : null;

    // 选项（多选题）或填空输入
    let body;
    // 优先用 questions.json 里的 options；没有就用原题 PDF 抽出的 optionsText。
    // ⚠️ 作答阶段【不能】标出正确答案（否则直接泄题），只有复盘阶段才标。
    const optSrc = (q.options && q.options.length >= 2)
      ? q.options.map((o, i) => (typeof o === 'string' ? { key: String.fromCharCode(65 + i), text: o } : o))
      : ((q.optionsText && q.optionsText.length >= 2) ? q.optionsText : null);

    if (optSrc) {
      const opts = optSrc.map((o) => {
        const key = o.key;
        const text = o.text;
        const ansLetter = String(q.answer || '').trim().toUpperCase();
        const isAns = /^[A-H]$/.test(ansLetter) && key === ansLetter;
        const isPicked = String(userAns).trim().toUpperCase() === key;
        let cls = 'q-option';
        if (reviewing) {
          if (isAns) cls += ' correct';
          else if (isPicked) cls += ' wrong';
        } else if (isPicked) {
          cls += ' picked';
        }
        return `<button class="${cls}" data-q="${qi}" data-key="${key}" data-num="${num}">
          <span class="key">${escapeHtml(key)}</span><span>${escapeHtml(text)}</span>
        </button>`;
      }).join('');
      body = `<div class="q-options">${opts}</div>`;
    } else {
      // 填空题：输入框
      let cls = 'q-input';
      if (reviewing) cls += right ? ' correct' : ' wrong';
      body = `<input class="${cls}" type="text" data-q="${qi}" data-num="${num}"
                 placeholder="在此输入答案…" value="${escapeHtml(userAns)}"
                 ${reviewing ? 'readonly' : ''} autocomplete="off" spellcheck="false">`;
    }

    const stem = q.stem
      ? escapeHtml(q.stem).replace(/_{2,}/g, '<span class="blank">______</span>')
      : '<span class="stem-missing">（题干见原题 PDF）</span>';
    // 批改结果
    const verdict = reviewing
      ? `<span class="q-verdict ${right ? 'right' : 'wrong'}">${right ? '✓ 正确' : '✗ 错误'}</span>`
      : (userAns ? '<span class="badge dim">已作答</span>' : '');

    // 复盘时显示正确答案 + 跳转按钮
    let answerRow = '';
    let jumpBtn = '';
    if (reviewing) {
      // 选择题展示：字母 + 实际选项文字（选择题答案单独一个字母看不出意思）
      const ansLetter = String(q.answer || '').trim().toUpperCase();
      const isChoice = /^[A-H]$/.test(ansLetter);
      let ansShow;
      if (isChoice && q.answerText) {
        ansShow = `${ansLetter}. ${q.answerText}`;
      } else {
        const accept = (q.alternatives && q.alternatives.length) ? q.alternatives : [q.answer || '—'];
        ansShow = accept.filter(Boolean).join('  /  ') || '—';
      }
      answerRow = `<div class="q-answer-row">
        <span class="k">正确答案：</span><span class="v">${escapeHtml(ansShow)}</span>
        ${userAns ? `<br><span class="k">你的作答：</span>${escapeHtml(userAns)}` : '<br><span class="k">未作答</span>'}
      </div>`;

      if (q.answerLine != null) {
        jumpBtn = `<button class="q-jump" data-line="${q.answerLine}" data-num="${num}">
          ▶ 跳到原文并播放${q.answerTime != null ? `（${fmtTime(q.answerTime)}）` : ''}
        </button>`;
      } else {
        jumpBtn = '<button class="q-jump no-target" disabled title="未能定位到原文">原文位置未定位</button>';
      }
    }

    const explain = (reviewing && q.explain)
      ? `<div class="q-explain"><strong>解析：</strong>${escapeHtml(q.explain).replace(/\n/g, '<br>')}</div>`
      : '';

    html += `<div class="q-item ${reviewing ? 'graded' : ''} ${reviewing && !userAns ? 'unanswered' : ''}" data-q="${qi}">
      <div class="q-head">
        <span class="q-num">${escapeHtml(String(num))}</span>
        ${verdict}
      </div>
      <div class="q-stem">${stem}</div>
      ${body}
      ${answerRow}
      ${jumpBtn}
      ${explain}
    </div>`;
  });

  els.qBody.innerHTML = html;

  // 事件：选项
  els.qBody.querySelectorAll('.q-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (state.phase === 'reviewing' || isListenMode()) return;   // 练耳朵模式不做题
      const qi = Number(btn.dataset.q);
      const num = Number(btn.dataset.num);
      const item = els.qBody.querySelector(`.q-item[data-q="${qi}"]`);
      item.querySelectorAll('.q-option').forEach((el) => el.classList.remove('picked'));
      btn.classList.add('picked');
      state.userAnswers.set(num, btn.dataset.key);
      updateExamProgress();
    });
  });

  // 事件：填空输入
  els.qBody.querySelectorAll('.q-input').forEach((inp) => {
    inp.addEventListener('input', () => {
      if (isListenMode()) return;
      const num = Number(inp.dataset.num);
      const v = inp.value.trim();
      if (v) state.userAnswers.set(num, v);
      else state.userAnswers.delete(num);
      updateExamProgress();
    });
  });

  // 事件：跳到原文并播放
  els.qBody.querySelectorAll('.q-jump[data-line]').forEach((btn) => {
    btn.addEventListener('click', () => {
      jumpToLine(Number(btn.dataset.line));
    });
  });
}

/**
 * 跳到原文某一行并播放。
 * 这是「点答案跳转」的核心：把该行滚到中间、高亮闪烁、从该行时间戳开始播。
 */
function jumpToLine(lineIndex) {
  const line = state.lines[lineIndex];
  if (!line) { toast('原文位置无效'); return; }

  // 复盘阶段若把原文隐藏了，先取消隐藏
  state.phase = 'reviewing';
  applyPhaseUI();

  audio.currentTime = Math.max(0, line.time + 0.01);
  audio.play().catch(() => {});

  setActive(lineIndex, true);

  // 强调一下跳到了哪一行
  const el = state.lineEls[lineIndex];
  if (el) {
    el.classList.add('highlight-flash');
    setTimeout(() => el.classList.remove('highlight-flash'), 2400);
  }

  // 移动端：关掉题目抽屉，让用户看到原文（宽屏下第三栏不动）
  setQPanel(false, { onlyIfNarrow: true });

  toast(`跳到 ${fmtTime(line.time)}`);
}

// ------------------------------------------------------------ 批改

function submitExam() {
  const qs = state.lesson?.questions || [];
  if (!qs.length) { toast('本课程没有题目'); return; }

  const unanswered = qs.filter((q, qi) => {
    const num = q.number != null ? q.number : qi + 1;
    return !state.userAnswers.get(num);
  });

  if (unanswered.length && !state.confirmSubmit) {
    state.confirmSubmit = true;
    toast(`还有 ${unanswered.length} 题未作答，再点一次「提交」确认`);
    setTimeout(() => { state.confirmSubmit = false; }, 3200);
    return;
  }
  state.confirmSubmit = false;

  let right = 0;
  const wrongList = [];
  qs.forEach((q, qi) => {
    const num = q.number != null ? q.number : qi + 1;
    const ans = state.userAnswers.get(num);
    if (isCorrect(q, ans)) right++;
    else wrongList.push(num);
  });

  state.gradeResult = { right, total: qs.length, wrong: wrongList };
  state.phase = 'reviewing';

  applyPhaseUI();
  renderQuestions();
  updateExamProgress();

  // 把原文里被作为答案的位置标出来，方便对照
  markAnswerLines();

  const acc = accuracyOf(right, qs.length);
  toast(`批改完成：正确率 ${acc.pct}%（${right} / ${qs.length}）`
    + (acc.pass ? ' · 达标' : ' · 未达标'));

  // 把成绩记进学习记录：课程列表上就会显示「正确率 xx%」
  recordScore(state.lesson?.manifest?.id, right, qs.length);
  renderLessonList();

  // 移动端：批改后直接展开题目抽屉看结果
  setQPanel(true, { onlyIfNarrow: true });
}

/** 在原文里标出答案所在行 */
function markAnswerLines() {
  state.lineEls.forEach((el) => el.classList.remove('is-answer'));
  const qs = state.lesson?.questions || [];
  const seen = new Set();
  for (const q of qs) {
    if (q.answerLine == null) continue;
    const el = state.lineEls[q.answerLine];
    if (el && !seen.has(q.answerLine)) {
      el.classList.add('is-answer');
      seen.add(q.answerLine);
      // 在行首标出题号，便于对照
      if (!el.dataset.answerMark) {
        el.dataset.answerMark = '1';
        const ts = el.querySelector('.ts');
        if (ts) ts.insertAdjacentHTML('afterend',
          `<div class="answer-badges">${q.number != null ? 'Q' + q.number : ''}</div>`);
      }
    }
  }
}

function resetExam() {
  state.userAnswers = new Map();
  state.gradeResult = null;
  state.phase = 'answering';
  state.lineEls.forEach((el) => el.classList.remove('is-answer'));
  els.qBody.querySelectorAll('.answer-badges').forEach((e) => e.remove());
  state.lineEls.forEach((el) => delete el.dataset.answerMark);
  applyPhaseUI();
  renderQuestions();
  updateExamProgress();
  toast('已清空作答，可以重做');
}

// ------------------------------------------------------------ Section 跳转

function renderSectionNav() {
  const lines = state.lines || [];
  if (!lines.length) { els.sectionNav && (els.sectionNav.innerHTML = ''); return; }
  if (!els.sectionNav) return;

  // 从原文里找 Section 起点（音频会念 "Section 1" / "Part one"）
  const wordNum = { one: 1, two: 2, three: 3, four: 4, '1': 1, '2': 2, '3': 3, '4': 4 };
  const re = /\b(?:section|part)\s+(one|two|three|four|[1-4])\b/i;
  const starts = {};
  lines.forEach((l, i) => {
    const m = re.exec(l.text);
    if (!m) return;
    const n = wordNum[m[1].toLowerCase()];
    if (n && starts[n] == null) starts[n] = i;
  });

  const found = Object.keys(starts).map(Number).sort((a, b) => a - b);
  if (!found.length) { els.sectionNav.innerHTML = ''; return; }

  els.sectionNav.innerHTML = '<span class="section-nav-label">跳转</span>'
    + found.map((n) => `<button class="section-btn" data-line="${starts[n]}">Section ${n}</button>`).join('');

  els.sectionNav.querySelectorAll('.section-btn').forEach((b) => {
    b.addEventListener('click', () => jumpToLine(Number(b.dataset.line)));
  });
}

/** 窄屏判定：也是「题目面板要不要做成抽屉」的分界线（与 CSS 的 860px 保持一致） */
const NARROW_MAX = 860;
function isNarrow() {
  return window.matchMedia(`(max-width: ${NARROW_MAX}px)`).matches;
}
// 老名字，别的地方还在用
function isMobile() {
  return isNarrow();
}

// ------------------------------------------------------------ 歌词同步

/** 二分查找：最后一个 time <= t 的下标 */
function findLineIndex(t) {
  const arr = state.lines;
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].time <= t + 0.02) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

function setActive(index, forceScroll) {
  if (index === state.activeIndex && !forceScroll) return;

  const prev = state.lineEls[state.activeIndex];
  if (prev) {
    prev.classList.remove('active');
    prev.classList.add('past');
  }

  state.activeIndex = index;
  const el = state.lineEls[index];
  if (!el) return;

  el.classList.remove('past');
  el.classList.add('active');

  for (let i = 0; i < index; i++) state.lineEls[i]?.classList.add('past');
  for (let i = index + 1; i < state.lineEls.length; i++) state.lineEls[i]?.classList.remove('past');

  if (state.follow && !state.userScrolling) {
    scrollToLine(el, forceScroll);
  }
}

function scrollToLine(el, instant) {
  const wrap = els.lyrics;
  const target = el.offsetTop - wrap.clientHeight / 2 + el.offsetHeight / 2;
  const max = wrap.scrollHeight - wrap.clientHeight;
  const top = Math.max(0, Math.min(max, target));

  if (instant) {
    wrap.classList.add('no-smooth');
    wrap.scrollTop = top;
    requestAnimationFrame(() => wrap.classList.remove('no-smooth'));
  } else {
    wrap.scrollTop = top;
  }
  els.jumpNow.classList.remove('show');
}

/** 逐词高亮（增强型 LRC） */
function updateWords(t) {
  const el = state.lineEls[state.activeIndex];
  if (!el) return;
  const words = el.querySelectorAll('.w');
  if (words.length < 2) return;
  for (const w of words) {
    const wt = Number(w.dataset.t);
    w.classList.toggle('on', wt <= t + 0.02);
  }
}

// ------------------------------------------------------------ 播放循环

let rafId = null;
let lastTickAt = 0;        // 上一次 rAF 的时刻，用来判断 rAF 是否已经停了
let lastPosSaveAt = 0;     // 上次写「播放位置」的时间

function tick() {
  rafId = requestAnimationFrame(tick);
  lastTickAt = performance.now();

  const t = audio.currentTime;
  const d = audio.duration || state.lesson?.manifest?.duration || 0;

  // 进度条（拖动中不要被播放位置覆盖，否则手指底下会跳）
  if (d > 0) {
    const pct = (t / d) * 100;
    if (!dragging) {
      els.played.style.width = pct + '%';
      els.thumb.style.left = pct + '%';
    }
    els.timeTotal.textContent = fmtTime(d);
  } else if (!dragging) {
    els.timeTotal.textContent = '--:--';
  }
  if (!dragging) els.timeNow.textContent = fmtTime(t);

  if (audio.buffered.length) {
    const end = audio.buffered.end(audio.buffered.length - 1);
    if (d > 0) els.buffer.style.width = (end / d) * 100 + '%';
  }

  // 歌词同步
  if (state.lines.length) {
    setActive(findLineIndex(t));
    updateWords(t);
  }
}

/**
 * 循环控制（单句复读 / A-B）与状态上报。
 *
 * ⚠️ 为什么不能放在 tick()（rAF）里：页面一旦不可见 rAF 就停了，
 *    而「锁屏听听力」恰恰要用复读和 A-B 循环。这里改用定时器，
 *    并额外挂 timeupdate 兜底（它由媒体管道驱动，被节流的概率更低）。
 */
/**
 * 播放按钮的状态永远以 audio.paused 为准（每个循环都刷一次）。
 *
 * 为什么不能只靠 play/pause 事件：真机上遇到过「播放已经停了、按钮还停在 ⏸」——
 * 媒体栈在 seek / 卡顿 / 被系统打断时并不保证把 pause 事件送到页面。
 * 这个函数是幂等的，事件里也调它，两边不会打架。
 */
function syncPlayButton() {
  if (!els.play) return;
  const playing = !audio.paused && !audio.ended;
  const want = playing ? '⏸' : '▶';
  if (els.play.textContent !== want) els.play.textContent = want;
  els.play.classList.toggle('playing', playing);
}

// ---- 卡顿看门狗：显示在播放、但进度长时间不动，就自己救回来 ----
let lastProgressTime = -1;
let lastProgressAt = 0;
let stallRecoveries = 0;

function watchStall(t) {
  const now = Date.now();
  if (audio.paused || audio.seeking || dragging) {
    lastProgressTime = t;
    lastProgressAt = now;
    return;
  }
  if (Math.abs(t - lastProgressTime) > 0.05) {
    lastProgressTime = t;
    lastProgressAt = now;
    stallRecoveries = 0;
    return;
  }
  if (!lastProgressAt) { lastProgressAt = now; return; }
  if (now - lastProgressAt < 3000) return;

  // 3 秒没动：先试着重新 play()，再不行就重新加载这一位置
  lastProgressAt = now;
  stallRecoveries += 1;
  if (stallRecoveries === 1) {
    console.warn('[player] 播放卡住，尝试恢复');
    const p = audio.play();
    if (p && p.catch) p.catch(() => { /* 下一次走重载 */ });
    return;
  }
  if (stallRecoveries === 2) {
    const at = audio.currentTime;
    const wasPlaying = true;
    console.warn('[player] 恢复失败，重新加载音频');
    toast('播放卡住了，正在重新加载…');
    audio.load();
    audio.addEventListener('loadedmetadata', function once() {
      audio.removeEventListener('loadedmetadata', once);
      audio.currentTime = at;
      if (wasPlaying) { const p = audio.play(); if (p && p.catch) p.catch(() => {}); }
    });
  }
}

function tickControl() {
  const t = audio.currentTime;
  const d = audio.duration || state.lesson?.manifest?.duration || 0;

  syncPlayButton();
  watchStall(t);

  // rAF 停了（锁屏/切后台）时，当前行没人维护 —— 这里补算，
  // 否则「单句复读」会一直循环切走之前的那一句
  if (performance.now() - lastTickAt > 1000) {
    state.activeIndex = findLineIndex(t);
  }

  if (!audio.paused) {
    if (state.repeat === 'line' && state.activeIndex >= 0) {
      const line = state.lines[state.activeIndex];
      const next = state.lines[state.activeIndex + 1];
      const end = next ? next.time : (d || line.time + 6);
      if (t >= end - 0.02) {
        audio.currentTime = line.time + 0.001;
      }
    } else if (state.repeat === 'ab' && state.ab.a != null && state.ab.b != null) {
      if (t >= state.ab.b - 0.02 || t < state.ab.a - 0.35) {
        audio.currentTime = state.ab.a + 0.001;
      }
    }
  }

  reportPlayback(false);
  updateSleepLeft();

  // 播放位置每 5 秒记一次（暂停与结束时还会再记一次，那两次是精确的）
  const now = Date.now();
  if (!audio.paused && now - lastPosSaveAt > 5000) {
    lastPosSaveAt = now;
    recordPosition(state.lesson?.manifest?.id, t, d);
  }
}

setInterval(tickControl, 250);
audio.addEventListener('timeupdate', tickControl);

// ------------------------------------------------------------ 后台 / 锁屏保活
//
// Android 侧有个前台服务（PlaybackService）负责让进程活到锁屏之后，
// 这里要做两件事：
//   ① 把播放状态报上去（正在播/暂停、标题、进度）→ 常驻通知与锁屏控制条
//   ② 接住通知栏/锁屏/耳机来的命令（__onHostCommand）作用到播放器
// 桌面浏览器里没有这个桥，整块逻辑自动空转，不影响任何行为。

let lastReportAt = 0;

function reportPlayback(force) {
  const h = host();
  if (!h || typeof h.setPlaybackState !== 'function') return;
  const now = performance.now();
  if (!force && now - lastReportAt < 2000) return;   // 定时上报最多 2 秒一次
  lastReportAt = now;

  const m = state.lesson?.manifest || {};
  const d = audio.duration || m.duration || 0;
  const sub = [m.paper, m.section].filter(Boolean).join(' · ') || m.source || '';
  try {
    h.setPlaybackState(!audio.paused, m.title || 'Whale Lite', sub,
      audio.currentTime || 0, Number.isFinite(d) ? d : 0);
  } catch (err) { /* 报不上去不影响播放 */ }
}

/**
 * 来自通知栏 / 锁屏 / 耳机线控的命令（Java 侧 evaluateJavascript 调用）。
 * 命令名与 PlaybackService 里的一致。
 */
window.__onHostCommand = (cmd, value) => {
  switch (cmd) {
    case 'toggle':
      if (audio.paused) audio.play().catch(() => {}); else audio.pause();
      break;
    case 'play':
      audio.play().catch(() => {});
      break;
    case 'pause':
      audio.pause();
      break;
    case 'stop':
      audio.pause();
      audio.currentTime = 0;
      host()?.stopPlayback?.();
      break;
    case 'prevLine':
      gotoLine(-1);
      break;
    case 'nextLine':
      gotoLine(1);
      break;
    case 'back5':
      audio.currentTime = Math.max(0, audio.currentTime - 5);
      break;
    case 'fwd5':
      audio.currentTime = Math.min(audio.duration || 1e9, audio.currentTime + 5);
      break;
    case 'seek':
      if (Number.isFinite(Number(value))) {
        audio.currentTime = Math.max(0, Math.min(audio.duration || 1e9, Number(value)));
      }
      break;
    default:
      break;
  }
  reportPlayback(true);
};


// ------------------------------------------------------------ A-B

/** 正确的循环按钮文案与提示（A/B 这种叫法用户看不懂，统一说「循环起点/终点」） */
function updateLoopUI() {
  const { a, b } = state.ab;
  if (els.abReadout) {
    els.abReadout.textContent = (a == null && b == null)
      ? ''
      : `循环 ${a == null ? '--:--' : fmtTime(a)} → ${b == null ? '--:--' : fmtTime(b)}`;
  }
  // 「设置循环终点 / 清除循环」只在已经有起点之后才有意义。
  // 窄屏上播放器本来就挤（四行控件），没设起点时先收起来，省一整行给原文。
  // 只影响显示，不影响任何操作流程：点了「设置循环起点」这两个按钮立刻出现。
  els.app.classList.toggle('has-ab', a != null);
  const d = audio.duration || state.lesson?.manifest?.duration || 0;
  if (a != null && b != null && d > 0) {
    els.ab.style.left = (a / d) * 100 + '%';
    els.ab.style.width = ((b - a) / d) * 100 + '%';
    els.ab.classList.add('show');
  } else {
    els.ab.classList.remove('show');
  }
}

function clearAB() {
  state.ab = { a: null, b: null };
  els.ab.classList.remove('show');
  updateLoopUI();
}

// ------------------------------------------------------------ 做题流程事件

els.btnSubmit?.addEventListener('click', submitExam);
els.btnReset?.addEventListener('click', resetExam);

// ------------------------------------------------------------ 修订模式
//
// 为什么要有：原文来自 Whisper 转写，原题来自 PDF 的 OCR，两者都会出错。
// 实测 OCR 把 "Complete the table below." 识别成 "Completethetablebelow."，
// 专有名词也常错。用户需要能自己改。
//
// 保存策略：改动写到独立的 override 文件（服务端 lib/edit.js 负责），
// 不覆盖机器生成的文件，所以重跑转写/OCR 不会丢失手工修订，也能一键还原。

/** 收集界面上当前显示的原文行（含用户刚改的） */
function collectLines() {
  return state.lineEls.map((el, i) => {
    const txtEl = el.querySelector('.txt');
    // 只取英文原文节点，跳过译文（.zh）
    let text = '';
    if (txtEl) {
      const clone = txtEl.cloneNode(true);
      clone.querySelectorAll('.zh').forEach((z) => z.remove());
      text = clone.textContent.replace(/\s+/g, ' ').trim();
    }
    const t = Number(el.dataset.t);
    return { time: Number.isFinite(t) ? t : (state.lines[i]?.time || 0), text };
  });
}

/** 收集界面上当前显示的题目（含用户刚改的） */
function collectQuestions() {
  const base = state.lesson?.questions || [];
  return base.map((q, qi) => {
    const item = els.qBody.querySelector(`.q-item[data-q="${qi}"]`);
    if (!item) return q;
    const stemEl = item.querySelector('.q-stem');
    const ansEl = item.querySelector('.q-answer-row .v');
    const inp = item.querySelector('.q-input');
    const next = { ...q };
    if (stemEl && !stemEl.querySelector('.stem-missing')) {
      next.stem = stemEl.textContent.trim();
    }
    if (ansEl) next.answer = ansEl.textContent.trim();
    // 选择题的选项文字也可能被改
    const opts = [...item.querySelectorAll('.q-option')];
    if (opts.length) {
      const texts = opts.map((o) => o.querySelector('span:last-child').textContent.trim());
      if (next.options && next.options.length === texts.length) next.options = texts;
      if (next.optionsText && next.optionsText.length === texts.length) {
        next.optionsText = next.optionsText.map((o, i) => ({ ...o, text: texts[i] }));
      }
      if (next.answerText) {
        const hit = opts.find((o) => o.classList.contains('correct'));
        if (hit) next.answerText = hit.querySelector('span:last-child').textContent.trim();
      }
    }
    if (inp && state.phase !== 'reviewing') next._userAnswer = inp.value;
    return next;
  });
}

function setEditable(el, on) {
  if (!el) return;
  if (on) el.setAttribute('contenteditable', 'plaintext-only');
  else el.removeAttribute('contenteditable');
}

/** 进入/退出修订模式 */
function setEditMode(on) {
  state.editing = on;
  els.app.classList.toggle('editing', on);
  if (els.editBar) els.editBar.hidden = !on;
  if (els.btnEdit) els.btnEdit.classList.toggle('on', on);

  // 原文行：只有英文部分可改（译文是机翻产物，改了会与时间轴脱节）
  state.lineEls.forEach((el) => {
    const txt = el.querySelector('.txt');
    setEditable(txt, on);
  });

  // 题目：题干、正确答案、选项文字
  // 「（题干见原题 PDF）」这类占位提示在修订模式下也要能改 ——
  // 用户正是要在这里把 OCR 抽不出来的题干补上。
  els.qBody.querySelectorAll('.q-stem, .q-answer-row .v, .q-option span:last-child')
    .forEach((el) => {
      setEditable(el, on);
      if (on && el.classList.contains('stem-missing')) {
        // 占位文字清掉，方便直接输入
        el.classList.remove('stem-missing');
        el.textContent = '';
        el.dataset.wasPlaceholder = '1';
      } else if (!on && el.dataset.wasPlaceholder && !el.textContent.trim()) {
        el.classList.add('stem-missing');
        el.textContent = '（题干见原题 PDF）';
        delete el.dataset.wasPlaceholder;
      }
    });

  // 填空题输入框在修订模式下也不能被 readonly 挡住
  els.qBody.querySelectorAll('.q-input').forEach((inp) => {
    if (on) inp.removeAttribute('readonly');
    else if (state.phase === 'reviewing') inp.setAttribute('readonly', '');
  });

  if (on) {
    toast('修订模式：点击文字即可修改');
    updateEditCount();
    // 修订时不要因为点一下就跳转播放，否则没法选字
    els.lyrics.classList.add('editing-lyrics');
  } else {
    els.lyrics.classList.remove('editing-lyrics');
  }
}

function updateEditCount() {
  if (!els.editCount) return;
  const n = state.editDirty || 0;
  els.editCount.textContent = n ? `${n} 处改动未保存` : '';
}

/** 标记有改动（内容变化时调用） */
function markDirty() {
  state.editDirty = (state.editDirty || 0) + 1;
  updateEditCount();
}

els.btnEdit?.addEventListener('click', () => {
  closeMoreMenu();
  if (!state.lesson) { toast('请先选择课程'); return; }
  setEditMode(!state.editing);
});
els.btnExitEdit?.addEventListener('click', () => setEditMode(false));

// 内容变化时计数
els.lyrics?.addEventListener('input', () => { if (state.editing) markDirty(); });
els.qBody?.addEventListener('input', () => { if (state.editing) markDirty(); });

els.btnSaveEdit?.addEventListener('click', async () => {
  if (!state.lesson) return;
  els.btnSaveEdit.disabled = true;
  try {
    const id = state.lesson.manifest.id;
    const lines = collectLines();
    const questions = collectQuestions();

    const r1 = await fetch('/api/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lessonId: id, what: 'transcript', lines }),
    });
    const d1 = await r1.json();
    if (!r1.ok) throw new Error(d1.error || '原文保存失败');

    const r2 = await fetch('/api/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lessonId: id, what: 'questions', questions }),
    });
    const d2 = await r2.json();
    if (!r2.ok) throw new Error(d2.error || '题目保存失败');

    state.editDirty = 0;
    updateEditCount();
    toast(`已保存：原文 ${d1.lines} 行、题目 ${d2.questions} 道`);
    setEditMode(false);
    await selectLesson(id);   // 重新载入，让修订生效
  } catch (err) {
    toast('保存失败：' + err.message);
  } finally {
    els.btnSaveEdit.disabled = false;
  }
});

els.btnRevertEdit?.addEventListener('click', async () => {
  if (!state.lesson) return;
  const m = state.lesson.manifest;
  if (!m.editedTranscript && !m.editedQuestions) { toast('本课程没有修订记录'); return; }
  if (!confirm('确定丢弃本课程的所有手工修订，还原成机器生成的版本？')) return;
  try {
    const r = await fetch('/api/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lessonId: m.id, action: 'revert' }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '还原失败');
    toast('已还原' + (d.removed.length ? '（' + d.removed.length + ' 个修订文件）' : ''));
    state.editDirty = 0;
    setEditMode(false);
    await selectLesson(m.id);
  } catch (err) {
    toast('还原失败：' + err.message);
  }
});

// ------------------------------------------------------------ 下载文本

/** 把一段文本作为文件下载（原文、原题都用它） */
function downloadText(text, filename) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = String(filename).replace(/[\\/:*?"<>|]/g, '_');
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/**
 * 下载原文 txt。
 * 用户要拿它去喂大模型做解析，所以带上完整原文（含译文，若有）。
 */
els.btnDownloadRaw?.addEventListener('click', () => {
  const L = state.lesson;
  if (!L) return;
  const title = L.manifest.title || 'lesson';
  const header = [
    `# ${title}`,
    L.manifest.transcriptSource?.kind === 'whisper'
      ? `# 注意：以下原文由 Whisper 自动语音识别生成（模型 ${L.manifest.transcriptSource.model || '未知'}），非官方原文，可能有错字。`
      : '',
    '',
  ].filter(Boolean).join('\n');

  downloadText(header + els.rawText.textContent, title + '.txt');
  toast('原文已下载');
});

// ------------------------------------------------------------ 导入资料

els.btnImport?.addEventListener('click', () => {
  closeMoreMenu();
  els.importDrawer.hidden = false;
});
els.btnCloseImport?.addEventListener('click', () => { els.importDrawer.hidden = true; });
els.importDrawer?.addEventListener('click', (e) => {
  if (e.target === els.importDrawer) els.importDrawer.hidden = true;
});

// ------------------------------------------------------------ 补充包管理面板

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1073741824) return (v / 1073741824).toFixed(2) + ' GB';
  if (v >= 1048576) return (v / 1048576).toFixed(1) + ' MB';
  if (v >= 1024) return (v / 1024).toFixed(1) + ' KB';
  return v + ' B';
}

/** 打包时随 APK 带的「有哪些补充包可装」清单（build-apk.js 生成） */
async function loadPackCatalog() {
  const j = await fetchLocalJson('packs-catalog.json');
  state.packCatalog = (j && j.packs) || [];
  return state.packCatalog;
}

function packItemHtml(p) {
  const status = p.ok
    ? '<span class="badge official">✅ 已安装</span>'
    : '<span class="badge warn">⚠️ 无法使用</span>';
  const rows = [];
  if (p.set) rows.push(`<span class="badge pack">📦 ${escapeHtml(p.set)}</span>`);
  if (p.lessons) rows.push(`<span class="badge dim">声明 ${p.lessons} 门课</span>`);
  if (p.loadedLessons != null) rows.push(`<span class="badge dim">已加载 ${p.loadedLessons} 门</span>`);
  rows.push(`<span class="badge dim">${fmtBytes(p.sizeBytes)}</span>`);
  rows.push(status);

  const problem = !p.ok
    ? `<div class="pack-error">${escapeHtml(p.error || '校验未通过')}</div>`
    : (p.loadError ? `<div class="pack-error">${escapeHtml(p.loadError)}</div>` : '');

  return `<div class="pack-item ${p.ok ? 'ok' : 'bad'}">
    <div class="pack-main">
      <div class="pack-title">${escapeHtml(p.file || p.id)}</div>
      <div class="pack-sub">${rows.join('')}</div>
      ${problem}
    </div>
    <div class="pack-ops">
      <button class="ghost-btn" data-pack-del="${escapeHtml(p.id)}" title="从手机里删除这个补充包">移除</button>
    </div>
  </div>`;
}

function renderPackPanel() {
  if (!els.packDrawer) return;

  const h = host();
  const info = DATA_SOURCE.packInfo;
  let dir = (info && info.dir) || '';
  if (!dir && h && typeof h.packsDir === 'function') {
    try { dir = h.packsDir(); } catch { dir = ''; }
  }
  if (els.packDir) els.packDir.textContent = dir || '（当前环境没有补充包目录）';

  const isAndroid = !!h;
  if (els.packHint) {
    // 说人话：用户只关心「这是什么、怎么用」，APK 2GiB 上限那种实现细节放到折叠区
    els.packHint.innerHTML = isAndroid
      ? '补充包是<b>批量导入听力材料</b>的包：一个文件里装着一整套课程'
        + '（音频 + 原文 + 译文 + 题目），放进手机就能离线听，不用解压。'
      : '补充包是给 <b>Android App</b> 用的听力材料包：一个文件里装着一整套课程。'
        + '<br>电脑上不需要它 —— 素材直接放在 <code>audio/</code> 目录，'
        + '<code>node server.js</code> 就能播全部课程。';
  }
  if (els.btnImportPack) els.btnImportPack.hidden = !isAndroid;

  // 已安装 / 已发现
  const packs = state.packs || [];
  if (els.packList) {
    els.packList.innerHTML = packs.length
      ? packs.map(packItemHtml).join('')
      : `<div class="empty-hint">${isAndroid
        ? '还没有补充包。<br>点右上角「导入 .lppack」，或把文件拷进上面那个目录后点「重新扫描」。'
        : '（桌面上没有补充包概念，见上面的说明）'}</div>`;
  }

  // 未安装的（来自随 APK 带的清单）
  const installedIds = new Set(packs.map((p) => p.id));
  if (els.packCatalog) {
    const rest = (state.packCatalog || []).filter((c) => !installedIds.has(c.id));
    els.packCatalog.innerHTML = rest.length
      ? `<div class="pack-section-title">随安装包提供的补充包</div>`
        + rest.map((c) => `<div class="pack-item catalog">
            <div class="pack-main">
              <div class="pack-title">${escapeHtml(c.file)}</div>
              <div class="pack-sub">
                ${c.set ? `<span class="badge pack">📦 ${escapeHtml(c.set)}</span>` : ''}
                ${c.lessons ? `<span class="badge dim">${c.lessons} 门课</span>` : ''}
                <span class="badge dim">${fmtBytes(c.sizeBytes)}</span>
                <span class="badge warn">未安装</span>
              </div>
              <div class="pack-error dim-text">把它拷到上面的目录（或用「导入 .lppack」选中它）即可离线播放。</div>
            </div>
          </div>`).join('')
      : '';
  }

  // 空间提示
  if (els.packStatus && !state.packBusy) {
    const free = info && info.freeBytes;
    els.packStatus.textContent = free
      ? `补充包目录可用空间：${fmtBytes(free)}（视频/音频素材较占空间，装之前先看看够不够）`
      : '';
  }

  // 删除按钮
  els.packList?.querySelectorAll('[data-pack-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.packDel;
      if (!confirm(`确定删除补充包「${id}」？\n\n包内的课程会立刻从课程列表消失（电脑上的原始文件不受影响）。`)) return;
      const h2 = host();
      if (!h2 || typeof h2.deletePack !== 'function') { toast('当前环境不支持删除'); return; }
      try {
        const res = JSON.parse(h2.deletePack(id));
        if (!res.ok) throw new Error(res.error || '删除失败');
        toast('已删除：' + id);
        DATA_SOURCE.packInfo = res.packs || DATA_SOURCE.packInfo;
        await refreshPacks(true);
      } catch (err) {
        toast('删除失败：' + err.message);
      }
    });
  });
}

els.btnPacks?.addEventListener('click', async () => {
  closeMoreMenu();
  els.packDrawer.hidden = false;
  renderPackPanel();
  // 列表与课程数据可能是在别处（数据线拷贝）加进去的，打开面板时重新扫一次
  const h = host();
  if (h && typeof h.rescanPacks === 'function') {
    try { DATA_SOURCE.packInfo = JSON.parse(h.rescanPacks()); } catch { /* 忽略 */ }
    await refreshPacks(true);
  }
});
els.btnClosePacks?.addEventListener('click', () => { els.packDrawer.hidden = true; });
els.packDrawer?.addEventListener('click', (e) => {
  if (e.target === els.packDrawer) els.packDrawer.hidden = true;
});

els.btnCopyPackDir?.addEventListener('click', async () => {
  const text = els.packDir?.textContent || '';
  try {
    await navigator.clipboard.writeText(text);
    toast('目录路径已复制');
  } catch {
    toast('复制失败，请手动抄写：' + text);
  }
});

els.btnImportPack?.addEventListener('click', () => {
  const h = host();
  if (!h || typeof h.importPack !== 'function') {
    toast('只有在 Android App 里才能导入补充包');
    return;
  }
  if (state.packBusy) { toast('正在导入，请稍候…'); return; }
  h.importPack();
});

els.btnRescanPacks?.addEventListener('click', async () => {
  const h = host();
  try {
    if (h && typeof h.rescanPacks === 'function') {
      DATA_SOURCE.packInfo = JSON.parse(h.rescanPacks());
    } else {
      DATA_SOURCE.packInfo = await fetchPackInfo();
    }
  } catch (err) {
    toast('重新扫描失败：' + err.message);
  }
  await refreshPacks(true);
  toast('已重新扫描补充包：' + state.packs.length + ' 个');
});

/**
 * Android 侧的事件回调（导入进度等）。
 * Java 里用 evaluateJavascript 调用，事件形如：
 *   {type:'import-start'|'import-progress'|'import-done'|'import-error'|'import-cancel'}
 */
window.__onPackEvent = async (ev) => {
  if (!ev || !ev.type) return;

  if (ev.type === 'import-start') {
    state.packBusy = true;
    if (els.packProgress) { els.packProgress.hidden = false; els.packProgressBar.style.width = '0%'; }
    if (els.packStatus) els.packStatus.textContent = `正在复制 ${ev.name || ''}（${fmtBytes(ev.sizeBytes)}）…`;
    return;
  }

  if (ev.type === 'import-progress') {
    const pct = ev.total > 0 ? Math.min(100, (ev.copied / ev.total) * 100) : 0;
    if (els.packProgress && ev.total > 0) els.packProgress.hidden = false;
    if (els.packProgressBar) els.packProgressBar.style.width = pct.toFixed(1) + '%';
    if (els.packStatus) {
      els.packStatus.textContent = `正在复制… ${fmtBytes(ev.copied)}`
        + (ev.total > 0 ? ` / ${fmtBytes(ev.total)}（${pct.toFixed(0)}%）` : '');
    }
    return;
  }

  if (ev.type === 'import-cancel') {
    state.packBusy = false;
    if (els.packProgress) els.packProgress.hidden = true;
    if (els.packStatus) els.packStatus.textContent = '已取消导入';
    return;
  }

  state.packBusy = false;
  if (els.packProgress) els.packProgress.hidden = true;

  if (ev.type === 'import-done') {
    if (els.packStatus) els.packStatus.textContent = '导入完成';
    toast(`补充包已装好：${ev.pack?.set || ev.pack?.id || ''}（${ev.pack?.lessons || 0} 门课）`);
    if (ev.packs) DATA_SOURCE.packInfo = ev.packs;
    await refreshPacks(true);
    renderPackPanel();
    return;
  }

  if (ev.type === 'import-error') {
    if (els.packStatus) els.packStatus.textContent = '导入失败：' + ev.message;
    toast('导入失败：' + ev.message);
    renderPackPanel();
  }
};

// ------------------------------------------------------------ 原题抽屉

els.btnPaper?.addEventListener('click', () => { els.paperDrawer.hidden = false; });
els.btnClosePaper?.addEventListener('click', () => { els.paperDrawer.hidden = true; });
els.paperDrawer?.addEventListener('click', (e) => {
  if (e.target === els.paperDrawer) els.paperDrawer.hidden = true;
});
els.btnCopyPaper?.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(els.paperText.textContent || '');
    toast('原题已复制');
  } catch { toast('复制失败，请手动选择'); }
});
els.btnDownloadPaper?.addEventListener('click', () => {
  const title = state.lesson?.manifest.title || 'paper';
  downloadText(els.paperText.textContent || '', title + '-原题.txt');
});

/** 读文件为文本 */
function readFileText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(r.error || new Error('读取失败'));
    r.readAsText(file, 'utf-8');
  });
}

/** 读文件为 base64（音频用） */
function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || '');
      resolve(s.slice(s.indexOf(',') + 1));
    };
    r.onerror = () => reject(r.error || new Error('读取失败'));
    r.readAsDataURL(file);
  });
}

els.btnDoImport?.addEventListener('click', async () => {
  const audioFile = els.fileAudio?.files?.[0];
  if (!audioFile) { toast('请先选择听力音频'); return; }

  const setStatus = (s) => { if (els.importStatus) els.importStatus.textContent = s; };
  els.btnDoImport.disabled = true;
  els.importResult.hidden = true;

  try {
    setStatus('读取文件…');
    const payload = {
      audioName: audioFile.name,
      audioBase64: await readFileBase64(audioFile),
      title: els.importTitle?.value?.trim() || '',
      exam: els.importExam?.value || 'other',
      transcript: null,
      explain: null,
      questions: null,
    };

    if (els.fileTranscript?.files?.[0]) {
      setStatus('读取原文…');
      payload.transcript = await readFileText(els.fileTranscript.files[0]);
    }
    if (els.fileExplain?.files?.[0]) {
      setStatus('读取解析…');
      payload.explain = await readFileText(els.fileExplain.files[0]);
    }
    if (els.fileQuestions?.files?.[0]) {
      setStatus('读取原题…');
      payload.questions = await readFileText(els.fileQuestions.files[0]);
    }

    setStatus('上传到本地服务…');
    const res = await fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));

    setStatus('');
    showImportResult(data);
    await loadLibrary(true);
    if (data.lessonId) selectLesson(data.lessonId);
    toast('导入成功');
  } catch (err) {
    setStatus('');
    els.importResult.hidden = false;
    els.importResult.textContent = '导入失败：' + err.message;
  } finally {
    els.btnDoImport.disabled = false;
  }
});

/** 导入成功后展示后续步骤（含给大模型做解析的提示词） */
function showImportResult(data) {
  const box = els.importResult;
  box.hidden = false;
  box.textContent = '';

  const lines = [];
  lines.push(`✅ 已导入：${data.title}`);
  lines.push(`   课程 id：${data.lessonId}`);
  lines.push('');

  if (data.transcriptGenerated) {
    lines.push('⚠️ 你没有提供原文，系统已用 Whisper 自动转写并生成时间轴。');
    lines.push('   机器转写可能有错字，界面上会标「🎙 Whisper 转写」。');
    lines.push('');
  }
  if (data.needsTranscription) {
    lines.push('⚠️ 未提供原文，且本地转写服务未启用。');
    lines.push('   请在项目目录执行（本机已装好 GPU 加速）：');
    lines.push(`   python tools/transcribe.py --audio "${data.audioPath}" --out "transcripts/${data.base}.tsv"`);
    lines.push('   node tools/ielts-integrate.js');
    lines.push('');
  }

  lines.push('── 需要逐题解析？把下面这段提示词连同原文一起发给大模型 ──');
  lines.push('');
  lines.push('你是雅思听力老师。下面给你一套听力试题的原文与题目。请：');
  lines.push('1) 逐题给出正确答案，并说明依据的原文句子；');
  lines.push('2) 指出该题的干扰项为什么错；');
  lines.push('3) 标注答案在原文中的位置（引用原句）；');
  lines.push('4) 提炼本题涉及的生词与同义替换（这是雅思听力的核心考点）。');
  lines.push('');
  lines.push('输出格式为 JSON 数组，每项形如：');
  lines.push('{"number":1,"answer":"...","explain":"...","transcript":"答案依据的原句"}');
  lines.push('');
  lines.push('【听力原文】');
  lines.push('（点右上角「原文」→「下载原文」拿到全文，粘贴到这里）');
  lines.push('');
  lines.push('【题目】');
  lines.push('（把原题粘贴到这里，或直接上传原题 PDF）');
  lines.push('');
  lines.push('拿到大模型返回的 JSON 后，保存为同名 .questions.json 放回课程目录即可。');

  box.textContent = lines.join('\n');
}

// ------------------------------------------------------------ 设置（个性化 + 习惯记忆）
//
// 统一存 localStorage：
//   · 外观：自定义背景图 / 预设背景 / 暗化 / 模糊 / 面板透明度 / 主题色 / 原文字号
//   · 习惯：倍速、显示模式、自动滚动、听写模式、复读模式（下次打开还是这套）
// 背景图在本地用 canvas 压到 1920×1200 再存 data URL，
// 既省空间（一般几百 KB），也保证不会撑爆 localStorage 的 5 MB 配额。

const SETTINGS_KEY = 'listening-player.settings.v1';
const PROGRESS_KEY = 'listening-player.progress.v1';

const BG_PRESETS = [
  { id: '', name: '默认', css: '' },
  { id: 'aurora', name: '极光', css: 'linear-gradient(160deg,#0b1e3a 0%,#123a4d 45%,#0d2b2b 100%)' },
  { id: 'ocean', name: '深海', css: 'linear-gradient(160deg,#07131f 0%,#0f2a3d 50%,#060e16 100%)' },
  { id: 'forest', name: '森林', css: 'linear-gradient(160deg,#0d2117 0%,#14382a 50%,#0a1c16 100%)' },
  { id: 'sunset', name: '暮色', css: 'linear-gradient(160deg,#2a1430 0%,#4a1f36 50%,#1b1024 100%)' },
  { id: 'paper', name: '暖纸', css: 'linear-gradient(160deg,#241d16 0%,#3a2c1f 50%,#1c1610 100%)' },
];

const ACCENTS = [
  { id: 'green', name: '森林绿', accent: '#4ade80', dim: '#1f6b3f', soft: 'rgba(74,222,128,.12)' },
  { id: 'blue', name: '深海蓝', accent: '#60a5fa', dim: '#1e4f8f', soft: 'rgba(96,165,250,.14)' },
  { id: 'amber', name: '暖阳橙', accent: '#fbbf24', dim: '#8a6410', soft: 'rgba(251,191,36,.14)' },
  { id: 'rose', name: '樱花粉', accent: '#fb7185', dim: '#8f2d43', soft: 'rgba(251,113,133,.14)' },
  { id: 'violet', name: '紫罗兰', accent: '#a78bfa', dim: '#5b3fa8', soft: 'rgba(167,139,250,.14)' },
];

const DEFAULT_SETTINGS = {
  // 面板透明度默认 65%：既能看见自己的背景图，又不影响读字（可以在设置里调）
  bgPreset: '', bgImage: '', bgDim: 45, bgBlur: 6, panelAlpha: 65,
  accent: 'green', lyricSize: 17,
  autoResume: true, saveProgress: true,
  mode: 'exam',            // exam=实战（先作答）｜listen=练耳朵（不答题，直接看原文）
  speed: '1', displayMode: 'both', follow: true, repeat: 'off', blur: false,
};

let settings = { ...DEFAULT_SETTINGS };
try {
  const raw = localStorage.getItem(SETTINGS_KEY);
  if (raw) settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
} catch { /* 存储不可用就用默认值 */ }

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (err) {
    toast('设置没能保存：' + (err && err.name === 'QuotaExceededError'
      ? '本地存储满了，换张小一点的背景图试试' : err.message));
  }
}

/** 把外观设置写到 CSS 变量上（背景层 + 主题色 + 字号 + 面板透明度） */
function applyAppearance() {
  const root = document.documentElement;
  const preset = BG_PRESETS.find((p) => p.id === settings.bgPreset && p.css);
  const image = settings.bgImage || (preset ? preset.css : '');

  if (els.bgLayer) {
    els.bgLayer.hidden = !image;
    els.bgLayer.style.backgroundImage = image
      ? (settings.bgImage ? `url("${settings.bgImage}")` : image)
      : '';
  }
  document.body.classList.toggle('has-bg', !!image);

  root.style.setProperty('--bg-dim', (Number(settings.bgDim) / 100).toFixed(2));
  root.style.setProperty('--bg-blur', Number(settings.bgBlur) + 'px');
  root.style.setProperty('--panel-alpha', (Number(settings.panelAlpha) / 100).toFixed(2));
  root.style.setProperty('--lyric-size', Number(settings.lyricSize) + 'px');

  const a = ACCENTS.find((x) => x.id === settings.accent) || ACCENTS[0];
  root.style.setProperty('--accent', a.accent);
  root.style.setProperty('--accent-dim', a.dim);
  root.style.setProperty('--accent-soft', a.soft);
}

/** 把「播放习惯」恢复到界面上（打开就是上次那套） */
function applyPlaybackPrefs() {
  if (els.speed) { els.speed.value = settings.speed; audio.playbackRate = Number(settings.speed) || 1; }
  if (els.displayMode) els.displayMode.value = settings.displayMode;
  if (els.repeatMode) {
    // A-B 需要先划区间，重启后无处可循 → 只恢复「当前句循环」
    els.repeatMode.value = settings.repeat === 'line' ? 'line' : 'off';
    state.repeat = els.repeatMode.value;
  }
  state.follow = settings.follow !== false;
  if (els.follow) {
    els.follow.textContent = '自动滚动：' + (state.follow ? '开' : '关');
    els.follow.classList.toggle('off', !state.follow);
  }
  state.blur = !!settings.blur;
  if (els.lyrics) els.lyrics.classList.toggle('blur-mode', state.blur);
  const blurBtn = $('btnBlur');
  if (blurBtn) {
    blurBtn.classList.toggle('on', state.blur);
    blurBtn.textContent = state.blur ? '听写模式：开' : '听写模式';
  }
  applyDisplayMode();
}

// ------------------------------------------------------------ 学习记录（人性化）
//
// 每门课记：听到哪儿（pos/dur）、正确率（right/total/pct）、打开次数与最后时间。
// 用途：课程列表上直接看到「正确率 75% / 上次 12:34」，打开 App 能接着上次听。

let progress = {};
try {
  const raw = localStorage.getItem(PROGRESS_KEY);
  if (raw) progress = JSON.parse(raw) || {};
} catch { progress = {}; }

let progressTimer = null;

function progressOf(id) {
  return id ? (progress[id] || null) : null;
}

function saveProgressNow() {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  } catch { /* 存不下就算了，不影响播放 */ }
}

/** 写记录（3 秒合并一次，避免每 250ms 的定时器把 localStorage 写爆） */
function touchProgress(id, patch) {
  if (!settings.saveProgress || !id) return;
  const p = progress[id] || (progress[id] = {});
  Object.assign(p, patch, { at: Date.now() });
  clearTimeout(progressTimer);
  progressTimer = setTimeout(saveProgressNow, 3000);
}

function recordPosition(id, pos, dur) {
  if (!id || !Number.isFinite(pos)) return;
  touchProgress(id, { pos: Math.max(0, Math.round(pos)), dur: Math.round(dur || 0) });
}

function recordScore(id, right, total) {
  if (!id || !total) return;
  touchProgress(id, {
    right, total,
    pct: Math.round((right / total) * 100),
    attempts: (progressOf(id)?.attempts || 0) + 1,
  });
  saveProgressNow();
}

function recordOpen(id) {
  if (!id) return;
  touchProgress(id, {
    opened: (progressOf(id)?.opened || 0) + 1,
    last: Date.now(),
    title: state.lesson?.manifest?.title || '',
  });
}

/** 有没有可以续听的位置 */
function readResume() {
  const id = state.lesson?.manifest?.id;
  if (!id || !settings.saveProgress) return null;
  const p = progressOf(id);
  if (!p || !p.pos || p.pos < 15) return null;
  const dur = audio.duration || state.lesson?.manifest?.duration || p.dur || 0;
  if (dur && p.pos > dur - 15) return null;      // 已经听到结尾了，不用续
  return { id, pos: p.pos };
}

function updateResumeBar() {
  if (!els.resumeBar) return;
  const r = readResume();
  if (!r) { els.resumeBar.hidden = true; return; }
  els.resumeBar.hidden = false;
  els.resumeBar.innerHTML = `上次听到 <b>${fmtTime(r.pos)}</b>
    <button class="ghost-btn" data-resume-go>继续听</button>
    <button class="ghost-btn" data-resume-zero>从头开始</button>`;
  // 用 data-* 而不是 id：这个条子是动态生成的，用 id 会让「JS 引用的 id 必须在 HTML 里」
  // 那条静态检查误报（那个检查对静态 DOM 很有用，值得留着）
  els.resumeBar.querySelector('[data-resume-go]')?.addEventListener('click', () => applyResume(false));
  els.resumeBar.querySelector('[data-resume-zero]')?.addEventListener('click', () => {
    audio.currentTime = 0;
    recordPosition(state.lesson?.manifest?.id, 0, audio.duration);
    els.resumeBar.hidden = true;
    toast('从头开始');
  });
}

function applyResume(silent) {
  const r = readResume();
  if (!r) return false;
  audio.currentTime = r.pos;
  if (els.resumeBar) els.resumeBar.hidden = true;
  if (!silent) toast('继续听：' + fmtTime(r.pos));
  return true;
}

// ------------------------------------------------------------ 睡眠定时（人性化）
//
// 睡前听听力用：到点自动暂停。也可以选「播完本课」。

let sleepTimerId = null;
let sleepEndAt = 0;
let sleepMode = '0';

function setSleepTimer(mode) {
  clearTimeout(sleepTimerId);
  sleepTimerId = null;
  sleepEndAt = 0;
  sleepMode = String(mode);
  settings.sleepMinutes = sleepMode;
  saveSettings();

  if (sleepMode === '0') {
    if (els.sleepLeft) els.sleepLeft.textContent = '';
    return;
  }
  if (sleepMode === '-1') {
    if (els.sleepLeft) els.sleepLeft.textContent = '播完本课停止';
    toast('本课播完会自动暂停');
    return;
  }
  const ms = Number(sleepMode) * 60000;
  sleepEndAt = Date.now() + ms;
  sleepTimerId = setTimeout(() => {
    audio.pause();
    if (els.sleepLeft) els.sleepLeft.textContent = '';
    toast('定时到点，已暂停');
  }, ms);
  updateSleepLeft();
}

function updateSleepLeft() {
  if (!els.sleepLeft) return;
  if (sleepMode === '-1') { els.sleepLeft.textContent = '播完本课停止'; return; }
  if (!sleepEndAt) { els.sleepLeft.textContent = ''; return; }
  const left = Math.max(0, sleepEndAt - Date.now());
  els.sleepLeft.textContent = fmtTime(Math.ceil(left / 1000)) + ' 后暂停';
}

// ------------------------------------------------------------ 设置面板

function renderSettingsPanel() {
  if (!els.settingsDrawer) return;

  // 背景预设
  if (els.bgPresets) {
    els.bgPresets.innerHTML = BG_PRESETS.map((p) => `
      <div class="bg-preset ${p.id ? '' : 'none'} ${!settings.bgImage && settings.bgPreset === p.id ? 'active' : ''}"
           data-preset="${p.id}" title="${escapeHtml(p.name)}"
           style="${p.css && !settings.bgImage ? `background-image:${p.css}` : ''}"></div>`).join('');
    els.bgPresets.querySelectorAll('[data-preset]').forEach((el) => {
      el.addEventListener('click', () => {
        settings.bgPreset = el.dataset.preset;
        settings.bgImage = '';          // 选预设就放弃自定义图
        saveSettings();
        applyAppearance();
        renderSettingsPanel();
      });
    });
  }

  // 主题色
  if (els.accentChips) {
    els.accentChips.innerHTML = ACCENTS.map((a) => `
      <button class="accent-chip ${settings.accent === a.id ? 'active' : ''}"
              data-accent="${a.id}" title="${escapeHtml(a.name)}"
              style="background:${a.accent}"></button>`).join('');
    els.accentChips.querySelectorAll('[data-accent]').forEach((el) => {
      el.addEventListener('click', () => {
        settings.accent = el.dataset.accent;
        saveSettings();
        applyAppearance();
        renderSettingsPanel();
      });
    });
  }

  const bind = (input, label, key, suffix) => {
    if (!input) return;
    input.value = settings[key];
    if (label) label.textContent = settings[key] + suffix;
    input.oninput = () => {
      settings[key] = Number(input.value);
      if (label) label.textContent = input.value + suffix;
      applyAppearance();
      saveSettings();
    };
  };
  bind(els.bgDim, els.bgDimVal, 'bgDim', '%');
  bind(els.bgBlur, els.bgBlurVal, 'bgBlur', 'px');
  bind(els.panelAlpha, els.panelAlphaVal, 'panelAlpha', '%');
  bind(els.lyricSize, els.lyricSizeVal, 'lyricSize', 'px');

  if (els.optAutoResume) {
    els.optAutoResume.checked = !!settings.autoResume;
    els.optAutoResume.onchange = () => {
      settings.autoResume = els.optAutoResume.checked;
      saveSettings();
    };
  }
  if (els.optSaveProgress) {
    els.optSaveProgress.checked = !!settings.saveProgress;
    els.optSaveProgress.onchange = () => {
      settings.saveProgress = els.optSaveProgress.checked;
      saveSettings();
      renderLessonList();
      renderSettingsPanel();
    };
  }

  if (els.progressSummary) {
    const ids = Object.keys(progress);
    const scored = ids.filter((k) => progress[k].total);
    const avg = scored.length
      ? Math.round(scored.reduce((n, k) => n + (progress[k].pct || 0), 0) / scored.length)
      : 0;
    els.progressSummary.textContent = ids.length
      ? `已记录 ${ids.length} 门课${scored.length ? `，其中 ${scored.length} 门做过题（平均正确率 ${avg}%）` : ''}。`
      : '还没有学习记录。做过题、听过一段就会自动记下来。';
  }
}

els.btnSettings?.addEventListener('click', () => {
  els.settingsDrawer.hidden = false;
  renderSettingsPanel();
});
els.btnCloseSettings?.addEventListener('click', () => { els.settingsDrawer.hidden = true; });
els.settingsDrawer?.addEventListener('click', (e) => {
  if (e.target === els.settingsDrawer) els.settingsDrawer.hidden = true;
});

// ------------------------------------------------------------ 问题反馈（仓库 Issues）

/** 反馈时一并带上的环境信息：定位问题基本就靠这几行，且不含任何个人信息 */
function feedbackInfo() {
  const narrow = isNarrow();
  const id = state.lesson?.manifest?.id || '(还没选课程)';
  return [
    `Whale Lite v${APP_VERSION}`,
    `反馈地址：${FEEDBACK_URL}`,
    `屏幕：${window.innerWidth}×${window.innerHeight} CSS px @${window.devicePixelRatio}x`
      + `（物理 ${screen.width}×${screen.height}，${narrow ? '窄屏/竖屏布局' : '宽屏布局'}）`,
    `当前课程：${id}`,
    `模式：${isListenMode() ? '练耳朵' : '实战'} · 题目面板：${state.qpanelOpen ? '展开' : '收起'}`,
    `环境：${navigator.userAgent}`,
  ].join('\n');
}

/**
 * 复制文本。
 * ⚠️ WebView（file:// 页面）里 `navigator.clipboard.writeText` 经常被拒
 * （实测报 `NotAllowedError: Document is not focused`），所以必须留一条老路子：
 * 临时 textarea + `document.execCommand('copy')`。
 * 而且**要检查 execCommand 的返回值** —— 它不抛异常不代表复制成功了，
 * 直接报「已复制」会骗用户（发过来的反馈信息是空的，白折腾一轮）。
 */
async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg);
    return true;
  } catch { /* 落到 execCommand */ }

  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  // 放在视口内但看不见：某些 WebView 对 left:-9999px 的元素拒绝 select()
  ta.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;border:0;padding:0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();

  if (ok) { toast(okMsg); return true; }
  toast('这台设备不让自动复制，请长按选中上面的号码手动复制');
  return false;
}

els.btnCopyFeedback?.addEventListener('click', () => {
  copyText(feedbackInfo(), '反馈信息已复制，粘到 issue 里即可');
});
// 「更多 ▾」里的「问题反馈」：打开设置面板并滚到反馈那一节
els.btnFeedback?.addEventListener('click', () => {
  if (!els.settingsDrawer) return;
  els.settingsDrawer.hidden = false;
  renderSettingsPanel();
  setTimeout(() => els.feedbackSection?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 60);
});

els.btnResetSettings?.addEventListener('click', () => {
  settings = { ...DEFAULT_SETTINGS };
  saveSettings();
  applyAppearance();
  applyPlaybackPrefs();
  setSleepTimer('0');
  if (els.sleepTimer) els.sleepTimer.value = '0';
  renderSettingsPanel();
  toast('已恢复默认外观与习惯');
});

/** 把用户选的图片缩到合适大小再存（localStorage 只有 5 MB） */
function readImageAsBackground(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const maxW = 1920;
        const maxH = 1200;
        const scale = Math.min(1, maxW / img.width, maxH / img.height);
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const cv = document.createElement('canvas');
        cv.width = w;
        cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(cv.toDataURL('image/jpeg', 0.82));
      } catch (err) {
        reject(err);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('这张图读不出来')); };
    img.src = url;
  });
}

els.fileBg?.addEventListener('change', async () => {
  const file = els.fileBg.files?.[0];
  if (!file) return;
  try {
    const dataUrl = await readImageAsBackground(file);
    settings.bgImage = dataUrl;
    settings.bgPreset = '';
    saveSettings();
    applyAppearance();
    renderSettingsPanel();
    toast(`背景已换（${Math.round(dataUrl.length / 1024)} KB）`);
  } catch (err) {
    toast('换背景失败：' + err.message);
  } finally {
    if (els.fileBg) els.fileBg.value = '';
  }
});

els.btnExportProgress?.addEventListener('click', () => {
  const payload = {
    exportedAt: new Date().toISOString(),
    note: 'Whale Lite 学习记录。含每门课的正确率与听到的位置，以及外观设置（背景图不导出）。',
    settings: { ...settings, bgImage: settings.bgImage ? '(已省略图片数据)' : '' },
    progress,
  };
  downloadText(JSON.stringify(payload, null, 2), 'Whale Lite-学习记录.json');
  toast('学习记录已导出');
});

els.btnClearProgress?.addEventListener('click', () => {
  if (!confirm('清空所有学习记录（正确率与播放位置）？此操作不可撤销。')) return;
  progress = {};
  saveProgressNow();
  renderLessonList();
  renderSettingsPanel();
  updateResumeBar();
  toast('学习记录已清空');
});

// ------------------------------------------------------------ 响应式布局（窄屏 / 竖屏 / 转屏）

/**
 * 题目面板**唯一**的开关。
 *
 * 这个项目以前有两个类在抢同一块面板：
 *   · `.no-qpanel`        —— 顶栏「题目」按钮 / Q 快捷键 / 练耳朵模式在用
 *   · `.mobile-qpanel-open` —— 右下角浮动 📝 / 遮罩 / 批改后自动展开在用
 * 宽屏下两者恰好互不干扰，所以一直没暴露；**窄屏下就出事了**：
 * 点顶栏「题目」把 `.no-qpanel` 去掉之后，面板变成 `display:flex` 但
 * `transform: translateX(102%)` 还停在屏幕外 —— 用户看到的现象就是
 * 「题目收起来之后再也打不开」。
 *
 * 现在只认 `state.qpanelOpen`，两种布局由 CSS 分别表现（见 style.css 的 860px 段）。
 */
function setQPanel(open, opts) {
  if (opts && opts.onlyIfNarrow && !isNarrow()) return;
  state.qpanelOpen = !!open;
  els.app.classList.toggle('no-qpanel', !state.qpanelOpen);
  els.btnToggleQuestions?.classList.toggle('on', state.qpanelOpen);
  els.btnMobileQpanel?.classList.toggle('on', state.qpanelOpen);
  els.btnMobileQpanel?.setAttribute('aria-pressed', state.qpanelOpen ? 'true' : 'false');
}
function toggleQPanel() {
  setQPanel(!state.qpanelOpen);
}

/**
 * 顶栏按钮的归属：窄屏时把次要按钮搬进「更多 ▾」，保证**没有任何按钮被挤出屏幕**。
 * 搬的是真节点（不是复制），所以事件监听、状态都跟着走；回到宽屏再搬回去。
 */
const TOPBAR_WIDE = ['modeSwitch', 'btnPaper', 'btnToggleQuestions', 'btnRaw', 'moreMenu', 'btnSettings'];
const TOPBAR_NARROW = ['modeSwitch', 'btnToggleQuestions', 'moreMenu', 'btnSettings'];
const MOREPOP_WIDE = ['btnEdit', 'btnImport', 'btnPacks', 'btnFeedback'];
const MOREPOP_NARROW = ['btnPaper', 'btnRaw', 'btnEdit', 'btnImport', 'btnPacks', 'btnFeedback'];

function layoutTopbar(narrow) {
  const bar = document.querySelector('.topbar-actions');
  const pop = els.morePop;
  if (!bar || !pop) return;
  const strip = narrow ? TOPBAR_NARROW : TOPBAR_WIDE;
  const menu = narrow ? MOREPOP_NARROW : MOREPOP_WIDE;
  strip.forEach((id) => { const el = $(id); if (el) bar.appendChild(el); });
  menu.forEach((id) => { const el = $(id); if (el) pop.appendChild(el); });
  // 宽屏时「更多」里只剩素材整理三项，按钮就够了；窄屏装 6 项，加个分组标题更清楚
  let head = pop.querySelector('.more-pop-head');
  if (narrow) {
    if (!head) {
      head = document.createElement('div');
      head.className = 'more-pop-head';
      pop.insertBefore(head, pop.firstChild);
    }
    head.textContent = '查看与整理';
  } else if (head) {
    head.remove();
  }
}

/** 原文区的上下留白跟着**滚动区高度**走，横屏手机上才不会把正文挤出可视区 */
function syncLyricPad() {
  const wrap = els.lyricsWrap;
  if (!wrap || !els.lyrics) return;
  const h = wrap.clientHeight;
  if (!h) return;
  els.lyrics.style.setProperty('--lyric-pad-top', Math.round(h * 0.40) + 'px');
  els.lyrics.style.setProperty('--lyric-pad-bottom', Math.round(h * 0.50) + 'px');
}

/** 浮动开关停在播放器上方：竖屏播放器会换行成两三行，写死 bottom 必然压住按钮 */
function syncPlayerHeight() {
  const player = document.querySelector('.player');
  if (!player) return;
  const h = Math.round(player.getBoundingClientRect().height);
  document.documentElement.style.setProperty('--player-h', h + 'px');
}

/**
 * 跨过断点或转屏时调用。
 * 转屏重置成该宽度下的默认状态（手机竖屏＝抽屉收起，宽屏/平板＝并排展开），
 * 否则从横屏转回竖屏会留下一个「第三栏式」的布局，交互全是错位的。
 */
function syncResponsive(force) {
  const narrow = isNarrow();
  if (force || narrow !== state.wasNarrow) {
    state.wasNarrow = narrow;
    els.app.classList.remove('mobile-sidebar-open');
    layoutTopbar(narrow);
    setQPanel(narrow ? false : !isListenMode());
  }
  syncLyricPad();
  syncPlayerHeight();
}

window.addEventListener('resize', () => syncResponsive(false));
window.addEventListener('orientationchange', () => {
  // 转屏后 WebView 的尺寸不是立刻更新的，等一拍再量
  setTimeout(() => syncResponsive(true), 260);
});

// ------------------------------------------------------------ 移动端抽屉

els.btnMobileSidebar?.addEventListener('click', () => {
  const willOpen = !els.app.classList.contains('mobile-sidebar-open');
  els.app.classList.toggle('mobile-sidebar-open', willOpen);
  els.btnMobileSidebar.classList.toggle('on', willOpen);
  if (willOpen) setQPanel(false);      // 两个抽屉不同时开，否则遮罩点一下关哪个都别扭
});
els.btnMobileQpanel?.addEventListener('click', () => {
  els.app.classList.remove('mobile-sidebar-open');
  els.btnMobileSidebar?.classList.remove('on');
  toggleQPanel();
});
els.btnCloseQpanel?.addEventListener('click', () => setQPanel(false));
els.sheetBackdrop?.addEventListener('click', () => {
  els.app.classList.remove('mobile-sidebar-open');
  els.btnMobileSidebar?.classList.remove('on');
  setQPanel(false);
});
// 点「更多」菜单里的东西之后把菜单收起来（菜单本身在 .moreMenu 里，
// 外面那层「点空白处关闭」的监听不会触发）
els.morePop?.addEventListener('click', (e) => {
  if (e.target.closest('button')) setTimeout(closeMoreMenu, 0);
});

// ============================================================ 原有事件绑定

els.play.addEventListener('click', () => {
  if (audio.paused) audio.play().catch((e) => toast('播放失败：' + e.message));
  else audio.pause();
});

audio.addEventListener('play', () => {
  syncPlayButton();
  reportPlayback(true);
});
audio.addEventListener('pause', () => {
  syncPlayButton();
  reportPlayback(true);
  recordPosition(state.lesson?.manifest?.id, audio.currentTime, audio.duration);
  saveProgressNow();
});
audio.addEventListener('ended', () => {
  syncPlayButton();
  reportPlayback(true);
  recordPosition(state.lesson?.manifest?.id, audio.duration, audio.duration);
  saveProgressNow();
  // 「播完本课」的睡眠定时
  if (sleepMode === '-1') {
    if (els.sleepLeft) els.sleepLeft.textContent = '';
    setSleepTimer('0');
    if (els.sleepTimer) els.sleepTimer.value = '0';
    toast('本课已播完，已停止');
  }
});
audio.addEventListener('error', () => {
  if (!audio.src) return;
  const code = audio.error ? audio.error.code : 0;
  const why = code === 1 ? '播放被中止' : code === 2 ? '读取音频出错' : code === 3 ? '音频解码失败' : '音频不可用';
  toast('音频加载失败（' + why + '），请检查文件是否存在或格式是否被支持。');
});
audio.addEventListener('stalled', () => {
  // 交给 watchStall 处理；这里只提示一次，避免刷屏
  if (!audio.paused && Date.now() - lastProgressAt > 5000) toast('网络/存储读取变慢，正在等待…');
});
audio.addEventListener('loadedmetadata', () => {
  els.timeTotal.textContent = fmtTime(audio.duration);
  cacheDuration(audio.duration);
  reportPlayback(true);
  lastProgressTime = -1;      // 换源后重置卡顿判定
  lastProgressAt = 0;
  stallRecoveries = 0;
});

/**
 * 用户自己导入的音频通常没有 .meta.json，时长未知。
 * 浏览器解出 metadata 后回写一份 .duration 缓存，
 * 这样课程列表下次一打开就能直接显示时长，不必等音频加载。
 */
let durationPosted = new Set();
function cacheDuration(dur) {
  const id = state.lesson?.manifest?.id;
  if (!id || !Number.isFinite(dur) || dur <= 0) return;
  if (Number(state.lesson.manifest.duration) > 0) return;   // 已知时长就不用写
  if (durationPosted.has(id)) return;
  durationPosted.add(id);

  // 离线模式没有服务可写，只在内存里记住
  if (DATA_SOURCE.mode !== 'http') {
    state.lesson.manifest.duration = dur;
    const item = state.lessons.find((l) => l.id === id);
    if (item) item.duration = dur;
    return;
  }

  fetch('/api/duration', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, duration: dur }),
  }).then((r) => {
    if (r.ok) {
      state.lesson.manifest.duration = dur;
      const item = state.lessons.find((l) => l.id === id);
      if (item) item.duration = dur;
    }
  }).catch(() => { /* 缓存失败不影响播放 */ });
}

// 进度条拖动
//
// ⚠️ 为什么改成「拖动中只预览、松手才真跳」：
//    以前每来一次 mousemove 就写一次 audio.currentTime，一条进度条能被拖出几十次 seek，
//    WebView 的媒体栈在这样连续 seek（每次都重新发 Range 请求）时容易卡住 ——
//    表现就是「拖完进度条声音没了」，而播放器状态还停在播放中，按钮也就没变回 ▶。
//    现在拖动期间只更新画面上的预览气泡，松手才 seek 一次；并且记录拖动前是否在播放，
//    松手后如果它自己停住了，自动接着播。
let dragging = false;
let dragWasPlaying = false;

function ratioFromEvent(ev) {
  const rect = els.progress.getBoundingClientRect();
  const clientX = ev.touches && ev.touches[0] ? ev.touches[0].clientX
    : (ev.changedTouches && ev.changedTouches[0] ? ev.changedTouches[0].clientX : ev.clientX);
  return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
}

function durationNow() {
  return audio.duration || state.lesson?.manifest?.duration || 0;
}

/** 拖动中的预览：只动画面，不动播放位置 */
function previewSeek(ev) {
  const d = durationNow();
  if (!(d > 0)) return;
  const target = ratioFromEvent(ev) * d;
  els.played.style.width = (ratioFromEvent(ev) * 100) + '%';
  els.thumb.style.left = (ratioFromEvent(ev) * 100) + '%';
  els.timeNow.textContent = fmtTime(target);
  if (els.seekBubble) {
    els.seekBubble.hidden = false;
    els.seekBubble.textContent = fmtTime(target);
    els.seekBubble.style.left = (ratioFromEvent(ev) * 100) + '%';
  }
}

/** 松手：真正跳一次，并在需要时把播放接上 */
function commitSeek(ev) {
  const d = durationNow();
  if (els.seekBubble) els.seekBubble.hidden = true;
  if (!(d > 0)) return;
  const target = ratioFromEvent(ev) * d;
  audio.currentTime = target;
  if (dragWasPlaying) resumeAfterSeek();
  dragging = false;
}

/**
 * 跳转后如果播放没接上，就自己接回去。
 * 只在「跳转前本来在放」时才自动续播，避免用户主动暂停后又被强行播起来。
 */
function resumeAfterSeek() {
  const wantFrom = audio.currentTime;
  setTimeout(() => {
    if (!audio.paused) return;                      // 还在放，不用管
    if (audio.ended) return;                        // 本来就是放完了
    if (Math.abs(audio.currentTime - wantFrom) > 30) return;  // 用户又手动跳走了
    const p = audio.play();
    if (p && p.catch) p.catch(() => { /* 交给卡顿看门狗 */ });
    toast('已从 ' + fmtTime(audio.currentTime) + ' 继续播放');
  }, 350);
}

function beginDrag(ev) {
  dragging = true;
  dragWasPlaying = !audio.paused;
  previewSeek(ev);
}

els.progress.addEventListener('mousedown', (e) => { e.preventDefault(); beginDrag(e); });
window.addEventListener('mousemove', (e) => { if (dragging) previewSeek(e); });
window.addEventListener('mouseup', (e) => { if (dragging) commitSeek(e); });
// 触摸：以前只监听了 touchstart（一点就跳、拖动时反而没反应），现在拖到哪预览到哪
els.progress.addEventListener('touchstart', (e) => { e.preventDefault(); beginDrag(e); }, { passive: false });
els.progress.addEventListener('touchmove', (e) => { if (dragging) { e.preventDefault(); previewSeek(e); } }, { passive: false });
els.progress.addEventListener('touchend', (e) => { if (dragging) commitSeek(e); });
els.progress.addEventListener('touchcancel', () => {
  dragging = false;
  if (els.seekBubble) els.seekBubble.hidden = true;
});

// 倍速
els.speed.addEventListener('change', () => {
  audio.playbackRate = Number(els.speed.value);
  settings.speed = els.speed.value;      // 记住，下次打开还是这个速度
  saveSettings();
  toast('播放速度 ' + els.speed.value + '×');
});

// 复读模式
els.repeatMode.addEventListener('change', () => {
  state.repeat = els.repeatMode.value;
  settings.repeat = state.repeat;
  saveSettings();
  if (state.repeat === 'ab' && (state.ab.a == null || state.ab.b == null)) {
    toast('请先点「设 A」「设 B」划定区间');
  }
});

// 循环区间：起点 / 终点 / 清除（按钮文案与提示统一用「循环起点、循环终点」的说法）
$('btnSetA').addEventListener('click', () => {
  state.ab.a = audio.currentTime;
  if (state.ab.b != null && state.ab.b <= state.ab.a) state.ab.b = null;
  updateLoopUI();
  toast('循环起点：' + fmtTime(state.ab.a) + (state.ab.b == null ? '　再设一个终点就能循环这一段' : ''));
});
$('btnSetB').addEventListener('click', () => {
  if (state.ab.a == null) { toast('请先设置循环起点'); return; }
  if (audio.currentTime <= state.ab.a) { toast('循环终点要在起点之后'); return; }
  state.ab.b = audio.currentTime;
  updateLoopUI();
  els.repeatMode.value = 'ab';
  state.repeat = 'ab';
  settings.repeat = 'ab';
  saveSettings();
  toast(`循环区间已设好：${fmtTime(state.ab.a)} → ${fmtTime(state.ab.b)}`);
});
$('btnClearAB').addEventListener('click', () => {
  clearAB();
  els.repeatMode.value = 'off';
  state.repeat = 'off';
  settings.repeat = 'off';
  saveSettings();
  toast('已清除循环区间');
});

// 上一句 / 下一句
function gotoLine(delta) {
  if (!state.lines.length) return;
  let i = state.activeIndex;
  if (i < 0) i = findLineIndex(audio.currentTime);
  const target = Math.max(0, Math.min(state.lines.length - 1, i + delta));
  audio.currentTime = state.lines[target].time + 0.001;
  setActive(target, true);
}
$('btnPrevLine').addEventListener('click', () => gotoLine(-1));
$('btnNextLine').addEventListener('click', () => gotoLine(1));
$('btnBack5').addEventListener('click', () => { audio.currentTime = Math.max(0, audio.currentTime - 5); });
$('btnFwd5').addEventListener('click', () => { audio.currentTime = Math.min(audio.duration || 1e9, audio.currentTime + 5); });

// 自动滚动
els.follow.addEventListener('click', () => {
  state.follow = !state.follow;
  els.follow.textContent = '自动滚动：' + (state.follow ? '开' : '关');
  els.follow.classList.toggle('off', !state.follow);
  settings.follow = state.follow;
  saveSettings();
  if (state.follow && state.activeIndex >= 0) scrollToLine(state.lineEls[state.activeIndex], true);
});

els.jumpNow.addEventListener('click', () => {
  if (state.activeIndex >= 0) scrollToLine(state.lineEls[state.activeIndex], true);
});

// 用户滚走后显示"回到当前"
els.lyrics.addEventListener('wheel', () => {
  if (state.follow) els.jumpNow.classList.add('show');
}, { passive: true });

// 听写模式
$('btnBlur').addEventListener('click', (e) => {
  state.blur = !state.blur;
  els.lyrics.classList.toggle('blur-mode', state.blur);
  e.currentTarget.classList.toggle('on', state.blur);
  e.currentTarget.textContent = state.blur ? '听写模式：开' : '听写模式';
  settings.blur = state.blur;
  saveSettings();
  toast(state.blur ? '听写模式：先听后看，鼠标悬停可揭示' : '已关闭听写模式');
});

// ------------------------------------------------------------ 模式 / 更多菜单 / 侧栏

/** 「更多」下拉：把素材整理类功能收起来，窄屏上就不会有按钮被挤出屏幕 */
function closeMoreMenu() {
  if (els.morePop) els.morePop.hidden = true;
  if (els.btnMore) els.btnMore.classList.remove('on');
}

function toggleMoreMenu() {
  if (!els.morePop) return;
  const willOpen = els.morePop.hidden;
  els.morePop.hidden = !willOpen;
  els.btnMore?.classList.toggle('on', willOpen);
}

els.btnMore?.addEventListener('click', (e) => { e.stopPropagation(); toggleMoreMenu(); });
document.addEventListener('click', (e) => {
  if (els.moreMenu && !els.moreMenu.contains(e.target)) closeMoreMenu();
});

// 模式切换：实战（先作答）/ 练耳朵（不答题，边听边看原文）
els.modeSwitch?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-mode]');
  if (!btn) return;
  applyModeChoice(btn.dataset.mode);
});

function applyModeChoice(mode) {
  if (mode !== MODE_LISTEN) mode = MODE_EXAM;
  if (settings.mode === mode) return;
  settings.mode = mode;
  saveSettings();
  applyMode();
  toast(mode === MODE_LISTEN
    ? '练耳朵模式：不做题，原文直接跟着音频滚动'
    : '实战模式：先作答，提交后才显示原文与答案');
}

// 侧栏收起后要有一个地方能展开：以前那个按钮在侧栏里面，一收就再也点不到了
function syncSidebarButton() {
  if (!els.btnExpandSidebar) return;
  const collapsed = els.app.classList.contains('sidebar-collapsed');
  els.btnExpandSidebar.hidden = !collapsed;
}
els.btnExpandSidebar?.addEventListener('click', () => {
  els.app.classList.remove('sidebar-collapsed');
  syncSidebarButton();
});

// 题目面板开关：顶栏「题目」与右下角浮动 📝 走同一个函数（以前是两套状态，窄屏下必坏）
$('btnToggleQuestions').addEventListener('click', toggleQPanel);
$('btnSidebar').addEventListener('click', () => {
  els.app.classList.toggle('sidebar-collapsed');
  syncSidebarButton();
});

// 原文抽屉
$('btnRaw').addEventListener('click', () => { els.rawDrawer.hidden = false; });
$('btnCloseRaw').addEventListener('click', () => { els.rawDrawer.hidden = true; });
els.rawDrawer.addEventListener('click', (e) => {
  if (e.target === els.rawDrawer) els.rawDrawer.hidden = true;
});
$('btnCopyRaw').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(els.rawText.textContent);
    toast('原文已复制');
  } catch {
    toast('复制失败，请手动选择文本');
  }
});

// 搜索与筛选
els.search.addEventListener('input', () => {
  state.query = els.search.value;
  renderLessonList();
});
els.examChips.addEventListener('click', (e) => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  els.examChips.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
  btn.classList.add('active');
  state.exam = btn.dataset.exam;
  renderLessonList();
});

// 重新扫描
$('btnReload').addEventListener('click', async () => {
  const currentId = state.lesson?.manifest?.id;
  await loadLibrary(true);
  if (currentId) {
    const still = state.lessons.find((l) => l.id === currentId);
    if (still) selectLesson(currentId);
    else if (state.lessons[0]) selectLesson(state.lessons[0].id);
  }
  toast('已重新扫描：' + state.lessons.length + ' 个课程');
});

// 显示模式：控制中文译文是否显示
els.displayMode.addEventListener('change', () => {
  const onlyOriginal = els.displayMode.value === 'original';
  els.lyrics.classList.toggle('no-translation', onlyOriginal);
  settings.displayMode = els.displayMode.value;
  saveSettings();
  const hasTr = (state.lesson?.translationLines || []).length > 0;
  if (!hasTr) toast('该课程没有中文译文');
  else toast(onlyOriginal ? '仅显示英文原文' : '显示中英对照');
});
// 初始化时同步一次（切课程后保持当前选择）
function applyDisplayMode() {
  els.lyrics.classList.toggle('no-translation', els.displayMode.value === 'original');
}

// 键盘快捷键
window.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return;

  switch (e.key) {
    case ' ':
      e.preventDefault();
      if (audio.paused) audio.play().catch(() => {}); else audio.pause();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      audio.currentTime = Math.max(0, audio.currentTime - 5);
      break;
    case 'ArrowRight':
      e.preventDefault();
      audio.currentTime = Math.min(audio.duration || 1e9, audio.currentTime + 5);
      break;
    case 'ArrowUp':
      e.preventDefault();
      gotoLine(-1);
      break;
    case 'ArrowDown':
      e.preventDefault();
      gotoLine(1);
      break;
    case '[':
      cycleSpeed(-1);
      break;
    case ']':
      cycleSpeed(1);
      break;
    case 'f': case 'F':
      els.follow.click();
      break;
    case 'j': case 'J':
      els.jumpNow.click();
      break;
    case 'b': case 'B':
      $('btnBlur').click();
      break;
    case 'q': case 'Q':
      $('btnToggleQuestions').click();
      break;
    case 'Tab':
      e.preventDefault();
      els.app.classList.toggle('sidebar-collapsed');
      break;
    case '?': case '/':
      e.preventDefault();
      els.btnSettings?.click();       // 快捷键帮助就在设置面板里
      break;
    default:
      break;
  }
});

function cycleSpeed(dir) {
  const opts = [...els.speed.options].map((o) => Number(o.value));
  const cur = Number(els.speed.value);
  let i = opts.indexOf(cur) + dir;
  i = Math.max(0, Math.min(opts.length - 1, i));
  els.speed.value = String(opts[i]);
  audio.playbackRate = opts[i];
  settings.speed = els.speed.value;
  saveSettings();
  toast('播放速度 ' + opts[i] + '×');
}

// ------------------------------------------------------------ 启动

// 外观与习惯要在第一次渲染之前生效，否则会闪一下默认样式
applyAppearance();
applyPlaybackPrefs();
syncSidebarButton();
if (els.modeSwitch) {
  els.modeSwitch.querySelectorAll('[data-mode]').forEach((b) => {
    b.classList.toggle('on', b.dataset.mode === settings.mode);
  });
}
if (isListenMode()) els.app.classList.add('mode-listen');

// 首屏按当前屏幕把布局摆对：窄屏收抽屉 + 次要按钮搬进「更多」，
// 宽屏恢复三栏并把按钮搬回顶栏。转屏 / 拉窗口时 syncResponsive 会再跑。
syncResponsive(true);

loadLibrary(false);
// 补充包清单（随 APK 带）只为面板里显示「未安装」状态，晚一点拿也无妨
loadPackCatalog().then(() => renderPackPanel()).catch(() => {});
rafId = requestAnimationFrame(tick);

// 睡眠定时：记在设置里，切换时立刻生效
if (els.sleepTimer) {
  els.sleepTimer.value = settings.sleepMinutes || '0';
  if (settings.sleepMinutes && settings.sleepMinutes !== '0') setSleepTimer(settings.sleepMinutes);
  els.sleepTimer.addEventListener('change', () => setSleepTimer(els.sleepTimer.value));
}

// 恢复上次的速度设置（applyPlaybackPrefs 已经把设置里的值写回去了）
audio.playbackRate = Number(els.speed.value);

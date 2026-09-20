# 🎧 Whale Lite · Listening Player

> 仓库：<https://github.com/yan-gck/Whale_Lite> · 问题反馈：<https://github.com/yan-gck/Whale_Lite/issues>
>
> 应用显示名：**Whale Lite**。项目目录、包名（`com.dsh.listeningplayer`）、
> 补充包目录等技术标识仍沿用 `listening-player` —— 那些是路径与协议标识，
> 改了会让已装的 App、手机上的补充包目录、文档里的命令全部失效。

四六级 / 雅思 / 托福听力练习播放器。音频播放的同时**原文按时间戳滚动**，支持逐词高亮、单句复读、A-B 区间循环、听写模式，并附带原题与答案面板。

前端为原生 JS，服务端只用 Node 内置模块（仅 PDF 原文抽取用到一个小库）。可打包成 **Android APK** 离线使用。

> ⚠️ **仓库里不带剑桥雅思素材**（音频、转写、以及从 PDF 抽出来的原题与答案都没有上传），
> 原因见 `docs/resources.md` 的版权核查。仓库带的是四六级素材与四套自编演示语料（CC0）。

---

## 一、Windows 上怎么运行

**双击 `启动播放器.bat`。**

它会自动完成：检查 Node.js → 素材为空时生成演示语料 → 启动服务 → 打开浏览器。
地址是 <http://127.0.0.1:4180>，关闭那个黑窗口即停止。

换端口：`启动播放器.bat 4190`

> 唯一前置条件：安装 [Node.js](https://nodejs.org/) 18 或更高版本。

> **为什么 `.bat` 里一个中文都没有？**
> cmd.exe 是按控制台 OEM 代码页逐字节解析批处理文件的。文件里一旦出现非 ASCII 字符，
> 解析器可能丢失位置、把字节流切错，于是执行出
> `'o' 不是内部或外部命令`、`'址：http:' 不是内部或外部命令` 这类莫名其妙的错误。
> 所以三个入口 `.bat` 全部保持纯 ASCII，中文提示由 `tools/launcher.ps1` 打印。

### 下载更多听力素材

**双击 `tools\下载开放资源.bat`**，按提示选择来源。

| 来源 | 内容 | 许可 |
|---|---|---|
| American English（美国国务院） | 30 段日常对话 + 自动抽取的原文 | 公有领域 |
| LibriVox / archive.org | 有声书章节，章级时间轴 | 公有领域 |
| LibriSpeech | 120 句朗读，一句一包，适合听写跟读 | CC BY 4.0 |
| VOA Learning English | 每日节目，新闻英语泛听 | 美国政府公有领域 |

合计约 240 MB。已下载的自动跳过，可随时中断重跑。

命令行方式：

```bash
node tools/fetch-resources.js all          # 全部
node tools/fetch-resources.js list         # 查看来源说明
node tools/fetch-resources.js amenglish    # 只下某一个
```

> 本工具**刻意不包含**四六级/雅思/托福真题音频与 TED。原因见 [docs/resources.md](docs/resources.md)：
> 真题音频版权属考试机构；TED 是 CC BY-NC-ND 且明文禁止抓取与剪辑。

---

## 二、打包成 Android APK

```bash
# 精简版（推荐）：完整前端 + 演示语料，只有 13 MB，随手就能装
node tools/build-apk.js --audio-set=CET4-演示,CET6-演示,IELTS-演示,TOEFL-演示

node tools/build-apk.js --no-audio                        # 瘦身版，只验证流程
node tools/build-apk.js --api=http://192.168.1.10:4180    # 改为连桌面端服务
```

产物落在交付目录 **`F:\DSH workshop\Whale-Lite-手机版\`**（`tools/paths.js` 的 `MOBILE_DIR`，
APK 与 `.lppack` 都放那儿，拷手机最方便），**装好后手机上完全离线可用**。

安装（手机打开 USB 调试后；**一律用 `-r`，卸载会连带删掉手机里的补充包**）：

```bash
"F:\DSH workshop\android-sdk\platform-tools\adb.exe" -s 127.0.0.1:5555 install -r "F:\DSH workshop\Whale-Lite-手机版\listening-player-lite.apk"
```

也可以把 APK 传到手机点击安装（需在系统设置里允许"安装未知来源应用"）。

### 素材装不下？用「补充包」

单个 APK 有 **2 GiB 硬上限**（ZIP 中央目录用 32 位记录大小），而全部素材约 3.0 GB，
装不进一个安装包。所以分两层：

| 产物 | 体积 | 内容 |
|---|---|---|
| `listening-player-lite.apk` | 13 MB | 完整前端 + 5 门演示课（演示音频为 64k MP3） |
| `雅思听力补充包.lppack` | 1.86 GB | 剑桥雅思 72 套（音频/时间轴/译文/题目/原题） |
| `六级听力补充包.lppack` | 856 MB | 六级真题 37 套 |

补充包**不用解压**，App 直接从 ZIP 里按需读取（包括音频的进度条拖动）。
装进手机有两种办法：

```bash
# 打包 + 校验
node tools/build-pack.js --set=IELTS-剑桥真题 --out=雅思听力补充包.lppack
node tools/pack-info.js 雅思听力补充包.lppack --verify

# A. 数据线：直接拷进 App 私有目录（不需要任何权限，也不必解压）
#    /sdcard/Android/data/com.dsh.listeningplayer/files/packs/
# B. 手机 App 内：右上角「补充包」→「导入 .lppack」选择文件（会复制，装好后原件可删）
```

装好后课程列表会立刻出现这些课程（带 📦 徽标），与电脑端内容完全一致：
滚动时间轴、中英对照、题目与答案解析、原题全文都能用。

### 前置条件

- **JDK 17**（提供 `javac` / `keytool`），可用 `JAVA_HOME` 指定
- **Android SDK**，需含 `platforms/android-34` 与 `build-tools/34.0.0`，可用 `ANDROID_HOME` 指定

脚本会在常见位置自动查找 SDK；找不到时按提示安装：

```bash
# 1. 下载命令行工具
#    https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip
#    解压到 <SDK>\cmdline-tools\latest\
# 2. 安装所需组件
sdkmanager --sdk_root=<SDK> "platform-tools" "platforms;android-34" "build-tools;34.0.0"
```

首次构建会自动生成调试签名证书（`android/keystore/debug.keystore`，口令 `android`）。
要发布请换成自己的正式证书。

### 构建原理

为了不引入 Gradle + Android Gradle Plugin（几百 MB 依赖），脚本直接调用 SDK 自带工具链：

```
bundle.json → assets/www → aapt2 compile/link → javac → d8 → ZIP 重打包 → zipalign → apksigner
```

---

## 三、界面与操作

```
┌──────────────┬────────────────────────────────┬──────────────┐
│ 课程库        │ 原文（歌词式滚动，当前行高亮）    │ 题目面板      │
│ 搜索 / 筛选   │ 逐词卡拉OK高亮                  │ 选项 / 解析   │
│              │                                │ 回放片段      │
├──────────────┴────────────────────────────────┴──────────────┤
│ 进度条 · 播放 · 倍速 · 复读 · A-B 循环 · 听写模式              │
└──────────────────────────────────────────────────────────────┘
```

| 操作 | 快捷键 |
|---|---|
| 播放 / 暂停 | `空格` |
| 后退 / 前进 5 秒 | `←` / `→` |
| 上一句 / 下一句 | `↑` / `↓` |
| 降低 / 提高语速 | `[` / `]` |
| 自动滚动开关 | `F` |
| 回到当前播放位置 | `J` |
| 听写模式（隐藏原文） | `B` |
| 显示 / 隐藏题目面板 | `Q` |
| 收起 / 展开课程列表 | `Tab` |
| 打开设置（含快捷键表） | `?` |

其它：**点任意一行原文**即从该句播放；题目里的「▶ 回放片段」只重放该题对应区间；
**拖动进度条**时先出现时间气泡预览、松手才跳转（这样不会把播放拖卡）；
想精听某一段就「设置循环起点」→「设置循环终点」，然后选「循环 A→B 区间」。

### 做题流程（做题 → 提交 → 批改 → 复盘）

1. **做题**：只显示题目与播放器，**原文自动隐藏**（边听边看原文就失去练习意义了）
2. **提交并批改**：没答完会先确认一次；提交后逐题判定对错
3. **正确率**：批改后立刻显示 **正确率百分比**
   - **≥60% 显示绿色**，<60% **显示红色**（顶部流程条 + 题目面板顶部的批改横幅两处都有，
     横幅还给出「答对 / 答错 / 共几题」与下一步建议）
4. **复盘**：显示原文、正确答案与解析；**点「▶ 跳到原文并播放」**可直接听答案所在的那一句

### 两种模式：实战 / 练耳朵

右上角一键切换（会记住）：

- **实战模式**：先听 + 看题（原文自动隐藏）→ 提交批改 → 显示正确率与解析 → 点答案跳到原文那一句
- **练耳朵模式**：不做题。没有作答区、没有提交按钮，**原文直接跟着音频滚动**，
  中英对照一起看；题目面板默认收起（想看时点「题目」，答案直接给），适合通勤磨耳朵

### 后台播放与锁屏保活（Android）

手机上听听力不必一直开着屏幕：

- 按电源键锁屏、切到别的 App、把手机放兜里，**声音都继续放**
- 锁屏与通知栏会出现控制条：显示当前课程名，可**上一句 / 播放暂停 / 下一句 / 停止**（耳机线控同样可用）
- **单句复读与 A-B 循环在锁屏下照常工作** —— 循环逻辑特意没有放在会随页面隐藏而停下的
  `requestAnimationFrame` 里，而是走定时器 + `timeupdate`
- 别的 App 出声（来电、导航、其它播放器）时自动让路，短暂打断结束后自动继续
- 只在播放时保持 CPU 唤醒与屏幕常亮；暂停即释放，暂停 10 分钟后自动收掉通知

实现：前台服务（`PlaybackService`，`foregroundServiceType="mediaPlayback"`）+ `MediaSession`
+ `PARTIAL_WAKE_LOCK`；清单里相应多了 `FOREGROUND_SERVICE`、`FOREGROUND_SERVICE_MEDIA_PLAYBACK`、
`WAKE_LOCK`、`POST_NOTIFICATIONS`（Android 13+ 会弹一次通知授权）。**依旧没有任何存储权限。**

> 个别国产 ROM 的后台策略较激进，若锁屏后仍被杀，把本 App 加进
> 「电池 → 不优化 / 允许后台运行」白名单即可。

### 个性化：换成你自己的背景

右上角「设置」里可以：

- **上传自己的图片当背景**（本机处理：自动缩到 1920×1200 再存，一般几十 KB，不上传任何地方）
- 或用 6 套预设渐变（极光 / 深海 / 森林 / 暮色 / 暖纸 / 无）
- **暗化、模糊、面板透明度**三个滑杆 —— 图片再花也能把字看清
  （读原文的主区会比周围面板再暗一点，保证对比度）
- **5 种主题色**：森林绿 / 深海蓝 / 暖阳橙 / 樱花粉 / 紫罗兰
- **原文字号** 14–30px 可调（手机上默认偏小）

> 批改后的「正确率」绿色是固定的，不跟着主题色变 —— ≥60% 永远显示绿色。

### 人性化的小设计

| 功能 | 说明 |
|---|---|
| **断点续听** | 每门课自动记住听到哪儿，课程列表显示「上次 05:01」；下次打开直接接着放（可在设置里关）。歌词区底部有「继续听 / 从头开始」 |
| **学习记录** | 正确率直接标在课程列表上（≥60 绿 / <60 红），可导出 JSON 备份、也可一键清空 |
| **睡眠定时** | 播放条右侧选 10–60 分钟或「播完本课」，倒计时可见，睡前听不怕放一宿 |
| **习惯记忆** | 倍速、显示模式、自动滚动、听写模式、复读模式、字号、背景、主题色……下次打开还是这套 |
| **快捷键帮助** | 按 `?` 打开设置面板，里面有完整快捷键表 |


---

## 四、导入你自己的听力素材

### 方式一：一条命令（推荐）

```bash
node tools/import.js --audio="D:\听力\2024年6月四级.mp3" \
     --sub="D:\听力\2024年6月四级.srt" \
     --exam=cet4 --year=2024 --paper="2024年6月第1套"
```

`--sub` 支持 `.srt` / `.vtt` / TED 字幕 `.json` / `.tsv`，会自动转成 LRC。
也可用 `--lrc=` 提供现成时间轴，`--text=` 提供完整原文，`--questions=` 提供题目。
不加 `--questions` 会生成一份带示例的题目模板。

### 方式二：手工放文件

在 `audio/` 下（可再建子目录）放一组同名文件，点界面里的「↻ 重新扫描素材」：

| 文件 | 必需 | 说明 |
|---|---|---|
| `<名字>.mp3` | ✅ | 音频，支持 mp3 / wav / m4a / ogg / opus / flac |
| `<名字>.lrc` | ⬜ | 时间轴。**没有它也能播，但歌词不会滚动** |
| `<名字>.questions.json` | ⬜ | 原题 + 答案 + 解析 |
| `<名字>.meta.json` | ⬜ | 标题 / 考试类型 / 来源 / 许可 |
| `<名字>.txt` | ⬜ | 完整原文，供「原文」抽屉显示 |

格式细节见 **[docs/format.md](docs/format.md)**。

---

## 五、工具链

| 工具 | 用途 |
|---|---|
| `tools/fetch-resources.js` | 下载开放许可的听力资源并直接生成资料包 |
| `tools/fetch-manual.js` | 下载「需人工确认」的素材（真题等），带字节数与编码校验 |
| `tools/fetch-cet6-full.js` | 下载全部六级真题（39 个音频 + 原文 + 题干 + 答案） |
| `tools/build-cet6-lessons.js` | 把六级原始素材编译成课程，含上游重复数据的自动检出 |
| `tools/cet6-timings.js` | 下载句级时间戳（含中文译文），按音频字节数配对到课程 |
| `tools/transcribe.py` | **语音转文字**：faster-whisper + GPU，输出带句级时间戳的 TSV |
| `tools/ielts-inventory.js` | 清点雅思素材：识别书号/Test、找重复、列出需合并的 |
| `tools/ielts-unify.js` | 统一雅思素材命名、合并被拆分的 Part、去重 |
| `tools/ielts-integrate.js` | 把转写结果整合进课程并标注 Whisper 来源 |
| `tools/merge_audio.py` | 用 PyAV 真正拼接多个音频为一个 MP3 |
| `tools/import.js` | 把散装素材（音频+字幕+原文+题目）整理成资料包 |
| `tools/lrc-from-srt.js` | SRT / VTT / TED 字幕 JSON / TSV → LRC，支持 `--offset=` 对齐不同源字幕 |
| `tools/calibrate-questions.js` | 用真实时间轴自动校准题目回放片段 |
| `tools/from-cet-timings.js` | 把 `cet-listening` 的 `timings.json`（四六级真题句级时间戳）接进播放器 |
| `tools/parse-qstem.js` | 「题干+选项+答案+原文标记」纯文本 → questions.json |
| `tools/auto-timing.js` | 给「有原文但没时间轴」的包生成**估算**时间轴（会标注为估算） |
| `tools/media-duration.js` | 读取 wav / mp3 / flac / m4a 时长（只读头部，不解码音频） |
| `tools/pdf-text.js` | 从 PDF 抽取文本（正确处理子集化嵌入字体的 ToUnicode 映射） |
| `tools/fix-librivox-text.js` | 用 Project Gutenberg 全文替换 archive.org 的 OCR 残片 |
| `tools/fix-titles.js` | 修正资料包标题里缺失的空格 |
| `tools/make-demo.ps1` | 生成演示语料（Windows SAPI 合成 + 采集真实词级时间戳） |
| `tools/build-apk.js` | 构建 Android APK |
| `tools/build-pack.js` | 打「补充包」（.lppack）：APK 装不下的素材单独打包 |
| `tools/pack-info.js` | 查看 / 校验补充包内容（只读中央目录，不整包载入内存） |
| `tools/verify-apk.js` | 构建后自检 APK 成品（资源是否齐全、dex 里有没有该有的类） |
| `tools/probe-frontend.js` | 无头浏览器里跑真实前端，验证「离线包 + 补充包」这条路 |
| `tools/probe-device.js` | 真机/模拟器探针：走 CDP 看真实 WebView，附 `--keepalive` / `--shot` / `--eval-file` |
| `tools/probe-layout.js` | **多分辨率布局探针**：一次浏览器切 8 种屏幕尺寸，断言没有按钮被挤出屏幕、题目面板能开能关 |
| `tools/probe-interact.js` | **竖屏交互全扫**：配合 `probe-device.js --eval-file=` 用，把每个面板点一遍并确认真的点得到 |
| `tools/probe-audio-diag.js` | 给 `probe-device.js --eval-file=` 用的音频诊断脚本（区分「保活坏了」与「媒体栈卡死」） |
| `tools/probe-ielts-q.js` | 雅思题目端到端：找一门雅思课 → 点开 → 数题目与「原题正文」块 → 验换行是否保留 |
| `tools/probe-desktop.js` | 桌面版体检：无头浏览器打开正在跑的 `server.js`，验课程数 / 顶栏 / 题目面板 / 音频源 / JS 报错。`--lesson=关键字` 可指定课程 |
| `tools/make-icon.js` | 生成应用图标（自写 PNG 编码器，无图形库依赖） |
| `tools/test.js` | 回归测试，`node tools/test.js --http` 连 HTTP 层一起测（含补充包与 Java 侧真实 ZIP/Range） |

### 真题这类「我下不了」的素材：`fetch-manual.js`

四六级真题音频版权属考试机构，不适合随项目自动分发；而且这类链接经常失效或**返回假内容**。所以单独做了一个：

```bash
node tools/fetch-manual.js list              # 列出清单（含许可说明、字节数、配对表）
node tools/fetch-manual.js get cet6-paired   # 下载「2017.12 第1套」全套并逐个校验
node tools/fetch-manual.js verify audio/     # 校验已下载文件的字节数
```

它做两件关键校验：

- **字节数比对** —— GitHub 上很多仓库用 Git LFS，`raw.githubusercontent.com` 会返回 **133 字节的指针文件而状态码仍是 200**，看起来成功其实内容是空的。清单里每个文件都记了真实字节数，对不上就报出来。
- **编码探测** —— 国内仓库的 `.lrc` / `.txt` 大量是 GBK（直接读是 `Part �� Listening` 这种乱码），但也有的其实是 UTF-8 带 BOM（无脑按 GBK 转会把 BOM 变成 `锘�`）。所以先看 BOM、再用严格模式试 UTF-8，最后才按 GBK 解。

清单与「实测下不了的来源」都记在 `docs/sources-manual.json`。

> 已经用它下好并装进播放器的：**六级真题 2017年12月第1套**（音频 18.3 MB + 590 行真实时间轴 + 25 题题干选项答案 + 25 条原文依据句，题目回放片段已自动校准）。
> 直接打开：<http://127.0.0.1:4180/?lesson=CET6-%E7%9C%9F%E9%A2%98%2F2017.12-%E7%AC%AC1%E5%A5%97-%E5%90%AC%E5%8A%9B.mp3>

### 题目时间的自动校准

手工给题目写 `start` / `end` 很容易估错（本项目演示语料一开始就整体偏了 5 倍）。`calibrate-questions.js` 的做法是：

1. 把同名 `.txt` 全文与 `.lrc` 词流做 **LCS 对齐**，得到「原文第 i 个词 ↔ 音频第 j 个词」的映射
2. 在全文里定位每道题的 `transcript`（允许小改写，用「F1 × 连续性」评分，避免高频词开头的句子匹配到垃圾片段）
3. 通过映射表把原文位置换算成音频时间

```bash
node tools/calibrate-questions.js audio            # 先看报告（dry-run）
node tools/calibrate-questions.js audio --write    # 确认无误后写回
```

实测在本项目 69 道题上 **69/69 全部校准成功**，对齐率 100%。

---

## 六、目录结构

```
listening-player/                       ← 项目目录（名字不动，构建脚本要 ASCII 路径）
├─ 启动播放器.bat            ← Windows 入口（双击运行）
├─ server.js                 HTTP 层：课程 API、Range 音频流、静态托管
├─ lib/library.js            素材扫描与 LRC 解析
├─ public/                   前端（桌面版由服务托管；APK 里打进 assets）
├─ android/                  Android 工程（清单 / Java 源码 / 资源）
│  └─ src/…/MainActivity.java 壳 + 资源拦截 + JS 桥
│     PackStore.java          补充包读取（不解压，含 Range）
├─ tools/
│  ├─ 下载开放资源.bat        ← 素材下载入口（双击运行）
│  └─ …                      命令行工具（见上表）
├─ docs/
│  ├─ format.md              资料包格式详解（含 .lppack）
│  └─ resources.md           开放资源清单与许可核查
└─ audio/                    你的素材

F:\DSH workshop\Whale-Lite-手机版\      ← 交付目录（App 显示名叫Whale Lite）
├─ listening-player-lite.apk 13 MB 安装包
├─ 雅思听力补充包.lppack      补充包（APK 装不下的素材）
├─ 六级听力补充包.lppack      补充包
└─ 安装说明.txt              给用户看的说明书
```

---

## 七、实现要点

几个踩过的坑，代码注释里也有说明：

**服务端 / 前端**

- **必须起本地服务**。`file://` 下 `<audio>` 发不出 Range 请求，浏览器也会因同源策略拒绝读取同目录的 `.lrc`。服务端实现了完整的 `206 Partial Content`。
- **课程 id 不预先编码**。`id` 保留中文原名，只在拼 URL 时编码一次；若服务端预先编码、前端再 `encodeURIComponent`，就会双重编码导致查不到课程。
- **增强型 LRC 解析不能用同一个带 `g` 的正则做两次操作**。`matchAll` 会把 `lastIndex` 推到末尾，紧接着用它 `replace` 会一个标签都替换不掉，正文变成空串。
- **逐词渲染的空格必须放进 `<span>` 内部**。拼 HTML 时空格会被折叠，否则原文连成一片（实测截图才发现）。

**素材生成**

- **TTS 的 `AudioPosition` 每次 `Speak()` 都会归零**。演示语料是多段朗读的，所以用「段边界处 WAV 文件长度」算累计偏移再加到相对位置上，否则第二段之后时间戳全错。
- **SAPI 写出的 WAV 是 18 字节 fmt chunk**，不是标准 16 字节。算时长必须遍历 RIFF chunk，不能假定 44 字节头。

**下载**

- **Node 不读 Windows 系统代理**。系统开着 Clash（`127.0.0.1:7897`）时，PowerShell 能下载而 Node 报 `connect ETIMEDOUT`（解析到污染 IP）。`fetch-resources.js` 会自动读注册表里的系统代理并建 CONNECT 隧道。
- **Git LFS 陷阱**：`raw.githubusercontent.com` 对 LFS 仓库会静默返回 133 字节指针文件，状态码还是 200。要改用 `media.githubusercontent.com`。
- **HuggingFace 行接口的 `audio` 字段是数组**（`row.audio[0].src`）。按对象读会得到 `undefined`，然后在别处炸成 `Invalid URL`。
- **archive.org 的 `_djvu.txt` 常常不是正文**，只是 CD 封面 + 目录的 OCR 残片（实测某条目仅 1383 字符且夹乱码）。下载器已加长度守门；LibriVox 的正文改用 `tools/fix-librivox-text.js` 从 Project Gutenberg 取权威全文。

**内容修正**

- **标题化之前要先把下划线换成空格**。`formal_greetings` 若先做 `\b\w` 首字母大写，会变成 `FormalGreetings`。
- **修标题不要用通用的"小写-大写交界插空格"规则**——会把 `LibriSpeech` 拆成 `Libri Speech`（实测误改 124 个标题）。要限定到出问题的那一类标题。

**Android 打包**

- **`jar uf` 在 Windows 上会写入反斜杠条目名**（`assets\www\app.js`），而 Android 只认正斜杠 —— 装上去会白屏。构建脚本用自写的 ZIP 重打包解决，并加了条目名自检。
- **`execFileSync` 不能直接跑 `.bat`**（报 `EINVAL`）；用 `cmd /c` 又会被含空格的路径搞乱。最终方案是把命令写进临时 `.bat` 再执行。
- **assets 里的音频无法做 Range 请求**，进度条会拖不动。`MainActivity` 用 `AssetFileDescriptor` 手工实现 `206 Partial Content`。
- **素材在 APK 里的路径是 `assets/www/audio/<目录>/<文件>`**，而课程 id 是相对 `audio/` 的。离线前端拼 URL 时漏掉 `audio/` 这一层，症状是「课程列表正常、一播放就报音频加载失败」，且**只在 APK 里复现**（桌面走 `/media/`）。

**后台 / 锁屏保活**

- **没有前台服务就没有保活**：App 退到后台就是后台进程，锁屏听听力会被系统回收。Android 14 起还必须声明 `foregroundServiceType="mediaPlayback"`、申请对应权限、并在 `startForeground(id, n, TYPE)` 里带上类型。
- **`startForegroundService` 后必须 5 秒内 `startForeground`**，否则 ANR —— 所以进服务先无条件进前台，再处理具体动作。
- **熄屏后 CPU 会休眠**，音频会断续，需要 `PARTIAL_WAKE_LOCK`；但只在播放时持有，暂停立即释放。
- **`webView.onPause()` 是保活的反面**（它告诉 WebView 停下来），要锁屏继续跑就不能调它。
- **`requestAnimationFrame` 在页面不可见时会停**：熄屏后还要工作的逻辑（复读、A-B、进度上报）必须挂在定时器 + `timeupdate` 上，且不能依赖 rAF 维护的状态。
- **`AudioFocusRequest`（API 26）不能当字段类型**：minSdk 24 的机器在类校验阶段就会崩，用老的 `requestAudioFocus` 更稳。
- **前台服务的通知在 Android 13+ 需要运行时权限**（`POST_NOTIFICATIONS`），否则服务照跑、通知不显示。

**补充包（.lppack）**

- **`ZipFile` 要显式指定 UTF-8**（`new ZipFile(file, StandardCharsets.UTF_8)`）：包里条目名是中文。
- **音频必须不压缩（STORED）存放**。`ZipFile` 的流不能 seek，Range 只能靠「skip 到起点 + 限长读」；只有未压缩条目的 `skip()` 是改偏移不真读，压缩条目会边解压边丢数据，拖一次进度条要好几秒。
- **JS 桥调用是同步的**，6 MB 的 `library.json` 要按「字符」分片传（按字节切会切断 UTF-8），每片之间让出主线程。
- **不用 `fetch()` 读包**：离线页面是 `file:///`，用 `addJavascriptInterface` 的桥更稳；只有 `<audio>` 需要一个真实 URL，所以自建了 `.../android_asset/www/pack/<包名>/<包内路径>` 这段 URL 空间。
- **导入先写 `.part` 再改名**，并先查可用空间：1.9 GB 复制到一半失败不能留下一个"看着已安装、其实读不了"的包。
- **旧版包要报明确原因**（没有 `library.json` 的 v1 包会直接说明"请重新打包"），不能静默不显示。

**怎么在没有手机的情况下验证这两层**（本机没有 adb 设备，也没装模拟器）

- `tools/java/PackSelfTest.java` 用电脑上的 `javac`/`java` 直接跑真实的 `PackStore`：对着真实的 1.86 GB 雅思补充包做导入、整读、5 种 Range 逐字节比对、并发读、路径穿越拦截、坏包拒绝、删除。
- `tools/probe-frontend.js` 用无头 Edge 跑真实前端，模拟 `AndroidHost` 与补充包 URL 空间，实测 `<audio>` 真的对 `pack/<包名>/audio/…` 发出 Range 请求并解出时长、面板显示已加载课程数。**这个探针抓到过一个会毁掉手机端的 bug**：一个只在 Android 分支里才会用到的缓存忘了初始化，桌面上一切正常，手机上课程列表直接空白 —— 所以「只有手机才会走到的分支」一定要用探针跑一遍。
- `tools/verify-apk.js` 在成品 APK 里核对 `classes.dex` 与资源，确认该有的代码真的进去了。

**Windows 批处理入口（踩得最惨的一块）**

- **`.bat` 里不能有非 ASCII 字符**。cmd 按 OEM 代码页逐字节解析批处理，中文会让它丢失位置，执行出 `'址：http:' 不是内部或外部命令` 这种碎片。三个入口现在都是纯 ASCII，中文交给 `launcher.ps1` 输出。
- **`start "" url` 的引号必须留着**。`start "" /b cmd /c "… & start "" http://…"` 这种嵌套写法里，cmd 只剥一层引号，内层 `""` 被当空标题吃掉，URL 就成了"待打开的文件名"，于是报「Windows 找不到以 127.0.0.1:4180 为名的文件」。改成 `start "" /b node server.js` + 单独一行 `start "" "http://…"` 就好了。
- **`set` 在 `if (...)` 块里对 `%VAR%` 无效**。`%VAR%` 在解析期就展开了，块内 `set` 的值外面看不到（`setlocal` 这里也没开延迟展开）。素材检测因此失效、每次都重跑演示生成。改用 `dir ... || set` 的 errorlevel 写法，不依赖变量。
- **标签放在文件最后一行会 `goto` 失败**（报 "cannot find the batch label"）。改成线性流程 + 提前 `exit /b`。

---

## 八、当前素材库

实测规模（`audio/` 合计约 1.17 GB，201 个课程）：

| 来源 | 课程 | 体积 | 时间轴 | 许可 |
|---|---|---|---|---|
| **六级真题（2016.06–2025.12）** | **37** | **856 MB** | 17 套句级＋2 套行级，含**中文译文** | 上传者声明 CC BY 4.0 ⚠️ |
| VOA Learning English | 5 | 137 MB | 无（VOA 不提供文本） | 美国政府公有领域 |
| American English 对话 | 30 | 60 MB | 估算（按行长度加权） | 公有领域 |
| LibriVox 有声书 | 4 | 45 MB | 章节级 | 公有领域 |
| 自编演示语料 | 5 | 51 MB | **词级（真实声学时间戳）** | CC0 |
| LibriSpeech 句子精听 | 120 | 12 MB | 整句 | CC BY 4.0 |

六级真题的 925 道题里，**332 道的回放片段已用真实时间轴自动校准**；925 道全部带选项与答案。

### 六级真题怎么下

```bash
node tools/fetch-cet6-full.js list      # 看有哪些考次
node tools/fetch-cet6-full.js down      # 下载全部（约 900 MB）
node tools/build-cet6-lessons.js        # 编译成播放器课程

node tools/cet6-timings.js fetch        # 下载 37 份句级时间戳（含中文译文）
node tools/cet6-timings.js match        # 按音频字节数配对
node tools/cet6-timings.js apply        # 写入课程（覆盖为句级时间轴）
```

**关于时间轴质量**：17 套拿到了句级时间戳＋中文译文（来自 `3056810551/cet-listening`，MIT，faster-whisper 生成）；2 套用仓库自带的行级 LRC；**剩下 18 套没有时间轴**，歌词面板不会滚动，但原文仍可在「原文」抽屉里读。

为什么只有 17 套配上？因为**时间戳只对同一份录音有效**。`timings.json` 里记录了生成时所用音频的字节数，我用它做指纹去匹配，37 份里正好 17 份能对上。剩下 20 份对应的是另一批录音（多在百度网盘），拿现有音频硬套会让歌词整体漂移，所以宁可不用。未配上的清单会在 `cet6-timings.js match` 的输出里逐条列出（含期望文件名与字节数）。

### ⚠️ 实测发现的上游数据缺陷

`Ysoseri1224` 仓库里 **`CET6_2017.06` 的两个音频与 `CET6_2017.12` 完全相同**（字节数与 MD5 一致），但两个目录的原文讲的是完全不同的内容（6 月是"Work Place 节目"，12 月是"欧洲食物浪费"）。

我没有靠日期猜，而是用**内容证据**裁决：把 `timings.json` 里这段录音的逐句文本，与两个目录的原文做词重合度比较 ——

```
CET6_2017.12 的原文与时间戳重合度 86.1%     ← 正确标签
CET6_2017.06 的原文仅 19.5%                ← 错放的副本，已排除
```

`build-cet6-lessons.js` 会自动做这个判定并排除错误副本，同时把结论写进 `audio/_cet6-build-report.json`。**结果是 2017年6月第1套缺失**——请不要用别的考次音频顶替它。

### 关于「估算时间轴」

`tools/auto-timing.js` 按行长度加权铺满音频时长，能滚、大致对得上，但**不是声学对齐**。生成的包在 `meta.json` 里标了 `autoTiming: "estimated"`。

### 语音转文字（把「有音频没原文」的材料变成可滚动歌词）

**剑桥雅思 4–21 的题目与原文都在正式出版的书里，网上没有可合法抓取的免费全套。**
但只要有音频，就能自己生成带时间戳的原文 —— 这就是 `tools/transcribe.py` 的用途。

```bash
# 单个文件
python tools/transcribe.py --audio "audio/IELTS-剑桥真题/C19-Test1.mp3" --out "transcripts/C19-Test1.tsv"

# 批量（可递归，已有 tsv 会跳过，支持断点续跑）
python tools/transcribe.py --dir "audio/IELTS-剑桥真题" --outdir transcripts --model medium.en --skip-existing

# 转好后整合进播放器（会自动打上 Whisper 标识）
node tools/ielts-integrate.js
```

本机实测（RTX 4060 + medium.en）：**约 26 倍实时**，一套 30 分钟的听力约 65 秒转完。

**转写结果的来源标注**是强制的：`meta.json` 里写 `transcriptSource: {kind: "whisper", model, generatedAt}`，
界面据此显示紫色「🎙 Whisper 转写」徽标，原文抽屉顶部也会加免责声明。**不要把机器听写当成官方原文。**

两个实测踩过的坑（已在代码里处理）：

- **显存泄漏**：VAD 的 ONNX 会话与 CTranslate2 的显存不回收，每处理一个文件涨约 420 MB，第 3 个就报
  `Unable to allocate 418. MiB ... complex128`。解决办法是**每个文件重建模型并强制回收**（`free_model`）。
- **偶发超长句**：whisper 偶尔把一句话对齐到很长区间（实测有 32 秒的），滚动歌词会卡住不动。
  `ielts-integrate.js` 会按字符数封顶显示时长。

### 雅思素材的统一与合并

素材来自多个渠道，命名不一致，还有按 Part 拆开的：

```bash
node tools/ielts-inventory.js scan    # 清点：书号、重复、需合并的
node tools/ielts-unify.js plan        # 出方案
node tools/ielts-unify.js run         # 执行（统一命名 + 合并 Part + 去重）
```

**解析书号的陷阱**（踩过一次）：`剑雅真题1-20` 合集的文件名形如 `69.18.C 03-Test 01`，
里面的 `C 03` 是**合集内编号不是书号**，真书号要看最前面的序号：`序号 = (书号-1)*4 + Test`，69 → C18-Test1。
而 `剑雅真题1-19` 合集的 `C 19-Test 01` 里 `C 19` 才是真书号。两者格式相似，语义完全不同。

合并用的是 PyAV 解码后重编码（`tools/merge_audio.py`），不是字节拼接 ——
mp3 每段都有 ID3 头，直接拼会得到能播但时长错乱、进度条乱跳的文件。

---

## 九、测试

```bash
node tools/test.js --http        # 回归测试：当前 79 项全部通过
node tools/probe-frontend.js     # 无头浏览器里跑真实前端（离线包 + 补充包 + 做题 + 保活 + 个性化）
node tools/probe-frontend.js --no-packs    # 回归：没装补充包时不能坏
node tools/probe-frontend.js --bad-pack    # 面板要能说清「为什么不能用」
node tools/probe-layout.js       # 多种分辨率下的布局不变量（不需要手机）
node tools/probe-device.js       # 真机/模拟器探针（需要设备已连 adb，见下）
node tools/verify-apk.js         # 成品 APK 自检（默认找交付目录里的那个）
```

> ⚠️ **改完 `public/` 下的前端，必须重新 `build-apk.js` 再跑探针** ——
> 探针端的是 `build/apk/assets/www`，那是上一次构建的副本。

`test.js` 覆盖 LRC 解析（标准 / 增强型逐词 / 多时间戳）、字幕转换（SRT / VTT / TED JSON / TSV）、
中文路径与 URL 编码、原题解析、前端一致性，以及 HTTP 层的 Range 请求、路径穿越防护、404 处理。

补充包部分还会**在本机直接跑 Java 代码**：`tools/test.js` 用 `javac`/`java` 编译并运行
`tools/java/PackSelfTest.java`，对真实 ZIP 做导入、Range 逐字节比对、并发读、坏包拒绝等检查 ——
不需要手机或模拟器。

### 真机 / 模拟器上调试

```bash
# MuMu 模拟器自带 adb，连上它（端口 7555/5555）
adb connect 127.0.0.1:7555
adb -s 127.0.0.1:5555 install -r "F:\DSH workshop\Whale-Lite-手机版\listening-player-lite.apk"
adb -s 127.0.0.1:7555 shell am start -n com.dsh.listeningplayer/.MainActivity   # 探针要求 App 已在运行

node tools/probe-device.js                 # 体检：课程数、音频地址、时长、补充包状态
node tools/probe-device.js --keepalive     # 锁屏保活实测：熄屏 6 秒看音频是否还在走
node tools/probe-device.js --boot          # 模拟器掉线时自动拉起并等待（开机约 106 秒）
node tools/probe-device.js --serial=IP:端口  # 模拟器和真机同时插着时指定探哪一台
node tools/probe-device.js --eval "表达式"  # 在真实 WebView 里跑任意 JS
node tools/probe-device.js --eval-file=脚本.js  # 复杂 JS 写文件再跑（PowerShell 会搞坏 \" 转义）
node tools/probe-device.js --shot out.png  # 截图
```

> 📶 **真机走无线调试**（USB 驱动被 libusbK 之类占用、`adb devices` 看不见时的退路）：
> 平板/手机开「开发者选项 → 无线调试」，先 `adb pair <IP>:<配对端口> <配对码>`，
> 再用 `adb connect <IP>:<连接端口>`。
> ⚠️ **配对端口和连接端口不是同一个** —— 配对对话框上那个配完就失效，
> 要的是「无线调试」主界面上另写的那一行。

> ⚠️ **探针跑多了 WebView 的媒体栈会卡死**（`audio.error.code=2`、`seeking` 永远为 true、
> 位置不动）。这时 `adb shell am force-stop com.dsh.listeningplayer` 再启动就恢复，
> **不是保活回归** —— 别急着去改 `PlaybackService`。

它走 Chrome DevTools 协议（`WebView.setWebContentsDebuggingEnabled(true)` + adb forward），
能看到真实 WebView 的 DOM、报错与状态。**这些坑只有真机上才暴露**：
`resources.arsc` 压缩导致装不上、assets 音频压缩导致拖不动进度条、
根路径引用导致页面没样式没脚本、`file://` 下 `fetch` 被拦导致课程列表空白 ——
本项目的构建脚本现在都会在打包后自检这几项。


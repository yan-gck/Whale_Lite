# 交接说明（HANDOFF）

> 这份文档用于**换一个新会话继续这个项目**。把整份内容粘给新会话，或让它先读本文件。
> 最后更新：**第 12 轮 —— 改名 Whale Lite + 发到 GitHub**。
> App 显示名从「圣元英语BB机」改成 **Whale Lite**（正式名称），反馈渠道从 QQ 换成
> **仓库 Issues 页**（<https://github.com/yan-gck/Whale_Lite/issues>），
> 代码已推到 <https://github.com/yan-gck/Whale_Lite>（不带剑桥雅思素材）。
> 上一轮（第 11 轮）完成的是竖屏 / 窄屏 / 不同分辨率的交互大修，四条 bug 全部修复；
> **已在 HONOR HEY2-W09 平板（Android 14）上实测通过**：竖屏 753×1173 交互全扫全过、
> 横屏 1205×721 三栏布局正常、**锁屏保活熄屏 6 秒前进 6.2s**。

---

## 一、项目是什么

在 `F:\DSH workshop\listening-player` 下的一套**英语听力练习系统**（四六级 / 雅思 / 托福）：

- 本地 Node 服务 + 原生前端，播放音频时**原文按时间戳滚动**（类歌词）
- 支持逐词高亮、倍速、单句复读、A-B 循环、听写模式、题目面板
- 可打包成 **Android APK**（内置全部素材，离线可用）
- 配套一整套工具链：资源下载、语音转写、字幕转换、题目时间校准、素材合并

**当前运行中**：`node server.js` → <http://127.0.0.1:4180>（273 个课程）

---

## 二、用户最新需求（本次要做的，**最重要**）

用户原话要点：

1. **改造播放器的交互逻辑**，做题流程改成：
   - 第一步：**听力 + 原题**（只听、只看题，**不显示原文**）
   - 然后有**提交按钮**
   - 提交后**自动对照批改**（对/错标出来）
   - 按解析把**答案与原文对应**起来
   - **点击答案（含用户答对的、答错的）可跳转到对应原文区域并播放**
2. **自定义板块**要四样东西：
   - ① 听力原文件（音频）
   - ② 听力原文（**用户没上传就用 Whisper 生成一份**）
   - ③ 解析（提示用户「用大模型 + 原文 + 题目」自己生成；若上一步原文是机器生成的，**要提供我们生成的原文供下载**）
   - ④ 听力原题
3. **翻译直接机翻**，加声明即可；除非用户主动上传中文原文
4. **Section 边界切分**要做
5. **所有有利于语言学习的优化都自动做，不要再问用户**
6. **手机端要能运行 PC 上的所有功能**
7. **APK 要自带全部资源**

用户已明确说「不要再问我」，所以**能自动做的直接做**。

---

## 三、环境与硬约束（务必先读）

| 项 | 值 |
|---|---|
| 工作目录 | `F:\DSH workshop` |
| 项目目录 | `F:\DSH workshop\listening-player` |
| Node | v24.19.0 |
| Python | 3.12.10（`python` 命令可用） |
| JDK | `F:\JAVA`（JDK 17） |
| Android SDK | `F:\DSH workshop\android-sdk`（platforms/android-34、build-tools/34.0.0） |
| GPU | NVIDIA RTX 4060 Laptop（转写用） |
| 物理内存 | 15.3 GB（**紧张，只剩约 4 GB 可用**） |
| 系统代理 | `127.0.0.1:7897`（Clash，Node 默认**不读**，见踩坑） |
| 沙箱 | `danger-full-access`，**审批提示已禁用** → 不要设置 `sandbox_permissions`，被拒就是被拒 |

已装依赖：`unpdf`（npm）、`faster-whisper`、`ctranslate2`、`nvidia-cublas-cu12`、`nvidia-cudnn-cu12`、PyAV。

### PowerShell 使用的血泪教训

**不要在 `pwsh` 里用内联 `node -e "..."` / `python -c "..."` 写复杂代码**——本会话因此浪费了大量轮次，转义会反复出错。
**正确做法**：用 `write` 工具写一个 `.js` / `.py` 脚本文件，再用 `pwsh` 执行它。

---

## 四、现在已有哪些资源

### 素材分布（`listening-player/audio/`）

| 目录 | 课程数 | 体积 | 说明 |
|---|---|---|---|
| `IELTS-剑桥真题/` | **72** | 1.85 GB | 剑桥雅思 **C4–C21**，命名 `C<书号>-Test<套号>.mp3`，**全部有 Whisper 句级时间轴** |
| `CET6-真题/` | 37 | 855 MB | 六级 2016–2025，925 题，332 题回放片段已校准 |
| `AmericanEnglish/` | 30 | 60 MB | 美国国务院对话，公有领域 |
| `VOA/` | 5 | 137 MB | 美国政府公有领域（无文本） |
| `LibriVox/` | 4 | 45 MB | 有声书，公有领域 |
| `LibriSpeech-句子精听/` | 120 | 12 MB | CC BY 4.0 |
| `CET4-演示/`、`CET6-演示/`、`IELTS-演示/`、`TOEFL-演示/` | 5 | 51 MB | **自编仿真题（CC0）**，含 69 道题 + 真实词级时间戳 |
| `_cet6-raw/`、`_timings/` | — | 小 | 六级原始文本与时间戳数据 |

`audio/` 合计约 **3.0 GB**。

### 转写成果

`listening-player/transcripts/*.tsv` — 72 个剑桥雅思转写文件，**共 26,219 句**，格式：
```
起始秒<TAB>结束秒<TAB>文本
```

### 用户提供的原题（**本次新增，关键**）

`F:\DSH workshop\听力真题\` — **17 本书 × 2 个 PDF = 34 个文件 / 78.4 MB**

| 文件名模式 | 内容 | 覆盖 |
|---|---|---|
| `剑N真题_listening.pdf` | 听力原题（题干、选项、填空） | 剑4–剑20 |
| `剑N真题_answers.pdf` | 答案页 | 剑4–剑20 |

（剑9/16/18/20 文件名里没有"真题"二字，是 `剑9_listening.pdf` 这种格式）

**PDF 文字层实测结论**：

- ✅ **有文字层（13 本）**：剑 4、5、6、7、8、10、11、12、13、14、15、17、19
- ❌ **扫描图，无文字层（4 本）**：剑 **9、16、18、20** → 需要 OCR

**答案页的 OCR 噪声规律**（解析时必须容错）：

| 现象 | 例子 | 实为 |
|---|---|---|
| `\|` 被识成 `I` | `shopping I variety of shopping` | `shopping \| variety of shopping`（两答案都算对） |
| `1` 被识成 `I` / `l` | `I C`、`I 0` | `1 C`、`10` |
| 行首 `1` 被识成 `7`/`l` | `1 Bristol` | `7 Bristol` |
| 大小写混乱 | `22 c` | `22 C` |

答案页格式样例（剑4 Test1）：
```
Section 1, Questions 1-10
1 shopping I variety of shopping
2 guided tours
3 more than 12 I over 12
Section 3, Questions 21-30
21 A
22 c
```
另有 `11 IN EITHER ORDER, BOTH REQUIRED FOR ONE MARK` 这类特殊标注。

**注意**：答案页**只有题号+答案，没有题干**；题干要从 `listening.pdf` 里抽。
剑13 的 listening PDF 被**手写填过答案**，抽出 `....f?..�Y.4l�` 这类噪声，需要清洗。

---

## 五、代码结构与现有能力

```
listening-player/
├─ 启动播放器.bat            双击启动（纯 ASCII，中文提示由 tools/launcher.ps1 输出）
├─ 打包APK.bat               双击构建 APK
├─ listening-player-lite.apk 构建产物（35 MB：前端 + 演示语料）
├─ 雅思听力补充包.lppack      1.86 GB（剑桥雅思 72 套，含课程数据）
├─ 六级听力补充包.lppack      856 MB（六级真题 37 套）
├─ server.js                 HTTP 层：/api/lessons、/api/lesson/<id>、/api/bundle、/api/duration(POST)、/media/<path>(支持 Range)
├─ lib/library.js            素材扫描 + 增强型 LRC 解析（含译文 .translation.lrc）
├─ public/                   前端 index.html / style.css / app.js（原生 JS，无框架）
│   └─ 支持 HTTP 与离线 bundle.json 双模式（_DATA_SOURCE），离线模式下再叠加补充包课程
├─ android/                  Android 工程（AndroidManifest.xml、src/.../*.java、res/）
│   └─ src/com/dsh/listeningplayer/
│       ├─ MainActivity.java 壳 + 资源拦截 + JS 桥（AndroidHost）
│       ├─ PlaybackService.java 前台服务：后台/锁屏保活（通知 + 媒体会话 + 唤醒锁）
│       ├─ PackStore.java    补充包读取（只用 java.*，可在电脑上跑测试）
│       ├─ HttpRange.java    Range 头解析（206 逻辑）
│       └─ Streams.java      skipFully / Bounded 流等小工具
├─ transcripts/              72 个雅思 TSV（Whisper 转写）
├─ tools/                    工具链（见下）
└─ docs/
    ├─ format.md             资料包格式详解（含 .lppack 补充包格式）
    └─ resources.md          开放资源清单与许可核查（很详细，涉及版权判断时先读它）
```

### 补充包（离线素材）是怎么跑起来的

单个 APK 有 **2 GiB 硬上限**（ZIP 中央目录 32 位），本机素材 3.0 GB 装不进去，所以分两层：

```
安装包 listening-player-lite.apk   35 MB   前端 + 5 门演示课
补充包 <名字>.lppack               任意     某个 audio/ 子目录的完整内容
```

数据流（手机端，全程离线）：

```
public/app.js
  ├─ 先 fetch('/api/lessons') 失败 → fetch('bundle.json')  ← 演示课
  └─ 再走 JS 桥 window.AndroidHost
       · packs()                        已安装包列表（JSON 字符串）
       · packTextLength/packTextChunk   取包内 library.json（按字符分片，6 MB 分 12 次传）
        ↓ 合并成课程列表（补充包课程带 📦 徽标）
  <audio src="file:///android_asset/www/pack/<包名>/audio/<课程 id>">
        ↓ shouldInterceptRequest 截获
MainActivity  →  PackStore（ZipFile 随机访问，不解压）
       · 非媒体：直接返回条目流
       · 音频：手工 206 Partial Content（条目流 + skipFully 定位 + 限长）
```

界面：右上角「补充包」→ 面板里能看到已安装包 / 校验失败原因 / 目录路径，
并有一个「导入 .lppack」按钮（走 SAF 文件选择器，Java 侧复制进私有目录，
进度用 `window.__onPackEvent` 回抛给网页）。

### 工具链（`tools/`）

| 文件 | 用途 |
|---|---|
| `fetch-resources.js` | 下载开放许可资源（公有领域/CC），**带 Windows 系统代理自动探测** |
| `fetch-manual.js` | 下载「需人工确认」的素材，带字节数与编码校验 |
| `fetch-cet6-full.js` | 六级真题全量下载 |
| `build-cet6-lessons.js` | 六级素材编译成课程（含上游重复数据自动检出） |
| `cet6-timings.js` | 句级时间戳下载与按字节数配对 |
| `transcribe.py` | **语音转文字**（faster-whisper + GPU），输出 TSV |
| `merge_audio.py` | PyAV 真正拼接多个音频为一个 MP3 |
| `ielts-inventory.js` | 清点素材：识别书号/Test、找重复、列需合并的 |
| `ielts-unify.js` | 统一命名 + 合并拆分 + 去重 |
| `ielts-integrate.js` | 把转写整合进课程并标注 Whisper 来源 |
| `pdf-text.js` | PDF 抽文本（基于 unpdf） |
| `parse-qstem.js` | 题干+选项+答案+原文标记 → questions.json |
| `calibrate-questions.js` | 用真实时间轴 LCS 对齐，自动算每题回放片段 |
| `lrc-from-srt.js` | SRT/VTT/TED JSON/TSV → LRC |
| `auto-timing.js` | 无时间轴时按行长度估算（会标注为估算） |
| `media-duration.js` | 读 wav/mp3/flac/m4a 时长（**按内容嗅探，不信扩展名**） |
| `build-apk.js` | 构建 APK（aapt2 + javac + d8 + 自写 ZIP 重打包 + zipalign + apksigner） |
| `build-pack.js` | **补充包打包**（`--list` 看目录，`--set=xxx` 打包，内含 library.json） |
| `pack-info.js` | **查看 / 校验补充包**（只读中央目录，不会把 1.8 GB 读进内存） |
| `verify-apk.js` | 构建后自检成品 APK（资源是否齐全、dex 里有没有补充包相关代码） |
| `probe-frontend.js` | **无头浏览器里跑真实前端**，模拟 AndroidHost + 补充包 URL 空间（不用手机就能验前端） |
| `java/PackSelfTest.java` | 补充包读取逻辑的单元测试（由 test.js 用 javac/java 直接跑） |
| `make-icon.js` | 生成图标（自写 PNG 编码器） |
| `make-demo.ps1` | 生成自编演示语料（SAPI 合成 + 真实词级时间戳） |
| `test.js` | 回归测试，`node tools/test.js --http`（当前 **73 项通过**） |
| `probe-device.js` | **真机/模拟器探针**：走 Chrome DevTools 协议看真实 WebView 的 DOM/状态，附 `--keepalive` 锁屏保活实测、`--shot` 截图、`--eval-file=脚本.js` 跑复杂 JS、**`--serial=IP:端口` 指定设备**（模拟器与真机同时插着时用；默认优先 MuMu 的 `:7555`） |
| `probe-audio-diag.js` | 配合 `probe-device.js --eval-file=` 用的音频诊断脚本：播放 6 秒并逐次打印 `readyState / networkState / error.code / seeking`，用来区分「保活坏了」和「媒体栈卡死」（见踩坑 61） |
| `probe-layout.js` | **多分辨率布局探针**（不需要手机）：无头浏览器里用 CDP 切 8 种屏幕尺寸，逐一断言「顶栏按钮没被切掉 / 更多菜单整块在屏幕内 / 题目面板两个入口都能开能关 / 浮动开关没压住播放器 / 正文没钻到顶栏底下」。见踩坑 67 |
| `probe-interact.js` | **竖屏交互全扫**（配合 `probe-device.js --eval-file=` 用）：把顶栏、更多菜单、侧栏、题目抽屉、原文/原题/设置/补充包/导入面板、模式切换全点一遍，并用 `elementFromPoint` 判断按钮是不是**真的点得到**（存在 ≠ 点得到） |
| `probe-ui-diag.js` | 一次性布局体检（配合 `--eval-file=` 用）：打印视口、每个顶栏按钮的 rect 与是否完整在视口内、更多菜单与题目面板的开关状态、横向溢出元素清单。定位"按钮跑哪去了"就靠它 |
| `wav-to-mp3.py` | 把演示语料的 WAV 转 64k MP3（APK 里的音频必须不压缩存放，转码能省 4 倍体积） |
| `launcher.ps1` | bat 的中文提示输出 |

### 课程资料包格式（`<名字>.*` 同名一组）

| 文件 | 必需 | 说明 |
|---|---|---|
| `.mp3` / `.m4a` / `.wav` … | ✅ | 音频 |
| `.lrc` | ⬜ | 时间轴，支持增强型逐词 `<mm:ss.xx>` |
| `.translation.lrc` | ⬜ | 中文译文，同时间戳，界面做英中对照 |
| `.questions.json` | ⬜ | 题目（见 `docs/format.md`） |
| `.meta.json` | ⬜ | 元信息，**含 `transcriptSource` 标识来源** |
| `.txt` | ⬜ | 完整原文 |

`meta.json` 里与本次需求相关的字段：
```json
"transcriptSource": { "kind": "whisper", "model": "faster-whisper medium.en",
                      "generatedAt": "2026-09-19", "note": "非官方原文" },
"axisQuality": "sentence",
"hasTranslation": true
```
`kind` 取值：`whisper`（紫标 🎙 Whisper 转写）/ `official`（绿标 📄 官方原文）/ `estimated`（≈ 估算时间轴）。

---

## 六、必须知道的踩坑记录（**别重复踩**）

### Windows / 批处理
1. **`.bat` 里不能有非 ASCII 字符**。cmd 按 OEM 代码页逐字节解析，中文会让它丢失位置，执行出 `'址：http:' 不是内部或外部命令` 这种碎片。三个入口现在都是纯 ASCII，中文由 `launcher.ps1` 输出。
2. **`start "" url` 的引号必须留着**。`start "" /b cmd /c "… & start "" http://…"` 这种嵌套里 cmd 只剥一层引号，URL 变成「待打开的文件名」，报「Windows 找不到以 127.0.0.1:4180 为名的文件」。
3. **`set` 在 `if (...)` 块里对 `%VAR%` 无效**（解析期展开）。改用 `dir ... || set` 的 errorlevel 写法。
4. **标签放文件最后一行会 `goto` 失败**。

### 网络
5. **Node 不读 Windows 系统代理**。系统开着 Clash 时 PowerShell 能下载而 Node 报 `connect ETIMEDOUT`（解析到污染 IP）。`fetch-resources.js` 会自动读注册表 `ProxyServer` 并建 CONNECT 隧道——**新写的下载代码要复用它**。
6. **Git LFS 陷阱**：`raw.githubusercontent.com` 对 LFS 仓库会静默返回 133 字节指针文件，状态码却是 200。二进制要走 `media.githubusercontent.com`；**文本文件反而必须走 raw**（走 media 会 404）。
7. **4xx 不要重试**（曾刷出几百行无用日志）。

### 编码
8. **`.lrc`/`.txt` 可能是 GBK，也可能是 UTF-8 带 BOM**。判定顺序：先看 BOM → 再用 `TextDecoder('utf-8', {fatal:true})` 严格试 → 最后才按 GBK 解。无脑按 GBK 转会把 BOM 变成 `锘�`。
9. **PowerShell 的 `Set-Content -Encoding UTF8` 会写 BOM**，破坏 shebang / JSON。用 Node 写文件更稳。

### 转写（Whisper）
10. **显存泄漏**：每处理一个文件涨约 420 MB，第 3 个就报 `Unable to allocate 418. MiB ... complex128`。解法：**每个文件重建模型 + `free_model()` 强制回收**。
11. **VAD 的 ONNX 会话也泄漏内存**。内存紧张时加 `--no-vad`（听力材料影响不大）。
12. **束搜索吃内存**。大文件（>28 MB）要加 `--beam 1`。
13. **whisper 偶发超长句**（实测最长 32 秒），滚动歌词会卡住。`ielts-integrate.js` 里按字符数封顶显示时长。
14. `AudioPosition` 每次 `Speak()` 归零（TTS 相关，见 `make-demo.ps1` 的累计偏移处理）。

### 前端 / 服务
15. **课程 id 不预先编码**。id 保留中文原名，只在拼 URL 时编码一次；否则双重编码查不到课程。
16. **增强型 LRC 解析不能用同一个带 `g` 的正则做两次操作**（`matchAll` 会把 `lastIndex` 推到末尾，`replace` 就失效，正文变空串）。
17. **逐词渲染的空格必须放进 `<span>` 内部**，否则原文连成一片。
18. **无头浏览器里没有真实排版**（`offsetTop` 恒为 0），滚动位置无法用截图验证；但**高亮逻辑可以验证**（把 `audio.currentTime` 打补丁后逐帧检查）。

### Android 打包
19. **`jar uf` 在 Windows 上写反斜杠条目名**（`assets\www\app.js`），Android 只认正斜杠 → 装上去白屏。构建脚本用**自写 ZIP 重打包**解决，并加了条目名自检。
20. **`execFileSync` 不能直接跑 `.bat`**（`EINVAL`）；`cmd /c` 又被含空格路径搞乱。方案：把命令写进临时 `.bat` 再执行。
21. **assets 里的音频无法做 Range 请求**，进度条会拖不动。`MainActivity` 用 `AssetFileDescriptor` 手工实现 `206 Partial Content`。

### 补充包（.lppack）——第 6 轮新增，全是实测踩出来的
22. **`ZipFile` 必须显式指定 UTF-8**：`new ZipFile(file, StandardCharsets.UTF_8)`。
    包里的条目名是中文，虽然打包时置了 UTF-8 名字标志（`0x0800`），显式指定更保险。API 24+ 才有这个重载（minSdk 正好 24）。
23. **音频必须 STORED（不压缩）存放**：`ZipFile.getInputStream()` 拿到的流不能 seek，
    Range 只能靠「skip 到起点 + 限长读」。只有未压缩条目的 `skip()` 是「只改偏移、不真读」，
    压缩条目 skip 会边解压边丢数据，25 MB 的音频拖一次进度条就要几秒。
    → `build-pack.js` 里 `zip.addFile(..., !isAudio)` 就是这个原因，测试里也专门断言了 method === 0。
24. **JS 桥调用是同步的，大字符串要分片**：雅思包的 `library.json` 有 6 MB，
    一口气从 Java 传一个 6 MB 字符串回 JS 不稳妥。方案：`packTextLength` + `packTextChunk`，
    **按「字符」切片**（按字节切会切断 UTF-8 多字节序列），前端每片之间 `await setTimeout(0)` 让出主线程。
25. **不要靠 `fetch()` 读补充包**：离线页面的地址是 `file:///android_asset/www/…`，
    用桥（`addJavascriptInterface`）比依赖 file:// 的同源策略稳得多。音频例外 ——
    `<audio>` 需要一个真实 URL，所以自建了 `.../android_asset/www/pack/<包名>/<包内路径>` 这段 URL 空间。
26. **`getExternalFilesDir(null)` 下再套一层 `packs/`**，路径是
    `/sdcard/Android/data/com.dsh.listeningplayer/files/packs/`。这个位置**不需要任何权限**，
    数据线就能往里拷（`AndroidManifest` 里只有 INTERNET，别加存储权限）。
27. **导入要写 `.part` 再改名**：1.9 GB 复制到一半被打断，不能留下一个「看着已安装、其实读不了」的包。
    复制前还要查 `getUsableSpace()`，不然用户会遇到写到一半失败的莫名错误。
28. **旧版包（没有 library.json）必须报明确原因**，不能静默不显示 ——
    校验失败信息会原样显示在「补充包」面板里（用户要看的就是「为什么不能用」）。

### 调试手法（没有手机也能验，第 6 轮新增）
29. **Java 侧逻辑抽成只用 `java.*` 的类，就能在电脑上跑**：`PackStore` / `HttpRange` / `Streams`
    都不引用 Android API，`tools/test.js` 里用 `javac` + `java` 直接跑 `tools/java/PackSelfTest.java`
    （真实 ZIP、真实 1.8 GB 补充包、真实 Range 比对、并发读同一份数据）。
    这比刷机快一百倍，而且能覆盖「拖动进度条听到错位置」这类难查的问题。
30. **前端功能要在无头浏览器里真跑一遍**：`node tools/probe-frontend.js` 会起一个本地服务，
    把 APK 用的离线资源原样端出来，并模拟 `AndroidHost` 与补充包 URL 空间，
    然后用无头 Edge 打开页面、点课程、开面板，把结果写进 DOM 再核对。
    **这条救过一次大 bug**：`DATA_SOURCE.packCache` 忘了初始化，
    桌面上（没有桥）一切正常，手机上一装上补充包**整个课程列表直接空白**。
    所以「只在 Android 里才会走到的分支」一定要用这个探针跑一遍。
31. **探针服务里不能用 `execFileSync` 启动浏览器**：它会阻塞 Node 事件循环，
    同进程的 HTTP 服务就没人应答 → 浏览器等服务、脚本等浏览器，直接死锁。要用 `spawn`。
32. **PowerShell 会把空字符串参数丢掉**：`java PackSelfTest a b c "" x` 里的 `""` 到不了 Java，
    参数位置全错位。要么别传空串，要么传占位符（本项目用 `-`）。
33. **自检顺序**：改完补充包或保活相关代码，跑
    `node tools/test.js --http` → `node tools/build-apk.js --audio-set=… --out=listening-player-lite.apk`
    → `node tools/verify-apk.js listening-player-lite.apk` → `node tools/probe-frontend.js`
    （这四步都在本机几秒到两分钟内完成，不需要手机）。
    **改了 `public/` 下的前端一定要重新构建 APK 再跑探针** —— 探针端的是
    `build/apk/assets/www`，那是上一次构建的副本，不重建就是拿旧代码在验（踩过一次，
    表现为「`window.__onHostCommand is not a function`」这种莫名其妙的错误）。
    **第 11 轮补充**：动过布局 / 尺寸 / 抽屉 / 顶栏按钮的，再加一步
    `node tools/probe-layout.js`（8 种分辨率跑布局不变量，本机约 20 秒）——
    这条正是为了堵住"探针全绿但手机上一上手就四个 bug"那个洞（见踩坑 67）。
34. **探针不要用 `--virtual-time-budget` + `--dump-dom`**：播放器有 250ms 定时器，
    虚拟时钟会把预算瞬间烧完，页面还没渲染完就 dump 了。
    改成 `--remote-debugging-port` + CDP `Runtime.evaluate` 轮询（Node 22+ 自带 WebSocket），
    真实时间等待，想等多久等多久。

### 后台 / 锁屏保活（第 7 轮新增）
35. **没有前台服务就没有保活**。App 退到后台就是「后台进程」，锁屏听听力会被系统直接回收。
    Android 14（targetSdk 34）起还必须：清单里声明 `foregroundServiceType="mediaPlayback"`、
    申请 `FOREGROUND_SERVICE_MEDIA_PLAYBACK` 权限、并且 `startForeground(id, n, TYPE)` 带上类型。
    少一样就是运行时异常。
36. **`startForegroundService` 之后必须 5 秒内 `startForeground`**，否则 ANR。
    所以 `onStartCommand` 里先无条件进前台，再处理具体动作 —— 别先判断再决定要不要进前台。
37. **熄屏后 CPU 会休眠，音频会断续**。要 `PARTIAL_WAKE_LOCK`，但**只在播放时持有**，
    暂停立即释放（否则就是纯耗电）。另外暂停久了要能自动收掉服务，不然通知栏永远挂着一条。
38. **`webView.onPause()` 是保活的反面**：它是让 WebView 停下来的信号。
    要锁屏继续跑就别调它（本项目已去掉，并在测试里加了「不许再写回去」的断言 ——
    注意断言前要先剥掉注释，否则会被解释这个坑的注释绊倒）。
39. **`requestAnimationFrame` 在页面不可见时会停**。凡是「熄屏后还要继续工作」的逻辑
    （单句复读、A-B 循环、进度上报）都不能只挂在 rAF 上，要放 `setInterval` + `timeupdate`，
    并且别依赖 rAF 维护的状态（如 `state.activeIndex`），得自己补算。
40. **`AudioFocusRequest`（API 26）别当字段类型用**，minSdk 24 的机器在类校验阶段就会炸。
    用老的 `requestAudioFocus(listener, stream, gain)`，它虽然被标 deprecated 但 API 34 上照样能用。
41. **前台服务的常驻通知在 Android 13+ 需要运行时权限**（`POST_NOTIFICATIONS`），
    不然服务照跑、通知不显示，用户会以为没生效。
42. **`assets/www/audio/` 这一层前缀别漏**：APK 把素材放在 `assets/www/audio/<目录>/<文件>`，
    而课程 id 是相对 `audio/` 的。离线前端拼 URL 时少写一层 `audio/`，
    结果是「列表正常、一播放就报音频加载失败」，而且**只在 APK 里复现**（桌面走 `/media/`）。

### 只有真机才暴露的问题（第 8 轮，全是血的教训）
45. **`resources.arsc` 必须未压缩 + 4 字节对齐**。targetSdk ≥ 30 时，Android 11+ 的安装器直接拒绝：
    `-124 Failed parse during installPackageLI: … resources.arsc … must be stored uncompressed and
    aligned on a 4-byte boundary`。自写 ZIP 重打包**不能无脑 deflate**：
    要么保留 aapt2 原本的压缩方式，要么强制 STORED。`build-apk.js` 现在打包后自检，不对就让构建失败。
46. **assets 里的音频必须是 STORED（未压缩）**：`getAssets().openFd()` 只对未压缩资源有效，
    而 MainActivity 就是靠它实现 Range（拖动进度条）的。压缩过的资源 → 播不出声、拖不动。
    同一个坑的两副面孔（45 与 46 都出自「一律 deflate」这一行代码）。
47. **`file:///android_asset/` 页面里不能用根路径引用资源**。写 `/app.js` 会被解析成
    `file:///app.js`（**不是** assets 根目录），既 404 又不会经过 `shouldInterceptRequest`
    → 页面变成「没有样式、没有脚本」的静态骨架。**一律用相对路径**（`app.js` / `style.css`），
    并写了一条静态检查盯着（`index.html 只用相对路径引用资源`）。
48. **file:// 页面里 `fetch()` 是废的**（"URL scheme file is not supported"）。
    `bundle.json`、`packs-catalog.json` 这类随包资源必须走 JS 桥读
    （`assetTextLength` + `assetTextChunk` 分片），否则**课程列表永远空白**，桌面完全正常。
49. **不要和 WebView 抢音频焦点**。音频是网页 `<audio>` 播的，Chromium 自己会申请焦点；
    前台服务再申请一次 → 自己跟自己抢 → Chromium 收到 `AUDIOFOCUS_LOSS` 立刻暂停。
    症状是「按下播放约 0.1 秒后自动暂停」。logcat 里能看到 `MediaFocusControl: requestAudioFocus()
    … AudioFocusDelegate` 紧随 `dispatching onAudioFocusChange(-1)`。
50. **`adb push` 会把中文文件名弄坏**（实测 `六级听力补充包.lppack` 变成 `六级听力`，扩展名丢了）。
    往手机拷补充包要么用**数据线 MTP 拖拽**（保留文件名）、要么用 App 内「导入 .lppack」、
    要么 push 时取个 ASCII 名字（`cet6.lppack`）。App 侧只认 `.lppack` 后缀，这个契约别放宽。
51. **真机调试的钥匙是 `WebView.setWebContentsDebuggingEnabled(true)`**，
    然后 `adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>` + CDP
    `Runtime.evaluate`。没有它，上面 45–49 这些都只能靠猜。
    （Node 22+ 自带 WebSocket，不需要 puppeteer。）
52. **改完前端一定要重新 `build-apk.js` 再跑设备探针**：探针连的是 App 里那份
    `assets/www`，不是 `public/`。拿旧包验新代码，会得到「函数不存在」这种莫名其妙的结论。

### 第 9 轮继续踩到的
53. **绝对不要在 `mousemove`/`touchmove` 里连续写 `audio.currentTime`**。WebView 的媒体栈
    经不起几十次连续 seek（每次都要重发 Range 请求），会卡死；而且卡死后 `pause` 事件
    不一定送到页面，于是「声音停了、按钮还显示在播放」。
    正确做法：拖动期间只更新画面（气泡预览），**松手才 seek 一次**，并在松手后检查是否需要续播。
54. **UI 的播放状态别只靠事件**：按钮文案每个周期从 `audio.paused` 推导一次。
    事件会丢，`paused` 不会骗人。再加一个卡顿看门狗（3 秒不动 → 重播 → 重新 load）。
55. **面向用户的文案不要写实现细节**。用户明确要求：「补充包是 APK 装不下的」这种话说给他听
    没意义，应该说「批量导入听力材料的包」。`test.js` 里有一条断言盯着这件事
    （查文案前要先剥掉代码注释，否则会被解释这个坑的注释绊倒）。
56. **窄屏上按钮会被挤出屏幕 = 藏起来**。顶栏 8 个按钮在 510 px 宽的主栏里必然滚出去，
    要主动把次要功能收进「更多 ▾」菜单，而不是靠横向滚动。
57. **超长的元信息会把标题栏撑到 200 px**，把原文区挤成一条缝（横屏手机上尤其致命）。
    元信息逐条 `max-width + ellipsis` 截断成一行即可；浮层（如续听条）也别压在正文上，
    改成独立一行。
58. **模拟器会自己退出**（MuMu VM 进程消失、5555/7555 不再监听），而 `adb` 在设备掉线时
    只打印 `waiting for device` 干等 —— 探针里所有 adb 调用**必须带 timeout**，
    否则整个会话被挂死（真被挂了 5 分钟）。重新拉起：
    `"E:\MuMu Player 12\nx_main\MuMuManager.exe" control --vmindex 0 launch`（开机约 106 秒），
    探针里加了 `--boot` 自动做这件事。
59. **复杂 JS 别内联进 `--eval`**：PowerShell 会把 `\"` 转义搞坏（老教训的新案例）。
    `probe-device.js` 现在支持 `--eval-file=脚本.js`，脚本写文件再跑。

### 第 10 轮（改显示名）—— 只有一条，但代价很大

60. **改 App 显示名 ≠ 改包名**。用户说「把名字改成Whale Lite」时，只改**显示名**：
    - ✅ 该改：`strings.xml` 的 `app_name`、清单 `android:label="@string/app_name"`、
      `index.html` 的 `<title>` 与侧栏品牌、`app.js` 的通知兜底标题与导出文件名、
      `PlaybackService` 的通知文案、`launcher.ps1` 横幅、交付目录名。
    - ❌ **绝对不能改**：包名 `com.dsh.listeningplayer`、项目目录 `listening-player`、
      补充包目录名 / 包内 `audio/<目录名>/` 路径。
    - **包名一改，就等于发了一个新 App**：① 手机上升级装不上，会并存两个图标；
      ② 补充包路径是 `getExternalFilesDir()` 拼出来的，**路径里带包名**，
      已有的 `.lppack`（模拟器上 856 MB 那份）当场失效，用户得重新拷一遍；
      ③ `adb`/探针脚本里所有 `-s ... install` 都要重来。
    - **项目目录一改**，构建脚本写的临时 `.bat` 里会出现中文路径 → cmd 解析坏（踩坑 1）。
    - 交付目录（`Whale-Lite-手机版`）**可以改**，因为它只被 `tools/paths.js` 的 `MOBILE_DIR`
      一处引用；改完记得 `build-apk.js` / `build-pack.js` / `打包APK.bat` 都走 `paths.js` 取路径，
      别把目录名硬编码到第二个地方。
    - 改完**必须重新构建 APK 再验**：`aapt2 dump badging` 里的 `application-label:'…'` 是唯一权威
      证据，光看源码容易漏（label 可能在清单里写死、也可能在 `strings.xml` 里）。
    - 换名后要搜两份清单：清单的 `application/@label`、前端的 `<title>` + 侧栏品牌。

61. **探针跑多了，WebView 的媒体栈会卡死 —— 别误判成保活回归**。
    第 10 轮复验时 `--keepalive` 第一次跑出「熄屏 6 秒音频前进 0.0s」，看着像保活坏了，
    实际是**媒体元素自己卡住了**：`audio.error.code=2`（MEDIA_ERR_NETWORK）、
    `seeking` 永远为 `true`、`readyState=1`、位置一动不动 —— 而且**熄屏前就已经不动了**
    （探针在亮屏状态下先播 2.5 秒，那 2.5 秒也是 0 前进，说明与锁屏无关）。
    这是踩坑 53 的同一类问题（反复 seek / 反复探测把媒体栈拖死）在模拟器上的表现。
    **处理办法：`adb shell am force-stop com.dsh.listeningplayer` + 重新 `am start`，立刻恢复。**
    诊断脚本：`node tools/probe-device.js --eval-file=tools/probe-audio-diag.js`
    （它会打印 `paused / currentTime / readyState / networkState / error.code / seeking` 并盯 6 秒）。
    **教训**：保活用例失败时，先看「没熄屏时音频走不走」，再决定要不要怀疑 `PlaybackService`。

### 第 11 轮（竖屏 / 分辨率）—— 全是布局与「僵尸选择器」

62. **`overflow-x: auto` 在手机上等于「把按钮删了」**。用户说「更多点不动」，
    其实那个按钮在 450 px 视口里 `rect.left = 506`，**压根没画在屏幕上**。
    桌面能横向滑、有滚动条提示；手机上滚动条被 `scrollbar-width: none` 藏了，
    用户不知道要滑，只知道按钮没了。
    → **窄屏一律换行（`flex-wrap: wrap`），永远不要用横向滚动藏东西**。
    顶栏这种地方还要再进一步：把次要按钮搬进「更多 ▾」菜单（`layoutTopbar()`），
    让主行永远放得下。
63. **同一个 UI 状态绝对不要有两个类**。题目面板曾经同时有 `.no-qpanel`（顶栏按钮在用）
    和 `.mobile-qpanel-open`（浮动按钮在用）。宽屏下两者互不干扰，所以一直没暴露；
    窄屏下点顶栏按钮只是把 `display` 变回 `flex`，`transform: translateX(102%)`
    还把它停在屏幕外 —— 面板"开着"，用户什么也看不见，于是报「收起来就打不开」。
    → 一个状态源（`state.qpanelOpen`）+ 一个 setter（`setQPanel()`），
    两种布局的差异只写在 CSS 里。
64. **写了 CSS 选择器一定要确认元素真的在里面**。`#sheetBackdrop` 被写在 `.app`
    **外面**，而样式是 `.app.mobile-qpanel-open .sheet-backdrop` ——
    选择器永远不成立，**遮罩从第 8 轮加进来就是死代码**，
    "点空白处关抽屉"从来没生效过，而且不会有任何报错。
    → 现在 `test.js` 里有一条静态断言盯着「遮罩必须在 `#qpanel` 之后、`#rawDrawer` 之前」。
65. **z-index 是要排队的，不是随便写个 60**。`.drawer`（原文/原题/设置等模态）是 60，
    浮动开关 ☰ / 📝 是 66 —— 竖屏下两个圆按钮就浮在设置面板上面挡字。
    现在：遮罩 65 < 浮动开关 66 < 侧栏/题目抽屉 70 < 模态抽屉 80。
    → 加新的浮层时**先看一眼这条队**。
66. **别用 `vh` 给滚动内容留上下空白**。原文区原来 `padding: 42vh 34px 46vh`：
    竖屏 776 px 高时是 326+357 px 留白（还行），
    横屏手机只有 400 多 px 高、滚动区才 200 多 px，**光留白就 88vh，当前句直接被顶出可视区**。
    → 改成 `syncLyricPad()` 按**滚动区自身高度**算，写进 `--lyric-pad-top/bottom`。

67. **探针在什么尺寸下跑，决定了它能发现什么 bug**。
    `probe-frontend.js` 启动无头 Edge 时没传 `--window-size`，一直在默认 **800×600** 下跑。
    它能验功能（课程列表、Range、面板文案），**但从不验布局** ——
    按钮有没有被切掉、面板开没开在屏幕里，一条都没查。
    所以第 9–10 轮"探针全绿"和"手机上好用"之间一直有个洞，用户一上手就撞了四个 bug。
    → 新增 `tools/probe-layout.js`：一次浏览器 + `Emulation.setDeviceMetricsOverride`
    切 8 种分辨率，逐个断言布局不变量；`tools/probe-interact.js`：竖屏下把每个面板点一遍，
    用 `elementFromPoint` 判断"这个按钮是不是真的点得到"（而不只是"存在"）。

68. **CDP 的合成点击不算「用户手势」，剪贴板会被拒**。
    验「复制反馈信息」时，用 `element.click()`（CDP `Runtime.evaluate` 里调）
    两条路都失败：`navigator.clipboard.writeText` 报
    `NotAllowedError: Document is not focused`（合成点击没有 transient user activation），
    `document.execCommand('copy')` 也返回 false。
    **这不代表真机上不能用** —— 换成真实触摸就好了：
    ```powershell
    # 先用 CDP 把按钮滚动到可见，取回它的 CSS 坐标
    node tools/probe-device.js --eval-file=<取坐标的脚本.js>
    # 再用 adb 发一次真实触摸（CSS 坐标 × devicePixelRatio = 设备像素）
    adb -s 127.0.0.1:7555 shell input tap 266 878
    # 最后读 toast 确认
    ```
    实测真实触摸下 toast 是「反馈信息已复制」，也就是 `writeText` 成功了。
    **另一个教训**：`copyText()` 里必须**检查 `execCommand` 的返回值**再报成功 ——
    它不抛异常不等于复制成功，直接弹「已复制」会让用户发过来一条空消息。

69. **无头 Edge 启动时会多开一个 `about:blank` 标签页**。
    写新探针时按「URL 里含 `127.0.0.1`」去挑 CDP 的 page target 会**连到空白页上**，
    症状是「视口 980px、DOM 里什么都没有」—— 看着像前端整个崩了，其实是在量错页面。
    → 只挑一个 page target，由脚本自己 `Page.navigate` 到目标地址，并核对 `document.URL`。
70. **往页面里注入的脚本是用模板字符串拼的，`\s` 会被解包**。
    `probe-frontend.js` / `probe-layout.js` 都是把一段 JS 写进模板字符串再 `Runtime.evaluate`，
    所以那段代码里：
    · 正则里的 `\s` 会被外层解包成换行转义 → 页面侧语法错误、量出来全是 `undefined`
      （要写成 `[\s\u3000]` 这类双反斜杠形式）；
    · **注释里不能出现反引号** —— 会把外层模板字符串直接截断，
      报错信息是 Node 自己的 `SyntaxError: Unexpected identifier`，很难联想到是注释干的（刚踩过）。

71. **保活用例又失败了一次，但这次是模拟器的音频时钟整个死了 —— 要学会区分三种「0.0s」**。
    第 11 轮复验时 `--keepalive` 报「熄屏 6 秒前进 0.0s」。**先别改代码**，跑
    `node tools/probe-device.js --eval-file=tools/probe-audio-diag.js` 看媒体元素的真实状态：

    | 诊断输出 | 含义 | 处理 |
    |---|---|---|
    | `error.code=2` + `seeking=true` + `readyState=1` | 媒体栈被反复 seek 拖死（踩坑 61） | `am force-stop` 重启 App |
    | `paused=false` + `readyState=4` + `err=null`，但 `currentTime` 不动 | **音频输出设备没了**，Chromium 的媒体时钟靠音频下沉驱动，没有 sink 就不走 | 见下 |
    | `paused=true` | 真的被系统掐了 | 那才是保活的问题 |

    这次是第二种：**MuMu 在没有窗口的后端进程（`MuMuVMMHeadless`）里跑，没有音频端点**。
    决定性证据是换个音频源照样不动 + 裸 `AudioContext` 也不走 —— 写个一次性脚本同时试：
    · APK 内置演示音频（普通 asset，**不经过补充包 ZIP**）
    · 补充包里的音频（走 `PackStore` + Range）
    · `new AudioContext()` 的 `currentTime`
    实测：前两个都是 `readyState=4 / err=null / 前进 0s`，`AudioContext` 1.5 秒才走 **0.032 秒**。
    → **三个一起不动 = 模拟器音频子系统的问题，与 App 无关**，去改 `PlaybackService` 是白费功夫。
    让 MuMu 带上窗口跑（或换真机）音频就回来了。

72. **设备熄屏时 WebView 会被挂起，CDP 端口不应答 —— 探针会死等**。
    真机（无线调试）跑 `probe-device.js` 时挂满 10 分钟超时，原因就是平板自动锁屏了。
    和踩坑 58（adb 掉线干等）是同一类问题，只不过这次卡在 HTTP 而不是 adb：
    `fetch('http://127.0.0.1:9333/json/list')` 没有超时，设备睡着后这个请求**永远不回**。
    → 现在加了 `AbortSignal.timeout(3000)`，并且连不上时**明确告诉你"设备可能熄屏了"**
    以及唤醒/解锁的命令，而不是抛一句「没找到可调试的页面」让人去猜。
    跑真机探针前先唤醒并解锁（`input keyevent 224` + 上滑 + 密码 + `keyevent 66`）。
    **无线调试还有一条**：屏幕长时间关着时，个别机器会把无线调试的 TCP 连接也断掉，
    重新 `adb connect` 一下即可。

### 数据解析
43. **剑桥文件名里的书号有陷阱**：`剑雅真题1-20` 合集的文件名形如 `69.18.C 03-Test 01`，`C 03` 是**合集内编号不是书号**，真书号看最前面的序号（`序号=(书号-1)*4+Test`）。而 `剑雅真题1-19` 合集的 `C 19-Test 01` 里 `C 19` 才是真书号。
44. **媒体格式要按内容嗅探，不信扩展名**：有些 `.mp3` 实际是 MP4 容器（魔数 `ftyp`）。SAPI 写的 WAV 是 **18 字节 fmt chunk**，不能假定 44 字节头。

---

## 七、版权立场（**重要，别搞错**）

已经查证并写进 `docs/resources.md`：

- ✅ **可自由分发**：LibriVox（公有领域）、美国国务院 American English（公有领域）、VOA（美国政府公有领域）、LibriSpeech（CC BY 4.0）、自编演示语料（CC0）
- ⚠️ **灰色**：GitHub 上的四六级归档（上传者自称 CC BY 4.0，非考试委员会声明）——已如实标注
- ❌ **不要打包分发**：TED（CC BY-NC-ND，禁止抓取与剪辑）、剑桥雅思、《剑桥雅思》PDF 与音频、各类雅思托福练习站（实测 8 个全部 all-rights-reserved）

**用户的立场**：素材是自备的，仅个人使用。所以可以处理用户的文件，但：
- 不要在界面上把来源说成"官方授权"
- **机器转写必须明确标注**（已有紫色徽标 + 免责声明机制）
- 机翻同理，要加声明

---

## 八、待办清单（按优先级）

### ✅ 已完成（本轮）

- [x] **解析答案 PDF → 每套 40 题的题库**
  - `tools/ocr_pdf.py`（PyMuPDF 渲染 + RapidOCR + **双栏重排**）→ 17 本答案页全部 OCR
  - `tools/parse-answers.js` → 解析出 **2488/2720 题（91.5%）**
  - `tools/apply-answers.js` → 写入 68 个课程的 questions.json
  - **关键坑**：剑15 起改用 `Part N` 而非 `Section N`；两栏紧贴导致题号与答案糊在一起；
    文字层对部分书是坏的（剑10 抽取后题号全丢）
- [x] **答案 → 原文的关联**（点答案跳转的基础）
  - `tools/link-answers.js`：精确匹配 + 数字转口语 + **Section 兜底**三级策略
  - 结果：**2880 题全部有定位**（精确 825 + Section 兜底 2055，未定位 0）
- [x] **改造做题流程 UI**（做题 → 提交 → 批改 → 复盘 → 点答案跳转）
  - 两阶段状态机 `state.phase`（answering / reviewing）
  - 做题阶段**原文模糊隐藏**（`.exam-hidden` + `#examVeil` 提示卡）
  - 提交时未答完会二次确认；批改后显示对错、正确答案、解析
  - **点答案跳转**：`.q-jump` → `jumpToLine()` → 滚动 + 闪烁 + 从该行时间戳播放
  - 已用探针验证：3/3 跳转成功，进度条正确跳到 230s
- [x] **自定义板块：四件套导入**
  - 前端导入抽屉（`#importDrawer`）+ 服务端 `POST /api/import`（`lib/import.js`）
  - 支持音频/原文/解析/原题；缺时间轴时自动调 `transcribe.py`
  - 导入成功给出**可复制的提示词**（让用户拿去问大模型要逐题解析）
  - 已实测：四件套落盘正确，课程立即可用
- [x] **Section 跳转**（从原文识别 "Section/Part N" 念白，界面顶部按钮直达）
- [x] **移动端适配**（≤860px 侧栏与题目面板改抽屉式 + 浮动开关 + 触控目标加大）
- [x] 回归测试扩到 **41 项**，全过

### ✅ 已完成（第 2 轮）

- [x] **机翻 + 声明**
  - `tools/translate_lrc.py`：CTranslate2 + **Opus-MT en→zh 量化模型**（仅 76 MB，纯离线，CPU int8）
  - 模型位置 `models/opus-mt-en-zh-ct2/`（来自 HF `jiangzhuo9357/opus-mt-en-zh-ct2`）
  - 不用 whisper 的 `task='translate'`：那要重跑一遍 30 分钟音频，慢且吃内存；直接翻已有 LRC 即可
  - **72/72 课程已生成 `.translation.lrc`**（约 50 句/秒）
  - 声明落在三处：① `[re:]` 元信息 ② 顶部 🌐 机器翻译 徽标 ③ 原文抽屉顶部声明
  - `lib/library.js` 用 `translationIsMachine` 区分机翻与人工译文（人工上传的不加声明）
- [x] **中英对照显示**：英文下方显示中文，`displayMode` 下拉可切「仅原文」隐藏译文
- [x] **题组指令**：从原题 PDF 抽出的题型指令（`Choose the correct letter, A, B or C.` 等）
      按题组显示在题目面板，让用户知道这组题怎么答
- [x] **题干抽取工具**：`tools/parse-paper.js` + `tools/merge-paper.js`
      （每本切出 4 个 Test、覆盖 40/40 题；把选择题字母答案配上实际选项文字）
- [x] **APK 分层打包**：`build-apk.js` 新增 `--audio-set=A,B` 只打指定素材目录
- [x] **修正一个自伤 bug**：`build-apk.js` 原本 `rmrf(BUILD_DIR)` 会清空整个 `build/`，
      把 OCR 产物（20 分钟成果）删了。现已改为只清 `build/apk/`。
      **教训：构建脚本绝不能删共享的中间产物目录。**

### P0 —— 仍需完成

- [x] ~~真机安装验证~~（第 8 轮已在 MuMu 模拟器 Android 12 上全部实测通过：
      安装、补充包 37 门课出现在列表并**从 ZIP 里直接播放**、拖动进度条、
      锁屏保活、个性化背景、学习记录）
- [ ] **换用户自己那台手机再验一遍**：装 `listening-player-lite.apk`（13 MB）→ 补充包用
      **数据线 MTP 拖拽**或 App 内「导入」（`adb push` 会弄坏中文名，见踩坑 50）→
      确认雅思 72 门课都在、进度条能拖、锁屏后继续放。
      国产 ROM 若锁屏后被杀，把 App 加进「电池 → 不优化」白名单。
- [ ] 4 本扫描 PDF 的原题 OCR（剑9/16/18/20）—— 答案页已全部 OCR 完，原题页一并处理
      （`build/ocr-listening` 已有产物，跑 `node tools/parse-paper.js json && node tools/merge-paper.js`）

### P1 —— 学习优化（用户已授权自动做）

- [ ] 生词高亮 / 点击查词
- [ ] 逐句跟读（录音对比）
- [ ] 学习进度与错题本（本地存储）
- [ ] 盲听模式（隐藏原文只留音频）
- [ ] 题组正文展示（目前题目面板只放指令，正文在 `.paper.txt` 里）

### ✅ 已完成（第 3–4 轮）

- [x] **原题 PDF 全部 OCR + 题干合并**
  - 17 本原题 OCR 完成（`build/ocr-listening`，约 50–75 秒/本）
  - `tools/parse-paper.js`：**17/17 本解析出 4 个 Test，每本覆盖 40/40 题，共 580 个题组**
  - `tools/merge-paper.js`：合并进 **64 门课**，产出 64 个 `.paper.txt`
  - 结果：**2448/2880 题有题组（85%）**，1506 题有题型指令，1023 题有选项原文
  - 588 道选择题中 296 道配到了选项文字（答案字母 → 实际内容）
- [x] **原题抽屉**：右上角「原题」按钮，可查看/复制/下载原题文本
      （表格式填空题必须看版式，光有输入框没法做）
- [x] **APK 分层打包**：`--audio-set=A,B` + `--out=xxx.apk`
- [x] 回归测试扩到 **46 项**（新增原题解析、前端一致性检查）

### ⚠️ 重要限制：单个 APK 不能超过 2 GiB

实测构建完整包失败：

```
[构建失败] File size (3164923473) is greater than 2 GiB
```

**这是 ZIP/APK 格式的硬限制**（中央目录用 32 位记录大小），不是代码问题。
本机素材合计约 3.0 GB，**物理上装不进一个 APK**。

另外从实用性看也不该这么做：装 3 GB 的包，手机要同时容纳
「下载的 APK（3 GB）」+「安装后展开（3 GB）」，至少 6 GB 空间。

**已构建的产物**：

| 文件 | 体积 | 内容 |
|---|---|---|
| `listening-player-lite.apk` | **34.6 MB** | 自编演示语料（4 门） |
| `listening-player.apk` | **1,733 MB** | 剑桥雅思 72 门（含时间轴/译文/题目） |

**其余分档命令**（按需构建）：

```bash
# 六级版（约 900 MB）
node tools/build-apk.js --audio-set=CET6-真题 --out=listening-player-cet6.apk

# 雅思 + 六级（超 2 GiB 会失败，别这么用）
# 想要"全部素材"请改用下面两种方式之一：

# 方式 A：APK 只装题面与时间轴（几 MB），音频走局域网从电脑取
node tools/build-apk.js --no-audio --api=http://192.168.1.x:4180 --out=listening-player-lan.apk

# 方式 B：分多个 APK，各装一部分（同上，装完互不冲突，需改包名）
```

**给用户的建议**：装 `listening-player-lite.apk`（34.6 MB）先体验完整功能，
需要雅思全量素材再装 1.7 GB 那个。想在手机上看六级真题，就用方式 A
（电脑开着 `node server.js`，手机连同一 WiFi）。

### ✅ 已完成（第 5 轮）

- [x] **换图标**：用户提供的插画 → `tools/make_icon.py`（PIL 解码/缩放/编码）
      生成 mdpi 48 / hdpi 72 / xhdpi 96 / xxhdpi 144 / xxxhdpi 192 全套
- [x] **手动修订原文与题目**（用户明确要求，用来兜底 OCR / 转写的错误）
  - 服务端 `lib/edit.js` + `POST /api/edit`
  - **修订写到独立的 override 文件，不覆盖机器生成的原件**：
    `<base>.lrc.override.json` / `<base>.questions.json.override.json`
    这样重跑转写或 OCR 不会冲掉手工修订，删掉 override 即可还原
  - 前端「修订」按钮 → 点文字直接改（`contenteditable`）+ 保存 / 还原 / 退出
  - 顶部显示 `✏ 已修订原文·题目` 徽标
  - **实测通过**：保存后 `editedTranscript=true` 且内容生效，还原后恢复原文
- [x] **原文审校**：`tools/polish-lrc.js`
  - **合并 Whisper 切碎的续行**：26,219 → **20,481 行（减 21.9%）**
  - 修正专有名词、英式拼写、重复词、标点：1,117 行
  - `tools/apply-polish.js` 应用（写 override），之后**必须重跑 `link-answers.js`**
    （行数变了，题目行号会错位）
- [x] **补充包机制**：`tools/build-pack.js`（打包）—— 见下

### ⚠️ 2 GiB 上限 → 改成「安装包 + 补充包」

单个 APK 有 **2 GiB 硬上限**（ZIP 中央目录用 32 位记录大小），本机素材 3.0 GB 装不下。

| 产物 | 体积 | 内容 |
|---|---|---|
| `listening-player-lite.apk` | **13.2 MB** | 完整前端 + 5 门演示课（演示音频已转 64k MP3），随手就能装 |
| `雅思听力补充包.lppack` | **1,858 MB** | 剑桥雅思 72 套（音频/时间轴/译文/题目/原题 + 课程数据） |
| `六级听力补充包.lppack` | **856 MB** | 六级真题 37 套 |
| `listening-player.apk` | 1,733 MB | （旧的整包，已被上面两者取代，可删） |

补充包就是标准 ZIP（实测 `Expand-Archive` 能正常解压），结构见 `docs/format.md` 第 6 节：

```
manifest.json            包信息（set / lessons / version / hasLibrary）
library.json             课程数据（时间轴/译文/题目/原题，App 直接读它）
audio/<目录名>/…          与项目 audio/ 完全一致
```

用 `node tools/build-pack.js --list` 看可打包的目录；
打包命令 `node tools/build-pack.js --set=IELTS-剑桥真题 --out=雅思听力补充包.lppack`。

**另外修了一个必须修的 bug**：`MainActivity` 里 `new WebChromeClient()` 没有重写
`onShowFileChooser`，导致**安卓端「导入」的文件选择器根本打不开**。
已实现完整的文件选择回调（`ValueCallback<Uri[]>` + `onActivityResult` + 必要的 import）。

### ✅ 已完成（第 12 轮）：改名 Whale Lite + 发到 GitHub

| 做了什么 | 细节 |
|---|---|
| **App 显示名 → Whale Lite** | 第 10 轮那套流程再走一遍（见踩坑 60）。`strings.xml` 的 `app_name`、`index.html` 的 `<title>` 与侧栏品牌、`app.js` 的通知兜底标题与导出文件名、`PlaybackService` 的通知标题与渠道描述、`launcher.ps1` / `server.js` 横幅、README / HANDOFF。**包名 `com.dsh.listeningplayer` 与项目目录 `listening-player` 照旧不动** |
| **交付目录改名** | `圣元英语BB机-手机版` → **`Whale-Lite-手机版`**（`tools/paths.js` 的 `MOBILE_DIR` 是唯一引用点） |
| **反馈渠道 → 仓库 Issues** | `FEEDBACK_QQ` 删掉，换成 `FEEDBACK_URL = https://github.com/yan-gck/Whale_Lite/issues`；界面上是真 `<a target="_blank">`（不是 button），PC 新开标签页、手机交给系统浏览器 |
| **修了一个会变新 bug 的地方** | WebView 原来**没有重写 `shouldOverrideUrlLoading`** —— 手机上点外链会让 WebView 自己导航过去，**整个 App 界面被网页顶掉**，只能靠返回键退回。已在 `MainActivity.AssetClient` 里补上：非 `file://` 的链接一律 `ACTION_VIEW` 交给系统浏览器 |
| **版本号** | `APP_VERSION` 1.2 → **1.3**，清单 `versionCode` 3→4 / `versionName` 1.3（`test.js` 里有断言盯着两边一致） |
| **发到 GitHub** | <https://github.com/yan-gck/Whale_Lite> |

**仓库里带什么 / 不带什么**（`.gitignore` 写得有注释，改之前先读）：

```
带：  全部源码（public/ lib/ tools/ android/ server.js）
      audio/CET6-真题/（856 MB，用户明确要求）
      audio/*-演示/ 四套自编语料（CC0）+ audio/_cet6-raw/ + audio/_timings/
不带：audio/IELTS-剑桥真题/（1.86 GB，剑桥版权，docs/resources.md 明确不可再分发）
      transcripts/（剑桥音频的转写，衍生内容）
      build/（含 OCR 出来的剑桥原题与答案，同样是版权内容）
      models/ node_modules/ *.lppack *.apk
      audio/{AmericanEnglish,VOA,LibriVox,LibriSpeech-句子精听}/（公有领域，但 254 MB，
        想带上就删掉 .gitignore 里那四行；不带的话用 tools/fetch-resources.js 现下）
```

实测提交体积 **727 MB / 536 个文件**，最大单文件 67.6 MB（`2024年12月-第1套.mp3`）。
GitHub 单文件上限 100 MB，所以能推；但有 3 个文件 >50 MB，push 时会打**警告**（不是错误）。

> **改名脚本**：`build/_rename.js`（临时脚本，已删）。思路是**先换带后缀的长串、再换通用名**，
> 否则「Whale Lite-手机版」这种半截结果会出现 —— 这个顺序反了很难查。
> 以后再有改名需求，照这个思路写，别用编辑器全局替换。

### ✅ 已完成（第 11 轮）：竖屏 / 窄屏 / 不同分辨率的交互大修

用户一次性报了四条 + 一个需求，**四条全是真 bug，而且根因各不相同**。
这轮最该记住的不是修法，而是**为什么之前没发现**（见最后一段）。

| 用户原话 | 真正的根因 | 修法 |
|---|---|---|
| **「更多」点不动** | `.topbar-actions` 是 `overflow-x: auto` + 藏掉滚动条。450 px 宽的手机上按钮总宽 429 px、可用只有 236 px，**「原文 / 更多 / 设置」被推到屏幕外**（`btnMore` 的 rect.left = 506 > 视口 450）。"能横向滑" 在桌面能凑合，在手机上等于没有 —— 用户根本不知道要滑 | 顶栏改成「标题一行 + 按钮一行」两行布局，按钮 `flex-wrap: wrap` 换行、**彻底取消横向滚动**；再加 `layoutTopbar()`：窄屏把「原题 / 原文」搬进「更多 ▾」菜单，宽屏搬回来。搬的是真节点，事件监听跟着走 |
| **题目收起来之后无法再展开** | 面板有**两个互不相干的状态类**：顶栏「题目」/Q 键/练耳朵用 `.no-qpanel`，浮动 📝/遮罩/批改用 `.mobile-qpanel-open`。宽屏下两者恰好不冲突；窄屏下点顶栏「题目」只是把 `display` 变回 `flex`，而 `transform: translateX(102%)` 还把它停在屏幕外 —— **面板"开着"但你什么也看不见** | 只保留一个状态源 `state.qpanelOpen` + 一个函数 `setQPanel()`，两个入口都走它；窄屏靠 `translateX` 收、宽屏靠 `display:none` 收，由同一段 CSS 表达。另在抽屉里加了明确的 ✕ 关闭按钮 |
| **不同分辨率 UI 会乱** | 断点只有 860/1180 两个，450 px 宽时顶栏溢出、原文区留白写死 `42vh/46vh`（横屏手机上滚动区才 200 多 px，光留白 88vh，当前句直接被顶出可视区） | 顶栏两行化；原文留白改由 `syncLyricPad()` 按**滚动区自身高度**算（`--lyric-pad-top/bottom`）；新增 `@media (max-width: 520px)` 与 `@media (max-height: 520px)` 两段 |
| **竖屏交互处处是 bug** | 顺藤摸瓜又逮到两条：① **遮罩从加进来那天起就是死代码** —— `#sheetBackdrop` 写在 `.app` **外面**，而 CSS 用的是 `.app.mobile-qpanel-open .sheet-backdrop`，选择器永远不成立，所以"点空白处关掉抽屉"从来没生效过；② `.drawer` 的 `z-index` 是 60，比浮动开关的 66 **还低**，竖屏下 ☰ / 📝 会浮在设置面板上面挡住文字 | 把 `#sheetBackdrop` 挪进 `.app`（`position: fixed` 脱离文档流，不会挤压三栏布局）；`.drawer` 提到 80；浮动开关位置改成 `calc(var(--player-h) + 12px)`（竖屏播放器会换行成 4 行，"写死 bottom: 132px" 必然压住按钮） |
| **要一个 bug 反馈渠道** | — | 设置面板新增「遇到问题？」一节：QQ **271311374** 大字显示 + 「复制反馈信息」按钮，复制内容含版本号 / 屏幕尺寸与布局模式 / 当前课程 / 运行环境（`navigator.userAgent`，不含任何个人信息）。「更多 ▾」菜单里也加了「问题反馈」直达入口 |

**顺带修的**（不修的话下次构建会莫名其妙失败）：
`build-apk.js` 里 `findJavaHome()` 找得到 `F:\JAVA`，但**没把它导出到子进程环境**。
`d8.bat` / `apksigner.bat` 自己不找 java，只看 `JAVA_HOME` 和 `PATH` ——
于是构建成不成功取决于"调用它的那个 shell 恰好有没有 JAVA_HOME"，
实测中途突然报 `JAVA_HOME is not set and no 'java' command could be found`。
现在找到 JDK 后立刻 `process.env.JAVA_HOME = javaHome` 并把 `bin` 塞进 `PATH`。

**为什么这四个 bug 能活到现在 —— 这才是重点**：

> `tools/probe-frontend.js` 启动无头 Edge 时**没传 `--window-size`**，
> 于是它一直在默认的 **800×600** 下跑。800 px 刚好落在 860 断点以内，
> 探针看到的是"窄屏布局"，但**它从来只检查功能、不检查布局** ——
> 按钮有没有被切掉、面板开没开在屏幕里，一条都没验。
> 所以「构建成功、探针全绿」和「手机上好用」之间一直有个洞。

新增 `tools/probe-layout.js`（多种分辨率 + 布局不变量）与
`tools/probe-interact.js`（竖屏交互全扫）专门堵这个洞，见下面的工具表。

**第 11 轮的实测结果**（全部通过）：

| 检查 | 结果 |
|---|---|
| `node tools/test.js --http` | **80/80 项通过**（新增 7 项布局/抽屉/反馈/A-B 的静态断言） |
| `node tools/probe-layout.js` | **8 种分辨率全过**：360×640 / 390×844 / **450×776（MuMu 竖屏）** / 800×360（手机横屏）/ 768×1024（平板竖屏）/ 1024×768（平板横屏）/ 1280×800 / 1920×1080 |
| 负向测试（证明探针不是空转） | 临时往构建产物注入 `overflow-x:auto + flex-wrap:nowrap + min-width:900px` → 探针立刻报「按钮右边出屏 right=3633 > 视口 360」「顶栏横向滚动 scrollWidth=3622 > clientWidth=338」并 exit 1 |
| `node tools/probe-frontend.js`（默认 / `--no-packs` / `--bad-pack`） | ✅ 全部通过（连跑两次，顺手修掉了拖动用例的偶发假失败） |
| `node tools/probe-device.js --eval-file=tools/probe-interact.js` | **竖屏交互全扫全部通过**：顶栏 5 个按钮、更多菜单 6 项、「☰/📝」两个浮动开关、侧栏、题目抽屉（顶栏入口 + 浮动入口 + ✕ + 遮罩）、《原文》《原题》《设置》《补充包》《导入》五个模态、模式切换，逐个用 `elementFromPoint` 验「真的点得到」 |
| `node tools/probe-device.js` | 42 门课 = 5 演示 + 37 六级补充包，`audioError: null`，补充包校验 ok |
| **真机：HONOR HEY2-W09 平板（Android 14 / 1600×2560 @340dpi）** | |
| ↳ 竖屏 753×1173（窄屏布局） | 顶栏两行、5 个按钮全可见；`probe-interact.js` **竖屏交互全扫全部通过**（顶栏/更多菜单 6 项/☰/📝/侧栏/题目抽屉三入口/5 个模态/模式切换） |
| ↳ 横屏 1205×721（宽屏三栏） | **6 个按钮一行放下**（原题/原文自动从「更多」搬回顶栏），三栏布局正常，A-B 按钮按需隐藏；截图 `build/tablet-landscape.png` |
| ↳ `--keepalive` | ✅ **真机锁屏保活通过**：熄屏 6 秒音频前进 **6.2s**，MediaSession `state=PLAYING(3)`，`PARTIAL_WAKE_LOCK listening-player:playback` 持有中 |
| ↳ 截图 | `build/tablet-portrait.png`（竖屏）、`build/tablet-landscape.png`（横屏） |

> **平板怎么连的（USB 驱动被占，走的无线调试）**：这台平板的 USB 复合设备被 `libusbK`
> 驱动占着（以前有工具装过 Zadig 之类），Windows 根本没枚举出 ADB 接口，`adb devices` 看不见它。
> 改用**无线调试**：`adb pair <IP>:<配对端口> <配对码>` 成功后，再用 `adb connect <IP>:<连接端口>`。
> ⚠️ **配对端口和连接端口是两个不同的端口**，配对对话框上给的那个配完就关了；
> 屏幕上「无线调试」主界面另写了一个。这次只拿到配对端口，于是写了个一次性端口扫描脚本
> 扫出 6 个开放端口，逐个 `adb connect` 试出来的（`node build\_scan-adb.js <IP>`，约 24 秒）。
> **下次直接跟用户要「无线调试主界面上那一行 IP 地址和端口」，比扫端口快。**
>
> 同时给 `probe-device.js` 加了 **`--serial=`** 参数：模拟器和真机同时插着时指定探哪一台
> （默认仍优先 MuMu 的 `:7555`）。用法：`node tools/probe-device.js --serial=10.131.191.231:37463 --keepalive`。
>
> 另外 HONOR 的两个小坑：① **熄屏后设备会进锁屏**，此时 `adb install` 会因为确认弹窗
> 显示不出来而报 `INSTALL_FAILED_ABORTED: User rejected permissions` —— 先
> `input keyevent 224` 唤醒 + 上滑 + `input text <密码>` + `input keyevent 66` 解锁再装；
> ② 装完可能停在 HONOR 自己的「应用权限」页，`input keyevent 3` 回桌面即可。
| 真机竖屏截图 | `build/round11-portrait.png`（450×776，顶栏一行放下 5 个按钮） |
| 复制反馈信息（`adb shell input tap` 真实触摸） | toast「反馈信息已复制，粘贴到 QQ 聊天窗口即可」 |

> **踩到的两个新坑**（都记在第六节）：CDP 的合成点击不算用户手势，剪贴板一律被拒
> （踩坑 68）；`probe-frontend.js` 的拖动用例没等音频元数据，偶发四条一起假失败
> （已加等待循环修掉 —— **不稳定的探针比没有探针更糟**）。

**顺带瘦身：窄屏播放器少占一行**（用户确认要收）。
「设置循环终点 / 清除循环」在没设起点之前是死按钮，却在竖屏上占掉一整行。
现在由 `updateLoopUI()` 切 `.app.has-ab` 控制显隐 —— **只改 display，不从 DOM 摘掉**
（快捷键、探针、学习记录都按 id 找它们）。实测竖屏 450×776：
播放器 **235px → 200px**（占屏 30% → 26%），点「设置循环起点」两个按钮立刻出现，
点「清除循环」又收回去。`test.js` 里加了断言盯着这条。

### ✅ 已完成（第 10 轮）：App 显示名改为「Whale Lite」

用户要求把 App 显示名从「听力播放器」改成 **Whale Lite**。
改的范围是**所有用户看得见的地方**：

| 位置 | 改了什么 |
|---|---|
| `android/res/values/strings.xml` + `AndroidManifest.xml` | 新增 `app_name` = Whale Lite；清单的 `android:label` 从写死的字面量改成引用 `@string/app_name`（以后改名只动一个文件） |
| `public/index.html` | 网页标题、侧栏品牌、补充包教程里提到的交付目录名 |
| `public/app.js` | 通知兜底标题（`setPlaybackState` 的默认 title）、学习记录导出的文件名与说明 |
| `android/.../PlaybackService.java` | 常驻通知的默认标题、通知渠道描述 |
| `android/.../MainActivity.java` | 文件头注释 |
| `tools/launcher.ps1` | 电脑端启动横幅 |
| **`server.js`** | **控制台横幅 `🎧 听力播放器已启动` → `🎧 Whale Lite 已启动`**（**第 10 轮漏了，本次补上** —— 见下） |
| 交付目录 | `听力播放器-手机版` → **`Whale-Lite-手机版`**（涉及 `tools/paths.js` 的 `MOBILE_DIR`、`build-apk.js`、`build-pack.js`、`打包APK.bat`） |

> **第 10 轮漏掉的一处**：`tools/launcher.ps1` 的横幅改了，但 `server.js` 自己还有一条启动横幅
> （`server.listen` 回调里那句 `console.log('  🎧  听力播放器已启动')`）。
> 双击 bat 时两条会**前后脚打出来**，新人名下面紧跟着旧名字，很难看。
> **教训：搜旧名字要连「控制台输出」一起搜**，别只看 `.md` / `public/` / `res/values/`。
> 现在的搜索范围应该包含 `*.js` 根目录（`server.js`、`lib/*.js`）与 `tools/*.ps1`。

**刻意没改的三样**（改了的代价远大于收益）：

| 保持原样 | 为什么不能动 |
|---|---|
| 包名 `com.dsh.listeningplayer` | 改了就是**另一个 App**：手机上已装的版本不会升级而是并存一份；`/sdcard/Android/data/com.dsh.listeningplayer/files/packs/` 里已有的补充包（模拟器上那份 856 MB）也读不到了 |
| 项目目录 `listening-player` | 构建脚本会写临时 `.bat`，**路径必须保持 ASCII**（中文路径会被 cmd 解析坏，踩坑 1）；文档里所有命令、脚本里的路径都要跟着重写 |
| 补充包目录名与包内路径 | 同上：`audio/<目录名>/…` 是补充包的内部契约，动了旧的 `.lppack` 全部失效 |

> ⚠️ **提醒（搜代码时两边都要搜）**：界面上叫「Whale Lite」，**技术标识仍然是 `listening-player`** ——
> 包名 `com.dsh.listeningplayer`、项目目录、JS 桥 `AndroidHost` 所在的命名空间、
> 以及交付目录里的 `listening-player-lite.apk` 都没改名。
> `public/style.css` 的文件头注释里还留着「听力播放器 · 样式」，那是代码注释、用户看不见，**故意留着**。

**改名后怎么验的**（这套顺序以后改名/改清单都要再走一遍）：

```powershell
cd "F:\DSH workshop\listening-player"
node tools/test.js --http                          # 73/73 全过
node tools/build-apk.js --audio-set=CET4-演示,CET6-演示,IELTS-演示,TOEFL-演示
node tools/verify-apk.js                           # 默认找 Whale-Lite-手机版\listening-player-lite.apk
node tools/probe-frontend.js                       # 再加 --no-packs / --bad-pack 各一次
# 装到设备上（一律 install -r，卸载会连带删掉手机里 856 MB 的补充包）
& "F:\DSH workshop\android-sdk\platform-tools\adb.exe" -s 127.0.0.1:5555 install -r "F:\DSH workshop\Whale-Lite-手机版\listening-player-lite.apk"
node tools/probe-device.js                         # 真机体检：42 门课 = 5 演示 + 37 六级补充包
node tools/probe-device.js --keepalive             # 锁屏保活：熄屏 6 秒音频应继续前进
```

**换名要查两份清单**（改名后漏改多半就漏在这两处）：
① 清单 `AndroidManifest.xml` 的 `application/@label`（这次已改成 `@string/app_name`，源码里不再有字面量）；
② 前端 `index.html` 的 `<title>` 与侧栏品牌 —— 网页标题在 WebView 里不显示，但**任务切换器与浏览器里显示的是它**。

**第 10 轮改名后的实测结果**（全部通过）：

| 检查 | 结果 |
|---|---|
| `node tools/test.js --http` | **73/73 项通过**（补完 `server.js` 横幅后又跑了一遍，仍 73/73） |
| `node tools/build-apk.js --audio-set=…` | 成功，13.2 MB，落到 `Whale-Lite-手机版\` |
| `aapt2 dump badging` | `application-label:'Whale Lite'`（包名仍是 `com.dsh.listeningplayer`） |
| `aapt2 dump resources` / `dump strings` | 资源表与 dex 里都有 `Whale Lite`；PlaybackService 的渠道描述 `Whale Lite 的后台播放控制` 也在 |
| `node tools/verify-apk.js` | 44 项全过（含清单前台服务类型 = mediaPlayback） |
| `node tools/probe-frontend.js` | ✅ 全部通过（114 门课 = 5 演示 + 109 补充包） |
| `… --no-packs` | ✅ 全部通过（5 门演示课，面板给出「还没有补充包」） |
| `… --bad-pack` | ✅ 全部通过（坏包行显示「这是旧版补充包（没有 library.json）…」） |
| `adb install -r` | Success（**数据保留**，手机里 856 MB 的 `cet6.lppack` 没动） |
| `node tools/probe-device.js` | **42 门课 = 5 演示 + 37 六级补充包**，音频时长 1602s，补充包 `cet6.lppack` 校验 ok |
| 真机 DOM | `<title>` = `Whale Lite · 四六级 / 雅思 / 托福`；侧栏 `.brand` = `Whale Lite`；全页搜不到旧名 |
| 真机常驻通知 | 渠道 `playback` 名 `播放控制`、有描述；标题为课程名；四个按钮「上一句/暂停/下一句/停止」齐全 |
| `node tools/probe-device.js --keepalive` | ✅ 熄屏 6 秒前进 **6.1s**，MediaSession 保持 `state=3`，`PARTIAL_WAKE_LOCK listening-player:playback` 持有中 |
| 截图 | `build/round10-brand.png`（模拟器 2560×1440，侧栏品牌已显示新名） |
| 桌面端启动横幅 | 用 `PORT=4199` 起一次性实例抓输出：`🎧  Whale Lite 已启动` / 已发现课程 273 个 |
| 旧名残留复查 | 项目内（排除 `audio/`、`build/`）已无「听力播放器」**用户可见**文案；只剩 2 处代码注释（`public/style.css:2` 文件头、`server.js:3` 文件头）与 2 处泛指措辞（`docs/resources.md`、`docs/sources-manual.json` 里「做听力播放器必然要切片」，说的是品类不是本 App） |

> 第一次跑 `--keepalive` 曾报「前进 0.0s」—— 查下来是探针跑多了把 WebView 媒体栈拖死，
> **不是改名引入的问题**（详见踩坑 61）。`force-stop` 重启 App 后即恢复。


### ✅ 已完成（第 9 轮）：两种模式 + 一批交互与文案问题

用户反馈的问题（都已在真机上复现/修复/验证）：

| 问题 | 原因与修法 |
|---|---|
| 拖动进度条后播放停住，但按钮还停在 ⏸ | 以前**每来一次 mousemove 就写一次 `audio.currentTime`**，一条进度条能拖出几十次 seek，WebView 媒体栈在连续 seek（每次重发 Range 请求）时容易卡住，而且 `pause` 事件不保证送达页面。现在：拖动中**只预览**（气泡显示目标时间，不碰播放位置），**松手才 seek 一次**；松手前若在播放、松手后被掐断则**自动续播**；再加一个**卡顿看门狗**（3 秒不动 → 重新 play → 再不行就重新 load 并跳回原位置） |
| 播放按钮状态不同步 | 按钮文案改成每个周期都从 `audio.paused` 推导（`syncPlayButton()`），不再只依赖 play/pause 事件 |
| `⟲5` / `5⟳` 看不懂 | 改成 **`−5s` / `+5s`**（title 里写全「后退 5 秒 (←)」）。第 12 轮按用户要求把「秒」缩成 `s`，窄屏上按钮也更短 |
| 「设 A / 设 B / 清 A-B」看不懂 | 改成 **「设置循环起点 / 设置循环终点 / 清除循环」**；读数显示成 `循环 00:12 → 00:30`；设完终点自动切到区间循环；循环下拉里叫「循环 A→B 区间」 |
| 补充包说明像开发文档 | 面向用户的话改成「补充包是**批量导入听力材料**的包：一个文件里装着一整套课程（音频 + 原文 + 译文 + 题目）」，技术细节（2 GB 上限、为什么要拆包）与**制作教程**折叠进两个 `<details>` 里 |
| 侧栏品牌（第 10 轮前还写着「听力播放器」）左边那个 `⇤` 点了回不去 | 那是收起侧栏的按钮，而它自己就在侧栏里 —— 收起来就再也点不到。现在图标改成 `«` + 明确 title，并在侧栏收起时显示一个浮动 `»` 按钮可以展开回来 |
| 顶栏按钮被挤出屏幕 | 按钮一多，窄屏上就横向滚出去了（相当于藏起来）。把素材整理类功能（修订/导入/补充包）收进**「更多 ▾」菜单**，主栏只留 实战·练耳朵 / 原题 / 题目 / 原文 / 更多 / 设置 |
| 原文区太矮 | 元信息（有的课 source/notes 是整段话）把标题栏撑到 **202 px**，原文区只剩 199 px，还被续听条盖住。现在元信息逐条截断成一行（悬停看全文），续听条改成**独立一行**不压正文 → 标题栏 99 px、原文区 302 px（横屏实测） |

**新增两种模式**（右上角切换，记在设置里）：

- **实战**：原来的流程 —— 先作答，提交后才给原文与答案。
- **练耳朵**：不做题。流程条与遮罩整条收走，原文直接跟着音频滚动；
  题目面板默认收起（点「题目」还能翻出来对照，答案直接给、输入框只读、点选项不会被记成作答）；成绩也不记（本来就没作答）。

### ✅ 已完成（第 8 轮）：真机实测 + 个性化 / 人性化

用户开了一台 **MuMu Player 12 模拟器**（Android 12 / SDK 32 / x86_64 / WebView 110），
这一轮所有改动都在真机上跑过。**第一次装上去就发现 APK 根本装不了** —— 之前所有轮次
的「构建成功」都是在没有真机的情况下自说自话。

**这台模拟器怎么连**（下次直接用）：

```bash
# MuMu 自带 adb 在 E:\MuMu Player 12\nx_main\adb.exe，端口 7555/5555
"F:\DSH workshop\android-sdk\platform-tools\adb.exe" connect 127.0.0.1:7555
node tools/build-apk.js --audio-set=CET4-演示,CET6-演示,IELTS-演示,TOEFL-演示 --out=listening-player-lite.apk
"F:\DSH workshop\android-sdk\platform-tools\adb.exe" -s 127.0.0.1:5555 install -r listening-player-lite.apk
node tools/probe-device.js                    # 体检：课程数 / 音频地址 / 时长
node tools/probe-device.js --keepalive        # 锁屏保活：熄屏 6 秒看音频是否还在走
node tools/probe-device.js --shot out.png     # 截图
node tools/probe-device.js --eval "表达式"     # 在真实 WebView 里跑任意 JS
```

**真机暴露的四个致命 bug（桌面上 100% 复现不出来）**：

| # | 症状 | 根因 |
|---|---|---|
| 1 | `adb install` 直接失败：`-124 … resources.arsc … must be stored uncompressed and aligned` | 自写 ZIP 重打包把所有条目都 deflate 了。targetSdk ≥ 30 时 Android 11+ 强制要求 `resources.arsc` 未压缩且 4 字节对齐 |
| 2 | 就算装上，音频也播不出、进度条拖不动 | 同一处 deflate 把 assets 里的音频也压了，而 `MainActivity` 是用 `getAssets().openFd()` 定位字节区间的 —— 压缩资源拿不到 FileDescriptor |
| 3 | App 打开是**死的**：没有样式、没有脚本，课程列表永远空白 | `index.html` 里写的是 `/app.js` `/style.css`。在 `file:///android_asset/www/` 页面里，根路径会被解析成 `file:///app.js`（**不是** assets 根目录），请求失败且不经过拦截器 |
| 4 | 按播放键约 0.1 秒后自动暂停 | 网页 `<audio>` 播放时 Chromium 自己申请音频焦点，我的 `PlaybackService` 又申请了一次 → 自己跟自己抢，Chromium 被判 `AUDIOFOCUS_LOSS` 后立刻暂停 |

修法：`build-apk.js` 保留 aapt2 原本的压缩方式 + 强制 `resources.arsc` STORED，
并在**打包后自检**（成品不对就直接让构建失败）；`index.html` 全改相对路径；
`PlaybackService` 彻底不碰音频焦点（交给 Chromium）。

**顺带把 APK 从 51 MB 压回 13 MB**：音频必须不压缩存放，而演示语料原本是 WAV（51 MB）。
新增 `tools/wav-to-mp3.py`（PyAV + libmp3lame，64k 单声道）→ 12.9 MB，音质对语音足够，
时间轴不受影响（LRC 与容器无关）。

### 🎨 个性化（用户点名的需求）

**自定义 App 背景** + 一整套外观设置（右上角「设置」）：

- 上传自己的图当背景（**本机处理**：canvas 缩到 1920×1200 再存 data URL，一般几十 KB，
  不会撑爆 localStorage 的 5 MB 配额；不上传任何地方）
- 6 套预设渐变背景（极光/深海/森林/暮色/暖纸/无）
- **暗化 / 模糊 / 面板透明度** 三个滑杆 —— 图片再花也能把字看清
  （主读区比周围面板再暗 15%，`calc(var(--panel-alpha) + 0.15)`）
- 5 种主题色（森林绿 / 深海蓝 / 暖阳橙 / 樱花粉 / 紫罗兰）→ 改 `--accent` 系列变量
- 原文字号 14–30px（手机通勤时很实用）

⚠️ 一个必须守住的细节：**达标绿不能用主题色变量**。用户要求「正确率 ≥60% 显示绿色」，
如果 `.accuracy.good` 用 `var(--accent)`，选橙色主题后它就不是绿的了。
现在固定用 `--ok: #4ade80`，测试里专门盯着（探针抓到了这个回归）。

### ❤️ 人性化（这一轮自己加的）

| 功能 | 说明 |
|---|---|
| **断点续听** | 每门课记住听到哪儿；课程列表显示「上次 05:01」；打开时自动回到上次那门课并接着放（可关）。歌词区底部有「继续听 / 从头开始」小条 |
| **学习记录** | 每门课记正确率与次数，**直接显示在课程列表上**（≥60 绿 / <60 红，与批改同一套判定）；可导出 JSON、可清空 |
| **睡眠定时** | 关闭 / 10-60 分钟 / 播完本课；倒计时显示在播放条右侧，睡前听不用怕睡着后放一宿 |
| **习惯记忆** | 倍速、显示模式、自动滚动、听写模式、复读模式、字号、背景、主题色、面板透明度全部记住，下次打开还是这套 |
| **快捷键帮助** | 「设置」面板里有完整快捷键表，按 `?` 直接打开 |

再加一件：`WebView.setWebContentsDebuggingEnabled(true)` —— 没有它，真机上出问题只能靠猜
（WebView 里的报错、DOM、localStorage 全看不见）。`tools/probe-device.js` 就是靠它工作的。

### ✅ 已完成（第 6 轮）：App 能自己读补充包了

原来「装了 lite APK 只能听 5 门演示课」的最后一环已经补上：

| 层 | 做了什么 |
|---|---|
| 包格式 | 补充包升到 **v2**：多了 `library.json`（桌面端扫描结果的快照，雅思包 6.6 MB / 六级 1.8 MB）。App 直接读它建课程列表，手机上的时间轴/译文/题目与电脑端**同源**，不必在 Android 侧再解析 LRC |
| Android | 新增 `PackStore.java`（发现/校验/读取/导入/删除，只用 `java.*`）、`HttpRange.java`、`Streams.java`；`MainActivity` 加了补充包 URL 空间与 JS 桥 `AndroidHost` |
| 前端 | bundle 模式下载入所有补充包的课程并合并进列表（带 📦 徽标）；`assetUrl()` 支持包内路径；新增「补充包」面板（已安装列表 / 失败原因 / 目录路径 / 导入按钮 / 进度条） |
| 工具 | `tools/pack-info.js`（查看+校验包）、`tools/verify-apk.js`（APK 成品自检）、`tools/probe-frontend.js`（无头浏览器验前端） |

**同轮补上的小功能：批改后显示正确率**

用户要求：提交批改后显示正确率，**≥60% 绿色、<60% 红色**。实现要点：

- `accuracyOf(right, total)` 是纯函数，返回 `{ pct, level: 'good'|'bad', pass }`，
  分界线抽成常量 `PASS_RATE = 60` —— 三处显示（顶部流程条、题目面板横幅、提交提示语）
  共用它，避免各写一遍后不一致。
- 颜色用 `.accuracy.good`（`var(--accent)` 绿）/ `.accuracy.bad`（`var(--red)` 红），
  另有 `.grade-banner.good/.bad` 给横幅左边框与底色。
- 正确率取整（`Math.round`），`2/3 → 67%`；没有题目时回 0% 不崩。
- **60% 整好算达标**（绿），59% 算未达标（红）—— 边界在探针里有专门用例。

### ✅ 已完成（第 7 轮）：后台 / 锁屏保活

用户问「后台保活跟锁屏保活有了吗」—— 当时**完全没有**（`onPause()` 反而会 `webView.onPause()`，
等于主动让 WebView 停摆；也没有服务、没有唤醒锁、没有通知）。现在补齐了：

| 件 | 作用 |
|---|---|
| `PlaybackService.java`（新） | 前台服务（`foregroundServiceType="mediaPlayback"`）+ 常驻通知 + `MediaSession` + `PARTIAL_WAKE_LOCK` |
| 常驻通知 | 显示课程标题与「正在播放/已暂停」，三个按钮：上一句 / 播放暂停 / 下一句，另有「停止」 |
| MediaSession | 锁屏与耳机线控可用；同时申请音频焦点，别的 App 出声时自动让路（瞬时丢失会自动恢复，永久丢失不恢复） |
| 唤醒锁 | **只在播放时持有**，暂停立即释放；暂停 10 分钟无操作自动收掉服务（不留僵尸通知） |
| 屏幕常亮 | `FLAG_KEEP_SCREEN_ON` 改成跟播放状态绑定（以前是无条件常亮，暂停也亮着） |
| 权限 | 新增 `FOREGROUND_SERVICE`、`FOREGROUND_SERVICE_MEDIA_PLAYBACK`、`WAKE_LOCK`、`POST_NOTIFICATIONS`（运行时申请）。**依然没有任何存储权限** |
| 前端 | `reportPlayback()` 把状态报给 Android；`window.__onHostCommand(cmd, value)` 接住通知栏/锁屏命令 |

**关键设计：`tickControl()`**
原来「单句复读 / A-B 循环」写在 `tick()`（`requestAnimationFrame`）里，
而页面一旦不可见 rAF 就停了 —— 锁屏听听力时循环会失效，而且 `state.activeIndex` 没人维护，
会一直循环切走之前的那一句。现在循环控制独立成 `tickControl()`，挂在
`setInterval(250ms)` + `audio.timeupdate` 上，并在 rAF 停摆超过 1 秒时自己补算当前行。

**顺带修掉一个老 bug（探针抓到的）**：APK 把素材放在 `assets/www/audio/`，
而离线前端拼的是 `assets/www/<课程 id>` —— 少了一层 `audio/`。
后果是 **APK 里那 5 门演示课列表能显示、一播放就报「音频加载失败」**，
桌面上完全复现不出来（桌面走 `/media/`）。已修，并在探针里加了「演示课音频必须能按 Range 取到」的用例。

**验证方式（本机没有手机，全靠这三招）**：

1. `tools/java/PackSelfTest.java`：用电脑上的 `javac/java` 直接跑真实的 `PackStore`，
   对着**真实的 1.86 GB 雅思补充包**做了导入、整读、5 种 Range 比对、并发读、路径穿越拦截、
   坏包拒绝、删除 —— 6758 项断言全过（两秒跑完）。
2. `tools/probe-frontend.js`：无头 Edge 里跑真实前端（模拟 `AndroidHost` + 补充包 URL 空间），
   实测到 `<audio>` 真的对 `pack/<包名>/audio/…` 发了 `Range: bytes=0-` 并解出时长 26:41，
   课程列表 5 门演示 + 109 门补充包课，面板显示「已加载 37/72 门」。
   同一支探针还会**真点一遍做题流程**（100% 绿 / 4% 红、60-59 边界）、
   **真调一遍保活链路**（上报播放状态、toggle/nextLine/seek 命令、rAF 停摆时补算当前行、A-B 越界拉回）。
   **这个探针抓出过两个会毁掉手机端的 bug**（见踩坑 30 与第 7 轮那条）。
3. `tools/verify-apk.js`：在成品 APK 里核对 `classes.dex` 是否含该有的类与常量、
   `packs-catalog.json` 的中文是否完好、精简版有没有被塞回大素材，
   并用 `aapt2 dump xmltree` 反解清单确认前台服务类型是 mediaPlayback。

---

## 九、怎么继续

```bash
# 1. 确认服务在跑
cd "F:\DSH workshop\listening-player"
node server.js                      # → http://127.0.0.1:4180

# 2. 跑回归测试，确认环境没坏（含补充包读写、Java 侧真实 ZIP/Range 用例）
node tools/test.js --http           # 应 73 项全过

# 3. 看当前课程
curl http://127.0.0.1:4180/api/lessons

# 4. 改完补充包相关代码后的完整自检（前四步都不需要手机）
node tools/test.js --http
node tools/build-apk.js --audio-set=CET4-演示,CET6-演示,IELTS-演示,TOEFL-演示
node tools/verify-apk.js                               # 成品 APK 自检（默认找交付目录里的那个）
node tools/probe-frontend.js                           # 无头浏览器跑真实前端
node tools/probe-frontend.js --no-packs                # 回归：没装补充包时不能坏
node tools/probe-frontend.js --bad-pack                # 面板要能说清「为什么不能用」

# 4.5 真机（MuMu 模拟器）—— 探针要求 App 已在运行
adb -s 127.0.0.1:5555 install -r "F:\DSH workshop\Whale-Lite-手机版\listening-player-lite.apk"
adb -s 127.0.0.1:7555 shell am start -n com.dsh.listeningplayer/.MainActivity
node tools/probe-device.js                             # 体检（42 门课 = 5 演示 + 37 六级补充包）
node tools/probe-device.js --keepalive                 # 锁屏保活：熄屏 6 秒音频应继续前进
node tools/probe-device.js --boot                      # 模拟器掉线时自动拉起（约 106 秒）

# 5. 重新打补充包 / 看包内容
node tools/build-pack.js --list
node tools/build-pack.js --set=IELTS-剑桥真题 --out=雅思听力补充包.lppack
node tools/pack-info.js --all --verify
```

**新会话开工建议**：先读 `docs/format.md`（资料包格式，第 6 节是补充包）
和本文件的第六节（踩坑，第 22–33 条是补充包与调试手法），
然后从 P0 的第一项开始 —— **换用户自己的手机再验一遍**（模拟器上已经全绿了）。
写脚本时**用 `write` 写文件再执行**，不要内联。

---

## 十、用户的工作习惯（供参考）

- 用中文交流，喜欢**实测数据**和**明确的失败原因**，不喜欢含糊结论
- 明确指出过：「所有你觉得有利于人类进行语言学习的优化都自动做，不需要再问我」
- 会自己去找素材（如原题 PDF、音频），找到后放工作区让 Agent 处理
- 对版权比较在意，要求机器生成的内容必须加声明
- 要求手机端和 PC 端功能对齐

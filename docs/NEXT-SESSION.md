# 新会话提示词（第 10 轮收尾）

> 上一轮（改 App 显示名）做到一半时上下文耗尽。把下面这段整体粘给新会话即可继续。
> 本文件内容与粘贴用的提示词一致，也可以直接让新会话读这个文件。

---

## 复制以下内容给新会话

继续「Whale Lite」项目（听力播放器）。**先读 `F:\DSH workshop\listening-player\docs\HANDOFF.md`**
（完整交接文档，含全部踩坑记录），再动手。

### 环境
- 电脑版 + 全部素材：`F:\DSH workshop\listening-player`（**目录必须保持 ASCII**，构建脚本会写临时 `.bat`，中文路径会被 cmd 解析坏）
- 手机交付物：`F:\DSH workshop\Whale-Lite-手机版\`（APK + 两个 .lppack + 安装说明.txt）
- Node v24.19 · Python 3.12 · JDK `F:\JAVA` · Android SDK `F:\DSH workshop\android-sdk`
- **MuMu Player 12 模拟器**（Android 12 / SDK 32 / x86_64 / WebView 110）里已经装好 App，
  `/sdcard/Android/data/com.dsh.listeningplayer/files/packs/cet6.lppack`（856 MB 六级补充包）也在。
  模拟器会自己退出，掉线时：
  ```powershell
  node tools/probe-device.js --boot          # 自动拉起并等待（开机约 106 秒）
  # 或手动：
  "E:\MuMu Player 12\nx_main\MuMuManager.exe" control --vmindex 0 launch
  "F:\DSH workshop\android-sdk\platform-tools\adb.exe" connect 127.0.0.1:7555
  ```

### 上一轮做了什么（第 10 轮：改 App 显示名）
显示名从「听力播放器」改成 **Whale Lite**，已完成并在真机验证：
- `android/res/values/strings.xml` 的 `app_name`；`AndroidManifest.xml` 改为 `android:label="@string/app_name"`
- 前端 `public/index.html`（网页标题、侧栏品牌、补充包教程里提到的交付目录名）、
  `public/app.js`（通知兜底标题、学习记录导出文件名与说明）
- 原生 `PlaybackService.java`（通知默认标题、通知渠道描述）、`MainActivity.java`（文件头注释）
- 电脑端启动横幅 `tools/launcher.ps1`
- 交付目录改名 `听力播放器-手机版` → `Whale-Lite-手机版`
  （涉及 `tools/paths.js` 的 `MOBILE_DIR`、`build-apk.js`、`build-pack.js`、`打包APK.bat`）
- 已重新构建并装机：`aapt2 dump badging` 显示 `application-label:'Whale Lite'`；
  设备上侧栏品牌、网页标题、常驻通知、课程播放均正常（截图确认）
- **刻意没改**：包名 `com.dsh.listeningplayer`、项目目录 `listening-player`、补充包目录路径
  —— 改了会让已装的 App 变成另一个应用、手机上的补充包目录失效、文档里的命令全要重写

### 你接手要做的（就这几件）
1. **补完 `docs/HANDOFF.md`**（上一轮这次编辑因内存不足失败了）：
   - 头部「最后更新」那行 → 第 10 轮（App 显示名改为Whale Lite）
   - 新增一节「第 10 轮：改显示名」，写清改了什么、为什么包名/目录名不动，
     并加一句提醒：界面上叫Whale Lite，技术标识仍是 listening-player
2. **搜一遍旧名字**（用户可见的地方才算，代码注释可留）：
   ```powershell
   cd "F:\DSH workshop\listening-player"
   Select-String -Path docs\*.md,README.md,public\*,android\res\values\*.xml,tools\*.js,tools\*.ps1 -Pattern "听力播放器"
   ```
   文档里若还有指向旧交付目录名的路径，一并改成 `Whale-Lite-手机版`。
   （当前只剩 HANDOFF.md 里 1 处「听力播放器」，就是头部那行）
3. **改名后的全套自检**：
   ```powershell
   node tools/test.js --http                  # 应 73 项全过
   node tools/build-apk.js --audio-set=CET4-演示,CET6-演示,IELTS-演示,TOEFL-演示
   node tools/verify-apk.js                   # 默认找 Whale-Lite-手机版\listening-player-lite.apk
   node tools/probe-frontend.js               # 再加 --no-packs / --bad-pack 各跑一次
   node tools/probe-device.js                 # 真机体检：42 门课 = 5 演示 + 37 六级补充包
   node tools/probe-device.js --keepalive     # 锁屏保活：熄屏 6 秒音频应继续前进
   ```
   装机用 `install -r`（**不要 uninstall** —— 卸载会连带删掉手机里 856 MB 的补充包）：
   ```powershell
   "F:\DSH workshop\android-sdk\platform-tools\adb.exe" -s 127.0.0.1:5555 install -r "F:\DSH workshop\Whale-Lite-手机版\listening-player-lite.apk"
   ```

### 纪律（这项目踩过的坑，别重复）
- **不要用 pwsh 内联 `node -e` / 复杂 JS**：用 `write` 写脚本文件再跑；
  设备探针用 `--eval-file=脚本.js`（PowerShell 会把 `\"` 转义搞坏，已栽过多次）
- 项目目录保持 ASCII；`probe-device.js` 的 adb 调用都有超时保护，设备掉线会立刻报错
- 界面文案说人话：别把「2 GB 上限」这类实现细节写给用户看（测试里有断言盯着）
- 补充包/APK 都属于交付物，放 `Whale-Lite-手机版`；构建脚本会自动落在那里

### 还没做、用户可能接着要的（HANDOFF 里有完整清单）
- P0：4 本扫描 PDF 的原题 OCR（剑9/16/18/20）
- P1：生词高亮 / 点击查词、逐句跟读录音对比、错题本、题组正文展示

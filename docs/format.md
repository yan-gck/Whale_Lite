# 资料包格式详解

播放器不要求你把素材整理成特定数据库，只要**一组同名文件**放在 `audio/` 下即可。
扫描规则在 `lib/library.js`，本文说明每个文件的写法。

```
audio/
├─ CET4-演示/
│  ├─ 01-news-reports.wav                 音频（必需）
│  ├─ 01-news-reports.lrc                 时间轴
│  ├─ 01-news-reports.questions.json      原题
│  ├─ 01-news-reports.meta.json           元信息
│  ├─ 01-news-reports.txt                 完整原文
│  └─ 01-news-reports.duration            时长缓存（自动生成，可手动写）
└─ 我的素材/
   └─ 2024年6月四级第1套.mp3               没有附属文件也能播，只是没有歌词和题目
```

**五种文件的「名字」必须一致**（只有扩展名不同）。音频支持
`.mp3 .wav .m4a .aac .ogg .oga .opus .flac .webm .mp4`。

---

## 1. `.lrc` — 时间轴

支持三种写法，可以混用。

### 标准行时间戳

```
[ti:2024年6月四级听力]
[00:12.34]Good morning, everyone.
[00:16.80]Welcome to the listening test.
```

### 增强型（逐词时间戳）— 播放器会做逐词卡拉OK高亮

```
[00:12.34]<00:12.34>Good <00:12.90>morning, <00:13.60>everyone.
```

行首的时间戳是**这一行的起始时间**，`<...>` 是**每个词的起始时间**，单位都是「分:秒.百分秒」。
一个 `<t>` 后面可以跟多个词，它们共用该时间戳。

### 一行多时间戳（重复段落）

```
[00:30.00][01:45.00]This is the chorus line.
```

### 会被忽略的行

`[ti:]`、`[ar:]`、`[al:]`、`[by:]`、`[offset:]`、`[re:]`、`[ve:]`、`[length:]` 这些元信息行，
以及不含时间戳的行。

> 💡 正文里想标章节，可以写 `-- CONVERSATION 1 --` 这样的纯文本行（带时间戳），
> 播放器会当普通行显示并高亮，效果等同于小标题。

### 时间戳对不上音频怎么办

两种办法：

1. 用 `--offset=` 整体平移：`node tools/lrc-from-srt.js in.srt out.lrc --offset=1.25`（正数=字幕往后挪）
2. 用播放器的 **「设 A」→ 听到正确起点 → 「清 A-B」** 手动核对；或在界面里点某一行试听校正

---

## 2. `.questions.json` — 原题

```json
{
  "title": "2024年6月四级听力",
  "exam": "cet4",
  "section": "Section A",
  "source": "自编仿真题",
  "license": "CC0-1.0",
  "questions": [
    {
      "number": 1,
      "tag": "新闻1",
      "stem": "What do volunteers do with the broken bicycles?",
      "options": [
        "They sell them to local shops.",
        "They repair them and use them as mobile libraries.",
        "They cut them up for metal.",
        "They give them to school children."
      ],
      "answer": "B",
      "explain": "原文：Volunteers collect broken bicycles ... repair them。故选 B。",
      "start": 33.8,
      "end": 46.61,
      "transcript": "Volunteers collect broken bicycles from recycling centers and repair them with parts donated by local shops."
    }
  ]
}
```

| 字段 | 必需 | 说明 |
|---|---|---|
| `number` | ⬜ | 题号，不填则按顺序显示 1、2、3… |
| `tag` | ⬜ | 小标签，如「新闻1」「长对话2」「填空题」 |
| `stem` | ✅ | 题干。**连续下划线**（`______`）会被自动高亮，适合填空题 |
| `options` | ⬜ | 选项数组。可以直接是字符串，也可以是 `{"key":"A","text":"..."}`。**填空题把答案放第一项即可** |
| `answer` | ✅ | 正确答案的字母，如 `"B"`；多选传数组 `["A","C"]` |
| `explain` | ⬜ | 解析。点选项后显示，支持 `\n` 换行 |
| `start` / `end` | ⬜ | 该题对应音频片段的起止秒数。有它才会出现「▶ 回放片段」按钮 |
| `transcript` | ⬜ | 该题对应的听力原句。答完后显示，也用于时间自动校准 |

> **强烈建议**：`start` / `end` 不要手工估。写完 `transcript` 后跑
> `node tools/calibrate-questions.js audio --write`，用真实时间轴自动算。

---

## 3. `.meta.json` — 元信息

```json
{
  "title": "2024年6月四级听力 · 第1套",
  "exam": "cet4",
  "section": "Section A / B / C",
  "paper": "2024年6月第1套",
  "year": "2024",
  "source": "自编仿真题（TTS 合成）",
  "license": "CC0-1.0",
  "sourceUrl": "https://example.com/source",
  "duration": 575.05,
  "notes": "任意备注，会在界面上作为提示显示"
}
```

| 字段 | 说明 |
|---|---|
| `exam` | `cet4` / `cet6` / `ielts` / `toefl` / `other`。决定侧栏的分组标签和筛选 |
| `title` | 不填则用文件名 |
| `duration` | 音频秒数。**不填也没关系**——播放器首次播放时会自动探测并写入 `.duration` 缓存 |
| `source` / `license` / `sourceUrl` | 会显示在标题下方。**请务必如实填写**，见 `docs/resources.md` |

---

## 4. `.txt` — 完整原文

纯文本，会在界面右上角「原文」抽屉里显示，可一键复制。
没有这个文件时，如果存在 `.lrc`，播放器会自动用 LRC 的文本拼一份。

---

## 5. `.duration` — 时长缓存

只含一个数字（秒），如 `575.05`。**不需要手工创建**：
播放器播放时探测到时长后会自动回写。存在它的意义是让课程列表在音频还没加载时就能显示时长。

---

## 6. `.lppack` — 补充包（Android 离线素材）

单个 APK 有 **2 GiB 硬上限**（ZIP 中央目录用 32 位记录大小），
而本机素材合计约 3.0 GB，物理上装不进一个安装包。于是拆成：

| 产物 | 体积 | 内容 |
|---|---|---|
| `listening-player-lite.apk` | 35 MB | 完整前端 + 演示语料 |
| `<某素材目录>.lppack` | 按素材而定 | 该目录的完整内容（音频/时间轴/译文/题目/原题） |

补充包就是**标准 ZIP**（用普通解压工具也能打开看），结构：

```
manifest.json              包信息（set / lessons / version）
library.json               课程数据（时间轴、译文、题目、原题）
audio/<素材目录名>/<课程文件>  与项目 audio/ 下完全一致
```

`manifest.json`：

```json
{
  "format": "listening-player-pack",
  "version": 2,
  "set": "IELTS-剑桥真题",
  "lessons": 72,
  "audioFiles": 72,
  "sourceBytes": 1953741824,
  "hasLibrary": true,
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

`library.json` 是**桌面端扫描结果的快照**（`lib/library.js` 的产物），
App 直接读它来建课程列表，因此手机上看到的课程与电脑上完全一致：

```json
{
  "format": "listening-player-pack", "version": 2, "set": "CET6-真题", "count": 37,
  "lessons": [
    { "manifest": {...}, "lines": [...], "translationLines": [...],
      "questions": [...], "transcript": "...", "paper": "..." }
  ]
}
```

### 打包 / 查看 / 安装

```bash
# 看有哪些目录可打包
node tools/build-pack.js --list

# 打包（在项目根目录生成 <set>.lppack）
node tools/build-pack.js --set=IELTS-剑桥真题 --out=雅思听力补充包.lppack

# 校验包内容（只读中央目录，不会把 1.8 GB 读进内存）
node tools/pack-info.js 雅思听力补充包.lppack --verify

# 装到手机：数据线拷进 App 私有目录（无需权限）
#   /sdcard/Android/data/com.dsh.listeningplayer/files/packs/
# 或者：App 里点右上角「补充包」→「导入 .lppack」
```

### 实现要点（改代码前必读）

- **不解压**：Android 侧用 `java.util.zip.ZipFile` 直接在包里随机定位，
  1.9 GB 的包不额外占空间（见 `android/src/.../PackStore.java`）。
- **音频必须 STORED 存放**：`ZipFile` 的流不能 seek，Range 请求靠
  "取到条目流 → `skipFully` 到起点 → 限长读" 实现；只有未压缩条目
  skip 才是「只改偏移、不真读数据」。所以 `build-pack.js` 对音频不压缩。
- **条目名是 UTF-8**：打包时置了 UTF-8 名字标志（`0x0800`），
  Java 侧 `new ZipFile(file, StandardCharsets.UTF_8)` 再显式指定一次。
- **URL 空间**：`file:///android_asset/www/pack/<包名>/<包内路径>`，
  由 `MainActivity.shouldInterceptRequest` 截获（音频同样手工实现 206）。
- **v1 的包没有 `library.json`**，App 会明确提示「旧版补充包，请重新打包」，
  而不是静默失败。

---

## 常见问题

**放了音频但没有歌词滚动？**
缺 `.lrc`。如果素材自带字幕，用 `node tools/import.js --audio=X.mp3 --sub=X.srt` 转换。

**歌词整体偏了几秒？**
音频与字幕不同源。用 `--offset=` 平移后重新生成 LRC。

**课程列表里没出现我的素材？**
1. 确认音频扩展名在支持列表里；2. 点界面左下角「↻ 重新扫描素材」；3. 刷新页面。

**题目没有「回放片段」按钮？**
该题缺 `start`。填好 `transcript` 后跑 `tools/calibrate-questions.js --write`。

**音频很大、拖动进度条卡？**
服务端已实现 Range 请求。若仍卡，考虑把 WAV 换成 MP3/M4A——WAV 体积约为 MP3 的 10 倍
（本项目演示音频是 16 kHz 单声道 WAV，约 32 KB/秒）。

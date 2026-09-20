# 四六级 / 雅思 / 托福 听力开放资源清单

> 核查日期：2026-02
> 核查方式：对每个来源**实际发起 HTTP 请求**（状态码、字节数、格式），并读取官方许可条款原文；
> 未能证实的条目一律标注「未核实」，不做推测。
>
> **核心结论：真正"音频 + 原文 + 时间戳 + 原题"四样齐全、且许可允许自由分发的资源，基本不存在。**
> 真题音频的版权属于考试机构，"网上能下载" ≠ "可以随播放器分发"。
> 本清单把**技术可达性**与**许可状态**分开写，请按自己的用途（个人自用 / 公开分发）取舍。

---

## 一、结论速览

| 档位 | 能否随项目分发 | 来源 |
|---|---|---|
| ✅ 可以 | 公有领域或开放许可，明确允许再分发 | **LibriSpeech**（CC BY 4.0 + 真实句级时间戳）、**LibriVox**（公有领域）、**American English / 美国国务院**（公有领域）、**VOA Learning English**（公有领域，需署名）、**AMI 会议语料**（CC BY 4.0 + 词级时间戳）、**FLEURS / LibriTTS**（CC BY 4.0） |
| ⚠️ 灰色 | 技术完全可用，但许可是**上传者自称**，权利人未表态 | GitHub 上的四六级真题归档（Zenodo CC BY 4.0 / MIT 声明） |
| ❌ 不要打包 | 明确保留权利，或明文禁止转载、禁抓取、禁剪辑 | TED 及 TED-LIUM / MuST-C、Common Voice、ELLLO、**全部 8 个已核实的雅思托福练习站** |

---

## 二、⭐ 最优基础：LibriSpeech（CC BY 4.0 + 真实句级时间戳）

这是本次核查中找到的**许可最干净、又自带真实时间戳**的英文音频语料，建议作为播放器素材的底座。

- 许可：OpenSLR 页面与语料内附的 `LICENSE.TXT` 三处独立声明 **CC BY 4.0**
- 时间戳：`original-mp3` 子集里的 `*.seg.txt` 直接给出每句起止秒数，实测样本
  ```
  8296-266250_0000 221.18 232.42
  8296-266250_0001 232.42 239.23
  ```
  格式为 `<话语id> <起始秒> <结束秒>`；`*.trans.txt` 提供逐字稿
- 体积小巧的入口：
  ```
  https://www.openslr.org/resources/12/dev-clean.tar.gz    # 337,926,286 字节
  ```
- 想要时间戳又不想下 84 GB 的 `original-mp3.tar.gz`：可以**流式解压**（边下边 gunzip），
  实测 0.2 MB 左右就能拿到第一个 `.seg.txt`
- 也可以直接从 HuggingFace 取单个样本：数据集 `openslr/librispeech_asr`，`clean` / `validation`
- ⚠️ 语料是**朗读体有声书**（LibriVox 录音切分而来），适合听写与跟读，但不像考试对话

## 三、⭐ 零限制：LibriVox（音频公有领域）

官方声明原文（<https://librivox.org/pages/public-domain/>）：

> "LibriVox records only texts that are in the public domain ... and **all our recordings are public domain** ... This means anyone can use all our recordings however we wish (even to sell them)."

- **音频与文本双公有领域，零限制**，是最省心的法律底座
- 取用方式：
  ```
  GET https://archive.org/metadata/<identifier>
  ```
  读 `licenseurl` 与 `files[]`，再取
  ```
  https://archive.org/download/<identifier>/<chapter>_64kb.mp3
  ```
- 实测样本 `the_adventures_of_sherlock_holmes_v5_1904_librivox`：标注 `licenseurl = http://creativecommons.org/publicdomain/mark/1.0/`，
  14 章 × 3 种码率；单章 MP3 实测 **200，10,191,094 字节**（`_128kb` 版 20,363,060 字节）
- 每章时长在 `length` 字段里（如 `"21:12"`），可用于拼章节级时间轴
- ⚠️ **实测确认：LibriVox 全库不带字幕文件**。检查多个 item，`.vtt / .srt / .lrc / .sbv / .sub / .ass` 命中数为 **0**，
  archive.org 只给到每章时长，**没有章内时间戳**。想要滚动歌词必须自己做强制对齐（见第七节）

## 四、⭐ 现成对话 + 文本配对：American English（美国国务院）

- 来源页：<https://americanenglish.state.gov/resources/everyday-conversations-learning-american-english>
  实测暴露 **30 个 mp3 直链** + 1 份文本 PDF
- 实测样本：`dialogue_1-01_formal_greetings.mp3` → **200，1,776,327 字节**；`dialogue_1-02…` → 1,665,150 字节
- 文本：同页 `b_dialogues_everyday_conversations_english_lo_0.pdf`
- 国务院版权声明原文：*"Unless a copyright is indicated, information on State Department websites is in the public domain and may be copied and distributed without permission."*
- **一个 clip 就是一段完整对话**，段落边界天然存在，不需要内部时间戳
- ⚠️ 例外是真实存在的：同站 `/resources/color-vowel-chart` 就标注了 CC BY-NC-ND 4.0。
  **每个资源页都要看一眼是否单独标注了版权**

## 五、⭐ 量大：VOA Learning English（美国政府公有领域）

- VOA 自己的授权页原文（<https://learningenglish.voanews.com/p/6861.html>）：
  > "Learning English **texts, MP3s**, photos and videos **are in the public domain**. You are allowed to reprint them for educational and commercial purposes, with credit to learningenglish.voanews.com. However, stories, photos and video images from news agencies such as AP, Reuters and AFP are copyrighted"
- 取用：解析播客页 <https://learningenglish.voanews.com/podcast/?zoneId=1689> 的
  `<enclosure url="…" type="audio/mpeg"/>`。实测样本
  `https://voa-audio.voanews.eu/vle/2025/03/31/20250331-003003-vle122-program_hq.mp3` → **200，28,748,948 字节**
- 分段素材页的 `<audio src="https://voa-audio.voanews.eu/...">` 同样是直链，且常带 `_hq.mp3` 高码率版
- 使用时署名 `learningenglish.voanews.com`
- ⚠️ **必须过滤 AP / 路透 / 法新社来源的条目**，这部分明确被排除在公有领域授权之外
- ⚠️ **无时间戳**
- ⚠️ 未核实项：VOA 近期 `/a/` 文章页对非浏览器客户端返回统一的 JS 外壳，**无法在服务端验证具体某一课的正文**。
  老页面（如播客页）渲染正常

---

## 六、四六级真题：技术可取，许可存疑

这是你最可能想要的东西。实测结论：**音频能下、原文能找到、部分套有真实句级时间戳，但没有任何一个来源能证明它有权分发这些真题。**

### 6.1 `Ysoseri1224/CET-6-Listening-10-Years-Resources-and-Analysis`

- 归档于 Zenodo，DOI [`10.5281/zenodo.20474009`](https://doi.org/10.5281/zenodo.20474009)，Zenodo API 返回的 license 字段是 **`cc-by-4.0`**（机器可读声明，不是 README 里一句话）
- 实测下载 2,207,112 字节的归档，223 个条目：
  - **39** 份 `CET6_YYYY.MM_setN_transcript.md`（13.7–14.9 KB，完整听力原文，带 `W:` / `M:` 说话人标记和 `[1] [2]` 题号对应）
  - **80** 份 `*_q_stem.txt`（题干含完整 ABCD 选项）+ `*_q_answer.txt`（答案）
  - **3** 个 `.lrc`（GBK 编码，`[mm:ss.xx]` 行级；覆盖 2017.12 set1/set2、2018.06 set2）
- ⚠️ **归档包内的 `.mp3` / `.m4a` 是 133 字节的 Git LFS 指针，不是音频本体**

### 6.2 ⚠️ 头号实操陷阱：Git LFS

五个 CET 相关仓库里有三个用 Git LFS 存媒体。用 `raw.githubusercontent.com` 取会**静默返回 133 字节的指针文件，状态码还是 200**——看起来成功，其实不是：

```
version https://git-lfs.github.com/spec/v1
oid sha256:6b2ab9a7fe004ffa359d5bdc4b66dae98d4c395c7070812fc28231620e806aff
size 11999480
```

正确做法是用 LFS 媒体域名：

```
https://media.githubusercontent.com/media/Ysoseri1224/CET-6-Listening-10-Years-Resources-and-Analysis/main/CET6_2016.12/CET6_2016.12_set1_listening.mp3
```

实测 **200，16,422,048 字节，`audio/mpeg`**（2025.12 set1 为 37,060,775 字节）。
各仓库 LFS 掩码不同（`CET6-Resources` 只掩 `*.pdf`；`Ysoseri1224` 掩 `*.mp3` / `*.m4a`），用前先看 `.gitattributes`。

### 6.3 ⚠️ PDF 与 DOCX 的不对称

`CET6-Resources` 里 `.docx` **有真实文字层**（实测提取 28,864 字符，题目完整），
而 `.pdf` 是**扫描图，没有文字层**（`pdftotext` 从两份 12 MB 的 PDF 里只取到 10 和 15 个字符）。
任何打算从 PDF 里挖原文的流水线都会失败，请改用 `.docx` 或 6.1 的 markdown。

> **必须说清的风险**：CC BY 4.0 是**上传者自己的声明**，不是全国大学英语四、六级考试委员会声明的。
> 下游仓库 `getfine333-ux/cet6-listening-study` 在自己的 `THIRD_PARTY_NOTICES.md` 里老实写了：
> *"it is not an independent warranty that every underlying item is free of third-party rights."*，
> 并声明与四六级考试委员会无关联。个人学习没问题；公开分发请自行判断。

### 6.4 `3056810551/cet-listening`：⭐ 唯一有真实句级时间戳的四六级来源

- 许可：`LICENSE` 原文为 **MIT**
- **37** 份 `timings.json`（仅六级；`transcripts/cet4/` 是空的）
- schema 实测确认：
  - 顶层 `version, audio, markdown, duration, source, generatedAt, elapsedSeconds, mode, model, device, computeType, warning, transcription, cached, sections, lines`
  - `lines[]` = `{id, sectionId, sectionTitle, speaker, text, type, words, start, end, matchedWords, translation}`，**start / end 单位是秒**
  - `type ∈ dialogue | narration | question`；7 个段落（CONVERSATION 1/2、PASSAGE 1/2、RECORDING 1/2/3）
  - 样本 `2017-12-1`：时长 1601.709 秒、**175 行**、2845 词、**175 行全部带中文译文**、25 个 `question` 片段，`mode: faster-whisper / small.en / int8`
- ⚠️ **仓库里没有音频**：`audio/` 被 `.gitignore` 排除，`raw` 取 mp3 返回 **404**，音频只在百度网盘

**本播放器已内置适配器，并解决了"配哪份音频"这个关键问题：**

`timings.json` 的 `source.audio.size` 记录了它对齐时所用音频的**确切字节数**，这就是识别录音的指纹。实测对应关系：

| timings id | 需要的字节数 | 在哪能找到 |
|---|---|---|
| `2017-12-1` | 19,220,504 | DieDiDi `2017年12月英语六级真题及答案/第一套听力.mp3` |
| `2017-12-2` | 26,012,108 | DieDiDi `…/第二套听力.mp3` |
| `2018-6-1` | 19,808,668 | DieDiDi `2018年6月英语六级真题及答案/第一套.mp3` |
| `2022-12-1` | 19,911,175 | YinsinSirius `CET6_2022.12/2022.12第1套/…听力.mp3` |
| `2025-12-1` | 37,060,775 | Ysoseri1224 LFS `CET6_2025.12_set1_listening.mp3` |

**确实存在不匹配的情况，必须按字节数核对**：`2017-6-1` 需要 19,293,414 字节，而 DieDiDi 里同名文件是 19,220,504 字节（是另一份录音）；`2025-6-1` 需要 18,852,049，YinsinSirius 的是 18,501,013。**配错录音，歌词会整体漂移。**

用法：

```bash
node tools/from-cet-timings.js 2017-12-1.timings.json --audio=第一套听力.mp3
```

字节数不一致时工具会**直接中止并报出差额**，不会生成错位的资料包。

### 6.5 其他 CET 仓库

| 仓库 | 许可 | 实测情况 |
|---|---|---|
| `YinsinSirius/CET6-Resources`（521★） | **无 LICENSE**（GitHub API `license: null`） | 506 条目 / 344 blob：217 pdf、62 docx、34 doc、**12 mp3**、4 txt。MP3 实测 200（18,501,013 字节）。**全库零 `.lrc`/`.srt`/`.vtt`**；docx 有文字层但**听力原文命中数为 0**（只有题目）；PDF 是扫描图 |
| `DieDiDi/CET4-6-past-exam-paper`（237★） | **无 LICENSE** | 265 blob：158 pdf、**51 mp3/m4a**、32 docx、**3 lrc**。真实音频 10.4–69.5 MB，覆盖四级 2015.12–2022.12、六级 2017.06–2023.03。3 个 LRC 实测为真（2017.12×2、2018.06），如 `[00:01.66]College English Test Band Six`。**未经许可的最大 CET 音频库** |
| `getfine333-ux/cet6-listening-study` | MIT **但明确限定范围**：*"This license applies only to the software source code in `web/` and `android/`."* | `resources/` 归 `THIRD_PARTY_NOTICES.md` 管；上游即 6.1，资源声明 CC BY 4.0。对上游声明是很好的旁证，且对自身局限很诚实 |
| HuggingFace | — | 实测搜 `CET6`/`CET-6`/`CET4`/`四六级`（含 `full=true`）**count = 0**，`CET` 25 个命中全是误报（`cetacean/*` 等）。**这条路排除** |

---

## 七、❌ 不要打包的来源（附实测证据）

### 7.1 雅思 / 托福练习站：8 个全数不可用

| 站点 | 实测 | 许可原文 | 判定 |
|---|---|---|---|
| `tuhoc.dolenglish.vn` | MP3 无鉴权直连（200，9,562,697 字节）＋**真实 WebVTT**（`00:01:02,220 --> 00:01:09,258 <v INTERVIEWER>`） | ToS：内容 "không được sao chép, tái sản xuất… hoặc khai thác thương mại"（不得复制、再生产或商业利用） | ❌ 且文件是 `CAM10_L3_S2.mp3` = **剑桥雅思 10**，第三方（剑桥大学出版社）版权 |
| `toeflmocktests.com` | 3 个 mp3 实测 200（195,120 / 241,488 / 225,504 字节）＋公开 JS 里 **38 条逐字 transcript** | §3 "Reproduce, distribute, or sell any content… without authorization"；"© 2026 TOEFLMock. All rights reserved." | ❌ 技术包装最干净，权利全保留 |
| `prepex.ai` | 公开 Supabase 桶，200 audio/mpeg | "personal, non-commercial educational purposes only"；"Copy, redistribute, or resell… without written authorization" | ❌ |
| `ieltsonlinetests.com` | 阿里云 OSS，200 audio/mp3，**59,602,068 字节** | 无明确禁止条款，但也无任何许可 | ❌ 公开托管它无权授权的第三方真题音频 |
| `breakingnewsenglish.com` | 3 个 mp3 实测 200 | **全站零 Creative Commons**；"NONE OF THE MATERIALS ON THIS WEBSITE CAN BE SOLD OR MONETIZED IN ANY FORM."；允许链接 html "**but not the mp3 files**"；禁止转载到 "any other website… blog, **app**, LMS or CMS" | ❌ 明文点名了 "app"。此前流传的 "CC BY-NC-SA" 说法**已被证伪** |
| `esl-lab.com` | 未测音频（**未核实**） | 禁止 "**saving the sound files using any means**… for either personal, educational, or commercial use"，禁止 "embedding the audio/video… in any other application, including mobile applications" | ❌ 硬性禁止 |
| `ielts.org`（官方） | — | "The copyright in the material… including all… **sound**, is owned by or licensed to the IELTS Partners… for **your personal and non-commercial use only**… You must not… republish… modify the material in any way" | ❌ |
| `ets.org`（官方） | — | "**Permissions are only granted in writing.** Verbal grants… are not binding."；上限 "**three (3) copies**… personal, private and noncommercial use" | ❌ |

**结论：8 个站点里零个存在宽松许可。技术可达性从来不是障碍，许可才是。**

### 7.2 语音语料里的禁区

| 语料 | 许可 | 判定 |
|---|---|---|
| **TED** | 官方字幕接口 `https://www.ted.com/talks/subtitles/id/<id>/lang/en` 实测可用，返回毫秒级 `startTime`/`duration`，质量是本次核查中最好的 | ❌ 使用政策原文：CC **BY-NC-ND** 4.0；"**ND**: … no derivative works are permitted so you cannot edit, remix, create, modify or alter the form of the TED Talks in any way"；"**Scraping video from TED.com is not permitted**"；FAQ 明确把 TED 内容放进 LMS/LXP **不在 CC 许可覆盖范围内**。做听力播放器必然要切片和离线，两条都踩 |
| TED-LIUM 1/2/3 | 存档页原文 CC BY-NC-ND 3.0；OpenSLR 相关页面现已 **404** | ❌ 不是 TED 的绕行方案，是同一限制的子集 |
| MuST-C | CC BY-NC-ND 4.0；落地页已失效，HF 门禁 401 | ❌ |
| **Common Voice** | 卡片**无 license 字段**；2025-10 起只经 Mozilla Data Collective 分发。MDC FAQ 原文："CC0 remains the license for computational use, whilst **not allowing mirroring the datasets** is a platform term" | ❌ 不得镜像／再分发数据集本体 |
| **VoxPopuli** | ⚠️ **README 说 CC0，仓库 `LICENSE` 文件却是 "Attribution-NonCommercial 4.0"**，是真实且未解决的冲突（HF discussion #8 无人回应） | ⚠️ 最好的"考试感"语音＋真实片段秒数，但**需要法务确认**才能用 |
| Switchboard-1 | LDC 会员协议，付费，无公开下载 | ❌ |
| **ELLLO** | 页面有直链 MP3（实测 200，1,410,771 字节）＋完整 Script ＋可下载 PDF/PPT | ❌ 全站唯一声明是 "elllo productions © copyright 2025/2026"，**零 Creative Commons 命中**。能下载 ≠ 能分发 |

### 7.3 另外两个可选项（有条件）

| 语料 | 许可 | 说明 |
|---|---|---|
| **AMI Meeting Corpus** | 官方页原文：**CC BY 4.0**（OpenSLR 镜像上的 CC BY-NC-SA 2.0 是过期信息） | **词级 + 音素级时间对齐**，是本次核查中时间戳精度最高的；做逐词高亮可以用它。⚠️ 但是**多人会议语音**，不是考试独白，难度定位不同 |
| **FLEURS / LibriTTS / LibriTTS-R** | 均为 CC BY 4.0 | 一句一个 clip，**无内部时间戳**（也不需要）；适合做句子精听。LibriTTS 是 24 kHz，音质优于 LibriSpeech |

---

## 八、所以本播放器的演示语料是怎么来的

既然真题不能分发、开放语料又缺时间戳，`audio/` 里的演示资料**全部是自编仿真题**：

- **文本**：按四六级 / 雅思 / 托福的**真实考场结构**自编（Section A/B/C、Section 1/4、Conversation/Lecture），指令语也照真实考试写
- **音频**：用 Windows 内置 SAPI 语音合成，16 kHz 单声道
- **时间戳**：**不是估算的**。生成时挂钩语音引擎的 `SpeakProgress` 事件，采集**每个词的声学起始位置**，输出增强型 LRC（`<mm:ss.xx>word`），因此可以做逐词卡拉OK式高亮
- **题目**：配套原题、答案、解析，以及经真实时间轴**自动校准**过的回放片段
- **许可**：文本自编，标注 CC0-1.0，可自由使用

生成器是 `tools/make-demo.ps1` + `tools/demo-content.json`。改 `demo-content.json` 里的文本即可生成你自己的仿真题。

---

## 九、想给真题音频配时间戳？四条路

| 路线 | 做法 | 成本 |
|---|---|---|
| 1. 蹭现成时间戳 | `node tools/from-cet-timings.js <timings.json> --audio=<对应mp3>` | 最低，但**必须按字节数配对录音** |
| 2. 字幕直接转 | `node tools/import.js --audio=X.mp3 --sub=X.srt --exam=cet4` | 低，前提是素材自带 `.srt`/`.vtt` |
| 3. 自己跑强制对齐 | `faster-whisper` / `whisper.cpp` 出带时间戳字幕，再转 LRC（见下） | 中，需要 Python 环境 |
| 4. 只做章节级 | LibriVox 用 archive.org 的每章时长拼起始时间 | 低，但歌词只能按章跳转 |

路线 3 的命令示例：

```bash
pip install faster-whisper
```
```python
from faster_whisper import WhisperModel
m = WhisperModel("small.en", device="cpu", compute_type="int8")
segs, _ = m.transcribe("2017-12-1.mp3", word_timestamps=True)
with open("out.tsv", "w", encoding="utf-8") as f:
    for s in segs:
        f.write(f"{s.start}\t{s.end}\t{s.text.strip()}\n")
```
```bash
node tools/lrc-from-srt.js out.tsv out.lrc
```

配好时间轴后，题目里的「回放片段」也能自动校准：

```bash
node tools/calibrate-questions.js audio --write
```

---

## 十、核查说明与未核实项

**已实测**：所有上表的链接、字节数、状态码、格式均由实际 HTTP 请求得到；许可条款摘自官方页面原文。

**明确未核实，不作为结论**：

- **VOA 逐条目的正文**：近期 `/a/` 页面给非浏览器客户端返回统一 JS 外壳，服务端取不到正文
- **British Council**：`learnenglish.britishcouncil.org` 与 `britishcouncil.org/terms` 均返回 **403**（Akamai），条款未核实
- `ieltsliz.com`、`toeflresources.com`、`linguahouse.com`、`english-online.org`：从未请求，**不作任何判断**
- `esl-lab.com` 的具体音频 URL 未请求（只读了 ToS）
- Common Voice 新版 MDC "segments" 是否有片段级时间戳：未读其说明
- VoxPopuli 的 CC0 与 CC BY-NC 冲突，Meta 方面无回应

**最后提醒**：所有许可状态都可能变化。用于公开分发前请再确认一次当前条款；本文档不构成法律意见。

个人自用学习（自己下载、自己播放、不公开传播）的尺度要宽得多。本文档里标 "❌ 不要打包" 的，针对的是**随项目一起分发**的场景。

# ============================================================================
#  make-demo.ps1 — 生成可直接播放的演示听力资料包
#
#  为什么用 TTS 生成演示资料：
#     四六级/雅思/托福真题音频受版权保护，不适合随播放器一起分发。
#     本脚本用 Windows 内置语音合成朗读【自编】的、仿考场结构的听力材料，
#     同时通过 SAPI 的 SpeakProgress 事件采集【每个词的声学起始时间】，
#     因此生成的 .lrc 逐词时间戳是测量值而非估算值 —— 音频与字幕天然对齐。
#
#  产物（每个语料包一个目录）：
#     <name>.wav            音频
#     <name>.lrc            增强型 LRC（含逐词 <mm:ss.xx> 时间戳）
#     <name>.txt            完整原文
#     <name>.questions.json 原题 + 答案 + 解析
#     <name>.meta.json      标题 / 来源 / 许可 / 时长
#
#  用法：
#     pwsh -File tools/make-demo.ps1
#     pwsh -File tools/make-demo.ps1 -Only cet4
# ============================================================================

[CmdletBinding()]
param(
    [string]$Only = '',
    [switch]$Force,
    # SAPI SpeechAudioFormatType 数值：6=8kHz16bit单声道, 18=16kHz16bit单声道, 22=22kHz16bit单声道
    [int]$FormatType = 18
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

$Root      = Split-Path -Parent $PSScriptRoot
$AudioRoot = Join-Path $Root 'audio'
$DataFile  = Join-Path $PSScriptRoot 'demo-content.json'

if (-not (Test-Path $DataFile)) { throw "找不到语料定义文件：$DataFile" }

$spec = Get-Content -Raw -Encoding UTF8 $DataFile | ConvertFrom-Json

# ---------------------------------------------------------------------- 工具

function ConvertTo-LrcTime([double]$seconds) {
    if ($seconds -lt 0) { $seconds = 0 }
    $m = [math]::Floor($seconds / 60)
    $s = $seconds - ($m * 60)
    return ('{0:00}:{1:00.00}' -f $m, $s)
}

function Get-SafeName([string]$name) {
    $invalid = [System.IO.Path]::GetInvalidFileNameChars()
    $sb = New-Object System.Text.StringBuilder
    foreach ($ch in $name.ToCharArray()) {
        if ($invalid -contains $ch) { [void]$sb.Append('_') } else { [void]$sb.Append($ch) }
    }
    return $sb.ToString()
}

<#
  读取 WAV 头的真实参数。
  注意：SAPI 写出的是 18 字节的 fmt chunk，所以不能按固定 44 字节偏移去算时长，
  必须遍历 RIFF chunk 找到 fmt / data 才能得到正确结果。
#>
function Get-WavInfo {
    param([Parameter(Mandatory)][string]$Path)

    $fs = [System.IO.File]::OpenRead($Path)
    $br = New-Object System.IO.BinaryReader($fs)
    try {
        $riff = [System.Text.Encoding]::ASCII.GetString($br.ReadBytes(4))
        if ($riff -ne 'RIFF') { return $null }
        $null = $br.ReadInt32()                       # 文件长度（不可靠，忽略）
        $wave = [System.Text.Encoding]::ASCII.GetString($br.ReadBytes(4))
        if ($wave -ne 'WAVE') { return $null }

        $info = [ordered]@{ sampleRate = 0; channels = 0; bits = 0; dataBytes = 0; durationSec = 0.0 }

        while ($fs.Position -lt $fs.Length - 8) {
            $idBytes = $br.ReadBytes(4)
            if ($idBytes.Count -lt 4) { break }
            $id = [System.Text.Encoding]::ASCII.GetString($idBytes)
            $size = $br.ReadInt32()
            if ($size -lt 0) { break }

            if ($id -eq 'fmt ') {
                $null = $br.ReadInt16()                   # 编码格式
                $info.channels   = $br.ReadInt16()
                $info.sampleRate = $br.ReadInt32()
                $null = $br.ReadInt32()                   # byteRate
                $null = $br.ReadInt16()                   # blockAlign
                $info.bits       = $br.ReadInt16()
                $skip = $size - 16
                if ($skip -gt 0) { $null = $br.ReadBytes($skip) }
            }
            elseif ($id -eq 'data') {
                $info.dataBytes = $size
                break
            }
            else {
                $null = $br.ReadBytes($size)
            }
        }

        $byteRate = $info.sampleRate * $info.channels * ($info.bits / 8)
        if ($byteRate -gt 0) {
            $info.durationSec = [math]::Round($info.dataBytes / $byteRate, 2)
        }
        return [pscustomobject]$info
    }
    finally {
        $br.Close(); $fs.Close()
    }
}

<#
  核心：朗读文本并采集【绝对】词级时间戳。

  关键坑：SpeechSynthesizer 的 AudioPosition 在每次 Speak() 时都会从 0 重新计数，
  但输出 WAV 文件是追加写入的。因此本函数：
     1. 逐段调用 Speak()，每次朗读前记录文件字节长度，算出该段的累计时间偏移；
     2. 把该段所有词事件的相对 AudioPosition 加上偏移，得到绝对时间。
  这样即使材料有几十段、上百个词，时间戳也不会错位。

  返回 @{ DurationSec; Words = @(@{ms;text}); SampleRate; DataBytes }
#>
function Invoke-Synthesis {
    param(
        [Parameter(Mandatory)][string[]]$Paragraphs,
        [Parameter(Mandatory)][string]$OutWav,
        [string]$Voice = 'Microsoft Zira Desktop',
        [int]$Rate = 0,
        [int]$SampleRate = 16000
    )

    $voiceObj = New-Object System.Speech.Synthesis.SpeechSynthesizer
    try { $voiceObj.SelectVoice($Voice) } catch { Write-Warning "语音 $Voice 不可用，使用系统默认语音" }
    $voiceObj.Rate = $Rate

    $absolute = New-Object System.Collections.ArrayList
    $script:curWords = New-Object System.Collections.ArrayList

    $handler = [System.EventHandler[System.Speech.Synthesis.SpeakProgressEventArgs]] {
        param($sender, $e)
        [void]$script:curWords.Add([pscustomobject]@{
            relMs = [double]$e.AudioPosition.TotalMilliseconds
            text  = [string]$e.Text
        })
    }
    $voiceObj.add_SpeakProgress($handler)

    $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
        $SampleRate,
        [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
        [System.Speech.AudioFormat.AudioChannel]::Mono
    )

    # 16kHz 16bit 单声道 => 每秒 32000 字节
    $bytesPerSec = $SampleRate * 2.0

    try {
        $voiceObj.SetOutputToWaveFile($OutWav, $fmt)
        # 头部（RIFF/fmt/data 声明）刚写完时的长度，作为 data 区起点，
        # 避免假定固定 44 字节头（SAPI 实际写 18 字节 fmt chunk）
        $dataOffset = (Get-Item $OutWav).Length

        $paraIndex = 0
        foreach ($para in $Paragraphs) {
            $text = ([string]$para).Trim()
            if ($text -eq '') { continue }

            # 本段在 data 区中的起始字节 => 累计时间偏移
            $before = (Get-Item $OutWav).Length
            $offsetMs = [math]::Max(0, (($before - $dataOffset) / $bytesPerSec) * 1000.0)

            $script:curWords = New-Object System.Collections.ArrayList
            $voiceObj.Speak($text)

            foreach ($w in $script:curWords) {
                [void]$absolute.Add([pscustomobject]@{
                    ms   = $offsetMs + $w.relMs
                    text = $w.text
                })
            }
            $paraIndex++
        }

        $voiceObj.SetOutputToNull()
    }
    finally {
        $voiceObj.remove_SpeakProgress($handler)
        $voiceObj.Dispose()
    }

    $info = Get-WavInfo -Path $OutWav
    $durationSec = if ($info -and $info.durationSec -gt 0) { $info.durationSec }
        elseif ($absolute.Count -gt 0) { [math]::Round(($absolute[$absolute.Count - 1].ms + 800) / 1000.0, 2) }
        else { 0 }

    return [pscustomobject]@{
        DurationSec = $durationSec
        Words       = $absolute
        SampleRate  = if ($info) { $info.sampleRate } else { $SampleRate }
        Channels    = if ($info) { $info.channels } else { 1 }
        DataBytes   = if ($info) { $info.dataBytes } else { 0 }
    }
}

<#
  把「原文行 + 词级时间戳」组装成增强型 LRC。
  逐行取词：行内按空白分词，与 SAPI 事件流顺序对账。
#>
function New-EnhancedLrc {
    param(
        [Parameter(Mandatory)][string[]]$Lines,
        [Parameter(Mandatory)]$Words,
        [Parameter(Mandatory)][double]$DurationSec,
        [string]$Title = ''
    )

    $out = New-Object System.Collections.Generic.List[string]
    if ($Title) { $out.Add("[ti:$Title]") }
    $out.Add('[by:listening-player make-demo (SAPI 词级时间戳)]')
    $out.Add("[length:$(ConvertTo-LrcTime $DurationSec)]")

    $wi = 0
    $pendingMs = 0.0        # 空行造成的停顿：把下一个词的起点作为该行起点

    for ($li = 0; $li -lt $Lines.Count; $li++) {
        $line = $Lines[$li].Trim()
        if ($line -eq '') { continue }

        # 该行期望的词数
        $tokens = @($line -split '\s+' | Where-Object { $_ -ne '' })
        if ($tokens.Count -eq 0) { continue }

        $lineStartMs = $null
        $parts = New-Object System.Collections.Generic.List[string]

        foreach ($tok in $tokens) {
            if ($wi -ge $Words.Count) { break }
            $w = $Words[$wi]
            $wi++

            if ($null -eq $lineStartMs) { $lineStartMs = $w.ms }

            # 词与词之间补一个空格（保持可读性），时间戳贴在词前
            $prefix = if ($parts.Count -gt 0) { ' ' } else { '' }
            $parts.Add("$prefix<$(ConvertTo-LrcTime ($w.ms / 1000.0))>$($w.text)")
        }

        if ($null -ne $lineStartMs) {
            $out.Add("[$(ConvertTo-LrcTime ($lineStartMs / 1000.0))]$($parts -join '')")
        }
    }

    return ($out -join "`n") + "`n"
}

# ---------------------------------------------------------------------- 主流程

$made = 0
$skipped = 0

foreach ($pack in $spec.packs) {
    if ($Only -and $pack.id -ne $Only) { continue }

    $packDir = Join-Path $AudioRoot (Get-SafeName $pack.folder)
    if (-not (Test-Path $packDir)) { New-Item -ItemType Directory -Force -Path $packDir | Out-Null }

    Write-Host ''
    Write-Host "── $($pack.label)  →  $packDir" -ForegroundColor Cyan

    foreach ($item in $pack.items) {
        $safe = Get-SafeName $item.name
        $wav = Join-Path $packDir "$safe.wav"

        if ((Test-Path $wav) -and -not $Force) {
            Write-Host "   · 跳过（已存在）$($item.title)" -ForegroundColor DarkGray
            $skipped++
            continue
        }

        # 逐段朗读：段落之间由脚本自行插入停顿
        $speakLines = @($item.script)
        $speakText = ($speakLines -join "`n`n")

        Write-Host "   · 合成 $($item.title) ..." -NoNewline
        $res = Invoke-Synthesis -Paragraphs $speakLines -OutWav $wav -Rate ([int]$pack.rate) -SampleRate 16000

        # LRC
        $lrc = New-EnhancedLrc -Lines $speakLines -Words $res.Words -DurationSec $res.DurationSec -Title $item.title
        [System.IO.File]::WriteAllText((Join-Path $packDir "$safe.lrc"), $lrc, (New-Object System.Text.UTF8Encoding($false)))

        # 原文 txt
        [System.IO.File]::WriteAllText((Join-Path $packDir "$safe.txt"), ($speakText + "`n"), (New-Object System.Text.UTF8Encoding($false)))

        # 题目
        $qDoc = [ordered]@{
            title   = $item.title
            exam    = $pack.id
            section = $pack.section
            source  = $pack.source
            license = $pack.license
            questions = $item.questions
        }
        [System.IO.File]::WriteAllText(
            (Join-Path $packDir "$safe.questions.json"),
            ($qDoc | ConvertTo-Json -Depth 8),
            (New-Object System.Text.UTF8Encoding($false))
        )

        # 元信息
        $meta = [ordered]@{
            title     = $item.title
            exam      = $pack.id
            section   = $pack.section
            source    = $pack.source
            license   = $pack.license
            sourceUrl = $pack.sourceUrl
            duration  = $res.DurationSec
            sampleRate = $res.SampleRate
            notes     = $pack.notes
            importedAt = (Get-Date).ToString('yyyy-MM-dd')
            generator = 'tools/make-demo.ps1 (Windows SAPI TTS, 词级时间戳)'
        }
        [System.IO.File]::WriteAllText(
            (Join-Path $packDir "$safe.meta.json"),
            ($meta | ConvertTo-Json -Depth 5),
            (New-Object System.Text.UTF8Encoding($false))
        )

        $secs = [math]::Round($res.DurationSec, 1)
        $mb = [math]::Round((Get-Item $wav).Length / 1MB, 1)
        Write-Host " ok  词数=$($res.Words.Count)  时长=${secs}s  大小=${mb}MB" -ForegroundColor Green
        $made++
    }
}

Write-Host ''
Write-Host "✅ 生成完成：新建 $made 个语料，跳过 $skipped 个" -ForegroundColor Green
Write-Host "   运行 node server.js 后打开 http://127.0.0.1:4180" -ForegroundColor Gray

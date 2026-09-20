# ============================================================
#  launcher.ps1 — 打印启动器里的中文提示
#
#  为什么中文提示要放在这里，而不是直接写在 .bat 里：
#    cmd.exe 是按控制台 OEM 代码页逐字节解析批处理文件的。
#    一旦 .bat 里出现非 ASCII 字符（中文），解析器可能丢失位置，
#    把字节流切错，进而执行出
#        'o' 不是内部或外部命令
#        '址：http:' 不是内部或外部命令
#        文件名、目录名或卷标语法不正确
#    这类莫名其妙的报错 —— 实测就是这个原因导致启动器整个跑不起来。
#    所以 .bat 保持纯 ASCII，中文一律由本脚本输出。
#
#  用法：powershell -NoProfile -ExecutionPolicy Bypass -File tools\launcher.ps1 <阶段> [端口]
# ============================================================

param(
    [Parameter(Position = 0)][string]$Stage = 'welcome',
    [Parameter(Position = 1)][string]$Port = '4180'
)

# 让本进程的输出用 UTF-8，保证中文在 cmd 窗口里正常显示
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

switch ($Stage) {
    'welcome' {
        Write-Host ''
        Write-Host '  =============================================='
        Write-Host '     Whale Lite · Listening Player'
        Write-Host '  =============================================='
        Write-Host ''
        Write-Host '  首次运行会自动生成演示语料（用 Windows 自带语音合成）。'
        Write-Host '  想下载更多开放资源，请另外双击：tools\下载开放资源.bat'
        Write-Host ''
    }

    'nonode' {
        Write-Host ''
        Write-Host '  [错误] 没有找到 Node.js。'
        Write-Host ''
        Write-Host '  本播放器需要 Node.js 18 或更高版本。'
        Write-Host '  请到 https://nodejs.org/ 下载安装，然后重新运行本文件。'
        Write-Host ''
    }

    'starting' {
        Write-Host ''
        Write-Host '  正在启动服务...'
        Write-Host ''
        Write-Host '  ------------------------------------------------'
        Write-Host "    浏览器地址：http://127.0.0.1:$Port"
        Write-Host '    停止播放器：关闭本窗口，或按 Ctrl+C'
        Write-Host '  ------------------------------------------------'
        Write-Host ''
    }

    'ready' {
        Write-Host ''
        Write-Host '  播放器已在浏览器中打开。'
        Write-Host '  本窗口正在运行服务，关闭它即停止播放器。'
        Write-Host ''
    }

    'apk' {
        Write-Host ''
        Write-Host '  =============================================='
        Write-Host '     打包 Android APK'
        Write-Host '  =============================================='
        Write-Host ''
        Write-Host '  前置条件：JDK 17 + Android SDK（platforms/android-34、build-tools/34.0.0）'
        Write-Host '  产物：项目根目录的 listening-player.apk（内置全部素材，离线可用）'
        Write-Host ''
    }

    'download' {
        Write-Host ''
        Write-Host '  =============================================='
        Write-Host '     下载开放听力资源'
        Write-Host '  =============================================='
        Write-Host ''
        Write-Host '  将要下载（全部为公有领域或开放许可，允许再分发）：'
        Write-Host '    1. 美国国务院 Everyday Conversations  (30 段对话，约 60 MB)'
        Write-Host '    2. LibriVox 有声书                      (4 章，约 45 MB)'
        Write-Host '    3. LibriSpeech 句子精听                 (120 句，约 12 MB)'
        Write-Host '    4. VOA Learning English                 (5 期节目，约 137 MB)'
        Write-Host ''
        Write-Host '  合计约 250 MB。已存在的文件会自动跳过，可随时中断后重跑。'
        Write-Host ''
        Write-Host '  ----------------------------------------------'
        Write-Host '    直接回车 = 全部下载'
        Write-Host '    输入 1/2/3/4 = 只下载其中一项'
        Write-Host '    输入 q = 取消'
        Write-Host '  ----------------------------------------------'
        Write-Host ''
    }

    'download-done' {
        Write-Host ''
        Write-Host '  ----------------------------------------------'
        Write-Host '    完成。回到播放器点「重新扫描素材」即可看到新内容。'
        Write-Host '  ----------------------------------------------'
        Write-Host ''
    }

    default {
        Write-Host "  (unknown stage: $Stage)"
    }
}

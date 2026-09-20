/**
 * 设备端音频诊断脚本（配合 tools/probe-device.js 的 --eval-file 使用）
 *
 * 用法：
 *   node tools/probe-device.js --eval-file=tools/probe-audio-diag.js
 *
 * 它会在真实 WebView 里：从当前位置播放，然后每 2 秒打印一次媒体元素的真实状态。
 *
 * 为什么需要它 —— 第 10 轮踩到的坑：
 *   `--keepalive` 报「熄屏 6 秒音频前进 0.0s」，看着像锁屏保活坏了。
 *   用这个脚本一看就知道**熄屏前音频就已经不动了**，而且
 *   `error.code=2`（MEDIA_ERR_NETWORK）+ `seeking` 永远为 true + `readyState=1`
 *   —— 是探针跑多了把 WebView 的媒体栈拖死了（同第 53 条：反复 seek 的副作用），
 *   跟 `PlaybackService` 一点关系都没有。
 *
 *   恢复办法：adb shell am force-stop com.dsh.listeningplayer，再重新 am start。
 *
 * 判读：
 *   · currentTime 每 2 秒 +2 左右          → 正常
 *   · currentTime 不动 + seeking=true      → 媒体栈卡死，重启 App
 *   · error.code=2                         → 数据源读取失败（补充包/拦截器）
 *   · readyState=1 且一直不涨              → 元数据还没加载出来（源太大或在等 Range）
 */
(async function () {
  var a = document.getElementById('audio');
  var out = [];
  var log = function (s) { out.push(s); };
  var snap = function (tag) {
    log(tag + ' → paused=' + a.paused
      + ' t=' + (Math.round(a.currentTime * 100) / 100)
      + ' dur=' + (Math.round((a.duration || 0) * 10) / 10)
      + ' readyState=' + a.readyState
      + ' networkState=' + a.networkState
      + ' err=' + (a.error ? a.error.code : 'null')
      + ' seeking=' + a.seeking);
  };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  log('src=' + a.src);
  snap('起始');

  var playErr = '';
  try {
    await a.play();
    log('play() 已 resolve');
  } catch (e) {
    playErr = String(e && e.name ? e.name : e) + ' / ' + String(e && e.message ? e.message : '');
    log('play() 被拒绝：' + playErr);
  }

  for (var i = 1; i <= 3; i++) {
    await sleep(2000);
    snap('播放 ' + (i * 2) + ' 秒后');
  }

  log('');
  log('（currentTime 一直不变且 seeking=true → 媒体栈卡死：force-stop 重启 App）');
  return out.join('\n');
})()

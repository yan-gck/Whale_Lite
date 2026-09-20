package com.dsh.listeningplayer;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.res.AssetFileDescriptor;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Whale Lite · Android 壳
 *
 * 设计要点：
 *   前端是纯静态页面，离线版把「public/ 前端 + audio/ 素材 + bundle.json」全部打进 APK 的 assets。
 *   但 assets 是压缩包，<audio> 元素无法对 assets 里的文件做 Range 请求（拖动进度条会用不了），
 *   所以这里用 shouldInterceptRequest 把 assets 内容通过一个"可寻址的响应"喂给 WebView，
 *   并显式声明 Accept-Ranges / Content-Length，让媒体播放器能正常拖动。
 *
 *   ── 补充包（.lppack）──
 *   单个 APK 有 2 GiB 硬上限（ZIP 中央目录 32 位记录大小），本机 3.0 GB 素材装不进去，
 *   因此素材拆成「安装包 + 补充包」。补充包放在 App 私有外部目录里：
 *
 *     getExternalFilesDir(null)/packs/*.lppack
 *     → /sdcard/Android/data/com.dsh.listeningplayer/files/packs/
 *
 *   这个目录用数据线就能直接拷文件进去，不需要任何权限（AndroidManifest 里只有 INTERNET）。
 *   读取由 PackStore 负责：ZipFile 直接随机访问，不解压，1.9 GB 的包不额外占空间。
 *
 *   为了让 <audio> 能播包里的音频，这里自建了一段 URL 空间：
 *
 *     file:///android_asset/www/pack/<包名>/<包内相对路径>
 *
 *   命中该前缀就不再去 assets 找，而是从补充包里取；音频同样手工实现 206 Partial Content
 *   （包内音频是 STORED 存放，skip 到起点是廉价操作）。
 *
 *   前端（public/app.js）通过 JS 桥 AndroidHost 拿到已安装包列表与包内课程数据，
 *   并把课程音频地址拼成上面的形式。
 */
public class MainActivity extends Activity {

    private WebView webView;
    private static final String START_URL = "file:///android_asset/www/index.html";

    /** 自建 URL 空间的前缀（必须与 public/app.js 里的 'pack/' 拼接保持一致） */
    private static final String PACK_MARKER = "/android_asset/www/pack/";
    private static final String ASSET_MARKER = "/android_asset/www/";

    private PackStore packStore;
    private volatile boolean packsScanned = false;

    /**
     * 随 APK 打包的文本资源缓存（bundle.json / packs-catalog.json）。
     *
     * 为什么要走桥而不是 fetch：离线页面的地址是 `file:///android_asset/www/index.html`，
     * 在 WebView 里对 file:// 发 fetch 会被拦掉（"URL scheme file is not supported"）。
     * 实测这样会导致**课程列表永远是空的** —— 桌面上完全复现不出来。
     * 只缓存最近读的一份（bundle.json 典型几百 KB，大包可能几十 MB）。
     */
    private String assetTextKey;
    private String assetText;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 沉浸式深色状态栏，和播放器配色一致
        Window window = getWindow();
        window.setStatusBarColor(Color.parseColor("#0c0f14"));
        window.setNavigationBarColor(Color.parseColor("#12161d"));
        // 注意：FLAG_KEEP_SCREEN_ON 不在这里加 —— 它现在跟「是否正在播放」绑定
        // （见 onPlaybackState），否则用户只是打开着看课程列表也一直亮屏。

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0c0f14"));
        root.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#0c0f14"));
        webView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(webView);
        setContentView(root);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);   // 允许自动播放下一句
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        // 补充包目录：优先 App 私有外部目录（数据线可写入、无需权限），
        // 外部存储不可用时退回内部目录（那里只能靠 App 内的「导入」按钮放文件）。
        File packsDir = getExternalFilesDir(null);
        if (packsDir == null) packsDir = new File(getFilesDir(), "packs");
        else packsDir = new File(packsDir, "packs");
        packStore = new PackStore(packsDir);

        // 允许用 Chrome 远程调试这个 WebView（chrome://inspect / CDP over adb）。
        // 没有它就只能靠猜：WebView 里的报错、DOM 状态、localStorage 全都看不到。
        // 需要 USB 调试权限才能连，对个人工具没有额外风险。
        WebView.setWebContentsDebuggingEnabled(true);

        webView.setWebChromeClient(new ChromeClient());
        webView.setWebViewClient(new AssetClient());
        webView.addJavascriptInterface(new HostBridge(), "AndroidHost");

        // 后台/锁屏保活：服务通过这个口子把通知栏/锁屏上的操作交回网页
        PlaybackService.setBridge(new PlaybackService.Bridge() {
            @Override
            public void sendCommand(String command, double value) {
                sendHostCommand(command, value);
            }
        });
        ensureNotificationPermission();

        // 扫描放到后台线程：ZipFile 打开时要读中央目录，别卡住界面
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    packStore.scan();
                    packsScanned = true;
                } catch (Exception ignored) { }
            }
        }, "pack-scan").start();

        webView.loadUrl(START_URL);
    }

    // ---------------------------------------------------------------- 文件选择
    //
    // 为什么必须自己实现：WebView 默认【不支持】<input type="file">，
    // 不重写 onShowFileChooser 的话，网页里点「选择文件」毫无反应。
    // 播放器的「导入」功能全靠它，所以这是必需的。

    private ValueCallback<Uri[]> filePathCallback;
    private static final int REQ_FILE = 1001;
    private static final int REQ_PACK = 1002;
    private static final int REQ_NOTIFICATION = 1003;

    private class ChromeClient extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                         FileChooserParams params) {
            if (filePathCallback != null) filePathCallback.onReceiveValue(null);
            filePathCallback = callback;
            try {
                Intent intent = params.createIntent();
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                startActivityForResult(intent, REQ_FILE);
                return true;
            } catch (Exception e) {
                filePathCallback = null;
                return false;
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    result = new Uri[n];
                    for (int i = 0; i < n; i++) result[i] = data.getClipData().getItemAt(i).getUri();
                } else if (data.getData() != null) {
                    result = new Uri[]{ data.getData() };
                }
            }
            if (filePathCallback != null) {
                filePathCallback.onReceiveValue(result);
                filePathCallback = null;
            }
            return;
        }

        if (requestCode == REQ_PACK) {
            if (resultCode != RESULT_OK || data == null || data.getData() == null) {
                sendPackEvent("{\"type\":\"import-cancel\"}");
                return;
            }
            final Uri uri = data.getData();
            // 1.9 GB 的复制不能放在主线程，也不能放在 JS 桥线程上
            new Thread(new Runnable() {
                @Override
                public void run() {
                    doImportPack(uri);
                }
            }, "pack-import").start();
            return;
        }

        super.onActivityResult(requestCode, resultCode, data);
    }

    // ---------------------------------------------------------------- 补充包导入

    /** 询问系统文件选择器（SAF），拿到 .lppack 后复制进包目录 */
    private void doImportPack(final Uri uri) {
        String name = queryDisplayName(uri);
        long size = querySize(uri);
        sendPackEvent("{\"type\":\"import-start\",\"name\":" + PackStore.quote(name)
                + ",\"sizeBytes\":" + size + "}");

        InputStream in = null;
        try {
            in = getContentResolver().openInputStream(uri);
            if (in == null) throw new IOException("无法读取所选文件");

            final long[] last = { 0 };
            PackStore.Pack p = packStore.importStream(in, name, size, new PackStore.Progress() {
                @Override
                public void onProgress(long copied, long total) {
                    long now = System.currentTimeMillis();
                    if (now - last[0] < 400) return;      // 限流：别把 JS 桥刷爆
                    last[0] = now;
                    sendPackEvent("{\"type\":\"import-progress\",\"copied\":" + copied
                            + ",\"total\":" + total + "}");
                }
            });

            sendPackEvent("{\"type\":\"import-done\",\"pack\":" + packJson(p)
                    + ",\"packs\":" + packStore.toJson() + "}");
        } catch (Exception e) {
            sendPackEvent("{\"type\":\"import-error\",\"message\":"
                    + PackStore.quote(messageOf(e)) + "}");
        } finally {
            Streams.closeQuietly(in);
        }
    }

    private String packJson(PackStore.Pack p) {
        return "{\"id\":" + PackStore.quote(p.id)
                + ",\"set\":" + PackStore.quote(p.set)
                + ",\"lessons\":" + p.lessons
                + ",\"sizeBytes\":" + p.sizeBytes
                + ",\"ok\":" + p.ok + "}";
    }

    private String queryDisplayName(Uri uri) {
        Cursor c = null;
        try {
            c = getContentResolver().query(uri, new String[]{ OpenableColumns.DISPLAY_NAME },
                    null, null, null);
            if (c != null && c.moveToFirst()) {
                String n = c.getString(0);
                if (n != null && !n.isEmpty()) return n;
            }
        } catch (Exception ignored) {
        } finally {
            if (c != null) c.close();
        }
        String last = uri.getLastPathSegment();
        return last == null ? "" : last;
    }

    private long querySize(Uri uri) {
        Cursor c = null;
        try {
            c = getContentResolver().query(uri, new String[]{ OpenableColumns.SIZE },
                    null, null, null);
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getLong(0);
        } catch (Exception ignored) {
        } finally {
            if (c != null) c.close();
        }
        return -1;
    }

    /** 把事件回抛给网页（必须在 UI 线程调 evaluateJavascript） */
    private void sendPackEvent(final String json) {
        if (webView == null) return;
        webView.post(new Runnable() {
            @Override
            public void run() {
                if (webView == null) return;
                webView.evaluateJavascript(
                        "window.__onPackEvent && window.__onPackEvent(" + json + ")", null);
            }
        });
    }

    private static String messageOf(Throwable e) {
        String m = e.getMessage();
        if (m == null || m.isEmpty()) m = e.getClass().getSimpleName();
        return m;
    }

    // ---------------------------------------------------------------- JS 桥
    //
    // 前端在离线（bundle）模式下靠它拿补充包列表与包内课程数据。
    // 之所以不走 fetch：file:// 页面里的 fetch 受同源策略限制，
    // 而 JS 桥是 WebView 原生支持的通道，稳定得多。

    public class HostBridge {

        @JavascriptInterface
        public String packs() {
            ensureScanned();
            try {
                return packStore.toJson();
            } catch (Exception e) {
                return "{\"supported\":true,\"error\":" + PackStore.quote(messageOf(e)) + ",\"packs\":[]}";
            }
        }

        @JavascriptInterface
        public String rescanPacks() {
            try {
                packStore.scan();
                packsScanned = true;
                return packStore.toJson();
            } catch (Exception e) {
                return "{\"supported\":true,\"error\":" + PackStore.quote(messageOf(e)) + ",\"packs\":[]}";
            }
        }

        @JavascriptInterface
        public String packsDir() {
            return packStore.dirPath();
        }

        @JavascriptInterface
        public int packTextLength(String packId, String relPath) {
            ensureScanned();
            PackStore.Pack p = packStore.get(packId);
            return p == null ? -1 : packStore.textLength(p, relPath);
        }

        @JavascriptInterface
        public String packTextChunk(String packId, String relPath, int from, int len) {
            ensureScanned();
            PackStore.Pack p = packStore.get(packId);
            return p == null ? null : packStore.textChunk(p, relPath, from, len);
        }

        /** 打开系统文件选择器导入 .lppack；完成后通过 __onPackEvent 回调 */
        @JavascriptInterface
        public boolean importPack() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                        i.addCategory(Intent.CATEGORY_OPENABLE);
                        i.setType("*/*");
                        i.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{ "*/*" });
                        startActivityForResult(i, REQ_PACK);
                    } catch (Exception e) {
                        sendPackEvent("{\"type\":\"import-error\",\"message\":"
                                + PackStore.quote("打不开文件选择器：" + messageOf(e)) + "}");
                    }
                }
            });
            return true;
        }

        @JavascriptInterface
        public String deletePack(String packId) {
            PackStore.Pack p = packStore.get(packId);
            if (p == null) {
                return "{\"ok\":false,\"error\":" + PackStore.quote("没有这个补充包") + "}";
            }
            boolean gone = packStore.delete(packId);
            return "{\"ok\":" + gone + ",\"packs\":" + packStore.toJson() + "}";
        }

        @JavascriptInterface
        public String appInfo() {
            return "{\"packageName\":" + PackStore.quote(getPackageName())
                    + ",\"sdk\":" + Build.VERSION.SDK_INT
                    + ",\"packsDir\":" + PackStore.quote(packStore.dirPath()) + "}";
        }

        /**
         * 网页上报播放状态（每次播放/暂停/切课/定时上报都会调）。
         *
         * 这是后台保活的入口：playing=true 会让 App 起一个前台服务
         * （常驻通知 + CPU 唤醒锁 + 媒体会话），锁屏后继续播放。
         */
        @JavascriptInterface
        public void setPlaybackState(final boolean playing, final String title,
                                     final String subtitle, final double positionSec,
                                     final double durationSec) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    onPlaybackState(playing,
                            title == null ? "" : title,
                            subtitle == null ? "" : subtitle,
                            (long) (positionSec * 1000),
                            (long) (durationSec * 1000));
                }
            });
        }

        /** 页面主动要求停止后台播放（例如用户点了「停止」） */
        @JavascriptInterface
        public void stopPlayback() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    PlaybackService.shutdown(MainActivity.this);
                }
            });
        }

        /**
         * 读一个随 APK 打包的文本文件（相对 assets/www）。
         * 返回字符数；-1 表示没有这个文件。内容用 {@link #assetTextChunk} 分片取。
         */
        @JavascriptInterface
        public synchronized int assetTextLength(String path) {
            try {
                String text = readAssetText(path);
                return text == null ? -1 : text.length();
            } catch (Exception e) {
                return -1;
            }
        }

        /** 取 asset 文本的一片（按【字符】切，中文不会被切断） */
        @JavascriptInterface
        public synchronized String assetTextChunk(String path, int from, int len) {
            try {
                String text = readAssetText(path);
                if (text == null) return null;
                if (from < 0 || from >= text.length()) return "";
                return text.substring(from, Math.min(text.length(), from + Math.max(0, len)));
            } catch (Exception e) {
                return null;
            }
        }
    }

    /** 读 assets/www/<path>（带缓存；路径穿越会被拒） */
    private synchronized String readAssetText(String path) throws IOException {
        String rel = PackStore.normalize(path);          // 复用同一套防穿越校验
        if (rel.equals(assetTextKey)) return assetText;

        InputStream in = null;
        try {
            in = getAssets().open("www/" + rel);
            String text = Streams.readText(in, 128 * 1024 * 1024);
            assetTextKey = rel;
            assetText = text;
            return text;
        } catch (IOException e) {
            return null;                                  // 没有这个资源
        } finally {
            Streams.closeQuietly(in);
        }
    }

    private void ensureScanned() {
        if (!packsScanned) {
            packStore.scan();
            packsScanned = true;
        }
    }

    // ---------------------------------------------------------------- 资源拦截

    /**
     * 让 assets / 补充包里的资源走我们的响应逻辑。
     *
     * 关键点：APK 内 assets 是压缩存放的，WebView 无法对里面的音频做 Range 请求，
     * 结果就是进度条拖不动。这里对音频请求手工实现 206 Partial Content：
     *   · assets   → AssetFileDescriptor 精确定位字节区间
     *   · 补充包    → ZipFile 条目流 + skipFully 定位
     */
    private class AssetClient extends WebViewClient {
        /**
         * 页面里的**外链**（比如「问题反馈」指向的 Git 仓库）交给系统浏览器打开。
         *
         * ⚠️ 不重写这个方法的话，WebView 会自己导航过去 —— 整个 App 界面被网页顶掉，
         *    用户只能靠系统返回键退回来，看着就像 App 挂了。
         *    我们自己的 file:///android_asset/ 页面必须继续走 WebView 内部加载（返回 false）。
         */
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            String url = request.getUrl().toString();
            if (url.startsWith("file://")) return false;
            try {
                Intent it = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(it);
                return true;
            } catch (Exception e) {
                // 设备上没装浏览器：退回 App 内部加载，至少让用户能看到内容
                return false;
            }
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            String url = request.getUrl().toString();

            // 补充包：.../android_asset/www/pack/<包名>/<包内路径>
            int pi = url.indexOf(PACK_MARKER);
            if (pi >= 0) {
                return servePack(url.substring(pi + PACK_MARKER.length()), request);
            }

            int idx = url.indexOf(ASSET_MARKER);
            if (idx < 0) return null;

            String rel = url.substring(idx + ASSET_MARKER.length());
            rel = stripQueryAndDecode(rel);

            String assetPath = "www/" + rel;
            String mime = guessMime(rel);
            boolean isMedia = mime.startsWith("audio/") || mime.startsWith("video/");

            // 非媒体资源：常规返回
            if (!isMedia) {
                try {
                    InputStream in = getAssets().open(assetPath);
                    return new WebResourceResponse(mime, encodingFor(mime), 200, "OK", baseHeaders(), in);
                } catch (IOException e) {
                    return null;
                }
            }

            try {
                long total = assetLength(assetPath);
                if (total <= 0) return null;
                final String assetPathF = assetPath;
                return serveMedia(mime, total, rangeOf(request), new Opener() {
                    @Override
                    public InputStream open(long start, long count) throws IOException {
                        AssetFileDescriptor fd = getAssets().openFd(assetPathF);
                        FileInputStream fis = fd.createInputStream();
                        try {
                            if (start > 0) Streams.skipFully(fis, start);
                        } catch (IOException e) {
                            Streams.closeQuietly(fis);
                            throw e;
                        }
                        return new Streams.Bounded(fis, count);
                    }
                });
            } catch (Exception e) {
                return null;
            }
        }

        /** 从补充包里提供文件 */
        private WebResourceResponse servePack(String rest, WebResourceRequest request) {
            int slash = rest.indexOf('/');
            if (slash <= 0) return null;

            final String packId = percentDecode(rest.substring(0, slash));
            final String rel = stripQueryAndDecode(rest.substring(slash + 1));

            ensureScanned();
            final PackStore.Pack pack = packStore.get(packId);
            if (pack == null || !pack.ok) return null;

            String mime = guessMime(rel);
            boolean isMedia = mime.startsWith("audio/") || mime.startsWith("video/");

            try {
                if (!isMedia) {
                    InputStream in = packStore.open(pack, rel);
                    return new WebResourceResponse(mime, encodingFor(mime), 200, "OK", baseHeaders(), in);
                }

                long total = packStore.length(pack, rel);
                if (total <= 0) return null;
                return serveMedia(mime, total, rangeOf(request), new Opener() {
                    @Override
                    public InputStream open(long start, long count) throws IOException {
                        return packStore.openRange(pack, rel, start, count);
                    }
                });
            } catch (Exception e) {
                return null;
            }
        }

        private Map<String, String> baseHeaders() {
            Map<String, String> h = new HashMap<>();
            h.put("Cache-Control", "no-cache");
            return h;
        }

        private long assetLength(String assetPath) {
            try {
                AssetFileDescriptor fd = getAssets().openFd(assetPath);
                long len = fd.getLength();
                fd.close();
                return len;
            } catch (IOException e) {
                return -1;
            }
        }
    }

    /** 打开某个字节区间的能力（assets 与补充包各一种实现） */
    private interface Opener {
        InputStream open(long start, long count) throws IOException;
    }

    /**
     * 组装媒体响应：带 Range 回 206，否则回 200。
     *
     * 注意 must 声明 Accept-Ranges 与 Content-Length —— 少一个，
     * 部分播放器就不肯让你拖动进度条。
     */
    private WebResourceResponse serveMedia(String mime, long total, String rangeHeader,
                                           Opener opener) throws IOException {
        HttpRange.Spec spec = HttpRange.parse(rangeHeader, total);
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-cache");
        headers.put("Accept-Ranges", "bytes");
        headers.put("Content-Length", String.valueOf(spec.length()));

        if (spec.partial) {
            headers.put("Content-Range", spec.contentRange(total));
            return new WebResourceResponse(mime, null, 206, "Partial Content", headers,
                    opener.open(spec.start, spec.length()));
        }
        return new WebResourceResponse(mime, null, 200, "OK", headers,
                opener.open(0, spec.length()));
    }

    private static String rangeOf(WebResourceRequest request) {
        Map<String, String> h = request.getRequestHeaders();
        return h == null ? null : h.get("Range");
    }

    private static String stripQueryAndDecode(String rel) {
        String r = rel;
        int q = r.indexOf('?');
        if (q >= 0) r = r.substring(0, q);
        q = r.indexOf('#');
        if (q >= 0) r = r.substring(0, q);
        return percentDecode(r);
    }

    /**
     * 百分号解码（UTF-8）。
     *
     * 不能用 URLDecoder：它会把 '+' 解成空格，而素材文件名里 '+' 是合法字符
     * （前端用的是 encodeURIComponent，'+' 会写成 %2B）。
     */
    static String percentDecode(String s) {
        if (s == null || s.indexOf('%') < 0) return s;
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '%' && i + 2 < s.length()) {
                int hi = Character.digit(s.charAt(i + 1), 16);
                int lo = Character.digit(s.charAt(i + 2), 16);
                if (hi >= 0 && lo >= 0) {
                    out.write((hi << 4) | lo);
                    i += 2;
                    continue;
                }
            }
            byte[] b = String.valueOf(c).getBytes(java.nio.charset.StandardCharsets.UTF_8);
            out.write(b, 0, b.length);
        }
        return new String(out.toByteArray(), java.nio.charset.StandardCharsets.UTF_8);
    }

    private static String encodingFor(String mime) {
        if (mime.startsWith("text/") || mime.contains("json") || mime.contains("javascript")) {
            return "UTF-8";
        }
        return null;
    }

    static String guessMime(String name) {
        String n = name.toLowerCase(Locale.ROOT);
        if (n.endsWith(".html")) return "text/html";
        if (n.endsWith(".js")) return "text/javascript";
        if (n.endsWith(".css")) return "text/css";
        if (n.endsWith(".json")) return "application/json";
        if (n.endsWith(".lrc") || n.endsWith(".txt")) return "text/plain";
        if (n.endsWith(".mp3")) return "audio/mpeg";
        if (n.endsWith(".wav")) return "audio/wav";
        if (n.endsWith(".m4a") || n.endsWith(".mp4")) return "audio/mp4";
        if (n.endsWith(".aac")) return "audio/aac";
        if (n.endsWith(".ogg") || n.endsWith(".oga") || n.endsWith(".opus")) return "audio/ogg";
        if (n.endsWith(".flac")) return "audio/flac";
        if (n.endsWith(".webm")) return "audio/webm";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        return "application/octet-stream";
    }

        // 让音量键留给系统，其余按键交给网页（网页里绑了空格/方向键等快捷键）
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    // ---------------------------------------------------------------- 后台 / 锁屏保活

    /**
     * 网页里播放状态一变就调这里，转交给 {@link PlaybackService}：
     * 正在播放 → 起前台服务（常驻通知）+ 持有 CPU 唤醒锁，锁屏与切后台都不会被掐；
     * 暂停 → 释放唤醒锁（省电），通知改成「已暂停」。
     */
    private void onPlaybackState(boolean playing, String title, String subtitle,
                                 long positionMs, long durationMs) {
        // 播放时保持屏幕常亮（看歌词），暂停就允许息屏 —— 以前是无条件常亮
        if (playing) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        } else {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }
        PlaybackService.update(this, playing, title, subtitle, positionMs, durationMs);
    }

    /** 把服务/锁屏/耳机来的命令交给网页执行 */
    private void sendHostCommand(String command, double value) {
        if (webView == null) return;
        final String js = "window.__onHostCommand && window.__onHostCommand("
                + PackStore.quote(command) + "," + value + ")";
        webView.post(new Runnable() {
            @Override
            public void run() {
                if (webView != null) webView.evaluateJavascript(js, null);
            }
        });
    }

    /**
     * Android 13+ 要在运行时申请通知权限，否则前台服务的常驻通知不显示
     * （服务本身照常运行，只是用户看不到控制条）。
     */
    private void ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) return;
        try {
            if (checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                    != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{ "android.permission.POST_NOTIFICATIONS" },
                        REQ_NOTIFICATION);
            }
        } catch (Exception ignored) { }
    }

    @Override
    protected void onPause() {
        super.onPause();
        // ⚠️ 这里【故意不调】webView.onPause()：那是让 WebView 停下来的信号，
        //    会让熄屏/切后台时歌词同步停摆（历史上就是这样）。
        //    真正的省电交给「暂停时释放唤醒锁」来做。
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onDestroy() {
        PlaybackService.setBridge(null);
        PlaybackService.shutdown(this);      // 页面随 Activity 一起没了，服务没必要留着
        if (packStore != null) packStore.close();
        if (webView != null) {
            webView.loadUrl("about:blank");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}

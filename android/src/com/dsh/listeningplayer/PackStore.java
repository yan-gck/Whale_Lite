package com.dsh.listeningplayer;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * PackStore —— 补充包（.lppack）的发现、校验、读取与导入。
 *
 * 背景：
 *   单个 APK 有 2 GiB 硬上限（ZIP 中央目录用 32 位记录大小），本机素材约 3.0 GB，
 *   装不进一个安装包。于是拆成「安装包（前端 + 演示语料）+ 补充包（.lppack）」。
 *
 * 补充包就是标准 ZIP：
 *   manifest.json    包信息（set / lessons / version…）
 *   library.json     课程数据（时间轴 / 译文 / 题目 / 原题）—— 前端直接吃这份
 *   audio/&lt;目录名&gt;/…  与项目 audio/ 完全一致
 *
 * 关键设计：
 *   · 不解压。ZipFile 能直接在文件里随机定位，1.9 GB 的包不占额外空间。
 *   · 音频 Range（拖动进度条）用「取到条目流 → skipFully 到起点 → 限长读」实现。
 *     ZipFile 的流虽然不能 seek，但包里的音频是 STORED（未压缩）存放的，
 *     skip 只改偏移不真读数据，所以拖动是廉价的。
 *   · 这个类【只用 java.*】，不引用任何 Android API，因此能在电脑上
 *     用 javac/java 直接跑测试（tools/java/PackSelfTest.java）。
 */
public class PackStore {

    public static final String FORMAT = "listening-player-pack";
    public static final String EXT = ".lppack";

    /** 单个包信息（含校验结果） */
    public static class Pack {
        public final String id;         // 文件名去掉扩展名，作为 URL 里的包名
        public final File file;
        public final long sizeBytes;
        public final long stamp;        // 修改时间，用于判断缓存是否还有效

        public boolean ok;              // 校验通过才可读
        public String error = "";       // 校验失败原因（给用户看的）
        public String format = "";
        public int version;
        public String set = "";
        public int lessons;
        public boolean hasLibrary;

        ZipFile zip;

        Pack(String id, File file) {
            this.id = id;
            this.file = file;
            this.sizeBytes = file.length();
            this.stamp = file.lastModified();
        }
    }

    private final File dir;
    private final Map<String, Pack> packs = new LinkedHashMap<>();
    private String cachedKey;
    private String cachedText;

    public PackStore(File dir) {
        this.dir = dir;
    }

    public File dir() {
        return dir;
    }

    public String dirPath() {
        return dir == null ? "" : dir.getAbsolutePath();
    }

    public long freeBytes() {
        return dir == null ? 0 : dir.getUsableSpace();
    }

    /** 已发现（含校验失败）的包，按 set 名排序 */
    public synchronized List<Pack> all() {
        List<Pack> list = new ArrayList<>(packs.values());
        Collections.sort(list, new Comparator<Pack>() {
            @Override
            public int compare(Pack a, Pack b) {
                int c = a.set.compareTo(b.set);
                return c != 0 ? c : a.id.compareTo(b.id);
            }
        });
        return list;
    }

    public synchronized Pack get(String id) {
        return id == null ? null : packs.get(id);
    }

    /**
     * 扫描目录，校验每个 .lppack。
     *
     * 已经打开且文件没变的包会复用（保留 ZipFile 句柄）：
     * 重新扫描时若把句柄全关掉，正在播放的音频会立刻断掉。
     */
    public synchronized List<Pack> scan() {
        Map<String, Pack> found = new LinkedHashMap<>();

        File[] files = dir == null ? null : dir.listFiles();
        if (files != null) {
            Arrays.sort(files, new Comparator<File>() {
                @Override
                public int compare(File a, File b) {
                    return a.getName().compareTo(b.getName());
                }
            });
            for (File f : files) {
                if (!f.isFile()) continue;
                String name = f.getName();
                if (!name.toLowerCase(Locale.ROOT).endsWith(EXT)) continue;
                String id = name.substring(0, name.length() - EXT.length());

                Pack old = packs.get(id);
                if (old != null && old.file.equals(f)
                        && old.sizeBytes == f.length() && old.stamp == f.lastModified()) {
                    found.put(id, old);       // 没变化，沿用已打开的句柄
                    continue;
                }
                if (old != null) closeQuietly(old);

                Pack p = new Pack(id, f);
                validate(p);
                found.put(id, p);
            }
        }

        // 目录里已经没有的包：关掉句柄
        for (Pack p : packs.values()) {
            if (!found.containsKey(p.id)) closeQuietly(p);
        }

        packs.clear();
        packs.putAll(found);
        cachedKey = null;
        cachedText = null;
        return all();
    }

    /** 打开并读 manifest.json，据此判断是不是合法的补充包 */
    private void validate(Pack p) {
        try {
            if (!p.file.isFile()) throw new IOException("文件不存在");
            // ⚠️ 必须指定 UTF-8：包里的条目名是中文。
            //    虽然打包时置了 UTF-8 名字标志（0x0800），显式指定更保险。
            p.zip = new ZipFile(p.file, StandardCharsets.UTF_8);

            ZipEntry m = p.zip.getEntry("manifest.json");
            if (m == null) throw new IOException("不是补充包：缺少 manifest.json");

            String text;
            InputStream in = null;
            try {
                in = p.zip.getInputStream(m);
                text = Streams.readText(in, 1 << 20);
            } finally {
                Streams.closeQuietly(in);
            }
            p.format = jsonString(text, "format");
            p.version = (int) jsonNumber(text, "version");
            p.set = jsonString(text, "set");
            p.lessons = (int) jsonNumber(text, "lessons");

            if (!FORMAT.equals(p.format)) {
                throw new IOException("格式不匹配：manifest 里写的是 \""
                        + (p.format.isEmpty() ? "(空)" : p.format) + "\"");
            }

            p.hasLibrary = p.zip.getEntry("library.json") != null;
            if (!p.hasLibrary) {
                throw new IOException("这是旧版补充包（没有 library.json）"
                        + "，请用 node tools/build-pack.js 重新打包后导入");
            }
            p.ok = true;
            p.error = "";
        } catch (Exception e) {
            p.ok = false;
            p.hasLibrary = false;
            p.error = messageOf(e);
            closeQuietly(p);
        }
    }

    // ------------------------------------------------------------ 读取

    private ZipEntry entryOf(Pack p, String relPath) throws IOException {
        if (p == null || !p.ok || p.zip == null) {
            throw new IOException("补充包不可用" + (p != null && !p.error.isEmpty() ? "：" + p.error : ""));
        }
        String rel = normalize(relPath);
        ZipEntry e = p.zip.getEntry(rel);
        if (e == null || e.isDirectory()) throw new IOException("包里没有 " + rel);
        return e;
    }

    /** 归一化并挡住路径穿越（URL 里的相对路径不可信） */
    public static String normalize(String relPath) throws IOException {
        String r = relPath == null ? "" : relPath.replace('\\', '/');
        while (r.startsWith("/")) r = r.substring(1);
        if (r.isEmpty() || r.contains("..") || r.contains(":") || r.startsWith(".")) {
            throw new IOException("非法路径：" + relPath);
        }
        return r;
    }

    public long length(Pack p, String relPath) throws IOException {
        ZipEntry e = entryOf(p, relPath);
        long n = e.getSize();
        if (n >= 0) return n;
        // 中央目录里没记大小（罕见）：读到内存数一遍
        InputStream in = null;
        try {
            in = p.zip.getInputStream(e);
            long total = 0;
            byte[] buf = new byte[65536];
            int r;
            while ((r = in.read(buf)) > 0) total += r;
            return total;
        } finally {
            Streams.closeQuietly(in);
        }
    }

    public InputStream open(Pack p, String relPath) throws IOException {
        return p.zip.getInputStream(entryOf(p, relPath));
    }

    /** 取 [start, start+count) 区间（音频 Range 用） */
    public InputStream openRange(Pack p, String relPath, long start, long count)
            throws IOException {
        ZipEntry e = entryOf(p, relPath);
        InputStream in = p.zip.getInputStream(e);
        try {
            if (start > 0) Streams.skipFully(in, start);
        } catch (IOException ioe) {
            Streams.closeQuietly(in);
            throw ioe;
        }
        return new Streams.Bounded(in, count);
    }

    /**
     * 读文本条目（UTF-8），只保留最近一次结果。
     *
     * library.json 有几 MB，而 WebView 的 JS 桥一次传送大字符串并不稳妥，
     * 所以前端按字符分片来取：先问总长度，再一块块拿。
     * 按【字符】切分不会切断 UTF-8 多字节序列，中文名字才安全。
     */
    public synchronized String readText(Pack p, String relPath) throws IOException {
        String key = p.id + "\u0000" + relPath;
        if (key.equals(cachedKey)) return cachedText;

        InputStream in = null;
        try {
            in = open(p, relPath);
            String text = Streams.readText(in, 64 * 1024 * 1024);
            cachedKey = key;
            cachedText = text;
            return text;
        } finally {
            Streams.closeQuietly(in);
        }
    }

    public synchronized int textLength(Pack p, String relPath) {
        try {
            return readText(p, relPath).length();
        } catch (Exception e) {
            return -1;
        }
    }

    public synchronized String textChunk(Pack p, String relPath, int from, int len) {
        try {
            String text = readText(p, relPath);
            // 起点越界回空串（不是 null）：前端靠「拿到空串」判断读完，
            // 而 null 表示读取失败，两者含义不能混
            if (from < 0 || from >= text.length()) return "";
            int to = Math.min(text.length(), from + Math.max(0, len));
            return text.substring(from, to);
        } catch (Exception e) {
            return null;
        }
    }

    // ------------------------------------------------------------ 导入 / 删除

    /** 导入进度回调（就是 Streams 的拷贝进度） */
    public interface Progress extends Streams.CopyProgress {
    }

    /**
     * 把用户选中的 .lppack 复制进包目录。
     *
     * 先写 .part 临时文件，校验通过才改名 —— 中途取消/断电不会留下
     * 一个「看起来已安装、其实读不了」的坏包。
     */
    public synchronized Pack importStream(InputStream in, String fileName, long totalBytes,
                                          Progress cb) throws IOException {
        if (dir == null) throw new IOException("没有可用的补充包目录");
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("无法创建目录：" + dir.getAbsolutePath());

        String name = safeName(fileName);
        String id = name.substring(0, name.length() - EXT.length());
        File target = new File(dir, name);
        File temp = new File(dir, name + ".part");

        if (totalBytes > 0) {
            long usable = dir.getUsableSpace();
            long need = totalBytes + 32L * 1024 * 1024;      // 留 32 MB 余量
            if (usable > 0 && usable < need) {
                throw new IOException("存储空间不足：需要约 " + mb(need)
                        + "，可用 " + mb(usable) + "。可先删掉导入用的原始文件再试。");
            }
        }

        OutputStream out = null;
        try {
            out = new BufferedOutputStream(new FileOutputStream(temp), 1 << 20);
            long copied = Streams.copy(in, out, totalBytes, cb);
            out.close();
            out = null;

            Pack check = new Pack(id, temp);
            validate(check);
            if (!check.ok) {
                String why = check.error;
                closeQuietly(check);
                throw new IOException("文件不是可用的补充包：" + why);
            }
            closeQuietly(check);

            if (target.exists() && !target.delete()) {
                throw new IOException("同名补充包正在使用，无法覆盖：" + name);
            }
            if (!temp.renameTo(target)) {
                // 个别文件系统不允许改名 → 退回「复制到目标」
                copyFile(temp, target);
                temp.delete();
            }
            scan();
            Pack p = packs.get(id);
            if (p == null) throw new IOException("导入后未能识别该补充包");
            return p;
        } catch (IOException e) {
            temp.delete();
            throw e;
        } finally {
            Streams.closeQuietly(out);
        }
    }

    public synchronized boolean delete(String id) {
        Pack p = packs.get(id);
        if (p == null) return false;
        closeQuietly(p);
        boolean gone = p.file.delete();
        packs.remove(id);
        cachedKey = null;
        cachedText = null;
        return gone;
    }

    public synchronized void close() {
        for (Pack p : packs.values()) closeQuietly(p);
        packs.clear();
        cachedKey = null;
        cachedText = null;
    }

    // ------------------------------------------------------------ JSON

    /** 给前端用的包列表（JS 侧直接 JSON.parse） */
    public synchronized String toJson() {
        StringBuilder sb = new StringBuilder();
        sb.append("{\"supported\":true");
        sb.append(",\"dir\":").append(quote(dirPath()));
        sb.append(",\"freeBytes\":").append(freeBytes());
        sb.append(",\"packs\":[");
        boolean first = true;
        for (Pack p : all()) {
            if (!first) sb.append(',');
            first = false;
            sb.append("{\"id\":").append(quote(p.id));
            sb.append(",\"file\":").append(quote(p.file.getName()));
            sb.append(",\"sizeBytes\":").append(p.sizeBytes);
            sb.append(",\"ok\":").append(p.ok);
            sb.append(",\"error\":").append(quote(p.error));
            sb.append(",\"format\":").append(quote(p.format));
            sb.append(",\"version\":").append(p.version);
            sb.append(",\"set\":").append(quote(p.set));
            sb.append(",\"lessons\":").append(p.lessons);
            sb.append(",\"hasLibrary\":").append(p.hasLibrary);
            sb.append('}');
        }
        sb.append("]}");
        return sb.toString();
    }

    // ------------------------------------------------------------ 工具

    private static String safeName(String fileName) {
        String base = fileName == null ? "" : fileName.replace('\\', '/');
        int slash = base.lastIndexOf('/');
        if (slash >= 0) base = base.substring(slash + 1);
        base = base.replaceAll("[\\x00-\\x1f<>:\"|?*]", "_").trim();
        if (base.isEmpty()) base = "pack-" + System.currentTimeMillis();
        if (!base.toLowerCase(Locale.ROOT).endsWith(EXT)) {
            int dot = base.lastIndexOf('.');
            if (dot > 0) base = base.substring(0, dot);
            base = base + EXT;
        }
        if (base.length() > 80) {
            base = base.substring(0, 80 - EXT.length()) + EXT;
        }
        return base;
    }

    private static void copyFile(File from, File to) throws IOException {
        InputStream in = null;
        OutputStream out = null;
        try {
            in = new java.io.FileInputStream(from);
            out = new BufferedOutputStream(new FileOutputStream(to), 1 << 20);
            Streams.copy(in, out, from.length(), null);
        } finally {
            Streams.closeQuietly(in);
            Streams.closeQuietly(out);
        }
    }

    private static void closeQuietly(Pack p) {
        if (p == null) return;
        Streams.closeQuietly(p.zip);
        p.zip = null;
    }

    private static String messageOf(Throwable e) {
        String m = e.getMessage();
        if (m == null || m.isEmpty()) m = e.getClass().getSimpleName();
        return m;
    }

    private static String mb(long bytes) {
        return String.format(Locale.ROOT, "%.0f MB", bytes / 1048576.0);
    }

    /** JSON 字符串字面量（中文原样输出，UTF-8 交给 evaluateJavascript） */
    public static String quote(String s) {
        if (s == null) return "null";
        StringBuilder sb = new StringBuilder(s.length() + 8);
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':  sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                case '\b': sb.append("\\b"); break;
                case '\f': sb.append("\\f"); break;
                default:
                    if (c < 0x20) sb.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        sb.append('"');
        return sb.toString();
    }

    /**
     * 从 JSON 里取一个字符串字段。
     *
     * 只用来读【我们自己生成的】manifest.json（结构扁平、无嵌套同名键），
     * 所以没有引入完整 JSON 解析器 —— Android 内置的 org.json 也够用，
     * 但那会把本类绑死在 Android 上，就没法在电脑上跑测试了。
     */
    public static String jsonString(String json, String key) {
        if (json == null) return "";
        int i = json.indexOf("\"" + key + "\"");
        if (i < 0) return "";
        i = json.indexOf(':', i + key.length() + 2);
        if (i < 0) return "";
        i++;
        while (i < json.length() && Character.isWhitespace(json.charAt(i))) i++;
        if (i >= json.length() || json.charAt(i) != '"') return "";
        i++;
        StringBuilder sb = new StringBuilder();
        while (i < json.length()) {
            char c = json.charAt(i++);
            if (c == '"') break;
            if (c == '\\' && i < json.length()) {
                char e = json.charAt(i++);
                switch (e) {
                    case 'n': sb.append('\n'); break;
                    case 't': sb.append('\t'); break;
                    case 'r': sb.append('\r'); break;
                    case 'b': sb.append('\b'); break;
                    case 'f': sb.append('\f'); break;
                    case 'u':
                        if (i + 4 <= json.length()) {
                            try {
                                sb.append((char) Integer.parseInt(json.substring(i, i + 4), 16));
                            } catch (NumberFormatException ignored) { }
                            i += 4;
                        }
                        break;
                    default: sb.append(e);
                }
            } else {
                sb.append(c);
            }
        }
        return sb.toString();
    }

    /** 取一个数字字段；取不到返回 -1 */
    public static long jsonNumber(String json, String key) {
        if (json == null) return -1;
        int i = json.indexOf("\"" + key + "\"");
        if (i < 0) return -1;
        i = json.indexOf(':', i + key.length() + 2);
        if (i < 0) return -1;
        i++;
        while (i < json.length() && Character.isWhitespace(json.charAt(i))) i++;
        int j = i;
        while (j < json.length() && (Character.isDigit(json.charAt(j)) || json.charAt(j) == '-')) j++;
        if (j == i) return -1;
        try {
            return Long.parseLong(json.substring(i, j));
        } catch (NumberFormatException e) {
            return -1;
        }
    }
}

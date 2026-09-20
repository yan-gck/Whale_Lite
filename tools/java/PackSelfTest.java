import com.dsh.listeningplayer.HttpRange;
import com.dsh.listeningplayer.PackStore;
import com.dsh.listeningplayer.Streams;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;

/**
 * PackSelfTest —— 补充包读取逻辑的单元测试（在电脑上跑，不需要手机）。
 *
 * 为什么要有它：
 *   补充包读取 = 「ZIP 随机访问 + 手工 Range」，这两件事都很难在手机上调试：
 *   进度条能拖但位置错了、中文文件名变成乱码、拖动时播放断流……
 *   而 PackStore / HttpRange / Streams 都只用 java.*，所以可以直接用
 *   普通 javac + java 在电脑上把它们跑一遍。
 *
 * 用法（由 tools/test.js 自动调用）：
 *   java PackSelfTest &lt;补充包&gt; &lt;原始音频&gt; &lt;包内条目路径&gt; &lt;空工作目录&gt;
 *                     [期望的包名] [期望课程数] [原文里应出现的内容]
 *
 * 退出码 0 表示全部通过，非 0 会打印失败原因。
 */
public class PackSelfTest {

    private static int checks = 0;
    private static String expectedSet = "测试-素材";
    private static String lrcMarker = "第一句中文原文";
    private static int expectedLessons = 1;      // 测试包只有 1 门课；真实包用参数传

    private static void check(boolean cond, String what) {
        checks++;
        if (!cond) throw new AssertionError("✗ " + what);
    }

    private static void eq(long a, long b, String what) {
        checks++;
        if (a != b) throw new AssertionError("✗ " + what + "：期望 " + b + "，实际 " + a);
    }

    private static void eqStr(String a, String b, String what) {
        checks++;
        if (a == null || !a.equals(b)) {
            throw new AssertionError("✗ " + what + "：期望 \"" + b + "\"，实际 \"" + a + "\"");
        }
    }

    private static byte[] readFile(File f) throws IOException {
        return Files.readAllBytes(f.toPath());
    }

    private static byte[] readStream(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toByteArray();
    }

    public static void main(String[] args) throws Exception {
        if (args.length < 4) {
            System.err.println("用法：PackSelfTest <补充包> <原始音频> <包内条目路径> <工作目录>");
            System.exit(2);
        }
        File packFile = new File(args[0]);
        File origAudio = new File(args[1]);
        String entryPath = args[2];
        File work = new File(args[3]);
        if (args.length > 4 && !args[4].isEmpty()) expectedSet = args[4];
        if (args.length > 5 && !args[5].isEmpty()) expectedLessons = Integer.parseInt(args[5]);
        // 想跳过原文内容校验就不要传第 7 个参数
        // （PowerShell 会把空参数丢掉，所以没有「传空串跳过」这种用法）
        if (args.length > 6 && !args[6].isEmpty()) lrcMarker = args[6];

        rangeTests();
        packTests(packFile, origAudio, entryPath, work);
        badPackTests(work);

        System.out.println("JAVA-OK " + checks);
    }

    // ------------------------------------------------------------ Range 解析

    private static void rangeTests() {
        HttpRange.Spec s;

        s = HttpRange.parse(null, 1000);
        check(!s.partial, "没有 Range 头时应回完整 200");
        eq(s.start, 0, "完整区间起点");
        eq(s.end, 999, "完整区间终点");

        s = HttpRange.parse("bytes=100-199", 1000);
        check(s.partial, "bytes=100-199 应回 206");
        eq(s.start, 100, "闭区间起点");
        eq(s.end, 199, "闭区间终点");
        eq(s.length(), 100, "闭区间长度");
        eqStr(s.contentRange(1000), "bytes 100-199/1000", "Content-Range 头");

        s = HttpRange.parse("bytes=100-", 1000);
        check(s.partial, "bytes=100- 应回 206");
        eq(s.end, 999, "开区间应到结尾");

        s = HttpRange.parse("bytes=-100", 1000);
        check(s.partial, "bytes=-100 应回 206");
        eq(s.start, 900, "后缀范围起点");
        eq(s.end, 999, "后缀范围终点");

        s = HttpRange.parse("bytes=0-0", 1000);
        check(s.partial, "bytes=0-0 是合法区间");
        eq(s.length(), 1, "单字节区间");

        // 播放器偶尔会请求「超出末尾」的区间：退回完整响应比 416 更宽容
        s = HttpRange.parse("bytes=2000-3000", 1000);
        check(!s.partial, "越界区间应退回完整响应");
        s = HttpRange.parse("bytes=500-100", 1000);
        check(!s.partial, "起点大于终点应退回完整响应");
        s = HttpRange.parse("items=0-10", 1000);
        check(!s.partial, "非 bytes 单位应退回完整响应");
        s = HttpRange.parse("bytes=abc", 1000);
        check(!s.partial, "无法解析应退回完整响应");
        s = HttpRange.parse("bytes=99999-", 1000);
        check(!s.partial, "起点越界应退回完整响应");

        // 多区间只服务第一段（播放器实际只用单区间）
        s = HttpRange.parse("bytes=0-99,200-299", 1000);
        check(s.partial, "多区间应取第一段");
        eq(s.end, 99, "多区间第一段终点");
    }

    // ------------------------------------------------------------ 补充包读取

    private static void packTests(File packFile, File origAudio, String entryPath,
                                  File work) throws Exception {
        File dir = new File(work, "packs");
        check(dir.mkdirs() || dir.isDirectory(), "创建补充包目录");

        PackStore store = new PackStore(dir);
        eq(store.scan().size(), 0, "空目录里没有补充包");

        // 导入（相当于用户在 App 里点了「导入 .lppack」）
        InputStream in = new FileInputStream(packFile);
        PackStore.Pack p;
        try {
            p = store.importStream(in, packFile.getName(), packFile.length(), null);
        } finally {
            in.close();
        }
        check(p.ok, "导入后校验通过：" + p.error);
        eqStr(p.set, expectedSet, "从 manifest.json 读出中文 set 名");
        eq(p.lessons, expectedLessons, "manifest 里的课程数");
        check(p.hasLibrary, "manifest 标记了 library.json");
        eq(p.version, 2, "包格式版本");
        eq(store.scan().size(), 1, "扫描到 1 个补充包");
        check(store.get(p.id) == p, "文件没变时应复用已打开的包");

        // 中文条目名 / 长度
        byte[] orig = readFile(origAudio);
        eq(store.length(p, entryPath), orig.length, "包内音频长度与原始文件一致");

        // 完整读取
        InputStream full = store.open(p, entryPath);
        try {
            check(Arrays.equals(readStream(full), orig), "完整读取内容与原始文件一致");
        } finally {
            full.close();
        }

        // Range：头部、中部、尾部、单字节
        assertRange(store, p, entryPath, orig, 0, 10);
        assertRange(store, p, entryPath, orig, 100, 50);
        assertRange(store, p, entryPath, orig, orig.length - 1000, 1000);
        assertRange(store, p, entryPath, orig, orig.length - 1, 1);
        assertRange(store, p, entryPath, orig, 0, orig.length);

        // 两个流同时读同一个条目（播放器一边播一边预取就会这样）：
        // ZipFile 共享一个底层句柄，读串了就听到杂音，所以要交错读并逐字节比对
        InputStream a = store.openRange(p, entryPath, 0, orig.length);
        InputStream b = store.openRange(p, entryPath, 1000, orig.length - 1000);
        try {
            byte[] gotA = new byte[orig.length];
            byte[] gotB = new byte[orig.length - 1000];
            int offA = 0, offB = 0;
            while (offA < gotA.length || offB < gotB.length) {
                if (offA < gotA.length) {
                    int n = a.read(gotA, offA, Math.min(4096, gotA.length - offA));
                    if (n < 0) offA = gotA.length; else offA += n;
                }
                if (offB < gotB.length) {
                    int n = b.read(gotB, offB, Math.min(4096, gotB.length - offB));
                    if (n < 0) offB = gotB.length; else offB += n;
                }
            }
            check(Arrays.equals(gotA, orig), "并发读取流 A 内容正确（ZipFile 句柄共享时不能串字节）");
            check(Arrays.equals(gotB, Arrays.copyOfRange(orig, 1000, orig.length)),
                    "并发读取流 B 内容正确");
        } finally {
            a.close();
            b.close();
        }

        // 文本条目（UTF-8 中文）：整体、长度、分片拼接
        String lrcPath = entryPath.replaceAll("\\.(mp3|wav|m4a|flac|ogg|opus)$", ".lrc");
        String text = store.readText(p, lrcPath);
        check(text.length() > 0, "文本条目应能读到内容：" + lrcPath);
        if (!lrcMarker.isEmpty()) {
            check(text.contains(lrcMarker), "UTF-8 中文文本条目读取正确：" + lrcMarker);
        }
        int len = store.textLength(p, lrcPath);
        eq(len, text.length(), "textLength 与文本长度一致");
        StringBuilder joined = new StringBuilder();
        for (int from = 0; from < len; from += 3) {           // 故意用 3 字符的小片
            String chunk = store.textChunk(p, lrcPath, from, 3);
            check(chunk != null, "分片读取不应返回 null");
            joined.append(chunk);
        }
        eqStr(joined.toString(), text, "分片拼接结果与整体一致（按字符切片不会切断 UTF-8）");
        String past = store.textChunk(p, lrcPath, len + 5, 3);
        check(past != null, "越界起点不应返回 null（null 专指读取失败）");
        eq(past.length(), 0, "越界起点返回空串");

        // library.json 能被读到（前端就是靠它建课程列表的）
        String lib = store.readText(p, "library.json");
        check(lib.contains("\"lessons\""), "library.json 可读");

        // 路径穿越必须挡住
        assertThrows(store, p, "../manifest.json", "拒绝 ../ 路径穿越");
        assertThrows(store, p, "/etc/passwd", "拒绝绝对路径");
        assertThrows(store, p, "audio/不存在的文件.mp3", "不存在的条目应报错");

        // 已安装的包不能被非法文件覆盖坏掉
        File junk = new File(work, "junk.lppack");
        FileOutputStream fo = new FileOutputStream(junk);
        fo.write("这不是 ZIP".getBytes(StandardCharsets.UTF_8));
        fo.close();
        boolean threw = false;
        InputStream jin = new FileInputStream(junk);
        try {
            store.importStream(jin, "junk.lppack", junk.length(), null);
        } catch (IOException e) {
            threw = true;
        } finally {
            jin.close();
        }
        check(threw, "非法文件必须被拒绝");
        eq(store.scan().size(), 1, "拒绝非法文件后原有补充包仍在");
        check(store.get(p.id).ok, "原有补充包仍可用（不会被半个文件覆盖）");
        File[] left = dir.listFiles();
        int parts = 0;
        if (left != null) {
            for (File f : left) if (f.getName().endsWith(".part")) parts++;
        }
        eq(parts, 0, "失败的导入不应留下 .part 临时文件");

        // 删除
        check(store.delete(p.id), "删除补充包");
        eq(store.scan().size(), 0, "删除后扫描不到");
        check(!p.file.exists(), "补充包文件已从磁盘删除");
    }

    /** 坏文件必须给出明确原因，而不是静默失败（用户要的是「为什么不能用」） */
    private static void badPackTests(File work) throws Exception {
        File dir = new File(work, "packs-old");
        check(dir.mkdirs() || dir.isDirectory(), "创建目录");
        PackStore store = new PackStore(dir);
        store.scan();
        File notZip = new File(dir, "坏包.lppack");
        FileOutputStream fo = new FileOutputStream(notZip);
        fo.write(new byte[]{ 'P', 'K', 3, 4, 0, 0, 0, 0 });
        fo.close();

        java.util.List<PackStore.Pack> list = store.scan();
        eq(list.size(), 1, "坏包也会被列出来（好让用户看到失败原因）");
        check(!list.get(0).ok, "坏包应标记为不可用");
        check(list.get(0).error.length() > 0, "坏包必须带原因：" + list.get(0).error);

        // toJson 是给前端的面板数据，字段缺失会让界面变成空白
        String json = store.toJson();
        check(json.contains("\"ok\":false"), "toJson 里带上了 ok 状态");
        check(json.contains("\"packs\":["), "toJson 结构正确");
        check(json.contains("坏包"), "toJson 里的中文名没有被丢掉");
        store.close();
    }

    private static void assertRange(PackStore store, PackStore.Pack p, String entry,
                                    byte[] orig, long start, long count) throws IOException {
        InputStream in = store.openRange(p, entry, start, count);
        try {
            byte[] got = readStream(in);
            eq(got.length, count, "Range " + start + "+" + count + " 的字节数");
            byte[] want = Arrays.copyOfRange(orig, (int) start, (int) (start + count));
            check(Arrays.equals(got, want), "Range " + start + "+" + count + " 的内容");
        } finally {
            in.close();
        }
    }

    private static void assertThrows(PackStore store, PackStore.Pack p, String rel, String what) {
        checks++;
        try {
            InputStream in = store.open(p, rel);
            Streams.closeQuietly(in);
            throw new AssertionError("✗ " + what + "（居然成功了）");
        } catch (IOException expected) {
            // 正常
        }
    }
}

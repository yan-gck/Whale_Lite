package com.dsh.listeningplayer;

import java.io.ByteArrayOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Streams —— 读取资源时反复要用到的几个小工具。
 *
 * 这些方法【只依赖 java.*】，不碰任何 Android API，因此可以在电脑上
 * 用普通 javac/java 直接跑单元测试（见 tools/java/PackSelfTest.java）。
 * 媒体区间定位这种容易写错、又难在手机上调试的逻辑，就该放在这一层。
 */
public final class Streams {

    private Streams() { }

    /**
     * 精确跳过 n 字节。
     *
     * 为什么不能只用 InputStream.skip()：它允许「跳过少于请求的字节数」
     * （文件流到末尾、管道没数据时都会这样），甚至返回 0。
     * 对音频 Range 请求来说，跳错位置 = 播放器听到错误的片段，
     * 所以这里循环跳，跳不动就退化成 read。
     */
    public static void skipFully(InputStream in, long n) throws IOException {
        byte[] buf = null;
        long left = n;
        while (left > 0) {
            long skipped = in.skip(left);
            if (skipped > 0) {
                left -= skipped;
                continue;
            }
            if (buf == null) buf = new byte[8192];
            int r = in.read(buf, 0, (int) Math.min(buf.length, left));
            if (r < 0) throw new IOException("流提前结束：还需跳过 " + left + " 字节");
            left -= r;
        }
    }

    /** 把整个流读成字节数组（带上限保护，避免损坏的条目把内存吃光） */
    public static byte[] readAll(InputStream in, int maxBytes) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[65536];
        int n;
        while ((n = in.read(buf)) > 0) {
            if (out.size() + n > maxBytes) {
                throw new IOException("内容超过上限 " + maxBytes + " 字节");
            }
            out.write(buf, 0, n);
        }
        return out.toByteArray();
    }

    public static String readText(InputStream in, int maxBytes) throws IOException {
        return new String(readAll(in, maxBytes), StandardCharsets.UTF_8);
    }

    /** 拷贝流，每拷一块回调一次（用于显示导入进度） */
    public interface CopyProgress {
        void onProgress(long copied, long total);
    }

    public static long copy(InputStream in, OutputStream out, long total,
                            CopyProgress cb) throws IOException {
        byte[] buf = new byte[1024 * 1024];
        long copied = 0;
        int n;
        while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
            copied += n;
            if (cb != null) cb.onProgress(copied, total);
        }
        out.flush();
        return copied;
    }

    /** 只允许读取前 limit 字节的包装流，用于实现 Range 响应 */
    public static class Bounded extends FilterInputStream {
        private long remaining;

        public Bounded(InputStream in, long limit) {
            super(in);
            this.remaining = limit;
        }

        @Override
        public int read() throws IOException {
            if (remaining <= 0) return -1;
            int b = super.read();
            if (b >= 0) remaining--;
            return b;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            if (remaining <= 0) return -1;
            int toRead = (int) Math.min(len, remaining);
            int n = super.read(b, off, toRead);
            if (n > 0) remaining -= n;
            return n;
        }

        @Override
        public long skip(long n) throws IOException {
            long s = super.skip(Math.min(n, remaining));
            if (s > 0) remaining -= s;
            return s;
        }

        @Override
        public int available() throws IOException {
            return (int) Math.min(super.available(), Math.max(0, remaining));
        }
    }

    public static void closeQuietly(java.io.Closeable c) {
        if (c == null) return;
        try { c.close(); } catch (Exception ignored) { }
    }
}

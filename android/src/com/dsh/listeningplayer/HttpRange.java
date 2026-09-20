package com.dsh.listeningplayer;

/**
 * HttpRange —— 解析 HTTP Range 请求头（媒体拖动进度条全靠它）。
 *
 * 支持的写法（RFC 7233）：
 *   bytes=100-199   闭区间
 *   bytes=100-      从 100 到结尾
 *   bytes=-500      最后 500 字节
 *
 * 单独拎出来是因为这段逻辑最容易出错，而且出错的症状很隐蔽：
 * 进度条能拖、但听到的位置是错的。抽成纯 Java 类后可以在电脑上直接跑测试
 * （tools/java/PackSelfTest.java），不必刷手机。
 */
public final class HttpRange {

    /** 解析结果：partial=true 表示应当回 206，否则回完整 200 */
    public static final class Spec {
        public final boolean partial;
        public final long start;
        public final long end;       // 含端点

        Spec(boolean partial, long start, long end) {
            this.partial = partial;
            this.start = start;
            this.end = end;
        }

        public long length() {
            return end - start + 1;
        }

        public String contentRange(long total) {
            return "bytes " + start + "-" + end + "/" + total;
        }
    }

    private HttpRange() { }

    /** 不带 Range 头（或无法解析）时返回完整区间 */
    public static Spec full(long total) {
        return new Spec(false, 0, Math.max(0, total - 1));
    }

    /**
     * @param header Range 头原文，可为 null
     * @param total  资源总字节数；必须 > 0
     */
    public static Spec parse(String header, long total) {
        if (header == null || total <= 0) return full(total);

        String h = header.trim();
        if (!h.startsWith("bytes=")) return full(total);

        // 多区间（bytes=0-99,200-299）这里只服务第一段：
        // 播放器实际只用单区间，返回 multipart/byteranges 得不偿失。
        String spec = h.substring(6).trim();
        int comma = spec.indexOf(',');
        if (comma >= 0) spec = spec.substring(0, comma).trim();

        int dash = spec.indexOf('-');
        if (dash < 0) return full(total);

        String a = spec.substring(0, dash).trim();
        String b = spec.substring(dash + 1).trim();

        try {
            long start;
            long end;
            if (a.isEmpty()) {
                // 后缀范围：最后 N 字节
                if (b.isEmpty()) return full(total);
                long suffix = Long.parseLong(b);
                if (suffix <= 0) return full(total);
                start = Math.max(0, total - suffix);
                end = total - 1;
            } else {
                start = Long.parseLong(a);
                end = b.isEmpty() ? total - 1 : Math.min(Long.parseLong(b), total - 1);
            }
            // 越界或不合法 → 退回完整响应（比返回 416 更宽容，
            // WebView 的媒体栈对 416 的处理并不一致）
            if (start < 0 || start >= total || start > end) return full(total);
            return new Spec(true, start, end);
        } catch (NumberFormatException e) {
            return full(total);
        }
    }
}

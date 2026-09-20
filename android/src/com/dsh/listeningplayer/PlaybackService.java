package com.dsh.listeningplayer;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

/**
 * PlaybackService —— 后台 / 锁屏保活
 *
 * 为什么需要它：
 *   播放器是 WebView 壳，音频其实由网页里的 &lt;audio&gt; 播放。App 一退到后台，
 *   进程就成了「后台进程」，系统随时可以回收 —— 锁屏听听力会直接被掐断。
 *
 * 三件事一起做才有效：
 *   ① **前台服务**（带常驻通知）：进程变成前台优先级，锁屏、切应用都不会被回收。
 *      Android 14 起必须声明 foregroundServiceType="mediaPlayback" 并持有对应权限。
 *   ② **PARTIAL_WAKE_LOCK**：熄屏后 CPU 若进入休眠，音频会断续、循环也会失效。
 *      只在「正在播放」时持有，暂停即释放，避免耗电。
 *   ③ **MediaSession**：锁屏与通知栏出现播放控制，并接收耳机/车机的播放暂停键；
 *      音频焦点也在这里申请，别的 App 放声音时我们先让路。
 *
 * 通知上的按钮与锁屏控制都要作用到网页里的播放器，所以命令统一走
 * {@link Bridge#sendCommand}（由 MainActivity 注入）回抛给 JS。
 */
public class PlaybackService extends Service {

    private static final String CHANNEL_ID = "playback";
    private static final int NOTIFICATION_ID = 1001;

    public static final String ACTION_UPDATE = "com.dsh.listeningplayer.PLAYBACK_UPDATE";
    public static final String ACTION_STOP = "com.dsh.listeningplayer.PLAYBACK_STOP";
    public static final String ACTION_COMMAND = "com.dsh.listeningplayer.PLAYBACK_COMMAND";

    public static final String EXTRA_PLAYING = "playing";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_SUBTITLE = "subtitle";
    public static final String EXTRA_POSITION = "position";
    public static final String EXTRA_DURATION = "duration";
    public static final String EXTRA_COMMAND = "command";

    /**
     * 网页与本服务的连接口。用静态引用而不是广播：
     * 只有本 App 一个消费者，广播要多写一个 Receiver 和一堆注册/注销。
     */
    public interface Bridge {
        /** 把命令交给网页执行（toggle / play / pause / prevLine / nextLine / seek …） */
        void sendCommand(String command, double value);
    }

    private static volatile Bridge bridge;

    /** MainActivity 在 onCreate 里注册，onDestroy 里清掉（避免持有已销毁的 Activity） */
    public static void setBridge(Bridge b) {
        bridge = b;
    }

    private MediaSession session;
    private PowerManager.WakeLock wakeLock;
    private boolean playing = false;    private String title = "Whale Lite";
    private String subtitle = "";
    private long positionMs = 0;
    private long durationMs = 0;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable autoStop = new Runnable() {
        @Override
        public void run() {
            // 暂停后长时间没人管：收摊，免得通知栏永远挂着一条
            if (!playing) stopSelf();
        }
    };

    // ⚠️ 这里【故意不申请音频焦点】。
    //
    // 踩过的坑：音频其实是网页里的 <audio> 在放，Chromium 自己会去申请音频焦点
    // （logcat 里能看到 AudioFocusDelegate）。服务要是再申请一次，就变成「自己跟自己抢」：
    // 后申请的（本服务）拿到焦点，先申请的 Chromium 收到 AUDIOFOCUS_LOSS → 立刻暂停播放。
    // 现象是「按下播放键约 0.1 秒后自动暂停」，而且只有真机/模拟器上才复现。
    // 焦点策略（被来电打断时暂停等）交给 Chromium 处理即可。

    // ------------------------------------------------------------ 外部入口

    /** 播放状态变化时由 Activity 调用（JS 报上来的） */
    public static void update(Context ctx, boolean playing, String title, String subtitle,
                              long positionMs, long durationMs) {
        Intent i = new Intent(ctx, PlaybackService.class);
        i.setAction(ACTION_UPDATE);
        i.putExtra(EXTRA_PLAYING, playing);
        i.putExtra(EXTRA_TITLE, title);
        i.putExtra(EXTRA_SUBTITLE, subtitle);
        i.putExtra(EXTRA_POSITION, positionMs);
        i.putExtra(EXTRA_DURATION, durationMs);
        start(ctx, i);
    }

    /** 彻底停掉（Activity 销毁、或页面明确停止播放时） */
    public static void shutdown(Context ctx) {
        try {
            ctx.stopService(new Intent(ctx, PlaybackService.class));
        } catch (Exception ignored) { }
    }

    private static void start(Context ctx, Intent i) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i);
            else ctx.startService(i);
        } catch (Exception ignored) {
            // 后台启动前台服务在个别系统版本上会被拒；播放本身不受影响，只是没有常驻通知
        }
    }

    // ------------------------------------------------------------ 生命周期

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "listening-player:playback");
        wakeLock.setReferenceCounted(false);

        session = new MediaSession(this, "listening-player");
        session.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS
                | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { command("play", 0); }
            @Override public void onPause() { command("pause", 0); }
            @Override public void onStop() { command("stop", 0); }
            @Override public void onSkipToNext() { command("nextLine", 0); }
            @Override public void onSkipToPrevious() { command("prevLine", 0); }
            @Override public void onSeekTo(long pos) { command("seek", pos / 1000.0); }
        });
        session.setActive(true);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();

        // ⚠️ 用 startForegroundService 启动后必须在 5 秒内 startForeground，
        //    否则系统直接 ANR。所以这里先无条件进前台，再处理具体动作。
        startForegroundCompat(buildNotification());

        if (ACTION_STOP.equals(action)) {
            stopSelf();
            return START_NOT_STICKY;
        }

        if (ACTION_COMMAND.equals(action) && intent != null) {
            // 来自通知栏按钮：交给网页执行
            command(intent.getStringExtra(EXTRA_COMMAND), 0);
            return START_NOT_STICKY;
        }

        if (ACTION_UPDATE.equals(action) && intent != null) {
            playing = intent.getBooleanExtra(EXTRA_PLAYING, playing);
            String t = intent.getStringExtra(EXTRA_TITLE);
            String s = intent.getStringExtra(EXTRA_SUBTITLE);
            if (t != null && !t.isEmpty()) title = t;
            if (s != null) subtitle = s;
            positionMs = intent.getLongExtra(EXTRA_POSITION, positionMs);
            durationMs = intent.getLongExtra(EXTRA_DURATION, durationMs);
            applyPlaybackState();
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(autoStop);
        setWakeLock(false);
        if (session != null) {
            session.setActive(false);
            session.release();
            session = null;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(Service.STOP_FOREGROUND_REMOVE);
        } else {
            stopForeground(true);
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;   // 只用 startService，不需要绑定
    }

    // ------------------------------------------------------------ 状态

    private void applyPlaybackState() {
        if (playing) {
            setWakeLock(true);
            handler.removeCallbacks(autoStop);
        } else {
            setWakeLock(false);
            handler.removeCallbacks(autoStop);
            // 暂停 10 分钟后自动收掉服务（用户可能只是暂时切走）
            handler.postDelayed(autoStop, 10 * 60 * 1000L);
        }

        if (session != null) {
            int state = playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED;
            session.setPlaybackState(new PlaybackState.Builder()
                    .setActions(PlaybackState.ACTION_PLAY
                            | PlaybackState.ACTION_PAUSE
                            | PlaybackState.ACTION_PLAY_PAUSE
                            | PlaybackState.ACTION_STOP
                            | PlaybackState.ACTION_SEEK_TO
                            | PlaybackState.ACTION_SKIP_TO_NEXT
                            | PlaybackState.ACTION_SKIP_TO_PREVIOUS)
                    .setState(state, positionMs, playing ? 1f : 0f)
                    .build());
            session.setMetadata(new MediaMetadata.Builder()
                    .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                    .putString(MediaMetadata.METADATA_KEY_ARTIST, subtitle)
                    .putLong(MediaMetadata.METADATA_KEY_DURATION, durationMs)
                    .build());
        }

        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) {
            try {
                nm.notify(NOTIFICATION_ID, buildNotification());
            } catch (Exception ignored) { }
        }
    }

    private void setWakeLock(boolean on) {
        if (wakeLock == null) return;
        try {
            if (on && !wakeLock.isHeld()) wakeLock.acquire();
            else if (!on && wakeLock.isHeld()) wakeLock.release();
        } catch (Exception ignored) { }
    }

    private void command(String cmd, double value) {
        if (cmd == null || cmd.isEmpty()) return;
        Bridge b = bridge;
        if (b != null) {
            try {
                b.sendCommand(cmd, value);
                return;
            } catch (Exception ignored) { }
        }
        // 页面已经没了（进程还在跑服务）：直接收摊
        stopSelf();
    }

    // ------------------------------------------------------------ 通知

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "播放控制",
                NotificationManager.IMPORTANCE_LOW);      // 静音、不弹横幅
        ch.setDescription("Whale Lite 的后台播放控制");
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
    }

    private PendingIntent serviceIntent(String action, String cmd, int requestCode) {
        Intent i = new Intent(this, PlaybackService.class);
        i.setAction(action);
        if (cmd != null) i.putExtra(EXTRA_COMMAND, cmd);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getService(this, requestCode, i, flags);
    }

    private Notification buildNotification() {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent content = PendingIntent.getActivity(this, 0, open, flags);

        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);

        b.setSmallIcon(android.R.drawable.ic_media_play)
                .setContentTitle(title)
                .setContentText(playing ? (subtitle.isEmpty() ? "正在播放" : subtitle) : "已暂停")
                .setContentIntent(content)
                .setOngoing(playing)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setVisibility(Notification.VISIBILITY_PUBLIC)     // 锁屏上也能看到
                .addAction(new Notification.Action.Builder(
                        android.R.drawable.ic_media_previous, "上一句",
                        serviceIntent(ACTION_COMMAND, "prevLine", 11)).build())
                .addAction(new Notification.Action.Builder(
                        playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                        playing ? "暂停" : "播放",
                        serviceIntent(ACTION_COMMAND, "toggle", 12)).build())
                .addAction(new Notification.Action.Builder(
                        android.R.drawable.ic_media_next, "下一句",
                        serviceIntent(ACTION_COMMAND, "nextLine", 13)).build())
                .addAction(new Notification.Action.Builder(
                        android.R.drawable.ic_menu_close_clear_cancel, "停止",
                        serviceIntent(ACTION_STOP, null, 14)).build());

        if (session != null) {
            b.setStyle(new Notification.MediaStyle()
                    .setMediaSession(session.getSessionToken())
                    .setShowActionsInCompactView(0, 1, 2));
        }
        return b.build();
    }

    private void startForegroundCompat(Notification n) {
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(NOTIFICATION_ID, n);
        }
    }
}

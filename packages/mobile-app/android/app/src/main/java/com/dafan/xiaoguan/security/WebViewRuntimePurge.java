package com.dafan.xiaoguan.security;

import android.os.Handler;
import android.os.Looper;
import android.webkit.CookieManager;
import android.webkit.WebStorage;
import android.webkit.WebView;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Clears the live WebView's own storage and cache from inside a running process.
 *
 * <p>The cold-start path deletes Chromium's profile directories before the first WebView exists
 * (see {@link LocalDataPurge#purgeWebViewProfile}). That is not enough for an online revocation: the
 * process, the WebView and its {@code localStorage} are already alive, so the app must clear them
 * here and keep running instead of requiring a force-stop.</p>
 *
 * <p>Every call is marshalled onto the main thread, because {@link WebStorage} and
 * {@link CookieManager} only accept mutations there. The caller blocks until the work is done
 * (bounded) so it can decide whether the gate may be released.</p>
 */
public final class WebViewRuntimePurge {

    private static final long TIMEOUT_MS = 5_000;

    private WebViewRuntimePurge() {}

    /**
     * @param view the live WebView, or {@code null} when the bridge has none yet
     * @return true when the main-thread work completed
     */
    public static boolean clear(WebView view) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            return run(view);
        }
        CountDownLatch done = new CountDownLatch(1);
        AtomicBoolean ok = new AtomicBoolean(false);
        new Handler(Looper.getMainLooper()).post(() -> {
            try {
                ok.set(run(view));
            } finally {
                done.countDown();
            }
        });
        try {
            if (!done.await(TIMEOUT_MS, TimeUnit.MILLISECONDS)) return false;
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            return false;
        }
        return ok.get();
    }

    private static boolean run(WebView view) {
        boolean ok = true;
        try {
            WebStorage.getInstance().deleteAllData();
        } catch (RuntimeException ex) {
            ok = false;
        }
        try {
            CookieManager manager = CookieManager.getInstance();
            manager.removeAllCookies(null);
            manager.flush();
        } catch (RuntimeException ex) {
            ok = false;
        }
        if (view != null) {
            try {
                view.clearCache(true);
                view.clearFormData();
                view.clearHistory();
            } catch (RuntimeException ex) {
                ok = false;
            }
        }
        return ok;
    }
}

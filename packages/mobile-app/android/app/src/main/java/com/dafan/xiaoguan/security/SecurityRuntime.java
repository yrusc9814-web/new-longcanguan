package com.dafan.xiaoguan.security;

import android.content.Context;

import com.dafan.xiaoguan.uploads.AppOrigin;
import com.dafan.xiaoguan.uploads.UploadsGate;

import java.io.File;

/**
 * Process-wide security runtime.
 *
 * <p>Single owner for the gate store, the member token store and the uploads gate, so the plugin
 * and the WebView client always observe the same state. Installation is idempotent and requires no
 * Activity: it only touches app-private directories.</p>
 */
public final class SecurityRuntime {

    private static volatile SecurityRuntime instance;

    private final GateStore gateStore;
    private final MemberTokenStore tokenStore;
    private final SecurityGateService gateService;
    private final File uploadsDirectory;
    private final LocalDataPurge localDataPurge;
    private final SafetyBackupStore safetyBackupStore;
    private final MemberRemovedNoticeStore noticeStore;
    private volatile boolean pendingWipeProfilePurged;
    private volatile boolean runtimeWebViewCleared;

    private SecurityRuntime(Context context) {
        Context app = context.getApplicationContext();
        File securityDir = new File(app.getNoBackupFilesDir(), "security");
        this.gateStore = new GateStore(new FileGatePersistence(new File(securityDir, "gate-state.txt")));
        this.tokenStore = new MemberTokenStore(new KeystoreMemberTokenStorage(securityDir));
        this.gateService = new SecurityGateService(gateStore, tokenStore);
        this.uploadsDirectory = new File(app.getFilesDir(), "uploads");
        // Safety backups live beside uploads but in their own private tree, so the uploads restore
        // swap can never delete them; the revocation purge still erases them.
        this.safetyBackupStore = new SafetyBackupStore(
            new File(app.getFilesDir(), SafetyBackupStore.DIRECTORY)
        );
        this.noticeStore = new MemberRemovedNoticeStore(
            new File(securityDir, "member-removed-notice.json")
        );
        // Both roots come from the Context once; the bridge never receives a path.
        File databaseDirectory = new File(app.getFilesDir().getParentFile(), "databases");
        this.localDataPurge = new LocalDataPurge(databaseDirectory, app.getFilesDir());
    }

    public static SecurityRuntime install(Context context) {
        SecurityRuntime current = instance;
        if (current == null) {
            synchronized (SecurityRuntime.class) {
                current = instance;
                if (current == null) {
                    current = new SecurityRuntime(context);
                    instance = current;
                }
            }
        }
        return current;
    }

    /** Returns the runtime, installing it when the first caller only has a Context. */
    public static SecurityRuntime get(Context context) {
        return install(context);
    }

    public GateStore gateStore() {
        return gateStore;
    }

    public SecurityGateService gateService() {
        return gateService;
    }

    public MemberTokenStore tokenStore() {
        return tokenStore;
    }

    public UploadsGate uploadsGate(AppOrigin origin) {
        return new UploadsGate(gateStore, uploadsDirectory, origin);
    }

    public File uploadsDirectory() {
        return uploadsDirectory;
    }

    public SafetyBackupStore safetyBackupStore() {
        return safetyBackupStore;
    }

    public MemberRemovedNoticeStore noticeStore() {
        return noticeStore;
    }

    /** Called once per process before the first WebView is created. */
    public void preparePendingWipeProfile(Context context) {
        if (gateStore.get().lockedPendingWipe()) {
            pendingWipeProfilePurged = LocalDataPurge.purgeWebViewProfile(
                context.getFilesDir().getParentFile(), context.getCacheDir());
        }
    }

    public boolean pendingWipeProfilePurged() {
        return pendingWipeProfilePurged;
    }

    /**
     * Records that the running process cleared the live WebView's storage and cache itself.
     *
     * <p>This is what makes an online revocation self-healing: the gate may be released without a
     * process restart because the profile was scrubbed in place. The flag is process-scoped and is
     * dropped together with the pending wipe.</p>
     */
    public void markRuntimeWebViewCleared(boolean cleared) {
        runtimeWebViewCleared = cleared;
    }

    public boolean runtimeWebViewCleared() {
        return runtimeWebViewCleared;
    }

    void finishPendingWipe() {
        pendingWipeProfilePurged = false;
        runtimeWebViewCleared = false;
    }

    /** Fixed-root physical erasure service; no caller-supplied paths. */
    public LocalDataPurge localDataPurge() {
        return localDataPurge;
    }
}

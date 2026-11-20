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

    private SecurityRuntime(Context context) {
        Context app = context.getApplicationContext();
        File securityDir = new File(app.getNoBackupFilesDir(), "security");
        this.gateStore = new GateStore(new FileGatePersistence(new File(securityDir, "gate-state.txt")));
        this.tokenStore = new MemberTokenStore(new KeystoreMemberTokenStorage(securityDir));
        this.gateService = new SecurityGateService(gateStore, tokenStore);
        this.uploadsDirectory = new File(app.getFilesDir(), "uploads");
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
}

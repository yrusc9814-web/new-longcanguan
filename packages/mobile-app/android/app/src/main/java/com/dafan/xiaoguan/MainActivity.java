package com.dafan.xiaoguan;

import android.content.pm.ApplicationInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import androidx.annotation.Nullable;

import com.dafan.xiaoguan.security.AppSecurityPlugin;
import com.dafan.xiaoguan.security.SecurityRuntime;
import com.dafan.xiaoguan.uploads.AppOrigin;
import com.dafan.xiaoguan.uploads.UploadsResponse;
import com.dafan.xiaoguan.web.CustomBridgeWebViewClient;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.CapConfig;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;

import org.json.JSONException;
import org.json.JSONObject;

public class MainActivity extends BridgeActivity {

    private SecurityRuntime securityRuntime;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Must happen before BridgeActivity.onCreate() builds the Bridge, otherwise the JS side
        // would see an "AppSecurity not implemented" plugin.
        registerPlugin(AppSecurityPlugin.class);
        registerPlugin(UploadsFilesPlugin.class);
        super.onCreate(savedInstanceState);
    }

    /**
     * Capacitor creates the Bridge in {@code super.load()}. A swapped client must be in place before
     * the first {@code /uploads/*} sub-resource is requested; those are only discovered after the
     * renderer parses the newly loaded document, so installing right after Bridge creation is
     * sufficient and stays tied to Bridge timing rather than a later lifecycle callback.
     */
    @Override
    protected void load() {
        config = loadBridgeConfig();
        securityRuntime = SecurityRuntime.install(this);
        securityRuntime.gateStore().lock();
        super.load();
        installGatedWebViewClient();
    }

    @SuppressWarnings("deprecation")
    private CapConfig loadBridgeConfig() {
        JSONObject options;
        try (BufferedReader reader = new BufferedReader(
            new InputStreamReader(getAssets().open("capacitor.config.json"), StandardCharsets.UTF_8)
        )) {
            StringBuilder json = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) json.append(line);
            options = new JSONObject(json.toString());
        } catch (IOException | JSONException ex) {
            options = new JSONObject();
        }

        try {
            JSONObject android = options.optJSONObject("android");
            if (android == null) android = new JSONObject();
            // Capacitor's debug logging includes complete plugin arguments and responses.
            android.put("loggingBehavior", "none");
            if (!android.has("webContentsDebuggingEnabled")) {
                android.put("webContentsDebuggingEnabled", (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);
            }
            options.put("android", android);
            return new CapConfig(getAssets(), options);
        } catch (JSONException ex) {
            throw new IllegalStateException("Cannot configure the Capacitor bridge", ex);
        }
    }

    /**
     * Swaps in the uploads-gated client. Capacitor keeps ownership of every non-uploads request, so
     * the local asset server, HTTP proxy and saved routes keep working unchanged.
     */
    private void installGatedWebViewClient() {
        Bridge current = getBridge();
        if (current == null) return;

        AppOrigin origin = resolveAppOrigin(current);
        CustomBridgeWebViewClient client = new CustomBridgeWebViewClient(current, securityRuntime, origin, this::onDocumentReload);
        current.setWebViewClient(client);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            installServiceWorkerGate(current, client);
        }
    }

    /**
     * A fresh document has no verified PIN in memory, so the process-scoped unlock is dropped on
     * every page load. The durable wipe/PIN flags are untouched.
     */
    private void onDocumentReload() {
        if (securityRuntime != null) securityRuntime.gateStore().lock();
    }

    /**
     * Capacitor resolves service worker requests without going through the WebViewClient, which
     * would let a service worker bypass the uploads gate. Re-point that path at the same client.
     */
    private void installServiceWorkerGate(Bridge current, CustomBridgeWebViewClient client) {
        try {
            ServiceWorkerController controller = ServiceWorkerController.getInstance();
            controller.setServiceWorkerClient(
                new ServiceWorkerClient() {
                    @Override
                    public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                        UploadsResponse gated = client.interceptUploads(request);
                        if (gated != null) return client.toWebResourceResponse(gated);
                        return current.getLocalServer().shouldInterceptRequest(request);
                    }
                }
            );
        } catch (RuntimeException ex) {
            // Older or restricted WebView providers may not expose a service worker controller.
        }
    }

    @Nullable
    private static AppOrigin resolveAppOrigin(Bridge bridge) {
        String url = bridge.getServerUrl();
        if (url == null || url.trim().isEmpty()) url = bridge.getAppUrl();
        if (url != null && !url.trim().isEmpty()) {
            Uri uri = Uri.parse(url);
            String uriScheme = uri.getScheme();
            String uriHost = uri.getHost();
            if (uriScheme != null && uriHost != null) {
                return new AppOrigin(uriScheme, uriHost, uri.getPort());
            }
        }

        // Fall back to the Capacitor defaults (https://localhost) instead of dropping the gate.
        String scheme = bridge.getScheme();
        String host = bridge.getHost();
        if (scheme == null || host == null) return null;
        return new AppOrigin(scheme, host, -1);
    }
}

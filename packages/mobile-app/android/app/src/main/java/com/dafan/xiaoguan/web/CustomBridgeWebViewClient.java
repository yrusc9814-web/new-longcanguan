package com.dafan.xiaoguan.web;

import android.graphics.Bitmap;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import androidx.annotation.Nullable;

import com.dafan.xiaoguan.security.SecurityRuntime;
import com.dafan.xiaoguan.uploads.AppOrigin;
import com.dafan.xiaoguan.uploads.UploadsDecision;
import com.dafan.xiaoguan.uploads.UploadsGate;
import com.dafan.xiaoguan.uploads.UploadsResponder;
import com.dafan.xiaoguan.uploads.UploadsResponse;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Capacitor's WebView client plus a strict local gate for {@code /uploads/*}.
 *
 * <p>Everything that is not an app-origin uploads request is delegated to Capacitor unchanged, so
 * the local asset server, the Capacitor HTTP proxy and saved-route handling keep working. Uploads
 * responses are produced entirely from the local filesystem: no network call, no buffering, and a
 * missing file fails in one {@code stat} instead of waiting for the server.</p>
 */
public class CustomBridgeWebViewClient extends BridgeWebViewClient {

    /** Raised for a new top-level document; used to drop the process-scoped PIN unlock. */
    public interface DocumentLoadListener {
        void onDocumentLoad();
    }

    private final DocumentLoadListener documentLoadListener;
    private final UploadsGate uploadsGate;

    public CustomBridgeWebViewClient(Bridge bridge, SecurityRuntime runtime, AppOrigin appOrigin) {
        this(bridge, runtime, appOrigin, null);
    }

    public CustomBridgeWebViewClient(
        Bridge bridge,
        SecurityRuntime runtime,
        AppOrigin appOrigin,
        @Nullable DocumentLoadListener documentLoadListener
    ) {
        super(bridge);
        this.documentLoadListener = documentLoadListener;
        // Gate reads the shared GateStore, so it is cheap and always sees the latest state.
        this.uploadsGate = runtime.uploadsGate(appOrigin);
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        UploadsResponse response = interceptUploads(request);
        if (response != null) {
            return toWebResourceResponse(response);
        }
        return super.shouldInterceptRequest(view, request);
    }

    @Override
    public void onPageStarted(WebView view, String url, Bitmap favicon) {
        // A reload or navigation creates a new document; it must not inherit the previous unlock.
        if (documentLoadListener != null) documentLoadListener.onDocumentLoad();
        super.onPageStarted(view, url, favicon);
    }

    /**
     * @return a response for an app-origin uploads request, or {@code null} to let Capacitor handle it
     */
    @Nullable
    public UploadsResponse interceptUploads(@Nullable WebResourceRequest request) {
        if (request == null) return null;
        Uri uri = request.getUrl();
        if (uri == null) return null;

        int port = uri.getPort();
        String scheme = uri.getScheme();
        String host = uri.getHost();

        UploadsDecision decision = uploadsGate.decide(scheme, host, port, uri.getEncodedPath(), uri.getPath());
        if (!decision.isUploadsRequest()) {
            return null;
        }
        return UploadsResponder.respond(decision);
    }

    public WebResourceResponse toWebResourceResponse(UploadsResponse response) {
        Map<String, String> headers = new LinkedHashMap<>(response.headers());
        return new WebResourceResponse(
            response.mimeType(),
            response.encoding(),
            response.statusCode(),
            response.reasonPhrase(),
            headers,
            response.body()
        );
    }
}

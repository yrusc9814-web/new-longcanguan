package com.dafan.xiaoguan;

import android.util.Base64;

import com.dafan.xiaoguan.security.SecurityRuntime;
import com.dafan.xiaoguan.uploads.UploadsFileStore;
import com.dafan.xiaoguan.uploads.UploadsRestore;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;

import java.io.IOException;
import java.util.List;

/**
 * JS bridge for crash-safe uploads file IO.
 *
 * <p>Contract (see {@code src/native/upload-files.ts}):</p>
 * <ul>
 *     <li>{@code readFile({path})} -&gt; {@code {data: Uint8Array | null}} (base64 over the bridge)</li>
 *     <li>{@code writeFile({path, data})} - atomic temp+rename write</li>
 *     <li>{@code listFiles()} -&gt; {@code {paths: string[]}}</li>
 *     <li>{@code statFile({path})} -&gt; {@code {exists, size, sha256}}</li>
 *     <li>{@code deleteFiles({paths})} -&gt; {@code {deleted: string[]}}</li>
 * </ul>
 *
 * <p>The directory is exactly {@link SecurityRuntime#uploadsDirectory()} so writes land in the
 * same tree the WebView interceptor serves. Illegal paths fail closed without touching disk.</p>
 */
@CapacitorPlugin(name = "UploadsFiles")
public final class UploadsFilesPlugin extends Plugin {

    @Override
    public void load() {
        SecurityRuntime.install(getContext());
    }

    @PluginMethod
    public void readFile(PluginCall call) {
        String path = call.getString("path");
        try {
            byte[] data = store().read(path);
            JSObject result = new JSObject();
            if (data == null) {
                result.put("data", JSONObject_NULL());
            } else {
                result.put("data", Base64.encodeToString(data, Base64.NO_WRAP));
                result.put("encoding", "base64");
            }
            call.resolve(result);
        } catch (IOException ex) {
            call.reject("Unable to read the uploads file", "FILE_READ_FAILED");
        }
    }

    @PluginMethod
    public void writeFile(PluginCall call) {
        String path = call.getString("path");
        String base64 = call.getString("dataBase64");
        if (base64 == null) {
            Object raw = call.getData().opt("data");
            if (raw instanceof String) base64 = (String) raw;
        }
        if (path == null || base64 == null) {
            call.reject("path and data are required", "INVALID_INPUT");
            return;
        }
        byte[] data;
        try {
            data = Base64.decode(base64, Base64.NO_WRAP);
        } catch (IllegalArgumentException ex) {
            call.reject("data must be base64", "INVALID_INPUT");
            return;
        }
        try {
            UploadsFileStore fileStore = store();
            fileStore.write(path, data);
            // The gate can close between the check above and the rename; re-check and undo the
            // write so a wipe that ran in that window cannot leave a readable file behind.
            if (isWipePending()) {
                try {
                    fileStore.deleteAll(java.util.Collections.singletonList(path));
                } catch (IOException ignored) {
                    // The purge pass removes the whole tree anyway; report the closed gate.
                }
                call.reject("The device is pending wipe", "MEMBER_REVOKED");
                return;
            }
            call.resolve();
        } catch (IOException ex) {
            call.reject("Unable to write the uploads file", "FILE_WRITE_FAILED");
        }
    }

    @PluginMethod
    public void listFiles(PluginCall call) {
        try {
            List<String> paths = store().list();
            JSArray array = new JSArray();
            for (String path : paths) array.put(path);
            JSObject result = new JSObject();
            result.put("paths", array);
            call.resolve(result);
        } catch (IOException ex) {
            call.reject("Unable to list the uploads directory", "FILE_LIST_FAILED");
        }
    }

    @PluginMethod
    public void statFile(PluginCall call) {
        String path = call.getString("path");
        try {
            UploadsFileStore.Stat stat = store().stat(path);
            JSObject result = new JSObject();
            result.put("exists", stat.exists());
            result.put("size", stat.size());
            result.put("sha256", stat.sha256());
            call.resolve(result);
        } catch (IOException ex) {
            call.reject("Unable to stat the uploads file", "FILE_STAT_FAILED");
        }
    }

    @PluginMethod
    public void deleteFiles(PluginCall call) {
        JSONArray paths = call.getArray("paths");
        if (paths == null) {
            call.reject("paths array is required", "INVALID_INPUT");
            return;
        }
        try {
            java.util.ArrayList<String> relatives = new java.util.ArrayList<>();
            for (int i = 0; i < paths.length(); i++) {
                String value = paths.optString(i, "");
                if (!value.isEmpty()) relatives.add(value);
            }
            List<String> deleted = store().deleteAll(relatives);
            JSArray array = new JSArray();
            for (String path : deleted) array.put(path);
            JSObject result = new JSObject();
            result.put("deleted", array);
            call.resolve(result);
        } catch (IOException ex) {
            call.reject("Unable to delete uploads files", "FILE_DELETE_FAILED");
        }
    }

    @PluginMethod
    public void prepareRestore(PluginCall call) {
        restoreOperation(call, () -> restore().prepare());
    }

    @PluginMethod
    public void writeRestoreFile(PluginCall call) {
        restoreOperation(call, () -> restore().write(call.getString("path"),
            Base64.decode(call.getString("dataBase64", ""), Base64.NO_WRAP)));
    }

    @PluginMethod
    public void activateRestore(PluginCall call) {
        restoreOperation(call, () -> restore().activate(call.getInt("restoreId", 0)));
    }

    @PluginMethod
    public void recoverRestore(PluginCall call) {
        restoreOperation(call, () -> restore().recover(call.getInt("restoreId", 0)));
    }

    @FunctionalInterface
    private interface RestoreOperation {
        void run() throws IOException;
    }

    private void restoreOperation(PluginCall call, RestoreOperation operation) {
        if (SecurityRuntime.get(getContext()).gateStore().get().lockedPendingWipe()) {
            call.reject("The device is pending wipe", "MEMBER_REVOKED");
            return;
        }
        try {
            operation.run();
            call.resolve();
        } catch (IOException | IllegalArgumentException ex) {
            call.reject("Unable to replace the uploads directory", "FILE_RESTORE_FAILED");
        }
    }

    private UploadsRestore restore() {
        return new UploadsRestore(SecurityRuntime.get(getContext()).uploadsDirectory());
    }

    private UploadsFileStore store() throws IOException {
        SecurityRuntime runtime = SecurityRuntime.get(getContext());
        if (runtime.gateStore().get().lockedPendingWipe() || restore().isReplacing()) {
            throw new IOException("The uploads directory is unavailable");
        }
        return new UploadsFileStore(runtime.uploadsDirectory());
    }

    private boolean isWipePending() {
        return SecurityRuntime.get(getContext()).gateStore().get().lockedPendingWipe();
    }

    private static Object JSONObject_NULL() {
        return org.json.JSONObject.NULL;
    }
}

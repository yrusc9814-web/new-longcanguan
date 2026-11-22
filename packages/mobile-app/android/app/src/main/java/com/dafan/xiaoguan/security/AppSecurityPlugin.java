package com.dafan.xiaoguan.security;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

/**
 * JS bridge for the local security gate.
 *
 * <p>Contract (see {@code src/native/app-security.ts}):</p>
 * <ul>
 *     <li>{@code getGateState()} -&gt; {@code {lockedPendingWipe, pinRequired, pinUnlocked}}</li>
 *     <li>{@code setGateState({lockedPendingWipe?, pinRequired?, pinUnlocked?})} -&gt; same shape</li>
 *     <li>{@code setMemberToken({memberToken})}, {@code getMemberToken() -&gt; {memberToken}},
 *     {@code clearMemberToken()}</li>
 * </ul>
 *
 * <p>This class only adapts Capacitor calls; all logic and its invariants live in
 * {@link SecurityGateService}. No token value is ever placed in an error message or log.</p>
 */
@CapacitorPlugin(name = "AppSecurity")
public final class AppSecurityPlugin extends Plugin {

    @Override
    public void load() {
        SecurityRuntime.install(getContext());
    }

    @PluginMethod
    public void getGateState(PluginCall call) {
        call.resolve(toJs(service().getGateState()));
    }

    @PluginMethod
    public void setGateState(PluginCall call) {
        boolean valid =
            hasBooleanOrAbsent(call, "lockedPendingWipe") &&
            hasBooleanOrAbsent(call, "pinRequired") &&
            hasBooleanOrAbsent(call, "pinUnlocked");
        if (!valid) {
            call.reject("Gate state fields must be booleans", "INVALID_GATE_STATE");
            return;
        }

        Boolean lockedPendingWipe = call.getBoolean("lockedPendingWipe");
        Boolean pinRequired = call.getBoolean("pinRequired");
        Boolean pinUnlocked = call.getBoolean("pinUnlocked");
        Object expiry = call.getData().opt("pinExpiresAt");
        if (expiry != null && (!(expiry instanceof Number) || ((Number) expiry).longValue() < 0)) {
            call.reject("PIN expiry must be a timestamp", "INVALID_GATE_STATE");
            return;
        }
        Long pinExpiresAt = expiry == null ? null : ((Number) expiry).longValue();

        try {
            SecurityRuntime runtime = SecurityRuntime.get(getContext());
            if (Boolean.FALSE.equals(lockedPendingWipe) && runtime.gateStore().get().lockedPendingWipe()
                && !runtime.pendingWipeProfilePurged()) {
                call.reject("Restart required to clear the WebView profile", "WIPE_RESTART_REQUIRED");
                return;
            }
            GateState state = runtime.gateService().setGateState(lockedPendingWipe, pinRequired, pinUnlocked, pinExpiresAt);
            if (!state.lockedPendingWipe()) runtime.finishPendingWipe();
            call.resolve(toJs(state));
        } catch (SecurityPersistenceException ex) {
            call.reject("Unable to apply the local security gate", "GATE_UPDATE_FAILED");
        }
    }

    @PluginMethod
    public void getMemberToken(PluginCall call) {
        try {
            String token = service().getMemberToken();
            JSObject result = new JSObject();
            // JSONObject.NULL keeps the key present so the JS contract sees `null`, not `undefined`.
            result.put("memberToken", token == null ? JSONObject.NULL : token);
            call.resolve(result);
        } catch (SecurityPersistenceException ex) {
            call.reject("Unable to read the member token", "TOKEN_READ_FAILED");
        }
    }

    @PluginMethod
    public void setMemberToken(PluginCall call) {
        String token = call.getString("memberToken");
        try {
            service().setMemberToken(token);
            call.resolve();
        } catch (IllegalArgumentException ex) {
            call.reject("memberToken is required", "INVALID_TOKEN");
        } catch (SecurityPersistenceException ex) {
            call.reject("Unable to store the member token", "TOKEN_WRITE_FAILED");
        }
    }

    @PluginMethod
    public void clearMemberToken(PluginCall call) {
        try {
            service().clearMemberToken();
            call.resolve();
        } catch (SecurityPersistenceException ex) {
            call.reject("Unable to clear the member token", "TOKEN_CLEAR_FAILED");
        }
    }

    /**
     * Physically erases the local business data (SQLite files, {@code uploads/}, {@code uploads-restore/}).
     *
     * <p>Refuses to run unless {@code lockedPendingWipe} is already persisted: the durable gate must be
     * in place before any byte is deleted, so a failed wipe can never leave readable data behind an
     * open gate. No path parameter is accepted; {@link SecurityRuntime} supplies the fixed roots.</p>
     */
    @PluginMethod
    public void purgeLocalData(PluginCall call) {
        SecurityRuntime runtime = SecurityRuntime.get(getContext());
        if (!runtime.gateStore().get().lockedPendingWipe()) {
            call.reject("The device is not pending wipe", "NOT_LOCKED");
            return;
        }
        LocalDataPurge.PurgeReport report = runtime.localDataPurge().run();
        JSObject result = new JSObject();
        result.put("complete", report.complete());
        result.put("databaseRemoved", report.databaseRemoved());
        result.put("uploadsRemoved", report.uploadsRemoved());
        result.put("restoreRemoved", report.restoreRemoved());
        JSArray failed = new JSArray();
        for (String name : report.failed()) failed.put(name);
        result.put("failed", failed);
        call.resolve(result);
    }

    private SecurityGateService service() {
        return SecurityRuntime.get(getContext()).gateService();
    }

    /** A field must be absent, JSON null, or a real boolean; anything else is a contract violation. */
    private static boolean hasBooleanOrAbsent(PluginCall call, String name) {
        Object value = call.getData().opt(name);
        return value == null || value instanceof Boolean;
    }

    private static JSObject toJs(GateState state) {
        JSObject result = new JSObject();
        result.put("lockedPendingWipe", state.lockedPendingWipe());
        result.put("pinRequired", state.pinRequired());
        result.put("pinUnlocked", state.pinUnlocked());
        return result;
    }
}

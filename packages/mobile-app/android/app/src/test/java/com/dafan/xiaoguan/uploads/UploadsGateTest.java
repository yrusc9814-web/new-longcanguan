package com.dafan.xiaoguan.uploads;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.fail;

import com.dafan.xiaoguan.security.GateState;
import com.dafan.xiaoguan.security.GateStore;
import com.dafan.xiaoguan.security.SecurityPersistenceException;

import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;

public class UploadsGateTest {

    private static final AppOrigin APP = new AppOrigin("https", "localhost", -1);

    @Rule
    public TemporaryFolder folder = new TemporaryFolder();

    private File uploadsRoot;
    private GateStore gateStore;
    private UploadsGate gate;

    @Before
    public void setUp() throws IOException {
        uploadsRoot = folder.newFolder("uploads");
        gateStore = new GateStore(new MemoryPersistence());
        gate = new UploadsGate(gateStore, uploadsRoot, APP);
    }

    private void write(String relative, byte[] content) throws IOException {
        File file = new File(uploadsRoot, relative);
        File parent = file.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("mkdirs");
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(content);
        }
    }

    private void applyGate(Boolean wipe, Boolean pinRequired, Boolean unlocked) {
        try {
            gateStore.update(wipe, pinRequired, unlocked);
        } catch (SecurityPersistenceException ex) {
            throw new IllegalStateException(ex);
        }
    }

    private UploadsDecision decide(String encodedPath, String decodedPath) {
        return gate.decide("https", "localhost", -1, encodedPath, decodedPath);
    }

    private UploadsDecision decide(String path) {
        return decide(path, path);
    }

    // --- same origin -------------------------------------------------------

    @Test
    public void nonUploadsRequestIsDelegatedToCapacitor() {
        assertEquals(UploadsDecision.Kind.DELEGATE, decide("/index.html").kind());
        assertEquals(UploadsDecision.Kind.DELEGATE, decide("/api/v1/health").kind());
        assertEquals(UploadsDecision.Kind.DELEGATE, decide("/uploads", "/uploads").kind());
    }

    @Test
    public void foreignOriginNeverServesUploads() {
        UploadsDecision decision = gate.decide("https", "evil.example", -1, "/uploads/a.png", "/uploads/a.png");
        assertEquals(UploadsDecision.Kind.FORBIDDEN, decision.kind());
        assertEquals(403, decision.statusCode());
    }

    @Test
    public void schemeAndPortMustMatchTheAppOrigin() {
        AppOrigin withPort = new AppOrigin("https", "localhost", 8443);
        UploadsGate portGate = new UploadsGate(gateStore, uploadsRoot, withPort);

        assertEquals(UploadsDecision.Kind.FORBIDDEN, portGate.decide("http", "localhost", 8443, "/uploads/a.png", "/uploads/a.png").kind());
        assertEquals(
            UploadsDecision.Kind.FORBIDDEN,
            portGate.decide("https", "localhost", 9443, "/uploads/a.png", "/uploads/a.png").kind()
        );
        assertEquals(UploadsDecision.Kind.FORBIDDEN, portGate.decide("https", "localhost", -1, "/uploads/a.png", "/uploads/a.png").kind());
    }

    @Test
    public void missingOriginFailsClosed() {
        UploadsGate originless = new UploadsGate(gateStore, uploadsRoot, null);
        assertEquals(
            UploadsDecision.Kind.FORBIDDEN,
            originless.decide("https", "localhost", -1, "/uploads/a.png", "/uploads/a.png").kind()
        );
    }

    // --- traversal ---------------------------------------------------------

    @Test
    public void rejectsPlainTraversal() {
        assertRejected("/uploads/../secret.png");
        assertRejected("/uploads/a/../../secret.png");
        assertRejected("/uploads/..%2fsecret.png");
    }

    @Test
    public void rejectsEncodedTraversalAndSeparators() {
        assertRejected("/uploads/%2e%2e/secret.png");
        assertRejected("/uploads/%2E%2E%2Fsecret.png");
        assertRejected("/uploads/a%2f..%2fb.png");
        assertRejected("/uploads/a%5c..%5cb.png");
        assertRejected("/uploads/a%252e%252e%252fb.png");
        assertRejected("/uploads/%2e/a.png");
    }

    @Test
    public void rejectsBackslashesEmptySegmentsAndDoubleSlashes() {
        assertRejected("/uploads/..\\secret.png");
        assertRejected("/uploads\\a.png");
        assertRejected("/uploads//a.png");
        assertRejected("/uploads/a//b.png");
        assertRejected("/uploads/./a.png");
        assertRejected("/uploads/a/./b.png");
        assertRejected("/uploads/");
    }

    @Test
    public void rejectsDisallowedExtensionsAndHiddenNames() {
        assertRejected("/uploads/a.gif");
        assertRejected("/uploads/a.svg");
        assertRejected("/uploads/a.png.txt");
        assertRejected("/uploads/.png");
        assertRejected("/uploads/no-extension");
        assertRejected("/uploads/a.bmp");
        assertRejected("/uploads/%FF.png");
    }

    @Test
    public void encodedPathDisagreeingWithPlatformDecodeIsRejected() {
        // Same path text, but our single decode and the platform decode disagree: ambiguous Uri.
        UploadsDecision decision = decide("/uploads/abcd.png", "/uploads/abxd.png");
        assertEquals(UploadsDecision.Kind.FORBIDDEN, decision.kind());
    }

    @Test
    public void rejectedEncodedDotEscapeIsNotSilentlyDelegated() {
        assertRejected("/uploads/a%2Epng");
    }

    @Test
    public void encodedPlainFileNameStillResolves() {
        applyGate(null, true, true);
        UploadsDecision decision = decide("/uploads/meal_%32%30%32%36.webp", "/uploads/meal_2026.webp");

        assertEquals(UploadsDecision.Kind.NOT_FOUND, decision.kind());
    }

    // --- gate states -------------------------------------------------------

    @Test
    public void pendingWipeBeatsPinRequirement() {
        applyGate(true, true, true);

        UploadsDecision decision = decide("/uploads/a.png");

        assertEquals(UploadsDecision.Kind.FORBIDDEN, decision.kind());
        assertEquals(403, decision.statusCode());
    }

    @Test
    public void pinRequiredWithoutUnlockReturnsUnauthorized() {
        applyGate(null, true, false);

        UploadsDecision decision = decide("/uploads/a.png");

        assertEquals(UploadsDecision.Kind.UNAUTHORIZED, decision.kind());
        assertEquals(401, decision.statusCode());
    }

    @Test
    public void pinRequiredAfterProcessRestartIsLockedAgain() {
        applyGate(null, true, true);
        // A restarted process reloads the durable state, where unlocked is never persisted.
        GateStore restarted = new GateStore(new MemoryPersistence(false, true, true));
        UploadsGate restartedGate = new UploadsGate(restarted, uploadsRoot, APP);

        assertFalse(restarted.get().pinUnlocked());
        assertEquals(
            UploadsDecision.Kind.UNAUTHORIZED,
            restartedGate.decide("https", "localhost", -1, "/uploads/a.png", "/uploads/a.png").kind()
        );
    }

    @Test
    public void unlockedPinWithExistingFileReturnsStreamed200() throws Exception {
        byte[] content = new byte[] { 1, 2, 3, 4, 5 };
        write("dish.png", content);
        applyGate(null, true, true);

        UploadsDecision decision = decide("/uploads/dish.png");
        assertEquals(UploadsDecision.Kind.FILE, decision.kind());
        assertEquals(200, decision.statusCode());
        assertEquals("image/png", decision.mimeType());

        UploadsResponse response = UploadsResponder.respond(decision);
        assertEquals(200, response.statusCode());
        assertEquals("no-store", response.headers().get("Cache-Control"));
        assertArrayEquals(content, readAll(response.body()));
    }

    @Test
    public void missingFileIsAFastLocal404() {
        applyGate(null, true, true);

        UploadsDecision decision = decide("/uploads/missing.png");
        assertEquals(UploadsDecision.Kind.NOT_FOUND, decision.kind());

        UploadsResponse response = UploadsResponder.respond(decision);
        assertEquals(404, response.statusCode());
        assertEquals("no-store", response.headers().get("Cache-Control"));
        assertNotNull(response.body());
    }

    @Test
    public void nestedFilesKeepTheirMimeType() throws Exception {
        write("2026/10/cover.JPEG", new byte[] { 9 });
        applyGate(null, true, true);

        UploadsDecision decision = decide("/uploads/2026/10/cover.JPEG");

        assertEquals(UploadsDecision.Kind.FILE, decision.kind());
        assertEquals("image/jpeg", decision.mimeType());
    }

    @Test
    public void symlinkedFileEscapingRootIsNotFound() throws Exception {
        File outside = folder.newFile("outside.png");
        File link = new File(uploadsRoot, "link.png");
        try {
            java.nio.file.Files.createSymbolicLink(link.toPath(), outside.toPath());
        } catch (IOException | UnsupportedOperationException ex) {
            return; // Platform without symlink support: nothing to assert.
        }
        applyGate(null, true, true);

        assertEquals(UploadsDecision.Kind.NOT_FOUND, decide("/uploads/link.png").kind());
    }

    @Test
    public void errorBodiesCarryNoCredentials() {
        applyGate(true, true, false);

        UploadsResponse response = UploadsResponder.respond(decide("/uploads/a.png"));

        assertEquals(403, response.statusCode());
        String body = readUtf8(response.body()).toLowerCase();
        assertFalse(body.contains("token"));
        assertFalse(body.contains("member"));
    }

    @Test
    public void delegateDecisionIsNotAResponse() {
        try {
            UploadsResponder.respond(UploadsDecision.delegate());
            fail("delegate must not produce a response");
        } catch (IllegalArgumentException expected) {
            assertNotNull(expected.getMessage());
        }
    }

    private void assertRejected(String path) {
        UploadsDecision decision = decide(path, path);
        assertEquals("expected rejection for " + path, UploadsDecision.Kind.FORBIDDEN, decision.kind());
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[512];
        int read;
        while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
        return out.toByteArray();
    }

    private static String readUtf8(InputStream in) {
        try {
            return new String(readAll(in), java.nio.charset.StandardCharsets.UTF_8);
        } catch (IOException ex) {
            return "";
        }
    }

    private static final class MemoryPersistence implements GateStore.Persistence {
        private GateState state;

        MemoryPersistence() {
            this(null);
        }

        MemoryPersistence(boolean wipe, boolean pin, boolean unlocked) {
            this(new GateState(wipe, pin, unlocked));
        }

        MemoryPersistence(GateState state) {
            this.state = state;
        }

        @Override
        public GateState read() {
            return state;
        }

        @Override
        public void write(GateState state) {
            this.state = state;
        }
    }
}

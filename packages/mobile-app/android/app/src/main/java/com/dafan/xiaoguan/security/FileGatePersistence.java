package com.dafan.xiaoguan.security;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/**
 * Plain-text, versioned persistence for the durable part of the gate state.
 *
 * <p>The format is intentionally trivial ({@code v1|wipe|pin}) so it stays readable in pure-Java
 * unit tests without an Android JSON runtime. Unknown or corrupt content is treated as a read
 * failure, which makes {@link GateStore} fail closed. Writes go through {@link AtomicFiles}.</p>
 */
public final class FileGatePersistence implements GateStore.Persistence {

    private static final String HEADER = "v1";
    private static final int MAX_BYTES = 256;

    private final File file;

    public FileGatePersistence(File file) {
        this.file = file;
    }

    @Override
    public GateState read() throws Exception {
        if (!file.isFile()) return null;
        byte[] bytes = AtomicFiles.readAll(file);
        try {
            if (bytes.length == 0 || bytes.length > MAX_BYTES) {
                throw new IOException("Invalid gate state record size");
            }
            String text = new String(bytes, StandardCharsets.UTF_8).trim();
            String[] parts = text.split("\\|", -1);
            if (parts.length != 3 || !HEADER.equals(parts[0])) {
                throw new IOException("Unsupported gate state record");
            }
            boolean wipe = parseBit(parts[1]);
            boolean pin = parseBit(parts[2]);
            return new GateState(wipe, pin, false);
        } finally {
            Arrays.fill(bytes, (byte) 0);
        }
    }

    @Override
    public void write(GateState state) throws Exception {
        String text = HEADER + '|' + bit(state.lockedPendingWipe()) + '|' + bit(state.pinRequired());
        AtomicFiles.writeSync(file, text.getBytes(StandardCharsets.UTF_8));
    }

    private static boolean parseBit(String value) throws IOException {
        if ("1".equals(value)) return true;
        if ("0".equals(value)) return false;
        throw new IOException("Invalid gate state bit");
    }

    private static char bit(boolean value) {
        return value ? '1' : '0';
    }
}

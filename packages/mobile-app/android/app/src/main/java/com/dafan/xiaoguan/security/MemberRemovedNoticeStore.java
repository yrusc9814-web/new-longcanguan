package com.dafan.xiaoguan.security;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Durable, one-shot "you were removed from the household" notice.
 *
 * <p>Stored at {@code no_backup/security/member-removed-notice.json}, i.e. the same private,
 * non-backed-up area as the gate record. It must survive the WebView storage purge, so it can never
 * live in {@code localStorage} (which the wipe clears by design) nor in {@code FilesDir/uploads}
 * (which the purge deletes).</p>
 *
 * <p>The file is only ever written <em>after</em> the physical erase succeeded, and
 * {@link #consume()} deletes it on read so the UI shows the notice exactly once. Writes go through
 * {@link AtomicFiles}; unreadable or malformed content is reported as "no notice" rather than
 * failing the process.</p>
 */
public final class MemberRemovedNoticeStore {

    /** Keys accepted from the JS contract. Extra keys are ignored. */
    private static final String KEY_VERSION = "version";
    private static final String KEY_HOUSEHOLD = "householdId";
    private static final String KEY_MEMBER = "memberId";
    private static final String KEY_WIPED_AT = "wipedAt";

    private static final int FORMAT_VERSION = 1;

    private final File file;

    public MemberRemovedNoticeStore(File file) {
        this.file = file;
    }

    /** @return the stored notice, or {@code null} when there is none (or it is unusable) */
    public Map<String, Object> read() {
        if (!file.isFile()) return null;
        byte[] bytes;
        try {
            bytes = AtomicFiles.readAll(file);
        } catch (IOException ex) {
            return null;
        }
        return parse(new String(bytes, StandardCharsets.UTF_8));
    }

    /**
     * Reads and deletes the notice. A failed delete still returns the notice: showing it twice is
     * harmless, losing it is not.
     */
    public Map<String, Object> consume() {
        Map<String, Object> notice = read();
        if (notice == null) return null;
        if (file.exists() && !file.delete()) {
            // Best effort: the notice is still delivered to this caller.
        }
        return notice;
    }

    public void write(String householdId, String memberId, String wipedAt) throws IOException {
        String json = "{\"version\":" + FORMAT_VERSION
            + ",\"householdId\":" + quote(householdId)
            + ",\"memberId\":" + quote(memberId)
            + ",\"wipedAt\":" + quote(wipedAt)
            + "}";
        AtomicFiles.writeSync(file, json.getBytes(StandardCharsets.UTF_8));
    }

    static String quote(String value) {
        if (value == null) return "null";
        StringBuilder out = new StringBuilder(value.length() + 2);
        out.append('"');
        for (int i = 0; i < value.length(); i++) {
            char ch = value.charAt(i);
            switch (ch) {
                case '"':
                    out.append("\\\"");
                    break;
                case '\\':
                    out.append("\\\\");
                    break;
                case '\n':
                    out.append("\\n");
                    break;
                case '\r':
                    out.append("\\r");
                    break;
                case '\t':
                    out.append("\\t");
                    break;
                default:
                    if (ch < 0x20) out.append(String.format("\\u%04x", (int) ch));
                    else out.append(ch);
            }
        }
        return out.append('"').toString();
    }

    /**
     * Minimal flat-object parser: string, number and null values only, which is exactly what this
     * record contains. Everything else (arrays, nested objects, trailing garbage) is treated as
     * malformed so a corrupted file can never masquerade as a notice.
     */
    static Map<String, Object> parse(String text) {
        if (text == null) return null;
        String input = text.trim();
        if (input.length() < 2 || input.charAt(0) != '{' || input.charAt(input.length() - 1) != '}') {
            return null;
        }
        Map<String, Object> values = new LinkedHashMap<>();
        int index = 1;
        int end = input.length() - 1;

        while (index < end) {
            index = skipSpace(input, index, end);
            if (index >= end) break;
            if (input.charAt(index) != '"') return null;
            StringBuilder key = new StringBuilder();
            index = readString(input, index, end, key);
            if (index < 0) return null;
            index = skipSpace(input, index, end);
            if (index >= end || input.charAt(index) != ':') return null;
            index = skipSpace(input, index + 1, end);
            if (index >= end) return null;

            Object value;
            char ch = input.charAt(index);
            if (ch == '"') {
                StringBuilder text2 = new StringBuilder();
                index = readString(input, index, end, text2);
                if (index < 0) return null;
                value = text2.toString();
            } else if (input.startsWith("null", index)) {
                index += 4;
                value = null;
            } else if (ch == '-' || (ch >= '0' && ch <= '9')) {
                int start = index;
                while (index < end && "+-.eE0123456789".indexOf(input.charAt(index)) >= 0) index++;
                try {
                    value = Double.valueOf(input.substring(start, index));
                } catch (NumberFormatException ex) {
                    return null;
                }
            } else {
                return null;
            }

            values.put(key.toString(), value);
            index = skipSpace(input, index, end);
            if (index < end) {
                if (input.charAt(index) != ',') return null;
                index++;
            }
        }

        if (!values.containsKey(KEY_VERSION) || !values.containsKey(KEY_WIPED_AT)) return null;
        Object version = values.get(KEY_VERSION);
        if (!(version instanceof Double) || ((Double) version).intValue() != FORMAT_VERSION) return null;
        Object wipedAt = values.get(KEY_WIPED_AT);
        if (!(wipedAt instanceof String) || ((String) wipedAt).isEmpty()) return null;
        for (String key : new String[] {KEY_HOUSEHOLD, KEY_MEMBER}) {
            Object value = values.get(key);
            if (value != null && !(value instanceof String)) return null;
        }
        return values;
    }

    private static int skipSpace(String input, int index, int end) {
        while (index < end && Character.isWhitespace(input.charAt(index))) index++;
        return index;
    }

    /** Reads a quoted string starting at {@code index}; returns the index after the closing quote. */
    private static int readString(String input, int index, int end, StringBuilder out) {
        int cursor = index + 1;
        while (cursor < end) {
            char ch = input.charAt(cursor);
            if (ch == '"') return cursor + 1;
            if (ch == '\\') {
                if (cursor + 1 >= end) return -1;
                char escaped = input.charAt(cursor + 1);
                switch (escaped) {
                    case '"':
                    case '\\':
                    case '/':
                        out.append(escaped);
                        break;
                    case 'n':
                        out.append('\n');
                        break;
                    case 'r':
                        out.append('\r');
                        break;
                    case 't':
                        out.append('\t');
                        break;
                    case 'u':
                        if (cursor + 5 >= end) return -1;
                        try {
                            out.append((char) Integer.parseInt(input.substring(cursor + 2, cursor + 6), 16));
                        } catch (NumberFormatException ex) {
                            return -1;
                        }
                        cursor += 4;
                        break;
                    default:
                        return -1;
                }
                cursor += 2;
                continue;
            }
            out.append(ch);
            cursor++;
        }
        return -1;
    }
}

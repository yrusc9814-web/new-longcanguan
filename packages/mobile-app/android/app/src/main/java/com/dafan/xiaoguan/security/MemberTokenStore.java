package com.dafan.xiaoguan.security;

/**
 * Thread-safe, validation-first wrapper around {@link MemberTokenStorage}.
 *
 * <p>The token is only ever handled as a string in memory; nothing is logged. Invalid tokens are
 * rejected before touching storage so a failed call cannot half-write a record.</p>
 */
public final class MemberTokenStore {

    private static final int MAX_TOKEN_LENGTH = 4096;

    private final MemberTokenStorage storage;
    private final Object lock = new Object();

    public MemberTokenStore(MemberTokenStorage storage) {
        this.storage = storage;
    }

    public static void validate(String token) {
        if (token == null) throw new IllegalArgumentException("memberToken is required");
        if (token.trim().isEmpty()) throw new IllegalArgumentException("memberToken is required");
        if (token.length() > MAX_TOKEN_LENGTH) throw new IllegalArgumentException("memberToken is too long");
        for (int i = 0; i < token.length(); i++) {
            char ch = token.charAt(i);
            if (ch == '\r' || ch == '\n' || ch == 0) {
                throw new IllegalArgumentException("memberToken contains an invalid character");
            }
        }
    }

    /** @return the token, or {@code null} when none is stored. */
    public String read() throws SecurityPersistenceException {
        synchronized (lock) {
            try {
                String token = storage.read();
                if (token == null || token.isEmpty()) return null;
                return token;
            } catch (Exception ex) {
                throw new SecurityPersistenceException("Unable to read the member token", ex);
            }
        }
    }

    public void write(String token) throws SecurityPersistenceException {
        validate(token);
        synchronized (lock) {
            try {
                storage.write(token);
            } catch (Exception ex) {
                throw new SecurityPersistenceException("Unable to store the member token", ex);
            }
        }
    }

    public void clear() throws SecurityPersistenceException {
        synchronized (lock) {
            try {
                storage.clear();
                if (storage.exists()) {
                    throw new SecurityPersistenceException("Member token still exists after clearing");
                }
            } catch (SecurityPersistenceException ex) {
                throw ex;
            } catch (Exception ex) {
                throw new SecurityPersistenceException("Unable to clear the member token", ex);
            }
        }
    }
}

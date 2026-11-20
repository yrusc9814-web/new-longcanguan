package com.dafan.xiaoguan.security;

/** Thrown when the security state could not be persisted; callers must not report success. */
public final class SecurityPersistenceException extends Exception {

    public SecurityPersistenceException(String message, Throwable cause) {
        super(message, cause);
    }

    public SecurityPersistenceException(String message) {
        super(message);
    }
}

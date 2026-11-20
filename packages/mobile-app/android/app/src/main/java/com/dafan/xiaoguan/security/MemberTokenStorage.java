package com.dafan.xiaoguan.security;

/** Durable member-token storage. Implementations must erase the record, not just overwrite it. */
public interface MemberTokenStorage {
    /** Returns the stored token, or {@code null} when none is stored. */
    String read() throws Exception;

    void write(String token) throws Exception;

    void clear() throws Exception;

    /** True when a record exists on disk (used to detect wipe failures). */
    boolean exists();
}

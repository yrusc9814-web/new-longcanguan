package com.dafan.xiaoguan.security;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Before;
import org.junit.Test;

import java.security.GeneralSecurityException;

import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;

public class TokenEnvelopeTest {

    private SecretKey key;
    private final TokenEnvelope envelope = new TokenEnvelope();

    @Before
    public void setUp() throws Exception {
        KeyGenerator generator = KeyGenerator.getInstance("AES");
        generator.init(256);
        key = generator.generateKey();
    }

    @Test
    public void roundTripsPlaintext() throws Exception {
        byte[] plaintext = "member-token-value".getBytes(java.nio.charset.StandardCharsets.UTF_8);

        byte[] blob = envelope.seal(key, plaintext);
        byte[] opened = envelope.open(key, blob);

        assertArrayEquals(plaintext, opened);
    }

    @Test
    public void usesAFreshIvPerEncryption() throws Exception {
        byte[] plaintext = "same".getBytes(java.nio.charset.StandardCharsets.UTF_8);

        byte[] first = envelope.seal(key, plaintext);
        byte[] second = envelope.seal(key, plaintext);

        assertFalse(java.util.Arrays.equals(first, second));
    }

    @Test
    public void ciphertextDoesNotContainPlaintext() throws Exception {
        byte[] plaintext = "super-secret-member-token".getBytes(java.nio.charset.StandardCharsets.UTF_8);

        byte[] blob = envelope.seal(key, plaintext);

        String raw = new String(blob, java.nio.charset.StandardCharsets.ISO_8859_1);
        assertFalse(raw.contains("super-secret-member-token"));
    }

    @Test
    public void rejectsTamperedCiphertext() throws Exception {
        byte[] blob = envelope.seal(key, "value".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        blob[blob.length - 1] ^= 0x01;

        try {
            envelope.open(key, blob);
            fail("tampered blob must not decrypt");
        } catch (GeneralSecurityException expected) {
            assertNotNull(expected);
        }
    }

    @Test
    public void rejectsForeignBlobFormat() {
        try {
            envelope.open(key, "plain".getBytes(java.nio.charset.StandardCharsets.UTF_8));
            fail("non-envelope input must be rejected");
        } catch (GeneralSecurityException expected) {
            assertEquals(true, expected.getMessage() != null);
        }
    }

    @Test
    public void rejectsEmptyPlaintext() {
        try {
            envelope.seal(key, new byte[0]);
            fail("empty token must not be sealed");
        } catch (GeneralSecurityException expected) {
            assertNotNull(expected);
        }
    }

    @Test
    public void rejectsOversizedPlaintext() {
        try {
            envelope.seal(key, new byte[16 * 1024]);
            fail("oversized token must not be sealed");
        } catch (GeneralSecurityException expected) {
            assertNotNull(expected);
        }
    }

    @Test
    public void cannotOpenWithAnotherKey() throws Exception {
        KeyGenerator generator = KeyGenerator.getInstance("AES");
        generator.init(256);
        SecretKey otherKey = generator.generateKey();
        byte[] blob = envelope.seal(key, "value".getBytes(java.nio.charset.StandardCharsets.UTF_8));

        try {
            assertNull(envelope.open(otherKey, blob));
            fail("foreign key must not decrypt");
        } catch (GeneralSecurityException expected) {
            assertNotNull(expected);
        }
    }
}

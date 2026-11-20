package com.dafan.xiaoguan.security;

import java.nio.ByteBuffer;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * AES-GCM envelope used for the member token.
 *
 * <p>Format: {@code 'D' 'F' 'T' 1 | IV | ciphertext+tag}. The IV length is read from a one-byte
 * prefix so the format works both with the Android Keystore (which requires a caller-supplied IV to
 * be omitted and generates its own) and with plain JVM AES keys in unit tests. The version byte
 * allows a format change without silently misinterpreting old blobs.</p>
 *
 * <p>Sealing never passes an IV when the key rejects caller nonces: Android Keystore AES-GCM keys
 * are generated with {@code setRandomizedEncryptionRequired(true)}, which makes a caller IV a hard
 * error ({@code CALLER_NONCE_PROHIBITED}).</p>
 */
public final class TokenEnvelope {

    private static final byte[] MAGIC = { 'D', 'F', 'T', 1 };
    private static final int TAG_BITS = 128;
    private static final int MAX_PLAINTEXT_BYTES = 8 * 1024;

    public byte[] seal(SecretKey key, byte[] plaintext) throws GeneralSecurityException {
        if (plaintext == null || plaintext.length == 0 || plaintext.length > MAX_PLAINTEXT_BYTES) {
            throw new GeneralSecurityException("Invalid token payload");
        }

        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key);
        byte[] iv = cipher.getIV();
        if (iv == null || iv.length == 0 || iv.length > 255) {
            throw new GeneralSecurityException("Cipher did not supply a usable IV");
        }
        byte[] ciphertext = cipher.doFinal(plaintext);

        ByteBuffer buffer = ByteBuffer.allocate(MAGIC.length + 1 + iv.length + ciphertext.length);
        buffer.put(MAGIC);
        buffer.put((byte) iv.length);
        buffer.put(iv);
        buffer.put(ciphertext);
        return buffer.array();
    }

    public byte[] open(SecretKey key, byte[] blob) throws GeneralSecurityException {
        if (blob == null || blob.length <= MAGIC.length + 1 + TAG_BITS / 8) {
            throw new GeneralSecurityException("Token blob is malformed");
        }
        for (int i = 0; i < MAGIC.length; i++) {
            if (blob[i] != MAGIC[i]) throw new GeneralSecurityException("Unsupported token blob version");
        }

        int ivLength = blob[MAGIC.length] & 0xFF;
        int ciphertextStart = MAGIC.length + 1 + ivLength;
        if (ivLength == 0 || ciphertextStart + TAG_BITS / 8 >= blob.length) {
            throw new GeneralSecurityException("Token blob is malformed");
        }

        byte[] iv = Arrays.copyOfRange(blob, MAGIC.length + 1, ciphertextStart);
        byte[] ciphertext = Arrays.copyOfRange(blob, ciphertextStart, blob.length);

        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, iv));
        byte[] plaintext = cipher.doFinal(ciphertext);
        if (plaintext.length == 0 || plaintext.length > MAX_PLAINTEXT_BYTES) {
            throw new GeneralSecurityException("Invalid token payload");
        }
        return plaintext;
    }
}

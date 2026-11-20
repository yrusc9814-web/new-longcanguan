package com.dafan.xiaoguan.security;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.util.Arrays;

import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;

/**
 * Keystore-backed AES-GCM storage for the member token.
 *
 * <p>The ciphertext lives in app-private storage. The AES-256 key is generated in the Android
 * Keystore and is neither exportable nor backed up. {@link #clear()} overwrites the record with
 * random bytes, deletes it and removes the Keystore entry, so the wiped token cannot be decrypted
 * by a later install of the same package.</p>
 *
 * <p>No token value is logged. Plaintext buffers are zeroed after use.</p>
 */
public final class KeystoreMemberTokenStorage implements MemberTokenStorage {

    static final String KEYSTORE_PROVIDER = "AndroidKeyStore";
    static final String KEY_ALIAS = "dafan.member-token.v1";
    static final String FILE_NAME = "member-token.bin";

    private final File directory;
    private final TokenEnvelope envelope = new TokenEnvelope();
    private final SecureRandom random = new SecureRandom();

    public KeystoreMemberTokenStorage(File directory) {
        this.directory = directory;
    }

    public static KeystoreMemberTokenStorage forApp(Context context) {
        return new KeystoreMemberTokenStorage(new File(context.getNoBackupFilesDir(), "security"));
    }

    @Override
    public String read() throws Exception {
        File file = tokenFile();
        if (!file.isFile()) return null;

        byte[] blob = AtomicFiles.readAll(file);
        try {
            byte[] plaintext = envelope.open(getOrCreateKey(), blob);
            try {
                return new String(plaintext, StandardCharsets.UTF_8);
            } finally {
                Arrays.fill(plaintext, (byte) 0);
            }
        } catch (Exception ex) {
            // An unreadable blob is unusable; erase it instead of retrying forever.
            try {
                clear();
            } catch (Exception ignored) {
                // The record is already unusable; a failed cleanup must not mask the read failure.
            }
            return null;
        } finally {
            Arrays.fill(blob, (byte) 0);
        }
    }

    @Override
    public void write(String token) throws Exception {
        File file = tokenFile();
        File parent = file.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            throw new IOException("Unable to create the security directory");
        }

        byte[] plaintext = token.getBytes(StandardCharsets.UTF_8);
        byte[] blob;
        try {
            blob = envelope.seal(getOrCreateKey(), plaintext);
        } finally {
            Arrays.fill(plaintext, (byte) 0);
        }
        try {
            AtomicFiles.writeSync(file, blob);
        } finally {
            Arrays.fill(blob, (byte) 0);
        }
    }

    @Override
    public void clear() throws Exception {
        File file = tokenFile();
        Exception failure = null;

        if (file.exists()) {
            try {
                long length = Math.max(64L, Math.min(file.length(), 8192L));
                byte[] noise = new byte[(int) length];
                random.nextBytes(noise);
                AtomicFiles.writeSync(file, noise);
            } catch (Exception ex) {
                failure = ex;
            }
        }
        if (file.exists() && !file.delete()) {
            failure = new IllegalStateException("Unable to delete the member token record");
        }
        try {
            KeyStore keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER);
            keyStore.load(null);
            if (keyStore.containsAlias(KEY_ALIAS)) keyStore.deleteEntry(KEY_ALIAS);
        } catch (Exception ex) {
            if (failure == null) failure = ex;
        }
        if (failure != null) throw failure;
    }

    @Override
    public boolean exists() {
        if (tokenFile().exists()) return true;
        try {
            KeyStore keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER);
            keyStore.load(null);
            return keyStore.containsAlias(KEY_ALIAS);
        } catch (Exception ex) {
            return false;
        }
    }

    private File tokenFile() {
        return new File(directory, FILE_NAME);
    }

    private SecretKey getOrCreateKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER);
        keyStore.load(null);
        if (keyStore.containsAlias(KEY_ALIAS)) {
            return (SecretKey) keyStore.getKey(KEY_ALIAS, null);
        }

        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE_PROVIDER);
        generator.init(
            new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build()
        );
        return generator.generateKey();
    }
}

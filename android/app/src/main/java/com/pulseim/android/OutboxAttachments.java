package com.pulseim.android;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.security.GeneralSecurityException;
import java.util.UUID;
import java.util.Set;
import javax.crypto.AEADBadTagException;
import javax.crypto.Cipher;

/** Immutable encrypted attachments. The caller receives plaintext only after GCM authentication. */
final class OutboxAttachments {
    private static final long MAX_BYTES = 100L * 1024 * 1024;
    private static final int IV_BYTES = 12, TAG_BYTES = 16;

    /** Only the durable ciphertext is missing or invalid. Scratch/key-provider errors are retryable. */
    static final class Unreadable extends IllegalStateException {
        Unreadable(Throwable cause) { super("本地待发附件已丢失或损坏", cause); }
    }
    interface Ciphers {
        Cipher encrypt(String attachmentId) throws GeneralSecurityException;
        Cipher decrypt(String attachmentId, byte[] iv) throws GeneralSecurityException;
    }
    static final class DecryptedFile implements AutoCloseable {
        final File file;
        DecryptedFile(File file) { this.file = file; }
        @Override public void close() { file.delete(); }
    }
    private final File directory, temporary;
    private final Ciphers ciphers;
    OutboxAttachments(File directory, File temporary, Ciphers ciphers) {
        this.directory = directory; this.temporary = temporary; this.ciphers = ciphers;
        if (!ensureDirectory(directory)) throw new IllegalStateException("无法创建待发附件目录");
    }
    String save(File source) {
        String id = UUID.randomUUID().toString(); File part = new File(directory, id + ".part"), target = file(id);
        try {
            if (!source.isFile() || source.length() <= 0 || source.length() > MAX_BYTES) throw new IOException("附件为空或超过100MB");
            Cipher cipher = ciphers.encrypt(id); byte[] iv = cipher.getIV(); if (iv.length != IV_BYTES) throw new IOException("Invalid IV");
            try (FileInputStream input = new FileInputStream(source); FileOutputStream output = new FileOutputStream(part)) {
                output.write(iv); transform(input, output, cipher, MAX_BYTES); output.getFD().sync();
            }
            if (!part.renameTo(target)) throw new IOException("Attachment commit failed");
            return id;
        } catch (IOException | GeneralSecurityException error) { part.delete(); target.delete(); throw new IllegalStateException("无法保存待发附件，请保留原文件后重试", error); }
    }
    DecryptedFile open(String id, String extension) {
        File plain = null;
        try {
            if (!extension.matches("[A-Za-z0-9]{1,8}")) extension = "tmp";
            try (FileInputStream input = openEncrypted(file(id))) {
                long size = input.getChannel().size();
                if (size <= IV_BYTES + TAG_BYTES || size > MAX_BYTES + IV_BYTES + TAG_BYTES) {
                    throw new Unreadable(new IOException("Invalid encrypted attachment length"));
                }
                byte[] iv = new byte[IV_BYTES]; int offset = 0, read;
                while (offset < iv.length && (read = input.read(iv, offset, iv.length - offset)) > 0) offset += read;
                if (offset != iv.length) throw new Unreadable(new IOException("Incomplete attachment header"));
                if (!ensureDirectory(temporary)) throw new IOException("Unable to create outbox scratch directory");
                plain = File.createTempFile("outbox-", "." + extension, temporary);
                try (FileOutputStream output = new FileOutputStream(plain)) {
                    transform(input, output, ciphers.decrypt(id, iv), MAX_BYTES + TAG_BYTES);
                    output.getFD().sync();
                }
            }
            return new DecryptedFile(plain);
        } catch (AEADBadTagException error) {
            if (plain != null) plain.delete();
            throw new Unreadable(error);
        } catch (IOException | GeneralSecurityException | RuntimeException error) {
            if (plain != null) plain.delete();
            if (error instanceof Unreadable) throw (Unreadable) error;
            throw new IllegalStateException("暂时无法读取待发附件，请检查存储空间后重试", error);
        }
    }
    private static FileInputStream openEncrypted(File source) throws IOException {
        try { return new FileInputStream(source); }
        catch (FileNotFoundException error) {
            if (Files.notExists(source.toPath())) throw new Unreadable(error);
            throw error;
        }
    }
    private static boolean ensureDirectory(File dir) {
        return dir.isDirectory() || dir.mkdirs() || dir.isDirectory();
    }
    void delete(String id) { file(id).delete(); }
    void retain(Set<String> ids) {
        File[] files = directory.listFiles(); if (files == null) return;
        for (File file : files) {
            String name = file.getName();
            if (name.matches("[a-f0-9-]{36}\\.(bin|part)") && !ids.contains(name.substring(0, 36))) file.delete();
        }
    }
    private File file(String id) {
        if (!validIdentity(id)) throw new IllegalArgumentException("Invalid attachment identity");
        return new File(directory, id + ".bin");
    }
    static boolean validIdentity(String id) {
        return id.matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}");
    }
    private static void transform(FileInputStream input, FileOutputStream output, Cipher cipher, long limit) throws IOException, GeneralSecurityException {
        byte[] buffer = new byte[64 * 1024]; int count; long total = 0;
        while ((count = input.read(buffer)) != -1) { total += count; if (total > limit) throw new IOException("附件超过100MB"); byte[] bytes = cipher.update(buffer, 0, count); if (bytes != null) output.write(bytes); }
        byte[] tail = cipher.doFinal(); if (tail != null) output.write(tail);
    }
}

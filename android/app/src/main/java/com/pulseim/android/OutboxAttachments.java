package com.pulseim.android;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.security.GeneralSecurityException;
import java.util.UUID;
import java.util.Set;
import javax.crypto.Cipher;

/** Immutable encrypted attachments. The caller receives plaintext only after GCM authentication. */
final class OutboxAttachments {
    private static final long MAX_BYTES = 100L * 1024 * 1024;
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
        if ((!directory.isDirectory() && !directory.mkdirs()) || (!temporary.isDirectory() && !temporary.mkdirs())) throw new IllegalStateException("无法创建待发附件目录");
        // These private files are only scratch copies. A killed process must not leave plaintext indefinitely.
        File[] opened = temporary.listFiles(); if (opened != null) for (File file : opened) if (file.isFile() && file.getName().startsWith("outbox-")) file.delete();
    }
    String save(File source) {
        String id = UUID.randomUUID().toString(); File part = new File(directory, id + ".part"), target = file(id);
        try {
            if (!source.isFile() || source.length() <= 0 || source.length() > MAX_BYTES) throw new IOException("附件为空或超过100MB");
            Cipher cipher = ciphers.encrypt(id); byte[] iv = cipher.getIV(); if (iv.length != 12) throw new IOException("Invalid IV");
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
            plain = File.createTempFile("outbox-", "." + extension, temporary);
            try (FileInputStream input = new FileInputStream(file(id)); FileOutputStream output = new FileOutputStream(plain)) {
                byte[] iv = new byte[12]; int offset = 0, read;
                while (offset < iv.length && (read = input.read(iv, offset, iv.length - offset)) > 0) offset += read;
                if (offset != iv.length) throw new IOException("Incomplete attachment");
                transform(input, output, ciphers.decrypt(id, iv), MAX_BYTES + 16); output.getFD().sync();
            }
            return new DecryptedFile(plain);
        } catch (IOException | GeneralSecurityException error) { if (plain != null) plain.delete(); throw new IllegalStateException("无法读取待发附件，请保留本地数据后重试", error); }
    }
    boolean exists(String id) { return file(id).isFile(); }
    void delete(String id) { file(id).delete(); }
    void retain(Set<String> ids) {
        File[] files = directory.listFiles(); if (files == null) return;
        for (File file : files) {
            String name = file.getName();
            if (name.matches("[a-f0-9-]{36}\\.(bin|part)") && !ids.contains(name.substring(0, 36))) file.delete();
        }
    }
    private File file(String id) {
        if (!id.matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")) throw new IllegalArgumentException("Invalid attachment identity");
        return new File(directory, id + ".bin");
    }
    private static void transform(FileInputStream input, FileOutputStream output, Cipher cipher, long limit) throws IOException, GeneralSecurityException {
        byte[] buffer = new byte[64 * 1024]; int count; long total = 0;
        while ((count = input.read(buffer)) != -1) { total += count; if (total > limit) throw new IOException("附件超过100MB"); byte[] bytes = cipher.update(buffer, 0, count); if (bytes != null) output.write(bytes); }
        byte[] tail = cipher.doFinal(); if (tail != null) output.write(tail);
    }
}

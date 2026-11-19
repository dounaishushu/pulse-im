package com.pulseim.android;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.util.Arrays;
import java.util.Comparator;
import java.util.stream.Stream;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/** Standalone JVM checks for encrypted pending attachments; run with run-outbox.ps1. */
public final class OutboxAttachmentsChecks {
    private static Path suite;
    private static int passed, failed;
    private interface Check { void run() throws Exception; }
    private static void require(boolean value, String message) { if (!value) throw new AssertionError(message); }
    private static void check(String name, Check action) {
        try { action.run(); passed++; System.out.println("PASS " + name); }
        catch (Exception | AssertionError error) { failed++; System.out.println("FAIL " + name); error.printStackTrace(System.out); }
    }
    private static void removeTree(Path path) throws IOException {
        require(path.toAbsolutePath().normalize().startsWith(suite), "cleanup escaped test directory");
        if (!Files.exists(path)) return;
        try (Stream<Path> files = Files.walk(path)) {
            for (Path file : files.sorted(Comparator.reverseOrder()).toList()) Files.delete(file);
        }
    }
    private static final class Fixture {
        final Path root = Files.createTempDirectory(suite, "case-");
        final Path cache = root.resolve("cache"), temporary = cache.resolve("outbox-open/account");
        final Path encrypted = root.resolve("no-backup/attachments"), source = root.resolve("voice.m4a");
        final byte[] content = new byte[160_037];
        final OutboxAttachments attachments;
        Fixture() throws Exception {
            for (int i = 0; i < content.length; i++) content[i] = (byte) (i * 31 + i / 7);
            Files.write(source, content);
            attachments = store((byte) 7);
        }
        OutboxAttachments store(byte seed) {
            byte[] bytes = new byte[32]; Arrays.fill(bytes, seed);
            SecretKeySpec key = new SecretKeySpec(bytes, "AES");
            return new OutboxAttachments(encrypted.toFile(), temporary.toFile(), new OutboxAttachments.Ciphers() {
                public Cipher encrypt(String id) throws GeneralSecurityException {
                    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key);
                    cipher.updateAAD(id.getBytes(StandardCharsets.UTF_8)); return cipher;
                }
                public Cipher decrypt(String id, byte[] iv) throws GeneralSecurityException {
                    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
                    cipher.updateAAD(id.getBytes(StandardCharsets.UTF_8)); return cipher;
                }
            });
        }
        String save() { return attachments.save(source.toFile()); }
        void verify(String id) throws Exception {
            File plain;
            try (OutboxAttachments.DecryptedFile opened = attachments.open(id, "m4a")) {
                plain = opened.file;
                require(plain.getName().endsWith(".m4a"), "voice extension changed");
                require(Arrays.equals(content, Files.readAllBytes(plain.toPath())), "attachment bytes changed");
            }
            require(!plain.exists(), "plaintext scratch file leaked after close");
            require(attachments.exists(id), "reading removed encrypted original");
        }
        void expectReadFailure(OutboxAttachments store, String id) {
            try (OutboxAttachments.DecryptedFile ignored = store.open(id, "m4a")) { throw new AssertionError("unreadable attachment was accepted"); }
            catch (IllegalStateException expected) { require(expected.getCause() != null, "read failure lost cause"); }
        }
        boolean scratchEmpty() throws Exception {
            try (Stream<Path> files = Files.list(temporary)) { return files.findAny().isEmpty(); }
        }
    }
    private static final class Storage implements OutboxPersistence {
        byte[] snapshot;
        public byte[] read() { return snapshot == null ? null : snapshot.clone(); }
        public void write(byte[] bytes) { snapshot = bytes.clone(); }
    }
    private static DurableMediaOutbox queue(Fixture f) { return new DurableMediaOutbox(new Storage(), f.attachments, "fixture-token", 1, "https://example.test/api/v2"); }
    private static void verifyVoice(Fixture f, DurableMediaOutbox queue, DurableMediaOutbox.Entry entry) throws Exception {
        try (OutboxAttachments.DecryptedFile opened = queue.openFile(entry)) {
            require(Arrays.equals(f.content, Files.readAllBytes(opened.file.toPath())), "queued voice bytes changed");
        }
    }
    public static void main(String[] args) throws Exception {
        suite = Files.createTempDirectory("pulse-outbox-checks-").toAbsolutePath().normalize();
        try {
            check("roundtrip preserves encrypted source and removes plaintext", () -> {
                Fixture f = new Fixture(); String id = f.save(); f.verify(id);
                require(!Arrays.equals(f.content, Files.readAllBytes(f.encrypted.resolve(id + ".bin"))), "plaintext stored as durable attachment");
            });
            check("recreates missing scratch directory without restarting outbox", () -> {
                Fixture f = new Fixture(); String id = f.save(); removeTree(f.temporary); f.verify(id);
            });
            check("recovers repeated removal of entire cache tree", () -> {
                Fixture f = new Fixture(); String id = f.save(); Files.delete(f.source);
                for (int i = 0; i < 3; i++) { removeTree(f.cache); f.verify(id); }
            });
            check("opening an attachment preserves other active scratch files", () -> {
                Fixture f = new Fixture(); String id = f.save();
                try (OutboxAttachments.DecryptedFile first = f.attachments.open(id, "m4a")) {
                    f.verify(id); require(first.file.isFile(), "second open deleted first upload scratch file");
                }
            });
            check("blocked scratch path preserves voice and recovers after retry", () -> {
                Fixture f = new Fixture(); String id = f.save(); removeTree(f.temporary);
                byte[] blocker = new byte[] { 6, 5, 4 }; Files.write(f.temporary, blocker);
                f.expectReadFailure(f.attachments, id);
                require(f.attachments.exists(id) && Arrays.equals(blocker, Files.readAllBytes(f.temporary)), "failure damaged existing files");
                Files.delete(f.temporary); f.verify(id);
            });
            check("missing encrypted attachment fails without leaking plaintext", () -> {
                Fixture f = new Fixture(); String id = f.save(); f.attachments.delete(id); f.expectReadFailure(f.attachments, id);
                require(f.scratchEmpty(), "failed open left plaintext");
            });
            check("GCM authentication failure retains encrypted data without plaintext", () -> {
                Fixture f = new Fixture(); String id = f.save(); Path path = f.encrypted.resolve(id + ".bin");
                byte[] bytes = Files.readAllBytes(path); bytes[bytes.length - 1] ^= 1; Files.write(path, bytes);
                f.expectReadFailure(f.attachments, id);
                require(f.scratchEmpty() && Arrays.equals(bytes, Files.readAllBytes(path)), "authentication failure changed durable data");
            });
            check("incorrect key cannot expose pending attachment", () -> {
                Fixture f = new Fixture(); String id = f.save(); f.expectReadFailure(f.store((byte) 8), id);
                require(f.scratchEmpty(), "wrong key leaked plaintext"); f.verify(id);
            });
            check("voice retry recovers queue head without losing or reordering later voices", () -> {
                Fixture f = new Fixture(); DurableMediaOutbox queue = queue(f);
                for (int i = 0; i < 3; i++) queue.enqueue("voice-" + i, 1, "voice", "audio/mp4", "语音.m4a", f.source.toFile(), 0, 8000);
                Files.delete(f.source); removeTree(f.temporary); Files.write(f.temporary, new byte[] { 1 });
                DurableMediaOutbox.Entry head = queue.claim(1); require(head.requestId.equals("voice-0"), "wrong queue head");
                f.expectReadFailure(f.attachments, head.attachmentId); queue.fail(head, "injected unavailable cache");
                require(queue.claim(1) == null && queue.pending(1).size() == 3, "failed head lost queue order");
                Files.delete(f.temporary); require(queue.retry(head), "voice cannot retry");
                for (int i = 0; i < 3; i++) {
                    removeTree(f.cache); DurableMediaOutbox.Entry next = queue.claim(1);
                    require(next != null && next.requestId.equals("voice-" + i), "retry changed voice order"); verifyVoice(f, queue, next);
                    require(queue.uploaded(next, "{}") && queue.committing(next), "voice did not advance");
                    require(queue.acknowledge(next.requestId, 1) == next, "voice acknowledgement lost");
                }
                require(queue.pending(1).isEmpty(), "queue did not drain");
            });
            check("pending image preview also survives cache removal", () -> {
                Fixture f = new Fixture(); DurableMediaOutbox queue = queue(f);
                DurableMediaOutbox.Entry entry = queue.enqueue("image-preview", 1, "image", "image/jpeg", "photo.jpg", f.source.toFile(), 0, 0);
                removeTree(f.cache);
                try (OutboxAttachments.DecryptedFile opened = queue.openPreview(entry)) {
                    require(Arrays.equals(f.content, Files.readAllBytes(opened.file.toPath())), "preview bytes changed");
                }
                require(entry.phase == DurableMediaOutbox.Phase.QUEUED && queue.pending(1).size() == 1, "preview mutated queue");
            });
        } finally { removeTree(suite); }
        System.out.println("RESULT passed=" + passed + " failed=" + failed);
        if (failed != 0) throw new AssertionError("attachment checks failed");
    }
}

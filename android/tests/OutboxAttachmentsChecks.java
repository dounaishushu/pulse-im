package com.pulseim.android;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
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
            require(Files.isRegularFile(encrypted.resolve(id + ".bin")), "reading removed encrypted original");
        }
        void expectReadFailure(OutboxAttachments store, String id, boolean unreadable) {
            try (OutboxAttachments.DecryptedFile ignored = store.open(id, "m4a")) { throw new AssertionError("unreadable attachment was accepted"); }
            catch (IllegalStateException expected) {
                require(expected.getCause() != null, "read failure lost cause");
                require((expected instanceof OutboxAttachments.Unreadable) == unreadable, "read failure was misclassified");
            }
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
    private static final String ENDPOINT = "https://example.test/api/v2";
    private static DurableMediaOutbox queue(Fixture f) { return queue(f, new Storage()); }
    private static DurableMediaOutbox queue(Fixture f, Storage storage) {
        return new DurableMediaOutbox(storage, f.attachments, "fixture-token", 1, ENDPOINT);
    }
    private static void seedLegacyVoice(DataOutputStream out, String id, String attachment, String phase, String error, String upload, long size) throws IOException {
        out.writeUTF(id);
        out.writeUTF(ENDPOINT);
        out.writeInt(1);
        out.writeInt(1);
        out.writeUTF("voice");
        out.writeUTF("audio/mp4");
        OutboxCodec.writeString(out, "语音.m4a");
        out.writeUTF(attachment);
        out.writeLong(size);
        out.writeInt(0);
        out.writeLong(8000);
        out.writeUTF(phase);
        OutboxCodec.writeString(out, error);
        OutboxCodec.writeString(out, upload);
        out.writeBoolean(false);
    }
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
                    f.verify(id);
                    f.store((byte) 7);
                    require(first.file.isFile(), "rebinding deleted a scratch file still in use");
                }
            });
            check("blocked scratch path preserves voice and recovers after retry", () -> {
                Fixture f = new Fixture(); String id = f.save(); removeTree(f.temporary); Files.createDirectories(f.temporary.getParent());
                byte[] blocker = new byte[] { 6, 5, 4 }; Files.write(f.temporary, blocker);
                f.expectReadFailure(f.attachments, id, false);
                require(Files.isRegularFile(f.encrypted.resolve(id + ".bin")) && Arrays.equals(blocker, Files.readAllBytes(f.temporary)), "failure damaged existing files");
                Files.delete(f.temporary); f.verify(id);
            });
            check("missing encrypted attachment fails without leaking plaintext", () -> {
                Fixture f = new Fixture(); String id = f.save(); f.attachments.delete(id); f.expectReadFailure(f.attachments, id, true);
                Files.createDirectories(f.temporary);
                require(f.scratchEmpty(), "failed open left plaintext");
            });
            check("GCM authentication failure retains encrypted data without plaintext", () -> {
                Fixture f = new Fixture(); String id = f.save(); Path path = f.encrypted.resolve(id + ".bin");
                byte[] bytes = Files.readAllBytes(path); bytes[bytes.length - 1] ^= 1; Files.write(path, bytes);
                f.expectReadFailure(f.attachments, id, true);
                require(f.scratchEmpty() && Arrays.equals(bytes, Files.readAllBytes(path)), "authentication failure changed durable data");
            });
            check("incorrect key cannot expose pending attachment", () -> {
                Fixture f = new Fixture(); String id = f.save(); f.expectReadFailure(f.store((byte) 8), id, true);
                require(f.scratchEmpty(), "wrong key leaked plaintext"); f.verify(id);
            });
            check("voice retry recovers queue head without losing or reordering later voices", () -> {
                Fixture f = new Fixture(); DurableMediaOutbox queue = queue(f);
                for (int i = 0; i < 3; i++) queue.enqueue("voice-" + i, 1, "voice", "audio/mp4", "语音.m4a", f.source.toFile(), 0, 8000);
                Files.delete(f.source); removeTree(f.temporary); Files.createDirectories(f.temporary.getParent()); Files.write(f.temporary, new byte[] { 1 });
                DurableMediaOutbox.Entry head = queue.claim(1); require(head.requestId.equals("voice-0"), "wrong queue head");
                f.expectReadFailure(f.attachments, head.attachmentId, false); queue.fail(head, "injected unavailable cache");
                require(queue.pending(1).size() == 3, "failed head lost pending voices");
                Files.delete(f.temporary);
                for (int i = 1; i < 3; i++) {
                    removeTree(f.cache); DurableMediaOutbox.Entry next = queue.claim(1);
                    require(next != null && next.requestId.equals("voice-" + i), "retry changed voice order"); verifyVoice(f, queue, next);
                    require(queue.uploaded(next, "{}") && queue.committing(next), "voice did not advance");
                    require(queue.acknowledge(next.requestId, 1) == next, "voice acknowledgement lost");
                }
                require(head.phase == DurableMediaOutbox.Phase.FAILED && head.error.equals("injected unavailable cache"), "later voices changed failure state");
                require(queue.retry(head) && queue.claim(1) == head, "voice cannot retry"); verifyVoice(f, queue, head);
                require(queue.uploaded(head, "{}") && queue.committing(head) && queue.acknowledge(head.requestId, 1) == head, "retried voice did not finish");
                require(queue.pending(1).isEmpty(), "queue did not drain");
            });
            check("lost voice remains visible across restart without blocking later voices", () -> {
                Fixture f = new Fixture(); Storage storage = new Storage(); DurableMediaOutbox queue = queue(f, storage);
                for (int i = 0; i < 4; i++) queue.enqueue("voice-" + i, 1, "voice", "audio/mp4", "语音.m4a", f.source.toFile(), 0, 8000);
                DurableMediaOutbox.Entry lost = queue.claim(1);
                Files.delete(f.encrypted.resolve(lost.attachmentId + ".bin"));
                try (OutboxAttachments.DecryptedFile ignored = queue.openFile(lost)) { throw new AssertionError("missing attachment opened"); }
                catch (OutboxAttachments.Unreadable error) {
                    require(!queue.markUnreadable(lost, lost.attempt - 1), "stale attempt changed queue state");
                    require(queue.markUnreadable(lost, lost.attempt), "missing voice did not settle");
                    require(!queue.defer(lost, "late lifecycle callback", lost.attempt, 0), "late lifecycle callback requeued missing voice");
                }
                queue.detach(); queue = queue(f, storage); lost = queue.pending(1).get(0);
                require(lost.phase == DurableMediaOutbox.Phase.UNREADABLE && !queue.retry(lost), "lost voice became retryable or disappeared");
                for (int i = 1; i < 4; i++) {
                    DurableMediaOutbox.Entry next = queue.claim(1);
                    require(next != null && next.requestId.equals("voice-" + i), "lost voice blocked or reordered the remaining lane");
                    verifyVoice(f, queue, next);
                    require(queue.uploaded(next, "{}") && queue.committing(next), "voice did not reach commit");
                    require(queue.acknowledge(next.requestId, 1) == next, "voice acknowledgement lost");
                }
                require(queue.pending(1).size() == 1 && queue.discard(lost), "could not dismiss only the lost voice");
            });
            check("legacy local read failure is retried without replaying a possibly committed message", () -> {
                Fixture f = new Fixture(); Storage storage = new Storage();
                String readFailure = "无法读取待发附件，请保留本地数据后重试";
                ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                try (DataOutputStream out = new DataOutputStream(bytes)) {
                    out.writeInt(2); out.writeInt(3);
                    seedLegacyVoice(out, "legacy-scratch", f.save(), "FAILED", readFailure, "", f.content.length);
                    seedLegacyVoice(out, "legacy-uploaded", f.save(), "FAILED", readFailure, "{\"url\":\"server-media\"}", f.content.length);
                    seedLegacyVoice(out, "legacy-tail", f.save(), "QUEUED", "", "", f.content.length);
                }
                Files.delete(f.source); removeTree(f.cache); storage.write(bytes.toByteArray());
                DurableMediaOutbox queue = queue(f, storage);
                DurableMediaOutbox.Entry recovered = queue.claim(1);
                require(recovered != null && recovered.requestId.equals("legacy-scratch"), "installed v2 queue remained stuck at a local read failure");
                verifyVoice(f, queue, recovered); queue.acknowledge(recovered.requestId, 1);
                DurableMediaOutbox.Entry uploaded = queue.pending(1).get(0);
                DurableMediaOutbox.Entry tail = queue.claim(1);
                require(uploaded.phase == DurableMediaOutbox.Phase.FAILED && tail != null && tail.requestId.equals("legacy-tail"), "upgrade replayed a possibly committed message");
                queue.acknowledge(tail.requestId, 1);
                require(queue.retry(uploaded) && queue.claim(1) == uploaded && uploaded.uploadJson.contains("server-media"), "manual retry lost existing upload");
                require(!queue.markUnreadable(uploaded, uploaded.attempt), "remote upload was downgraded to a local read failure");
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

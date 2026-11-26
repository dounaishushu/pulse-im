package com.pulseim.android;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import java.io.*;
import java.nio.file.Files;
import java.util.*;
import java.util.function.Supplier;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import static org.junit.Assert.*;

public class OutboxRowPersistenceTest {
    private static final String BASE = "https://example.test/api/v2";
    @Rule public TemporaryFolder files = new TemporaryFolder();
    private static final class Rows implements OutboxRowPersistence {
        final int version;
        LinkedHashMap<String, OutboxRecord> rows = new LinkedHashMap<>();
        OutboxRecord.Snapshot legacy, lastRead;
        boolean roomOnly, fail;
        int upserts, deletes, snapshots, commits;
        Rows(int version) { this.version = version; }
        public byte[] read() { lastRead = roomOnly ? OutboxRecord.combine(new ArrayList<>(rows.values()), version) : legacy; return lastRead == null ? null : lastRead.data(); }
        public byte[] readRetryState() { return lastRead == null ? null : lastRead.retry(); }
        public void write(byte[] data) { throw new AssertionError("Delta dispatch required"); }
        public void writeRows(List<OutboxRecord> changed, List<String> removed, boolean replaceAll, Supplier<OutboxRecord.Snapshot> full) {
            if (fail) throw new IllegalStateException("disk full");
            LinkedHashMap<String, OutboxRecord> next = replaceAll ? new LinkedHashMap<>() : new LinkedHashMap<>(rows);
            changed.forEach(row -> next.put(row.requestId, row)); removed.forEach(next::remove);
            if (!roomOnly) {
                OutboxRecord.Snapshot snapshot = full.get();
                assertTrue(OutboxRecord.same(snapshot, OutboxRecord.combine(new ArrayList<>(next.values()), version)));
                legacy = snapshot; snapshots++;
            }
            rows = next; upserts += changed.size(); deletes += removed.size(); commits++;
        }
    }
    private TextSendQueue text(Rows disk, String token) {
        TextSendQueue queue = new TextSendQueue(); queue.bindStorage(disk, token, 1, BASE); return queue;
    }
    private TextSendQueue.Entry add(TextSendQueue q, int cid) { return q.enqueue("token", 1, BASE, cid, "same text", 0); }
    @Test public void fiftyTextActionsOnlyRewriteChangedRows() {
        Rows disk = new Rows(1); TextSendQueue q = text(disk, "token");
        for (int i = 1; i <= 50; i++) add(q, i);
        disk.roomOnly = true; int before = disk.upserts, snapshots = disk.snapshots;
        TextSendQueue.Entry entry = q.claim("token", 1, BASE, 1, 0, 1000).get(0);
        assertEquals(1, disk.upserts - before);
        q.defer(entry, "network", entry.attempt, 2000, 1000); assertEquals(2, disk.upserts - before);
        assertEquals(snapshots, disk.snapshots); assertEquals(50, disk.rows.size());
    }
    @Test public void textClaimsAcrossConversationsCommitOnlyTwoChangedActions() {
        Rows disk = new Rows(1); TextSendQueue q = text(disk, "token"); add(q, 1); add(q, 1); add(q, 2);
        int rows = disk.upserts, commits = disk.commits;
        assertEquals(2, q.claim("token", 1, BASE, 2, 0, 1000).size());
        assertEquals(2, disk.upserts - rows); assertEquals(commits + 1, disk.commits);
    }
    @Test public void acknowledgeAndDiscardDeleteWithoutRewritingOtherActions() {
        Rows disk = new Rows(1); TextSendQueue q = text(disk, "token"); TextSendQueue.Entry a = add(q, 1), b = add(q, 2);
        q.claim("token", 1, BASE, 2); q.fail(b, "400", b.attempt); int rows = disk.upserts;
        assertSame(a, q.acknowledge(a.requestId, "token", 1, BASE, 1)); assertTrue(q.discard(b, "token", 1, BASE));
        assertEquals(rows, disk.upserts); assertEquals(2, disk.deletes); assertTrue(disk.rows.isEmpty());
    }
    @Test public void textRowRecoveryPreservesRequestsMentionsAndMonotonicAttempt() {
        Rows disk = new Rows(1); TextSendQueue q = text(disk, "token");
        TextSendQueue.Entry a = q.enqueue("token", 1, BASE, 1, "@friend payload", 9, new int[]{2});
        q.claim("token", 1, BASE); q.defer(a, "network", a.attempt, 3000, 1000); disk.roomOnly = true;
        TextSendQueue restored = text(disk, "refreshed-token"); TextSendQueue.Entry b = restored.pending("refreshed-token", 1, BASE, 1).get(0);
        assertEquals(a.requestId, b.requestId); assertArrayEquals(new int[]{2}, b.mentionUserIds()); assertEquals(9, b.replyToId);
        assertEquals(1, b.attempt); assertEquals(4000, b.retryAtMs); assertEquals("@friend payload", b.text);
        assertTrue(restored.claim("refreshed-token", 1, BASE, 1, 0, 3999).isEmpty());
        assertEquals(2, restored.claim("refreshed-token", 1, BASE, 1, 0, 4000).get(0).attempt);
    }
    @Test public void failedAtomicRowWriteDoesNotPublishEnqueueClaimOrAck() {
        Rows disk = new Rows(1); TextSendQueue q = text(disk, "token"); TextSendQueue.Entry a = add(q, 1);
        disk.fail = true; assertThrows(IllegalStateException.class, () -> add(q, 2));
        assertTrue(q.pending("token", 1, BASE, 2).isEmpty());
        assertThrows(IllegalStateException.class, () -> q.claim("token", 1, BASE));
        assertEquals(0, a.attempt); assertEquals(TextSendQueue.Phase.QUEUED, a.phase);
        assertThrows(IllegalStateException.class, () -> q.acknowledge(a.requestId, "token", 1, BASE, 1));
        assertSame(a, q.pending("token", 1, BASE, 1).get(0)); assertEquals(1, disk.rows.size());
    }
    @Test public void failedTextStateIsFlushedWithNextActionInBothReadModes() {
        for (boolean roomOnly : new boolean[]{false, true}) {
            Rows disk = new Rows(1); TextSendQueue q = text(disk, "token"); TextSendQueue.Entry a = add(q, 1);
            disk.roomOnly = roomOnly; q.claim("token", 1, BASE);
            disk.fail = true; assertTrue(q.fail(a, "HTTP 400", a.attempt));
            disk.fail = false; int before = disk.upserts; TextSendQueue.Entry b = add(q, 2);
            assertEquals(2, disk.upserts - before);
            before = disk.upserts; add(q, 3); assertEquals(1, disk.upserts - before);
            disk.roomOnly = true; TextSendQueue recovered = text(disk, "token");
            TextSendQueue.Entry saved = recovered.pending("token", 1, BASE, 1).get(0);
            assertEquals(TextSendQueue.Phase.FAILED, saved.phase); assertEquals(a.error, saved.error);
            assertEquals(a.attempt, saved.attempt); assertEquals(b.requestId, recovered.pending("token", 1, BASE, 2).get(0).requestId);
        }
    }
    @Test public void deferredTextAndRejectedRetryKeepAllUncommittedFields() {
        Rows disk = new Rows(1); TextSendQueue q = text(disk, "token"); TextSendQueue.Entry a = add(q, 1);
        q.claim("token", 1, BASE); disk.fail = true;
        assertThrows(IllegalStateException.class, () -> q.defer(a, "network", a.attempt, 5000, 1000));
        disk.fail = false; add(q, 2); disk.roomOnly = true;
        TextSendQueue restored = text(disk, "token"); TextSendQueue.Entry saved = restored.pending("token", 1, BASE, 1).get(0);
        assertEquals(6000, saved.retryAtMs); assertEquals(1, saved.attempt);
        restored.claim("token", 1, BASE, 1, 0, 6000); restored.fail(saved, "HTTP 403");
        disk.fail = true; assertThrows(IllegalStateException.class, () -> restored.retry(saved, "token", 1, BASE));
        assertEquals(6000, saved.retryAtMs); assertEquals(TextSendQueue.Phase.FAILED, saved.phase);
        disk.fail = false; add(restored, 3);
    }
    @Test public void removingDirtyTextDoesNotResurrectItOrARejectedEnqueue() {
        Rows disk = new Rows(1); TextSendQueue q = text(disk, "token"); TextSendQueue.Entry a = add(q, 1);
        q.claim("token", 1, BASE); disk.fail = true; q.fail(a, "HTTP 400");
        assertThrows(IllegalStateException.class, () -> add(q, 2));
        assertThrows(IllegalStateException.class, () -> q.discard(a, "token", 1, BASE));
        disk.fail = false; assertTrue(q.discard(a, "token", 1, BASE)); add(q, 3);
        assertEquals(1, disk.rows.size()); assertFalse(disk.rows.containsKey(a.requestId));
    }
    @Test public void rowRecoveryStillRejectsWrongAccountAndNeverPersistsToken() {
        Rows disk = new Rows(1); TextSendQueue q = text(disk, "secret-token");
        q.enqueue("secret-token", 1, BASE, 1, "payload", 0); disk.roomOnly = true;
        byte[] data = disk.read(); assertFalse(new String(data, java.nio.charset.StandardCharsets.UTF_8).contains("secret-token"));
        TextSendQueue other = new TextSendQueue();
        assertThrows(IllegalStateException.class, () -> other.bindStorage(disk, "token", 2, BASE));
        assertEquals(1, disk.rows.size());
    }
    private OutboxAttachments attachments;
    private DurableMediaOutbox media(Rows disk) throws Exception {
        if (attachments == null) attachments = new OutboxAttachments(files.newFolder(), files.newFolder(), new OutboxAttachments.Ciphers() {
            private Cipher cipher(int mode, byte[] iv) throws java.security.GeneralSecurityException {
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); SecretKeySpec key = new SecretKeySpec(new byte[16], "AES");
                if (iv == null) cipher.init(mode, key); else cipher.init(mode, key, new GCMParameterSpec(128, iv)); return cipher;
            }
            public Cipher encrypt(String id) throws java.security.GeneralSecurityException { return cipher(Cipher.ENCRYPT_MODE, null); }
            public Cipher decrypt(String id, byte[] iv) throws java.security.GeneralSecurityException { return cipher(Cipher.DECRYPT_MODE, iv); }
        });
        return new DurableMediaOutbox(disk, attachments, "token", 1, BASE);
    }
    private DurableMediaOutbox.Entry add(DurableMediaOutbox q, String id, int cid) throws Exception {
        File source = files.newFile(); Files.write(source.toPath(), new byte[]{1, 2, 3});
        return q.enqueue(id, cid, "image", "image/png", "photo.png", source, 8, 0, true);
    }
    @Test public void fiftyMediaActionsOnlyRewriteCurrentUploadCommitAndRetry() throws Exception {
        Rows disk = new Rows(3); DurableMediaOutbox q = media(disk); for (int i = 1; i <= 50; i++) add(q, "media-" + i, i);
        disk.roomOnly = true; int before = disk.upserts, snapshots = disk.snapshots;
        DurableMediaOutbox.Entry entry = q.claim(1, 1000); q.uploaded(entry, "{\"url\":\"fixture\"}", entry.attempt);
        q.committing(entry, entry.attempt); q.defer(entry, "network", entry.attempt, 2000, 1000);
        assertEquals(4, disk.upserts - before); assertEquals(snapshots, disk.snapshots); assertEquals(50, disk.rows.size());
    }
    @Test public void mediaRowRecoveryKeepsUploadAndEncryptedAttachment() throws Exception {
        Rows disk = new Rows(3); DurableMediaOutbox q = media(disk); DurableMediaOutbox.Entry a = add(q, "a", 1); add(q, "b", 2);
        q.claim(1, 1000); q.uploaded(a, "{\"url\":\"fixture\"}", a.attempt); q.committing(a, a.attempt); disk.roomOnly = true;
        DurableMediaOutbox recovered = media(disk); DurableMediaOutbox.Entry b = recovered.pending(1).get(0);
        assertEquals(a.requestId, b.requestId); assertEquals(1, b.attempt); assertEquals(a.uploadJson, b.uploadJson); assertTrue(b.original);
        assertEquals(8, b.replyToId); assertEquals(DurableMediaOutbox.Phase.QUEUED, b.phase);
        recovered.claim(1, 1000); try (OutboxAttachments.DecryptedFile file = recovered.openFile(b)) { assertArrayEquals(new byte[]{1,2,3}, Files.readAllBytes(file.file.toPath())); }
        int before = disk.upserts; recovered.acknowledge("a", 1); assertEquals(before, disk.upserts); assertEquals(1, disk.deletes);
        assertEquals(1, recovered.pending(2).size());
    }
    @Test public void failedMediaEnqueueDoesNotLeaveAnActionOrDeleteAnotherAttachment() throws Exception {
        Rows disk = new Rows(3); DurableMediaOutbox q = media(disk); DurableMediaOutbox.Entry a = add(q, "a", 1);
        disk.fail = true; assertThrows(IllegalStateException.class, () -> add(q, "b", 2));
        assertEquals(1, q.pending(0).size()); disk.fail = false; q.claim(1, 1000);
        try (OutboxAttachments.DecryptedFile file = q.openFile(a)) { assertEquals(3, file.file.length()); }
    }
    @Test public void failedMediaStateIsFlushedWithNextActionInBothReadModes() throws Exception {
        for (boolean roomOnly : new boolean[]{false, true}) {
            Rows disk = new Rows(3); DurableMediaOutbox q = media(disk); DurableMediaOutbox.Entry a = add(q, "a", 1);
            disk.roomOnly = roomOnly; q.claim(1, 1000); disk.fail = true; q.fail(a, "HTTP 400", a.attempt);
            disk.fail = false; int before = disk.upserts; add(q, "b", 2); assertEquals(2, disk.upserts - before);
            before = disk.upserts; add(q, "c", 3); assertEquals(1, disk.upserts - before);
            disk.roomOnly = true; DurableMediaOutbox restored = media(disk); DurableMediaOutbox.Entry saved = restored.pending(1).get(0);
            assertEquals(DurableMediaOutbox.Phase.FAILED, saved.phase); assertEquals(a.error, saved.error); assertEquals(1, saved.attempt);
        }
    }
    @Test public void unreadableMediaRemainsPausedAfterAnotherActionAndRoomRestart() throws Exception {
        Rows disk = new Rows(3); DurableMediaOutbox q = media(disk); DurableMediaOutbox.Entry a = add(q, "a", 1);
        q.claim(1, 1000); disk.fail = true; assertTrue(q.markUnreadable(a, a.attempt));
        disk.fail = false; add(q, "b", 2); disk.roomOnly = true;
        DurableMediaOutbox restored = media(disk);
        assertEquals(DurableMediaOutbox.Phase.UNREADABLE, restored.pending(1).get(0).phase);
        assertNull(restored.claim(1, 1000));
    }
    @Test public void deletingDirtyMediaFlushesOnlySurvivors() throws Exception {
        Rows disk = new Rows(3); DurableMediaOutbox q = media(disk); DurableMediaOutbox.Entry a = add(q, "a", 1);
        q.claim(1, 1000); disk.fail = true; q.fail(a, "HTTP 400", a.attempt);
        assertThrows(IllegalStateException.class, () -> add(q, "rejected", 2));
        disk.fail = false; assertTrue(q.discard(a)); add(q, "survivor", 3);
        assertEquals(Set.of("survivor"), disk.rows.keySet());
    }
    @Test public void failedMediaPauseFromUploadOrCommitIsClaimableOnlyAfterDurableRecovery() throws Exception {
        for (boolean committing : new boolean[]{false, true}) {
            Rows disk = new Rows(3); DurableMediaOutbox q = media(disk); DurableMediaOutbox.Entry a = add(q, "a", 1); add(q, "b", 1);
            q.claim(1, 1000);
            if (committing) { q.uploaded(a, "uploaded", a.attempt); q.committing(a, a.attempt); }
            disk.fail = true;
            assertThrows(IllegalStateException.class, () -> q.defer(a, "offline", a.attempt, 2000, 1000));
            assertEquals(DurableMediaOutbox.Phase.QUEUED, a.phase); assertEquals(3000, q.nextRetryAt(1, 1000));
            assertNull(q.claim(1, 2999)); assertThrows(IllegalStateException.class, () -> q.claim(1, 3000));
            assertEquals(1, a.attempt); assertEquals(DurableMediaOutbox.Phase.QUEUED, a.phase);
            disk.fail = false; disk.roomOnly = true;
            assertSame(a, q.claim(1, 3000)); assertEquals(2, a.attempt);
            assertEquals(committing ? "uploaded" : "", a.uploadJson);
            q.acknowledge("a", 1); assertEquals("b", q.claim(1, 3000).requestId);
        }
    }
    @Test public void rowCodecRejectsDuplicateMixedVersionAndWrongRetryIdentity() throws Exception {
        Rows a = new Rows(1); TextSendQueue q = text(a, "token"); TextSendQueue.Entry entry = add(q, 1); OutboxRecord row = a.rows.get(entry.requestId);
        assertThrows(IllegalStateException.class, () -> OutboxRecord.combine(List.of(row, row), 1));
        assertThrows(IllegalStateException.class, () -> OutboxRecord.combine(List.of(row), 3));
        assertThrows(IllegalArgumentException.class, () -> new OutboxRecord("wrong", row.snapshot.data(), row.snapshot.retry()));
        byte[] bad = row.snapshot.retry(); bad[3] = 2;
        assertThrows(IllegalArgumentException.class, () -> new OutboxRecord(entry.requestId, row.snapshot.data(), bad));
    }
    @Test public void rowCodecSnapshotsAreDefensiveAndSupportEmptyQueues() {
        Rows disk = new Rows(1); TextSendQueue q = text(disk, "token"); TextSendQueue.Entry entry = add(q, 1);
        OutboxRecord row = disk.rows.get(entry.requestId); byte[] saved = row.snapshot.data(); byte[] copy = row.snapshot.data(); copy[0]++;
        assertArrayEquals(saved, row.snapshot.data());
        OutboxRecord.Snapshot empty = OutboxRecord.combine(List.of(), 1); assertEquals(8, empty.data().length); assertEquals(8, empty.retry().length);
    }
}

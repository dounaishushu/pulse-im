package com.pulseim.android;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import java.io.*;
import java.nio.file.Files;
import java.util.*;
import javax.crypto.Cipher;
import javax.crypto.spec.*;
import static org.junit.Assert.*;

public class OutboxRetryStateTest {
    @Rule public TemporaryFolder files = new TemporaryFolder();
    private static final String BASE = "https://example.test/api/v2";
    private static final class Storage implements OutboxPersistence {
        byte[] data, retry; int writes;
        public byte[] read() { return data; }
        public byte[] readRetryState() { return retry; }
        public void write(byte[] bytes) { data = bytes.clone(); retry = null; writes++; }
        public void write(byte[] bytes, byte[] retryState) { data = bytes.clone(); retry = retryState.clone(); writes++; }
    }
    private TextSendQueue text(Storage s, String token) { TextSendQueue q = new TextSendQueue(); q.bindStorage(s, token, 1, BASE); return q; }
    @Test public void textRestartRetainsDeadlineAttemptAndAccountIsolation() throws Exception {
        Storage s = new Storage(); TextSendQueue q = text(s, "token");
        TextSendQueue.Entry a = q.enqueue("token", 1, BASE, 1, "a", 0); q.claim("token", 1, BASE);
        q.defer(a, "network", a.attempt, 60000); long deadline = a.retryAtMs;
        TextSendQueue restored = text(s, "new-token"); TextSendQueue.Entry b = restored.pending("new-token", 1, BASE, 1).get(0);
        assertEquals(a.requestId, b.requestId); assertEquals(a.attempt, b.attempt); assertEquals(deadline, b.retryAtMs);
        assertEquals(deadline, restored.nextRetryAt("new-token", 1, BASE, 0)); assertEquals(0, restored.nextRetryAt("new-token", 1, BASE, 1));
        assertTrue(restored.claim("new-token", 1, BASE, 2, 0, deadline - 1).isEmpty());
        assertTrue(restored.claim("token", 1, BASE, 2, 0, deadline).isEmpty());
        assertEquals(List.of(b), restored.claim("new-token", 1, BASE, 2, 0, deadline)); assertEquals(2, b.attempt);
        assertEquals(0, restored.nextRetryAt("new-token", 1, BASE, 0));
        assertEquals(1, new DataInputStream(new ByteArrayInputStream(s.data)).readInt());
    }
    private OutboxAttachments attachments;
    private DurableMediaOutbox media(Storage s) throws Exception {
        if (attachments == null) attachments = new OutboxAttachments(files.newFolder(), files.newFolder(), new OutboxAttachments.Ciphers() {
            private Cipher cipher(int mode, byte[] iv) throws Exception {
                Cipher c = Cipher.getInstance("AES/GCM/NoPadding"); SecretKeySpec key = new SecretKeySpec(new byte[16], "AES");
                if (iv == null) c.init(mode, key); else c.init(mode, key, new GCMParameterSpec(128, iv)); return c;
            }
            public Cipher encrypt(String id) throws java.security.GeneralSecurityException { try { return cipher(Cipher.ENCRYPT_MODE, null); } catch (Exception e) { throw new java.security.GeneralSecurityException(e); } }
            public Cipher decrypt(String id, byte[] iv) throws java.security.GeneralSecurityException { try { return cipher(Cipher.DECRYPT_MODE, iv); } catch (Exception e) { throw new java.security.GeneralSecurityException(e); } }
        });
        return new DurableMediaOutbox(s, attachments, "token", 1, BASE);
    }
    private DurableMediaOutbox.Entry add(DurableMediaOutbox q, String id, int cid) throws Exception {
        File f = files.newFile(); Files.write(f.toPath(), new byte[]{1}); return q.enqueue(id, cid, "image", "image/png", "image.png", f, 0, 0);
    }
    @Test public void mediaRestartRetainsUploadAndBackoffWithoutBlockingOtherConversations() throws Exception {
        Storage s = new Storage(); DurableMediaOutbox q = media(s); DurableMediaOutbox.Entry a = add(q, "a", 1); add(q, "b", 2);
        q.claim(1); q.uploaded(a, "{\"url\":\"uploaded\"}"); q.defer(a, "network", a.attempt, 60000); long deadline = a.retryAtMs;
        DurableMediaOutbox restored = media(s); DurableMediaOutbox.Entry b = restored.pending(1).get(0);
        assertEquals(a.attempt, b.attempt); assertEquals(deadline, b.retryAtMs); assertEquals(a.uploadJson, b.uploadJson);
        assertEquals(deadline, restored.nextRetryAt(1));
        assertNull(restored.claim(1, deadline - 1)); assertNotNull(restored.claim(2, deadline - 1));
        assertSame(b, restored.claim(1, deadline)); assertEquals(2, b.attempt); assertEquals(0, restored.nextRetryAt(1));
        restored.fail(b, "permanent"); DurableMediaOutbox again = media(s); DurableMediaOutbox.Entry failed = again.pending(1).get(0);
        assertEquals(DurableMediaOutbox.Phase.FAILED, failed.phase); assertEquals("permanent", failed.error); assertEquals(2, failed.attempt);
        assertNull(again.claim(1, deadline)); assertEquals(0, again.nextRetryAt(1));
        assertEquals(3, new DataInputStream(new ByteArrayInputStream(s.data)).readInt());
    }
    @Test public void oldRecordsWithoutRetryMetadataStillRestore() throws Exception {
        Storage s = new Storage(); TextSendQueue q = text(s, "token");
        TextSendQueue.Entry a = q.enqueue("token", 1, BASE, 1, "a", 0); q.claim("token", 1, BASE); q.defer(a, "network", a.attempt, 60000); s.retry = null;
        TextSendQueue restored = text(s, "token"); TextSendQueue.Entry b = restored.pending("token", 1, BASE, 1).get(0);
        assertEquals(0, b.attempt); assertEquals(0, b.retryAtMs); assertEquals(List.of(b), restored.claim("token", 1, BASE));
        Storage m = new Storage(); DurableMediaOutbox mq = media(m); DurableMediaOutbox.Entry ma = add(mq, "media", 1); mq.claim(1); mq.defer(ma, "network", ma.attempt, 60000); m.retry = null;
        assertNotNull(media(m).claim(1));
    }
    private byte[] metadata(int version, int count, String id, long attempt, long deadline, boolean trailing) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(); DataOutputStream out = new DataOutputStream(bytes);
        out.writeInt(version); out.writeInt(count); out.writeUTF(id); out.writeLong(attempt); out.writeLong(deadline); if (trailing) out.writeByte(0); return bytes.toByteArray();
    }
    @Test public void corruptMetadataIsRejectedBeforeAccountQueueIsRebound() throws Exception {
        Storage s = new Storage(); TextSendQueue q = text(s, "token"); TextSendQueue.Entry a = q.enqueue("token", 1, BASE, 1, "a", 0);
        for (byte[] bad : List.of(metadata(2, 1, a.requestId, 0, 0, false), metadata(1, 2, a.requestId, 0, 0, false), metadata(1, 1, "other-id", 0, 0, false), metadata(1, 1, a.requestId, -1, 0, false), metadata(1, 1, a.requestId, 0, -1, false), metadata(1, 1, a.requestId, 0, 0, true))) {
            s.retry = bad; int before = s.writes; assertThrows(IllegalStateException.class, () -> q.bindStorage(s, "new-token", 1, BASE));
            assertEquals(before, s.writes); assertSame(a, q.pending("token", 1, BASE, 1).get(0));
        }
    }
    @Test public void retryMetadataCommitsWithQueueInOneWrite() throws Exception {
        Storage s = new Storage(); TextSendQueue q = text(s, "token"); int before = s.writes;
        TextSendQueue.Entry a = q.enqueue("token", 1, BASE, 1, "a", 0); assertEquals(before + 1, s.writes); assertNotNull(s.retry);
        q.claim("token", 1, BASE); q.defer(a, "network", a.attempt, 60000);
        TextSendQueue restored = text(s, "token"); assertTrue(restored.claim("token", 1, BASE).isEmpty());
    }
    @Test public void truncatedAndDuplicateRetryRecordsAreRejected() throws Exception {
        byte[] one = metadata(1, 1, "a", 1, 1000, false);
        Map<String, long[]> entries = Map.of("a", new long[2]);
        assertThrows(IOException.class, () -> OutboxRetryState.restore(Arrays.copyOf(one, one.length - 1), entries, (entry, retry) -> {}));
        byte[] first = metadata(1, 2, "a", 1, 1000, false); ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        bytes.write(first); bytes.write(first, 8, first.length - 8);
        assertThrows(IOException.class, () -> OutboxRetryState.restore(bytes.toByteArray(), Map.of("a", new long[2], "b", new long[2]), (entry, retry) -> {}));
    }
}

package com.pulseim.android;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import java.io.File;
import java.nio.file.Files;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import static org.junit.Assert.*;

public class DurableMediaOutboxTest {
    @Rule public TemporaryFolder files = new TemporaryFolder();
    private final byte[][] disk = {null};
    private final OutboxPersistence storage = new OutboxPersistence() {
        public byte[] read() { return disk[0]; } public void write(byte[] bytes) { disk[0] = bytes.clone(); }
    };
    private OutboxAttachments attachments;
    private DurableMediaOutbox box() throws Exception {
        if (attachments == null) attachments = new OutboxAttachments(files.newFolder(), files.newFolder(), new OutboxAttachments.Ciphers() {
            private Cipher cipher(int mode, byte[] iv) throws java.security.GeneralSecurityException {
                Cipher c = Cipher.getInstance("AES/GCM/NoPadding"); SecretKeySpec key = new SecretKeySpec(new byte[16], "AES");
                if (iv == null) c.init(mode, key); else c.init(mode, key, new GCMParameterSpec(128, iv)); return c;
            }
            public Cipher encrypt(String id) throws java.security.GeneralSecurityException { return cipher(Cipher.ENCRYPT_MODE, null); }
            public Cipher decrypt(String id, byte[] iv) throws java.security.GeneralSecurityException { return cipher(Cipher.DECRYPT_MODE, iv); }
        });
        return new DurableMediaOutbox(storage, attachments, "token", 1, "https://example.test/api/v2");
    }
    private DurableMediaOutbox.Entry add(DurableMediaOutbox q, String id, int cid) throws Exception {
        File source = files.newFile(); Files.write(source.toPath(), new byte[]{1});
        return q.enqueue(id, cid, "image", "image/png", "image.png", source, 0, 0);
    }
    @Test public void unreadableHeadIsSkippedWithoutChangingIt() throws Exception {
        DurableMediaOutbox q = box(); DurableMediaOutbox.Entry a = add(q, "a", 1), b = add(q, "b", 1);
        q.claim(1); q.markUnreadable(a, a.attempt); String error = a.error;
        assertSame(b, q.claim(1)); assertEquals(DurableMediaOutbox.Phase.UNREADABLE, a.phase); assertEquals(error, a.error);
    }
    @Test public void failedHeadIsSkippedAndOtherConversationRemainsIndependent() throws Exception {
        DurableMediaOutbox q = box(); DurableMediaOutbox.Entry a = add(q, "a", 1), b = add(q, "b", 1), other = add(q, "c", 2);
        q.claim(1); q.fail(a, "original"); assertSame(b, q.claim(1)); assertSame(other, q.claim(2)); assertEquals("original", a.error);
    }
    @Test public void fakeClockRespectsBackoffAndInFlightBarrier() throws Exception {
        DurableMediaOutbox q = box(); DurableMediaOutbox.Entry a = add(q, "a", 1); add(q, "b", 1); a.retryAtMs = 1000;
        assertNull(q.claim(1, 999)); assertEquals(DurableMediaOutbox.Phase.QUEUED, a.phase);
        assertSame(a, q.claim(1, 1000)); assertNull(q.claim(1, 1000));
        q.uploaded(a, "{}"); q.committing(a); assertNull(q.claim(1, 1000));
    }
    @Test public void restoredFailuresDoNotBlockAndDetachStopsClaims() throws Exception {
        DurableMediaOutbox q = box(); DurableMediaOutbox.Entry a = add(q, "a", 1); add(q, "b", 1);
        q.claim(1); q.fail(a, "original"); DurableMediaOutbox restored = box();
        DurableMediaOutbox.Entry next = restored.claim(1); assertNotNull(next); assertEquals("b", next.requestId);
        restored.detach(); assertNull(restored.claim(1));
    }
}

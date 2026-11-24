package com.pulseim.android;

import org.junit.Test;
import java.util.List;
import static org.junit.Assert.*;

public class TextSendQueueTest {
    private TextSendQueue.Entry add(TextSendQueue q, int cid) { return q.enqueue("token", 1, "https://example.test/api/v2", cid, "text", 0); }
    private List<TextSendQueue.Entry> claim(TextSendQueue q) { return q.claim("token", 1, "https://example.test/api/v2", 2); }
    @Test public void failedHeadDoesNotBlockAndRetainsError() {
        TextSendQueue q = new TextSendQueue(); TextSendQueue.Entry failed = add(q, 1);
        claim(q); q.fail(failed, "original error"); TextSendQueue.Entry next = add(q, 1);
        assertEquals(List.of(next), claim(q)); assertEquals(TextSendQueue.Phase.FAILED, failed.phase); assertEquals("original error", failed.error);
        assertTrue(claim(q).isEmpty());
    }
    @Test public void failedConversationsAndOtherAccountsAreNotClaimed() {
        TextSendQueue q = new TextSendQueue(); TextSendQueue.Entry a = add(q, 1), b = add(q, 2);
        claim(q); q.fail(a, "a"); q.fail(b, "b"); assertTrue(claim(q).isEmpty());
        q.enqueue("other", 2, "https://example.test/api/v2", 3, "other", 0); assertTrue(claim(q).isEmpty());
        TextSendQueue.Entry next = add(q, 3); assertEquals(List.of(next), claim(q));
    }
    @Test public void sendingAndBackoffRemainConversationBarriers() {
        TextSendQueue q = new TextSendQueue(); TextSendQueue.Entry a = add(q, 1); add(q, 1);
        assertEquals(List.of(a), claim(q)); assertTrue(claim(q).isEmpty());
        q.defer(a, "later", a.attempt, Long.MAX_VALUE / 2); assertTrue(claim(q).isEmpty());
    }
    @Test public void restartPreservesRequestIdentityAndFailure() {
        final byte[][] disk = {null}; OutboxPersistence storage = new OutboxPersistence() {
            public byte[] read() { return disk[0]; } public void write(byte[] bytes) { disk[0] = bytes.clone(); }
        };
        TextSendQueue q = new TextSendQueue(); q.bindStorage(storage, "token", 1, "https://example.test/api/v2");
        TextSendQueue.Entry a = add(q, 1); claim(q); q.fail(a, "original"); TextSendQueue.Entry b = add(q, 1);
        TextSendQueue restored = new TextSendQueue(); restored.bindStorage(storage, "new-token", 1, "https://example.test/api/v2");
        List<TextSendQueue.Entry> sent = restored.claim("new-token", 1, "https://example.test/api/v2", 2);
        assertEquals(1, sent.size()); assertEquals(b.requestId, sent.get(0).requestId); assertTrue(b.requestId.startsWith("android-text-"));
        assertEquals("original", restored.pending("new-token", 1, "https://example.test/api/v2", 1).get(0).error);
    }
    @Test public void restrictedConversationDoesNotTakeSlotsOrChangeItsMessage() {
        TextSendQueue q = new TextSendQueue(); TextSendQueue.Entry blocked = add(q, 1);
        blocked.error = "original"; TextSendQueue.Entry b = add(q, 2), c = add(q, 3);
        assertEquals(List.of(b, c), q.claim("token", 1, "https://example.test/api/v2", 2, 1));
        assertEquals(TextSendQueue.Phase.QUEUED, blocked.phase); assertEquals(0, blocked.attempt);
        assertEquals("original", blocked.error); assertTrue(q.claim("token", 1, "https://example.test/api/v2", 2, 1).isEmpty());
    }
    @Test public void blockedQueueDoesNotWriteAndResumesWithoutManualRetry() {
        final byte[][] disk = {null}; final int[] writes = {0};
        OutboxPersistence storage = new OutboxPersistence() {
            public byte[] read() { return disk[0]; } public void write(byte[] bytes) { disk[0] = bytes.clone(); writes[0]++; }
        };
        TextSendQueue q = new TextSendQueue(); q.bindStorage(storage, "token", 1, "https://example.test/api/v2");
        TextSendQueue.Entry a = add(q, 1); add(q, 1); int before = writes[0];
        for (int i = 0; i < 3; i++) assertTrue(q.claim("token", 1, "https://example.test/api/v2", 2, 1).isEmpty());
        assertEquals(before, writes[0]); assertEquals(0, a.attempt);
        assertEquals(List.of(a), q.claim("token", 1, "https://example.test/api/v2", 2, 0));
        assertTrue(q.claim("token", 1, "https://example.test/api/v2", 2, 0).isEmpty());
    }
    @Test public void permissionFilterPreservesAccountAndConversationBarriers() {
        TextSendQueue q = new TextSendQueue(); add(q, 1);
        TextSendQueue.Entry b = add(q, 2); add(q, 2);
        q.enqueue("other", 2, "https://example.test/api/v2", 3, "other", 0);
        assertEquals(List.of(b), q.claim("token", 1, "https://example.test/api/v2", 1, 1));
        assertTrue(q.claim("token", 1, "https://example.test/api/v2", 2, 1).isEmpty());
        q.defer(b, "later", b.attempt, 60_000);
        assertTrue(q.claim("token", 1, "https://example.test/api/v2", 2, 1).isEmpty());
        assertEquals(List.of(b), q.pending("token", 1, "https://example.test/api/v2", 2).subList(0, 1));
    }
    @Test public void accountAndRequestIdentitySurviveRestartWithBlockedConversation() {
        final byte[][] disk = {null}; OutboxPersistence storage = new OutboxPersistence() {
            public byte[] read() { return disk[0]; } public void write(byte[] bytes) { disk[0] = bytes.clone(); }
        };
        TextSendQueue q = new TextSendQueue(); q.bindStorage(storage, "token", 1, "https://example.test/api/v2");
        TextSendQueue.Entry a = add(q, 1), b = add(q, 2);
        TextSendQueue restored = new TextSendQueue(); restored.bindStorage(storage, "new-token", 1, "https://example.test/api/v2");
        assertTrue(restored.claim("token", 1, "https://example.test/api/v2", 2, 1).isEmpty());
        List<TextSendQueue.Entry> eligible = restored.claim("new-token", 1, "https://example.test/api/v2", 2, 1);
        assertEquals(1, eligible.size()); assertEquals(b.requestId, eligible.get(0).requestId);
        assertEquals(a.requestId, restored.pending("new-token", 1, "https://example.test/api/v2", 1).get(0).requestId);
        assertEquals(TextSendQueue.Phase.QUEUED, restored.pending("new-token", 1, "https://example.test/api/v2", 1).get(0).phase);
    }
    @Test public void noActiveConversationAndLegacyOverloadsCanDrainNormally() {
        TextSendQueue q = new TextSendQueue(); TextSendQueue.Entry a = add(q, 1), b = add(q, 2);
        assertTrue(q.claim("token", 1, "https://example.test/api/v2", 0, 1).isEmpty());
        assertEquals(List.of(a, b), q.claim("token", 1, "https://example.test/api/v2", 2, 0));
        TextSendQueue legacy = new TextSendQueue(); TextSendQueue.Entry c = add(legacy, 1);
        assertEquals(List.of(c), claim(legacy));
    }
}

package com.pulseim.android;

import org.junit.Test;
import java.io.*;
import java.util.*;
import static org.junit.Assert.*;

public class OutboxCapacityTest {
    private OutboxRecord row(String id, byte[] payload) throws IOException {
        return row(id, payload, "QUEUED", "");
    }
    private OutboxRecord row(String id, byte[] payload, String phase, String error) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(); DataOutputStream data = new DataOutputStream(bytes);
        data.writeInt(1); data.writeInt(1); data.writeUTF(id); data.writeUTF("https://example.test/api/v2"); data.writeInt(1); data.writeInt(10);
        OutboxCodec.writeString(data, new String(payload, java.nio.charset.StandardCharsets.ISO_8859_1));
        data.writeInt(0); data.writeInt(0); data.writeUTF(phase); OutboxCodec.writeString(data, error);
        byte[] retry = OutboxRetryState.encode(List.of(id), value -> value, value -> 1, value -> 1000);
        return new OutboxRecord(id, bytes.toByteArray(), retry);
    }
    private OutboxCapacity measure(List<OutboxRecord> rows) {
        OutboxCapacity total = OutboxCapacity.empty();
        for (OutboxRecord row : rows) total = total.add(OutboxCapacity.Cost.of(row));
        return total;
    }
    private long actualJsonBytes(List<OutboxRecord> rows) {
        OutboxRecord.Snapshot snapshot = OutboxRecord.combine(rows, 1);
        String data = Base64.getEncoder().encodeToString(snapshot.data()).replace("/", "\\/");
        String retry = Base64.getEncoder().encodeToString(snapshot.retry()).replace("/", "\\/");
        return ("{\"version\":1,\"data\":\"" + data + "\",\"retry_state\":\"" + retry + "\"}").length();
    }
    @Test public void fiftyOneMiBPayloadsCannotBeAcceptedAsRollbackSafe() {
        OutboxCapacity total = OutboxCapacity.empty();
        for (int i = 0; i < 50; i++) total = total.add(new OutboxCapacity.Cost(1024 * 1024, 80, 16));
        assertTrue(total.legacyBytesUpperBound() > OutboxCapacity.MAX_JSON_BYTES);
        OutboxCapacity oversized = total;
        assertThrows(IllegalStateException.class, () -> oversized.requireFits(OutboxCapacity.MAX_JSON_BYTES));
    }
    @Test public void arbitraryBinaryAndRowAlignmentsStayBelowTheJsonBound() throws Exception {
        Random random = new Random(20261126);
        for (int sample = 0; sample < 100; sample++) {
            List<OutboxRecord> rows = new ArrayList<>();
            for (int i = 0; i < 20; i++) {
                byte[] payload = new byte[random.nextInt(301)]; random.nextBytes(payload);
                rows.add(row("row-" + i, payload));
            }
            assertTrue(actualJsonBytes(rows) <= measure(rows).legacyBytesUpperBound());
        }
    }
    @Test public void slashEscapingCannotBypassTheLegacyJsonCapacityLimit() throws Exception {
        byte[] bytes = new byte[600]; Arrays.fill(bytes, (byte)255); List<OutboxRecord> rows = List.of(row("a", bytes));
        OutboxRecord.Snapshot snapshot = OutboxRecord.combine(rows, 1);
        long naive = Base64.getEncoder().encodeToString(snapshot.data()).length() + Base64.getEncoder().encodeToString(snapshot.retry()).length() + 38;
        assertTrue(actualJsonBytes(rows) > naive);
        assertThrows(IllegalStateException.class, () -> measure(rows).requireFits(naive));
    }
    @Test public void updatesAndDeletesRestoreTheExactIncrementalBudget() throws Exception {
        OutboxRecord a = row("a", new byte[20]), b = row("b", new byte[21]), updated = row("a", new byte[300]);
        OutboxCapacity original = measure(List.of(a, b));
        OutboxCapacity changed = original.remove(OutboxCapacity.Cost.of(a)).add(OutboxCapacity.Cost.of(updated));
        assertTrue(changed.same(measure(List.of(updated, b))));
        assertTrue(changed.remove(OutboxCapacity.Cost.of(updated)).same(measure(List.of(b))));
        assertTrue(original.remove(OutboxCapacity.Cost.of(a)).remove(OutboxCapacity.Cost.of(b)).same(OutboxCapacity.empty()));
    }
    @Test public void checkedBoundaryRejectsGrowthWithoutMutatingThePreviousBudget() throws Exception {
        OutboxCapacity before = measure(List.of(row("a", new byte[200]))); long limit = before.legacyBytesUpperBound();
        before.requireFits(limit);
        assertThrows(IllegalStateException.class, () -> before.requireFits(limit - 1));
        assertThrows(IllegalStateException.class, () -> before.add(new OutboxCapacity.Cost(100, 30, 16)).requireFits(limit));
        assertEquals(1, before.count); before.requireFits(limit);
    }
    @Test public void persistedCountersSurviveRestartAndContinueWithOneRowCost() throws Exception {
        OutboxRecord a = row("a", new byte[200]); OutboxCapacity before = measure(List.of(a));
        OutboxCapacity restored = new OutboxCapacity(before.count, before.dataBytes, before.retryBytes, before.slashAllowance);
        assertTrue(restored.same(before)); assertTrue(restored.remove(OutboxCapacity.Cost.of(a)).same(OutboxCapacity.empty()));
    }
    @Test public void entryLimitCannotCreateAnUnreadableSnapshotAfterCutover() {
        OutboxCapacity total = OutboxCapacity.empty();
        for (int i = 0; i < 10000; i++) total = total.add(new OutboxCapacity.Cost(20, 20, 16));
        OutboxCapacity full = total;
        assertThrows(IllegalArgumentException.class, () -> full.add(new OutboxCapacity.Cost(20, 20, 16)));
        assertEquals(10000, full.count);
    }
    @Test public void corruptedCountersUnderflowAndOverflowFailClosed() {
        assertThrows(IllegalArgumentException.class, () -> new OutboxCapacity(-1, 8, 8, 24));
        assertThrows(IllegalArgumentException.class, () -> OutboxCapacity.empty().remove(new OutboxCapacity.Cost(1, 1, 16)));
        assertThrows(ArithmeticException.class, () -> new OutboxCapacity(1, Long.MAX_VALUE, 8, 24).legacyBytesUpperBound());
    }
    @Test public void admissionCannotRaiseTheExistingGlobalStorageLimit() {
        assertThrows(IllegalStateException.class, () -> OutboxCapacity.empty().requireFits(OutboxCapacity.MAX_JSON_BYTES + 1L));
        assertThrows(IllegalStateException.class, () -> OutboxCapacity.empty().requireFits(0));
    }
    @Test public void restartRecoveryCannotIncreaseThePreviouslyChargedCapacity() throws Exception {
        for (String phase : new String[]{"QUEUED", "SENDING"}) {
            for (String error : new String[]{"", "offline", "x".repeat(100), "\uFFFF".repeat(40)}) {
                OutboxCapacity before = measure(List.of(row("a", new byte[200], phase, error)));
                OutboxCapacity recovered = measure(List.of(row("a", new byte[200], "QUEUED", "等待发送…")));
                assertTrue(recovered.legacyBytesUpperBound() <= before.legacyBytesUpperBound());
                recovered.requireFits(before.legacyBytesUpperBound());
            }
        }
    }
}

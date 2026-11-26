package com.pulseim.android;

import java.io.*;
import java.util.*;

/** A single action encoded with the unchanged queue and retry codecs; never contains credentials. */
final class OutboxRecord {
    static final class Snapshot {
        private final byte[] data, retry;
        Snapshot(byte[] data, byte[] retry) {
            this.data = Objects.requireNonNull(data).clone();
            this.retry = retry == null ? null : retry.clone();
        }
        byte[] data() { return data.clone(); }
        byte[] retry() { return retry == null ? null : retry.clone(); }
    }
    final String requestId;
    final Snapshot snapshot;
    OutboxRecord(String requestId, byte[] data, byte[] retry) {
        if (requestId == null || requestId.isEmpty() || requestId.length() > 200) throw new IllegalArgumentException("Invalid outbox request");
        snapshot = new Snapshot(data, retry); this.requestId = requestId;
        try {
            DataInputStream payload = input(data);
            int version = payload.readInt();
            if (version < 1 || version > 3 || payload.readInt() != 1 || !requestId.equals(payload.readUTF())) throw new IOException("Invalid row payload");
            OutboxRetryState.restore(Objects.requireNonNull(retry), Collections.singletonMap(requestId, this), (row, state) -> {});
        } catch (IOException error) { throw new IllegalArgumentException("Invalid outbox row", error); }
    }
    private static DataInputStream input(byte[] bytes) { return new DataInputStream(new ByteArrayInputStream(bytes)); }

    /** Rebuild only at restore/verification/rollback, never on an ordinary row-only mutation. */
    static Snapshot combine(List<OutboxRecord> rows, int version) {
        if (version < 1 || version > 3 || rows.size() > 10000) throw new IllegalArgumentException("Invalid outbox snapshot");
        try {
            ByteArrayOutputStream data = new ByteArrayOutputStream(), retry = new ByteArrayOutputStream();
            DataOutputStream d = new DataOutputStream(data), r = new DataOutputStream(retry);
            d.writeInt(version); d.writeInt(rows.size()); r.writeInt(1); r.writeInt(rows.size());
            Set<String> ids = new HashSet<>();
            for (OutboxRecord row : rows) {
                if (!ids.add(row.requestId) || input(row.snapshot.data).readInt() != version) throw new IOException("Duplicate/mixed outbox rows");
                d.write(row.snapshot.data, 8, row.snapshot.data.length - 8);
                r.write(row.snapshot.retry, 8, row.snapshot.retry.length - 8);
            }
            return new Snapshot(data.toByteArray(), retry.toByteArray());
        } catch (IOException error) { throw new IllegalStateException("无法读取待发队列，请保留本地数据后重试", error); }
    }
    static boolean same(Snapshot a, Snapshot b) {
        return Arrays.equals(a.data, b.data) && Arrays.equals(a.retry, b.retry);
    }
}

package com.pulseim.android;

import java.io.*;

/** Incremental, conservative size of the unchanged Base64/JSON rollback record. */
final class OutboxCapacity {
    static final int MAX_JSON_BYTES = 64 * 1024 * 1024;
    private static final int JSON_BYTES = "{\"version\":1,\"data\":\"\",\"retry_state\":\"\"}".length();
    final long count, dataBytes, retryBytes, slashAllowance;
    static final class Cost {
        final long dataBytes, retryBytes, slashAllowance;
        Cost(long dataBytes, long retryBytes, long slashAllowance) {
            if (dataBytes < 0 || retryBytes < 0 || slashAllowance < 0) throw new IllegalArgumentException("Invalid outbox row size");
            this.dataBytes = dataBytes; this.retryBytes = retryBytes; this.slashAllowance = slashAllowance;
        }
        static Cost of(OutboxRecord row) {
            byte[] data = row.snapshot.data(), retry = row.snapshot.retry();
            byte[] recovered = recovered(data);
            // Charge at least the recovery representation, so a full queue remains restorable.
            return new Cost(Math.max(data.length, recovered.length) - 8L, retry.length - 8L,
                Math.addExact(Math.max(escapedSlashes(data), escapedSlashes(recovered)), escapedSlashes(retry)));
        }
    }
    private static void skipString(DataInputStream input) throws IOException {
        int size = input.readInt();
        if (size < 0 || size > 8 * 1024 * 1024 || size > input.available() || input.skipBytes(size) != size) throw new IOException("Invalid outbox string size");
    }
    private static byte[] recovered(byte[] bytes) {
        try {
            DataInputStream input = new DataInputStream(new ByteArrayInputStream(bytes));
            int version = input.readInt(); input.readInt(); input.readUTF(); input.readUTF(); input.readInt(); input.readInt();
            if (version == 1) {
                skipString(input); input.readInt(); int mentions = input.readInt();
                if (mentions < 0 || mentions > 100) throw new IOException("Invalid mention count");
                for (int i = 0; i < mentions; i++) input.readInt();
            } else {
                input.readUTF(); input.readUTF(); skipString(input); input.readUTF(); input.readLong(); input.readInt(); input.readLong();
            }
            int start = bytes.length - input.available(); String phase = input.readUTF(); skipString(input);
            if (phase.equals("FAILED") || phase.equals("UNREADABLE")) return bytes;
            int end = bytes.length - input.available();
            ByteArrayOutputStream buffer = new ByteArrayOutputStream(); DataOutputStream output = new DataOutputStream(buffer);
            output.write(bytes, 0, start); output.writeUTF("QUEUED"); OutboxCodec.writeString(output, "等待发送…"); output.write(bytes, end, bytes.length - end);
            return buffer.toByteArray();
        } catch (IOException error) { throw new IllegalArgumentException("Invalid outbox capacity payload", error); }
    }
    OutboxCapacity(long count, long dataBytes, long retryBytes, long slashAllowance) {
        if (count < 0 || count > 10000 || dataBytes < 8 || retryBytes < 8 || slashAllowance < 0) throw new IllegalArgumentException("Invalid outbox capacity metadata");
        this.count = count; this.dataBytes = dataBytes; this.retryBytes = retryBytes; this.slashAllowance = slashAllowance;
    }
    // Each eight-byte snapshot header contributes at most twelve escaped Base64 characters.
    static OutboxCapacity empty() { return new OutboxCapacity(0, 8, 8, 24); }
    OutboxCapacity add(Cost cost) {
        return new OutboxCapacity(Math.incrementExact(count), Math.addExact(dataBytes, cost.dataBytes), Math.addExact(retryBytes, cost.retryBytes), Math.addExact(slashAllowance, cost.slashAllowance));
    }
    OutboxCapacity remove(Cost cost) {
        return new OutboxCapacity(Math.decrementExact(count), Math.subtractExact(dataBytes, cost.dataBytes), Math.subtractExact(retryBytes, cost.retryBytes), Math.subtractExact(slashAllowance, cost.slashAllowance));
    }
    private static long base64(long bytes) { return Math.multiplyExact(Math.addExact(bytes, 2) / 3, 4); }
    long legacyBytesUpperBound() { return Math.addExact(JSON_BYTES, Math.addExact(slashAllowance, Math.addExact(base64(dataBytes), base64(retryBytes)))); }
    void requireFits(long limit) {
        if (limit <= 0 || limit > MAX_JSON_BYTES || legacyBytesUpperBound() > limit) throw new IllegalStateException("Local outbox rollback capacity exceeded");
    }
    boolean same(OutboxCapacity other) {
        return other != null && count == other.count && dataBytes == other.dataBytes && retryBytes == other.retryBytes && slashAllowance == other.slashAllowance;
    }
    private static long escapedSlashes(byte[] bytes) {
        long max = 0;
        // A row may start at any of the three Base64 byte alignments after an earlier edit.
        // Bound internal '/' characters at every alignment; reserve two boundary groups.
        for (int alignment = 0; alignment < 3; alignment++) {
            long slashes = 0;
            for (int i = 8 + alignment; i + 2 < bytes.length; i += 3) {
                int a = bytes[i] & 255, b = bytes[i + 1] & 255, c = bytes[i + 2] & 255;
                if ((a >>> 2) == 63) slashes++;
                if ((((a & 3) << 4) | (b >>> 4)) == 63) slashes++;
                if ((((b & 15) << 2) | (c >>> 6)) == 63) slashes++;
                if ((c & 63) == 63) slashes++;
            }
            max = Math.max(max, slashes);
        }
        return max + 8;
    }
}

package com.pulseim.android;

import java.io.*;
import java.util.Collections;

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
    private static final class Fields {
        final int version, endpointAt, endpointEnd, phaseAt, errorEnd, stateEnd;
        final String endpoint, phase;
        Fields(byte[] bytes) throws IOException {
            DataInputStream input = new DataInputStream(new ByteArrayInputStream(bytes));
            version = input.readInt();
            if (version < 1 || version > 3 || input.readInt() != 1) throw new IOException("Invalid outbox row version/count");
            input.readUTF(); endpointAt = bytes.length - input.available(); endpoint = input.readUTF(); endpointEnd = bytes.length - input.available(); input.readInt(); input.readInt();
            if (version == 1) {
                skipString(input); input.readInt(); int mentions = input.readInt();
                if (mentions < 0 || mentions > 100) throw new IOException("Invalid mention count");
                for (int i = 0; i < mentions; i++) input.readInt();
            } else {
                input.readUTF(); input.readUTF(); skipString(input); input.readUTF(); input.readLong(); input.readInt(); input.readLong();
            }
            phaseAt = bytes.length - input.available(); phase = input.readUTF(); skipString(input);
            if (version == 1 ? !(phase.equals("QUEUED") || phase.equals("SENDING") || phase.equals("FAILED")) :
                !(phase.equals("QUEUED") || phase.equals("UPLOADING") || phase.equals("COMMITTING") || phase.equals("FAILED") || phase.equals("UNREADABLE"))) throw new IOException("Invalid outbox phase");
            errorEnd = bytes.length - input.available();
            if (version != 1) skipString(input);
            stateEnd = bytes.length - input.available();
            if (version >= 2) input.readBoolean();
            if (input.available() != 0) throw new IOException("Trailing outbox row data");
        }
    }
    private static byte[] recovered(byte[] bytes) {
        try {
            Fields fields = new Fields(bytes);
            if (fields.phase.equals("FAILED") || fields.phase.equals("UNREADABLE")) return bytes;
            ByteArrayOutputStream buffer = new ByteArrayOutputStream(); DataOutputStream output = new DataOutputStream(buffer);
            output.write(bytes, 0, fields.phaseAt); output.writeUTF("QUEUED"); OutboxCodec.writeString(output, "等待发送…"); output.write(bytes, fields.errorEnd, bytes.length - fields.errorEnd);
            return buffer.toByteArray();
        } catch (IOException error) { throw new IllegalArgumentException("Invalid outbox capacity payload", error); }
    }
    /** Only existing, unchanged actions may progress while an old Room queue is oversized. */
    static boolean recoverySafe(OutboxRecord before, OutboxRecord after) {
        if (!before.requestId.equals(after.requestId)) return false;
        byte[] a = before.snapshot.data(), b = after.snapshot.data();
        try {
            Fields old = new Fields(a), next = new Fields(b);
            if (old.version != next.version || old.endpointAt != next.endpointAt || old.phaseAt - old.endpointEnd != next.phaseAt - next.endpointEnd || a.length - old.stateEnd != b.length - next.stateEnd) return false;
            if (!OutboxCodec.sameEndpoint(old.endpoint, next.endpoint)) return false;
            for (int i = 0; i < old.endpointAt; i++) if (a[i] != b[i]) return false;
            for (int i = 0; i < old.phaseAt - old.endpointEnd; i++) if (a[old.endpointEnd + i] != b[next.endpointEnd + i]) return false;
            for (int i = 0; i < a.length - old.stateEnd; i++) if (a[old.stateEnd + i] != b[next.stateEnd + i]) return false;
            // Bound mutable diagnostics/upload metadata absolutely, rather than adding room each retry.
            if (next.stateEnd - next.phaseAt > Math.max(old.stateEnd - old.phaseAt, 64 * 1024)) return false;
            return attempt(after) >= attempt(before);
        } catch (IOException error) { throw new IllegalArgumentException("Invalid outbox recovery payload", error); }
    }
    private static long attempt(OutboxRecord row) throws IOException {
        long[] value = {0};
        OutboxRetryState.restore(row.snapshot.retry(), Collections.singletonMap(row.requestId, row), (entry, state) -> value[0] = state[0]);
        return value[0];
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
    boolean fits(long limit) { return limit > 0 && limit <= MAX_JSON_BYTES && legacyBytesUpperBound() <= limit; }
    void requireFits(long limit) { if (!fits(limit)) throw new IllegalStateException("Local outbox rollback capacity exceeded"); }
    void requireTransition(long limit, OutboxCapacity before, boolean roomReads, boolean existingActionsOnly) {
        if (limit <= 0 || limit > MAX_JSON_BYTES || !fits(limit) && !(roomReads && before != null && !before.fits(limit) && existingActionsOnly))
            throw new IllegalStateException("Local outbox rollback capacity exceeded");
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

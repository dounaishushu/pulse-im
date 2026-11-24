package com.pulseim.android;

import java.io.*;
import java.util.*;
import java.util.function.*;

/** Optional metadata committed with the unchanged queue payload in its encrypted record. */
final class OutboxRetryState {
    static <T> byte[] encode(Collection<T> entries, Function<T, String> id, ToLongFunction<T> attempts, ToLongFunction<T> retryAt) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(); DataOutputStream out = new DataOutputStream(bytes);
        out.writeInt(1); out.writeInt(entries.size());
        for (T entry : entries) { out.writeUTF(id.apply(entry)); out.writeLong(attempts.applyAsLong(entry)); out.writeLong(retryAt.applyAsLong(entry)); }
        out.flush(); return bytes.toByteArray();
    }
    static <T> void restore(byte[] snapshot, Map<String, T> entries, BiConsumer<T, long[]> apply) throws IOException {
        if (snapshot == null) return;
        DataInputStream in = new DataInputStream(new ByteArrayInputStream(snapshot));
        if (in.readInt() != 1 || in.readInt() != entries.size()) throw new IOException("Invalid retry metadata version/count");
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < entries.size(); i++) {
            String id = in.readUTF(); T entry = entries.get(id); long attempt = in.readLong(), retryAt = in.readLong();
            if (entry == null || !seen.add(id) || attempt < 0 || retryAt < 0) throw new IOException("Invalid retry metadata entry");
            apply.accept(entry, new long[]{attempt, retryAt});
        }
        if (in.available() != 0) throw new IOException("Trailing retry metadata");
    }
}

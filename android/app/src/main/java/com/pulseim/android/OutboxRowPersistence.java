package com.pulseim.android;

import java.util.List;
import java.util.function.Supplier;

/** Optional delta storage. Existing snapshot stores retain their original contract. */
interface OutboxRowPersistence extends OutboxPersistence {
    /** One atomic commit. The full legacy snapshot is evaluated only while dual-writing. */
    void writeRows(List<OutboxRecord> upserts, List<String> deletes, boolean replaceAll,
                   Supplier<OutboxRecord.Snapshot> legacySnapshot);
}

package com.pulseim.android;

/** Synchronous, atomic, account-scoped storage. A failed/stale write must throw. */
interface OutboxPersistence {
    byte[] read();
    void write(byte[] snapshot);
    default byte[] readRetryState() { return null; }
    default void write(byte[] snapshot, byte[] retryState) { write(snapshot); }
}

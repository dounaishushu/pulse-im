package com.pulseim.android;

import androidx.annotation.NonNull;
import androidx.room.Entity;

/** All action fields, including state/error/retry/upload metadata, are authenticated ciphertext. */
@Entity(tableName = "outbox", primaryKeys = {"accountKey", "namespace", "requestId"})
public final class OutboxEntity {
    @NonNull public String accountKey = "";
    @NonNull public String namespace = "";
    @NonNull public String requestId = "";
    public long position;
    public long createdAt;
    @NonNull public byte[] data = new byte[0];
}

package com.pulseim.android;

import androidx.annotation.NonNull;
import androidx.room.Entity;

@Entity(tableName = "outbox_metadata", primaryKeys = {"accountKey", "namespace"})
public final class OutboxMetadata {
    @NonNull public String accountKey = "";
    @NonNull public String namespace = "";
    @NonNull public byte[] data = new byte[0];
}

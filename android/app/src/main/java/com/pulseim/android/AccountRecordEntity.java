package com.pulseim.android;

import androidx.annotation.NonNull;
import androidx.room.ColumnInfo;
import androidx.room.Entity;

/** The existing records schema, retained byte for byte by migration 1 -> 2. */
@Entity(tableName = "records", primaryKeys = {"scope", "namespace", "record_key"})
public final class AccountRecordEntity {
    @NonNull public String scope = "";
    @NonNull public String namespace = "";
    @ColumnInfo(name = "record_key") @NonNull public String recordKey = "";
    @NonNull public byte[] data = new byte[0];
}

package com.pulseim.android;

import androidx.annotation.NonNull;

/** BLOBs are fetched in bounded chunks, so an 8 MiB draft never fills CursorWindow. */
public final class OutboxRowHeader {
    @NonNull public String requestId = "";
    public long position, createdAt;
    public int byteCount;
}

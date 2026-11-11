package com.pulseim.android

/** A retained tab stays visible while an account-scoped snapshot is refreshed. */
internal class HomeTabLoadState(private val lifetimeMs: Long = 15_000L) {
    var hasSnapshot = false; private set
    var loading = false; private set
    private var loadedAt = 0L
    private var revision = 0L
    private var requestedRevision = 0L
    private var acceptedRevision = -1L

    fun needsRefresh(now: Long): Boolean = !loading &&
        (!hasSnapshot || revision != acceptedRevision || now - loadedAt >= lifetimeMs)
    fun begin() { loading = true; requestedRevision = revision }
    fun accept(now: Long) { loading = false; hasSnapshot = true; loadedAt = now; acceptedRevision = requestedRevision }
    fun restore() { hasSnapshot = true; loadedAt = 0; acceptedRevision = -1 }
    fun fail() { loading = false }
    fun invalidate() { revision++ }
    fun reset() { hasSnapshot = false; loading = false; loadedAt = 0; revision++; acceptedRevision = -1 }
}

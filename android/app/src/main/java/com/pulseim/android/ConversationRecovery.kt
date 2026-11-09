package com.pulseim.android

/** ID-keyset snapshot plus events received after subscription. No Android APIs,
 * so large-gap and event-race behavior is executable in ordinary JVM checks. */
internal class ConversationRecovery<T>(private val floor: Int) {
    private val rows = sortedMapOf<Int, T>()
    private val events = linkedMapOf<Int, T?>()
    var after = 0; private set
    var maximum: Int? = null; private set
    private var cleared = 0
    private var complete = false

    @Synchronized fun page(maximumId: Int, next: Int, more: Boolean, clearedId: Int, items: List<Pair<Int, T>>) {
        require(!complete && maximumId >= 0 && (maximum == null || maximum == maximumId) && next >= after && (!more || next > after)) { "Invalid message sync cursor" }
        for ((id, item) in items) { require(id > after && id >= floor && id <= maximumId) { "Invalid message sync range" }; rows[id] = item }
        maximum = maximumId; after = next; cleared = maxOf(cleared, clearedId); complete = !more
    }
    @Synchronized fun event(id: Int, message: T?) { if (id > 0) events[id] = message }
    @Synchronized fun clearedBefore(): Int = cleared
    @Synchronized fun result(): List<T> {
        check(complete) { "Incomplete message snapshot" }
        for ((id, message) in events) { if (message == null) rows.remove(id) else if (id >= floor) rows[id] = message }
        return rows.filterKeys { it > cleared }.values.toList()
    }
}

/** A send acknowledgement has no newer mutation authority than an observed WS
 * edit/recall. Tombstones survive replacement of visible rows. */
internal class MessageVersionGuard<T> {
    private data class Entry<T>(val edited: String, val removed: Boolean, val value: T?)
    private val entries = mutableMapOf<Int, Entry<T>>()
    fun clear() = entries.clear()
    fun value(id: Int): T? = entries[id]?.takeUnless { it.removed }?.value
    fun releaseValuesBefore(floor: Int) {
        // Preserve edit/recall authority without retaining old message bodies forever.
        entries.keys.filter { it < floor }.forEach { id -> entries[id]?.let { if (it.value != null) entries[id] = it.copy(value = null) } }
    }
    fun accept(id: Int, edited: String, removed: Boolean, value: T?, source: String): Boolean {
        if (id <= 0) return false
        val previous = entries[id]
        if (!removed && previous != null) {
            if (previous.removed || (previous.edited.isNotEmpty() && edited < previous.edited)) return false
            if (source == "ack" && (edited.isEmpty() || (previous.edited.isNotEmpty() && edited <= previous.edited))) return false
        }
        entries[id] = Entry(edited, removed, value)
        return true
    }
}

/** Visibility is derived from the quoted source, independently of the reply's
 * own edited_at. A late history read cannot resurrect a removed source. */
internal class ReplyVisibilityState {
    private val unavailable = mutableSetOf<Int>()
    fun clear() = unavailable.clear()
    fun removed(sourceId: Int) { if (sourceId > 0) unavailable.add(sourceId) }
    fun hidden(sourceId: Int, serverUnavailable: Boolean, clearedBefore: Int): Boolean {
        if (sourceId <= 0) return true
        if (serverUnavailable || sourceId <= clearedBefore) unavailable.add(sourceId)
        return sourceId in unavailable
    }
}

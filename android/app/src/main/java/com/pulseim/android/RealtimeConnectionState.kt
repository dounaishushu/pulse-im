package com.pulseim.android

/** Lifecycle and per-connection subscription ownership, independent of Android. */
internal class RealtimeConnectionState {
    private var epoch = 0
    private var active = false
    private var closed = false
    private var authenticated = false
    private val subscriptions = mutableSetOf<Int>()
    private var inbox = false

    @Synchronized fun begin(): Int? {
        if (closed || active) return null
        active = true; authenticated = false; subscriptions.clear(); inbox = false
        return ++epoch
    }
    @Synchronized fun accepts(value: Int): Boolean = !closed && active && epoch == value
    @Synchronized fun authenticate(value: Int): Boolean {
        if (!accepts(value) || authenticated) return false
        authenticated = true; return true
    }
    @Synchronized fun ready(): Boolean = !closed && active && authenticated
    @Synchronized fun subscribe(value: Int, conversation: Int): Boolean = accepts(value) && authenticated && conversation > 0 && subscriptions.add(conversation)
    @Synchronized fun unsubscribe(value: Int, conversation: Int): Boolean = accepts(value) && authenticated && subscriptions.remove(conversation)
    @Synchronized fun subscribeInbox(value: Int): Boolean {
        if (!accepts(value) || !authenticated || inbox) return false
        inbox = true; return true
    }
    @Synchronized fun disconnect(value: Int): Boolean {
        if (!accepts(value)) return false
        active = false; authenticated = false; subscriptions.clear(); inbox = false
        return true
    }
    @Synchronized fun close() { closed = true; active = false; authenticated = false; subscriptions.clear(); inbox = false }
}

/** Coalesce refresh bursts while retaining one follow-up after an in-flight read. */
internal class ConversationRefreshGate {
    private var running = false
    private var again = false
    @Synchronized fun begin(refresh: Boolean): Boolean {
        if (running) { if (refresh) again = true; return false }
        running = true; return true
    }
    @Synchronized fun finish(): Boolean { running = false; val pending = again; again = false; return pending }
}

/** Accept unrelated/new rows even while one busy conversation keeps changing. */
internal class ConversationSnapshotState<T> {
    var revision = 0
        private set
    private val changes = mutableMapOf<Int, Int>()
    private val hidden = mutableMapOf<Int, Int>()
    fun advanceSnapshotRevision(): Int = ++revision
    fun changed(id: Int) { if (id > 0) changes[id] = ++revision }
    fun hide(id: Int) { if (id > 0) { changes.remove(id); hidden[id] = ++revision } }
    fun merge(requestRevision: Int, incoming: List<Pair<Int, T>>, previous: List<Pair<Int, T>>, replace: Boolean): List<T> {
        val old = previous.toMap()
        val result = if (replace) linkedMapOf() else previous.toMap(linkedMapOf())
        for ((id, item) in incoming) {
            if ((hidden[id] ?: -1) > requestRevision) { result.remove(id); continue }
            result[id] = if ((changes[id] ?: -1) > requestRevision && old.containsKey(id)) old.getValue(id) else item
        }
        if (replace) previous.forEach { (id, item) -> if ((changes[id] ?: -1) > requestRevision && (hidden[id] ?: -1) <= requestRevision) result.putIfAbsent(id, item) }
        changes.entries.removeAll { it.value <= requestRevision }; hidden.entries.removeAll { it.value <= requestRevision }
        return result.values.toList()
    }
}

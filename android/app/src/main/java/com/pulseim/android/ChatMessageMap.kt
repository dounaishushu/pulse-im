package com.pulseim.android

/** Compatibility map for the existing renderer; ownership and snapshots live in the ViewModel. */
internal class ChatMessageMap<V>(
    private val lock: Any,
    private val snapshot: (Int, V) -> ChatRow,
    private val accepts: (ChatRow) -> Boolean,
    private val changed: (List<ChatRow>) -> Unit
) : AbstractMutableMap<Int, V>() {
    private val valuesById = sortedMapOf<Int, V>()
    private val snapshotsById = sortedMapOf<Int, ChatRow>()
    private var published: List<ChatRow> = emptyList()

    override val size: Int get() = synchronized(lock) { valuesById.size }
    override fun get(key: Int): V? = synchronized(lock) { valuesById[key] }
    override fun containsKey(key: Int) = synchronized(lock) { valuesById.containsKey(key) }
    override val entries: MutableSet<MutableMap.MutableEntry<Int, V>> get() = synchronized(lock) {
        val result = linkedSetOf<MutableMap.MutableEntry<Int, V>>()
        valuesById.forEach { (id, value) -> result.add(java.util.AbstractMap.SimpleImmutableEntry(id, value)) }
        java.util.Collections.unmodifiableSet(result)
    }

    override fun put(key: Int, value: V): V? = synchronized(lock) {
        val row = snapshot(key, value)
        val previous = valuesById[key]
        if (key <= 0 || row.id != key || !accepts(row)) return@synchronized previous
        valuesById[key] = value
        if (snapshotsById.put(key, row) != row) publish()
        previous
    }

    override fun remove(key: Int): V? = synchronized(lock) {
        if (!valuesById.containsKey(key)) return@synchronized null
        val previous = valuesById.remove(key)
        snapshotsById.remove(key)
        publish()
        previous
    }

    override fun clear() = synchronized(lock) {
        if (valuesById.isNotEmpty()) { reset(); changed(published) }
    }

    /** Called under the same lock as the ViewModel's account/conversation transition. */
    fun reset() = synchronized(lock) {
        valuesById.clear(); snapshotsById.clear(); published = emptyList()
    }

    private fun publish() {
        published = java.util.Collections.unmodifiableList(ArrayList(snapshotsById.values))
        changed(published)
    }
}

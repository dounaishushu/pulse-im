package com.pulseim.android

import android.os.SystemClock
import org.json.JSONObject

/** Recently displayed pages only; never persists access or grants permission to send. */
internal class ChatSwitchCache(private val now: () -> Long = { SystemClock.elapsedRealtime() }) {
    data class Ticket(val scope: String, val connection: Int, val conversation: Int, val generation: Long, val revision: Long, val contentRevision: Long)
    data class Snapshot(val info: JSONObject, val page: ChatHistoryPage, val savedAt: Long, val cursor: ChatDeltaCursor? = null)
    private var scope = ""
    private var connection = -1
    private var generation = 0L
    private val revisions = mutableMapOf<Int, Long>()
    private val changes = mutableMapOf<Int, Long>()
    private val pages = LinkedHashMap<Int, Snapshot>(8, .75f, true)
    fun bind(owner: String, epoch: Int) {
        if (scope != owner) { clear(); scope = owner }
        if (connection != epoch) { generation++; connection = epoch }
    }
    fun clear() { generation++; pages.clear(); revisions.clear(); changes.clear() }
    fun changed(conversation: Int) {
        if (conversation > 0) changes[conversation] = (changes[conversation] ?: 0L) + 1
    }
    fun invalidate(conversation: Int) {
        if (conversation <= 0) { clear(); return }
        pages.remove(conversation); revisions[conversation] = (revisions[conversation] ?: 0L) + 1
    }
    fun ticket(conversation: Int) = Ticket(scope, connection, conversation, generation, revisions[conversation] ?: 0L, changes[conversation] ?: 0L)
    private fun owns(ticket: Ticket) = ticket.scope == scope && ticket.connection == connection &&
        ticket.generation == generation && ticket.revision == (revisions[ticket.conversation] ?: 0L)
    fun current(ticket: Ticket) = owns(ticket) && ticket.contentRevision == (changes[ticket.conversation] ?: 0L)
    fun read(ticket: Ticket, summary: JSONObject?, connected: Boolean): Snapshot? {
        // Existing local records remain readable during reconnect or metadata
        // refresh. Neither their metadata nor these cursors authorize sending.
        if (!current(ticket)) return null
        val value = pages[ticket.conversation] ?: return null
        if (summary?.let { it.optInt("id") != ticket.conversation || it.optString("type") != value.info.optString("type") ||
                it.optString("membership_version") != value.page.membershipVersion ||
                it.optBoolean("is_hidden") } == true) {
            pages.remove(ticket.conversation); return null
        }
        val boundary = maxOf(value.page.clearedBefore, summary?.optInt("cleared_before_message_id") ?: 0)
        if (boundary > value.page.clearedBefore) pages[ticket.conversation] = value.copy(
            page = value.page.copy(items = value.page.items.filter { it.optInt("id") > boundary }, clearedBefore = boundary))
        return Snapshot(JSONObject(value.info.toString()), value.page.copy(items = value.page.items.filter { it.optInt("id") > boundary }.map { JSONObject(it.toString()) }, clearedBefore = boundary), value.savedAt, value.cursor)
    }
    fun remember(ticket: Ticket, info: JSONObject, page: ChatHistoryPage, cursor: ChatDeltaCursor? = null): Boolean {
        if (!owns(ticket) || info.optInt("id") != ticket.conversation || page.membershipVersion.isNullOrBlank() ||
            info.optString("membership_version") != page.membershipVersion ||
            page.items.any { it.optInt("id") <= 0 || it.optInt("conversation_id") != ticket.conversation }) return false
        val items = page.items.sortedBy { it.optInt("id") }.takeLast(20).map { JSONObject(it.toString()) }
        // Keep unusually large message bodies from occupying a navigation cache.
        if (items.sumOf { it.toString().length } + info.toString().length > 256 * 1024) return false
        pages[ticket.conversation] = Snapshot(JSONObject(info.toString()).apply { remove("_opening_chat"); remove("_local_pending") },
            page.copy(items = items, nextMaxId = ((items.firstOrNull()?.optInt("id") ?: 1) - 1).coerceAtLeast(0),
                hasMore = page.hasMore || page.items.size > items.size), now(), cursor?.takeIf { it.membership == page.membershipVersion })
        while (pages.size > 8) pages.remove(pages.keys.first())
        return true
    }
}

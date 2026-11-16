package com.pulseim.android

import org.json.JSONObject

/** Main-thread queue: one bounded snapshot per request, scoped to the authenticated endpoint. */
internal class ConversationReadState {
    data class Account(val userId: Int, val token: String, val endpoint: String)
    data class Request(val account: Account, val generation: Long, val sequence: Long, val conversationId: Int, val through: Int)
    private var account: Account? = null
    private var generation = 0L
    private var sequence = 0L
    var revision = 0L; private set
    private val pending = linkedMapOf<Int, Int>()
    private data class Confirmed(val through: Int, val unread: Int, val stateVersion: Long)
    private val confirmed = mutableMapOf<Int, Confirmed>()
    private var inFlight: Request? = null

    fun bind(userId: Int, token: String?, endpoint: String) {
        val next = token?.takeIf { it.isNotBlank() && userId > 0 }?.let { Account(userId, it, endpoint) }
        if (next == account) return
        account = next; generation++; revision++; pending.clear(); confirmed.clear(); inFlight = null
    }

    fun record(conversationId: Int, through: Int, reopen: Boolean = false): Boolean {
        if (account == null || conversationId <= 0 || through <= 0) return false
        if (through <= (pending[conversationId] ?: 0)) return false
        if (!reopen && through <= (confirmed[conversationId]?.through ?: 0)) return false
        pending[conversationId] = through; revision++; return true
    }

    fun next(): Request? {
        val actor = account ?: return null
        if (inFlight != null) return null
        val entry = pending.entries.firstOrNull() ?: return null
        return Request(actor, generation, ++sequence, entry.key, entry.value).also { inFlight = it }
    }

    fun finish(request: Request, success: Boolean, unreadCount: Int = 0, stateVersion: Long = 0): Boolean {
        if (inFlight != request || request.generation != generation || request.account != account) return false
        inFlight = null
        if (success) {
            require(unreadCount >= 0 && stateVersion >= 0)
            val previous = confirmed[request.conversationId]
            confirmed[request.conversationId] = Confirmed(maxOf(previous?.through ?: 0, request.through), unreadCount, maxOf(previous?.stateVersion ?: 0, stateVersion))
            if ((pending[request.conversationId] ?: 0) <= request.through) pending.remove(request.conversationId)
            revision++
        }
        return true
    }

    // A retained list or a late directory response must not resurrect an acknowledged read.
    // New messages and a newer explicit unread reminder still use their server counts.
    fun unread(conversationId: Int, latestMessageId: Int, serverCount: Int, stateVersion: Long = 0, reminder: Boolean = false): Int {
        if (latestMessageId > 0 && latestMessageId <= (pending[conversationId] ?: 0)) return 0
        val read = confirmed[conversationId]
        if (read != null && latestMessageId > 0 && latestMessageId <= read.through &&
            (stateVersion <= read.stateVersion || read.stateVersion == 0L && !reminder)) return read.unread
        return serverCount.coerceAtLeast(0)
    }

    fun apply(row: JSONObject) {
        val id = row.optInt("id")
        val latest = row.optJSONObject("last_message")?.optInt("id") ?: 0
        val state = row.optJSONObject("state")
        val version = state?.optString("version")?.toLongOrNull() ?: 0L
        row.put("unread_count", unread(id, latest, row.optInt("unread_count"), version, state?.optBoolean("reminder") == true))
        val read = confirmed[id]
        val through = maxOf(pending[id] ?: 0, read?.takeIf { version <= it.stateVersion || it.stateVersion == 0L }?.through ?: 0)
        val lastMention = row.optInt("last_mention_message_id")
        if (through > 0 && (lastMention > 0 && lastMention <= through || lastMention == 0 && latest in 1..through)) {
            row.put("unread_mention_count", 0).put("last_mention_message_id", 0)
        }
    }
}

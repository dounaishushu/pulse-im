package com.pulseim.android

/** Main-thread queue: one bounded snapshot per request, scoped to the authenticated endpoint. */
internal class ConversationReadState {
    data class Account(val userId: Int, val token: String, val endpoint: String)
    data class Request(val account: Account, val generation: Long, val sequence: Long, val conversationId: Int, val through: Int)
    private var account: Account? = null
    private var generation = 0L
    private var sequence = 0L
    var revision = 0L; private set
    private val pending = linkedMapOf<Int, Int>()
    private val confirmed = mutableMapOf<Int, Int>()
    private var inFlight: Request? = null

    fun bind(userId: Int, token: String?, endpoint: String) {
        val next = token?.takeIf { it.isNotBlank() && userId > 0 }?.let { Account(userId, it, endpoint) }
        if (next == account) return
        account = next; generation++; revision++; pending.clear(); confirmed.clear(); inFlight = null
    }

    fun record(conversationId: Int, through: Int, reopen: Boolean = false): Boolean {
        if (account == null || conversationId <= 0 || through <= 0) return false
        if (through <= (pending[conversationId] ?: 0)) return false
        if (!reopen && through <= (confirmed[conversationId] ?: 0)) return false
        pending[conversationId] = through; revision++; return true
    }

    fun next(): Request? {
        val actor = account ?: return null
        if (inFlight != null) return null
        val entry = pending.entries.firstOrNull() ?: return null
        return Request(actor, generation, ++sequence, entry.key, entry.value).also { inFlight = it }
    }

    fun finish(request: Request, success: Boolean): Boolean {
        if (inFlight != request || request.generation != generation || request.account != account) return false
        inFlight = null
        if (success) {
            confirmed[request.conversationId] = maxOf(confirmed[request.conversationId] ?: 0, request.through)
            if ((pending[request.conversationId] ?: 0) <= request.through) pending.remove(request.conversationId)
            revision++
        }
        return true
    }

    // Suppress only pending reads whose displayed boundary covers the entire list snapshot.
    // A newer last message must retain its unread indication until a fresh authoritative count.
    fun unread(conversationId: Int, latestMessageId: Int, serverCount: Int): Int =
        if (latestMessageId > 0 && latestMessageId <= (pending[conversationId] ?: 0)) 0 else serverCount.coerceAtLeast(0)
}

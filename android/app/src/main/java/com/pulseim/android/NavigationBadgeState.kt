package com.pulseim.android

internal data class NavigationBadgeCounts(val messages: Int = 0, val requests: Int = 0) {
    companion object {
        fun label(count: Int): String = when {
            count <= 0 -> ""
            count > 99 -> "99+"
            else -> count.toString()
        }
    }
}

internal data class NavigationBadgeSnapshot @JvmOverloads constructor(val conversations: Map<Int, Int>, val pendingRequestIds: Set<Int>, val latestMessageIds: Map<Int, Int> = emptyMap())

/** A complete server snapshot is scoped to an account and cannot undo later actions. */
internal class NavigationBadgeState {
    data class Ticket(val generation: Long, val revision: Long, val sequence: Long)
    private data class Account(val userId: Int, val token: String?, val endpoint: String)
    private var account: Account? = null
    private var generation = 0L
    private var revision = 0L
    private var sequence = 0L
    private var conversations = emptyMap<Int, Int>()
    private var requests = emptySet<Int>()

    fun bind(userId: Int, token: String?, endpoint: String): Boolean {
        val next = if (userId > 0 && !token.isNullOrBlank()) Account(userId, token, endpoint) else null
        if (account == next) return false
        account = next; generation++; revision++; sequence++
        conversations = emptyMap(); requests = emptySet()
        return true
    }

    fun begin(): Ticket = Ticket(generation, revision, ++sequence)

    fun accept(ticket: Ticket, snapshot: NavigationBadgeSnapshot): Boolean {
        if (account == null || ticket.generation != generation || ticket.revision != revision || ticket.sequence != sequence) return false
        conversations = snapshot.conversations.filter { (id, unread) -> id > 0 && unread > 0 }.toMap()
        requests = snapshot.pendingRequestIds.filter { it > 0 }.toSet()
        return true
    }

    fun invalidate() { revision++ }

    fun handledRequest(id: Int) {
        if (id <= 0) return
        revision++
        requests = requests - id
    }

    fun counts(): NavigationBadgeCounts = NavigationBadgeCounts(
        conversations.values.fold(0L) { total, unread -> (total + unread).coerceAtMost(Int.MAX_VALUE.toLong()) }.toInt(),
        requests.size
    )
}

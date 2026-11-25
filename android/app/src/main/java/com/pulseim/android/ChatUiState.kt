package com.pulseim.android

/** In-memory identity only. Credentials never appear in diagnostic descriptions. */
internal data class ChatAccount(val endpoint: String, val userId: Int, val token: String) {
    init { require(endpoint.isNotBlank() && userId > 0 && token.isNotBlank()) }
    override fun toString() = "ChatAccount(userId=$userId)"
}

/** Immutable payloads prevent a worker from mutating a state already being rendered. */
internal data class ChatRow(val id: Int, val conversationId: Int, val snapshot: String, val version: String = "")
internal data class OutboxRow(
    val requestId: String, val conversationId: Int, val kind: String,
    val phase: String, val error: String = "", val attempt: Long = 0, val retryAtMs: Long = 0
)

internal data class ChatUiState(
    val conversationId: Int = 0,
    val messages: List<ChatRow> = emptyList(),
    val outbox: List<OutboxRow> = emptyList(),
    val canSend: Boolean = false,
    val canSendReason: String? = null,
    val loadingOlder: Boolean = false,
    val hasMoreOlder: Boolean = true,
    val account: ChatAccount? = null,
    val accountRevision: Long = 0,
    val conversationRevision: Long = 0
)

/** Epochs also reject callbacks after switching A -> B -> A. */
internal data class ChatStateTicket(
    val account: ChatAccount, val accountRevision: Long,
    val conversationId: Int, val conversationRevision: Long
) {
    fun matches(state: ChatUiState) = account == state.account && accountRevision == state.accountRevision &&
        conversationId == state.conversationId && conversationRevision == state.conversationRevision
}

/** Pure reducer; the ViewModel owns publication and serializes transitions. */
internal object ChatStateReducer {
    fun bind(state: ChatUiState, account: ChatAccount?): ChatUiState =
        if (account == state.account) state else ChatUiState(account = account,
            accountRevision = state.accountRevision + 1, conversationRevision = state.conversationRevision + 1)

    fun open(state: ChatUiState, conversationId: Int): ChatUiState {
        require(conversationId >= 0)
        require(conversationId == 0 || state.account != null) { "An authenticated account is required" }
        // Reopening the same conversation is a new entry, so old history work loses ownership.
        return ChatUiState(conversationId = conversationId, account = state.account,
            accountRevision = state.accountRevision, conversationRevision = state.conversationRevision + 1)
    }

    fun ticket(state: ChatUiState): ChatStateTicket? = state.account?.takeIf { state.conversationId > 0 }?.let {
        ChatStateTicket(it, state.accountRevision, state.conversationId, state.conversationRevision)
    }

    fun permission(state: ChatUiState, ticket: ChatStateTicket, allowed: Boolean, reason: String?): ChatUiState =
        if (!ticket.matches(state)) state else state.copy(canSend = allowed, canSendReason = reason)

    fun history(state: ChatUiState, ticket: ChatStateTicket, loading: Boolean, hasMore: Boolean): ChatUiState =
        if (!ticket.matches(state)) state else state.copy(loadingOlder = loading, hasMoreOlder = hasMore)

    fun messages(state: ChatUiState, ticket: ChatStateTicket, rows: List<ChatRow>): ChatUiState {
        if (!ticket.matches(state)) return state
        val captured = rows.filter { it.id > 0 && it.conversationId == state.conversationId }
            .associateBy { it.id }.values.sortedBy { it.id }
        return if (captured == state.messages) state else state.copy(messages = immutable(captured))
    }

    fun outbox(state: ChatUiState, ticket: ChatStateTicket, rows: List<OutboxRow>): ChatUiState {
        if (!ticket.matches(state)) return state
        val captured = rows.filter { it.requestId.isNotBlank() && it.conversationId == state.conversationId }
            .associateBy { it.kind to it.requestId }.values.toList()
        return if (captured == state.outbox) state else state.copy(outbox = immutable(captured))
    }

    private fun <T> immutable(values: Collection<T>): List<T> =
        java.util.Collections.unmodifiableList(ArrayList(values))
}

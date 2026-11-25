package com.pulseim.android

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONObject
import kotlin.properties.ReadWriteProperty
import kotlin.reflect.KProperty

/** No Activity, View, Context or transport callbacks are retained here. */
internal class ChatViewModel : ViewModel() {
    private val lock = Any()
    @Volatile private var closed = false
    private val mutableState = MutableStateFlow(ChatUiState())
    val uiState: StateFlow<ChatUiState> = mutableState.asStateFlow()
    val messageData = ChatMessageMap<JSONObject>(lock,
        snapshot = { id, value -> ChatRow(id, value.optInt("conversation_id"), value.toString(), value.messageAuthority()) },
        accepts = { !closed && mutableState.value.account != null && it.conversationId == mutableState.value.conversationId },
        changed = { rows ->
            ChatStateReducer.ticket(mutableState.value)?.let { ticket ->
                mutableState.value = ChatStateReducer.messages(mutableState.value, ticket, rows)
            }
        })

    fun bindAccount(account: ChatAccount?) = synchronized(lock) {
        if (closed || mutableState.value.account == account) return@synchronized
        messageData.reset()
        mutableState.value = ChatStateReducer.bind(mutableState.value, account)
    }

    fun open(account: ChatAccount?, conversationId: Int, reopen: Boolean = false): ChatStateTicket? = synchronized(lock) {
        if (closed) return@synchronized null
        val bound = ChatStateReducer.bind(mutableState.value, account)
        val id = if (account == null) 0 else conversationId
        if (bound !== mutableState.value || reopen || bound.conversationId != id) {
            messageData.reset()
            mutableState.value = ChatStateReducer.open(bound, id)
        }
        ChatStateReducer.ticket(mutableState.value)
    }

    fun current(account: ChatAccount?, conversationId: Int): ChatUiState? = uiState.value.takeIf {
        !closed && account != null && it.account == account && conversationId > 0 && it.conversationId == conversationId
    }

    fun ticket(): ChatStateTicket? = synchronized(lock) {
        if (closed) null else ChatStateReducer.ticket(mutableState.value)
    }

    fun permission(ticket: ChatStateTicket?, allowed: Boolean, reason: String?) = change(ticket) {
        ChatStateReducer.permission(it, ticket!!, allowed, reason)
    }

    fun outbox(ticket: ChatStateTicket?, rows: List<OutboxRow>) = change(ticket) {
        ChatStateReducer.outbox(it, ticket!!, rows)
    }

    fun loadingOlder(ticket: ChatStateTicket?): ReadWriteProperty<Any?, Boolean> = historyProperty(ticket, true)
    fun hasMoreOlder(ticket: ChatStateTicket?): ReadWriteProperty<Any?, Boolean> = historyProperty(ticket, false)

    private fun historyProperty(ticket: ChatStateTicket?, loading: Boolean) = object : ReadWriteProperty<Any?, Boolean> {
        override fun getValue(thisRef: Any?, property: KProperty<*>): Boolean {
            val state = uiState.value
            return ticket?.matches(state) == true && if (loading) state.loadingOlder else state.hasMoreOlder
        }
        override fun setValue(thisRef: Any?, property: KProperty<*>, value: Boolean) {
            change(ticket) { state -> ChatStateReducer.history(state, ticket!!,
                if (loading) value else state.loadingOlder, if (loading) state.hasMoreOlder else value) }
        }
    }

    private inline fun change(ticket: ChatStateTicket?, reduce: (ChatUiState) -> ChatUiState): Boolean = synchronized(lock) {
        if (closed || ticket?.matches(mutableState.value) != true) return@synchronized false
        val previous = mutableState.value
        val next = reduce(previous)
        mutableState.value = next
        next != previous
    }

    override fun onCleared() {
        synchronized(lock) {
            closed = true
            messageData.reset()
            mutableState.value = ChatStateReducer.bind(mutableState.value, null)
        }
        super.onCleared()
    }

    object Factory : ViewModelProvider.Factory {
        override fun <T : ViewModel> create(modelClass: Class<T>): T {
            require(modelClass == ChatViewModel::class.java)
            @Suppress("UNCHECKED_CAST") return ChatViewModel() as T
        }
    }
}

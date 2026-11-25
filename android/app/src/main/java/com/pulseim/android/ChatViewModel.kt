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
    private var sendController: ChatSendController? = null
    private val capturedAttempts = mutableMapOf<String, ChatCapturedAttempt>()
    fun capturedAttempt(requestId: String): ChatCapturedAttempt = synchronized(lock) {
        check(!closed)
        capturedAttempts.getOrPut(requestId) { ChatCapturedAttempt() }
    }
    fun releaseCapturedAttempt(requestId: String, attempt: ChatCapturedAttempt) = synchronized(lock) {
        if (capturedAttempts[requestId] === attempt) capturedAttempts.remove(requestId)
    }
    private fun stopCapturedAttempts() {
        capturedAttempts.values.forEach { it.stop() }; capturedAttempts.clear()
    }
    fun sender(createPorts: () -> ChatSendPorts): ChatSendController {
        check(!closed)
        return sendController ?: ChatSendController(createPorts(), ::sendingChanged).also { sendController = it }
    }
    private fun sendingChanged() = synchronized(lock) {
        val sender = sendController ?: return@synchronized
        val state = mutableState.value
        if (closed || sender.gate.account != state.account) return@synchronized
        val ticket = ChatStateReducer.ticket(state)
        val next = if (ticket == null) state else ChatStateReducer.outbox(state, ticket, sender.rows(ticket.conversationId))
        mutableState.value = next.copy(sendRevision = state.sendRevision + 1)
    }
    private fun syncSender() {
        val state = mutableState.value
        sendController?.let { it.update(it.gate.copy(account = state.account,
            conversationId = state.conversationId, canSend = state.canSend)) }
    }
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
        stopCapturedAttempts()
        messageData.reset()
        mutableState.value = ChatStateReducer.bind(mutableState.value, account)
        syncSender()
    }

    fun open(account: ChatAccount?, conversationId: Int, reopen: Boolean = false): ChatStateTicket? = synchronized(lock) {
        if (closed) return@synchronized null
        val bound = ChatStateReducer.bind(mutableState.value, account)
        if (bound !== mutableState.value) stopCapturedAttempts()
        val id = if (account == null) 0 else conversationId
        if (bound !== mutableState.value || reopen || bound.conversationId != id) {
            messageData.reset()
            mutableState.value = ChatStateReducer.open(bound, id)
            syncSender()
        }
        ChatStateReducer.ticket(mutableState.value)
    }

    fun current(account: ChatAccount?, conversationId: Int): ChatUiState? = uiState.value.takeIf {
        !closed && account != null && it.account == account && conversationId > 0 && it.conversationId == conversationId
    }

    fun ticket(): ChatStateTicket? = synchronized(lock) {
        if (closed) null else ChatStateReducer.ticket(mutableState.value)
    }

    fun permission(ticket: ChatStateTicket?, allowed: Boolean, reason: String?): Boolean = change(ticket) {
        ChatStateReducer.permission(it, ticket!!, allowed, reason)
    }.also { if (it) syncSender() }

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
        sendController?.close()
        synchronized(lock) {
            closed = true
            stopCapturedAttempts()
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

package com.pulseim.android

internal enum class TextSendDecision { DEFER, FAIL, SEND }
internal object TextSendPolicy {
    class NotReady(message: String) : IllegalStateException(message)
    fun canSend(conversationId: Int, activeConversationId: Int, chatCanSend: Boolean): Boolean =
        conversationId != activeConversationId || chatCanSend
    fun decide(error: Exception?, chatCanSend: Boolean): TextSendDecision = when {
        error == null -> if (chatCanSend) TextSendDecision.SEND else TextSendDecision.DEFER
        error is NotReady || error is ClientApiException && error.errorCode == "stale_session" -> TextSendDecision.DEFER
        error is java.io.IOException || error is ClientApiException &&
            (error.status in listOf(408, 425, 429, 500, 502, 503, 504) || error.errorCode == "membership_changed") -> TextSendDecision.DEFER
        else -> TextSendDecision.FAIL
    }
}

package com.pulseim.android

/** A viewer-specific label; the shared message keeps the author's original name. */
internal data class ChatSenderLabel(val userId: Int, val fallback: String, val text: String) {
    fun matches(currentUserId: Any?, currentFallback: Any?, currentText: CharSequence?) =
        currentUserId == userId && currentFallback == fallback && currentText?.toString() == text

    companion object {
        fun resolve(userId: Int, name: Any?, nickname: Any?, resolveName: (Int, String) -> String): ChatSenderLabel {
            val fallback = sequenceOf(name, nickname).filterIsInstance<String>().map { it.trim() }
                .firstOrNull { it.isNotEmpty() && it != "null" } ?: "群成员"
            return ChatSenderLabel(userId, fallback, resolveName(userId, fallback))
        }
    }
}

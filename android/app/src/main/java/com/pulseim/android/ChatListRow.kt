package com.pulseim.android

internal enum class ChatRowKind { OLDER_LOADING, MESSAGE, PENDING_TEXT, PENDING_MEDIA }

/** Immutable content captured before AsyncListDiffer starts comparing a submission. */
internal data class ChatListRow(
    val kind: ChatRowKind, val id: Int = 0, val requestId: String = "",
    val version: String = "", val snapshot: String = ""
) {
    val key: String get() = when (kind) {
        ChatRowKind.OLDER_LOADING -> "older"
        ChatRowKind.MESSAGE -> "message:$id"
        ChatRowKind.PENDING_TEXT -> "pending-text:$requestId"
        ChatRowKind.PENDING_MEDIA -> "pending-media:$requestId"
    }
}

internal object ChatListRows {
    fun ordered(header: ChatListRow?, messages: List<ChatListRow>, pending: List<ChatListRow>): List<ChatListRow> = buildList {
        header?.let { add(it) }
        addAll(messages.filter { it.id > 0 }.associateBy { it.id }.values.sortedBy { it.id })
        addAll(pending.associateBy { it.key }.values)
    }
    fun sameItem(a: ChatListRow, b: ChatListRow) = a.key == b.key
    fun sameContent(a: ChatListRow, b: ChatListRow) = a.version == b.version && a.snapshot == b.snapshot
    fun anchorPosition(rows: List<ChatListRow>, key: String) = rows.indexOfFirst { it.key == key }
}

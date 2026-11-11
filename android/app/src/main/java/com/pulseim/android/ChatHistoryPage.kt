package com.pulseim.android

import org.json.JSONObject

/** A page is bounded; the cursor, rather than an offset, survives new messages. */
internal data class ChatHistoryPage(val items: List<JSONObject>, val hasMore: Boolean, val nextMaxId: Int) {
    companion object {
        fun parse(data: JSONObject, conversationId: Int, maxId: Int = 0): ChatHistoryPage {
            require(conversationId > 0 && maxId >= 0)
            val rows = data.getJSONArray("items")
            val items = (0 until rows.length()).map { rows.getJSONObject(it) }
            require(items.all { it.optInt("id") > 0 && it.optInt("conversation_id") == conversationId && (maxId == 0 || it.getInt("id") <= maxId) }) { "历史消息范围无效" }
            require(items.map { it.getInt("id") }.distinct().size == items.size) { "历史消息重复" }
            val oldest = items.minOfOrNull { it.getInt("id") } ?: 0
            val more = if (data.has("has_more")) data.getBoolean("has_more")
                else if (data.has("total")) data.getLong("total") > items.size
                else items.isNotEmpty()
            require(!more || items.isNotEmpty()) { "历史消息分页无效" }
            return ChatHistoryPage(items.sortedBy { it.getInt("id") }, more && oldest > 1, (oldest - 1).coerceAtLeast(0))
        }
    }
}

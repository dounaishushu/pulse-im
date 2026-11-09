package com.pulseim.android

import org.json.JSONArray
import org.json.JSONObject

/** Durable composer state. Mention identities are saved explicitly, never inferred from typed names. */
internal data class ChatDraft(
    val text: String,
    val selectionStart: Int = text.length,
    val selectionEnd: Int = selectionStart,
    val mentions: List<Mention> = emptyList(),
    val reply: JSONObject? = null
) {
    data class Mention(val userId: Int, val start: Int, val end: Int, val text: String)
    val empty: Boolean get() = text.isEmpty() && reply == null

    fun toJSON(): JSONObject {
        require(text.length <= MAX_TEXT)
        return JSONObject().put("version", 1).put("text", text)
            .put("selection_start", selectionStart.coerceIn(0, text.length))
            .put("selection_end", selectionEnd.coerceIn(0, text.length))
            .put("mentions", JSONArray(validMentions(text, mentions).map {
                JSONObject().put("user_id", it.userId).put("start", it.start).put("end", it.end).put("text", it.text)
            })).apply { cleanReply(reply)?.let { put("reply", it) } }
    }

    companion object {
        private const val MAX_TEXT = 200_000
        private fun space(value: Char) = value.isWhitespace() || Character.isSpaceChar(value)
        fun validMentions(text: String, values: List<Mention>): List<Mention> {
            val accepted = mutableListOf<Mention>()
            for (item in values.take(100)) {
                if (item.userId <= 0 || item.start < 0 || item.end <= item.start || item.end > text.length ||
                    !item.text.startsWith("@") || item.text.length < 2 || text.substring(item.start, item.end) != item.text ||
                    (item.start > 0 && !space(text[item.start - 1])) || (item.end < text.length && !space(text[item.end])) ||
                    accepted.any { item.start < it.end && item.end > it.start }) continue
                accepted.add(item)
            }
            return accepted
        }
        fun cleanReply(value: JSONObject?): JSONObject? {
            if (value == null || value.optInt("id") <= 0 || value.optBoolean("unavailable")) return null
            // Media grants and complete message bodies are not part of a draft.
            return JSONObject().put("id", value.getInt("id")).apply {
                for (field in listOf("sender_id", "sender_name", "type", "text")) {
                    if (value.has(field) && !value.isNull(field)) put(field, value.get(field))
                }
            }
        }
        fun fromJSON(value: JSONObject?): ChatDraft? {
            if (value == null || value.optInt("version") != 1 || value.opt("text") !is String) return null
            val text = value.getString("text")
            if (text.length > MAX_TEXT) return null
            val rows = value.optJSONArray("mentions") ?: JSONArray()
            val mentions = (0 until minOf(rows.length(), 100)).mapNotNull { index ->
                rows.optJSONObject(index)?.let { Mention(it.optInt("user_id"), it.optInt("start", -1), it.optInt("end", -1), it.optString("text")) }
            }
            return ChatDraft(text, value.optInt("selection_start", text.length).coerceIn(0, text.length),
                value.optInt("selection_end", text.length).coerceIn(0, text.length), validMentions(text, mentions), cleanReply(value.optJSONObject("reply")))
        }
    }
}

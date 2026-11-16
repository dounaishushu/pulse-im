package com.pulseim.android

import org.json.JSONObject

/** Shared conversation events and private deletions use independent cursors. */
internal data class ChatDeltaCursor(val events: Long, val personal: Long, val membership: String) {
    init { require(events >= 0 && personal >= 0 && membership.toLongOrNull()?.let { it > 0 } == true) }
    companion object {
        // A directory summary predates the history request. Using a later /open
        // response or the highest visible message event could skip concurrent sends.
        fun beforeHistory(info: JSONObject?): ChatDeltaCursor? = runCatching {
            require(info != null && info.has("event_seq"))
            ChatDeltaCursor(info.getString("event_seq").toLong(), info.optJSONObject("state")?.optString("personal_seq", "0")?.toLong() ?: 0,
                info.getString("membership_version"))
        }.getOrNull()
    }
}

internal data class ChatDelta(val items: List<JSONObject>, val removed: Set<Int>, val cleared: Int, val cursor: ChatDeltaCursor)

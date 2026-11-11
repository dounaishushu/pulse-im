package com.pulseim.android

import android.content.Context
import org.json.JSONObject

/** Only a previously verified account may open its local data during a network outage. */
internal object LocalSessionCache {
    fun save(context: Context, endpoint: String, user: JSONObject) {
        val scope = LocalAccountStore.scope(endpoint, user.getInt("id"))
        val record = JSONObject()
        for (field in listOf("id", "nickname", "username", "avatar_url", "public_id", "internal_staff")) {
            if (user.has(field)) record.put(field, user.get(field))
        }
        check(LocalAccountStore.write(context, LocalAccountStore.ticket(scope, "session-profile"), "snapshot", record))
    }

    fun read(context: Context, endpoint: String, userId: Int): JSONObject? {
        if (userId <= 0) return null
        val scope = LocalAccountStore.scope(endpoint, userId)
        return LocalAccountStore.read(context, LocalAccountStore.ticket(scope, "session-profile"))
            ?.takeIf { it.optInt("id") == userId }
    }
}

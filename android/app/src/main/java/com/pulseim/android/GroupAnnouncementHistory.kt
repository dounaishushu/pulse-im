package com.pulseim.android

import android.content.Context
import android.util.Base64
import java.security.MessageDigest

/** A durable, account/group scoped record. Never include the login token or notice text. */
internal class GroupAnnouncementHistory(context: Context, endpoint: String, actorId: Int, groupId: Int) {
    private val preferences = context.applicationContext.getSharedPreferences("pulse_group_announcement_history", Context.MODE_PRIVATE)
    private val key = if (actorId > 0 && groupId > 0 && endpoint.isNotBlank()) {
        val identity = "${endpoint.trim().trimEnd('/')}\u0000$actorId\u0000$groupId"
        "shown_v1_" + Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(identity.toByteArray(Charsets.UTF_8)), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    } else null
    private var presented = false

    fun wasPresented(): Boolean = key == null || presented || preferences.getBoolean(key, false)

    fun markPresented() {
        val record = key ?: return
        if (wasPresented()) return
        presented = true
        preferences.edit().putBoolean(record, true).apply()
    }
}

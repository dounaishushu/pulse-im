package com.pulseim.android

import org.json.JSONObject
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Server permission is authoritative; old servers retain their known restrictions. */
data class ChatSendPermission(val allowed: Boolean, val reason: String = "") {
    val hint: String get() = when (reason) {
        "group_muted", "member_muted", "account_muted" -> "已禁止发言"
        "channel_readonly" -> "仅频道所有者和管理员可以发布内容"
        "peer_unavailable" -> "对方的隐私设置或屏蔽关系限制了联系"
        "loading" -> "正在同步会话…"
        "inactive" -> "当前会话不可发送"
        else -> if (allowed) "输入消息" else "当前会话不可发送"
    }
    companion object {
        fun from(value: JSONObject?, type: String, localPending: Boolean = false, now: Long = System.currentTimeMillis()): ChatSendPermission {
            if (value?.has("can_send") == true && !value.isNull("can_send")) {
                val allowed = value.optBoolean("can_send", false)
                if (allowed && localPending) return ChatSendPermission(false, "loading")
                return ChatSendPermission(allowed, if (allowed) "" else value.optString("send_disabled_reason").takeUnless { it.isBlank() || it == "null" } ?: "inactive")
            }
            if (value?.optString("status") in listOf("inactive", "dissolved", "frozen") || value?.optString("frozen_at").orEmpty().let { it.isNotBlank() && it != "null" }) return ChatSendPermission(false, "inactive")
            if (type == "channel" && value?.optBoolean("can_publish", false) != true) return ChatSendPermission(false, "channel_readonly")
            if (type == "group" && value?.optBoolean("all_muted", false) == true && value.optString("my_role") !in listOf("owner", "admin")) return ChatSendPermission(false, "group_muted")
            val until = value?.optString("my_muted_until").orEmpty()
            if (until.isNotBlank() && until != "null") {
                val expires = runCatching { Instant.parse(until).toEpochMilli() }.getOrElse {
                    runCatching { LocalDateTime.parse(until.replace('T', ' '), DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")).atZone(ZoneId.of("Asia/Shanghai")).toInstant().toEpochMilli() }.getOrDefault(Long.MAX_VALUE)
                }
                if (expires > now) return ChatSendPermission(false, "member_muted")
            }
            return if (localPending) ChatSendPermission(false, "loading") else ChatSendPermission(true)
        }
    }
}

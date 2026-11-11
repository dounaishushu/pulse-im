package com.pulseim.android
import java.net.URI
import java.util.UUID
internal object ClientPolicy {
    fun secureEndpoint(value: String, websocket: Boolean = false, debug: Boolean = BuildConfig.DEBUG): Boolean = runCatching {
        val u = URI(value)
        u.host != null && (debug || publicHostname(u.host)) && u.userInfo == null && u.fragment == null &&
            u.scheme in (if (debug) (if (websocket) listOf("ws", "wss") else listOf("http", "https")) else (if (websocket) listOf("wss") else listOf("https")))
    }.getOrDefault(false)
    private fun publicHostname(value: String): Boolean {
        val host = value.lowercase()
        return host.contains('.') && !host.contains(':') && !Regex("[0-9.]+").matches(host) &&
            listOf("localhost", "local", "lan", "internal", "test", "invalid", "example", "example.com", "example.org", "example.net").none { host == it || host.endsWith(".$it") } &&
            host.split('.').all { Regex("[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?").matches(it) }
    }
    fun newer(remote: String, local: String): Boolean {
        fun parts(v: String) = v.removePrefix("v").split('.', '-').map { it.toIntOrNull() ?: 0 }
        val a = parts(remote); val b = parts(local)
        for (i in 0 until maxOf(a.size, b.size)) { val d = (a.getOrNull(i) ?: 0) - (b.getOrNull(i) ?: 0); if (d != 0) return d > 0 }
        return false
    }
}
internal data class SendTarget(val conversationId: Int, val userId: Int, val token: String, val requestId: String = "android-${UUID.randomUUID()}", val replyToId: Int = 0, val replyRevision: Long = 0) {
    fun matches(conversation: Int, user: Int, session: String?) = conversationId == conversation && userId == user && token == session
}

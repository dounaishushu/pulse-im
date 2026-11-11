package com.pulseim.android

/** Public identity stays a case-sensitive string; all relationship keys remain integers. */
internal object PublicUserId {
    sealed class FriendTarget {
        data class Public(val id: String) : FriendTarget()
        data class Legacy(val id: Int) : FriendTarget()
    }
    private val format = Regex("[A-Za-z0-9]{16}")
    fun value(raw: Any?): String? = (raw as? String)?.takeIf { candidate ->
        format.matches(candidate) && candidate.any { it in 'A'..'Z' } &&
            candidate.any { it in 'a'..'z' } && candidate.any { it in '0'..'9' }
    }
    fun display(raw: Any?): String = value(raw) ?: "未就绪"
    fun friendQr(raw: Any?): String? = value(raw)?.let { "pulse://add-friend?public_id=$it" }
    fun matches(raw: Any?, keyword: String): Boolean = value(raw)?.contains(keyword) == true
    fun scanned(publicValues: List<String>?, legacyUserId: String?): FriendTarget? {
        // Presence, including an empty or repeated parameter, forbids legacy fallback.
        if (publicValues != null) return value(publicValues.singleOrNull())?.let { FriendTarget.Public(it) }
        return legacyUserId?.toIntOrNull()?.takeIf { it > 0 }?.let { FriendTarget.Legacy(it) }
    }
}

package com.pulseim.android

/** P2 automatic retry budget, independent of transport and encrypted queue formats. */
internal object ChatRetryPolicy {
    const val MAX_RETRIES = 5

    /** attempt=1 is the initial request; up to five further requests may follow. */
    fun retryDelayMs(attempt: Long, random: Double): Long? {
        require(attempt > 0)
        require(random.isFinite() && random in 0.0..1.0)
        if (attempt > MAX_RETRIES) return null
        val base = minOf(30_000L, 1_000L shl (attempt - 1).toInt())
        return (base * (0.5 + random * 0.5)).toLong()
    }
}

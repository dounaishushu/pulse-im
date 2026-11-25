package com.pulseim.android

/** State for legacy captured actions; UI callbacks and transport stay outside the model. */
internal class ChatCapturedAttempt(private val random: () -> Double = { kotlin.random.Random.nextDouble() }) {
    private val state = SendAttemptState()
    private var budgetAttempt = 0L
    @Synchronized fun begin(): Int { budgetAttempt++; return state.begin() }
    fun current(attempt: Int) = state.current(attempt)
    fun acknowledge() = state.acknowledge()
    fun stop() = state.stop()
    fun settle() = state.settle()
    @Synchronized fun retryDelay(attempt: Int): Long? =
        if (state.current(attempt)) ChatRetryPolicy.retryDelayMs(budgetAttempt, random()) else null
    @Synchronized fun manualRetry() { budgetAttempt = 0 }
}

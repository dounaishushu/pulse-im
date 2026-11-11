package com.pulseim.android

/** HTTP retries and realtime acknowledgements share one completion authority. */
internal class SendAttemptState {
    private var generation = 0
    private var stopped = false
    private var acknowledged = false
    private var settled = false

    @Synchronized fun begin(): Int {
        check(!acknowledged) { "A confirmed message cannot be sent again" }
        stopped = false
        return ++generation
    }
    @Synchronized fun current(attempt: Int): Boolean = !acknowledged && !stopped && attempt == generation
    @Synchronized fun acknowledge(): Boolean {
        if (acknowledged) return false
        acknowledged = true; stopped = true
        return true
    }
    @Synchronized fun stop() { stopped = true }
    @Synchronized fun settle(): Boolean {
        if (settled) return false
        settled = true
        return true
    }
}

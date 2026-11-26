package com.pulseim.android

/** Keep one realtime owner across Activity instances, including a pause to the home screen. */
internal class RealtimeOwner<T : Any> {
    private var owner: T? = null

    /** The caller closes the displaced owner's connection before opening its own. */
    @Synchronized fun claim(next: T): T? {
        if (owner === next) return null
        val previous = owner
        owner = next
        return previous
    }

    @Synchronized fun owns(candidate: T): Boolean = owner === candidate

    /** An old Activity can be destroyed after the replacement has already resumed. */
    @Synchronized fun release(candidate: T) {
        if (owner === candidate) owner = null
    }
}

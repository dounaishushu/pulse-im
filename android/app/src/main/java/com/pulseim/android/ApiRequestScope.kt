package com.pulseim.android

import okhttp3.Call
import java.io.InterruptedIOException

/** Cancels only the reads/open operation belonging to one chat navigation. */
internal class ApiRequestScope {
    private val calls = mutableSetOf<Call>()
    @Volatile var cancelled = false; private set
    fun checkActive() { if (cancelled) throw InterruptedIOException("Chat navigation cancelled") }
    fun track(call: Call) {
        synchronized(calls) { if (cancelled) call.cancel() else calls.add(call) }
        checkActive()
    }
    fun release(call: Call) { synchronized(calls) { calls.remove(call) } }
    fun cancel() {
        val pending = synchronized(calls) { cancelled = true; calls.toList().also { calls.clear() } }
        pending.forEach { it.cancel() }
    }
}

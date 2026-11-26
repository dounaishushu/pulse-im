package com.pulseim.android

import java.util.concurrent.TimeoutException

internal data class PushAccount(val base: String, val userId: Int, val token: String) {
    override fun toString() = "PushAccount(userId=$userId)"
}

internal interface PushRegistrationPorts {
    fun account(): PushAccount?
    fun execute(task: () -> Unit)
    fun schedule(delayMs: Long, task: () -> Unit): () -> Unit
    fun obtainToken(received: (String) -> Unit, failed: (Throwable) -> Unit)
    fun saveToken(value: String)
    fun register(account: PushAccount, deviceToken: String)
    fun retryable(error: Throwable): Boolean
    fun fault(error: Throwable)
    fun now(): Long
}

/** Owns only FCM registration. All mutable state stays on the supplied serial worker. */
internal class PushRegistration(private val ports: PushRegistrationPorts) {
    private var owner: PushAccount? = null
    private var generation = 0L
    private var busy = false
    private var registeredToken: String? = null
    private var registeredAt = 0L
    private var cancelWakeup: (() -> Unit)? = null

    fun bind() = ports.execute {
        val account = ports.account()
        if (account == null) { reset(); return@execute }
        if (owner == account && (busy || registeredToken != null && ports.now() - registeredAt in 0 until REFRESH_MS)) return@execute
        reset(); owner = account
        attempt(account, null, 0)
    }

    fun tokenChanged(value: String) = ports.execute {
        val account = ports.account() ?: return@execute
        if (owner == account && value == registeredToken && ports.now() - registeredAt in 0 until REFRESH_MS) return@execute
        reset(); owner = account
        attempt(account, value, 0)
    }

    fun stop() = ports.execute { reset() }

    private fun reset() {
        generation++; cancelWakeup?.invoke(); cancelWakeup = null
        owner = null; busy = false; registeredToken = null; registeredAt = 0
    }

    private fun current(ticket: Long, account: PushAccount) =
        ticket == generation && owner == account && ports.account() == account

    private fun attempt(account: PushAccount, deviceToken: String?, retry: Int) {
        if (ports.account() != account) { reset(); return }
        cancelWakeup?.invoke(); cancelWakeup = null
        val ticket = ++generation; busy = true
        if (deviceToken != null) { register(ticket, account, deviceToken, retry); return }
        cancelWakeup = ports.schedule(20_000) {
            ports.execute {
                if (current(ticket, account)) failed(ticket, account, null, retry, TimeoutException("FCM token acquisition timed out"))
            }
        }
        try {
            ports.obtainToken({ value ->
                ports.execute {
                    if (current(ticket, account)) {
                        cancelWakeup?.invoke(); cancelWakeup = null
                        register(ticket, account, value, retry)
                    }
                }
            }, { error -> ports.execute { if (current(ticket, account)) failed(ticket, account, null, retry, error) } })
        } catch (error: Exception) {
            if (current(ticket, account)) failed(ticket, account, null, retry, error)
        }
    }

    private fun register(ticket: Long, account: PushAccount, deviceToken: String, retry: Int) {
        if (!current(ticket, account)) return
        if (deviceToken.length !in 16..4096 || deviceToken.any { it.isWhitespace() }) {
            busy = false; generation++
            ports.fault(IllegalArgumentException("Invalid FCM registration token")); return
        }
        try {
            ports.saveToken(deviceToken)
            if (!current(ticket, account)) return
            ports.register(account, deviceToken)
            if (current(ticket, account)) {
                busy = false; registeredToken = deviceToken; registeredAt = ports.now()
                cancelWakeup?.invoke(); cancelWakeup = null
            }
        } catch (error: Exception) {
            if (current(ticket, account)) failed(ticket, account, deviceToken, retry, error)
        }
    }

    private fun failed(ticket: Long, account: PushAccount, deviceToken: String?, retry: Int, error: Throwable) {
        if (!current(ticket, account)) return
        cancelWakeup?.invoke(); cancelWakeup = null
        generation++; busy = false; ports.fault(error)
        if (retry >= 5 || !ports.retryable(error)) return
        val retryTicket = generation; busy = true
        cancelWakeup = ports.schedule(1000L shl retry) {
            ports.execute { if (current(retryTicket, account)) attempt(account, deviceToken, retry + 1) }
        }
    }

    companion object { private const val REFRESH_MS = 86_400_000L }
}

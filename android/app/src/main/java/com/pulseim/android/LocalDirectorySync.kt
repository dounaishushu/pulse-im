package com.pulseim.android

import android.content.Context
import org.json.JSONObject
import java.util.concurrent.Executor

/** Fetch every page off the UI thread; only a fully validated generation replaces the saved directory. */
internal class LocalDirectorySync(
    context: Context,
    private val executor: Executor,
    private val current: () -> Account?,
    private val fetch: (Account, LocalDirectoryStore.Kind, Int) -> JSONObject,
    private val completed: (Account, LocalDirectoryStore.Kind, LocalDirectoryStore.Snapshot) -> Unit = { _, _, _ -> },
    private val failed: (Account, LocalDirectoryStore.Kind, Throwable) -> Unit = { _, _, _ -> },
    private val now: () -> Long = { android.os.SystemClock.elapsedRealtime() },
    private val started: (Account, LocalDirectoryStore.Kind, LocalAccountStore.Ticket) -> Unit = { _, _, _ -> },
    private val startOn: ((() -> Unit) -> Unit) = { it() }
) {
    data class Account(val endpoint: String, val userId: Int, val token: String) {
        val scope: String get() = LocalAccountStore.scope(endpoint, userId)
    }
    private data class Flight(val account: Account, val kind: LocalDirectoryStore.Kind, val ticket: LocalAccountStore.Ticket, var again: Boolean = false)
    private val app = context.applicationContext
    private val flights = mutableMapOf<Pair<String, LocalDirectoryStore.Kind>, Flight>()
    private val next = mutableMapOf<Pair<String, LocalDirectoryStore.Kind>, Long>()
    private fun valid(flight: Flight): Boolean = current() == flight.account && LocalAccountStore.current(flight.ticket)
    @Synchronized fun refresh(force: Boolean = false, kinds: Set<LocalDirectoryStore.Kind> = LocalDirectoryStore.Kind.values().toSet()) {
        val account = current()?.takeIf { it.userId > 0 && it.token.isNotEmpty() } ?: return
        for (kind in kinds) {
            val key = account.scope to kind
            val previous = flights[key]
            if (previous != null && previous.account == account) { if (force) previous.again = true; continue }
            if (!force && now() < (next[key] ?: 0L)) continue
            val flight = Flight(account, kind, LocalDirectoryStore.begin(account.scope, kind)); flights[key] = flight
            startOn {
                if (valid(flight)) {
                    try { started(account, kind, flight.ticket); executor.execute { run(flight) } }
                    catch (error: Throwable) { synchronized(this) { if (flights[key] === flight) { flights.remove(key); next[key] = now() + 5000 } }; failed(account, kind, error) }
                } else synchronized(this) { if (flights[key] === flight) flights.remove(key) }
            }
        }
    }
    private fun run(flight: Flight) {
        var success = false
        try {
            val refresh = LocalDirectoryStore.Refresh(flight.ticket, flight.kind)
            while (!refresh.done) {
                if (!valid(flight)) return
                val result = fetch(flight.account, flight.kind, refresh.nextPage)
                if (!valid(flight)) return
                refresh.append(result)
            }
            val snapshot = refresh.snapshot()
            if (!valid(flight)) return
            success = LocalDirectoryStore.replace(app, flight.ticket, flight.kind, snapshot)
            if (success && valid(flight)) completed(flight.account, flight.kind, snapshot.copy(requestTicket = flight.ticket))
        } catch (error: Throwable) {
            if (valid(flight)) failed(flight.account, flight.kind, error)
        } finally {
            synchronized(this) {
                val key = flight.account.scope to flight.kind
                if (flights[key] === flight) {
                    flights.remove(key); next[key] = now() + if (success) 30_000 else 5_000
                    if (flight.again && current() == flight.account) refresh(true, setOf(flight.kind))
                }
            }
        }
    }
    @Synchronized fun stop() {
        flights.values.forEach { if (LocalAccountStore.current(it.ticket)) LocalAccountStore.invalidate(it.ticket.scope, it.ticket.namespace) }
        flights.clear(); next.clear()
    }
}

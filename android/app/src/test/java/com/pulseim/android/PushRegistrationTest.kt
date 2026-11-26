package com.pulseim.android

import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.util.ArrayDeque

class PushRegistrationTest {
    private val first = PushAccount("https://one.invalid/api/v2", 11, "session-a")
    private val token = "fcm-device-token-aaaaaaaaaaaaaaaa"
    private class Permanent : IllegalStateException()
    private class Fixture(account: PushAccount?) : PushRegistrationPorts {
        var active = account
        var time = 100L
        val work = ArrayDeque<() -> Unit>()
        data class Timer(val delay: Long, val task: () -> Unit, var cancelled: Boolean = false)
        val timers = mutableListOf<Timer>()
        val requests = mutableListOf<Pair<(String) -> Unit, (Throwable) -> Unit>>()
        val calls = mutableListOf<Pair<PushAccount, String>>()
        val saved = mutableListOf<String>()
        val failures = mutableListOf<Throwable>()
        var registrationError: Exception? = null
        var duringRegister: (() -> Unit)? = null
        override fun account() = active
        override fun execute(task: () -> Unit) { work.add(task) }
        override fun schedule(delayMs: Long, task: () -> Unit): () -> Unit {
            val timer = Timer(delayMs, task); timers.add(timer); return { timer.cancelled = true }
        }
        override fun obtainToken(received: (String) -> Unit, failed: (Throwable) -> Unit) { requests.add(received to failed) }
        override fun saveToken(value: String) { saved.add(value) }
        override fun register(account: PushAccount, deviceToken: String) {
            calls.add(account to deviceToken); duringRegister?.invoke(); registrationError?.let { throw it }
        }
        override fun retryable(error: Throwable) = error !is Permanent
        override fun fault(error: Throwable) { failures.add(error) }
        override fun now() = time
        fun drain() { while (work.isNotEmpty()) work.removeFirst().invoke() }
        fun wake() { val timer = timers.first { !it.cancelled }; timer.cancelled = true; time += timer.delay; timer.task(); drain() }
        fun success(value: String, index: Int = requests.lastIndex) { requests[index].first(value); drain() }
    }

    @Test fun signedOutDoesNotAcquireOrRegisterAToken() {
        val f = Fixture(null); val p = PushRegistration(f)
        p.bind(); p.tokenChanged(token); f.drain()
        assertTrue(f.requests.isEmpty()); assertTrue(f.calls.isEmpty()); assertTrue(f.saved.isEmpty())
    }
    @Test fun registersTheScopedGoAccountAndCoalescesReconnects() {
        val f = Fixture(first); val p = PushRegistration(f)
        p.bind(); p.bind(); f.drain(); assertEquals(1, f.requests.size)
        f.success(token); p.bind(); f.drain()
        assertEquals(listOf(first to token), f.calls); assertEquals(listOf(token), f.saved)
        assertTrue(f.timers.all { it.cancelled })
    }
    @Test fun tokenCallbackForThePreviousAccountCannotBindToTheNewAccount() {
        val f = Fixture(first); val p = PushRegistration(f)
        p.bind(); f.drain(); f.active = first.copy(userId = 12, token = "session-b"); p.bind(); f.drain()
        f.success(token, 0); assertTrue(f.calls.isEmpty()); assertTrue(f.saved.isEmpty())
        f.success(token, 1); assertEquals(f.active, f.calls.single().first)
    }
    @Test fun endpointAndSessionChangesInvalidateCallbacksEvenForTheSameUser() {
        for (next in listOf(first.copy(base = "https://two.invalid/api/v2"), first.copy(token = "renewed"))) {
            val f = Fixture(first); val p = PushRegistration(f); p.bind(); f.drain()
            f.active = next; f.success(token); assertTrue(f.calls.isEmpty())
            p.bind(); f.drain(); f.success(token); assertEquals(next, f.calls.single().first)
        }
    }
    @Test fun logoutDiscardsTheLateFirebaseCallbackAndCancelsItsWatchdog() {
        val f = Fixture(first); val p = PushRegistration(f); p.bind(); f.drain()
        f.active = null; p.stop(); f.drain(); f.success(token)
        assertTrue(f.calls.isEmpty()); assertTrue(f.saved.isEmpty()); assertTrue(f.timers.all { it.cancelled })
    }
    @Test fun refreshedTokenWinsOverAnOlderOutstandingGetTokenResult() {
        val f = Fixture(first); val p = PushRegistration(f); p.bind(); f.drain()
        val fresh = token + "new"; p.tokenChanged(fresh); f.drain(); f.success(token, 0)
        assertEquals(listOf(first to fresh), f.calls); assertEquals(listOf(fresh), f.saved)
    }
    @Test fun transientRegistrationFailureRetriesWithoutRequestingAnotherDeviceToken() {
        val f = Fixture(first); val p = PushRegistration(f); f.registrationError = IOException()
        p.bind(); f.drain(); f.success(token)
        assertEquals(1000L, f.timers.last().delay)
        f.registrationError = null; f.wake()
        assertEquals(2, f.calls.size); assertEquals(1, f.requests.size); assertTrue(f.timers.all { it.cancelled })
    }
    @Test fun onlyFiveAutomaticRetriesAreScheduled() {
        val f = Fixture(first); val p = PushRegistration(f); f.registrationError = IOException()
        p.tokenChanged(token); f.drain(); repeat(5) { f.wake() }
        assertEquals(6, f.calls.size); assertEquals(listOf(1000L, 2000L, 4000L, 8000L, 16000L), f.timers.map { it.delay })
        assertTrue(f.timers.all { it.cancelled }); assertEquals(6, f.failures.size)
    }
    @Test fun permanentRegistrationFailureDoesNotRetry() {
        val f = Fixture(first); val p = PushRegistration(f); f.registrationError = Permanent()
        p.tokenChanged(token); f.drain(); assertEquals(1, f.calls.size); assertTrue(f.timers.isEmpty())
    }
    @Test fun tokenAcquisitionFailureRetriesAndThenRegisters() {
        val f = Fixture(first); val p = PushRegistration(f); p.bind(); f.drain()
        f.requests.single().second(IOException()); f.drain(); f.wake(); f.success(token)
        assertEquals(2, f.requests.size); assertEquals(1, f.calls.size)
    }
    @Test fun tokenAcquisitionTimeoutRetriesAndRejectsTheLateResult() {
        val f = Fixture(first); val p = PushRegistration(f); p.bind(); f.drain()
        assertEquals(20_000L, f.timers.single().delay); f.wake(); f.success(token, 0)
        assertTrue(f.calls.isEmpty()); f.wake(); f.success(token, 1); assertEquals(1, f.calls.size)
    }
    @Test fun accountSwitchCancelsAnAlreadyScheduledRegistrationRetry() {
        val f = Fixture(first); val p = PushRegistration(f); f.registrationError = IOException()
        p.tokenChanged(token); f.drain(); val oldTimer = f.timers.single()
        f.active = first.copy(userId = 12); p.bind(); f.drain()
        oldTimer.task(); f.drain(); assertEquals(1, f.calls.size); assertTrue(oldTimer.cancelled)
        f.registrationError = null; f.success(token); assertEquals(12, f.calls.last().first.userId)
    }
    @Test fun accountChangingDuringAnInflightRegistrationIsNotRememberedAsSuccessful() {
        val f = Fixture(first); val p = PushRegistration(f)
        f.duringRegister = { f.active = first.copy(token = "session-b") }
        p.tokenChanged(token); f.drain(); f.duringRegister = null; p.bind(); f.drain(); f.success(token)
        assertEquals(2, f.calls.size); assertEquals("session-b", f.calls.last().first.token)
    }
    @Test fun successfulBindingsRefreshAfterOneDayAndAfterClockRegression() {
        for (clock in listOf(86_400_101L, 0L)) {
            val f = Fixture(first); val p = PushRegistration(f); p.tokenChanged(token); f.drain()
            f.time = clock; p.bind(); f.drain(); f.success(token); assertEquals(2, f.calls.size)
        }
    }
    @Test fun malformedDeviceTokensAreNotStoredRegisteredOrRetried() {
        for (bad in listOf("", "short", token + "\n", "x".repeat(4097))) {
            val f = Fixture(first); val p = PushRegistration(f); p.tokenChanged(bad); f.drain()
            assertTrue(f.calls.isEmpty()); assertTrue(f.saved.isEmpty()); assertTrue(f.timers.isEmpty()); assertEquals(1, f.failures.size)
        }
    }
    @Test fun accountDiagnosticTextNeverContainsTheAuthenticationToken() {
        assertFalse(first.toString().contains(first.token)); assertFalse(first.toString().contains(first.base))
    }
}

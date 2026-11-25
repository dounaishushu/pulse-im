package com.pulseim.android

import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import org.junit.Assert.*
import org.junit.Test

class ChatCapturedAttemptTest {
    @Test fun automaticRetryStopsAfterFiveAndManualRetryStartsANewBudget() {
        val attempt = ChatCapturedAttempt { 0.0 }
        assertEquals(listOf(500L, 1000L, 2000L, 4000L, 8000L, null), (1..6).map { attempt.retryDelay(attempt.begin()) })
        attempt.manualRetry(); assertEquals(500L, attempt.retryDelay(attempt.begin()))
    }
    @Test fun acknowledgedOrSupersededAttemptsCannotScheduleAnotherRetry() {
        val attempt = ChatCapturedAttempt { 0.0 }; val old = attempt.begin(); val current = attempt.begin()
        assertNull(attempt.retryDelay(old)); assertTrue(attempt.acknowledge()); assertNull(attempt.retryDelay(current))
    }
    @Test fun theViewModelOwnsCapturedStateAndAccountChangesStopIt() {
        val model = ChatViewModel(); val account = ChatAccount("https://example.test", 1, "token")
        model.bindAccount(account); val state = model.capturedAttempt("r"); val generation = state.begin()
        assertSame(state, model.capturedAttempt("r")); model.bindAccount(account.copy(token = "changed"))
        assertFalse(state.current(generation)); assertNotSame(state, model.capturedAttempt("r"))
    }
    @Test fun permanentModelDestructionStopsTheCapturedState() {
        val store = ViewModelStore(); val model = ViewModelProvider(store, ChatViewModel.Factory)[ChatViewModel::class.java]
        val state = model.capturedAttempt("r"); val generation = state.begin(); store.clear()
        assertFalse(state.current(generation))
    }
}

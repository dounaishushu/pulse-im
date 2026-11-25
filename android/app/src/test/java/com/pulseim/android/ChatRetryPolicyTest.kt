package com.pulseim.android

import org.junit.Assert.*
import org.junit.Test

class ChatRetryPolicyTest {
    @Test fun jitterCoversDocumentedHalfToFullExponentialDelay() {
        for (attempt in 1L..5L) {
            val base = 1_000L shl (attempt - 1).toInt()
            assertEquals(base / 2, ChatRetryPolicy.retryDelayMs(attempt, 0.0))
            assertEquals(base, ChatRetryPolicy.retryDelayMs(attempt, 1.0))
            assertEquals(base * 3 / 4, ChatRetryPolicy.retryDelayMs(attempt, 0.5))
        }
    }
    @Test fun fiveRetriesAreAllowedAndTheNextFailureStopsAutomaticWork() {
        assertNotNull(ChatRetryPolicy.retryDelayMs(5, 0.5))
        assertNull(ChatRetryPolicy.retryDelayMs(6, 0.5))
    }
    @Test fun restoredLargeAttemptCounterDoesNotOverflowShiftOrRestartBudget() {
        assertNull(ChatRetryPolicy.retryDelayMs(Long.MAX_VALUE, 0.5))
    }
    @Test(expected = IllegalArgumentException::class) fun invalidInitialAttemptIsRejected() {
        ChatRetryPolicy.retryDelayMs(0, 0.5)
    }
    @Test(expected = IllegalArgumentException::class) fun nonFiniteRandomIsRejected() {
        ChatRetryPolicy.retryDelayMs(1, Double.NaN)
    }
    @Test(expected = IllegalArgumentException::class) fun negativeRandomIsRejected() {
        ChatRetryPolicy.retryDelayMs(1, -0.1)
    }
    @Test(expected = IllegalArgumentException::class) fun outOfRangeRandomIsRejected() {
        ChatRetryPolicy.retryDelayMs(1, 1.1)
    }
}

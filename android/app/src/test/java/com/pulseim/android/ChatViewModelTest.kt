package com.pulseim.android

import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class ChatViewModelTest {
    private val account = ChatAccount("https://a.example/api/v2", 1, "token")
    private fun opened() = ChatViewModel().apply { open(account, 10) }

    @Test fun providerReturnsTheSameViewModelUntilTheStoreIsCleared() {
        val store = ViewModelStore()
        val first = ViewModelProvider(store, ChatViewModel.Factory)[ChatViewModel::class.java]
        val second = ViewModelProvider(store, ChatViewModel.Factory)[ChatViewModel::class.java]
        assertSame(first, second)
        store.clear()
        assertNotSame(first, ViewModelProvider(store, ChatViewModel.Factory)[ChatViewModel::class.java])
    }
    @Test fun permissionUsesReadOnlyStateFlowAndRequiresAnActiveTicket() {
        val model = opened(); val ticket = model.ticket()!!
        assertFalse(model.uiState.value.canSend)
        assertTrue(model.permission(ticket, true, ""))
        assertTrue(model.current(account, 10)!!.canSend)
        assertFalse(model.permission(ticket, true, ""))
        assertNull(model.current(account.copy(token = "changed"), 10))
        assertNull(model.current(account, 20))
    }
    @Test fun staleConversationCallbackCannotChangePermissionOrOutbox() {
        val model = opened(); val old = model.ticket()!!
        model.open(account, 20); model.open(account, 10)
        assertFalse(model.permission(old, true, "stale"))
        assertFalse(model.outbox(old, listOf(OutboxRow("r", 10, "text", "FAILED"))))
        assertFalse(model.uiState.value.canSend); assertTrue(model.uiState.value.outbox.isEmpty())
    }
    @Test fun sameOwnerAndConversationPreserveTicketUnlessExplicitlyReopened() {
        val model = opened(); val first = model.ticket()
        assertEquals(first, model.open(account, 10))
        assertNotEquals(first, model.open(account, 10, reopen = true))
    }
    @Test fun accountRebindingClearsStateAndInvalidatesOldTickets() {
        val model = opened(); val old = model.ticket()!!
        model.permission(old, true, "")
        model.bindAccount(account.copy(token = "new-token"))
        assertEquals(0, model.uiState.value.conversationId)
        assertFalse(model.permission(old, true, "")); assertFalse(model.uiState.value.canSend)
    }
    @Test fun historyDelegatesUseOneStateAndIgnoreThePreviousEntry() {
        val model = opened(); val ticket = model.ticket()
        var loading by model.loadingOlder(ticket)
        var more by model.hasMoreOlder(ticket)
        assertFalse(loading); assertTrue(more)
        loading = true; more = false
        assertTrue(model.uiState.value.loadingOlder); assertFalse(model.uiState.value.hasMoreOlder)
        model.open(account, 20)
        loading = true; more = false
        assertFalse(loading); assertFalse(more)
        assertFalse(model.uiState.value.loadingOlder); assertTrue(model.uiState.value.hasMoreOlder)
    }
    @Test fun clearingStoreRejectsLateCallbacksAndCannotResurrectAnAccount() {
        val store = ViewModelStore()
        val model = ViewModelProvider(store, ChatViewModel.Factory)[ChatViewModel::class.java]
        val ticket = model.open(account, 10)!!; store.clear()
        assertNull(model.open(account, 10)); assertNull(model.ticket())
        assertFalse(model.permission(ticket, true, "")); model.bindAccount(account)
        assertNull(model.uiState.value.account)
    }
    @Test fun outboxIsCapturedWithoutPublishingTheWorkersMutableList() {
        val model = opened(); val rows = mutableListOf(OutboxRow("r", 10, "text", "SENDING"))
        model.outbox(model.ticket(), rows); rows.clear()
        assertEquals("SENDING", model.uiState.value.outbox.single().phase)
    }
    @Test fun concurrentUpdatesPreserveIndependentHistoryAndPermissionChanges() {
        val model = opened(); val ticket = model.ticket(); val gate = CountDownLatch(1)
        val workers = Executors.newFixedThreadPool(2)
        try {
            val permission = workers.submit { gate.await(); model.permission(ticket, true, "ready") }
            val history = workers.submit { gate.await(); var loading by model.loadingOlder(ticket); loading = true }
            gate.countDown(); permission.get(2, TimeUnit.SECONDS); history.get(2, TimeUnit.SECONDS)
            assertTrue(model.uiState.value.canSend); assertTrue(model.uiState.value.loadingOlder)
        } finally { workers.shutdownNow() }
    }
}

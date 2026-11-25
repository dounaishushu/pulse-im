package com.pulseim.android

import org.junit.Assert.*
import org.junit.Test

class ChatUiStateTest {
    private val alice = ChatAccount("https://a.example/api/v2", 1, "alice-token")
    private val bob = ChatAccount("https://a.example/api/v2", 2, "bob-token")
    private fun opened() = ChatStateReducer.open(ChatStateReducer.bind(ChatUiState(), alice), 10)
    private fun row(id: Int, conversationId: Int = 10) = ChatRow(id, conversationId, "payload-$id")

    @Test fun initialAndNewConversationDoNotAssumeSendPermission() {
        assertFalse(ChatUiState().canSend)
        assertFalse(opened().canSend)
    }
    @Test fun bindingSameIdentityPreservesStateAndTicket() {
        val current = opened()
        assertSame(current, ChatStateReducer.bind(current, alice.copy()))
    }
    @Test fun accountSwitchClearsAllPrivateState() {
        var current = opened()
        val ticket = ChatStateReducer.ticket(current)!!
        current = ChatStateReducer.permission(current, ticket, true, "ready")
        current = ChatStateReducer.messages(current, ticket, listOf(row(1)))
        current = ChatStateReducer.outbox(current, ticket, listOf(OutboxRow("r", 10, "text", "QUEUED")))
        current = ChatStateReducer.history(current, ticket, true, false)
        val next = ChatStateReducer.bind(current, bob)
        assertEquals(0, next.conversationId)
        assertTrue(next.messages.isEmpty()); assertTrue(next.outbox.isEmpty())
        assertFalse(next.canSend); assertNull(next.canSendReason); assertFalse(next.loadingOlder)
        assertTrue(next.hasMoreOlder); assertFalse(ticket.matches(next))
    }
    @Test fun tokenAndEndpointChangesInvalidateTickets() {
        val current = opened(); val ticket = ChatStateReducer.ticket(current)!!
        assertFalse(ticket.matches(ChatStateReducer.bind(current, alice.copy(token = "new-token"))))
        assertFalse(ticket.matches(ChatStateReducer.bind(current, alice.copy(endpoint = "https://b.example/api/v2"))))
    }
    @Test fun switchingAccountAwayAndBackRejectsOriginalCallback() {
        val current = opened(); val ticket = ChatStateReducer.ticket(current)!!
        val returned = ChatStateReducer.open(ChatStateReducer.bind(ChatStateReducer.bind(current, bob), alice), 10)
        assertFalse(ticket.matches(returned))
        assertSame(returned, ChatStateReducer.messages(returned, ticket, listOf(row(1))))
    }
    @Test fun switchingConversationAwayAndBackRejectsOriginalCallback() {
        val current = opened(); val ticket = ChatStateReducer.ticket(current)!!
        val returned = ChatStateReducer.open(ChatStateReducer.open(current, 20), 10)
        assertFalse(ticket.matches(returned))
        assertSame(returned, ChatStateReducer.permission(returned, ticket, true, null))
    }
    @Test fun reopeningSameConversationInvalidatesInFlightHistory() {
        val current = opened(); val ticket = ChatStateReducer.ticket(current)!!
        val next = ChatStateReducer.open(current, 10)
        assertFalse(ticket.matches(next))
        assertSame(next, ChatStateReducer.history(next, ticket, true, false))
    }
    @Test fun closingConversationAndLogoutRemoveTickets() {
        val current = opened()
        assertNull(ChatStateReducer.ticket(ChatStateReducer.open(current, 0)))
        assertNull(ChatStateReducer.ticket(ChatStateReducer.bind(current, null)))
    }
    @Test fun rowsAreOrderedDeduplicatedAndRestrictedToCurrentConversation() {
        val current = opened(); val ticket = ChatStateReducer.ticket(current)!!
        val rows = listOf(row(3), row(1), row(3).copy(version = "edit"), row(2, 20), row(0))
        val next = ChatStateReducer.messages(current, ticket, rows)
        assertEquals(listOf(1, 3), next.messages.map { it.id })
        assertEquals("edit", next.messages.last().version)
    }
    @Test fun mutableInputCannotChangePublishedMessages() {
        val current = opened(); val source = mutableListOf(row(1))
        val next = ChatStateReducer.messages(current, ChatStateReducer.ticket(current)!!, source)
        source.clear()
        assertEquals(listOf(row(1)), next.messages)
        try { (next.messages as MutableList).clear(); fail("Published list must be immutable") }
        catch (_: UnsupportedOperationException) { }
    }
    @Test fun repeatedPayloadRetainsStateAndMessageListIdentity() {
        val current = opened(); val ticket = ChatStateReducer.ticket(current)!!
        val next = ChatStateReducer.messages(current, ticket, listOf(row(1)))
        assertSame(next, ChatStateReducer.messages(next, ticket, listOf(row(1))))
        assertSame(next.messages, ChatStateReducer.permission(next, ticket, true, null).messages)
    }
    @Test fun outboxFilteringKeepsDistinctTextAndMediaRequestsAndCapturesInput() {
        val current = opened(); val ticket = ChatStateReducer.ticket(current)!!
        val source = mutableListOf(OutboxRow("r", 10, "text", "QUEUED"),
            OutboxRow("r", 10, "image", "UPLOADING"), OutboxRow("other", 20, "text", "QUEUED"),
            OutboxRow("", 10, "text", "QUEUED"))
        val next = ChatStateReducer.outbox(current, ticket, source)
        source.clear()
        assertEquals(2, next.outbox.size)
        assertEquals(listOf("text", "image"), next.outbox.map { it.kind })
    }
    @Test fun staleOutboxAndPermissionCannotUpdateNewOwner() {
        val current = opened(); val ticket = ChatStateReducer.ticket(current)!!
        val next = ChatStateReducer.bind(current, bob)
        assertSame(next, ChatStateReducer.outbox(next, ticket, listOf(OutboxRow("r", 10, "text", "FAILED"))))
        assertSame(next, ChatStateReducer.permission(next, ticket, true, "ready"))
    }
    @Test fun accountDiagnosticsDoNotExposeTokenOrEndpoint() {
        assertFalse(alice.toString().contains(alice.token))
        assertFalse(alice.toString().contains(alice.endpoint))
    }
    @Test(expected = IllegalArgumentException::class) fun unauthenticatedConversationCannotOpen() {
        ChatStateReducer.open(ChatUiState(), 10)
    }
}

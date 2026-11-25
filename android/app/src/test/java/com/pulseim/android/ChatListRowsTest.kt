package com.pulseim.android

import org.junit.Assert.*
import org.junit.Test

class ChatListRowsTest {
    private fun message(id: Int, version: String = "1", text: String = "text") = ChatListRow(ChatRowKind.MESSAGE, id = id, version = version, snapshot = text)
    @Test fun messagesRemainOrderedWithHistoryFirstAndPendingLast() {
        val header = ChatListRow(ChatRowKind.OLDER_LOADING)
        val pending = ChatListRow(ChatRowKind.PENDING_TEXT, requestId = "request")
        assertEquals(listOf(header, message(1), message(2), pending), ChatListRows.ordered(header, listOf(message(2), message(1)), listOf(pending)))
    }
    @Test fun changedMessageRetainsIdentityAndLatestDuplicateWins() {
        val a = message(1); val b = message(1, "2", "edited")
        assertTrue(ChatListRows.sameItem(a, b)); assertFalse(ChatListRows.sameContent(a, b))
        assertEquals(listOf(b), ChatListRows.ordered(null, listOf(a, b), emptyList()))
    }
    @Test fun statusAndPendingPhaseChangesAreContentUpdates() {
        val a = ChatListRow(ChatRowKind.PENDING_MEDIA, requestId = "a", version = "QUEUED")
        val b = a.copy(version = "FAILED")
        assertTrue(ChatListRows.sameItem(a, b)); assertFalse(ChatListRows.sameContent(a, b))
        assertFalse(ChatListRows.sameItem(a, a.copy(kind = ChatRowKind.PENDING_TEXT)))
    }
    @Test fun snapshotsDoNotChangeWhenCallerBuildsANewerValue() {
        val a = message(1); val list = mutableListOf(a); val snapshot = ChatListRows.ordered(null, list, emptyList())
        list[0] = message(1, "2"); assertEquals("1", snapshot.single().version)
        assertTrue(ChatListRows.sameContent(a, snapshot.single()))
    }
    @Test fun prependingAndAppendingPreserveAnchorIdentity() {
        val old = listOf(message(20), message(21)); val key = old.first().key
        val next = ChatListRows.ordered(null, listOf(message(19)) + old + message(22), emptyList())
        assertEquals(1, ChatListRows.anchorPosition(next, key)); assertEquals(-1, ChatListRows.anchorPosition(next, "missing"))
    }
    @Test fun repeatedPendingItemsRemainDistinctAcrossKinds() {
        val a = ChatListRow(ChatRowKind.PENDING_TEXT, requestId = "same", version = "1")
        val b = a.copy(kind = ChatRowKind.PENDING_MEDIA); val c = a.copy(version = "2")
        assertEquals(listOf(c, b), ChatListRows.ordered(null, emptyList(), listOf(a, b, c)))
    }
}

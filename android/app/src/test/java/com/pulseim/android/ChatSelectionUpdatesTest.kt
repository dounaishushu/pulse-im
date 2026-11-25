package com.pulseim.android

import org.junit.Assert.*
import org.junit.Test

class ChatSelectionUpdatesTest {
    private fun message(id: Int) = ChatListRow(ChatRowKind.MESSAGE, id = id)
    private val rows = listOf(ChatListRow(ChatRowKind.OLDER_LOADING), message(10), message(20), message(30),
        ChatListRow(ChatRowKind.PENDING_TEXT, requestId = "text"),
        ChatListRow(ChatRowKind.PENDING_MEDIA, requestId = "image"))

    @Test fun inactiveSelectionDoesNotInvalidateRows() {
        assertEquals(emptyList<Int>(), ChatSelectionUpdates().positions(rows, false, emptySet()))
    }
    @Test fun enteringSelectionUpdatesAllMessagesAndSkipsHeaderAndPending() {
        assertEquals(listOf(1, 2, 3), ChatSelectionUpdates().positions(rows, true, setOf(20)))
    }
    @Test fun selectingAnotherMessageOnlyInvalidatesThatMessage() {
        val updates = ChatSelectionUpdates(); updates.positions(rows, true, setOf(10))
        assertEquals(listOf(2), updates.positions(rows, true, setOf(10, 20)))
    }
    @Test fun deselectingTheLastMessageKeepsSelectionModeAndUpdatesOneRow() {
        val updates = ChatSelectionUpdates(); updates.positions(rows, true, setOf(20))
        assertEquals(listOf(2), updates.positions(rows, true, emptySet()))
        assertEquals(emptyList<Int>(), updates.positions(rows, true, emptySet()))
    }
    @Test fun replacingSelectionUpdatesBothChangedMessages() {
        val updates = ChatSelectionUpdates(); updates.positions(rows, true, setOf(10, 20))
        assertEquals(listOf(1, 3), updates.positions(rows, true, setOf(20, 30)))
    }
    @Test fun leavingSelectionUpdatesAllMessageWidthsEvenWithNoCheckedRows() {
        val updates = ChatSelectionUpdates(); updates.positions(rows, true, emptySet())
        assertEquals(listOf(1, 2, 3), updates.positions(rows, false, emptySet()))
    }
    @Test fun mutableActivitySelectionCannotChangeThePreviousSnapshot() {
        val updates = ChatSelectionUpdates(); val selected = linkedSetOf(10)
        updates.positions(rows, true, selected); selected.clear(); selected.add(30)
        assertEquals(listOf(1, 3), updates.positions(rows, true, selected))
    }
    @Test fun prependingHistoryUsesCurrentPositionsAndMessageIdentity() {
        val updates = ChatSelectionUpdates(); updates.positions(rows, true, setOf(20))
        val next = listOf(message(5)) + rows
        assertEquals(listOf(3), updates.positions(next, true, emptySet()))
    }
    @Test fun removingSelectedHistoryDoesNotInvalidateUnrelatedRows() {
        val updates = ChatSelectionUpdates(); updates.positions(rows, true, setOf(10, 20))
        assertEquals(emptyList<Int>(), updates.positions(rows.filter { it.id != 10 }, true, setOf(20)))
    }
    @Test fun identicalSelectionAndContentUpdatesDoNotEmitSelectionPayloads() {
        val updates = ChatSelectionUpdates(); updates.positions(rows, true, setOf(20))
        assertEquals(emptyList<Int>(), updates.positions(rows.map { it.copy(version = "edited") }, true, setOf(20)))
    }
    @Test fun inactiveIdsAreIgnoredAndCannotLeakIntoANewSession() {
        val updates = ChatSelectionUpdates(); updates.positions(rows, false, setOf(20))
        assertEquals(emptyList<Int>(), updates.positions(rows, false, emptySet()))
        assertEquals(listOf(1, 2, 3), updates.positions(rows, true, emptySet()))
    }
    @Test fun independentListsDoNotShareSelectionState() {
        val first = ChatSelectionUpdates(); first.positions(rows, true, setOf(20))
        val second = ChatSelectionUpdates()
        assertEquals(emptyList<Int>(), second.positions(rows, false, emptySet()))
        assertEquals(listOf(2), first.positions(rows, true, emptySet()))
    }
}

package com.pulseim.android

import org.junit.Assert.*
import org.junit.Test

class ChatMessageMapTest {
    private var snapshots = 0
    private val changes = mutableListOf<List<ChatRow>>()
    private fun map() = ChatMessageMap<String>(Any(), { id, text ->
        snapshots++; ChatRow(id, if (text == "wrong-conversation") 20 else 10, text)
    }, { it.conversationId == 10 }, changes::add)

    @Test fun insertionMaintainsOrderedValuesAndImmutableSnapshots() {
        val map = map(); map[3] = "three"; map[1] = "one"
        assertEquals(listOf(1, 3), map.keys.toList())
        assertEquals(listOf("one", "three"), map.values.toList())
        assertEquals(listOf(1, 3), changes.last().map { it.id })
        try { (changes.last() as MutableList<ChatRow>).clear(); fail("Snapshot must be immutable") }
        catch (_: UnsupportedOperationException) { }
    }
    @Test fun changingOneOfTwoHundredMessagesSnapshotsOnlyThatMessage() {
        val map = map(); for (id in 1..200) map[id] = "message-$id"
        val previous = changes.last(); snapshots = 0
        map[100] = "edited"
        assertEquals(1, snapshots)
        assertEquals("message-100", previous[99].snapshot)
        assertEquals("edited", changes.last()[99].snapshot)
        assertSame(previous[0], changes.last()[0])
    }
    @Test fun equalPayloadUpdatesCompatibilityValueWithoutPublishingAgain() {
        val map = map(); map[1] = "one"; val count = changes.size
        map[1] = String(charArrayOf('o', 'n', 'e'))
        assertEquals(count, changes.size)
        assertEquals("one", map[1])
    }
    @Test fun otherConversationAndInvalidIdsCannotEnterMap() {
        val map = map(); map[1] = "wrong-conversation"; map[0] = "zero"
        assertTrue(map.isEmpty()); assertTrue(changes.isEmpty())
    }
    @Test fun removalAndClearPublishAndMissingRemovalsDoNot() {
        val map = map(); map[1] = "one"; map[2] = "two"
        assertEquals("one", map.remove(1)); val count = changes.size
        assertNull(map.remove(999)); assertEquals(count, changes.size)
        map.clear(); assertTrue(changes.last().isEmpty())
        map.clear(); assertEquals(count + 1, changes.size)
    }
    @Test fun entriesCannotBypassPublicationWithSetValue() {
        val map = map(); map[1] = "one"
        try { map.entries.first().setValue("bypass"); fail("Must use put") }
        catch (_: UnsupportedOperationException) { }
        assertEquals("one", map[1])
    }
    @Test fun resetDoesNotPublishOldOwnerDataDuringRebinding() {
        val map = map(); map[1] = "one"; val count = changes.size
        map.reset(); assertTrue(map.isEmpty()); assertEquals(count, changes.size)
        map[2] = "new"; assertEquals(listOf(2), changes.last().map { it.id })
    }
}

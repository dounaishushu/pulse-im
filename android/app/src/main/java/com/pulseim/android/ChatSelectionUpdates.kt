package com.pulseim.android

/** Tracks only selection state; content changes remain owned by the list diff. */
internal class ChatSelectionUpdates {
    private var active = false
    private var selected = emptySet<Int>()

    fun positions(rows: List<ChatListRow>, nextActive: Boolean, nextSelected: Set<Int>): List<Int> {
        // The activity owns a mutable set. Retain a snapshot for the next comparison.
        val next = if (nextActive) nextSelected.toSet() else emptySet()
        val modeChanged = active != nextActive
        val positions = rows.mapIndexedNotNull { index, row ->
            index.takeIf {
                row.kind == ChatRowKind.MESSAGE &&
                    (modeChanged || (row.id in selected) != (row.id in next))
            }
        }
        active = nextActive; selected = next
        return positions
    }
}

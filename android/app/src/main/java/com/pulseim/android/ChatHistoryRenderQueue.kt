package com.pulseim.android

import android.os.Build
import android.widget.LinearLayout
import org.json.JSONObject

/** Show newest rows first, yielding between small batches so touch/back stays responsive. */
internal class ChatHistoryRenderQueue(
    private val target: LinearLayout, private val current: () -> Boolean,
    private val row: (JSONObject) -> Unit, private val painted: () -> Unit,
    private val finished: () -> Unit, private val interrupted: () -> Unit
) {
    fun render(items: List<JSONObject>) {
        val pending = java.util.ArrayDeque(items.asReversed())
        fun step() {
            if (!current()) { pending.clear(); interrupted(); return }
            val start = System.nanoTime(); var count = 0
            if (Build.VERSION.SDK_INT >= 29) target.suppressLayout(true)
            try {
                while (pending.isNotEmpty() && count < 4 && (count == 0 || System.nanoTime() - start < 6_000_000)) {
                    row(pending.removeFirst()); count++
                }
            } finally { if (Build.VERSION.SDK_INT >= 29) target.suppressLayout(false) }
            painted()
            if (pending.isEmpty()) finished() else target.postOnAnimation { step() }
        }
        target.postOnAnimation { step() }
    }
}

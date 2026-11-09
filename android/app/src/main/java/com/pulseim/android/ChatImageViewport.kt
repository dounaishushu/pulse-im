package com.pulseim.android

import android.graphics.Rect
import android.os.Looper
import android.view.View
import android.view.ViewTreeObserver
import android.widget.ScrollView
import java.util.concurrent.atomic.AtomicBoolean

/** Starts visible photos before nearby prefetches; old history never becomes a FIFO download backlog. */
internal class ChatImageViewport(private val limit: Int = 3) {
    private class Entry(val view: View, val valid: () -> Boolean, val release: () -> Unit,
                        val start: (() -> Boolean, () -> Unit) -> Unit) {
        val wanted = AtomicBoolean(false)
        var running = false
        var done = false
        var priority = Int.MAX_VALUE
    }
    private val entries = mutableListOf<Entry>()
    private var root: View? = null
    private var observer: ViewTreeObserver? = null
    private var scheduled = false
    private val changed = ViewTreeObserver.OnScrollChangedListener { schedule() }
    private val layout = ViewTreeObserver.OnGlobalLayoutListener { schedule() }
    private val attached = object : View.OnAttachStateChangeListener {
        override fun onViewAttachedToWindow(v: View) { observe(v); schedule() }
        override fun onViewDetachedFromWindow(v: View) { if (root === v) clear() }
    }
    fun enqueue(view: View, container: View, valid: () -> Boolean, loaded: Boolean = false, release: () -> Unit = {}, start: (() -> Boolean, () -> Unit) -> Unit) {
        check(Looper.myLooper() == Looper.getMainLooper())
        if (root !== container) {
            clear(); root = container; container.addOnAttachStateChangeListener(attached)
            if (container.isAttachedToWindow) observe(container)
        }
        entries.removeAll { it.view === view && !it.running }
        entries.add(Entry(view, valid, release, start).apply { done = loaded }); schedule()
    }
    private fun observe(view: View) {
        if (observer === view.viewTreeObserver) return
        detachObserver(); observer = view.viewTreeObserver
        observer?.addOnScrollChangedListener(changed); observer?.addOnGlobalLayoutListener(layout)
    }
    private fun detachObserver() {
        observer?.takeIf { it.isAlive }?.let { it.removeOnScrollChangedListener(changed); it.removeOnGlobalLayoutListener(layout) }
        observer = null
    }
    private fun schedule() {
        val owner = root ?: return
        if (scheduled) return
        scheduled = true
        owner.postOnAnimation { if (root === owner) { scheduled = false; pump() } }
    }
    private fun pump() {
        val owner = root ?: return
        if (!owner.isAttachedToWindow) return
        var ancestor: View? = owner
        while (ancestor != null && ancestor !is ScrollView) ancestor = ancestor.parent as? View
        val viewport = Rect()
        if (!(ancestor ?: owner).getGlobalVisibleRect(viewport) || viewport.height() <= 0) return
        val margin = viewport.height() / 2
        val location = IntArray(2)
        fun belongs(view: View): Boolean {
            var node: View? = view
            while (node != null) { if (node === owner) return true; node = node.parent as? View }
            return false
        }
        entries.removeAll { entry ->
            val removed = !entry.running && (!entry.valid() || !belongs(entry.view))
            if (removed) entry.release()
            removed
        }
        entries.forEach { entry ->
            entry.view.getLocationOnScreen(location)
            val top = location[1]; val bottom = top + entry.view.height
            val wanted = entry.valid() && entry.view.isAttachedToWindow && entry.view.height > 0 &&
                entry.view.visibility == View.VISIBLE && bottom >= viewport.top - margin && top <= viewport.bottom + margin
            entry.wanted.set(wanted)
            if (!wanted && entry.done) { entry.release(); entry.done = false }
            val distance = kotlin.math.abs((top + bottom) / 2 - viewport.centerY())
            entry.priority = if (bottom > viewport.top && top < viewport.bottom) distance else viewport.height() * 2 + distance
        }
        entries.removeAll { !it.running && !it.valid() }
        var available = (limit - entries.count { it.running }).coerceAtLeast(0)
        for (entry in entries.filter { !it.running && !it.done && it.wanted.get() }.sortedBy { it.priority }) {
            if (available-- <= 0) break
            entry.running = true
            val eligible = { entry.wanted.get() && entry.valid() }
            entry.start(eligible) {
                // Completion is delivered on the UI thread, even when the transfer was cancelled.
                entry.running = false; entry.done = entry.wanted.get() && entry.valid(); schedule()
            }
        }
    }
    fun clear() {
        entries.forEach { it.wanted.set(false); it.release() }; entries.clear()
        root?.removeOnAttachStateChangeListener(attached); root = null
        detachObserver(); scheduled = false
    }
}

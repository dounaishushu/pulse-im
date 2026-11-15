package com.pulseim.android

import android.view.MotionEvent
import android.view.View
import android.view.ViewTreeObserver
import android.widget.LinearLayout
import android.widget.ScrollView

/** Following survives row replacement, image decoding and IME layout passes. */
internal class ChatMessageScroll(
    val messages: LinearLayout,
    private val scroll: ScrollView,
    private val current: () -> Boolean,
    private val navigation: () -> Long
) {
    private var following = false
    private var revision = 0L
    private var disposed = false
    private val preDraw = ViewTreeObserver.OnPreDrawListener {
        if (following && (!current() || revision != navigation())) following = false
        if (following) scroll.scrollTo(0, (messages.height - scroll.height + scroll.paddingTop + scroll.paddingBottom).coerceAtLeast(0))
        true
    }
    private val attachment = object : View.OnAttachStateChangeListener {
        override fun onViewAttachedToWindow(view: View) = Unit
        override fun onViewDetachedFromWindow(view: View) = dispose()
    }

    init {
        messages.viewTreeObserver.addOnPreDrawListener(preDraw)
        messages.addOnAttachStateChangeListener(attachment)
    }

    fun followLatest() {
        if (disposed || !current()) return
        following = true; revision = navigation()
        // The next pre-draw uses measured row heights, after ScrollView has
        // performed its own focus/keyboard adjustment for this frame.
        messages.requestLayout(); messages.invalidate()
    }

    fun onTouch(event: MotionEvent) {
        if (event.actionMasked == MotionEvent.ACTION_MOVE || event.actionMasked == MotionEvent.ACTION_SCROLL) following = false
    }

    fun dispose() {
        if (disposed) return
        disposed = true; following = false
        if (messages.viewTreeObserver.isAlive) messages.viewTreeObserver.removeOnPreDrawListener(preDraw)
        messages.removeOnAttachStateChangeListener(attachment)
    }
}

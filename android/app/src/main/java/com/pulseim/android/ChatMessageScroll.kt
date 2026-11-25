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
    private val navigation: () -> Long,
    private val recycler: ChatRecyclerList? = null
) {
    private var following = false
    private var readerPaused = false
    private var touching = false
    private var revision = 0L
    private var disposed = false
    var positionRevision = 0L
        private set
    private fun bottomGap() = recycler?.remaining() ?: (messages.height - scroll.height + scroll.paddingTop + scroll.paddingBottom - scroll.scrollY)
    private val recyclerChanged: () -> Unit = { resumeAtBottom() }
    private val scrollChanged = ViewTreeObserver.OnScrollChangedListener { resumeAtBottom() }
    private val preDraw = ViewTreeObserver.OnPreDrawListener {
        if (following && (!current() || revision != navigation())) following = false
        if (following) {
            if (recycler != null) recycler.followLatest()
            else scroll.scrollTo(0, (messages.height - scroll.height + scroll.paddingTop + scroll.paddingBottom).coerceAtLeast(0))
        }
        true
    }
    private val attachment = object : View.OnAttachStateChangeListener {
        override fun onViewAttachedToWindow(view: View) = Unit
        override fun onViewDetachedFromWindow(view: View) = dispose()
    }

    init {
        messages.viewTreeObserver.addOnPreDrawListener(preDraw)
        scroll.viewTreeObserver.addOnScrollChangedListener(scrollChanged)
        messages.addOnAttachStateChangeListener(attachment)
        recycler?.addChanged(recyclerChanged)
    }

    /** Capture before inserting rows; later callbacks must still respect a new reader gesture. */
    fun shouldFollowIncoming() = !disposed && current() && !readerPaused &&
        ((following && revision == navigation()) || bottomGap() <= IOSGroupChatStyle.dp(scroll.context, 24))

    fun followLatest(force: Boolean = false) {
        if (disposed || !current() || (readerPaused && !force)) return
        if (force) { readerPaused = false; touching = false; positionRevision++ }
        following = true; revision = navigation()
        // The next pre-draw uses measured row heights, after ScrollView has
        // performed its own focus/keyboard adjustment for this frame.
        messages.requestLayout(); messages.invalidate()
    }

    fun onTouch(event: MotionEvent) {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN, MotionEvent.ACTION_MOVE, MotionEvent.ACTION_SCROLL -> {
                positionRevision++
                touching = event.actionMasked != MotionEvent.ACTION_SCROLL
                readerPaused = true; following = false
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> { positionRevision++; touching = false; resumeAtBottom() }
        }
    }

    private fun resumeAtBottom() {
        // Only reaching the bottom resumes automatic following. A new row or
        // late image below the reader cannot cancel the pause.
        if (readerPaused && !touching && !disposed && current() && (recycler?.view ?: scroll).height > 0 && bottomGap() <= 2) {
            readerPaused = false; positionRevision++
            followLatest()
        }
    }

    fun dispose() {
        if (disposed) return
        disposed = true; following = false
        if (messages.viewTreeObserver.isAlive) messages.viewTreeObserver.removeOnPreDrawListener(preDraw)
        if (scroll.viewTreeObserver.isAlive) scroll.viewTreeObserver.removeOnScrollChangedListener(scrollChanged)
        messages.removeOnAttachStateChangeListener(attachment)
        recycler?.removeChanged(recyclerChanged)
    }
}

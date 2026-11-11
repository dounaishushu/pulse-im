package com.pulseim.android

import android.content.Context
import android.view.MotionEvent
import android.view.ViewConfiguration
import android.widget.ListView

/** Keep the displayed adapter snapshot stable until AbsListView's delayed click has run. */
internal class TapResponsiveListView(context: Context) : ListView(context) {
    private var fingerDown = false
    private var clickPending = false
    private var pendingRows: (() -> Unit)? = null
    private var pendingAnchor: (() -> Unit)? = null
    private val publish = Runnable { if (!fingerDown) { clickPending = false; flush() } }

    fun publishRows(change: () -> Unit) {
        if (fingerDown || clickPending) pendingRows = change else change()
    }
    fun afterRowsPublished(action: () -> Unit) {
        if (pendingRows != null || fingerDown || clickPending) pendingAnchor = action else action()
    }
    private fun flush() {
        val rows = pendingRows; pendingRows = null; rows?.invoke()
        val anchor = pendingAnchor; pendingAnchor = null; anchor?.invoke()
    }
    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        if (event.actionMasked == MotionEvent.ACTION_DOWN) {
            removeCallbacks(publish); fingerDown = true
        }
        return try { super.dispatchTouchEvent(event) } finally {
            when (event.actionMasked) {
                MotionEvent.ACTION_UP -> {
                    fingerDown = false; clickPending = true
                    removeCallbacks(publish)
                    // AbsListView checks mDataChanged again in its pressed-state callback.
                    postDelayed(publish, ViewConfiguration.getPressedStateDuration().toLong() + 1)
                }
                MotionEvent.ACTION_CANCEL -> {
                    fingerDown = false; clickPending = false
                    removeCallbacks(publish); post(publish)
                }
            }
        }
    }
    override fun onDetachedFromWindow() {
        removeCallbacks(publish); fingerDown = false; clickPending = false
        cancelPendingInputEvents(); smoothScrollBy(0, 0); isPressed = false
        super.onDetachedFromWindow()
        flush()
    }
    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        removeCallbacks(publish); fingerDown = false; clickPending = false
        flush()
        // AbsListView marks its adapter as changed when it reattaches. A retained
        // view with unchanged bounds can otherwise skip layout until a scroll,
        // and every tap is rejected while that framework flag remains set.
        requestLayout()
    }
}

package com.pulseim.android

import android.graphics.Rect
import android.util.Log
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.AbsSeekBar
import android.widget.CompoundButton
import android.widget.EditText
import android.widget.HorizontalScrollView
import android.widget.TextView
import android.widget.VideoView

/** Shared by Activity and page dialogs, whose touch events use separate windows. */
internal class PageBackTouchDispatcher {
    private var gesture: PageBackGesture? = null
    private var owner: Any? = null
    private var claimed = false
    private var left = 0f

    fun dispatch(event: MotionEvent, surface: View, currentOwner: Any?, child: (MotionEvent) -> Boolean, back: () -> Unit): Boolean {
        val action = event.actionMasked
        if (action == MotionEvent.ACTION_DOWN) {
            claimed = false; owner = null; gesture?.reset()
            val bounds = Rect()
            if (currentOwner != null && surface.getGlobalVisibleRect(bounds) && bounds.contains(event.rawX.toInt(), event.rawY.toInt()) &&
                !horizontalControlAt(surface, event.rawX, event.rawY)) {
                left = bounds.left.toFloat()
                gesture = PageBackGesture(ViewConfiguration.get(surface.context).scaledTouchSlop.toFloat(), 72 * surface.resources.displayMetrics.density)
                if (gesture!!.begin(event.rawX - left, event.rawY, bounds.width().toFloat())) owner = currentOwner
            }
            if (currentOwner != null) trace("begin eligible=${owner != null}")
        } else if (owner != null) {
            if (owner != currentOwner || event.pointerCount != 1 || action == MotionEvent.ACTION_CANCEL) {
                trace("cancel pageChanged=${owner != currentOwner} pointers=${event.pointerCount} systemCancel=${action == MotionEvent.ACTION_CANCEL}")
                owner = null; gesture?.reset()
            } else if (action == MotionEvent.ACTION_MOVE && gesture?.move(event.rawX - left, event.rawY, event.pointerCount) == true) {
                if (!claimed) {
                    claimed = true
                    trace("claimed")
                    MotionEvent.obtain(event).also { cancel -> cancel.action = MotionEvent.ACTION_CANCEL; child(cancel); cancel.recycle() }
                }
                return true
            } else if (action == MotionEvent.ACTION_UP) {
                val consumed = claimed
                val accepted = gesture?.finish(event.rawX - left, event.rawY) == true
                trace("finish accepted=$accepted")
                owner = null; claimed = false
                if (accepted) back()
                return consumed || child(event)
            }
        }
        // Once the child receives CANCEL, it must not receive this sequence's UP,
        // including when a second finger, account switch or page change cancelled back.
        if (claimed) {
            if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) claimed = false
            return true
        }
        return child(event)
    }

    private fun trace(message: String) {
        if (BuildConfig.DEBUG && Log.isLoggable("PulseSwipe", Log.DEBUG)) Log.d("PulseSwipe", message)
    }

    private fun horizontalControlAt(view: View, x: Float, y: Float): Boolean {
        if (view.visibility != View.VISIBLE || view.alpha <= .01f) return false
        val bounds = Rect()
        if (!view.getGlobalVisibleRect(bounds) || !bounds.contains(x.toInt(), y.toInt())) return false
        if (view is EditText || view is AbsSeekBar || view is CompoundButton || view is HorizontalScrollView || view is VideoView ||
            (view is TextView && view.hasSelection()) || (view is QuestionZoomImageView && view.ownsImageDrag) ||
            (view is WebView && (view.canScrollHorizontally(-1) || view.canScrollHorizontally(1)))) return true
        if (view is ViewGroup) {
            for (index in view.childCount - 1 downTo 0) {
                val child = view.getChildAt(index)
                if (child.visibility == View.VISIBLE && child.alpha > .01f && child.getGlobalVisibleRect(bounds) && bounds.contains(x.toInt(), y.toInt())) {
                    return horizontalControlAt(child, x, y)
                }
            }
        }
        return false
    }
}

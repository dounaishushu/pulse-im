package com.pulseim.android

import android.app.Activity
import android.app.Dialog
import android.view.MotionEvent
import android.view.ViewGroup

/** Page/modal back uses the same gesture, while protected dialogs stay cancel-proof. */
internal open class BackSwipeDialog(private val hostActivity: Activity, theme: Int = 0) : Dialog(hostActivity, theme) {
    private val swipe = PageBackTouchDispatcher()
    private var swipeCancelable = true
    var onSwipeBack: (() -> Unit)? = null
    var swipePageIdentity: () -> Any? = { null }
    var swipeBackEnabled: () -> Boolean = { true }

    override fun setCancelable(flag: Boolean) { swipeCancelable = flag; super.setCancelable(flag) }

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        val surface = window?.decorView ?: return super.dispatchTouchEvent(event)
        val page = (surface.findViewById<ViewGroup>(android.R.id.content))?.getChildAt(0)
        val scope = if (isShowing && swipeCancelable && swipeBackEnabled() && (hostActivity as? MainActivity)?.isAppLocked() != true)
            listOf(page, swipePageIdentity(), (hostActivity as? MainActivity)?.swipeAccountIdentity()) else null
        return swipe.dispatch(event, surface, scope, { super.dispatchTouchEvent(it) }) {
            onSwipeBack?.invoke() ?: onBackPressed()
        }
    }
}

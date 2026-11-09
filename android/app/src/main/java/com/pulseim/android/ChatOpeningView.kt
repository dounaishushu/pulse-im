package com.pulseim.android

import android.content.Context
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout

/** Immediate feedback while current server membership and first messages load. */
internal class ChatOpeningView(context: Context, title: String, back: () -> Unit, retry: () -> Unit) : ChatScreen(context) {
    private val progress = listLoadingIndicator(context)
    private val status = label("", 14f, CHAT_GREY).apply {
        gravity = Gravity.CENTER; visibility = GONE
        setPadding(dp(24), dp(16), dp(24), dp(16))
        setOnClickListener { retry() }
        accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
    }
    init {
        id = R.id.chat_opening
        header(title.ifBlank { "会话" }, back)
        addView(FrameLayout(context).apply {
            addView(progress, FrameLayout.LayoutParams(dp(40), dp(40), Gravity.CENTER))
            addView(status, FrameLayout.LayoutParams(-1, -2, Gravity.CENTER))
        }, LayoutParams(-1, 0, 1f))
    }
    fun showError(value: String) { progress.visibility = GONE; status.text = "$value\n点击重试"; status.visibility = VISIBLE }
}

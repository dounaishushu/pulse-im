package com.pulseim.android

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.widget.TextView
import kotlin.math.roundToInt

/** Main-thread store shared by all five tabs, without keeping an Activity alive. */
internal object NavigationBadges {
    private val state = NavigationBadgeState()
    private val observers = mutableSetOf<(NavigationBadgeCounts) -> Unit>()
    fun bind(userId: Int, token: String?, endpoint: String): Boolean {
        val changed = state.bind(userId, token, endpoint)
        if (changed) publish()
        return changed
    }
    fun begin() = state.begin()
    fun accept(ticket: NavigationBadgeState.Ticket, snapshot: NavigationBadgeSnapshot): Boolean {
        val accepted = state.accept(ticket, snapshot)
        if (accepted) publish()
        return accepted
    }
    fun invalidate() = state.invalidate()
    fun handledRequest(id: Int) { state.handledRequest(id); publish() }
    fun observe(observer: (NavigationBadgeCounts) -> Unit) { observers.add(observer); observer(state.counts()) }
    fun remove(observer: (NavigationBadgeCounts) -> Unit) { observers.remove(observer) }
    private fun publish() { val counts = state.counts(); observers.toList().forEach { it(counts) } }
}

internal class UnreadBadgeView(context: Context, private val requests: Boolean) : TextView(context) {
    private fun dp(value: Int) = (value * resources.displayMetrics.density).roundToInt()
    private val observer: (NavigationBadgeCounts) -> Unit = { counts ->
        val count = if (requests) counts.requests else counts.messages
        text = NavigationBadgeCounts.label(count)
        visibility = if (count > 0) VISIBLE else GONE
        contentDescription = if (requests) "$count 条待处理好友申请" else "$count 条未读消息"
    }
    init {
        gravity = Gravity.CENTER
        includeFontPadding = false
        textSize = 10f
        typeface = Typeface.DEFAULT_BOLD
        setTextColor(Color.WHITE)
        setPadding(dp(4), 0, dp(4), 0)
        minWidth = dp(16); minHeight = dp(16)
        background = GradientDrawable().apply { setColor(0xFFF16559.toInt()); cornerRadius = dp(10).toFloat() }
        visibility = GONE
        accessibilityLiveRegion = ACCESSIBILITY_LIVE_REGION_POLITE
    }
    override fun onAttachedToWindow() { super.onAttachedToWindow(); NavigationBadges.observe(observer) }
    override fun onDetachedFromWindow() { NavigationBadges.remove(observer); super.onDetachedFromWindow() }
}

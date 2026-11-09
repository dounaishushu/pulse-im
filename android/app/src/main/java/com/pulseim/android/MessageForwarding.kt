package com.pulseim.android

import android.content.Context
import android.graphics.Color
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.widget.FrameLayout
import android.widget.TextView
import org.json.JSONObject
import java.util.UUID
import kotlin.math.abs

internal data class ForwardMessageItem(val sourceId: Int, val type: String, val bodyJson: String, val requestId: String)

internal class MessageForwardBatch(messages: List<ForwardMessageItem>) {
    val items = messages.distinctBy { it.sourceId }.sortedBy { it.sourceId }
    var completed = 0
        private set
    init { require(items.size in 1..100 && items.all { it.sourceId > 0 }) }
    fun pending(): ForwardMessageItem? = items.getOrNull(completed)
    fun acknowledge(requestId: String) {
        check(pending()?.requestId == requestId) { "Unexpected forwarding acknowledgement" }
        completed++
    }
}

internal object MessageForwarding {
    private val fields = mapOf(
        "text" to listOf("text"), "contact_card" to listOf("user_id"),
        "image" to listOf("url", "text", "mime", "size", "name", "width", "height", "original"),
        "video" to listOf("url", "thumbnail_url", "text", "mime", "size", "name", "width", "height", "duration_ms"),
        "file" to listOf("url", "text", "mime", "size", "name", "file_name", "original_name"),
        "voice" to listOf("url", "mime", "size", "name", "duration_ms")
    )
    fun supported(message: JSONObject): Boolean = message.optInt("id") > 0 && fields.containsKey(message.optString("type")) &&
        message.isNull("recalled_at") && message.optString("status") != "recalled"
    fun snapshot(message: JSONObject): ForwardMessageItem {
        require(supported(message))
        val type = message.getString("type")
        val source = message.optJSONObject("body") ?: JSONObject()
        val body = JSONObject()
        fields.getValue(type).forEach { field -> if (source.has(field)) body.put(field, source.get(field)) }
        return ForwardMessageItem(message.getInt("id"), type, body.toString(), "android-forward-${UUID.randomUUID()}")
    }
    fun targetAllowed(target: JSONObject): Boolean = target.optInt("id") > 0 &&
        target.optString("type") in listOf("direct", "group", "channel", "customer_service", "favorites") &&
        target.isNull("frozen_at") && target.optString("status") != "frozen" &&
        (!target.has("can_publish") || target.isNull("can_publish") || target.optBoolean("can_publish")) &&
        (target.optString("type") != "channel" || target.optString("my_role") in listOf("owner", "admin"))
}

/** Intercept taps only while selecting, so media/quotes keep their normal actions. */
internal class SelectableMessageRow(context: Context, val messageId: Int, private val messageView: View, onMenu: ((View) -> Unit)? = null, toggle: () -> Unit) : FrameLayout(context) {
    private val density = resources.displayMetrics.density
    private val check = TextView(context).apply {
        textSize = 16f; gravity = android.view.Gravity.CENTER
        setTextColor(Color.WHITE); importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }
    private var choosing = false
    private var startX = 0f
    private var startY = 0f
    private val slop = ViewConfiguration.get(context).scaledTouchSlop
    private var held = false
    private val longPress = Runnable { if (choosing && isAttachedToWindow && onMenu != null) { held = true; performLongClick() } }
    init {
        tag = messageId; id = R.id.chat_selectable_message
        // Move vertical spacing to the outer row; FrameLayout replaces the child's old params.
        val originalMargins = messageView.layoutParams as? android.view.ViewGroup.MarginLayoutParams
        layoutParams = android.widget.LinearLayout.LayoutParams(-1, -2).apply {
            topMargin = originalMargins?.topMargin ?: 0
            bottomMargin = originalMargins?.bottomMargin ?: 0
        }
        addView(messageView, LayoutParams(-1, -2))
        addView(check, LayoutParams((24 * density).toInt(), (24 * density).toInt(), android.view.Gravity.START or android.view.Gravity.CENTER_VERTICAL).apply { leftMargin = (4 * density).toInt() })
        setOnClickListener { if (choosing) toggle() }
        setOnLongClickListener { if (choosing && onMenu != null) { onMenu(this); true } else false }
        update(false, false, "")
    }
    fun update(active: Boolean, selected: Boolean, description: String) {
        choosing = active; isClickable = active
        if (!active) removeCallbacks(longPress)
        check.visibility = if (active) View.VISIBLE else View.GONE
        check.text = if (selected) "✓" else ""
        check.background = android.graphics.drawable.GradientDrawable().apply {
            shape = android.graphics.drawable.GradientDrawable.OVAL
            setColor(if (selected) 0xFF299FD9.toInt() else AppAppearance.background(Color.WHITE))
            setStroke((2 * density).toInt(), if (selected) 0xFF299FD9.toInt() else 0xFF7F9AA9.toInt())
        }
        (messageView.layoutParams as LayoutParams).apply { leftMargin = if (active) (32 * density).toInt() else 0 }.also { messageView.layoutParams = it }
        setBackgroundColor(if (active && selected) 0x29299FD9 else Color.TRANSPARENT)
        contentDescription = if (active) "${if (selected) "已选择" else "未选择"} $description" else null
        importantForAccessibility = if (active) View.IMPORTANT_FOR_ACCESSIBILITY_YES else View.IMPORTANT_FOR_ACCESSIBILITY_AUTO
        messageView.importantForAccessibility = if (active) View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS else View.IMPORTANT_FOR_ACCESSIBILITY_AUTO
    }
    override fun onInterceptTouchEvent(event: MotionEvent): Boolean = choosing || super.onInterceptTouchEvent(event)
    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (!choosing) return super.onTouchEvent(event)
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> { startX = event.x; startY = event.y; held = false; removeCallbacks(longPress); postDelayed(longPress, ViewConfiguration.getLongPressTimeout().toLong()) }
            MotionEvent.ACTION_MOVE -> if (abs(event.x - startX) > slop || abs(event.y - startY) > slop) removeCallbacks(longPress)
            MotionEvent.ACTION_UP -> { removeCallbacks(longPress); if (!held && abs(event.x - startX) <= slop && abs(event.y - startY) <= slop) performClick() }
            MotionEvent.ACTION_CANCEL -> { removeCallbacks(longPress); held = false }
        }
        return true
    }
    override fun performClick(): Boolean = super.performClick()
    override fun onDetachedFromWindow() { removeCallbacks(longPress); super.onDetachedFromWindow() }
}

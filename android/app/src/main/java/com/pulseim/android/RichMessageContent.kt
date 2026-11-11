package com.pulseim.android

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.view.Gravity
import android.view.View
import android.widget.*
import org.json.JSONObject

/** The same rich content is used by native group and direct conversations. */
internal object RichMessageContent {
    fun string(body: JSONObject, name: String) = body.optString(name).takeUnless { it.isBlank() || it == "null" }.orEmpty()
    fun isVideo(message: JSONObject): Boolean = message.optString("type") == "video" ||
        (message.optString("type") == "file" && string(message.optJSONObject("body") ?: JSONObject(), "mime").startsWith("video/", true))
    fun available(message: JSONObject) = (message.isNull("recalled_at") || message.optString("recalled_at").isBlank()) &&
        message.optString("status") !in listOf("recalled", "deleted")
    fun imageCaption(message: JSONObject): String {
        val body = message.optJSONObject("body") ?: return ""
        if (!available(message) || message.optString("type") != "image" || string(body, "url").isBlank()) return ""
        return (body.opt("text") as? String)?.takeUnless { it.isBlank() }.orEmpty()
    }
    fun captionSize(c: Context, message: JSONObject, maxWidth: Int): Pair<Int, Int> {
        val limit = IOSGroupChatStyle.dp(c, 230).coerceAtMost(maxWidth)
        val body = message.optJSONObject("body") ?: JSONObject()
        val w = body.optDouble("width"); val h = body.optDouble("height")
        if (!w.isFinite() || !h.isFinite() || w <= 0 || h <= 0) return limit to limit
        val maxHeight = IOSGroupChatStyle.dp(c, 300)
        val width = (maxHeight * w / h).coerceIn(IOSGroupChatStyle.dp(c, 180).coerceAtMost(limit).toDouble(), limit.toDouble()).toInt()
        return width to (width * h / w).coerceIn(IOSGroupChatStyle.dp(c, 40).toDouble(), maxHeight.toDouble()).toInt()
    }
    fun caption(c: Context, message: JSONObject, width: Int, color: Int): TextView =
        IOSGroupChatStyle.label(c, imageCaption(message), AppAppearance.messageSize.toFloat(), color).apply {
            id = R.id.chat_image_caption
            layoutParams = LinearLayout.LayoutParams(width, -2)
            setTag(R.id.appearance_message, true); setTag(R.id.appearance_user_content, true)
            setPadding(IOSGroupChatStyle.dp(c, 10), IOSGroupChatStyle.dp(c, 7), IOSGroupChatStyle.dp(c, 10), IOSGroupChatStyle.dp(c, 2))
        }
    fun transparentBubble(message: JSONObject): Boolean {
        val body = message.optJSONObject("body") ?: return false
        return available(message) && when {
            message.optString("type") == "image" || isVideo(message) -> string(body, "url").isNotBlank()
            message.optString("type") == "contact_card" -> body.optInt("user_id") > 0
            else -> false
        }
    }
    fun duration(milliseconds: Long): String {
        val seconds = milliseconds.coerceAtLeast(0) / 1000
        return "%d:%02d".format(java.util.Locale.ROOT, seconds / 60, seconds % 60)
    }
    fun video(c: Context, message: JSONObject, mine: Boolean, maxWidth: Int,
              load: (JSONObject, ImageView, TextView, TextView) -> Unit, open: (JSONObject) -> Unit): View {
        val body = message.optJSONObject("body") ?: JSONObject()
        val name = string(body, "name").ifBlank { string(body, "file_name").ifBlank { "视频" } }
        val width = IOSGroupChatStyle.dp(c, 260).coerceAtMost(maxWidth.coerceAtLeast(IOSGroupChatStyle.dp(c, 120)))
        fun label(text: String, size: Float, color: Int) = IOSGroupChatStyle.label(c, text, size, color)
        val foreground = IOSGroupChatStyle.ink()
        val card = LinearLayout(c).apply {
            id = R.id.chat_message_video; orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(width, -2)
            contentDescription = "播放视频：$name"; isFocusable = true
            setOnClickListener { open(message) }
        }
        val preview = ImageView(c).apply { id = R.id.chat_video_thumbnail; scaleType = ImageView.ScaleType.CENTER_CROP; importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO }
        val status = label("正在加载视频封面…", 11f, Color.WHITE).apply { id = R.id.chat_video_status; gravity = Gravity.BOTTOM or Gravity.START; setPadding(IOSGroupChatStyle.dp(c, 8), 0, IOSGroupChatStyle.dp(c, 44), IOSGroupChatStyle.dp(c, 6)) }
        val duration = label(if (body.optLong("duration_ms") > 0) RichMessageContent.duration(body.optLong("duration_ms")) else "视频", 11f, Color.WHITE).apply {
            id = R.id.chat_video_duration; gravity = Gravity.CENTER; setPadding(8, 3, 8, 3); background = IOSGroupChatStyle.shape(c, 0x99000000.toInt(), 4)
        }
        val frame = FrameLayout(c).apply {
            background = IOSGroupChatStyle.shape(c, 0xFF303B48.toInt(), 12); clipToOutline = true
            addView(preview, FrameLayout.LayoutParams(-1, -1)); addView(status, FrameLayout.LayoutParams(-1, -1))
            addView(label("▶", 24f, Color.WHITE).apply { gravity = Gravity.CENTER; background = IOSGroupChatStyle.shape(c, 0x99000000.toInt(), 24); importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO },
                FrameLayout.LayoutParams(IOSGroupChatStyle.dp(c, 48), IOSGroupChatStyle.dp(c, 48), Gravity.CENTER))
            addView(duration, FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM or Gravity.END).apply { rightMargin = IOSGroupChatStyle.dp(c, 6); bottomMargin = IOSGroupChatStyle.dp(c, 6) })
        }
        card.addView(frame, LinearLayout.LayoutParams(width, width * 9 / 16))
        string(body, "text").takeIf { it.isNotBlank() }?.let { card.addView(label(it, 14f, foreground).apply { setPadding(8, 3, 8, 3) }) }
        load(message, preview, status, duration)
        return card
    }
    fun contact(c: Context, message: JSONObject, mine: Boolean, maxWidth: Int,
                loadImage: (ImageView, TextView, String) -> Unit, open: (JSONObject) -> Unit): View {
        val body = message.optJSONObject("body") ?: JSONObject()
        val name = string(body, "nickname").ifBlank { "联系人名片" }
        val foreground = if (AppAppearance.dark) 0xFFEDF4FF.toInt() else 0xFF304E75.toInt()
        val muted = if (AppAppearance.dark) 0xFFB8CBE3.toInt() else 0xFF526885.toInt()
        val border = if (AppAppearance.dark) 0xFF4B6888.toInt() else 0xFFCAD8EE.toInt()
        return LinearLayout(c).apply {
            id = R.id.chat_message_contact_card; orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(IOSGroupChatStyle.dp(c, 260).coerceAtMost(maxWidth.coerceAtLeast(IOSGroupChatStyle.dp(c, 120))), -2)
            background = IOSGroupChatStyle.shape(c, if (AppAppearance.dark) 0xFF263B54.toInt() else 0xFFE7EFFF.toInt(), 12).apply {
                setStroke(IOSGroupChatStyle.dp(c, 1), border)
            }
            setPadding(IOSGroupChatStyle.dp(c, 14), IOSGroupChatStyle.dp(c, 12), IOSGroupChatStyle.dp(c, 14), IOSGroupChatStyle.dp(c, 12))
            contentDescription = "查看联系人名片：$name"; isFocusable = true
            setOnClickListener { open(message) }
            addView(LinearLayout(c).apply {
                gravity = Gravity.CENTER_VERTICAL
                addView(IOSGroupChatStyle.avatar(c, name, string(body, "avatar_url"), loadImage).apply { id = R.id.chat_contact_card_avatar },
                    LinearLayout.LayoutParams(IOSGroupChatStyle.dp(c, 48), IOSGroupChatStyle.dp(c, 48)).apply { rightMargin = IOSGroupChatStyle.dp(c, 12) })
                addView(LinearLayout(c).apply {
                    orientation = LinearLayout.VERTICAL
                    addView(IOSGroupChatStyle.label(c, name, 16f, foreground).apply { typeface = Typeface.DEFAULT_BOLD; maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END })
                    string(body, "username").takeIf { it.isNotBlank() }?.let { addView(IOSGroupChatStyle.label(c, "@$it", 12f, muted).apply { maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END }) }
                }, LinearLayout.LayoutParams(0, -2, 1f))
            }, LinearLayout.LayoutParams(-1, -2))
            PublicUserId.value(body.opt("public_id"))?.let { addView(IOSGroupChatStyle.label(c, "ID：$it", 11f, muted).apply { maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END; setPadding(0, 8, 0, 6) }) }
            addView(View(c).apply { setBackgroundColor(border) }, LinearLayout.LayoutParams(-1, IOSGroupChatStyle.dp(c, 1)).apply { topMargin = IOSGroupChatStyle.dp(c, 8) })
            addView(IOSGroupChatStyle.label(c, "个人名片 · 点击查看   ›", 12f, muted).apply { setPadding(0, IOSGroupChatStyle.dp(c, 9), 0, 0) })
        }
    }
}

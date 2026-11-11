package com.pulseim.android

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.widget.*
import org.json.JSONObject
import kotlin.math.roundToInt

/** The standard group conversation used by iOS ChatView, rendered natively. */
internal object IOSGroupChatStyle {
    const val blue = 0xFF2F80ED.toInt()
    fun background() = if (AppAppearance.dark) 0xFF1C1C1E.toInt() else 0xFFF2F2F7.toInt()
    fun surface() = AppAppearance.background(Color.WHITE)
    fun ink() = AppAppearance.ink(Color.BLACK)
    fun muted() = if (AppAppearance.dark) 0xFF98989F.toInt() else 0xFF8E8E93.toInt()
    fun dp(c: Context, n: Int) = (c.resources.displayMetrics.density * n).roundToInt()
    fun shape(c: Context, color: Int, radius: Int) = GradientDrawable().apply { setColor(color); cornerRadius = dp(c, radius).toFloat() }
    fun label(c: Context, value: String, size: Float, color: Int = ink()) = TextView(c).apply {
        text = value; textSize = size; setTextColor(color); includeFontPadding = false
        setTag(R.id.appearance_user_content, true)
    }
    fun senderName(message: JSONObject): String? = sequenceOf("sender_name", "sender_nickname")
        .mapNotNull { message.opt(it) as? String }
        .map { it.trim() }.firstOrNull { it.isNotEmpty() && it != "null" }
    fun action(c: Context, kind: String, description: String, width: Int = 24, onClick: (View) -> Unit): FrameLayout = FrameLayout(c).apply {
        contentDescription = description; isClickable = true; isFocusable = true
        layoutParams = LinearLayout.LayoutParams(dp(c, width), dp(c, 40))
        addView(IOSGroupGlyph(c, kind), FrameLayout.LayoutParams(dp(c, 19), dp(c, 19), Gravity.CENTER))
        setOnClickListener(onClick)
    }
    fun avatar(c: Context, title: String, rawURL: String, loadImage: (ImageView, TextView, String) -> Unit): FrameLayout {
        val sender = title.takeUnless { it.isBlank() || it == "null" }?.trim() ?: "友"
        val initial = sender.substring(0, sender.offsetByCodePoints(0, 1))
        val fallback = label(c, initial, 13f, Color.WHITE).apply {
            gravity = Gravity.CENTER; importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        val image = ImageView(c).apply {
            scaleType = ImageView.ScaleType.CENTER_CROP; tag = "ios-group-avatar"
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        val frame = FrameLayout(c).apply {
            clipToOutline = true; background = shape(c, 0xFF7B74D8.toInt(), 15)
            addView(fallback, FrameLayout.LayoutParams(-1, -1))
            addView(image, FrameLayout.LayoutParams(-1, -1))
        }
        rawURL.takeUnless { it.isBlank() || it == "null" }?.let { loadImage(image, fallback, it) }
        return frame
    }
    fun header(c: Context, title: String, subtitle: String, onBack: () -> Unit, onMore: () -> Unit) = FrameLayout(c).apply {
        setBackgroundColor(surface()); layoutParams = LinearLayout.LayoutParams(-1, dp(c, 44))
        addView(LinearLayout(c).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER
            addView(label(c, title, 16f).apply { id = R.id.group_chat_title; gravity = Gravity.CENTER; typeface = Typeface.DEFAULT_BOLD; maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END })
            addView(label(c, subtitle, 10f, muted()).apply { id = R.id.group_chat_members; gravity = Gravity.CENTER; setPadding(0, dp(c, 1), 0, 0) })
        }, FrameLayout.LayoutParams(-1, -1).apply { leftMargin = dp(c, 52); rightMargin = dp(c, 52) })
        addView(action(c, "back", "返回聊天列表", 44) { onBack() }, FrameLayout.LayoutParams(dp(c, 44), -1, Gravity.START))
        addView(action(c, "more", "群组资料", 44) { onMore() }.apply { id = R.id.channel_details }, FrameLayout.LayoutParams(dp(c, 44), -1, Gravity.END))
    }

    fun message(c: Context, message: JSONObject, mine: Boolean,
                loadImage: (ImageView, TextView, String) -> Unit,
                openMedia: (JSONObject) -> Unit,
                voice: (JSONObject, VoiceMessageView) -> Unit,
                quote: ((JSONObject, Boolean) -> View)? = null,
                loadVideo: (JSONObject, ImageView, TextView, TextView) -> Unit = { _, _, status, _ -> status.text = "点击播放视频" },
                openContact: (JSONObject) -> Unit = {}): LinearLayout {
        val row = LinearLayout(c).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = (if (mine) Gravity.END else Gravity.START) or Gravity.TOP
            layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(c, 12) }
        }
        if (!mine) {
            // Message authors are visible independently of the restricted member roster.
            row.addView(avatar(c, senderName(message) ?: "群成员", message.optString("sender_avatar_url"), loadImage).apply {
                id = R.id.group_message_avatar
            }, LinearLayout.LayoutParams(dp(c, 30), dp(c, 30)).apply { rightMargin = dp(c, 8) })
        }
        val body = message.optJSONObject("body") ?: JSONObject()
        val type = message.optString("type")
        val recalled = !message.isNull("recalled_at") && message.optString("recalled_at").isNotBlank() || message.optString("status") == "recalled"
        val transparent = RichMessageContent.transparentBubble(message) || VoiceMessageView.supported(message)
        val hasImageCaption = RichMessageContent.imageCaption(message).isNotEmpty()
        val textColor = if (mine) Color.WHITE else ink()
        val maxBubble = (c.resources.displayMetrics.widthPixels - dp(c, if (mine) 72 else 110)).coerceAtLeast(dp(c, 120))
        val bubble = LinearLayout(c).apply {
            id = R.id.group_message_bubble; orientation = LinearLayout.VERTICAL
            if (hasImageCaption) { background = shape(c, if (mine) blue else surface(), 12); clipToOutline = true }
            if (!transparent) {
                background = shape(c, if (mine) blue else surface(), 16)
                setPadding(dp(c, 12), dp(c, 9), dp(c, 12), dp(c, 9))
            }
        }
        var quoteWidth: Int? = null
        if (!recalled) body.optJSONObject("reply_to")?.let { original ->
            quote?.invoke(original, mine && !transparent)?.let {
                val width = (maxBubble - dp(c, 24)).coerceAtLeast(dp(c, 72)).coerceAtMost(dp(c, 230))
                quoteWidth = width
                bubble.addView(it, LinearLayout.LayoutParams(width, -2).apply { bottomMargin = dp(c, 7) })
            }
        }
        val timestamp = Regex("[T ](\\d{2}:\\d{2})").find(message.optString("created_at"))?.groupValues?.get(1).orEmpty()
        val time = label(c, timestamp, 10f, if (mine && (!transparent || hasImageCaption)) 0xB8FFFFFF.toInt() else muted()).apply {
            id = R.id.group_message_time; typeface = Typeface.create("sans-serif", Typeface.ITALIC); gravity = Gravity.END
            setSingleLine(true)
        }
        if (VoiceMessageView.supported(message)) {
            bubble.addView(VoiceMessageView(c, body, mine, maxBubble).apply { setOnClickListener { voice(message, this) } },
                LinearLayout.LayoutParams(-2, -2).apply { gravity = if (mine) Gravity.END else Gravity.START })
            bubble.addView(time, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(c, 2) })
        } else if (!recalled && RichMessageContent.isVideo(message) && RichMessageContent.string(body, "url").isNotBlank()) {
            bubble.addView(RichMessageContent.video(c, message, mine, maxBubble, loadVideo, openMedia))
            bubble.addView(time, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(c, 4) })
        } else if (!recalled && type == "contact_card" && body.optInt("user_id") > 0) {
            bubble.addView(RichMessageContent.contact(c, message, mine, maxBubble - dp(c, 24), loadImage, openContact))
            bubble.addView(time, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(c, 4) })
        } else if (type == "image" && !recalled && body.optString("url").isNotBlank()) {
            val preview = ImageView(c).apply { scaleType = ImageView.ScaleType.FIT_CENTER; tag = "ios-group-image" }
            val status = label(c, "图片加载中…", 12f, muted()).apply { gravity = Gravity.CENTER }
            val frame = FrameLayout(c).apply {
                id = R.id.group_message_image; contentDescription = "查看聊天图片"
                clipToOutline = true; background = shape(c, Color.TRANSPARENT, 12)
                addView(preview, FrameLayout.LayoutParams(-1, -1)); addView(status, FrameLayout.LayoutParams(-1, -1))
                setOnClickListener { openMedia(message) }
            }
            val size = if (hasImageCaption) RichMessageContent.captionSize(c, message, maxBubble) else dp(c, 230).coerceAtMost(maxBubble) to dp(c, 230)
            bubble.addView(frame, LinearLayout.LayoutParams(size.first, size.second))
            if (hasImageCaption) {
                bubble.addView(RichMessageContent.caption(c, message, size.first, textColor))
                time.setPadding(dp(c, 10), 0, dp(c, 10), dp(c, 6))
            }
            bubble.addView(time, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(c, 4) })
            loadImage(preview, status, body.optString("url"))
        } else {
            val line = GroupMessageTextLine(c, quoteWidth ?: (maxBubble - dp(c, 24)).coerceAtLeast(dp(c, 80)))
            val value = if (recalled) "消息已撤回" else when (type) {
                "voice" -> "语音暂不可用"
                "file", "video" -> (if (type == "video") "▹  " else "▤  ") + body.optString("name").takeUnless { it.isBlank() || it == "null" }.orEmpty().ifBlank { body.optString("file_name").takeUnless { it.isBlank() || it == "null" } ?: if (type == "video") "播放视频" else "打开附件" }
                "contact_card" -> body.optString("nickname", "联系人名片") + "\n用户 ID：${PublicUserId.display(body.opt("public_id"))}\n个人名片"
                "red_packet" -> "历史红包（已停用）"
                "shake" -> "ϟ  " + body.optString("text", "窗口抖动")
                else -> body.optString("text", "消息")
            }
            val content = label(c, value, if (type in listOf("voice", "file", "video")) 14f else 15f, if (recalled) muted() else textColor).apply {
                id = R.id.chat_message_text; maxWidth = (maxBubble - dp(c, 65)).coerceAtLeast(dp(c, 72))
                if (recalled) typeface = Typeface.create("sans-serif", Typeface.ITALIC)
                if (!recalled && type in listOf("file", "video")) { contentDescription = "打开附件"; setOnClickListener { openMedia(message) } }
            }
            line.addView(content)
            if (!message.isNull("edited_at")) line.addView(label(c, "已编辑", 10f, if (mine) 0xB8FFFFFF.toInt() else muted()).apply { setPadding(dp(c, 5), 0, 0, 0) })
            line.addView(time, LinearLayout.LayoutParams(-2, -2).apply { leftMargin = dp(c, 8) })
            bubble.addView(line)
        }
        val column = LinearLayout(c).apply { orientation = LinearLayout.VERTICAL }
        if (!mine && message.optInt("sender_id") > 0) {
            val sender = senderName(message) ?: "群成员"
            column.addView(label(c, sender, 12f, if (AppAppearance.dark) 0xFFB4BED1.toInt() else 0xFF637484.toInt()).apply {
                id = R.id.group_message_sender; maxWidth = maxBubble; maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.END
                contentDescription = "发送者：$sender"
            }, LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = dp(c, 4) })
        }
        column.addView(bubble, LinearLayout.LayoutParams(-2, -2))
        row.addView(column, LinearLayout.LayoutParams(-2, -2))
        return row
    }
}

internal class IOSGroupGlyph(c: Context, var kind: String, var tint: Int = IOSGroupChatStyle.blue): View(c) {
    private val p = Paint(Paint.ANTI_ALIAS_FLAG)
    override fun onDraw(canvas: Canvas) {
        val size = minOf(width, height).toFloat(); canvas.save(); canvas.translate((width-size)/2, (height-size)/2); canvas.scale(size/24, size/24)
        p.color = tint; p.style = Paint.Style.STROKE; p.strokeWidth = 1.9f; p.strokeCap = Paint.Cap.ROUND; p.strokeJoin = Paint.Join.ROUND
        fun path(vararg v: Pair<Float,Float>) { canvas.drawPath(Path().apply { moveTo(v[0].first,v[0].second); v.drop(1).forEach { lineTo(it.first,it.second) } },p) }
        when(kind) {
            "back" -> path(15f to 3f, 6f to 12f, 15f to 21f)
            "more" -> { p.style=Paint.Style.FILL; for(x in floatArrayOf(4f,12f,20f))canvas.drawCircle(x,12f,1.8f,p) }
            "photo" -> { canvas.drawRoundRect(2f,3f,22f,21f,2f,2f,p);canvas.drawCircle(8f,8f,1.7f,p);path(3f to 17f,9f to 11f,13f to 15f,17f to 10f,22f to 15f) }
            "file" -> { canvas.drawPath(Path().apply { moveTo(8f,14f);lineTo(15f,7f);cubicTo(19f,3f,23f,7f,19f,11f);lineTo(9f,21f);cubicTo(4f,26f,-2f,19f,3f,14f);lineTo(14f,3f);cubicTo(17f,0f,22f,1f,23f,4f) },p) }
            "send" -> { path(6f to 11f,12f to 5f,18f to 11f);canvas.drawLine(12f,5f,12f,20f,p) }
            "stop" -> { canvas.drawCircle(12f,12f,10f,p);p.style=Paint.Style.FILL;canvas.drawRect(8f,8f,16f,16f,p) }
            "mic" -> { p.style=Paint.Style.FILL;canvas.drawRoundRect(9f,2f,15f,15f,3f,3f,p);p.style=Paint.Style.STROKE;canvas.drawArc(RectF(6f,7f,18f,19f),0f,180f,false,p);canvas.drawLine(12f,19f,12f,23f,p) }
        }
        canvas.restore()
    }
}

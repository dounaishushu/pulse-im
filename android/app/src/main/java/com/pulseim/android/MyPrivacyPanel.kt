package com.pulseim.android

import android.app.Dialog
import android.content.Context
import android.graphics.*
import android.graphics.drawable.ColorDrawable
import android.view.*
import android.widget.*
import org.json.JSONObject

/** Reference cards retain their spacing while the enclosing MyScreen handles scrolling. */
internal class MyPrivacyPanel(context: Context) : ChatScreen(context) {
    init { setOnApplyWindowInsetsListener { _, insets -> insets }; setBackgroundColor(Color.TRANSPARENT) }
    fun section(title: String, top: Int = 58) {
        addView(label(title, 15.5f, MY_BLUE), LayoutParams(-1, -2).apply { setMargins(px(88), px(top), px(40), px(28)) })
    }
    fun card(top: Int = 0) = LinearLayout(context).apply {
        orientation = VERTICAL; background = surface(Color.WHITE, 24)
        this@MyPrivacyPanel.addView(this, LayoutParams(-1, -2).apply { setMargins(px(39), px(top), px(39), 0) })
    }
    fun entry(parent: LinearLayout, title: String, value: String, viewId: Int, icon: String? = null, color: Int = MY_BLUE, last: Boolean = false, click: () -> Unit) {
        parent.addView(LinearLayout(context).apply {
            id = viewId; gravity = Gravity.CENTER_VERTICAL; minimumHeight = maxOf(px(126), dp(52)); setPadding(px(49), px(15), px(34), px(15))
            if (icon != null) addView(PrivacyGlyph(context, icon, color), LayoutParams(px(43), px(43)).apply { rightMargin = px(30) })
            addView(label(title, 16f), LayoutParams(0, -2, 1f))
            addView(label(value, 15f, CHAT_GREY))
            addView(MyGlyph(context, "chevron", 0xFFCACBCD.toInt()), LayoutParams(px(25), px(35)).apply { leftMargin = px(20) })
            setOnClickListener { click() }
        })
        if (!last) line(parent)
    }
    fun radio(parent: LinearLayout, title: String, selected: Boolean, viewId: Int, click: () -> Unit) {
        parent.addView(LinearLayout(context).apply {
            id = viewId; gravity = Gravity.CENTER_VERTICAL; minimumHeight = maxOf(px(126), dp(52)); setPadding(px(49), px(15), px(47), px(15))
            contentDescription = "$title，${if (selected) "已选中" else "未选中"}"; isSelected = selected
            addView(label(title, 16.5f), LayoutParams(0, -2, 1f))
            addView(PrivacyGlyph(context, if (selected) "selected" else "radio", MY_BLUE), LayoutParams(px(44), px(44)))
            setOnClickListener { click() }
        })
        if (parent.childCount > 1) parent.addView(View(context).apply { setBackgroundColor(0xFFEEEEEE.toInt()) }, parent.childCount - 1, LayoutParams(-1, 1).apply { setMargins(px(49), 0, px(34), 0) })
    }
    private fun line(parent: LinearLayout) { parent.addView(View(context).apply { setBackgroundColor(0xFFEEEEEE.toInt()) }, LayoutParams(-1, 1).apply { setMargins(px(49), 0, px(34), 0) }) }
    fun help(value: String, centered: Boolean = false) {
        addView(label(value, 12.5f, CHAT_GREY).apply { if (centered) gravity = Gravity.CENTER; setLineSpacing(px(8).toFloat(), 1f) }, LayoutParams(-1, -2).apply { setMargins(px(88), px(22), px(88), 0) })
    }
    fun person(parent: LinearLayout, user: JSONObject, viewId: Int, resolveAvatar: (String) -> String, right: String, click: () -> Unit) {
        val name = jsonText(user, "nickname").ifBlank { jsonText(user, "name") }
        parent.addView(LinearLayout(context).apply {
            id = viewId; contentDescription = "$name，$right"; gravity = Gravity.CENTER_VERTICAL; minimumHeight = px(146); setPadding(px(36), px(18), px(36), px(18))
            addView(FrameLayout(context).apply {
                background = surface(0xFF77A6D8.toInt(), 52); clipToOutline = true
                addView(label(name.take(1), 19f, Color.WHITE).apply { gravity = Gravity.CENTER; setTag(R.id.appearance_user_content, true) }, FrameLayout.LayoutParams(-1, -1))
                jsonText(user, "avatar_url").takeIf { it.isNotBlank() }?.let { url -> addView(ImageView(context).apply { scaleType = ImageView.ScaleType.CENTER_CROP; ChatAvatars.bind(this, resolveAvatar(url)) }, FrameLayout.LayoutParams(-1, -1)) }
            }, LayoutParams(px(96), px(96)))
            addView(LinearLayout(context).apply {
                orientation = VERTICAL
                addView(label(name, 16f).apply { maxLines = 1; setTag(R.id.appearance_user_content, true) })
                jsonText(user, "username").takeIf { it.isNotBlank() }?.let { addView(label("@$it", 13f, CHAT_GREY).apply { setTag(R.id.appearance_user_content, true) }) }
            }, LayoutParams(0, -2, 1f).apply { leftMargin = px(26) })
            addView(label(right, 14f, MY_BLUE)); setOnClickListener { click() }
        }); line(parent)
    }
    fun retention(choose: (Int) -> Unit) {
        val dialog = (context as? android.app.Activity)?.let { BackSwipeDialog(it) } ?: Dialog(context)
        val content = LinearLayout(context).apply { orientation = VERTICAL; background = surface(Color.WHITE, 36) }
        content.addView(label("自动删除账号", 18f).apply { gravity = Gravity.CENTER }, LayoutParams(-1, px(158)))
        listOf(30 to "1个月", 90 to "3个月", 180 to "6个月", 365 to "1年").forEach { (days, title) ->
            content.addView(label(title, 18f, MY_BLUE).apply { id = when (days) { 30 -> R.id.retention_30; 90 -> R.id.retention_90; 180 -> R.id.retention_180; else -> R.id.retention_365 }; gravity = Gravity.CENTER; setOnClickListener { dialog.dismiss(); choose(days) } }, LayoutParams(-1, px(110)))
            line(content)
        }
        content.addView(label("取消", 18f, CHAT_GREY).apply { gravity = Gravity.CENTER; setOnClickListener { dialog.dismiss() } }, LayoutParams(-1, px(115)))
        dialog.setContentView(content); AppAppearance.apply(content)
        dialog.window?.apply { setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT)); setLayout(px(718), -2); addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND); attributes = attributes.apply { dimAmount = .4f } }
        dialog.show(); dialog.window?.setLayout(px(718), -2)
    }
}

internal class PrivacyGlyph(context: Context, private val kind: String, private val tint: Int) : View(context) {
    private val p = Paint(Paint.ANTI_ALIAS_FLAG)
    override fun onDraw(c: Canvas) {
        c.save(); val s = minOf(width, height) / 100f; c.translate((width - s * 100) / 2, (height - s * 100) / 2); c.scale(s, s)
        p.color = tint; p.style = Paint.Style.STROKE; p.strokeWidth = 6f; p.strokeCap = Paint.Cap.ROUND
        when (kind) {
            "block" -> { c.drawCircle(50f, 50f, 41f, p); c.drawLine(21f, 79f, 79f, 21f, p) }
            "key" -> { c.drawCircle(27f, 68f, 18f, p); c.drawLine(40f, 55f, 85f, 10f, p); c.drawLine(65f, 30f, 78f, 43f, p); c.drawLine(78f, 17f, 91f, 30f, p) }
            "scan" -> { for (a in 0..3) { c.save(); c.rotate(90f * a, 50f, 50f); c.drawPath(Path().apply { moveTo(12f, 35f); lineTo(12f, 12f); lineTo(35f, 12f) }, p); c.restore() }; c.drawLine(14f, 50f, 86f, 50f, p) }
            "add-user" -> { c.drawCircle(37f, 25f, 17f, p); c.drawArc(RectF(9f, 47f, 66f, 93f), 180f, 180f, false, p); c.drawLine(77f, 36f, 77f, 70f, p); c.drawLine(60f, 53f, 94f, 53f, p) }
            "selected", "radio" -> { p.color = if (kind == "selected") MY_BLUE else 0xFFBBBBBB.toInt(); p.strokeWidth = 4f; c.drawCircle(50f, 50f, 42f, p); if (kind == "selected") { p.style = Paint.Style.FILL; c.drawCircle(50f, 50f, 30f, p) } }
        }; c.restore()
    }
}

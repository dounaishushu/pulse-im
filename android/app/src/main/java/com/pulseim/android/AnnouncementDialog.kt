package com.pulseim.android

import android.app.Activity
import android.app.Dialog
import android.graphics.*
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject
import kotlin.math.roundToInt

internal fun announcementText(value: String, activity: Activity): String =
    value.replace("{app_name}", activity.getString(R.string.app_name))

/** Native dialog: the card, shield, dim layer and button follow the supplied mobile reference. */
internal class AnnouncementDialog(activity: Activity, notice: JSONObject) : Dialog(activity) {
    init {
        requestWindowFeature(Window.FEATURE_NO_TITLE)
        val metrics = activity.resources.displayMetrics
        val cardWidth = minOf((metrics.widthPixels * 679f / 873f).roundToInt(), (480 * metrics.density).roundToInt())
        fun px(value: Int) = (value * cardWidth / 679f).roundToInt()
        fun label(value: String, size: Float, color: Int) = TextView(activity).apply {
            text = announcementText(value, activity); textSize = size; setTextColor(color)
            gravity = Gravity.CENTER; includeFontPadding = false
        }
        val card = LinearLayout(activity).apply {
            id = R.id.announcement_dialog; orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL
            setPadding(px(58), px(48), px(58), px(60))
            background = GradientDrawable().apply { setColor(Color.WHITE); cornerRadius = px(48).toFloat() }
        }
        card.addView(AnnouncementShieldView(activity), LinearLayout.LayoutParams(px(130), px(130)))
        val title = label(notice.optString("title", "官方提示"), 21f, Color.BLACK).apply {
            id = R.id.announcement_title; typeface = Typeface.DEFAULT_BOLD
        }
        card.addView(title, LinearLayout.LayoutParams(-1, -2).apply { topMargin = px(18) })
        val body = label(notice.optString("content"), 14.5f, CHAT_GREY).apply {
            id = R.id.announcement_content; setLineSpacing(px(12).toFloat(), 1f)
        }
        val scroll = ScrollView(activity).apply {
            id = R.id.announcement_scroll; isFillViewport = false; scrollBarSize = maxOf(1, px(3))
            addView(body, ViewGroup.LayoutParams(-1, -2))
        }
        card.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f).apply { topMargin = px(26) })
        val confirm = label("我知道了", 16f, Color.WHITE).apply {
            id = R.id.announcement_confirm; isFocusable = true
            background = GradientDrawable().apply { setColor(CHAT_BLUE); cornerRadius = px(54).toFloat() }
            setOnClickListener { dismiss() }
        }
        card.addView(confirm, LinearLayout.LayoutParams(-1, px(108)).apply { topMargin = px(36) })
        val textWidth = cardWidth - px(116)
        val widthSpec = View.MeasureSpec.makeMeasureSpec(textWidth, View.MeasureSpec.EXACTLY)
        val heightSpec = View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED)
        title.measure(widthSpec, heightSpec); body.measure(widthSpec, heightSpec)
        val fixedHeight = px(48 + 130 + 18 + 26 + 36 + 108 + 60) + title.measuredHeight
        val height = maxOf(px(650), fixedHeight + body.measuredHeight).coerceAtMost((metrics.heightPixels * .84f).roundToInt())
        setContentView(card, ViewGroup.LayoutParams(cardWidth, height))
        setCanceledOnTouchOutside(false)
        window?.apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT)); setLayout(cardWidth, height)
            setGravity(Gravity.CENTER); addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            attributes = attributes.apply { dimAmount = .48f }
        }
    }
}

/** Resolution-independent shield with a blue gradient and a soft shadow. */
private class AnnouncementShieldView(context: android.content.Context) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    init { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO; setLayerType(LAYER_TYPE_SOFTWARE, null) }
    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val save = canvas.save(); canvas.scale(width / 160f, height / 160f)
        paint.shader = null; paint.color = 0x186295FF; canvas.drawOval(39f, 136f, 125f, 149f, paint)
        val shield = Path().apply {
            moveTo(80f, 11f); lineTo(140f, 37f); lineTo(140f, 80f)
            cubicTo(140f, 116f, 113f, 137f, 80f, 150f)
            cubicTo(47f, 137f, 20f, 116f, 20f, 80f); lineTo(20f, 37f); close()
        }
        paint.color = Color.WHITE
        paint.shader = LinearGradient(28f, 18f, 132f, 144f, intArrayOf(0xFF97CBFF.toInt(), 0xFF5E9BFF.toInt(), 0xFF3975F5.toInt()), null, Shader.TileMode.CLAMP)
        paint.setShadowLayer(5f, 2f, 5f, 0x305588F9); canvas.drawPath(shield, paint); paint.clearShadowLayer()
        canvas.save(); canvas.scale(.77f, .79f, 80f, 80f)
        paint.shader = LinearGradient(40f, 26f, 120f, 130f, Color.WHITE, 0xFFEEF4FF.toInt(), Shader.TileMode.CLAMP)
        canvas.drawPath(shield, paint); canvas.restore()
        paint.shader = LinearGradient(75f, 49f, 85f, 117f, 0xFF7BAAFF.toInt(), 0xFF437CF1.toInt(), Shader.TileMode.CLAMP)
        canvas.drawRoundRect(73.5f, 48f, 86.5f, 92f, 6.5f, 6.5f, paint)
        canvas.drawCircle(80f, 108f, 7f, paint); canvas.restoreToCount(save)
    }
}

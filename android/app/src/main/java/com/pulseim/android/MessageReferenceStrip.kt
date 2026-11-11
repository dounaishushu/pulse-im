package com.pulseim.android

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView

/** Shared native treatment for the composer quote, pinned header and quote body. */
internal class MessageReferenceStrip(context: Context, title: String, summary: String, iosGroup: Boolean = false, embedded: Boolean = false, mine: Boolean = false) : LinearLayout(context) {
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
    private val accent = if (iosGroup && embedded && mine) Color.WHITE else if (iosGroup) IOSGroupChatStyle.blue else 0xFF4285E8.toInt()
    val image = ImageView(context).apply { scaleType = ImageView.ScaleType.CENTER_CROP }
    val imageStatus = TextView(context).apply { textSize = 9f; maxLines = 1; gravity = Gravity.CENTER }
    val imageBox = FrameLayout(context).apply {
        visibility = View.GONE
        addView(image, FrameLayout.LayoutParams(-1, -1))
        addView(imageStatus, FrameLayout.LayoutParams(-1, -1))
    }
    val extra = TextView(context).apply { textSize = 12f; setTextColor(0xFF4285E8.toInt()); gravity = Gravity.CENTER; minWidth = dp(44); minimumHeight = dp(44); visibility = View.GONE }
    val close = TextView(context).apply { text = "×"; textSize = 24f; setTextColor(0xFF8995A3.toInt()); gravity = Gravity.CENTER; minWidth = dp(44); minimumHeight = dp(44); visibility = View.GONE }
    val nextPin = TextView(context).apply { text = "⌄"; textSize = 20f; setTextColor(IOSGroupChatStyle.muted()); gravity = Gravity.CENTER; visibility = View.GONE }
    init {
        orientation = HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
        setBackgroundColor(if (iosGroup) IOSGroupChatStyle.surface() else Color.WHITE); setPadding(dp(if (iosGroup) 12 else 10), dp(if (iosGroup) 8 else 5), dp(if (iosGroup) 8 else 2), dp(if (iosGroup) 8 else 5))
        if (iosGroup && embedded) { background = IOSGroupChatStyle.shape(context, if (mine) 0x1AFFFFFF else 0x1A2F80ED, 7); setPadding(dp(8), dp(8), dp(8), dp(8)) }
        addView(View(context).apply { setBackgroundColor(accent) }, LayoutParams(dp(3), dp(if (embedded) 34 else 38)))
        addView(imageBox, LayoutParams(dp(if (embedded) 34 else 38), dp(if (embedded) 34 else 38)).apply { leftMargin = dp(8) })
        addView(LinearLayout(context).apply {
            orientation = VERTICAL; setPadding(dp(10), dp(2), dp(8), dp(2))
            addView(TextView(context).apply { text = title; textSize = if (iosGroup) 12f else 13f; typeface = Typeface.DEFAULT_BOLD; setTextColor(accent); maxLines = 1; ellipsize = TextUtils.TruncateAt.END; setTag(R.id.appearance_user_content, true) })
            addView(TextView(context).apply { text = summary; textSize = if (embedded) 12f else 13f; setTextColor(if (iosGroup && embedded) accent else if (AppAppearance.dark) 0xFFB7C3D1.toInt() else 0xFF586777.toInt()); maxLines = if (embedded) 2 else 1; ellipsize = TextUtils.TruncateAt.END; setPadding(0, dp(3), 0, 0); setTag(R.id.appearance_user_content, true) })
        }, LayoutParams(0, -2, 1f))
        if (iosGroup) { extra.minWidth = dp(28); extra.minimumHeight = dp(38); close.minWidth = dp(28); close.minimumHeight = dp(38) }
        addView(nextPin, LayoutParams(dp(28), dp(38)))
        addView(extra, LayoutParams(-2, -2)); addView(close, LayoutParams(-2, -2))
    }
}

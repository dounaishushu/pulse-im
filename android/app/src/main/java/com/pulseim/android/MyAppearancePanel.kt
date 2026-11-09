package com.pulseim.android

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.view.Gravity
import android.widget.*

internal class MyAppearancePanel(context: Context, changeMode: (String) -> Unit) : ChatScreen(context) {
    init {
        setOnApplyWindowInsetsListener { _, insets -> insets }
        setBackgroundColor(Color.TRANSPARENT)
        orientation = VERTICAL
        val modes = LinearLayout(context).apply { orientation = VERTICAL; background = surface(Color.WHITE, 27) }
        listOf(Triple("system", "跟随系统", "自动跟随设备的浅色或深色外观"), Triple("light", "浅色模式", "始终使用浅色外观"), Triple("dark", "深色模式", "始终使用深色外观")).forEach { (mode, title, subtitle) ->
            modes.addView(LinearLayout(context).apply {
                id = when (mode) { "system" -> R.id.appearance_system; "light" -> R.id.appearance_light; else -> R.id.appearance_dark }
                gravity = Gravity.CENTER_VERTICAL; setPadding(px(38), 0, px(39), 0); contentDescription = "$title ${if (AppAppearance.mode == mode) "已选中" else "未选中"}"
                addView(LinearLayout(context).apply {
                    orientation = VERTICAL; addView(label(title, 17f)); addView(label(subtitle, 12.5f, CHAT_GREY), LayoutParams(-1, -2).apply { topMargin = px(12) })
                }, LayoutParams(0, -2, 1f))
                if (AppAppearance.mode == mode) addView(AccountGlyph(context, "check", MY_BLUE), LayoutParams(px(52), px(52)))
                setOnClickListener { changeMode(mode) }
            }, LayoutParams(-1, px(126)))
        }
        addView(modes, LayoutParams(-1, px(378)).apply { setMargins(px(39), px(45), px(39), 0) })
        addView(label("消息文字大小", 16.5f, MY_BLUE), LayoutParams(-1, px(69)).apply { setMargins(px(39), px(38), px(39), 0) })
        val value = label(AppAppearance.messageSize.toString(), 16f).apply { id = R.id.appearance_font_value; gravity = Gravity.CENTER }
        val incoming = label("这是预览文字", AppAppearance.messageSize.toFloat()).apply { id = R.id.appearance_preview_in; setTag(R.id.appearance_message, true); setTag(R.id.appearance_user_content, true) }
        val outgoing = label("这是预览文字", AppAppearance.messageSize.toFloat(), Color.WHITE).apply {
            id = R.id.appearance_preview_out; setTag(R.id.appearance_message, true); setTag(R.id.appearance_user_content, true)
            background = surface(MY_BLUE, 28); setPadding(px(25), px(20), px(25), px(20))
        }
        val preview = LinearLayout(context).apply {
            orientation = VERTICAL; setBackgroundColor(Color.WHITE); setPadding(px(39), 0, px(39), px(40))
            addView(LinearLayout(context).apply {
                gravity = Gravity.CENTER_VERTICAL
                addView(SeekBar(context).apply {
                    id = R.id.appearance_font_slider; min = 12; max = 24; progress = AppAppearance.messageSize; contentDescription = "消息文字大小"
                    progressTintList = ColorStateList.valueOf(MY_BLUE); progressBackgroundTintList = ColorStateList.valueOf(0xFFE1E1E1.toInt()); thumbTintList = ColorStateList.valueOf(MY_BLUE)
                    setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                        override fun onProgressChanged(bar: SeekBar?, progress: Int, fromUser: Boolean) {
                            if (!fromUser) return
                            AppAppearance.set(context, "message_size", progress.toString()); value.text = progress.toString()
                            incoming.textSize = progress.toFloat(); outgoing.textSize = progress.toFloat()
                        }
                        override fun onStartTrackingTouch(bar: SeekBar?) {}
                        override fun onStopTrackingTouch(bar: SeekBar?) {}
                    })
                }, LayoutParams(0, px(108), 1f).apply { rightMargin = px(35) })
                addView(value, LayoutParams(px(61), -1))
            })
            addView(incoming, LayoutParams(-2, -2).apply { topMargin = px(41) })
            addView(outgoing, LayoutParams(-2, -2).apply { gravity = Gravity.END; topMargin = px(65) })
        }
        addView(preview, LayoutParams(-1, -2))
    }
}

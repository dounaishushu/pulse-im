package com.pulseim.android

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.view.View
import android.widget.LinearLayout
import android.widget.ScrollView

/** Floats inside the message viewport, so IME and composer resizing cannot cover it. */
internal class ChatScrollBottom(c: Context, private val scroll: ScrollView, private val messages: LinearLayout,
    private val current: () -> Boolean, private val jump: (ChatScrollBottom) -> Unit) : View(c) {
    var retryRequired = false
        private set
    private var loading = false
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val layout = OnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> refresh() }
    init {
        id = R.id.chat_scroll_bottom; visibility = GONE; isFocusable = true
        contentDescription = "回到底部"
        background = IOSGroupChatStyle.shape(c, if (AppAppearance.dark) 0xFF303B42.toInt() else Color.WHITE, 24).apply {
            setStroke(IOSGroupChatStyle.dp(c, 1), if (AppAppearance.dark) 0xFF50606B.toInt() else 0xFFDFE6EB.toInt())
        }
        elevation = IOSGroupChatStyle.dp(c, 3).toFloat()
        setOnClickListener { if (current() && !loading) jump(this) }
    }
    fun begin() { loading = true; isEnabled = false; contentDescription = "正在回到最新消息"; alpha = .65f; refresh() }
    fun complete(success: Boolean) {
        loading = false; retryRequired = !success; isEnabled = true; alpha = 1f
        contentDescription = if (success) "回到底部" else "加载最新消息失败，点击重试"
        refresh()
    }
    private fun refresh() {
        val distance = messages.height - scroll.scrollY - scroll.height
        visibility = if (current() && scroll.isShown && scroll.height > 0 && (loading || retryRequired || distance > IOSGroupChatStyle.dp(context, 64))) VISIBLE else GONE
    }
    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        scroll.setOnScrollChangeListener { _: View, _: Int, _: Int, _: Int, _: Int -> refresh() }
        scroll.addOnLayoutChangeListener(layout); messages.addOnLayoutChangeListener(layout); post { refresh() }
    }
    override fun onDetachedFromWindow() {
        scroll.setOnScrollChangeListener(null); scroll.removeOnLayoutChangeListener(layout); messages.removeOnLayoutChangeListener(layout)
        super.onDetachedFromWindow()
    }
    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val unit = minOf(width, height) / 24f
        paint.style = Paint.Style.STROKE; paint.strokeWidth = 1.7f * unit; paint.strokeCap = Paint.Cap.ROUND; paint.strokeJoin = Paint.Join.ROUND
        paint.color = if (AppAppearance.dark) 0xFFDDE5EB.toInt() else 0xFF83909A.toInt()
        canvas.drawPath(Path().apply { moveTo(width/2f-5*unit,height/2f-2*unit); lineTo(width/2f,height/2f+3*unit); lineTo(width/2f+5*unit,height/2f-2*unit) },paint)
    }
}

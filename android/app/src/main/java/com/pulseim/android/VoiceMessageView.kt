package com.pulseim.android

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.os.SystemClock
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONObject

/** One voice bar for both private and group messages; playback stays in GroupMessageMedia. */
internal class VoiceMessageView(c: Context, body: JSONObject, private val mine: Boolean, private val maxWidth: Int) : View(c) {
    var durationSeconds = seconds(body)
        private set
    var playing = false
        private set
    var loading = false
        private set
    var failed = false
        private set
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val density = resources.displayMetrics.density
    private val textPixels = 14f * resources.displayMetrics.scaledDensity * AppAppearance.fontScale
    private val frame = object : Runnable {
        override fun run() {
            if (!isAttachedToWindow || !isShown || (!playing && !loading)) return
            invalidate(); postDelayed(this, 140)
        }
    }

    init {
        id = R.id.chat_message_voice
        isFocusable = true; minimumHeight = dp(48)
        updateDescription()
    }

    fun render(state: GroupMessageMedia.VoiceState) {
        val previous = durationSeconds
        if (state.durationSeconds > 0) durationSeconds = state.durationSeconds.coerceAtMost(300)
        playing = state.playing; loading = state.loading; failed = !state.error.isNullOrBlank()
        updateDescription(); removeCallbacks(frame)
        if (previous != durationSeconds) requestLayout()
        if (playing || loading) post(frame)
        invalidate()
    }

    private fun updateDescription() {
        contentDescription = "${when { loading -> "正在加载语音"; playing -> "暂停语音消息"; failed -> "语音播放失败，点击重试"; else -> "播放语音消息" }}，${durationSeconds}秒"
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val preferred = dp((104 + durationSeconds.coerceAtMost(45) * 3).coerceAtMost(240))
        setMeasuredDimension(resolveSize(preferred.coerceAtMost(maxWidth.coerceAtLeast(dp(72))), widthMeasureSpec), resolveSize(dp(48), heightMeasureSpec))
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val tail = dp(5).toFloat()
        val left = if (mine) 0f else tail
        val right = width.toFloat() - if (mine) tail else 0f
        val center = height / 2f
        paint.style = Paint.Style.FILL
        paint.color = if (mine) { if (AppAppearance.dark) 0xFF75C957.toInt() else 0xFF95EC69.toInt() }
            else { if (AppAppearance.dark) 0xFF2B303A.toInt() else Color.WHITE }
        canvas.drawRoundRect(left, dp(3).toFloat(), right, height - dp(3).toFloat(), dp(8).toFloat(), dp(8).toFloat(), paint)
        canvas.drawPath(Path().apply {
            val edge = if (mine) right - 1 else left + 1
            moveTo(edge, center - tail); lineTo(if (mine) width.toFloat() else 0f, center); lineTo(edge, center + tail); close()
        }, paint)
        paint.color = if (mine) 0xFF15310C.toInt() else if (AppAppearance.dark) 0xFFF1F4F8.toInt() else 0xFF252A31.toInt()
        paint.textSize = textPixels; paint.typeface = android.graphics.Typeface.DEFAULT
        paint.textAlign = if (mine) Paint.Align.RIGHT else Paint.Align.LEFT
        val baseline = center - (paint.fontMetrics.ascent + paint.fontMetrics.descent) / 2
        canvas.drawText("${durationSeconds}\"", if (mine) right - dp(41) else left + dp(41), baseline, paint)
        canvas.save()
        canvas.translate(if (mine) right - dp(22) else left + dp(22), center)
        if (mine) canvas.scale(-1f, 1f)
        if (loading) {
            paint.style = Paint.Style.STROKE; paint.strokeWidth = 1.8f * density; paint.strokeCap = Paint.Cap.ROUND
            val r = dp(8).toFloat()
            canvas.drawArc(RectF(-r, -r, r, r), (SystemClock.uptimeMillis() % 1000) * .36f, 245f, false, paint)
        } else {
            val waves = if (playing) ((SystemClock.uptimeMillis() / 280) % 3 + 1).toInt() else 3
            paint.style = Paint.Style.FILL; canvas.drawCircle(-5f * density, 0f, 1.6f * density, paint)
            paint.style = Paint.Style.STROKE; paint.strokeWidth = 1.8f * density; paint.strokeCap = Paint.Cap.ROUND
            for (i in 1..waves) {
                val r = (3.5f * i + 1) * density; val x = -6f * density
                canvas.drawArc(RectF(x - r, -r, x + r, r), -55f, 110f, false, paint)
            }
        }
        canvas.restore()
        if (failed) {
            paint.style = Paint.Style.FILL; paint.textSize = 12f * resources.displayMetrics.scaledDensity
            paint.textAlign = if (mine) Paint.Align.LEFT else Paint.Align.RIGHT
            canvas.drawText("!", if (mine) left + dp(13) else right - dp(13), baseline, paint)
        }
    }

    override fun onInitializeAccessibilityNodeInfo(info: AccessibilityNodeInfo) {
        super.onInitializeAccessibilityNodeInfo(info)
        info.className = android.widget.Button::class.java.name; info.text = "${durationSeconds}秒语音"
    }

    override fun onDetachedFromWindow() {
        removeCallbacks(frame); playing = false; loading = false
        updateDescription(); super.onDetachedFromWindow()
    }

    override fun onWindowVisibilityChanged(visibility: Int) {
        super.onWindowVisibilityChanged(visibility)
        if (visibility != VISIBLE) {
            removeCallbacks(frame); playing = false; loading = false
            updateDescription(); invalidate()
        }
    }

    private fun dp(value: Int) = IOSGroupChatStyle.dp(context, value)

    companion object {
        fun supported(message: JSONObject): Boolean = message.optString("type") == "voice" && RichMessageContent.available(message) &&
            RichMessageContent.string(message.optJSONObject("body") ?: JSONObject(), "url").isNotBlank()
        private fun seconds(body: JSONObject): Int {
            val ms = body.optLong("duration_ms").coerceIn(0, 300000)
            return if (ms > 0) ((ms + 999) / 1000).toInt() else body.optInt("duration_seconds", 1).coerceIn(1, 300)
        }
    }
}

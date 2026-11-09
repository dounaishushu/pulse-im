package com.pulseim.android

import android.content.Context
import android.graphics.*
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.TextView
import kotlin.math.roundToInt

/** Layout proportions come from the 873 × 1920 channel reference. */
internal class ChannelEmptyState(context: Context) : FrameLayout(context) {
    val illustration: View = ChannelIllustration(context).apply {
        id = R.id.channels_illustration
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    }
    val caption = TextView(context).apply {
        id = R.id.contacts_empty
        textSize = 14.5f
        setTextColor(0xFF68686B.toInt())
        includeFontPadding = false
        gravity = Gravity.CENTER
        accessibilityLiveRegion = ACCESSIBILITY_LIVE_REGION_POLITE
    }

    init {
        id = R.id.channels_empty_state
        addView(illustration, LayoutParams(1, 1))
        addView(caption, LayoutParams(-1, -2))
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val width = MeasureSpec.getSize(widthMeasureSpec)
        val height = MeasureSpec.getSize(heightMeasureSpec)
        val unit = width / 873f
        illustration.measure(MeasureSpec.makeMeasureSpec((400 * unit).roundToInt().coerceAtMost(width), MeasureSpec.EXACTLY),
            MeasureSpec.makeMeasureSpec(minOf((370 * unit).roundToInt(), (height * .43f).roundToInt()), MeasureSpec.EXACTLY))
        caption.measure(MeasureSpec.makeMeasureSpec((width - 64 * unit).roundToInt().coerceAtLeast(0), MeasureSpec.EXACTLY),
            MeasureSpec.makeMeasureSpec(height, MeasureSpec.AT_MOST))
        setMeasuredDimension(width, height)
    }

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        val artLeft = (width - illustration.measuredWidth) / 2
        val artTop = (height * .492f - illustration.measuredHeight / 2f).roundToInt()
        illustration.layout(artLeft, artTop, artLeft + illustration.measuredWidth, artTop + illustration.measuredHeight)
        val textLeft = (width - caption.measuredWidth) / 2
        val textTop = (height * .706f - caption.measuredHeight / 2f).roundToInt()
        caption.layout(textLeft, textTop, textLeft + caption.measuredWidth, textTop + caption.measuredHeight)
    }
}

/** Native blue message-board artwork, rendered at the actual device resolution. */
private class ChannelIllustration(context: Context) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val rear = Path().apply {
        moveTo(154f, 37f); cubicTo(143f, 31f, 131f, 38f, 131f, 51f)
        lineTo(131f, 181f); cubicTo(131f, 192f, 136f, 201f, 145f, 205f)
        lineTo(292f, 265f); cubicTo(302f, 269f, 312f, 263f, 312f, 251f)
        lineTo(312f, 126f); cubicTo(312f, 116f, 307f, 107f, 298f, 102f); close()
    }
    private val face = Path().apply {
        moveTo(172f, 49f); cubicTo(161f, 44f, 152f, 50f, 152f, 62f)
        lineTo(152f, 188f); cubicTo(152f, 200f, 157f, 208f, 166f, 212f)
        lineTo(310f, 273f); cubicTo(322f, 278f, 332f, 272f, 332f, 259f)
        lineTo(332f, 137f); cubicTo(332f, 125f, 327f, 117f, 317f, 112f); close()
    }

    init { setLayerType(LAYER_TYPE_SOFTWARE, null) }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val scale = minOf(width / 400f, height / 370f)
        canvas.save()
        canvas.translate((width - 400 * scale) / 2f, (height - 370 * scale) / 2f)
        canvas.scale(scale, scale)
        paint.color = 0x297E9BCD
        paint.maskFilter = BlurMaskFilter(16f, BlurMaskFilter.Blur.NORMAL)
        canvas.drawOval(20f, 200f, 387f, 334f, paint)
        paint.maskFilter = null
        paint.color = Color.WHITE
        paint.shader = RadialGradient(214f, 257f, 186f, intArrayOf(0x31CCD9F5, 0x14DCE5F8, 0x00E8ECFD), floatArrayOf(0f, .6f, 1f), Shader.TileMode.CLAMP)
        canvas.drawOval(8f, 179f, 399f, 354f, paint)
        paint.shader = null
        sphere(canvas, 83f, 47f, 23f)
        sphere(canvas, 359f, 133f, 12f)
        tree(canvas, 45f, 238f, 23f, 73f)
        tree(canvas, 78f, 198f, 18f, 55f)
        tree(canvas, 371f, 226f, 21f, 60f)

        paint.shader = LinearGradient(134f, 38f, 304f, 264f, intArrayOf(0xFFB4D6F7.toInt(), 0xFF4D95EA.toInt(), 0xFF679FED.toInt()), floatArrayOf(0f, .46f, 1f), Shader.TileMode.CLAMP)
        paint.setShadowLayer(10f, 4f, 9f, 0x2686ACE3)
        canvas.drawPath(rear, paint)
        paint.clearShadowLayer()
        paint.shader = LinearGradient(169f, 49f, 327f, 271f, intArrayOf(0xFF81B9FA.toInt(), 0xFFBDDEFB.toInt(), 0xFFE5F3FD.toInt()), floatArrayOf(0f, .57f, 1f), Shader.TileMode.CLAMP)
        canvas.drawPath(face, paint)
        canvas.save()
        canvas.clipPath(face)
        paint.shader = RadialGradient(255f, 163f, 152f, 0x78E8FAFF, 0x00DFEBFF, Shader.TileMode.CLAMP)
        canvas.drawRect(145f, 43f, 337f, 280f, paint)
        canvas.restore()
        paint.shader = LinearGradient(154f, 49f, 331f, 268f, 0x3296C1F6, 0xC4EAF8FF.toInt(), Shader.TileMode.CLAMP)
        paint.style = Paint.Style.STROKE; paint.strokeWidth = 2f
        canvas.drawPath(face, paint)
        paint.style = Paint.Style.FILL; paint.shader = null
        paint.color = 0xECF1FCFF.toInt()
        paint.setShadowLayer(4f, 0f, 0f, 0x65E5FFFF)
        canvas.save()
        // The three dots follow the perspective of the message board.
        val perspective = Matrix().apply { setValues(floatArrayOf(1f, 0f, 0f, .43f, 1f, 0f, 0f, 0f, 1f)) }
        canvas.concat(perspective)
        for (x in floatArrayOf(193f, 241f, 289f)) canvas.drawCircle(x, 55f, 9f, paint)
        canvas.restore()
        paint.clearShadowLayer()
        canvas.restore()
    }

    private fun sphere(canvas: Canvas, x: Float, y: Float, r: Float) {
        paint.shader = RadialGradient(x - r * .32f, y - r * .4f, r * 1.45f,
            intArrayOf(0xFFF3F9FF.toInt(), 0xFFAFD6F3.toInt(), 0xFF7EB7E7.toInt()), floatArrayOf(0f, .58f, 1f), Shader.TileMode.CLAMP)
        canvas.drawCircle(x, y, r, paint); paint.shader = null
    }

    private fun tree(canvas: Canvas, x: Float, y: Float, w: Float, h: Float) {
        paint.shader = LinearGradient(x - w / 2, y - h / 2, x + w / 2, y + h / 2, 0xFFCCE5F8.toInt(), 0xFF74A7E7.toInt(), Shader.TileMode.CLAMP)
        canvas.drawRoundRect(x - w * .08f, y, x + w * .08f, y + h / 2, 2f, 2f, paint)
        canvas.drawPath(Path().apply { moveTo(x, y - h / 2); lineTo(x + w / 2, y + h * .25f); quadTo(x, y + h * .4f, x - w / 2, y + h * .25f); close() }, paint)
        paint.shader = null
    }
}

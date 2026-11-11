package com.pulseim.android

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.*
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.view.animation.LinearInterpolator
import android.widget.FrameLayout
import android.widget.TextView
import kotlin.math.roundToInt

/** Empty-state geometry follows the supplied 873 × 1920 new-friends reference. */
class NewFriendsEmptyState(context: Context) : FrameLayout(context) {
    val illustration = NewFriendsIllustration(context).apply {
        id = R.id.new_friends_illustration
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
        id = R.id.new_friends_empty_state
        addView(illustration, LayoutParams(1, 1))
        addView(caption, LayoutParams(-1, -2))
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val width = MeasureSpec.getSize(widthMeasureSpec)
        val height = MeasureSpec.getSize(heightMeasureSpec)
        val unit = width / 873f
        val artWidth = minOf((400 * unit).roundToInt(), width)
        val artHeight = minOf((370 * unit).roundToInt(), (height * .43f).roundToInt())
        illustration.measure(MeasureSpec.makeMeasureSpec(artWidth, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(artHeight, MeasureSpec.EXACTLY))
        caption.measure(MeasureSpec.makeMeasureSpec((width - 64 * unit).roundToInt().coerceAtLeast(0), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(height.coerceAtLeast(0), MeasureSpec.AT_MOST))
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

/** Visible only during a pull gesture or its pending refresh request. */
class NewFriendsRefreshView(context: Context) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private var angle = 0f
    private var busy = false
    private val animator = ValueAnimator.ofFloat(0f, 360f).apply {
        duration = 950
        repeatCount = ValueAnimator.INFINITE
        interpolator = LinearInterpolator()
        addUpdateListener { angle = it.animatedValue as Float; invalidate() }
    }

    init {
        id = R.id.new_friends_refresh
        visibility = GONE
        background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(0xFFFCFCFF.toInt()) }
        elevation = 4f * resources.displayMetrics.density
        contentDescription = "下拉刷新好友申请"
    }

    fun setPullProgress(progress: Float) {
        if (busy) return
        visibility = if (progress > 0f) VISIBLE else GONE
        angle = progress.coerceIn(0f, 1.5f) * 180f
        contentDescription = if (progress >= 1f) "松开刷新好友申请" else "下拉刷新好友申请"
        invalidate()
    }

    fun setBusy(value: Boolean) {
        busy = value
        visibility = if (value) VISIBLE else GONE
        contentDescription = if (value) "正在刷新好友申请" else "下拉刷新好友申请"
        if (value && isAttachedToWindow && !animator.isRunning) animator.start()
        else if (!value) { animator.cancel(); angle = 0f; invalidate() }
    }

    override fun onAttachedToWindow() { super.onAttachedToWindow(); if (busy) animator.start() }
    override fun onDetachedFromWindow() { animator.cancel(); super.onDetachedFromWindow() }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        canvas.save()
        canvas.scale(width / 100f, height / 100f)
        canvas.rotate(angle, 50f, 50f)
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = 5.5f
        paint.strokeCap = Paint.Cap.ROUND
        paint.shader = LinearGradient(27f, 32f, 73f, 72f, 0xFFD3D7F0.toInt(), 0xFF999FD7.toInt(), Shader.TileMode.CLAMP)
        canvas.drawArc(RectF(27f, 30f, 73f, 72f), 7f, 183f, false, paint)
        paint.shader = null
        canvas.restore()
    }
}

/** The blue glass shield, floating spheres and arrows are drawn as native UI artwork. */
class NewFriendsIllustration(context: Context) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val rear = Path().apply {
        moveTo(212f, 7f)
        cubicTo(219f, 4f, 225f, 7f, 232f, 11f)
        lineTo(288f, 37f)
        cubicTo(296f, 41f, 300f, 48f, 300f, 56f)
        lineTo(300f, 125f)
        cubicTo(297f, 164f, 269f, 190f, 224f, 207f)
        cubicTo(217f, 211f, 211f, 210f, 205f, 207f)
        cubicTo(160f, 187f, 137f, 154f, 137f, 123f)
        lineTo(137f, 52f)
        cubicTo(137f, 45f, 141f, 39f, 149f, 36f)
        close()
    }
    private val rim = Path().apply {
        moveTo(222f, 26f)
        lineTo(280f, 53f)
        cubicTo(286f, 56f, 289f, 61f, 289f, 68f)
        lineTo(289f, 127f)
        cubicTo(288f, 161f, 263f, 187f, 222f, 204f)
        cubicTo(181f, 185f, 157f, 157f, 157f, 126f)
        lineTo(157f, 67f)
        cubicTo(157f, 60f, 159f, 56f, 166f, 53f)
        close()
    }
    private val face = Path().apply {
        moveTo(222f, 38f)
        lineTo(270f, 61f)
        cubicTo(276f, 64f, 278f, 68f, 278f, 75f)
        lineTo(278f, 125f)
        cubicTo(276f, 154f, 258f, 176f, 222f, 192f)
        cubicTo(187f, 175f, 169f, 152f, 169f, 124f)
        lineTo(169f, 75f)
        cubicTo(169f, 68f, 170f, 64f, 177f, 61f)
        close()
    }

    init { setLayerType(LAYER_TYPE_SOFTWARE, null) }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val scale = minOf(width / 400f, height / 370f)
        canvas.save()
        canvas.translate((width - 400 * scale) / 2f, (height - 370 * scale) / 2f)
        canvas.scale(scale, scale)
        paint.style = Paint.Style.FILL
        paint.maskFilter = BlurMaskFilter(15f, BlurMaskFilter.Blur.NORMAL)
        paint.color = 0x297E9BCD
        canvas.drawOval(24f, 151f, 386f, 310f, paint)
        paint.color = 0x2199ABD0
        canvas.drawOval(71f, 180f, 344f, 338f, paint)
        paint.maskFilter = null
        // Paint alpha also multiplies shader colors. Reset the translucent
        // ground paint before drawing the blue shield and its surrounding shapes.
        paint.color = Color.WHITE
        paint.shader = RadialGradient(213f, 208f, 192f, intArrayOf(0x34CCD9F5, 0x12DCE5F8, 0x00E8ECFD), floatArrayOf(0f, .65f, 1f), Shader.TileMode.CLAMP)
        canvas.drawOval(19f, 144f, 395f, 341f, paint)
        paint.shader = null

        sphere(canvas, 103f, 47f, 22f, 0xFFF3F9FF.toInt(), 0xFFAFD6F3.toInt(), 0xFF7EB7E7.toInt())
        sphere(canvas, 333f, 127f, 13f, 0xFFF6F7FF.toInt(), 0xFFD9DEF3.toInt(), 0xFFB7C4E9.toInt())
        arrow(canvas, 27f, 199f, 25f, 55f)
        arrow(canvas, 57f, 155f, 20f, 43f)
        arrow(canvas, 377f, 181f, 20f, 45f)

        paint.setShadowLayer(13f, 6f, 10f, 0x1E86ACE3)
        paint.shader = LinearGradient(147f, 19f, 291f, 203f, intArrayOf(0xFFD7E9F5.toInt(), 0xFF93C1EF.toInt(), 0xFF6199F0.toInt()), floatArrayOf(0f, .5f, 1f), Shader.TileMode.CLAMP)
        canvas.drawPath(rear, paint)
        paint.clearShadowLayer()
        paint.shader = LinearGradient(164f, 29f, 283f, 198f, intArrayOf(0xFF8ABFFA.toInt(), 0xFF76B5FE.toInt(), 0xFF518AF0.toInt()), floatArrayOf(0f, .55f, 1f), Shader.TileMode.CLAMP)
        canvas.drawPath(rim, paint)
        paint.shader = LinearGradient(180f, 49f, 273f, 188f, intArrayOf(0xFF87BAF9.toInt(), 0xFFC8E4FB.toInt(), 0xFFEAF5FC.toInt()), floatArrayOf(0f, .64f, 1f), Shader.TileMode.CLAMP)
        canvas.drawPath(face, paint)

        canvas.save()
        canvas.clipPath(face)
        paint.shader = RadialGradient(225f, 102f, 99f, 0x76E8FAFF, 0x00DFEBFF, Shader.TileMode.CLAMP)
        canvas.drawRect(156f, 23f, 292f, 200f, paint)
        paint.shader = LinearGradient(207f, 95f, 271f, 183f, 0x00FFFFFF, 0x72FFFFFF, Shader.TileMode.CLAMP)
        canvas.drawPath(Path().apply { moveTo(188f, 22f); lineTo(278f, 71f); lineTo(278f, 193f); lineTo(148f, 193f); close() }, paint)
        canvas.restore()
        paint.shader = LinearGradient(167f, 64f, 248f, 190f, 0x319CC4F6, 0xAEECFAFF.toInt(), Shader.TileMode.CLAMP)
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = 2f
        canvas.drawPath(face, paint)
        paint.style = Paint.Style.FILL
        paint.shader = null

        paint.color = 0xCBF3FFFF.toInt()
        paint.setShadowLayer(5f, 0f, 0f, 0x79E5FFFF)
        canvas.drawRoundRect(215.5f, 70f, 226f, 120f, 5f, 5f, paint)
        canvas.drawCircle(220.8f, 136f, 6.1f, paint)
        paint.clearShadowLayer()
        canvas.restore()
    }

    private fun sphere(canvas: Canvas, x: Float, y: Float, radius: Float, light: Int, middle: Int, edge: Int) {
        paint.shader = RadialGradient(x - radius * .32f, y - radius * .4f, radius * 1.45f, intArrayOf(light, middle, edge), floatArrayOf(0f, .58f, 1f), Shader.TileMode.CLAMP)
        canvas.drawCircle(x, y, radius, paint)
        paint.shader = null
    }

    private fun arrow(canvas: Canvas, x: Float, y: Float, width: Float, height: Float) {
        paint.shader = LinearGradient(x - width / 2f, y - height / 2f, x + width / 2f, y + height / 2f, 0xFFBEDCF5.toInt(), 0xFF599CE8.toInt(), Shader.TileMode.CLAMP)
        canvas.drawPath(Path().apply { moveTo(x, y - height / 2f); lineTo(x + width / 2f, y + height * .27f); lineTo(x + width * .14f, y + height * .22f); lineTo(x + width * .1f, y + height / 2f); lineTo(x - width * .14f, y + height / 2f); lineTo(x - width * .18f, y + height * .2f); lineTo(x - width / 2f, y + height * .2f); close() }, paint)
        paint.shader = LinearGradient(x, y - height / 2f, x + width / 2f, y + height / 2f, 0xFF8FBFEF.toInt(), 0xFF4B88DD.toInt(), Shader.TileMode.CLAMP)
        canvas.drawPath(Path().apply { moveTo(x, y - height / 2f); lineTo(x + width / 2f, y + height * .27f); lineTo(x + width * .14f, y + height * .22f); lineTo(x + width * .1f, y + height / 2f); lineTo(x, y + height * .32f); close() }, paint)
        paint.shader = null
    }
}

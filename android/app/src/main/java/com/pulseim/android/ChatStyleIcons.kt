package com.pulseim.android

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.view.View
import kotlin.math.min

/** Native, resolution-independent icons for the private chat reference layout.
 * The containing control supplies its touch target, accessibility label and action. */
internal class ChatStyleIconView(context: Context, kind: String, color: Int = Color.BLACK) : View(context) {
    var kind: String = kind
        set(value) { field = value; invalidate() }
    var iconColor: Int = color
        set(value) { field = value; invalidate() }
    private val pen = Paint(Paint.ANTI_ALIAS_FLAG)

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val availableWidth = (width - paddingLeft - paddingRight).toFloat()
        val availableHeight = (height - paddingTop - paddingBottom).toFloat()
        val size = min(availableWidth, availableHeight)
        if (size <= 0f) return
        canvas.save()
        canvas.translate(paddingLeft + (availableWidth - size) / 2f, paddingTop + (availableHeight - size) / 2f)
        canvas.scale(size / 24f, size / 24f)
        pen.reset(); pen.isAntiAlias = true
        pen.color = if (AppAppearance.dark && iconColor == 0xFF0800D4.toInt()) 0xFF9AAFFF.toInt() else AppAppearance.ink(iconColor)
        pen.style = Paint.Style.STROKE; pen.strokeWidth = 2f
        pen.strokeCap = Paint.Cap.ROUND; pen.strokeJoin = Paint.Join.ROUND
        when (kind) {
            "star" -> {
                val star = Path()
                for (i in 0 until 10) {
                    val angle = Math.PI * i / 5 - Math.PI / 2
                    val radius = if (i % 2 == 0) 10f else 4.5f
                    val x = 12f + (kotlin.math.cos(angle) * radius).toFloat()
                    val y = 12f + (kotlin.math.sin(angle) * radius).toFloat()
                    if (i == 0) star.moveTo(x, y) else star.lineTo(x, y)
                }
                star.close(); canvas.drawPath(star, pen)
            }
            "card" -> {
                canvas.drawRoundRect(2f, 4f, 22f, 20f, 2f, 2f, pen)
                canvas.drawCircle(8f, 10f, 2.3f, pen)
                canvas.drawArc(RectF(4.5f, 12.5f, 11.5f, 19.5f), 180f, 180f, false, pen)
                canvas.drawLine(14f, 9f, 19f, 9f, pen); canvas.drawLine(14f, 14f, 19f, 14f, pen)
            }
            "back" -> path(canvas, 15f to 3.5f, 6.5f to 12f, 15f to 20.5f)
            "chevron" -> path(canvas, 8f to 4f, 16f to 12f, 8f to 20f)
            "share" -> {
                pen.strokeWidth = 1.8f
                canvas.drawLine(7f, 10.8f, 17f, 5.2f, pen)
                canvas.drawLine(7f, 13.2f, 17f, 18.8f, pen)
                for ((x, y) in arrayOf(5f to 12f, 19f to 4f, 19f to 20f)) canvas.drawCircle(x, y, 2.8f, pen)
            }
            "more" -> {
                pen.style = Paint.Style.FILL
                for (y in floatArrayOf(4.5f, 12f, 19.5f)) canvas.drawCircle(12f, y, 1.85f, pen)
            }
            "plus" -> {
                pen.strokeWidth = 2.4f
                canvas.drawLine(12f, 3.5f, 12f, 20.5f, pen)
                canvas.drawLine(3.5f, 12f, 20.5f, 12f, pen)
            }
            "smile" -> {
                pen.strokeWidth = 1.9f
                canvas.drawCircle(12f, 12f, 9.25f, pen)
                canvas.drawArc(RectF(6.3f, 8f, 17.7f, 17.4f), 18f, 144f, false, pen)
                pen.style = Paint.Style.FILL
                canvas.drawCircle(8.5f, 9f, 1.15f, pen)
                canvas.drawCircle(15.5f, 9f, 1.15f, pen)
            }
            "mic" -> {
                pen.style = Paint.Style.FILL
                canvas.drawRoundRect(8.5f, 1.5f, 15.5f, 14.8f, 3.5f, 3.5f, pen)
                pen.style = Paint.Style.STROKE; pen.strokeWidth = 1.9f
                canvas.drawPath(Path().apply { moveTo(5.5f, 10.5f); lineTo(5.5f, 12.2f); cubicTo(5.5f, 20f, 18.5f, 20f, 18.5f, 12.2f); lineTo(18.5f, 10.5f) }, pen)
                canvas.drawLine(12f, 18f, 12f, 22f, pen)
            }
            "send" -> {
                pen.style = Paint.Style.FILL
                canvas.drawPath(Path().apply { moveTo(2.5f, 2.5f); lineTo(22f, 12f); lineTo(2.5f, 21.5f); lineTo(5.9f, 13f); lineTo(15.5f, 12f); lineTo(5.9f, 11f); close() }, pen)
            }
            "photo" -> {
                pen.strokeWidth = 2f
                canvas.drawRoundRect(2f, 3f, 22f, 21f, 1.3f, 1.3f, pen)
                pen.style = Paint.Style.FILL
                canvas.drawCircle(8f, 8.6f, 1.8f, pen)
                canvas.drawPath(Path().apply { moveTo(3f, 16.2f); lineTo(8.6f, 11.2f); lineTo(12f, 14.1f); lineTo(16.8f, 9.7f); lineTo(21f, 14.1f); lineTo(21f, 20f); lineTo(3f, 20f); close() }, pen)
            }
            "camera" -> {
                pen.style = Paint.Style.FILL
                canvas.drawPath(Path().apply {
                    moveTo(2.7f, 5.8f); lineTo(7.1f, 5.8f); lineTo(8.7f, 2.8f); lineTo(15.3f, 2.8f); lineTo(16.9f, 5.8f); lineTo(21.3f, 5.8f)
                    quadTo(23f, 5.8f, 23f, 7.5f); lineTo(23f, 20f); quadTo(23f, 21.7f, 21.3f, 21.7f); lineTo(2.7f, 21.7f)
                    quadTo(1f, 21.7f, 1f, 20f); lineTo(1f, 7.5f); quadTo(1f, 5.8f, 2.7f, 5.8f); close()
                }, pen)
                // The lens is a cutout in the solid blue body, matching its tile.
                pen.color = AppAppearance.background(Color.WHITE); canvas.drawCircle(12f, 13.2f, 4.3f, pen)
            }
            "file" -> {
                canvas.drawPath(Path().apply { moveTo(5f, 2f); lineTo(14f, 2f); lineTo(20f, 8f); lineTo(20f, 22f); lineTo(5f, 22f); close(); moveTo(14f, 2.5f); lineTo(14f, 8f); lineTo(19.5f, 8f) }, pen)
                canvas.drawLine(8.5f, 12f, 16.5f, 12f, pen)
                canvas.drawLine(8.5f, 16f, 16.5f, 16f, pen)
            }
            "video" -> {
                canvas.drawRoundRect(2f, 5f, 22f, 20f, 1.5f, 1.5f, pen)
                pen.style = Paint.Style.FILL
                canvas.drawPath(Path().apply { moveTo(9f, 8.5f); lineTo(16f, 12.5f); lineTo(9f, 16.5f); close() }, pen)
            }
            "bell", "bell_off" -> {
                pen.style = Paint.Style.FILL
                canvas.drawCircle(12f, 3f, 1.6f, pen)
                canvas.drawPath(Path().apply {
                    moveTo(4f, 18f); lineTo(6f, 14.8f); lineTo(6f, 9f)
                    cubicTo(6f, 1.9f, 18f, 1.9f, 18f, 9f)
                    lineTo(18f, 14.8f); lineTo(20f, 18f); close()
                }, pen)
                canvas.drawArc(RectF(9.5f, 17.5f, 14.5f, 22f), 0f, 180f, false, pen)
                if (kind == "bell_off") {
                    pen.style = Paint.Style.STROKE; pen.strokeWidth = 4.8f
                    pen.color = AppAppearance.background(Color.WHITE)
                    canvas.drawLine(3f, 2.5f, 21f, 20.5f, pen)
                    pen.color = AppAppearance.ink(iconColor); pen.strokeWidth = 1.9f
                    canvas.drawLine(3f, 2.5f, 21f, 20.5f, pen)
                }
            }
            "broom" -> {
                pen.strokeWidth = 1.8f
                canvas.drawLine(19.8f, 2.3f, 12.1f, 12.1f, pen)
                canvas.drawPath(Path().apply {
                    moveTo(12.1f, 10.8f); cubicTo(10.8f, 13.1f, 7.8f, 14f, 2.8f, 14.1f)
                    cubicTo(3.5f, 19.7f, 7.7f, 23f, 11.3f, 21.1f)
                    cubicTo(14.5f, 19.4f, 15.3f, 15.8f, 13.8f, 12.1f); close()
                }, pen)
            }
            "trash" -> {
                pen.style = Paint.Style.FILL
                canvas.drawRoundRect(8f, 2.2f, 16f, 4.6f, .6f, .6f, pen)
                canvas.drawRoundRect(3f, 4.7f, 21f, 6.5f, .4f, .4f, pen)
                canvas.drawPath(Path().apply { moveTo(5f, 7.5f); lineTo(19f, 7.5f); lineTo(18f, 22f); lineTo(6f, 22f); close() }, pen)
                pen.style = Paint.Style.STROKE; pen.strokeWidth = 1.1f
                pen.color = AppAppearance.background(Color.WHITE)
                canvas.drawLine(10f, 10f, 10f, 18.5f, pen)
                canvas.drawLine(14f, 10f, 14f, 18.5f, pen)
            }
            "shake" -> {
                canvas.drawRoundRect(7f, 2f, 17f, 22f, 1.8f, 1.8f, pen)
                canvas.drawLine(10.5f, 18.7f, 13.5f, 18.7f, pen)
                pen.strokeWidth = 1.5f
                path(canvas, 3.8f to 4f, 1.7f to 8f, 4.2f to 12f, 1.7f to 16f, 3.8f to 20f)
                path(canvas, 20.2f to 4f, 22.3f to 8f, 19.8f to 12f, 22.3f to 16f, 20.2f to 20f)
            }
        }
        canvas.restore()
    }

    private fun path(canvas: Canvas, vararg points: Pair<Float, Float>) {
        if (points.isEmpty()) return
        canvas.drawPath(Path().apply { moveTo(points[0].first, points[0].second); points.drop(1).forEach { lineTo(it.first, it.second) } }, pen)
    }
}

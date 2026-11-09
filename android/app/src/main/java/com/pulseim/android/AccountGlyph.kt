package com.pulseim.android
import android.content.Context
import android.graphics.*
import android.view.View
internal class AccountGlyph(context: Context, var kind: String, private val tint: Int) : View(context) {
    private val pen = Paint(Paint.ANTI_ALIAS_FLAG)
    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas); canvas.save(); canvas.translate(paddingLeft.toFloat(), paddingTop.toFloat()); canvas.scale((width - paddingLeft - paddingRight) / 64f, (height - paddingTop - paddingBottom) / 64f)
        pen.color = AppAppearance.ink(tint); pen.strokeWidth = 3f; pen.style = Paint.Style.STROKE; pen.strokeCap = Paint.Cap.ROUND; pen.strokeJoin = Paint.Join.ROUND
        when (kind) {
            "more" -> { pen.style = Paint.Style.FILL; for (x in listOf(15f, 32f, 49f)) canvas.drawCircle(x, 32f, 3.5f, pen) }
            "check" -> canvas.drawPath(Path().apply { moveTo(16f, 32f); lineTo(28f, 43f); lineTo(48f, 20f) }, pen)
            "ledger" -> {
                pen.style = Paint.Style.FILL; canvas.drawRoundRect(8f, 5f, 55f, 60f, 10f, 10f, pen)
                pen.style = Paint.Style.STROKE; pen.color = Color.WHITE
                for (y in listOf(22f, 33f, 44f)) canvas.drawLine(21f, y, 42f, y, pen)
            }
            else -> {
                canvas.drawPath(Path().apply { moveTo(11f, 32f); cubicTo(22f, 16f, 43f, 16f, 54f, 32f); cubicTo(43f, 48f, 22f, 48f, 11f, 32f) }, pen)
                canvas.drawCircle(32f, 32f, 6f, pen)
                if (kind == "eye_off") canvas.drawLine(15f, 15f, 51f, 49f, pen)
            }
        }
        canvas.restore()
    }
}

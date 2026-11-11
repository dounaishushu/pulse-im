package com.pulseim.android

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.PopupWindow
import android.widget.TextView
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale

internal data class MessageMenuAction(val key: String, val label: String, val icon: String = key, val enabled: Boolean = true)

/** One icon column, one text column and a real timestamp for every message menu. */
internal class MessageActionMenu(context: Context, actions: List<MessageMenuAction>, message: JSONObject, private val onPick: (String) -> Unit) : PopupWindow(context) {
    private val density = context.resources.displayMetrics.density
    private fun dp(value: Int) = (value * density + .5f).toInt()
    private val card = LinearLayout(context).apply {
        id = R.id.message_action_menu; orientation = LinearLayout.VERTICAL; setPadding(0, dp(4), 0, dp(4))
        background = GradientDrawable().apply { setColor(AppAppearance.background(Color.WHITE)); cornerRadius = dp(7).toFloat() }
        clipToOutline = true
    }
    private var menuAnchor: View? = null
    private fun actionRow(action: MessageMenuAction): View = LinearLayout(card.context).apply {
        tag = action.key
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(dp(14), 0, dp(14), 0)
        isEnabled = action.enabled; alpha = if (action.enabled) 1f else .4f
        contentDescription = action.label; isFocusable = action.enabled
        if (action.enabled) { isClickable = true; setOnClickListener { dismiss(); onPick(action.key) } }
        val value = android.util.TypedValue(); context.theme.resolveAttribute(android.R.attr.selectableItemBackground, value, true); setBackgroundResource(value.resourceId)
        addView(MessageMenuIcon(context, action.icon), LinearLayout.LayoutParams(dp(18), dp(18)).apply { rightMargin = dp(18) })
        addView(TextView(context).apply { text = action.label; textSize = 13f; setTextColor(AppAppearance.ink(Color.BLACK)); setSingleLine(); includeFontPadding = false }, LinearLayout.LayoutParams(0, -2, 1f))
    }
    init {
        actions.forEach { action ->
            card.addView(actionRow(action), LinearLayout.LayoutParams(-1, dp(40)))
        }
        timestamp(message.optString("created_at"))?.let { time ->
            card.addView(View(context).apply { tag = "menu-footer"; setBackgroundColor(AppAppearance.background(0xFFEEEEEE.toInt())) }, LinearLayout.LayoutParams(-1, dp(6)).apply { topMargin = dp(4) })
            val footer = LinearLayout(context).apply { gravity = Gravity.CENTER_VERTICAL; setPadding(dp(8), 0, dp(8), 0) }
            footer.addView(MessageMenuIcon(context, "clock"), LinearLayout.LayoutParams(dp(18), dp(18)).apply { rightMargin = dp(8) })
            footer.addView(TextView(context).apply { id = R.id.message_action_time; text = time; textSize = 12f; setTextColor(AppAppearance.ink(Color.BLACK)); includeFontPadding = false })
            card.addView(footer, LinearLayout.LayoutParams(-1, dp(34)))
        }
        contentView = card; width = dp(174); height = -2; isFocusable = true; isOutsideTouchable = true
        setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT)); elevation = dp(10).toFloat()
        inputMethodMode = INPUT_METHOD_NOT_NEEDED
    }
    /** Add only freshly authorized staff rows; keep the ordinary menu and its pixels. */
    fun internalActions(allowed: Boolean, editable: Boolean, ownEditable: Boolean = false) {
        if (!isShowing) return
        for (index in card.childCount - 1 downTo 0) {
            if (card.getChildAt(index).tag in listOf("recall", "edit")) card.removeViewAt(index)
        }
        var index = (0 until card.childCount).firstOrNull { card.getChildAt(it).tag in listOf("select", "menu-footer") } ?: card.childCount
        if (allowed) card.addView(actionRow(MessageMenuAction("recall", "撤回消息")), index++, LinearLayout.LayoutParams(-1, dp(40)))
        if (ownEditable || (allowed && editable)) card.addView(actionRow(MessageMenuAction("edit", "编辑消息")), index, LinearLayout.LayoutParams(-1, dp(40)))
        menuAnchor?.takeIf { it.isAttachedToWindow }?.let { anchor ->
            val (x, y) = position(anchor)
            update(x, y, width, contentView.measuredHeight)
        }
    }
    fun show(anchor: View) {
        menuAnchor = anchor
        val (x, y) = position(anchor)
        showAtLocation(anchor, Gravity.TOP or Gravity.LEFT, x, y)
    }
    private fun position(anchor: View): Pair<Int, Int> {
        val frame = Rect(); anchor.getWindowVisibleDisplayFrame(frame)
        contentView.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(frame.height(), View.MeasureSpec.AT_MOST))
        val point = IntArray(2); anchor.getLocationOnScreen(point)
        val x = (point[0] + anchor.width / 2).coerceIn(frame.left + dp(8), (frame.right - width - dp(8)).coerceAtLeast(frame.left + dp(8)))
        val y = (point[1] + anchor.height / 2).coerceIn(frame.top + dp(8), (frame.bottom - contentView.measuredHeight - dp(8)).coerceAtLeast(frame.top + dp(8)))
        return Pair(x, y)
    }
    private fun timestamp(raw: String): String? = try {
        val parser = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.CHINA).apply { isLenient = false }
        val date = parser.parse(raw)
        if (date == null) null else {
            val today = Calendar.getInstance(); val yesterday = Calendar.getInstance().apply { add(Calendar.DAY_OF_YEAR, -1) }; val value = Calendar.getInstance().apply { time = date }
            fun sameDay(day: Calendar) = value.get(Calendar.YEAR) == day.get(Calendar.YEAR) && value.get(Calendar.DAY_OF_YEAR) == day.get(Calendar.DAY_OF_YEAR)
            val label = when { sameDay(today) -> "今天"; sameDay(yesterday) -> "昨天"; else -> SimpleDateFormat("yyyy/M/d", Locale.CHINA).format(date) }
            label + " " + SimpleDateFormat("HH:mm", Locale.CHINA).format(date)
        }
    } catch (_: Exception) { null }
}

internal class MessageMenuIcon(context: Context, private val kind: String) : View(context) {
    private val ink = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 1.5f; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND; color = AppAppearance.ink(Color.BLACK) }
    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas); val save = canvas.save(); canvas.scale(width / 24f, height / 24f)
        fun line(vararg points: Float) { val path = Path(); path.moveTo(points[0], points[1]); var i = 2; while (i < points.size) { path.lineTo(points[i], points[i + 1]); i += 2 }; canvas.drawPath(path, ink) }
        when (kind) {
            "reply" -> { line(9f,4f,2f,11f,9f,18f,9f,14f); canvas.drawPath(Path().apply { moveTo(9f,14f); cubicTo(15f,13f,18f,15f,21f,20f); cubicTo(22f,11f,18f,7f,9f,7f); lineTo(9f,4f) },ink) }
            "copy" -> { canvas.drawRoundRect(7f,5f,18f,21f,2f,2f,ink); line(14f,2f,4f,2f,3f,3f,3f,16f) }
            "forward" -> { line(14f,3f,22f,11f,14f,18f,14f,13f); canvas.drawPath(Path().apply { moveTo(14f,13f); cubicTo(7f,13f,4f,16f,2f,20f); cubicTo(1f,10f,6f,7f,14f,7f); lineTo(14f,3f) },ink) }
            "delete" -> { line(4f,6f,20f,6f); line(9f,3f,15f,3f); line(6f,6f,7f,21f,17f,21f,18f,6f) }
            "clock" -> { canvas.drawArc(3f,4f,21f,22f,-80f,320f,false,ink); line(8f,2f,12f,2f,12f,6f); line(12f,8f,12f,13f,9f,15f) }
            "pin", "unpin" -> { line(8f,3f,17f,7f,14f,12f,14f,16f,9f,14f,5f,16f,7f,11f,8f,3f); line(9f,14f,5f,21f) }
            "edit" -> { line(4f,16f,3f,21f,8f,20f,21f,7f,17f,3f,4f,16f); line(14f,6f,18f,10f) }
            "recall" -> { canvas.drawArc(4f,4f,22f,22f,200f,290f,false,ink); line(4f,5f,4f,11f,10f,11f) }
            "favorite" -> line(12f,2f,15f,9f,22f,9f,17f,14f,19f,22f,12f,17f,5f,22f,7f,14f,2f,9f,9f,9f,12f,2f)
            else -> { canvas.drawCircle(12f,12f,10f,ink); line(7f,12f,10f,15f,17f,8f) }
        }
        canvas.restoreToCount(save)
    }
}

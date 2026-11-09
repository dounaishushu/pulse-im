package com.pulseim.android

import android.app.Activity
import android.app.Dialog
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale
import kotlin.math.roundToInt

internal object WorkTaskSettlement {
    fun complete(payload: JSONObject): Boolean = runCatching {
        val record = payload.getJSONObject("record")
        val total = record.getInt("total_questions")
        val correct = record.getInt("correct_count")
        val wrong = record.getInt("wrong_count")
        val unit = record.getDouble("unit_price"); val wage = record.getDouble("wage")
        if (record.getInt("id") <= 0 || record.getString("status") != "reviewed" ||
            record.getString("employee_type") !in setOf("intern", "formal") || total !in 1..1000 ||
            correct !in 0..total || wrong != total - correct || !unit.isFinite() || unit < 0 ||
            !wage.isFinite() || wage < 0 || kotlin.math.abs(wage - correct * unit) >= 0.000001) return false
        val questions = payload.getJSONArray("questions")
        if (questions.length() != total) return false
        val ids = HashSet<String>(); var counted = 0
        for (i in 0 until questions.length()) {
            val question = questions.getJSONObject(i); val id = question.getString("question_uuid")
            if (id.isBlank() || !ids.add(id) || question.isNull("answer") || question.isNull("reviewed_correct")) return false
            if (question.getBoolean("reviewed_correct")) counted++
        }
        counted == correct
    }.getOrDefault(false)
}

/** Only complete, server-graded snapshots can be shown as a settlement. */
internal class WorkTaskSettlementDialog(
    private val activity: Activity,
    payload: JSONObject,
    currentNickname: String,
    private val loadAvatar: (ImageView, String) -> Unit,
    private val onConfirm: () -> Unit
) : BackSwipeDialog(activity, if (AppAppearance.dark) R.style.AppThemeDark else R.style.AppTheme) {
    // Freeze the settlement snapshot while this dialog is visible.
    private val record = JSONObject(payload.getJSONObject("record").toString())
    private val questions = JSONArray(payload.optJSONArray("questions")?.toString() ?: "[]")
    private val employeeTitle = if (string(record, "employee_type") == "formal") "正式员工" else "实习员工"
    private val nickname = string(record, "nickname").ifBlank { currentNickname.ifBlank { "用户" } }
    private val blue = 0xFF2F80ED.toInt()
    private val ink = if (AppAppearance.dark) 0xFFF3F3F7.toInt() else Color.BLACK
    private val muted = if (AppAppearance.dark) 0xFFAAAAAF.toInt() else 0xFF8E8E93.toInt()
    private var detailsDialog: Dialog? = null

    init {
        require(WorkTaskSettlement.complete(payload)) { "未能取得完整结算结果，请重试" }
        requestWindowFeature(Window.FEATURE_NO_TITLE)
        val card = column().apply {
            setPadding(dp(22), dp(22), dp(22), dp(18))
            background = shape(Color.WHITE, 18)
        }
        card.addView(label("✓", 28f, 0xFF60B76E.toInt()).apply {
            gravity = Gravity.CENTER
            background = shape(if (AppAppearance.dark) 0xFF274530.toInt() else 0xFFE8F4EA.toInt(), 30)
            contentDescription = "批改已完成"
        }, LinearLayout.LayoutParams(dp(60), dp(60)).apply { gravity = Gravity.CENTER_HORIZONTAL; bottomMargin = dp(16) })
        card.addView(label(employeeTitle, 26f, 0xFFEA432D.toInt(), true).apply {
            id = R.id.work_settlement_title
            gravity = Gravity.CENTER
            minHeight = dp(22)
        }, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(14) })
        card.addView(label(string(record, "task_name").ifBlank { "工作任务结算" }, 13f, muted).apply { gravity = Gravity.CENTER },
            LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(10) })

        detailRow(card, "完成时间", completionTime(string(record, "submitted_at")))
        val duration = record.optInt("duration_seconds").coerceAtLeast(0)
        detailRow(card, "完成耗时", "${duration / 60}分${duration % 60}秒")
        detailRow(card, "状态", "已完成")

        card.addView(LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            addView(statistic(true), LinearLayout.LayoutParams(dp(72), dp(50)).apply { rightMargin = dp(15) })
            addView(statistic(false), LinearLayout.LayoutParams(dp(72), dp(50)))
        }, LinearLayout.LayoutParams(-1, dp(50)).apply { topMargin = dp(12); bottomMargin = dp(18) })

        val wage = "¥${formattedWage(record.getDouble("wage"))}"
        card.addView(column().apply {
            gravity = Gravity.CENTER
            background = GradientDrawable(GradientDrawable.Orientation.LEFT_RIGHT,
                intArrayOf(0xFFFF6B32.toInt(), 0xFFFF8F52.toInt())).apply { cornerRadius = dp(11).toFloat() }
            addView(label("工资收入", 12f, 0xC7FFFFFF.toInt()).apply { gravity = Gravity.CENTER })
            addView(label(wage, 30f, Color.WHITE, true).apply { gravity = Gravity.CENTER },
                LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(3); bottomMargin = dp(3) })
            // This is the historical record role, never the account's current permission.
            addView(label(if (string(record, "employee_type") == "formal") "(正式员工)" else "(实习员工)", 12f, 0xC7FFFFFF.toInt()).apply { gravity = Gravity.CENTER })
        }, LinearLayout.LayoutParams(-1, dp(100)))

        val avatarBox = FrameLayout(activity).apply {
            background = shape(if (AppAppearance.dark) 0xFF364765.toInt() else 0xFFE8F1FF.toInt(), 19)
            clipToOutline = true
        }
        avatarBox.addView(label(nickname.take(1), 17f, blue, true).apply { gravity = Gravity.CENTER }, FrameLayout.LayoutParams(-1, -1))
        val avatar = ImageView(activity).apply {
            id = R.id.work_user_avatar
            scaleType = ImageView.ScaleType.CENTER_CROP
            contentDescription = "用户头像"
        }
        avatarBox.addView(avatar, FrameLayout.LayoutParams(-1, -1))
        val userName = label(nickname, 15f, ink, true).apply { maxLines = 2; ellipsize = TextUtils.TruncateAt.END }
        card.addView(LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            minimumHeight = dp(38)
            addView(avatarBox, LinearLayout.LayoutParams(dp(38), dp(38)).apply { rightMargin = dp(10) })
            addView(userName, LinearLayout.LayoutParams(-2, -2).apply { userName.maxWidth = cardWidth() - dp(92) })
        }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(18) })

        card.addView(action("确定", 16f, Color.WHITE).apply {
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            background = shape(blue, 7)
            setOnClickListener { dismiss(); onConfirm() }
        }, LinearLayout.LayoutParams(-1, dp(44)).apply { topMargin = dp(18) })

        val viewport = CappedScrollView().apply {
            isFillViewport = false
            overScrollMode = View.OVER_SCROLL_NEVER
            isVerticalScrollBarEnabled = false
            // The scroll container can gain keyboard focus after code verification.
            // Keep the card white; individual controls retain their focus feedback.
            defaultFocusHighlightEnabled = false
            background = shape(Color.WHITE, 18)
            clipToOutline = true
            addView(card, ViewGroup.LayoutParams(-1, -2))
        }
        setContentView(viewport)
        setCancelable(true)
        setCanceledOnTouchOutside(false)
        setOnCancelListener { onConfirm() }
        val avatarUrl = string(record, "avatar_url")
        if (avatarUrl.isNotBlank()) loadAvatar(avatar, avatarUrl)
    }

    override fun onStart() {
        super.onStart()
        window?.apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            setLayout(cardWidth(), ViewGroup.LayoutParams.WRAP_CONTENT)
            setGravity(Gravity.CENTER)
            addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            attributes = attributes.apply { dimAmount = .54f }
            setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN)
        }
    }

    override fun onStop() {
        detailsDialog?.dismiss()
        detailsDialog = null
        super.onStop()
    }


    private fun detailRow(card: LinearLayout, title: String, value: String) {
        card.addView(LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            minimumHeight = dp(26)
            addView(label("$title:", 13f, muted), LinearLayout.LayoutParams(-2, -2).apply { rightMargin = dp(12) })
            addView(label(value.ifBlank { "-" }, 13f, ink).apply { gravity = Gravity.END }, LinearLayout.LayoutParams(0, -2, 1f))
        }, LinearLayout.LayoutParams(-1, -2))
    }

    private fun statistic(correct: Boolean): View {
        val title = if (correct) "批改正确" else "批改错误"
        val count = "${record.getInt(if (correct) "correct_count" else "wrong_count")}题"
        val color = if (correct) 0xFF66B977.toInt() else 0xFFE76460.toInt()
        return column().apply {
            gravity = Gravity.CENTER
            val fill = if (AppAppearance.dark) { if (correct) 0xFF263C30.toInt() else 0xFF452C2D.toInt() }
                else if (correct) 0xFFEAF6EC.toInt() else 0xFFFFF0EC.toInt()
            background = shape(fill, 18).apply { setStroke(dp(1), if (correct) 0xFFC3DFC5.toInt() else 0xFFF3C4C1.toInt()) }
            addView(label(count, 15f, color, true).apply { gravity = Gravity.CENTER }, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(2) })
            addView(label(title, 10f, color).apply { gravity = Gravity.CENTER })
            isEnabled = true
            isClickable = true
            isFocusable = true
            contentDescription = "$title，$count，查看批改明细"
            setOnClickListener { showDetails(if (correct) 1 else 2) }
        }
    }

    private fun showDetails(initialFilter: Int) {
        if (!isShowing) return
        detailsDialog?.dismiss()
        val dialog = BackSwipeDialog(activity, if (AppAppearance.dark) R.style.AppThemeDark else R.style.AppTheme)
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
        val root = column().apply { background = shape(Color.WHITE, 18); setPadding(dp(16), dp(12), dp(16), dp(16)) }
        root.addView(FrameLayout(activity).apply {
            addView(label("批改明细", 17f, ink, true).apply { gravity = Gravity.CENTER }, FrameLayout.LayoutParams(-1, -1))
            addView(action("关闭", 14f, blue).apply { setOnClickListener { dialog.dismiss() } }, FrameLayout.LayoutParams(dp(52), -1, Gravity.END))
        }, LinearLayout.LayoutParams(-1, dp(44)))
        val filters = LinearLayout(activity).apply { orientation = LinearLayout.HORIZONTAL; background = shape(0xFFF0EFF6.toInt(), 8); setPadding(dp(3), dp(3), dp(3), dp(3)) }
        root.addView(filters, LinearLayout.LayoutParams(-1, dp(38)).apply { topMargin = dp(8); bottomMargin = dp(12) })
        val rows = column().apply { setPadding(0, dp(2), 0, dp(2)) }
        root.addView(ScrollView(activity).apply { addView(rows); isFillViewport = false }, LinearLayout.LayoutParams(-1, 0, 1f))
        var filter = initialFilter
        fun render() {
            for (i in 0 until filters.childCount) {
                val item = filters.getChildAt(i) as TextView
                item.isSelected = i == filter
                item.background = if (i == filter) shape(Color.WHITE, 6) else ColorDrawable(Color.TRANSPARENT)
                item.setTextColor(ink)
                item.contentDescription = "${item.text}，${if (i == filter) "已选中" else "未选中"}"
            }
            rows.removeAllViews()
            val note = string(record, "review_note")
            if (note.isNotBlank()) rows.addView(column().apply {
                setPadding(dp(14), dp(14), dp(14), dp(14)); background = shape(0xFFF7F7F7.toInt(), 10)
                addView(label("批改备注", 13f, ink, true))
                addView(label(note, 13f, muted), LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(6) })
            }, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(16) })
            var shown = 0
            for (i in 0 until questions.length()) {
                val question = questions.optJSONObject(i) ?: continue
                val known = question.has("reviewed_correct") && !question.isNull("reviewed_correct")
                val correct = known && question.optBoolean("reviewed_correct")
                if ((filter == 1 && (!known || !correct)) || (filter == 2 && (!known || correct))) continue
                val answered = question.has("answer") && !question.isNull("answer")
                val answer = if (!answered) "未答" else if (question.optBoolean("answer")) "对" else "错"
                val result = if (!known) "未批改" else if (correct) "批改正确" else "批改错误"
                rows.addView(LinearLayout(activity).apply {
                    orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
                    setPadding(dp(14), dp(14), dp(14), dp(14)); background = shape(0xFFF7F7F7.toInt(), 10)
                    addView(label("第 ${i + 1} 题", 12f, ink), LinearLayout.LayoutParams(0, -2, 1f))
                    addView(label("作答：$answer", 12f, ink), LinearLayout.LayoutParams(-2, -2).apply { rightMargin = dp(8) })
                    addView(label(result, 12f, if (correct) 0xFF159A78.toInt() else 0xFFE45151.toInt()))
                }, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(12) })
                shown++
            }
            if (shown == 0) rows.addView(label("暂无此类题目", 13f, muted).apply { gravity = Gravity.CENTER; setPadding(0, dp(24), 0, dp(24)) })
        }
        listOf("全部", "正确", "错误").forEachIndexed { i, title ->
            filters.addView(action(title, 13f, ink).apply { setOnClickListener { filter = i; render() } }, LinearLayout.LayoutParams(0, -1, 1f))
        }
        render()
        dialog.setContentView(root)
        dialog.setCanceledOnTouchOutside(true)
        dialog.setOnDismissListener { if (detailsDialog === dialog) detailsDialog = null }
        detailsDialog = dialog
        dialog.show()
        dialog.window?.apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            setLayout(minOf(dp(540), activity.resources.displayMetrics.widthPixels - dp(32)), (activity.resources.displayMetrics.heightPixels * .78f).roundToInt())
            setGravity(Gravity.CENTER)
            addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            attributes = attributes.apply { dimAmount = .25f }
        }
    }

    private fun cardWidth() = minOf(dp(333), activity.resources.displayMetrics.widthPixels - dp(60)).coerceAtLeast(dp(160))
    private fun dp(value: Int) = (value * activity.resources.displayMetrics.density).roundToInt()
    private fun column() = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
    private fun shape(color: Int, radius: Int) = GradientDrawable().apply { setColor(AppAppearance.background(color)); cornerRadius = dp(radius).toFloat() }
    private fun label(value: String, size: Float, color: Int, bold: Boolean = false) = TextView(activity).apply {
        text = value; textSize = size; includeFontPadding = false; setTextColor(color)
        if (bold) typeface = Typeface.DEFAULT_BOLD
    }
    private fun action(value: String, size: Float, color: Int) = label(value, size, color).apply {
        gravity = Gravity.CENTER; isClickable = true; isFocusable = true
    }

    private inner class CappedScrollView : ScrollView(activity) {
        override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
            val available = (activity.resources.displayMetrics.heightPixels - dp(32)).coerceAtLeast(dp(100))
            val incoming = View.MeasureSpec.getSize(heightMeasureSpec)
            val maxHeight = if (View.MeasureSpec.getMode(heightMeasureSpec) == View.MeasureSpec.UNSPECIFIED) available else minOf(available, incoming)
            super.onMeasure(widthMeasureSpec, View.MeasureSpec.makeMeasureSpec(maxHeight, View.MeasureSpec.AT_MOST))
        }
    }

    private fun string(source: JSONObject, key: String): String = source.optString(key).takeUnless { it == "null" }.orEmpty().trim()
    private fun completionTime(value: String): String {
        if (value.isBlank()) return "-"
        val time = value.split(' ', 'T').lastOrNull().orEmpty()
        return if (Regex("^(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$").matches(time)) time else value
    }
    private fun formattedWage(value: Double): String {
        return String.format(Locale.US, "%.2f", value)
    }
}

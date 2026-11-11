package com.pulseim.android

import android.animation.ValueAnimator
import android.app.Activity
import android.app.Dialog
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.accessibility.AccessibilityManager
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/** The view is recreated on entry; automatic presentation history survives navigation and login. */
internal class GroupAnnouncementUi(
    private val activity: Activity,
    private val history: GroupAnnouncementHistory,
    private val scroll: () -> ScrollView?,
    private val current: () -> Boolean,
    private val mayPresent: () -> Boolean,
) {
    private fun dp(value: Int) = (value * activity.resources.displayMetrics.density).toInt()
    val bar = LinearLayout(activity).apply {
        id = R.id.group_announcement_bar
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(12), 0, dp(2), 0); setBackgroundColor(0xFFFFF2C6.toInt())
        visibility = View.GONE
    }
    private val summary = TextView(activity).apply {
        id = R.id.group_announcement_text
        textSize = 14f; setTextColor(0xFF795811.toInt()); gravity = Gravity.CENTER_VERTICAL
        setSingleLine(true); marqueeRepeatLimit = -1
        isFocusable = true; contentDescription = "群公告，点击查看全文"
        setOnClickListener { showFullText() }
    }
    private var content = ""
    private var hiddenContent: String? = null
    private var dialog: Dialog? = null
    private var destroyed = false
    private val presentation = object : Runnable {
        override fun run() {
            if (destroyed || !current() || !bar.isAttachedToWindow) return
            updateMotion()
            if (content.isBlank() || history.wasPresented()) return
            if (mayPresent()) showFullText() else bar.postDelayed(this, 250)
        }
    }

    init {
        bar.addView(TextView(activity).apply {
            text = "公告"; textSize = 12f; setTextColor(0xFF795811.toInt())
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            setPadding(0, 0, dp(9), 0)
        }, LinearLayout.LayoutParams(-2, dp(44)))
        bar.addView(summary, LinearLayout.LayoutParams(0, dp(44), 1f))
        bar.addView(TextView(activity).apply {
            id = R.id.group_announcement_close; text = "×"; textSize = 24f
            gravity = Gravity.CENTER; setTextColor(0xFF795811.toInt()); isFocusable = true
            contentDescription = "关闭本次进群的当前公告条"
            setOnClickListener { hiddenContent = content; updateStrip() }
        }, LinearLayout.LayoutParams(dp(44), dp(44)))
        bar.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
            override fun onViewAttachedToWindow(view: View) { resume() }
            override fun onViewDetachedFromWindow(view: View) { pause() }
        })
    }

    fun accept(value: String) {
        if (destroyed || !current()) return
        val next = value.takeUnless { it.isBlank() }.orEmpty()
        if (next != content) {
            dialog?.dismiss(); content = next; hiddenContent = null
            summary.text = next
            summary.contentDescription = "群公告：${next.replace('\n', ' ')}。点击查看全文"
        }
        updateStrip(); resume()
    }

    private fun updateStrip() {
        val visibility = if (content.isNotBlank() && hiddenContent != content) View.VISIBLE else View.GONE
        if (bar.visibility != visibility) {
            // Keep the same reading anchor, including a reader already at the bottom.
            val viewport = scroll(); val oldTop = viewport?.top ?: 0; val oldY = viewport?.scrollY ?: 0
            val child = viewport?.getChildAt(0)
            val bottom = viewport != null && oldY >= ((child?.height ?: 0) - viewport.height).coerceAtLeast(0) - dp(24)
            bar.visibility = visibility
            viewport?.post {
                if (!destroyed && current() && scroll() === viewport) {
                    if (bottom) viewport.scrollTo(0, ((child?.height ?: 0) - viewport.height).coerceAtLeast(0))
                    else viewport.scrollTo(0, (oldY + viewport.top - oldTop).coerceAtLeast(0))
                }
            }
        }
        updateMotion()
    }

    private fun updateMotion() {
        val accessibility = activity.getSystemService(Context.ACCESSIBILITY_SERVICE) as AccessibilityManager
        val animate = !destroyed && current() && bar.isAttachedToWindow && bar.visibility == View.VISIBLE &&
            ValueAnimator.areAnimatorsEnabled() && !accessibility.isTouchExplorationEnabled
        summary.ellipsize = if (animate) TextUtils.TruncateAt.MARQUEE else TextUtils.TruncateAt.END
        summary.isSelected = animate
    }

    fun resume() {
        bar.removeCallbacks(presentation)
        if (destroyed || !current()) { summary.isSelected = false; return }
        updateMotion(); bar.post(presentation)
    }

    fun pause() {
        bar.removeCallbacks(presentation); summary.isSelected = false
        dialog?.dismiss(); dialog = null
    }

    fun destroy() { destroyed = true; pause() }

    private fun showFullText() {
        if (destroyed || !current() || !mayPresent() || content.isBlank() || dialog?.isShowing == true) return
        val shownContent = content
        val popup = Dialog(activity).apply { requestWindowFeature(Window.FEATURE_NO_TITLE) }
        val card = LinearLayout(activity).apply {
            id = R.id.group_announcement_dialog; orientation = LinearLayout.VERTICAL
            setPadding(dp(22), dp(22), dp(22), dp(18))
            background = GradientDrawable().apply { setColor(Color.WHITE); cornerRadius = dp(18).toFloat() }
        }
        card.addView(TextView(activity).apply {
            text = "群公告"; textSize = 20f; typeface = Typeface.DEFAULT_BOLD
            setTextColor(0xFF202020.toInt()); gravity = Gravity.CENTER
        }, LinearLayout.LayoutParams(-1, -2))
        val body = TextView(activity).apply {
            id = R.id.group_announcement_body; text = shownContent; textSize = 16f
            setTextColor(0xFF333333.toInt()); setLineSpacing(dp(5).toFloat(), 1f)
            setTextIsSelectable(true); setPadding(0, dp(4), 0, dp(8))
        }
        card.addView(ScrollView(activity).apply {
            id = R.id.group_announcement_scroll; addView(body, ViewGroup.LayoutParams(-1, -2))
        }, LinearLayout.LayoutParams(-1, 0, 1f).apply { topMargin = dp(18); bottomMargin = dp(16) })
        card.addView(TextView(activity).apply {
            id = R.id.group_announcement_confirm; text = "我知道了"; textSize = 16f
            setTextColor(Color.WHITE); gravity = Gravity.CENTER; isFocusable = true
            background = GradientDrawable().apply { setColor(0xFF3279FF.toInt()); cornerRadius = dp(24).toFloat() }
            setOnClickListener { popup.dismiss() }
        }, LinearLayout.LayoutParams(-1, dp(48)))
        val metrics = activity.resources.displayMetrics
        popup.setContentView(card, ViewGroup.LayoutParams(minOf(metrics.widthPixels - dp(40), dp(480)), (metrics.heightPixels * .72f).toInt()))
        popup.setCanceledOnTouchOutside(false)
        popup.window?.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        popup.setOnDismissListener { if (dialog === popup) { dialog = null; resume() } }
        dialog = popup
        popup.show()
        // Persist only an actual presentation. Empty, failed and deferred loads consume nothing.
        if (popup.isShowing) history.markPresented()
    }
}

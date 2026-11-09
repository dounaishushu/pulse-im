package com.pulseim.android

import android.app.Dialog
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.os.Build
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.Window
import android.view.WindowManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject

/** The same compact white recipient chooser as the desktop reference. */
internal class ForwardRecipientDialog(context: Context, private val resolveAvatar: (String) -> String) : Dialog(context) {
    var onPick: (String) -> Unit = {}
    var onMore: () -> Unit = {}
    var onRetry: () -> Unit = {}
    var onSearch: () -> Unit = {}
    private val density = context.resources.displayMetrics.density
    private fun dp(value: Int) = (value * density + .5f).toInt()
    private val blue = 0xFF0099DB.toInt()
    private val muted = 0xFF929BA4.toInt()
    private val root = LinearLayout(context).apply {
        id = R.id.message_forward_dialog; orientation = LinearLayout.VERTICAL
        background = GradientDrawable().apply { setColor(Color.WHITE); cornerRadius = dp(8).toFloat() }; clipToOutline = true
        isFocusableInTouchMode = true
    }
    private val search = EditText(context).apply {
        id = R.id.message_forward_search; hint = "搜索"; textSize = 14f
        setTextColor(Color.BLACK); setHintTextColor(0xFF999999.toInt()); background = null
        setPadding(0, 0, 0, 0); setSingleLine(true); gravity = Gravity.CENTER_VERTICAL
        inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_FILTER
        importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO; contentDescription = "搜索接收者"
    }
    val query: String get() = search.text.toString().trim()
    private val rows = LinearLayout(context).apply { id = R.id.message_forward_targets; orientation = LinearLayout.VERTICAL }
    private val more = command("加载更多会话", R.id.message_forward_more) { onMore() }
    private val empty = label("没有找到接收者", 14f, muted).apply { gravity = Gravity.CENTER; setPadding(0, dp(24), 0, dp(24)) }
    private var allowAutoLoad = false
    private val scroll = ScrollView(context).apply {
        isFillViewport = false; isVerticalScrollBarEnabled = true; setPadding(0, dp(8), 0, dp(4))
        if (Build.VERSION.SDK_INT >= 29) {
            verticalScrollbarThumbDrawable = GradientDrawable().apply { setColor(0xFF999999.toInt()); cornerRadius = dp(3).toFloat(); setSize(dp(5), dp(40)) }
            verticalScrollbarTrackDrawable = ColorDrawable(0xFFF1F1F1.toInt())
        }
        addView(LinearLayout(context).apply { orientation = LinearLayout.VERTICAL; addView(rows); addView(empty); addView(more) })
        setOnScrollChangeListener { _: View, _: Int, y: Int, _: Int, _: Int ->
            if (allowAutoLoad && getChildAt(0).height - y - height < dp(100)) onMore()
        }
    }
    private val status = label("", 12f, 0xFF7C8994.toInt()).apply {
        id = R.id.message_forward_status; maxLines = 3; ellipsize = TextUtils.TruncateAt.END
        accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
    }
    private val retry = command("重试", R.id.message_forward_retry) { onRetry() }
    private val cancel = command("取消", R.id.message_forward_cancel) { dismiss() }
    private var targets = emptyList<JSONObject>()
    private var busy = false
    private var locked = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        requestWindowFeature(Window.FEATURE_NO_TITLE)
        super.onCreate(savedInstanceState)
        root.addView(label("选择接收者...", 16f, Color.BLACK).apply {
            id = R.id.message_forward_title; typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            gravity = Gravity.CENTER_VERTICAL; setPadding(dp(24), 0, dp(24), 0)
        }, LinearLayout.LayoutParams(-1, dp(44)))
        root.addView(LinearLayout(context).apply {
            gravity = Gravity.CENTER_VERTICAL; setPadding(dp(18), 0, dp(18), 0)
            addView(ForwardRecipientIcon(context, false), LinearLayout.LayoutParams(dp(18), dp(18)).apply { rightMargin = dp(10) })
            addView(search, LinearLayout.LayoutParams(0, -1, 1f))
        }, LinearLayout.LayoutParams(-1, dp(48)))
        root.addView(View(context).apply { setBackgroundColor(0xFFE5E5E5.toInt()) }, LinearLayout.LayoutParams(-1, dp(1)))
        root.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
        root.addView(View(context).apply { setBackgroundColor(0xFFE5E5E5.toInt()) }, LinearLayout.LayoutParams(-1, dp(1)))
        root.addView(LinearLayout(context).apply {
            gravity = Gravity.CENTER_VERTICAL or Gravity.END; minimumHeight = dp(54); setPadding(dp(16), 0, dp(16), 0)
            addView(status, LinearLayout.LayoutParams(0, -2, 1f))
            addView(retry, LinearLayout.LayoutParams(-2, dp(40)))
            addView(cancel, LinearLayout.LayoutParams(dp(52), dp(40)))
        }, LinearLayout.LayoutParams(-1, -2))
        setContentView(root)
        search.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { renderRows(); scroll.scrollTo(0, 0); onSearch() }
            override fun afterTextChanged(s: Editable?) {}
        })
        root.requestFocus()
    }

    override fun onStart() {
        super.onStart()
        val visible = Rect()
        (ownerActivity?.window?.decorView ?: window?.decorView)?.getWindowVisibleDisplayFrame(visible)
        val display = context.resources.displayMetrics
        window?.apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT)); setDimAmount(.5f)
            addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            setLayout(minOf(dp(364), display.widthPixels - dp(24)), minOf(dp(1000), (visible.height().takeIf { it > 0 } ?: display.heightPixels) - dp(16)))
            setGravity(Gravity.CENTER)
            setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE or WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN)
        }
    }

    fun render(items: List<JSONObject>, hasMore: Boolean, loading: Boolean, sending: Boolean, lockedKey: String,
               feedback: String, failed: Boolean, completed: Int, total: Int, loadError: Boolean) {
        targets = items; busy = sending; locked = lockedKey; allowAutoLoad = hasMore && !loading && !loadError && !busy && locked.isEmpty()
        search.isEnabled = !busy && locked.isEmpty()
        status.text = feedback; status.visibility = if (feedback.isEmpty()) View.GONE else View.VISIBLE
        retry.visibility = if (failed) View.VISIBLE else View.GONE; retry.isEnabled = !busy
        retry.text = if (completed > 0) "继续转发 ${total - completed} 条" else "重试"
        more.visibility = if (hasMore && locked.isEmpty()) View.VISIBLE else View.GONE
        more.isEnabled = !loading && !busy
        more.text = if (loading) "正在加载…" else if (loadError) "重试加载会话" else "加载更多会话"
        renderRows()
    }

    private fun renderRows() {
        val position = scroll.scrollY
        rows.removeAllViews()
        val favorite = JSONObject().put("id", 0).put("type", "favorites").put("name", "收藏夹")
        val keyword = query.lowercase()
        val filtered = (listOf(favorite) + targets.filter { it.optString("type") != "favorites" }).filter { item ->
            keyword.isEmpty() || listOf(name(item), value(item, "username"), value(item, "peer_public_id"), value(item, "remark")).any { it.lowercase().contains(keyword) }
        }
        empty.visibility = if (filtered.isEmpty()) View.VISIBLE else View.GONE
        filtered.forEach { item ->
            val key = if (item.optString("type") == "favorites") "favorites" else item.optInt("id").toString()
            val title = name(item)
            rows.addView(LinearLayout(context).apply {
                id = R.id.message_forward_recipient; tag = key; contentDescription = "转发到 $title"
                gravity = Gravity.CENTER_VERTICAL; setPadding(dp(16), 0, dp(16), 0)
                isEnabled = !busy && locked.isEmpty(); isFocusable = true
                background = rowBackground(key == locked)
                addView(avatar(item), LinearLayout.LayoutParams(dp(42), dp(42)).apply { rightMargin = dp(16) })
                addView(LinearLayout(context).apply {
                    orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_VERTICAL
                    addView(label(title, 14f, Color.BLACK).apply { typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL) }, LinearLayout.LayoutParams(-1, dp(19)))
                    addView(label(subtitle(item), 14f, muted), LinearLayout.LayoutParams(-1, dp(19)).apply { topMargin = dp(3) })
                }, LinearLayout.LayoutParams(0, -2, 1f))
                setOnClickListener { if (!busy && locked.isEmpty()) onPick(key) }
            }, LinearLayout.LayoutParams(-1, dp(56)))
        }
        scroll.post { scroll.scrollTo(0, position) }
    }

    private fun avatar(item: JSONObject): View {
        val colors = arrayOf(intArrayOf(0xFF59B7FF.toInt(), 0xFF3989D7.toInt()), intArrayOf(0xFFFF9B62.toInt(), 0xFFE34E45.toInt()),
            intArrayOf(0xFF65D4DF.toInt(), 0xFF2B9AC7.toInt()), intArrayOf(0xFFFF89B3.toInt(), 0xFFE64D82.toInt()), intArrayOf(0xFFA0D66B.toInt(), 0xFF65AF48.toInt()))
        val favorite = item.optString("type") == "favorites"
        return FrameLayout(context).apply {
            background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, colors[if (favorite) 0 else item.optInt("id").mod(colors.size)]).apply { shape = GradientDrawable.OVAL }
            clipToOutline = true; importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
            if (favorite) addView(ForwardRecipientIcon(context, true), FrameLayout.LayoutParams(dp(24), dp(24), Gravity.CENTER))
            else {
                addView(label(name(item).take(1), 20f, Color.WHITE).apply { gravity = Gravity.CENTER }, FrameLayout.LayoutParams(-1, -1))
                value(item, "avatar_url").takeIf { it.isNotBlank() }?.let { raw ->
                    addView(ImageView(context).apply { scaleType = ImageView.ScaleType.CENTER_CROP; ChatAvatars.bind(this, resolveAvatar(raw)) }, FrameLayout.LayoutParams(-1, -1))
                }
            }
        }
    }
    private fun name(item: JSONObject) = if (item.optString("type") == "favorites") "收藏夹" else value(item, "name").ifBlank { "会话" }
    private fun subtitle(item: JSONObject) = when {
        item.optString("type") == "favorites" -> "转发消息到这里以便快速访问"
        item.optBoolean("is_bot") || item.optBoolean("peer_is_bot") -> "机器人"
        item.optString("type") == "group" -> "群组"
        item.optString("type") == "channel" -> "频道"
        item.optString("type") == "customer_service" -> "客服"
        item.optBoolean("peer_online") -> "在线"
        value(item, "peer_last_seen_at").isNotBlank() -> "近期曾上线"
        else -> "最近上线时间不可见"
    }
    private fun value(item: JSONObject, key: String) = item.optString(key).takeUnless { it == "null" }.orEmpty()
    private fun label(value: String, size: Float, color: Int) = TextView(context).apply {
        text = value; textSize = size; setTextColor(color); includeFontPadding = false
        maxLines = 1; ellipsize = TextUtils.TruncateAt.END; setPadding(0, 0, 0, 0); gravity = Gravity.CENTER_VERTICAL
    }
    private fun command(value: String, viewId: Int, click: () -> Unit) = label(value, 14f, blue).apply {
        id = viewId; gravity = Gravity.CENTER; setPadding(dp(8), 0, dp(8), 0)
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL); isFocusable = true
        background = rowBackground(false); setOnClickListener { click() }
    }
    private fun rowBackground(selected: Boolean) = StateListDrawable().apply {
        addState(intArrayOf(android.R.attr.state_pressed), ColorDrawable(0xFFF1F1F1.toInt()))
        addState(intArrayOf(android.R.attr.state_focused), ColorDrawable(0xFFF1F1F1.toInt()))
        addState(intArrayOf(), ColorDrawable(if (selected) 0xFFF1F1F1.toInt() else Color.WHITE))
    }
}

private class ForwardRecipientIcon(context: Context, private val bookmark: Boolean) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = if (bookmark) 1.8f else 1.65f; strokeJoin = Paint.Join.ROUND; strokeCap = Paint.Cap.ROUND }
    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        canvas.save(); canvas.scale(width / 24f, height / 24f)
        paint.color = if (bookmark) Color.WHITE else 0xFF999999.toInt()
        if (bookmark) canvas.drawPath(Path().apply { moveTo(6f, 3.5f); lineTo(18f, 3.5f); lineTo(18f, 20.5f); lineTo(12f, 16.5f); lineTo(6f, 20.5f); close() }, paint)
        else { canvas.drawCircle(10.5f, 10.5f, 5.5f, paint); canvas.drawLine(6.5f, 14.5f, 2.5f, 18.5f, paint) }
        canvas.restore()
    }
}

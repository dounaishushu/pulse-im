package com.pulseim.android

import android.app.Activity
import android.app.AlertDialog
import android.app.Dialog
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.Window
import android.view.WindowManager
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject
import java.util.concurrent.Executor

private object ContactCardColors {
    val muted: Int get() = AppAppearance.ink(0xFF7B8790.toInt())
    val accent: Int get() = AppAppearance.ink(0xFF159A78.toInt())
}

/** Own-contact selection only. The message contains an ID, never profile fields. */
internal class ContactCardPicker(
    private val activity: Activity, private val actorId: Int, private val executor: Executor,
    private val current: () -> Boolean, private val fetch: (Int) -> JSONObject,
    private val loadImage: (ImageView, TextView, String) -> Unit,
    private val send: (Int) -> Unit
) : Dialog(activity) {
    private fun dp(value: Int) = (value * context.resources.displayMetrics.density + .5f).toInt()
    private fun label(value: String, size: Float = 14f) = TextView(context).apply { text = value; textSize = size; setTextColor(AppAppearance.ink(Color.BLACK)) }
    private val entries = linkedMapOf<Int, JSONObject>()
    private var page = 0
    private var hasMore = true
    private var loading = false
    private var closed = false
    private var submitted = false
    private var confirmation: AlertDialog? = null
    private var failure = ""
    private val lifetimeCheck = object : Runnable {
        override fun run() { if (!closed && isShowing) { if (!current()) dismiss() else window?.decorView?.postDelayed(this, 200) } }
    }
    private val search = EditText(context).apply {
        id = R.id.contact_card_search; hint = "搜索昵称 / 用户名 / ID"; setSingleLine(true); textSize = 14f
        setTextColor(AppAppearance.ink(Color.BLACK)); setHintTextColor(ContactCardColors.muted)
        inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_FILTER
        importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO; setPadding(dp(16), 0, dp(16), 0)
    }
    private val rows = LinearLayout(context).apply { id = R.id.contact_card_rows; orientation = LinearLayout.VERTICAL }
    private val status = label("正在加载联系人…", 13f).apply { id = R.id.contact_card_status; setTextColor(ContactCardColors.muted); setPadding(dp(18), dp(16), dp(18), dp(16)); accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE }
    private val more = label("加载更多联系人").apply { id = R.id.contact_card_more; setTextColor(ContactCardColors.accent); gravity = Gravity.CENTER; setPadding(0, dp(16), 0, dp(16)); setOnClickListener { load() } }
    private val retry = label("重试加载联系人").apply { id = R.id.contact_card_retry; setTextColor(ContactCardColors.accent); gravity = Gravity.CENTER; setPadding(0, dp(14), 0, dp(14)); setOnClickListener { failure = ""; load() } }
    private fun valid() = !closed && isShowing && current()
    override fun onCreate(savedInstanceState: Bundle?) {
        requestWindowFeature(Window.FEATURE_NO_TITLE); super.onCreate(savedInstanceState)
        val root = LinearLayout(context).apply {
            id = R.id.contact_card_picker; orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply { setColor(AppAppearance.background(Color.WHITE)); cornerRadius = dp(16).toFloat() }; clipToOutline = true
        }
        root.addView(label("发送名片", 18f).apply { typeface = Typeface.DEFAULT_BOLD; setPadding(dp(20), dp(20), dp(20), dp(16)) })
        root.addView(search, LinearLayout.LayoutParams(-1, dp(48)))
        root.addView(ScrollView(context).apply { addView(LinearLayout(context).apply { orientation = LinearLayout.VERTICAL; addView(rows); addView(status); addView(retry); addView(more) }) }, LinearLayout.LayoutParams(-1, 0, 1f))
        root.addView(label("取消").apply { id = R.id.contact_card_cancel; gravity = Gravity.CENTER; setTextColor(ContactCardColors.accent); setPadding(0, dp(18), 0, dp(18)); setOnClickListener { dismiss() } })
        setContentView(root)
        search.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { render(); if (s?.isNotBlank() == true && failure.isEmpty()) load() }
            override fun afterTextChanged(s: Editable?) {}
        })
        window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE or WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN)
    }
    override fun onStart() {
        super.onStart(); window?.setBackgroundDrawableResource(android.R.color.transparent)
        window?.setLayout((context.resources.displayMetrics.widthPixels * .94f).toInt(), (context.resources.displayMetrics.heightPixels * .76f).toInt())
        window?.decorView?.post(lifetimeCheck)
        window?.decorView?.post { if (page == 0) load() }
    }
    override fun dismiss() { closed = true; window?.decorView?.removeCallbacks(lifetimeCheck); confirmation?.dismiss(); confirmation = null; super.dismiss() }
    override fun cancel() { closed = true; window?.decorView?.removeCallbacks(lifetimeCheck); confirmation?.dismiss(); confirmation = null; super.cancel() }
    private fun render() {
        rows.removeAllViews()
        val query = search.text.toString().trim()
        val matches = entries.values.filter { item -> query.isEmpty() || listOf("nickname", "remark", "username", "public_id").any { item.optString(it).takeUnless { value -> value == "null" }.orEmpty().contains(query, ignoreCase = true) } }
        for (item in matches) {
            val name = item.optString("nickname").ifBlank { "联系人" }
            val row = LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(dp(16), dp(10), dp(16), dp(10))
                tag = "contact-card-${item.optInt("user_id")}"; contentDescription = "发送$name 的名片"; isFocusable = true
                addView(IOSGroupChatStyle.avatar(context, name, item.optString("avatar_url").takeUnless { it == "null" }.orEmpty(), loadImage), LinearLayout.LayoutParams(dp(42), dp(42)))
                addView(LinearLayout(context).apply {
                    orientation = LinearLayout.VERTICAL; setPadding(dp(12), 0, 0, 0)
                    addView(label(item.optString("remark").takeIf { it.isNotBlank() && it != "null" } ?: name, 15f).apply { typeface = Typeface.DEFAULT_BOLD; maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END })
                    addView(label("用户 ID：${PublicUserId.display(item.opt("public_id"))}", 12f).apply { setTextColor(ContactCardColors.muted) })
                }, LinearLayout.LayoutParams(0, -2, 1f))
            }
            row.setOnClickListener {
                if (!valid() || submitted || confirmation != null) return@setOnClickListener
                confirmation = AlertDialog.Builder(activity).setTitle("发送名片").setMessage("将$name 的名片发送到当前聊天？")
                    .setNegativeButton("取消", null).setPositiveButton("发送") { _, _ ->
                        if (valid() && !submitted) { submitted = true; val id = item.optInt("user_id"); send(id); dismiss() }
                    }.create().also { dialog -> dialog.setOnDismissListener { if (confirmation === dialog) confirmation = null }; dialog.show() }
            }
            rows.addView(row)
        }
        status.text = when { failure.isNotEmpty() -> "联系人加载失败，请重试"; loading -> "正在加载联系人…"; matches.isEmpty() -> if (query.isEmpty()) "暂无联系人" else "未找到匹配联系人"; else -> "选择一位联系人，发送其个人名片" }
        retry.visibility = if (failure.isNotEmpty()) View.VISIBLE else View.GONE
        more.visibility = if (hasMore && !loading && failure.isEmpty()) View.VISIBLE else View.GONE
    }
    private fun load() {
        if (!valid() || loading || !hasMore) return
        val next = page + 1; loading = true; failure = ""; render()
        executor.execute {
            try {
                if (!valid()) return@execute
                val result = fetch(next); val items = result.getJSONArray("items")
                check(result.optInt("page") == next && result.optInt("size") in 1..100) { "联系人分页响应无效" }
                activity.runOnUiThread {
                    if (!valid()) return@runOnUiThread
                    for (i in 0 until items.length()) items.optJSONObject(i)?.let { item -> val id = item.optInt("user_id"); if (id > 0 && id != actorId) entries[id] = item }
                    page = next; hasMore = items.length() > 0 && next.toLong() * result.optInt("size") < result.optLong("total")
                    loading = false; render(); if (search.text.isNotBlank() && hasMore) load()
                }
            } catch (error: Exception) { activity.runOnUiThread { if (valid()) { loading = false; failure = error.message ?: "加载失败"; render() } } }
        }
    }
}

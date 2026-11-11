package com.pulseim.android

import android.content.Context
import android.graphics.Typeface
import android.text.Editable
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.widget.*
import org.json.JSONObject
import java.util.concurrent.Executors

/** Mention helpers are limited to the current group owner and admins. */
internal class GroupMentionPicker(c: Context, private val input: EditText, private val current: () -> Boolean,
    private val allowed: () -> Boolean, private val search: (String, Int) -> JSONObject,
    private val loadAvatar: (ImageView, TextView, String) -> Unit) : LinearLayout(c) {
    private data class Token(val start: Int, val end: Int, val query: String, val draft: String)
    private val worker = Executors.newSingleThreadExecutor()
    private var revision = 0
    private var token: Token? = null
    private var denied = false
    private var loading = false
    private var page = 1
    private val rows = LinearLayout(c).apply { orientation = VERTICAL }
    private val update = Runnable { load(1) }
    val action = TextView(c).apply {
        id = R.id.group_mention_button; text = "@"; textSize = 22f; gravity = Gravity.CENTER
        setTextColor(IOSGroupChatStyle.blue); contentDescription = "艾特群成员"; isFocusable = true
        setOnClickListener {
            if (!available() || !input.isEnabled) return@setOnClickListener
            input.requestFocus()
            if (readToken() == null) {
                val a = input.selectionStart.coerceIn(0, input.length()); val b = input.selectionEnd.coerceIn(0, input.length())
                val from = minOf(a,b); val to = maxOf(a,b)
                val prefix = if (from > 0 && !input.text[from-1].isWhitespace()) " " else ""
                input.text.replace(from,to,prefix+"@"); input.setSelection(from+prefix.length+1)
            }
            changed(); (c.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.showSoftInput(input,InputMethodManager.SHOW_IMPLICIT)
        }
    }
    private val watcher = object : TextWatcher {
        override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
        override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
        override fun afterTextChanged(s: Editable?) { changed() }
    }
    init {
        id = R.id.group_mention_picker; orientation = VERTICAL; visibility = GONE
        setBackgroundColor(IOSGroupChatStyle.surface()); elevation = dp(3).toFloat()
        addView(ScrollView(c).apply { addView(rows); isFillViewport = false },LayoutParams(-1,dp(48)))
        input.addTextChangedListener(watcher); input.setOnClickListener { changed() }; refreshPermission()
    }
    private fun dp(v: Int) = IOSGroupChatStyle.dp(context,v)
    private fun resizeRows() { getChildAt(0).layoutParams = LayoutParams(-1,dp((rows.childCount * 48).coerceIn(48,208))) }
    private fun available() = current() && allowed() && !denied
    fun refreshPermission() { action.visibility = if (available()) VISIBLE else GONE; if (!available()) dismiss() }
    fun dismiss() { removeCallbacks(update); revision++; loading = false; token = null; visibility = GONE; rows.removeAllViews() }
    private fun readToken(): Token? {
        val end = input.selectionStart
        if (end < 0 || end != input.selectionEnd) return null
        val value = input.text.toString()
        val m = Regex("(?:^|\\s)@([^\\s@]{0,80})$").find(value.substring(0,end)) ?: return null
        return Token(end-m.groupValues[1].length-1,end,m.groupValues[1],value)
    }
    private fun changed() {
        dismiss(); refreshPermission()
        val change = revision
        fun settled() {
            if (change != revision || !isAttachedToWindow || !available() || !input.hasFocus() || !input.isEnabled) return
            // IMEs may remove composing spans without another text-change event.
            if (android.view.inputmethod.BaseInputConnection.getComposingSpanStart(input.text) >= 0) { postDelayed({ settled() },80); return }
            token = readToken() ?: return; postDelayed(update,180)
        }
        post { settled() }
    }
    private fun matches(t: Token,r: Int) = isAttachedToWindow && available() && r == revision && token == t && input.text.toString() == t.draft && input.selectionStart == t.end && input.selectionEnd == t.end
    private fun label(value: String, click: (() -> Unit)? = null): TextView = TextView(context).apply {
        text = value; textSize = 13f; setTextColor(IOSGroupChatStyle.muted()); gravity = Gravity.CENTER; minHeight = dp(44)
        if (click != null) { isFocusable = true; setOnClickListener { click() } }
    }
    private fun load(next: Int) {
        val t = token ?: return
        if (!available() || !input.isEnabled) { dismiss(); return }
        if (android.view.inputmethod.BaseInputConnection.getComposingSpanStart(input.text) >= 0) { postDelayed({ load(next) },80); return }
        if (loading) return
        val request = ++revision; loading = true; visibility = VISIBLE
        if (next == 1) { rows.removeAllViews(); rows.addView(label("正在查找群成员…")); resizeRows() }
        worker.execute {
            try {
                val response = search(t.query,next)
                post {
                    if (!matches(t,request)) return@post
                    loading = false
                    if (!response.optBoolean("can_search")) { denied = true; refreshPermission(); return@post }
                    if (next == 1) rows.removeAllViews() else rows.findViewWithTag<View>("more")?.let { rows.removeView(it) }
                    val items = response.optJSONArray("items")
                    if (items != null) for (i in 0 until items.length()) {
                        val item = items.getJSONObject(i); if (item.optInt("user_id") <= 0 || item.optString("nickname").isBlank()) continue
                        val line = LinearLayout(context).apply { orientation = HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; minimumHeight = dp(48); setPadding(dp(12),dp(4),dp(12),dp(4)); isFocusable = true }
                        val name = item.optString("nickname")
                        line.addView(IOSGroupChatStyle.avatar(context,name,item.optString("avatar_url"),loadAvatar),LayoutParams(dp(36),dp(36)))
                        val copy = LinearLayout(context).apply { orientation = VERTICAL; setPadding(dp(10),0,dp(8),0) }
                        copy.addView(TextView(context).apply { text = name; textSize = 14f; setTextColor(IOSGroupChatStyle.ink()); setTypeface(null,Typeface.BOLD) })
                        val username = item.optString("username").takeUnless { it == "null" }.orEmpty()
                        copy.addView(TextView(context).apply { text = if (username.isNotBlank()) "@$username" else "ID: ${item.optString("public_id","")}"; textSize = 12f; setTextColor(IOSGroupChatStyle.muted()) })
                        line.addView(copy,LayoutParams(0,-2,1f)); line.contentDescription = "艾特 $name"; line.setOnClickListener { choose(t,item) }; rows.addView(line)
                    }
                    page = next
                    if (rows.childCount == 0) rows.addView(label("未找到匹配成员"))
                    if (response.optBoolean("has_more")) rows.addView(label("加载更多") { load(page+1) }.apply { tag = "more" })
                    resizeRows()
                }
            } catch (_: Exception) { post { if (matches(t,request)) { loading = false; if (next == 1) rows.removeAllViews(); rows.addView(label("加载失败，点击重试") { load(next) }); resizeRows() } } }
        }
    }
    private fun choose(t: Token,item: JSONObject) {
        if (!matches(t,revision) || !input.isEnabled) { dismiss(); return }
        val normalized = item.optString("nickname").filter { !it.isISOControl() && Character.getType(it) != Character.FORMAT.toInt() }.replace(Regex("\\s+")," ").trim()
        val points = normalized.codePoints().limit(80).toArray(); val name = String(points,0,points.size)
        val value = "@$name "
        if (name.isBlank() || input.length()-(t.end-t.start)+value.length > 5000) return
        dismiss(); input.text.replace(t.start,t.end,value); input.setSelection(t.start+value.length); input.requestFocus()
    }
    override fun onDetachedFromWindow() { dismiss(); input.removeTextChangedListener(watcher); worker.shutdownNow(); super.onDetachedFromWindow() }
}

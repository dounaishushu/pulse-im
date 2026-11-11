package com.pulseim.android

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Color
import android.view.Gravity
import android.view.View
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONArray
import java.net.URI

/** A website-only browser. Its requests never receive the application's API headers or bridge. */
internal class ExplorePanel(private val activity: Activity, private val current: () -> Boolean) : LinearLayout(activity) {
    private data class Entry(val name: String, val url: String)
    private var entries = emptyList<Entry>()
    private var selected: Entry? = null
    private var disposed = false
    private var web: WebView? = null
    private var mainUrl = ""
    private var failedUrl: String? = null
    private val entryButtons = LinearLayout(activity).apply { orientation = HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    private val selector = HorizontalScrollView(activity).apply { id = R.id.explore_selector; isHorizontalScrollBarEnabled = false; addView(entryButtons) }
    private val reload = button("刷新", R.id.explore_reload) { retry() }
    private val entryRow = LinearLayout(activity).apply { orientation = HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    private val loading = TextView(activity).apply { id = R.id.explore_loading; text = "网页加载中…"; textSize = 12f; gravity = Gravity.CENTER; setTextColor(0xFF159A78.toInt()); visibility = GONE }
    private val body = FrameLayout(activity)
    private val errorBox = LinearLayout(activity).apply { orientation = VERTICAL; gravity = Gravity.CENTER; setPadding(dp(20), dp(16), dp(20), dp(16)); setBackgroundColor(Color.WHITE); visibility = GONE }
    private val error = TextView(activity).apply { id = R.id.explore_error; text = "网页加载失败，请检查网络后重试"; textSize = 15f; gravity = Gravity.CENTER; setTextColor(0xFF7B8790.toInt()) }
    private val retryButton = button("重试", R.id.explore_retry) { retry() }
    private val empty = TextView(activity).apply { id = R.id.explore_empty; text = "暂无可用探索入口\n管理员配置有效网页后会显示在这里"; textSize = 15f; gravity = Gravity.CENTER; setTextColor(0xFF7B8790.toInt()); visibility = GONE }

    init {
        id = R.id.explore_panel; orientation = VERTICAL; setBackgroundColor(Color.WHITE)
        entryRow.addView(selector, LayoutParams(0, dp(46), 1f))
        entryRow.addView(reload, LayoutParams(dp(62), dp(44)))
        addView(entryRow, LayoutParams(-1, dp(46)))
        addView(loading, LayoutParams(-1, dp(24)))
        errorBox.addView(error, LayoutParams(-1, -2)); errorBox.addView(retryButton, LayoutParams(dp(110), dp(48)).apply { topMargin = dp(14) })
        body.addView(empty, FrameLayout.LayoutParams(-1, -1)); body.addView(errorBox, FrameLayout.LayoutParams(-1, -1))
        addView(body, LayoutParams(-1, 0, 1f))
        controls()
    }

    fun updateLinks(values: JSONArray) {
        if (disposed) return
        val next = buildList<Entry> {
            for (index in 0 until values.length()) {
                val value = values.optJSONObject(index) ?: continue
                val url = validUrl(value.optString("url")) ?: continue
                if (none { it.url == url }) add(Entry(value.optString("name").trim().ifEmpty { "探索入口" }.take(32), url))
                // Both server-managed lists allow ten entries; the merged list may contain twenty.
                if (size == 20) break
            }
        }
        val active = next.firstOrNull { it.url == selected?.url } ?: next.firstOrNull()
        entries = next
        renderSelector()
        if (active == null) {
            selected = null; destroyWeb(); loading.visibility = GONE; errorBox.visibility = GONE; empty.visibility = VISIBLE; controls()
        } else if (selected?.url == active.url && web != null) {
            selected = active; controls()
        } else open(active)
    }

    private fun renderSelector() {
        entryButtons.removeAllViews(); entryRow.visibility = if (entries.isNotEmpty()) VISIBLE else GONE
        entries.forEachIndexed { index, entry ->
            entryButtons.addView(button(entry.name, ENTRY_IDS.getOrNull(index) ?: View.generateViewId()) { if (entry.url != selected?.url) open(entry) }.apply {
                tag = entry.url; contentDescription = "打开探索入口：${entry.name}"; isSelected = entry.url == selected?.url
            }, LayoutParams(-2, dp(44)))
        }
    }

    private fun live(owner: WebView) = !disposed && web === owner && isAttachedToWindow && current()
    private fun beginNavigation(url: String) {
        mainUrl = url; failedUrl = null; loading.visibility = VISIBLE; errorBox.visibility = GONE; controls()
    }
    private fun open(entry: Entry, targetUrl: String = entry.url) {
        if (disposed || !current() || !isAttachedToWindow) return
        destroyWeb(); selected = entry; mainUrl = targetUrl; failedUrl = null
        empty.visibility = GONE; errorBox.visibility = GONE; loading.visibility = VISIBLE
        val owner = WebView(activity).apply {
            id = R.id.explore_web; tag = entry.url
            settings.javaScriptEnabled = true; settings.domStorageEnabled = true; settings.loadsImagesAutomatically = true
            settings.allowFileAccess = false; settings.allowContentAccess = false
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            settings.setSupportMultipleWindows(false); settings.javaScriptCanOpenWindowsAutomatically = false
        }
        web = owner
        owner.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (!live(view) || validUrl(request.url.toString()) == null) return true
                if (request.isForMainFrame) beginNavigation(request.url.toString())
                return false
            }
            @Deprecated("Legacy navigation callback")
            override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean {
                if (!live(view) || validUrl(url) == null) return true
                beginNavigation(url); return false
            }
            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                if (!live(view)) return
                // HTTP errors can arrive before this callback. A start for the same
                // navigation must not erase its actionable failure or retry target.
                if (mainUrl != url) beginNavigation(url)
                else { if (failedUrl == null) loading.visibility = VISIBLE; controls() }
            }
            override fun onPageFinished(view: WebView, url: String) {
                if (!live(view) || mainUrl != url || view.url != url) return
                loading.visibility = GONE; controls()
            }
            override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) { if (live(view)) controls() }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, failure: WebResourceError) {
                if (request.isForMainFrame && live(view) && request.url.toString() == mainUrl) {
                    showError(if (failure.description.toString().contains("ERR_CLEARTEXT_NOT_PERMITTED")) "当前应用不允许此 HTTP 网页，请使用 HTTPS 地址" else "网页加载失败，请检查网络后重试", request.url.toString())
                }
            }
            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                if (request.isForMainFrame && response.statusCode >= 400 && live(view) && request.url.toString() == mainUrl) showError("网页返回错误（${response.statusCode}），请稍后重试", request.url.toString())
            }
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                if (web === view) { destroyWeb(); if (!disposed && current()) showError() }
                return true
            }
        }
        body.addView(owner, 0, FrameLayout.LayoutParams(-1, -1)); controls(); renderSelector()
        owner.loadUrl(targetUrl)
    }

    private fun showError(message: String = "网页加载失败，请检查网络后重试", targetUrl: String = mainUrl) {
        failedUrl = validUrl(targetUrl) ?: selected?.url
        error.text = message; loading.visibility = GONE; errorBox.visibility = VISIBLE; controls()
    }
    private fun retry() {
        if (disposed || !current()) return
        val failedTarget = failedUrl
        val owner = web
        if (owner == null) { selected?.let { open(it, failedTarget ?: it.url) }; return }
        errorBox.visibility = GONE; loading.visibility = VISIBLE
        failedUrl = null
        if (failedTarget != null) { mainUrl = failedTarget; owner.loadUrl(failedTarget) }
        else { mainUrl = owner.url?.takeIf { validUrl(it) != null } ?: selected?.url.orEmpty(); owner.reload() }
    }
    fun back(): Boolean {
        val owner = web ?: return false
        if (!live(owner) || !owner.canGoBack()) return false
        failedUrl = null; errorBox.visibility = GONE; loading.visibility = VISIBLE; owner.goBack(); return true
    }
    private fun controls() {
        reload.isEnabled = !disposed && selected != null
        retryButton.isEnabled = !disposed && selected != null
    }
    private fun destroyWeb() {
        val old = web ?: return
        web = null; old.stopLoading(); old.webViewClient = WebViewClient(); body.removeView(old); old.clearHistory(); old.destroy()
    }
    fun dispose() {
        if (disposed) return
        disposed = true; destroyWeb(); loading.visibility = GONE; controls()
    }
    override fun onDetachedFromWindow() { dispose(); super.onDetachedFromWindow() }
    private fun button(label: String, identifier: Int, action: () -> Unit) = Button(activity).apply {
        id = identifier; text = label; textSize = 13f; isAllCaps = false; minWidth = 0; minimumWidth = 0; setPadding(dp(7), 0, dp(7), 0)
        setTextColor(0xFF159A78.toInt()); setOnClickListener { action() }
    }
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    companion object {
        private val ENTRY_IDS = intArrayOf(R.id.explore_entry_0, R.id.explore_entry_1, R.id.explore_entry_2, R.id.explore_entry_3, R.id.explore_entry_4, R.id.explore_entry_5, R.id.explore_entry_6, R.id.explore_entry_7, R.id.explore_entry_8, R.id.explore_entry_9)
        private fun validUrl(raw: String): String? {
            val value = raw.trim()
            if (value.isEmpty() || value.length > 2048 || value.any { it.isWhitespace() || it.isISOControl() }) return null
            return runCatching { URI(value).takeIf {
                it.isAbsolute && it.scheme.lowercase() in setOf("http", "https") && !it.host.isNullOrBlank() && it.rawUserInfo == null && (it.port == -1 || it.port in 1..65535)
            }?.toASCIIString() }.getOrNull()
        }
    }
}

package com.pulseim.android

import android.app.Activity
import android.app.Dialog
import android.graphics.Bitmap
import android.graphics.Color
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.util.concurrent.ExecutorService
import java.util.concurrent.Future

/** Image-only state: preview and retries never initialize or submit task answers. */
internal class QuestionImagePanel(
    private val activity: Activity,
    private val executor: ExecutorService,
    private val cacheScope: String,
    private val resolve: (String, String) -> String,
    private val current: () -> Boolean
) : FrameLayout(activity) {
    private val picture = ImageView(activity).apply {
        id = R.id.work_question_image; scaleType = ImageView.ScaleType.FIT_CENTER
        setBackgroundColor(Color.WHITE); contentDescription = "任务题目图片，点击放大"
    }
    private val status = TextView(activity).apply {
        id = R.id.work_question_status; gravity = Gravity.CENTER; textSize = 14f
        setTextColor(0xFF7B8790.toInt()); setBackgroundColor(Color.WHITE)
    }
    private val hint = TextView(activity).apply {
        id = R.id.work_question_zoom_hint; text = "点击图片放大 · 双指缩放"; textSize = 12f
        gravity = Gravity.CENTER; setTextColor(0xFF159A78.toInt()); setBackgroundColor(Color.WHITE)
    }
    @Volatile private var revision = 0
    private var loadTask: Future<*>? = null
    private var mediaId = ""
    private var question = ""
    private var rawUrl = ""
    private var label = ""
    private var bitmap: Bitmap? = null
    private var preview: Dialog? = null
    init {
        addView(picture, LayoutParams(-1, -1).apply { bottomMargin = dp(28) })
        addView(status, LayoutParams(-1, -1).apply { bottomMargin = dp(28) })
        addView(hint, LayoutParams(-1, dp(28), Gravity.BOTTOM))
        picture.setOnClickListener { showPreview() }; hint.setOnClickListener { showPreview() }
        status.setOnClickListener { if (status.isEnabled) load() }
    }
    fun bind(uuid: String, url: String, title: String, media: String = "") {
        if (question == uuid && rawUrl == url && mediaId == media && (bitmap != null || loadTask?.isDone == false)) {
            label = title; return
        }
        cancelLoad(); dismissPreview(); question = uuid; rawUrl = url; mediaId = media; label = title
        bitmap = null; picture.setImageDrawable(null); picture.tag = uuid
        picture.contentDescription = "$title，点击放大题目图片"; hint.isEnabled = false
        val cached = runCatching { ChatImageCache.cached(cacheScope, rawUrl) }.getOrNull()
        if (cached != null) { display(cached); return }
        status.text = "题目图片加载中…"; status.visibility = View.VISIBLE; status.isEnabled = false
        load()
    }
    private fun valid(request: Int, uuid: String) = revision == request && question == uuid && isAttachedToWindow && current()
    private fun cancelLoad() { revision++; loadTask?.cancel(true); loadTask = null }
    private fun display(value: Bitmap) {
        bitmap = value; picture.setImageBitmap(value); status.visibility = View.GONE; hint.isEnabled = true
    }
    private fun load() {
        if (!current() || !isAttachedToWindow || executor.isShutdown || rawUrl.isBlank()) return
        cancelLoad()
        val request = revision; val uuid = question; val raw = rawUrl; val media = mediaId
        status.text = "题目图片加载中…"; status.visibility = View.VISIBLE; status.isEnabled = false
        loadTask = executor.submit {
            try {
                if (!valid(request, uuid) || Thread.currentThread().isInterrupted) return@submit
                // Authorization, transfer and decoding all stay off the UI thread.
                val url = resolve(raw, media)
                val loaded = ChatImageCache.load(activity, cacheScope, url, 2560) { valid(request, uuid) && !Thread.currentThread().isInterrupted }
                activity.runOnUiThread { if (valid(request, uuid)) display(loaded) }
            } catch (_: Exception) {
                activity.runOnUiThread { if (valid(request, uuid)) { status.text = "题目图片加载失败\n点击重试"; status.isEnabled = true; status.visibility = View.VISIBLE } }
            }
        }
    }
    override fun onAttachedToWindow() { super.onAttachedToWindow(); if (bitmap == null && rawUrl.isNotBlank()) load() }
    private fun showPreview() {
        val loaded = bitmap ?: return
        if (!current() || !isAttachedToWindow || picture.tag != question || preview?.isShowing == true) return
        val request = revision; val uuid = question
        val dialog = BackSwipeDialog(activity, android.R.style.Theme_Material_Light_NoActionBar_Fullscreen)
        val root = LinearLayout(activity).apply { id = R.id.work_image_preview_root; orientation = LinearLayout.VERTICAL; setBackgroundColor(Color.BLACK) }
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        val top = LinearLayout(activity).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(dp(12), 0, dp(8), 0) }
        top.addView(TextView(activity).apply { id = R.id.work_image_preview_title; text = label; textSize = 16f; setTextColor(Color.WHITE); gravity = Gravity.CENTER_VERTICAL }, LinearLayout.LayoutParams(0, dp(56), 1f))
        top.addView(Button(activity).apply { id = R.id.work_image_preview_close; text = "关闭"; contentDescription = "关闭题目图片预览"; isAllCaps = false; setOnClickListener { dialog.dismiss() } }, LinearLayout.LayoutParams(dp(78), dp(50)))
        root.addView(top, LinearLayout.LayoutParams(-1, dp(56)))
        root.addView(QuestionZoomImageView(activity).apply { id = R.id.work_image_preview_image; setImageBitmap(loaded) }, LinearLayout.LayoutParams(-1, 0, 1f))
        root.addView(TextView(activity).apply { text = "双指缩放 · 拖动查看 · 双击还原"; textSize = 12f; setTextColor(Color.WHITE); gravity = Gravity.CENTER }, LinearLayout.LayoutParams(-1, dp(34)))
        dialog.setContentView(root); dialog.setCancelable(true); dialog.setCanceledOnTouchOutside(false)
        dialog.setOnDismissListener { if (preview === dialog) preview = null }
        if (!valid(request, uuid)) return
        preview = dialog; dialog.show(); dialog.window?.setLayout(-1, -1); ViewCompat.requestApplyInsets(root)
    }
    fun dismissPreview() { preview?.dismiss(); preview = null }
    override fun onDetachedFromWindow() { cancelLoad(); dismissPreview(); bitmap = null; picture.setImageDrawable(null); super.onDetachedFromWindow() }
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
}

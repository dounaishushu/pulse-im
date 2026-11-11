package com.pulseim.android

import android.app.Activity
import android.app.Dialog
import android.graphics.Bitmap
import android.graphics.BitmapFactory
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
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ExecutorService

/** Image-only state: preview and retries never initialize or submit task answers. */
internal class QuestionImagePanel(
    private val activity: Activity,
    private val executor: ExecutorService,
    private val resolve: (String) -> String,
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
    private var revision = 0
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
    fun bind(uuid: String, url: String, title: String) {
        dismissPreview(); revision++; question = uuid; rawUrl = url; label = title
        bitmap = null; picture.setImageDrawable(null); picture.tag = uuid
        picture.contentDescription = "$title，点击放大题目图片"; hint.isEnabled = false
        load()
    }
    private fun valid(request: Int, uuid: String) = revision == request && question == uuid && isAttachedToWindow && current()
    private fun load() {
        if (!current() || !isAttachedToWindow) return
        val request = ++revision; val uuid = question; val url = resolve(rawUrl)
        status.text = "题目图片加载中…"; status.visibility = View.VISIBLE; status.isEnabled = false
        executor.execute {
            try {
                val connection = URL(url).openConnection() as HttpURLConnection
                val bytes = try {
                    connection.connectTimeout = 8000; connection.readTimeout = 12000; connection.useCaches = false
                    require(connection.responseCode in 200..299) { "图片请求失败" }
                    connection.inputStream.use { input ->
                        val output = ByteArrayOutputStream(); val buffer = ByteArray(16 * 1024)
                        while (true) { val count = input.read(buffer); if (count < 0) break; require(output.size() + count <= 20 * 1024 * 1024) { "图片过大" }; output.write(buffer, 0, count) }
                        output.toByteArray()
                    }
                } finally { connection.disconnect() }
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }; BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                require(bounds.outWidth > 0 && bounds.outHeight > 0) { "无法读取图片" }
                val options = BitmapFactory.Options().apply {
                    inSampleSize = 1
                    while (bounds.outWidth.toLong() * bounds.outHeight / inSampleSize / inSampleSize > 8000000L || maxOf(bounds.outWidth, bounds.outHeight) / inSampleSize > 8192) inSampleSize *= 2
                    inScaled = false
                }
                val loaded = requireNotNull(BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)) { "无法解码图片" }
                activity.runOnUiThread {
                    if (!valid(request, uuid)) { loaded.recycle(); return@runOnUiThread }
                    bitmap = loaded; picture.setImageBitmap(loaded); status.visibility = View.GONE; hint.isEnabled = true
                }
            } catch (_: Exception) {
                activity.runOnUiThread { if (valid(request, uuid)) { status.text = "题目图片加载失败\n点击重试"; status.isEnabled = true; status.visibility = View.VISIBLE } }
            }
        }
    }
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
    override fun onDetachedFromWindow() { revision++; dismissPreview(); bitmap = null; picture.setImageDrawable(null); super.onDetachedFromWindow() }
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
}

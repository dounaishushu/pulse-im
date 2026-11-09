package com.pulseim.android

import android.app.Activity
import android.app.Dialog
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.drawable.ColorDrawable
import android.media.ExifInterface
import android.net.Uri
import android.view.GestureDetector
import android.view.Gravity
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import java.util.concurrent.Executors

/** Local-only preview. The caller receives the URI only after the explicit send action. */
internal class PhotoSendPreview(private val activity: Activity, uris: List<Uri>, initialIndex: Int, selection: List<Uri>,
    private val onSelectionChanged: (List<Uri>, Uri) -> Unit, private val onSend: (List<Uri>) -> Unit) :
    Dialog(activity, android.R.style.Theme_Black_NoTitleBar_Fullscreen) {
    constructor(activity: Activity, uri: Uri, onSend: (Uri) -> Unit) : this(activity, listOf(uri), 0, listOf(uri), { _, _ -> }, { onSend(it.single()) })
    private val items = uris.distinct()
    private val selected = selection.filter { it in items }.toCollection(linkedSetOf())
    private var index = initialIndex.coerceIn(0, (items.size - 1).coerceAtLeast(0))
    private val worker = Executors.newSingleThreadExecutor()
    private var revision = 0
    private var submitted = false
    private var ready = false
    private val root = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(Color.BLACK) }
    private val image = PreviewPhotoImage(activity).apply { id = R.id.photo_preview_image; contentDescription = "待发送图片，可双指缩放或双击查看" }
    private val status = label("正在加载图片…", 14f).apply { id = R.id.photo_preview_status; gravity = Gravity.CENTER }
    private val retry = label("重新加载", 15f).apply { id = R.id.photo_preview_retry; gravity = Gravity.CENTER; visibility = View.GONE; setOnClickListener { load() } }
    private val send = label("发送", 15f).apply { id = R.id.photo_preview_send; gravity = Gravity.CENTER; isEnabled = false; alpha = .45f }
    private val counter = label("图片预览", 17f).apply { id = R.id.photo_preview_counter; gravity = Gravity.CENTER }
    private val previous = label("上一张", 15f).apply { id = R.id.photo_preview_previous; gravity = Gravity.CENTER; setOnClickListener { showIndex(index - 1) } }
    private val next = label("下一张", 15f).apply { id = R.id.photo_preview_next; gravity = Gravity.CENTER; setOnClickListener { showIndex(index + 1) } }
    private val remove = label("取消选择", 15f).apply { id = R.id.photo_preview_remove; gravity = Gravity.CENTER; setOnClickListener { removeCurrent() } }
    private fun dp(value: Int) = (activity.resources.displayMetrics.density * value + .5f).toInt()
    private fun label(value: String, size: Float) = TextView(activity).apply { text = value; textSize = size; setTextColor(Color.WHITE); includeFontPadding = false }
    init {
        require(items.isNotEmpty() && selected.size <= PhotoAlbumPickerActivity.MAX_CHAT_PHOTOS && items.all { it.scheme == "content" })
        val bar = LinearLayout(activity).apply { gravity = Gravity.CENTER_VERTICAL; setPadding(dp(8), dp(6), dp(12), dp(6)) }
        bar.addView(label("‹ 返回", 17f).apply { id = R.id.photo_preview_back; gravity = Gravity.CENTER; contentDescription = "返回相册重新选择"; setOnClickListener { dismiss() } }, LinearLayout.LayoutParams(dp(76), dp(48)))
        bar.addView(counter, LinearLayout.LayoutParams(0, dp(48), 1f))
        send.background = android.graphics.drawable.GradientDrawable().apply { setColor(0xFF2586D5.toInt()); cornerRadius = dp(7).toFloat() }
        send.setOnClickListener {
            if (ready && !submitted) {
                val confirmed = if (selected.isEmpty()) listOf(items[index]) else selected.toList()
                submitted = true; send.isEnabled = false; onSend(confirmed)
            }
        }
        bar.addView(send, LinearLayout.LayoutParams(dp(90), dp(38)))
        root.addView(bar)
        root.addView(FrameLayout(activity).apply {
            addView(image, FrameLayout.LayoutParams(-1, -1))
            addView(LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER; addView(status); addView(retry, LinearLayout.LayoutParams(dp(160), dp(48))) }, FrameLayout.LayoutParams(-1, -1))
            addView(imagePreviewCloseButton(activity) { dismiss() }, FrameLayout.LayoutParams(dp(84), dp(48), Gravity.BOTTOM or Gravity.START).apply { leftMargin = dp(12); bottomMargin = dp(12) })
        }, LinearLayout.LayoutParams(-1, 0, 1f))
        root.addView(LinearLayout(activity).apply {
            gravity = Gravity.CENTER_VERTICAL
            addView(previous, LinearLayout.LayoutParams(0, dp(48), 1f))
            addView(remove, LinearLayout.LayoutParams(0, dp(48), 1f))
            addView(next, LinearLayout.LayoutParams(0, dp(48), 1f))
        })
        image.onSwipe = { direction -> showIndex(index + direction) }
        root.addView(label("左右滑动切换 · 双指缩放或双击查看", 12f).apply { setTextColor(0xFFAAAAAA.toInt()); gravity = Gravity.CENTER }, LinearLayout.LayoutParams(-1, dp(38)))
        setContentView(root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom); insets
        }
    }
    override fun onStart() {
        super.onStart()
        window?.let { w -> WindowCompat.setDecorFitsSystemWindows(w, false); w.setBackgroundDrawable(ColorDrawable(Color.BLACK)); w.setLayout(-1, -1); w.statusBarColor = Color.BLACK; w.navigationBarColor = Color.BLACK; WindowCompat.getInsetsController(w, root).apply { isAppearanceLightStatusBars = false; isAppearanceLightNavigationBars = false } }
        ViewCompat.requestApplyInsets(root)
        load()
    }
    private fun load() {
        if (items.isEmpty() || submitted) return
        val uri = items[index]
        val request = ++revision; ready = false; send.isEnabled = false; send.alpha = .45f
        counter.text = if (items.size == 1) "图片预览" else "图片预览 ${index + 1}/${items.size}"
        counter.contentDescription = "当前第${index + 1}张，共${items.size}张照片"
        updateSelection()
        previous.isEnabled = index > 0; previous.alpha = if (previous.isEnabled) 1f else .35f
        next.isEnabled = index < items.lastIndex; next.alpha = if (next.isEnabled) 1f else .35f
        onSelectionChanged(selected.toList(), uri)
        image.setImageDrawable(null); status.text = "正在加载图片…"; status.visibility = View.VISIBLE; retry.visibility = View.GONE
        worker.execute {
            if (request != revision) return@execute
            val bitmap = runCatching { decode(uri) }.getOrNull()
            activity.runOnUiThread {
                if (request != revision || !isShowing || activity.isFinishing || activity.isDestroyed) { bitmap?.recycle(); return@runOnUiThread }
                if (bitmap == null) { status.text = "图片无法预览，请重试或返回重新选择"; retry.visibility = View.VISIBLE }
                else { image.setImageBitmap(bitmap); ready = true; updateSelection(); status.visibility = View.GONE }
            }
        }
    }
    private fun showIndex(value: Int) {
        if (!submitted && value in items.indices && value != index) { index = value; load() }
    }
    private fun removeCurrent() {
        if (submitted || items.isEmpty()) return
        val uri = items[index]
        if (uri in selected) selected.remove(uri)
        else if (selected.size < PhotoAlbumPickerActivity.MAX_CHAT_PHOTOS) selected.add(uri)
        else { android.widget.Toast.makeText(activity, "一次最多选择${PhotoAlbumPickerActivity.MAX_CHAT_PHOTOS}张照片", android.widget.Toast.LENGTH_SHORT).show(); return }
        updateSelection(); onSelectionChanged(selected.toList(), uri)
    }
    private fun updateSelection() {
        send.text = if (selected.isEmpty()) "发送此图" else "发送(${selected.size})"
        send.contentDescription = if (selected.isEmpty()) "发送当前预览的照片" else "发送已选${selected.size}张照片"
        send.isEnabled = ready; send.alpha = if (send.isEnabled) 1f else .45f
        remove.text = if (items.getOrNull(index) in selected) "取消选择" else "选择此图"
        remove.contentDescription = remove.text
    }
    private fun decode(uri: Uri): Bitmap {
        val resolver = activity.contentResolver
        val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) }
        require(options.outWidth > 0 && options.outHeight > 0)
        options.inJustDecodeBounds = false; options.inSampleSize = 1
        while (maxOf(options.outWidth, options.outHeight) / options.inSampleSize > 3072) options.inSampleSize *= 2
        val source = resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) } ?: error("图片无法读取")
        val orientation = runCatching { resolver.openInputStream(uri)?.use { ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) } }.getOrNull()
        val matrix = Matrix().apply { when (orientation) {
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> setScale(-1f, 1f)
            ExifInterface.ORIENTATION_ROTATE_180 -> setRotate(180f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> setScale(1f, -1f)
            ExifInterface.ORIENTATION_TRANSPOSE -> { setRotate(90f); postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_ROTATE_90 -> setRotate(90f)
            ExifInterface.ORIENTATION_TRANSVERSE -> { setRotate(-90f); postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_ROTATE_270 -> setRotate(-90f)
        } }
        if (matrix.isIdentity) return source
        return try { Bitmap.createBitmap(source, 0, 0, source.width, source.height, matrix, true).also { if (it !== source) source.recycle() } }
        catch (error: Throwable) { source.recycle(); throw error }
    }
    override fun onStop() { revision++; ready = false; worker.shutdownNow(); image.setImageDrawable(null); super.onStop() }
}

/** Keep the exit outside the zoomed image transform and always visible. */
internal fun imagePreviewCloseButton(context: android.content.Context, close: () -> Unit): TextView {
    fun dp(value: Int) = (context.resources.displayMetrics.density * value + .5f).toInt()
    return TextView(context).apply {
        id = R.id.photo_preview_close
        text = "× 关闭"; textSize = 16f; gravity = Gravity.CENTER
        setTextColor(Color.WHITE); includeFontPadding = false
        background = android.graphics.drawable.GradientDrawable().apply {
            setColor(0xDD25262B.toInt()); cornerRadius = dp(24).toFloat(); setStroke(dp(1), 0x88FFFFFF.toInt())
        }
        elevation = dp(6).toFloat(); isClickable = true; isFocusable = true
        contentDescription = "关闭图片预览，返回上一页"
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        setOnClickListener { close() }
    }
}

/** Aspect-fit image with bounded pan, pinch zoom and double-tap zoom. */
internal class PreviewPhotoImage(context: android.content.Context) : ImageView(context) {
    var onSwipe: ((Int) -> Unit)? = null
    val isZoomed get() = zoom > 1.001f
    private var zoom = 1f
    private var base = 1f
    private var offsetX = 0f
    private var offsetY = 0f
    private var lastX = 0f
    private var lastY = 0f
    private val pinch = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScale(detector: ScaleGestureDetector): Boolean { zoomTo(zoom * detector.scaleFactor, detector.focusX, detector.focusY); return true }
    })
    private val taps = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
        override fun onDown(event: MotionEvent) = true
        override fun onDoubleTap(event: MotionEvent): Boolean { if (zoom > 1f) fit() else zoomTo(2.5f, event.x, event.y); return true }
        override fun onFling(first: MotionEvent?, last: MotionEvent, velocityX: Float, velocityY: Float): Boolean {
            val start = first ?: return false
            val dx = last.x - start.x; val dy = last.y - start.y
            if (zoom == 1f && kotlin.math.abs(dx) > width * .18f && kotlin.math.abs(dx) > kotlin.math.abs(dy) * 1.5f && onSwipe != null) {
                onSwipe?.invoke(if (dx < 0) 1 else -1); return true
            }
            return false
        }
    })
    init { scaleType = ScaleType.MATRIX }
    override fun setImageBitmap(bitmap: Bitmap?) { super.setImageBitmap(bitmap); fit() }
    /** A sharper copy of the same photo must not reset a gesture in progress. */
    fun upgradeBitmap(bitmap: Bitmap) {
        val previous = drawable ?: run { setImageBitmap(bitmap); return }
        if ((previous as? android.graphics.drawable.BitmapDrawable)?.bitmap === bitmap) return
        val centerX = (width / 2f - offsetX) / (previous.intrinsicWidth * base * zoom).coerceAtLeast(1f)
        val centerY = (height / 2f - offsetY) / (previous.intrinsicHeight * base * zoom).coerceAtLeast(1f)
        val oldZoom = zoom
        super.setImageBitmap(bitmap); fit(); zoom = oldZoom
        offsetX = width / 2f - centerX * bitmap.width * base * zoom
        offsetY = height / 2f - centerY * bitmap.height * base * zoom
        render()
    }
    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) { super.onSizeChanged(w, h, oldw, oldh); fit() }
    private fun fit() { val d = drawable ?: return; if (width <= 0 || height <= 0) return; base = minOf(width.toFloat() / d.intrinsicWidth, height.toFloat() / d.intrinsicHeight); zoom = 1f; offsetX = (width - d.intrinsicWidth * base) / 2; offsetY = (height - d.intrinsicHeight * base) / 2; render() }
    private fun zoomTo(value: Float, x: Float, y: Float) { val next = value.coerceIn(1f, 5f); val ratio = next / zoom; offsetX = x + (offsetX - x) * ratio; offsetY = y + (offsetY - y) * ratio; zoom = next; render() }
    private fun render() {
        val d = drawable ?: return; val w = d.intrinsicWidth * base * zoom; val h = d.intrinsicHeight * base * zoom
        offsetX = if (w <= width) (width - w) / 2 else offsetX.coerceIn(width - w, 0f)
        offsetY = if (h <= height) (height - h) / 2 else offsetY.coerceIn(height - h, 0f)
        imageMatrix = Matrix().apply { setScale(base * zoom, base * zoom); postTranslate(offsetX, offsetY) }
    }
    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (drawable == null) return false
        pinch.onTouchEvent(event); taps.onTouchEvent(event)
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> { lastX = event.x; lastY = event.y; parent?.requestDisallowInterceptTouchEvent(true) }
            MotionEvent.ACTION_POINTER_DOWN, MotionEvent.ACTION_POINTER_UP -> {
                val remaining = if (event.actionMasked == MotionEvent.ACTION_POINTER_UP && event.actionIndex == 0 && event.pointerCount > 1) 1 else 0
                lastX = event.getX(remaining); lastY = event.getY(remaining)
            }
            MotionEvent.ACTION_MOVE -> { if (!pinch.isInProgress && event.pointerCount == 1) { offsetX += event.x - lastX; offsetY += event.y - lastY; render() }; lastX = event.x; lastY = event.y }
            MotionEvent.ACTION_UP -> { parent?.requestDisallowInterceptTouchEvent(false); performClick() }
            MotionEvent.ACTION_CANCEL -> parent?.requestDisallowInterceptTouchEvent(false)
        }
        return true
    }
    override fun performClick(): Boolean = super.performClick()
}

package com.pulseim.android

import android.app.Activity
import android.app.Dialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.media.MediaPlayer
import android.media.AudioAttributes
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.webkit.MimeTypeMap
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.MediaController
import android.widget.TextView
import android.widget.Toast
import android.widget.VideoView
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.Collections
import java.util.Locale
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.roundToInt

/** One instance belongs to one captured account/conversation. Never reuse it after close(). */
internal class GroupMessageMedia(
    private val activity: Activity,
    private val imageScope: String,
    private val resolveUrl: (String) -> String,
    private val isCurrent: () -> Boolean,
    private val refreshImage: ((JSONObject) -> String)? = null,
    private val cacheConversationId: Int = 0,
    private val cacheScope: String = imageScope
) {
    data class VoiceState(
        val messageId: Int,
        val loading: Boolean,
        val playing: Boolean,
        val durationSeconds: Int = 0,
        val positionSeconds: Int = 0,
        val error: String? = null
    )

    private val handler = Handler(Looper.getMainLooper())
    private val executor = Executors.newFixedThreadPool(2)
    private val posters = VideoPosterLoader(resolveUrl) { alive() }
    private val connections = Collections.synchronizedSet(mutableSetOf<HttpURLConnection>())
    private val previewGeneration = AtomicInteger()
    private val voiceGeneration = AtomicInteger()
    private val fileGeneration = AtomicInteger()
    @Volatile private var closed = false
    private var previewDialog: Dialog? = null
    private var previewVideo: VideoView? = null
    private var player: MediaPlayer? = null
    private var voiceID = 0
    private var voiceListener: ((VoiceState) -> Unit)? = null
    private var voiceLoading = false
    private var voiceDuration = 0

    private val playbackTick = object : Runnable {
        override fun run() {
            if (!alive()) { close(); return }
            val active = player ?: return
            val playing = runCatching { active.isPlaying }.getOrDefault(false)
            emitVoice(playing = playing)
            if (playing) handler.postDelayed(this, 500)
        }
    }

    fun showImage(rawUrl: String, refresh: (() -> String)? = null) = onMain {
        if (!alive()) return@onMain
        var url = resolved(rawUrl) ?: return@onMain
        dismissPreview()
        val generation = previewGeneration.incrementAndGet()
        val dialog = preview("图片预览")
        val root = dialog.findViewById<FrameLayout>(android.R.id.content).getChildAt(0) as FrameLayout
        val image = PreviewPhotoImage(activity).apply { contentDescription = "聊天图片，可双指缩放或双击查看" }
        (dialog as? BackSwipeDialog)?.swipeBackEnabled = { !image.isZoomed }
        root.addView(image, 0, FrameLayout.LayoutParams(-1, -1).apply { topMargin = dp(56); bottomMargin = dp(16) })
        (ChatImageCache.cached(imageScope, url) ?: ChatImageCache.cached(imageScope, ChatImagePreview.url(url)))?.let { image.setImageBitmap(it) }
        val status = statusLabel("图片加载中…")
        root.addView(status, FrameLayout.LayoutParams(-1, -1).apply { topMargin = dp(56) })
        fun load() {
            if (!previewCurrent(dialog, generation)) return
            status.text = "图片加载中…"; status.visibility = if (image.drawable == null) View.VISIBLE else View.GONE; status.isEnabled = false
            launch {
                try {
                    val bitmap = try {
                        ChatImageCache.load(activity, imageScope, url, 2560) { previewCurrent(dialog, generation) }
                    } catch (error: Exception) {
                        if (!ChatImageCache.authorizationExpired(error) || refresh == null || !previewCurrent(dialog, generation)) throw error
                        val fresh = refresh()
                        if (!previewCurrent(dialog, generation)) throw IOException("已取消")
                        url = resolved(fresh) ?: throw IOException("图片地址无效")
                        ChatImageCache.load(activity, imageScope, url, 2560) { previewCurrent(dialog, generation) }
                    }
                    handler.post {
                        if (!previewCurrent(dialog, generation)) return@post
                        image.upgradeBitmap(bitmap); status.visibility = View.GONE
                    }
                } catch (error: Exception) {
                    handler.post { if (previewCurrent(dialog, generation)) { status.text = "${friendlyError(error, "图片加载失败")}\n点击重试"; status.visibility = View.VISIBLE; status.isEnabled = true } }
                }
            }
        }
        status.setOnClickListener { load() }
        root.addView(imagePreviewCloseButton(activity) { dialog.dismiss() }, FrameLayout.LayoutParams(dp(84), dp(48), Gravity.BOTTOM or Gravity.START).apply { leftMargin = dp(12); bottomMargin = dp(12) })
        load()
    }

    fun toggleVoice(messageId: Int, rawUrl: String, onState: (VoiceState) -> Unit) = onMain {
        if (!alive() || messageId <= 0) return@onMain
        if (voiceID == messageId && (voiceLoading || player != null)) {
            voiceListener = onState
            if (voiceLoading) { stopAudio(true); return@onMain }
            val active = player ?: return@onMain
            try {
                if (active.isPlaying) { active.pause(); handler.removeCallbacks(playbackTick); emitVoice(playing = false) }
                else { active.start(); emitVoice(playing = true); handler.removeCallbacks(playbackTick); handler.post(playbackTick) }
            } catch (error: Exception) { voiceError(friendlyError(error, "语音播放失败")) }
            return@onMain
        }
        val url = resolved(rawUrl) ?: return@onMain
        stopAudio(true)
        val generation = voiceGeneration.incrementAndGet()
        voiceID = messageId; voiceListener = onState; voiceLoading = true; voiceDuration = 0
        emitVoice(playing = false)
        launch {
            try {
                val uri = Uri.parse(url)
                val path = uri.getQueryParameter("path") ?: uri.path.orEmpty()
                val suffix = path.substringAfterLast('.', "").lowercase(Locale.ROOT)
                val name = if (suffix in listOf("wav", "m4a", "mp3", "aac", "ogg", "opus", "webm")) "voice.$suffix" else "voice.audio"
                val file = download(url, name) { voiceGeneration.get() == generation }
                handler.post {
                    if (!alive() || voiceGeneration.get() != generation || voiceID != messageId) return@post
                    val media = MediaPlayer()
                    player = media
                    try {
                        media.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                        media.setDataSource(file.absolutePath)
                        media.setOnPreparedListener {
                            if (!voiceCurrent(media, generation, messageId)) { runCatching { media.release() }; return@setOnPreparedListener }
                            voiceLoading = false; voiceDuration = ((media.duration.toLong() + 999) / 1000).toInt()
                            try { media.start(); emitVoice(playing = true); handler.post(playbackTick) }
                            catch (error: Exception) { voiceError(friendlyError(error, "语音播放失败")) }
                        }
                        media.setOnCompletionListener {
                            if (voiceCurrent(media, generation, messageId)) {
                                handler.removeCallbacks(playbackTick)
                                runCatching { media.seekTo(0) }
                                emitVoice(playing = false, position = 0)
                            }
                        }
                        media.setOnErrorListener { _, _, _ ->
                            if (voiceCurrent(media, generation, messageId)) voiceError("语音播放失败，请重试")
                            true
                        }
                        media.prepareAsync()
                    } catch (error: Exception) { voiceError(friendlyError(error, "语音播放失败")) }
                }
            } catch (error: Exception) {
                handler.post { if (alive() && voiceGeneration.get() == generation && voiceID == messageId) voiceError(friendlyError(error, "语音加载失败")) }
            }
        }
    }

    fun openAttachment(message: JSONObject) = onMain {
        if (!alive()) return@onMain
        val frozen = JSONObject(message.toString())
        val body = frozen.optJSONObject("body") ?: return@onMain
        val raw = jsonString(body, "url")
        if (frozen.optString("type") == "image") {
            showImage(raw, refreshImage?.let { renew -> { renew(frozen) } }); return@onMain
        }
        val url = resolved(raw) ?: return@onMain
        if (RichMessageContent.isVideo(frozen)) { showVideo(url, safeName(jsonString(body, "name").ifBlank { "视频.mp4" })); return@onMain }
        val generation = fileGeneration.incrementAndGet()
        val name = safeName(jsonString(body, "name").ifBlank { Uri.parse(url).lastPathSegment ?: "附件" })
        val declaredSize = body.optLong("size", 0)
        if (declaredSize > MAX_BYTES) { notice("附件超过100MB，无法打开"); return@onMain }
        notice("正在下载附件…")
        launch {
            try {
                val file = download(url, name) { fileGeneration.get() == generation }
                handler.post {
                    if (!alive() || fileGeneration.get() != generation) return@post
                    try {
                        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
                        val mime = mimeType(jsonString(body, "mime"), name)
                        activity.startActivity(Intent(Intent.ACTION_VIEW).apply {
                            setDataAndType(uri, mime)
                            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                            clipData = android.content.ClipData.newRawUri("附件", uri)
                        })
                    } catch (_: ActivityNotFoundException) { notice("没有可打开此附件的应用") }
                    catch (_: Exception) { notice("附件无法打开，请重试") }
                }
            } catch (error: Exception) {
                handler.post { if (alive() && fileGeneration.get() == generation) notice(friendlyError(error, "附件下载失败，请重试")) }
            }
        }
    }

    fun loadVideoPreview(message: JSONObject, image: ImageView, status: TextView, duration: TextView) = posters.bind(message, image, status, duration)

    fun close() {
        if (closed) return
        closed = true
        posters.close()
        previewGeneration.incrementAndGet(); voiceGeneration.incrementAndGet(); fileGeneration.incrementAndGet()
        handler.removeCallbacksAndMessages(null)
        synchronized(connections) { connections.toList().forEach { runCatching { it.disconnect() } }; connections.clear() }
        executor.shutdownNow()
        onMain {
            stopAudio(false)
            dismissPreview()
        }
    }

    private fun showVideo(url: String, name: String) {
        stopAudio(true)
        dismissPreview()
        val generation = previewGeneration.incrementAndGet()
        val dialog = preview("视频预览")
        val root = dialog.findViewById<FrameLayout>(android.R.id.content).getChildAt(0) as FrameLayout
        val video = VideoView(activity)
        previewVideo = video
        root.addView(video, 0, FrameLayout.LayoutParams(-1, -1, Gravity.CENTER).apply { topMargin = dp(56); bottomMargin = dp(16) })
        val controls = MediaController(activity).apply { setAnchorView(video) }
        video.setMediaController(controls)
        val status = statusLabel("视频加载中…")
        root.addView(status, FrameLayout.LayoutParams(-1, -1).apply { topMargin = dp(56) })
        video.setOnPreparedListener {
            if (previewCurrent(dialog, generation)) { status.visibility = View.GONE; video.start() }
            else video.stopPlayback()
        }
        video.setOnErrorListener { _, _, _ ->
            if (previewCurrent(dialog, generation)) { status.text = "视频无法播放\n点击重试"; status.visibility = View.VISIBLE; status.isEnabled = true }
            true
        }
        fun load() {
            if (!previewCurrent(dialog, generation)) return
            video.stopPlayback(); status.text = "视频加载中…"; status.visibility = View.VISIBLE; status.isEnabled = false
            launch {
                try {
                    val file = download(url, name) { previewGeneration.get() == generation }
                    handler.post { if (previewCurrent(dialog, generation)) video.setVideoPath(file.absolutePath) }
                } catch (error: Exception) {
                    handler.post { if (previewCurrent(dialog, generation)) { status.text = "${friendlyError(error, "视频加载失败")}\n点击重试"; status.isEnabled = true } }
                }
            }
        }
        status.setOnClickListener { load() }
        load()
    }

    private fun preview(title: String): Dialog {
        val dialog = BackSwipeDialog(activity, if (AppAppearance.dark) R.style.AppThemeDark else R.style.AppTheme)
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
        val root = FrameLayout(activity).apply { setBackgroundColor(Color.BLACK) }
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        root.addView(TextView(activity).apply {
            text = title; textSize = 17f; setTextColor(Color.WHITE); gravity = Gravity.CENTER
        }, FrameLayout.LayoutParams(-1, dp(56)).apply { leftMargin = dp(72); rightMargin = dp(72) })
        root.addView(TextView(activity).apply {
            text = "关闭"; textSize = 15f; setTextColor(Color.WHITE); gravity = Gravity.CENTER
            contentDescription = "关闭$title"; isClickable = true; isFocusable = true
            setOnClickListener { dialog.dismiss() }
        }, FrameLayout.LayoutParams(dp(72), dp(56), Gravity.TOP or Gravity.END))
        dialog.setContentView(root)
        dialog.setOnDismissListener {
            if (previewDialog === dialog) {
                previewGeneration.incrementAndGet()
                runCatching { previewVideo?.stopPlayback() }
                previewVideo = null; previewDialog = null
            }
        }
        previewDialog = dialog
        dialog.show()
        dialog.window?.apply {
            setBackgroundDrawable(ColorDrawable(Color.BLACK))
            setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            statusBarColor = Color.BLACK; navigationBarColor = Color.BLACK
            WindowCompat.setDecorFitsSystemWindows(this, false)
            WindowCompat.getInsetsController(this, root).apply { isAppearanceLightStatusBars = false; isAppearanceLightNavigationBars = false }
            setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN)
        }
        ViewCompat.requestApplyInsets(root)
        return dialog
    }

    private fun dismissPreview() {
        previewGeneration.incrementAndGet()
        val dialog = previewDialog
        previewDialog = null
        runCatching { previewVideo?.stopPlayback() }
        previewVideo = null
        dialog?.dismiss()
    }

    private fun stopAudio(notify: Boolean) {
        voiceGeneration.incrementAndGet()
        handler.removeCallbacks(playbackTick)
        if (notify && voiceID > 0) emitVoice(playing = false, loading = false)
        val previous = player
        player = null
        runCatching { previous?.setOnPreparedListener(null); previous?.setOnCompletionListener(null); previous?.setOnErrorListener(null); previous?.release() }
        voiceID = 0; voiceListener = null; voiceLoading = false; voiceDuration = 0
    }

    private fun voiceError(message: String) {
        emitVoice(playing = false, loading = false, error = message)
        stopAudio(false)
    }

    private fun emitVoice(playing: Boolean, loading: Boolean = voiceLoading, position: Int? = null, error: String? = null) {
        if (!alive() || voiceID <= 0) return
        val seconds = position ?: if (voiceLoading) 0 else runCatching { (player?.currentPosition ?: 0) / 1000 }.getOrDefault(0)
        voiceListener?.invoke(VoiceState(voiceID, loading, playing, voiceDuration, seconds, error))
    }

    private fun voiceCurrent(media: MediaPlayer, generation: Int, messageId: Int) =
        alive() && player === media && voiceGeneration.get() == generation && voiceID == messageId
    private fun previewCurrent(dialog: Dialog, generation: Int) =
        alive() && previewDialog === dialog && dialog.isShowing && previewGeneration.get() == generation
    private fun alive() = !closed && !activity.isFinishing && !activity.isDestroyed && isCurrent()
    private fun onMain(action: () -> Unit) { if (Looper.myLooper() == Looper.getMainLooper()) action() else handler.post(action) }
    private fun launch(action: () -> Unit) {
        if (closed) return
        try { executor.execute(action) } catch (_: RejectedExecutionException) { /* close() won the submission race. */ }
    }
    private fun notice(value: String) { if (alive()) Toast.makeText(activity, value, Toast.LENGTH_SHORT).show() }
    private fun statusLabel(value: String) = TextView(activity).apply {
        text = value; textSize = 15f; setTextColor(Color.WHITE); gravity = Gravity.CENTER
        isClickable = true; isFocusable = true
    }
    private fun dp(value: Int) = (value * activity.resources.displayMetrics.density).roundToInt()
    private fun jsonString(value: JSONObject, name: String) = value.optString(name).takeUnless { it == "null" }.orEmpty().trim()
    private fun resolved(raw: String): String? = try {
        if (raw.isBlank()) throw IOException("附件地址为空")
        resolveUrl(raw).also { val url = URL(it); if (url.protocol !in listOf("http", "https") || url.host.isBlank() || url.userInfo != null) throw IOException("附件地址无效") }
    } catch (_: Exception) { notice("附件地址无效，请刷新会话后重试"); null }

    private fun download(url: String, name: String, current: () -> Boolean): File =
        LocalMediaCache.get(activity, cacheScope, cacheConversationId, url, name, { alive() && current() }) { valid -> downloadFresh(url, name, valid) }

    private fun downloadFresh(url: String, name: String, current: () -> Boolean): File {
        if (!alive() || !current()) throw IOException("已取消")
        val folder = File(activity.cacheDir, "group-media").apply { if (!isDirectory && !mkdirs()) throw IOException("无法创建附件缓存") }
        val file = File(folder, "${UUID.randomUUID()}-${safeName(name)}")
        val partial = File(folder, "${UUID.randomUUID()}.part")
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 10000; readTimeout = 20000; instanceFollowRedirects = false
            setRequestProperty("Accept", "*/*")
        }
        connections.add(connection)
        try {
            if (!alive() || !current()) throw IOException("已取消")
            val started = SystemClock.elapsedRealtime()
            if (connection.responseCode !in 200..299) throw IOException(if (connection.responseCode in listOf(401, 403)) "附件链接已失效，请刷新会话后重试" else "附件下载失败")
            if (connection.contentLengthLong > MAX_BYTES) throw IOException("附件超过100MB，无法打开")
            connection.inputStream.use { input ->
                partial.outputStream().use { output ->
                    val buffer = ByteArray(32 * 1024)
                    var total = 0L
                    while (true) {
                        if (!alive() || !current() || Thread.currentThread().isInterrupted) throw IOException("已取消")
                        if (SystemClock.elapsedRealtime() - started > 120000) throw IOException("下载超时，请重试")
                        val count = input.read(buffer)
                        if (count < 0) break
                        total += count
                        if (total > MAX_BYTES) throw IOException("附件超过100MB，无法打开")
                        output.write(buffer, 0, count)
                    }
                    if (total == 0L) throw IOException("附件内容为空")
                }
            }
            if (!alive() || !current()) throw IOException("已取消")
            if (!partial.renameTo(file)) throw IOException("无法保存附件缓存")
            return file
        } finally {
            partial.delete()
            connections.remove(connection)
            connection.disconnect()
        }
    }

    private fun safeName(raw: String): String = raw.substringAfterLast('/').substringAfterLast('\\')
        .replace(Regex("[\\p{Cntrl}\\\\/:*?\"<>|]"), "_").trim(' ', '.').take(100).ifBlank { "附件" }
    private fun mimeType(declared: String, name: String): String =
        if (Regex("^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$").matches(declared)) declared
        else MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase(Locale.ROOT)) ?: "application/octet-stream"
    private fun friendlyError(error: Exception, fallback: String): String = error.message?.takeIf { it.any { char -> char.code in 0x4E00..0x9FFF } } ?: fallback

    companion object { private const val MAX_BYTES = 100L * 1024 * 1024 }
}

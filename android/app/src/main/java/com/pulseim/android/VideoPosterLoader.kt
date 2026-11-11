package com.pulseim.android

import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.LruCache
import android.view.View
import android.widget.ImageView
import android.widget.TextView
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

/** Extract PC-uploaded video covers off the UI thread, without downloading a full file. */
internal class VideoPosterLoader(private val resolveUrl: (String) -> String, private val current: () -> Boolean) {
    private data class Poster(val bitmap: Bitmap?, val duration: String)
    private data class Target(val image: WeakReference<ImageView>, val status: WeakReference<TextView>, val duration: WeakReference<TextView>)
    private val handler = Handler(Looper.getMainLooper())
    private val executor = Executors.newFixedThreadPool(2)
    private val cache = object : LruCache<String, Poster>(8 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Poster) = (value.bitmap?.byteCount ?: 0) + 64
    }
    private val pending = mutableMapOf<String, MutableList<Target>>()
    private val failed = linkedMapOf<String, Long>()
    @Volatile private var closed = false
    private fun alive() = !closed && current()

    fun bind(message: JSONObject, image: ImageView, status: TextView, duration: TextView) {
        if (!alive()) return
        val body = message.optJSONObject("body") ?: return
        val url = runCatching { resolveUrl(RichMessageContent.string(body, "url")).also {
            val parsed = URL(it); require(parsed.protocol in listOf("http", "https") && parsed.host.isNotBlank() && parsed.userInfo == null)
        } }.getOrNull()
        if (url == null) { status.text = "点击播放视频"; return }
        val key = message.optInt("id").toString() + ":" + identity(url)
        image.tag = key
        val target = Target(WeakReference(image), WeakReference(status), WeakReference(duration))
        cache.get(key)?.let { apply(key, target, it); return }
        if ((failed[key] ?: 0) > SystemClock.elapsedRealtime()) { status.text = "点击播放视频"; return }
        pending[key]?.let { it.add(target); return }
        if (pending.size >= 16) { status.text = "点击播放视频"; return }
        pending[key] = mutableListOf(target)
        try { executor.execute {
            var retriever: MediaMetadataRetriever? = null
            val poster = try {
                if (!alive()) return@execute
                retriever = MediaMetadataRetriever()
                retriever.setDataSource(url, emptyMap<String, String>())
                val milliseconds = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: body.optLong("duration_ms")
                val bitmap = if (Build.VERSION.SDK_INT >= 27) retriever.getScaledFrameAtTime(0, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, 480, 320)
                    else retriever.getFrameAtTime(0, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)?.let { frame ->
                        val scale = minOf(1f, 480f / frame.width, 320f / frame.height)
                        if (scale < 1) Bitmap.createScaledBitmap(frame, (frame.width * scale).toInt().coerceAtLeast(1), (frame.height * scale).toInt().coerceAtLeast(1), true).also { frame.recycle() } else frame
                    }
                Poster(bitmap, if (milliseconds > 0) RichMessageContent.duration(milliseconds) else "")
            } catch (_: Exception) { Poster(null, "") }
            finally { runCatching { retriever?.release() } }
            handler.post {
                val targets = pending.remove(key) ?: return@post
                if (!alive()) { poster.bitmap?.recycle(); return@post }
                if (poster.bitmap != null) cache.put(key, poster)
                else { failed[key] = SystemClock.elapsedRealtime() + 20000; while (failed.size > 80) failed.remove(failed.keys.first()) }
                targets.filter { it.image.get()?.isAttachedToWindow == true }.forEach { apply(key, it, poster) }
            }
        } } catch (_: RejectedExecutionException) { pending.remove(key); status.text = "点击播放视频" }
    }
    private fun apply(key: String, target: Target, poster: Poster) {
        val image = target.image.get() ?: return
        if (!alive() || image.tag != key) return
        // Cached values may be applied while constructing a row; asynchronous
        // results cannot affect a detached/replaced row.
        image.setImageBitmap(poster.bitmap)
        target.status.get()?.let { it.text = if (poster.bitmap == null) "点击播放视频" else ""; it.visibility = if (poster.bitmap == null) View.VISIBLE else View.GONE }
        if (poster.duration.isNotBlank()) target.duration.get()?.text = poster.duration
    }
    private fun identity(url: String): String {
        val uri = Uri.parse(url)
        if (!uri.queryParameterNames.containsAll(listOf("media_expires", "media_signature"))) return url
        return uri.buildUpon().clearQuery().apply {
            for (name in uri.queryParameterNames) if (name !in listOf("media_expires", "media_signature"))
                for (value in uri.getQueryParameters(name)) appendQueryParameter(name, value)
        }.build().toString()
    }
    fun close() { closed = true; executor.shutdownNow(); handler.removeCallbacksAndMessages(null); pending.clear(); failed.clear(); cache.evictAll() }
}

package com.pulseim.android

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.os.SystemClock
import android.util.LruCache
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/** Chat bubbles and the viewer share compressed originals, not a second download.
 * Scope includes the captured endpoint and session. Cache hits never grant message access.
 */
internal object ChatImageCache {
    internal class AuthorizationExpired : IOException("图片链接已过期")
    internal fun authorizationExpired(error: Throwable): Boolean =
        generateSequence(error) { it.cause }.take(8).any { it is AuthorizationExpired }
    private const val MAX_BYTES = 32L * 1024 * 1024
    private const val DISK_BYTES = 160L * 1024 * 1024
    private const val MAX_AGE = 7L * 24 * 60 * 60 * 1000
    private val lock = Any()
    private val io = Executors.newFixedThreadPool(3)
    private class Transfer {
        lateinit var task: FutureTask<File>
        var consumers = 0
        @Volatile var connection: HttpURLConnection? = null
    }
    private val flights = ConcurrentHashMap<String, Transfer>()
    private var generation = 0
    private val memory = object : LruCache<String, Bitmap>((Runtime.getRuntime().maxMemory() / 8).coerceIn(8L * 1024 * 1024, 48L * 1024 * 1024).toInt()) {
        override fun sizeOf(key: String, value: Bitmap) = value.allocationByteCount
    }
    private fun folder(context: Context) = File(context.applicationContext.cacheDir, "chat-images-v1")
    private fun variant(pixel: Int) = if (pixel <= 1024) 1024 else 2560

    internal fun key(scope: String, raw: String): String {
        val uri = Uri.parse(raw)
        require(uri.scheme in listOf("http", "https") && !uri.host.isNullOrBlank() && uri.userInfo == null) { "图片地址无效" }
        val grants = setOf("media_expires", "media_signature", "media_session", "media_kind")
        val complete = grants.all { !uri.getQueryParameter(it).isNullOrEmpty() }
        val canonical = uri.buildUpon().fragment(null).clearQuery().apply {
            uri.queryParameterNames.sorted().forEach { name ->
                if (!complete || name !in setOf("media_expires", "media_signature")) {
                    uri.getQueryParameters(name).sorted().forEach { appendQueryParameter(name, it) }
                }
            }
        }.build().toString()
        return MessageDigest.getInstance("SHA-256").digest((scope + "\u0000" + canonical).toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
    }

    fun cached(scope: String, url: String): Bitmap? = synchronized(lock) {
        val key = key(scope, url)
        memory.get("$key:2560") ?: memory.get("$key:1024")
    }

    /** Keep the exact bytes just uploaded. Call off the UI thread, after upload
     * acknowledgement and before sending its message; refreshed signatures use
     * the same scoped key, so the sender need not download its own photo again. */
    fun seedUploaded(context: Context, scope: String, url: String, source: File, current: () -> Boolean) {
        val cacheKey = key(scope, url)
        val epoch = synchronized(lock) {
            if (!current()) throw IOException("已取消")
            generation
        }
        if (!source.isFile || source.length() !in 1..MAX_BYTES) throw IOException("图片缓存来源无效")
        val directory = folder(context)
        synchronized(lock) {
            checkEpoch(epoch)
            if (!directory.isDirectory && !directory.mkdirs()) throw IOException("无法创建图片缓存")
        }
        val partial = File(directory, "${UUID.randomUUID()}.part")
        var bitmap: Bitmap? = null
        var retained = false
        try {
            var copied = 0L
            source.inputStream().use { input -> partial.outputStream().use { output ->
                val buffer = ByteArray(32 * 1024)
                while (true) {
                    if (!current() || Thread.currentThread().isInterrupted) throw IOException("已取消")
                    val count = input.read(buffer); if (count < 0) break
                    copied += count; if (copied > MAX_BYTES) throw IOException("图片超过缓存大小限制")
                    output.write(buffer, 0, count)
                }
            } }
            if (copied == 0L || copied != source.length()) throw IOException("图片缓存不完整")
            val decoded = safeDecode(context, partial, 2560); bitmap = decoded
            synchronized(lock) {
                checkEpoch(epoch)
                if (!current()) throw IOException("已取消")
                val target = File(directory, "$cacheKey.image")
                if (!partial.renameTo(target)) throw IOException("图片缓存保存失败")
                memory.put("$cacheKey:2560", decoded); retained = true
                prune(directory, target)
            }
        } finally {
            partial.delete()
            if (!retained) bitmap?.recycle()
        }
    }

    /** Must run off the UI thread. One consumer cancelling does not cancel another's download. */
    fun load(context: Context, scope: String, url: String, maxPixel: Int, current: () -> Boolean): Bitmap {
        val key = key(scope, url); val pixel = variant(maxPixel)
        val epoch = synchronized(lock) {
            if (!current()) throw IOException("已取消")
            (memory.get("$key:$pixel") ?: memory.get("$key:2560"))?.let { return it }
            generation
        }
        val flightKey = "$epoch:$key"
        val flight = synchronized(lock) {
            flights[flightKey]?.also { it.consumers++ } ?: Transfer().also { transfer ->
                transfer.consumers = 1
                transfer.task = FutureTask { original(context, key, url, epoch, transfer) }
                flights[flightKey] = transfer
                io.execute { try { transfer.task.run() } finally { flights.remove(flightKey, transfer) } }
            }
        }
        fun awaitFile(): File {
            while (true) {
                if (!current() || Thread.currentThread().isInterrupted || synchronized(lock) { generation != epoch }) throw IOException("已取消")
                try { return flight.task.get(100, TimeUnit.MILLISECONDS) } catch (_: TimeoutException) { /* Check this consumer's lifetime. */ }
            }
        }
        try {
          val file = awaitFile()
        // Decoding must not hold the lock used by synchronous UI cache reads.
        val bitmap = try { safeDecode(context, file, pixel) } catch (error: Exception) { synchronized(lock) { file.delete() }; throw error }
          return synchronized(lock) {
            if (!current() || generation != epoch) throw IOException("已取消")
            (memory.get("$key:$pixel") ?: memory.get("$key:2560"))?.let { return@synchronized it }
            memory.put("$key:$pixel", bitmap)
            bitmap
          }
        } finally {
            val disconnect = synchronized(lock) {
                flight.consumers--
                if (flight.consumers == 0 && !flight.task.isDone) {
                    flights.remove(flightKey, flight); flight.task.cancel(true); flight.connection
                } else null
            }
            disconnect?.disconnect()
        }
    }

    private fun original(context: Context, key: String, url: String, epoch: Int, transfer: Transfer): File {
        val directory = folder(context); val target = File(directory, "$key.image")
        synchronized(lock) {
            checkEpoch(epoch)
            if (target.isFile && target.length() in 1..MAX_BYTES && System.currentTimeMillis() - target.lastModified() in 0..MAX_AGE) {
                target.setLastModified(System.currentTimeMillis()); return target
            }
            target.delete()
            if (!directory.isDirectory && !directory.mkdirs()) throw IOException("无法创建图片缓存")
        }
        val partial = File(directory, "${UUID.randomUUID()}.part")
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 10000; readTimeout = 15000; instanceFollowRedirects = false
            useCaches = false; setRequestProperty("Accept", "image/*")
        }
        try {
            synchronized(lock) {
                checkEpoch(epoch)
                if (transfer.task.isCancelled) throw IOException("已取消")
                transfer.connection = connection
            }
            val started = SystemClock.elapsedRealtime()
            if (connection.responseCode in listOf(401, 403)) throw AuthorizationExpired()
            if (connection.responseCode !in 200..299) throw IOException("图片下载失败")
            if (connection.contentLengthLong > MAX_BYTES) throw IOException("图片超过32MB，请在电脑端查看")
            var total = 0L
            connection.inputStream.use { input -> partial.outputStream().use { output ->
                val buffer = ByteArray(32 * 1024)
                while (true) {
                    if (Thread.currentThread().isInterrupted || synchronized(lock) { generation != epoch }) throw IOException("已取消")
                    if (SystemClock.elapsedRealtime() - started > 60000) throw IOException("图片下载超时")
                    val count = input.read(buffer); if (count < 0) break
                    total += count; if (total > MAX_BYTES) throw IOException("图片超过32MB，请在电脑端查看")
                    output.write(buffer, 0, count)
                }
            } }
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(partial.absolutePath, bounds)
            if (total == 0L || (connection.contentLengthLong >= 0 && total != connection.contentLengthLong)
                || bounds.outWidth <= 0 || bounds.outHeight <= 0) throw IOException("图片格式无效或下载不完整")
            synchronized(lock) {
                checkEpoch(epoch)
                if (!partial.renameTo(target)) throw IOException("图片缓存保存失败")
                prune(directory, target)
            }
            return target
        } finally { transfer.connection = null; partial.delete(); connection.disconnect() }
    }

    fun trimMemory() = synchronized(lock) { memory.evictAll() }
    private fun safeDecode(context: Context, file: File, pixel: Int): Bitmap = try { decode(file, pixel) } catch (error: OutOfMemoryError) {
        trimMemory(); ClientDiagnostics.get(context).fault("ANDROID_MEMORY", error)
        try { decode(file, minOf(pixel, 512)) } catch (again: OutOfMemoryError) { throw IOException("图片内存不足，请稍后重试", again) }
    }
    private fun decode(file: File, pixel: Int): Bitmap {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.absolutePath, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw IOException("图片格式无效")
        val options = BitmapFactory.Options().apply {
            inSampleSize = 1
            while (maxOf(bounds.outWidth, bounds.outHeight) / inSampleSize > pixel) inSampleSize *= 2
        }
        val bitmap = BitmapFactory.decodeFile(file.absolutePath, options) ?: throw IOException("图片无法解码")
        val orientation = runCatching { ExifInterface(file.absolutePath).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) }.getOrDefault(1)
        val matrix = Matrix()
        when (orientation) {
            2 -> matrix.setScale(-1f, 1f); 3 -> matrix.setRotate(180f); 4 -> matrix.setScale(1f, -1f)
            5 -> { matrix.setRotate(90f); matrix.postScale(-1f, 1f) }
            6 -> matrix.setRotate(90f); 7 -> { matrix.setRotate(270f); matrix.postScale(-1f, 1f) }
            8 -> matrix.setRotate(270f)
        }
        if (matrix.isIdentity) return bitmap
        return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true).also { if (it !== bitmap) bitmap.recycle() }
    }

    /** Invalidate first, so an in-flight old download cannot refill the cleared cache. */
    fun clear(context: Context) = synchronized(lock) {
        generation++; memory.evictAll(); flights.values.forEach { it.task.cancel(true); it.connection?.disconnect() }; flights.clear()
        folder(context).deleteRecursively()
        Unit
    }
    internal fun clearMemory() = synchronized(lock) { memory.evictAll() }
    private fun checkEpoch(epoch: Int) { if (generation != epoch) throw IOException("已取消") }
    private fun prune(directory: File, keep: File) {
        var bytes = 0L
        directory.listFiles()?.filter { it.extension == "image" }?.sortedByDescending { it.lastModified() }?.forEachIndexed { index, file ->
            bytes += file.length()
            if (file != keep && (index >= 160 || bytes > DISK_BYTES || System.currentTimeMillis() - file.lastModified() > MAX_AGE)) file.delete()
        }
    }
}

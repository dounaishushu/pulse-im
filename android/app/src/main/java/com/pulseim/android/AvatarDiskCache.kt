package com.pulseim.android

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import java.io.File
import java.security.MessageDigest
import java.util.UUID

/** Only small decoded avatar thumbnails persist; filenames contain no URLs or credentials. */
internal object AvatarDiskCache {
    private const val MAX_FILE = 512L * 1024
    private const val MAX_DISK = 64L * 1024 * 1024
    private const val MAX_FILES = 600
    private const val MAX_AGE = 30L * 86400000
    private val lock = Any()
    @Volatile private var generation = 0
    fun key(scope: String, identity: String): String = MessageDigest.getInstance("SHA-256")
        .digest((scope + "\u0000" + identity).toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    private fun directory(context: Context): File {
        val parent = context.applicationContext.cacheDir.canonicalFile
        val value = File(parent, "avatar-thumbnails-v1")
        require(value.canonicalFile == value.absoluteFile && value.canonicalFile.parentFile == parent) { "Invalid avatar cache" }
        return value
    }
    fun read(context: Context, key: String): Bitmap? = synchronized(lock) {
        if (!Regex("[a-f0-9]{64}").matches(key)) return@synchronized null
        val folder = directory(context); val file = File(folder, "$key.png")
        try {
            if (file.canonicalFile.parentFile != folder.canonicalFile || !file.isFile || file.length() !in 1..MAX_FILE ||
                System.currentTimeMillis() - file.lastModified() !in 0..MAX_AGE) { file.delete(); return@synchronized null }
            val bytes = file.readBytes()
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            if (bounds.outWidth !in 1..256 || bounds.outHeight !in 1..256) { file.delete(); return@synchronized null }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.also { file.setLastModified(System.currentTimeMillis()) }
                ?: run { file.delete(); null }
        } catch (_: Exception) { file.delete(); null }
    }
    fun epoch(): Int = generation
    fun write(context: Context, key: String, source: Bitmap, expected: Int, current: () -> Boolean) {
        if (!Regex("[a-f0-9]{64}").matches(key) || !current()) return
        val scale = minOf(1f, 256f / maxOf(source.width, source.height))
        val small = if (scale < 1) Bitmap.createScaledBitmap(source, maxOf(1, (source.width * scale).toInt()), maxOf(1, (source.height * scale).toInt()), true) else source
        try {
            val output = java.io.ByteArrayOutputStream()
            if (!small.compress(Bitmap.CompressFormat.PNG, 100, output) || output.size().toLong() !in 1..MAX_FILE) return
            synchronized(lock) {
                if (expected != generation || !current()) return
                val folder = directory(context); if (!folder.isDirectory && !folder.mkdirs()) return
                val partial = File(folder, "${UUID.randomUUID()}.part")
                try {
                    partial.outputStream().use { it.write(output.toByteArray()) }
                    if (expected != generation || !current()) return
                    val target = File(folder, "$key.png")
                    if (!partial.renameTo(target)) return
                    prune(folder)
                } finally { partial.delete() }
            }
        } catch (_: Exception) { /* Cache failures keep the network/avatar fallback usable. */ }
        finally { if (small !== source) small.recycle() }
    }
    private fun prune(folder: File) {
        val files = folder.listFiles()?.filter { it.isFile && Regex("[a-f0-9]{64}\\.png").matches(it.name) }
            ?.sortedByDescending { it.lastModified() } ?: return
        var bytes = 0L
        files.forEachIndexed { index, file ->
            bytes += file.length()
            if (index >= MAX_FILES || bytes > MAX_DISK || System.currentTimeMillis() - file.lastModified() !in 0..MAX_AGE) file.delete()
        }
    }
    fun clear(context: Context) = synchronized(lock) {
        generation++
        val folder = directory(context)
        folder.listFiles()?.forEach { if (Regex("(?:[a-f0-9]{64}\\.png|[a-f0-9-]{36}\\.part)").matches(it.name)) it.delete() }
    }
}

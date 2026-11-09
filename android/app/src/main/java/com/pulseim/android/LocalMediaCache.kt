package com.pulseim.android

import android.content.Context
import android.net.Uri
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicInteger

/** Downloaded attachments survive closing a preview and restarting the app. */
internal object LocalMediaCache {
    private val epoch = AtomicInteger()
    private val locks = Array(32) { Any() }
    private val maintenance = Any()
    private const val LIMIT = 1024L * 1024 * 1024
    private fun hash(raw: String) = MessageDigest.getInstance("SHA-256").digest(raw.toByteArray()).joinToString("") { "%02x".format(it) }
    private fun digest(file: File): String = file.inputStream().use { input ->
        val md = MessageDigest.getInstance("SHA-256"); val buffer = ByteArray(65536)
        while (true) { val n = input.read(buffer); if (n < 0) break; md.update(buffer, 0, n) }
        md.digest().joinToString("") { "%02x".format(it) }
    }
    internal fun identity(raw: String): String {
        val uri = Uri.parse(raw); require(uri.scheme in listOf("http", "https") && !uri.host.isNullOrBlank() && uri.userInfo == null)
        return uri.buildUpon().clearQuery().fragment(null).apply {
            uri.queryParameterNames.sorted().filter { it !in listOf("media_expires", "media_signature") }.forEach { key -> uri.getQueryParameters(key).forEach { appendQueryParameter(key, it) } }
        }.build().toString()
    }
    private fun root(context: Context) = File(context.applicationContext.cacheDir, "local-media-v1").apply { if (!isDirectory && !mkdirs()) throw IOException("无法创建附件缓存") }
    fun get(context: Context, scope: String, cid: Int, raw: String, name: String, current: () -> Boolean, loader: (() -> Boolean) -> File): File {
        val generation = epoch.get(); val owner = hash("$scope|$cid"); val key = hash("$owner|${identity(raw)}")
        val extension = name.substringAfterLast('.', "bin").lowercase().takeIf { it.matches(Regex("[a-z0-9]{1,8}")) } ?: "bin"
        synchronized(locks[(key.hashCode() and Int.MAX_VALUE) % locks.size]) {
            fun alive() = current() && epoch.get() == generation
            if (!alive()) throw IOException("已取消")
            val dir = root(context); val file = File(dir, "$key.$extension"); val meta = File(dir, "$key.json")
            try {
                val saved = JSONObject(meta.readText())
                if (file.length() > 0 && file.length() == saved.getLong("size") && digest(file) == saved.getString("sha256") && alive()) {
                    meta.setLastModified(System.currentTimeMillis()); return file
                }
            } catch (_: Exception) { }
            val temporary = loader(::alive)
            try {
                if (!alive()) throw IOException("已取消")
                val checksum = digest(temporary)
                synchronized(maintenance) {
                    if (!alive()) throw IOException("已取消")
                    file.delete(); if (!temporary.renameTo(file)) { temporary.copyTo(file, overwrite = true); temporary.delete() }
                    meta.writeText(JSONObject().put("size", file.length()).put("sha256", checksum).put("owner", owner).put("extension", extension).toString())
                    prune(dir, key)
                }
                return file
            } finally { temporary.delete() }
        }
    }
    private fun prune(dir: File, retained: String) {
        val rows = dir.listFiles()?.filter { it.name.matches(Regex("[a-f0-9]{64}\\.json")) }?.sortedBy { it.lastModified() }.orEmpty()
        var size = dir.listFiles()?.sumOf { it.length() } ?: 0L; var count = rows.size
        for (meta in rows) {
            if (size <= LIMIT && count <= 500) break
            val key = meta.nameWithoutExtension; if (key == retained) continue
            dir.listFiles()?.filter { it.name.startsWith("$key.") }?.forEach { size -= it.length(); it.delete() }; count--
        }
    }
    fun purge(context: Context, scope: String, cid: Int) = synchronized(maintenance) {
        epoch.incrementAndGet(); val owner = hash("$scope|$cid"); val dir = root(context)
        dir.listFiles()?.filter { it.extension == "json" }?.forEach { meta ->
            if (runCatching { JSONObject(meta.readText()).optString("owner") == owner }.getOrDefault(false)) dir.listFiles()?.filter { it.name.startsWith(meta.nameWithoutExtension + ".") }?.forEach { it.delete() }
        }
    }
    fun clear(context: Context) = synchronized(maintenance) { epoch.incrementAndGet(); root(context).listFiles()?.forEach { if (it.isFile) it.delete() } }
}

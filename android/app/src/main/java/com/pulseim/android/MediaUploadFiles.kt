package com.pulseim.android

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import java.io.Closeable
import java.io.File
import java.io.InputStream
import java.util.Locale

/** Picker names and MIME hints are optional; use decoded image content for image uploads. */
internal object MediaUploadFiles {
    data class Prepared(val file: File, val mime: String, val displayName: String) : Closeable {
        override fun close() { file.delete() }
    }

    private const val MIB = 1024L * 1024L
    private val imageExtensions = mapOf("image/jpeg" to "jpg", "image/png" to "png", "image/gif" to "gif", "image/webp" to "webp")

    fun prepare(context: Context, uri: Uri, kind: String, avatar: Boolean = false): Prepared {
        require(kind in listOf("image", "video", "file")) { "不支持此上传类型" }
        val name = displayName(context, uri)
        val hint = context.contentResolver.getType(uri)?.substringBefore(';')?.lowercase(Locale.ROOT).orEmpty()
        val limit = (if (kind == "video") 100L else if (kind == "image") 10L else 50L) * MIB
        // A camera original can exceed the upload limit; conversion reads at most 50 MB.
        val source = File.createTempFile("media-source-", ".tmp", context.cacheDir)
        try {
            val input = context.contentResolver.openInputStream(uri) ?: throw IllegalArgumentException("无法读取所选文件，请重新选择")
            input.use { copyBounded(it, source, if (kind == "image") 50L * MIB else limit) }
            require(source.length() > 0) { "所选文件为空，请重新选择" }
            if (kind == "image") return prepareImage(context, source, name, avatar)
            val extension = name.substringAfterLast('.', "").lowercase(Locale.ROOT).takeIf { it.matches(Regex("[a-z0-9]{1,8}")) }
                ?: MimeTypeMap.getSingleton().getExtensionFromMimeType(hint)
                ?: throw IllegalArgumentException("无法识别文件格式，请选择带有扩展名的文件")
            val mime = hint.ifBlank { MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension) ?: "application/octet-stream" }
            return movePrepared(context, source, extension, mime, name)
        } finally { source.delete() }
    }

    private fun prepareImage(context: Context, source: File, name: String, avatar: Boolean): Prepared {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(source.absolutePath, bounds)
        require(bounds.outWidth > 0 && bounds.outHeight > 0) { "图片无法读取，请重新选择或导出为 JPG/PNG" }
        val actual = bounds.outMimeType?.lowercase(Locale.ROOT).orEmpty()
        val extension = imageExtensions[actual]
        val animated = actual == "image/gif" || actual == "image/webp"
        val maxEdge = if (avatar) 1536 else 1600
        val budget = 512L * 1024
        if (animated) {
            require(source.length() <= 10L * MIB) { "图片超过10MB，请选择较小的图片" }
            return movePrepared(context, source, extension!!, actual, imageName(name, extension))
        }
        if (extension != null && source.length() <= budget && bounds.outWidth <= maxEdge && bounds.outHeight <= maxEdge) {
            return movePrepared(context, source, extension, actual, imageName(name, extension))
        }
        val options = BitmapFactory.Options().apply {
            inPreferredConfig = Bitmap.Config.ARGB_8888
            inSampleSize = 1
            while (bounds.outWidth / inSampleSize > maxEdge || bounds.outHeight / inSampleSize > maxEdge) inSampleSize *= 2
        }
        var bitmap = BitmapFactory.decodeFile(source.absolutePath, options)
            ?: throw IllegalArgumentException("此图片格式暂无法读取，请导出为 JPG/PNG 后重试")
        // Screenshots usually have no transparency. Encoding them repeatedly as
        // lossless PNG was expensive and left multi-photo uploads unnecessarily large.
        val keepPng = avatar && actual == "image/png"
        val transparent = !avatar && bitmap.hasAlpha() && hasTransparency(bitmap)
        val format = if (keepPng) Bitmap.CompressFormat.PNG else if (transparent) Bitmap.CompressFormat.WEBP else Bitmap.CompressFormat.JPEG
        val outputExtension = if (keepPng) "png" else if (transparent) "webp" else "jpg"
        val output = File.createTempFile("media-image-", ".$outputExtension", context.cacheDir)
        try {
            val orientation = runCatching { ExifInterface(source.absolutePath).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) }.getOrDefault(ExifInterface.ORIENTATION_NORMAL)
            val matrix = Matrix().apply {
                when (orientation) {
                    ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> setScale(-1f, 1f)
                    ExifInterface.ORIENTATION_ROTATE_180 -> setRotate(180f)
                    ExifInterface.ORIENTATION_FLIP_VERTICAL -> setScale(1f, -1f)
                    ExifInterface.ORIENTATION_TRANSPOSE -> { setRotate(90f); postScale(-1f, 1f) }
                    ExifInterface.ORIENTATION_ROTATE_90 -> setRotate(90f)
                    ExifInterface.ORIENTATION_TRANSVERSE -> { setRotate(-90f); postScale(-1f, 1f) }
                    ExifInterface.ORIENTATION_ROTATE_270 -> setRotate(-90f)
                }
            }
            if (!matrix.isIdentity) {
                val rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
                if (rotated !== bitmap) { bitmap.recycle(); bitmap = rotated }
            }
            var quality = if (avatar) 88 else 82
            while (true) {
                output.outputStream().use { require(bitmap.compress(format, quality, it)) { "图片处理失败，请重新选择" } }
                if (output.length() <= budget) break
                if (!keepPng && quality > 72) { quality -= 8; continue }
                require(bitmap.width > 256 || bitmap.height > 256) { "图片处理后仍过大，请选择较小的图片" }
                val scaled = Bitmap.createScaledBitmap(bitmap, (bitmap.width * .8f).toInt().coerceAtLeast(1), (bitmap.height * .8f).toInt().coerceAtLeast(1), true)
                if (scaled !== bitmap) { bitmap.recycle(); bitmap = scaled }
                quality = if (avatar) 88 else 82
            }
            require(output.length() > 0) { "图片处理失败，请重新选择" }
            return Prepared(output, if (keepPng) "image/png" else if (transparent) "image/webp" else "image/jpeg", imageName(name, outputExtension))
        } catch (error: Throwable) { output.delete(); throw error }
        finally { bitmap.recycle() }
    }

    private fun hasTransparency(bitmap: Bitmap): Boolean {
        val row = IntArray(bitmap.width)
        for (y in 0 until bitmap.height) {
            bitmap.getPixels(row, 0, row.size, 0, y, row.size, 1)
            if (row.any { (it ushr 24) != 255 }) return true
        }
        return false
    }
    private fun movePrepared(context: Context, source: File, extension: String, mime: String, name: String): Prepared {
        val output = File.createTempFile("media-upload-", ".$extension", context.cacheDir)
        try {
            source.copyTo(output, overwrite = true)
            return Prepared(output, mime, name)
        } catch (error: Throwable) { output.delete(); throw error }
    }

    private fun copyBounded(input: InputStream, file: File, limit: Long) {
        file.outputStream().use { output ->
            val buffer = ByteArray(16 * 1024); var total = 0L
            while (true) {
                val count = input.read(buffer); if (count < 0) break
                total += count
                require(total <= limit) { "所选文件超过大小限制，请选择较小的文件" }
                output.write(buffer, 0, count)
            }
        }
    }

    private fun displayName(context: Context, uri: Uri): String {
        val name = runCatching {
            context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (index >= 0 && cursor.moveToFirst()) cursor.getString(index) else null
            }
        }.getOrNull().orEmpty()
        return name.replace('/', '_').replace('\\', '_').filter { !it.isISOControl() }.take(160).ifBlank { "附件" }
    }

    private fun imageName(name: String, extension: String): String = name.substringBeforeLast('.', name).take(150).ifBlank { "图片" } + ".$extension"
}

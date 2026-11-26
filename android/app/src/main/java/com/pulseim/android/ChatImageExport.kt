package com.pulseim.android

import android.content.ContentValues
import android.content.Context
import android.graphics.BitmapFactory
import android.media.MediaScannerConnection
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.File
import java.io.IOException
import java.io.OutputStream
import java.util.UUID

/** Copy the original image bytes, preserving animation and avoiding preview re-encoding. */
internal object ChatImageExport {
    fun save(context: Context, file: File, current: () -> Boolean) {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.absolutePath, bounds)
        val extension = when (bounds.outMimeType) {
            "image/jpeg" -> "jpg"; "image/png" -> "png"; "image/gif" -> "gif"; "image/webp" -> "webp"
            else -> throw IOException("图片格式暂不支持保存")
        }
        if (!current() || bounds.outWidth <= 0 || bounds.outHeight <= 0) throw IOException("图片不可用")
        val folder = context.getString(R.string.app_name).replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]"), "_").take(64).ifBlank { "小猿口算" }
        val name = "$folder-${System.currentTimeMillis()}-${UUID.randomUUID().toString().take(8)}.$extension"
        file.inputStream().use { source ->
          val destination = if (Build.VERSION.SDK_INT >= 29) {
            val resolver = context.contentResolver
            val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, ContentValues().apply {
                put(MediaStore.Images.Media.DISPLAY_NAME, name); put(MediaStore.Images.Media.MIME_TYPE, bounds.outMimeType)
                put(MediaStore.Images.Media.RELATIVE_PATH, "${Environment.DIRECTORY_PICTURES}/$folder")
                put(MediaStore.Images.Media.IS_PENDING, 1)
            }) ?: throw IOException("无法创建相册图片")
            object : GalleryImageWriter.Destination {
                override fun open(): OutputStream = resolver.openOutputStream(uri) ?: throw IOException("无法写入相册")
                override fun publish() { if (resolver.update(uri, ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING, 0) }, null, null) != 1) throw IOException("无法保存到相册") }
                override fun rollback() { resolver.delete(uri, null, null) }
            }
        } else {
            val directory = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), folder)
            if (!directory.isDirectory && !directory.mkdirs()) throw IOException("无法创建相册目录")
            val target = File(directory, name)
            val partial = File(directory, ".$name.part")
            if (!partial.createNewFile()) throw IOException("无法创建相册图片")
            object : GalleryImageWriter.Destination {
                override fun open(): OutputStream = partial.outputStream()
                override fun publish() {
                    if (!partial.renameTo(target)) throw IOException("无法保存到相册")
                    MediaScannerConnection.scanFile(context, arrayOf(target.absolutePath), arrayOf(bounds.outMimeType), null)
                }
                override fun rollback() { partial.delete(); target.delete() }
            }
          }
          GalleryImageWriter.write(source, destination, 32L * 1024 * 1024, current)
        }
    }
}

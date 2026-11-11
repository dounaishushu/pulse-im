package com.pulseim.android

import android.content.ContentValues
import android.content.Context
import android.graphics.Bitmap
import android.media.MediaScannerConnection
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.File
import java.util.UUID

internal object MyQrExport {
    /** Called on a worker; never leave an incomplete image in the gallery after a failed write. */
    fun save(context: Context, bitmap: Bitmap, userId: Int) {
        val folder = context.getString(R.string.app_name).replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]"), "_").take(64).ifBlank { "小猿口算" }
        val filename = "$folder-QR-$userId-${System.currentTimeMillis()}-${UUID.randomUUID().toString().take(8)}.png"
        if (Build.VERSION.SDK_INT >= 29) {
            val resolver = context.contentResolver
            val values = ContentValues().apply {
                put(MediaStore.Images.Media.DISPLAY_NAME, filename); put(MediaStore.Images.Media.MIME_TYPE, "image/png")
                put(MediaStore.Images.Media.RELATIVE_PATH, "${Environment.DIRECTORY_PICTURES}/$folder")
                put(MediaStore.Images.Media.IS_PENDING, 1)
            }
            val uri = requireNotNull(resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values))
            try {
                requireNotNull(resolver.openOutputStream(uri)).use { output -> check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)) }
                check(resolver.update(uri, ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING, 0) }, null, null) == 1)
            } catch (e: Exception) { runCatching { resolver.delete(uri, null, null) }; throw e }
        } else {
            val directory = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), folder)
            check(directory.isDirectory || directory.mkdirs())
            val file = File(directory, filename)
            check(file.createNewFile())
            try {
                file.outputStream().use { output -> check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)) }
                MediaScannerConnection.scanFile(context, arrayOf(file.absolutePath), arrayOf("image/png"), null)
            } catch (e: Exception) { file.delete(); throw e }
        }
    }
}

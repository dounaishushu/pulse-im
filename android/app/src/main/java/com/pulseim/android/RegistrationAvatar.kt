package com.pulseim.android

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.util.Base64
import java.io.ByteArrayOutputStream

/** Bounded image decoding and JPEG normalization run off the UI thread. */
internal object RegistrationAvatar {
    fun prepare(context: Context, uri: Uri): ByteArray = MediaUploadFiles.prepare(context, uri, "image", avatar = true).use { file ->
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.file.absolutePath, bounds)
        require(bounds.outWidth > 0 && bounds.outHeight > 0) { "头像无法读取，请重新选择" }
        val options = BitmapFactory.Options().apply { inSampleSize = 1; while (bounds.outWidth / inSampleSize > 768 || bounds.outHeight / inSampleSize > 768) inSampleSize *= 2 }
        var bitmap = BitmapFactory.decodeFile(file.file.absolutePath, options) ?: error("头像无法读取，请重新选择")
        try {
            val orientation = runCatching { ExifInterface(file.file).getAttributeInt(ExifInterface.TAG_ORIENTATION, 1) }.getOrDefault(1)
            val matrix = Matrix().apply { when (orientation) { 2 -> setScale(-1f, 1f); 3 -> setRotate(180f); 4 -> setScale(1f, -1f); 5 -> { setRotate(90f); postScale(-1f, 1f) }; 6 -> setRotate(90f); 7 -> { setRotate(-90f); postScale(-1f, 1f) }; 8 -> setRotate(-90f) } }
            if (!matrix.isIdentity) { val rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true); if (rotated !== bitmap) { bitmap.recycle(); bitmap = rotated } }
            ByteArrayOutputStream().use { output ->
                require(bitmap.compress(Bitmap.CompressFormat.JPEG, 85, output)) { "头像处理失败，请重新选择" }
                output.toByteArray().also { require(it.isNotEmpty() && it.size <= 1024 * 1024) { "头像过大，请选择较小的图片" } }
            }
        } finally { bitmap.recycle() }
    }
    fun dataURL(bytes: ByteArray) = "data:image/jpeg;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
}

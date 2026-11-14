package com.pulseim.android

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.core.content.FileProvider
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.io.File
import java.net.URL
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** Real preparation, encrypted attachment persistence and Go content download. */
internal object PhotoOriginalChecks {
    fun run(context: Context, sender: ApiClient, recipient: ApiClient, conversationId: Int) {
        val directory = File(context.cacheDir, "photo-original-${java.util.UUID.randomUUID()}").apply { check(mkdirs()) }
        try {
            val source = File(directory, "chosen.png")
            val bitmap = Bitmap.createBitmap(1800, 1200, Bitmap.Config.ARGB_8888)
            try { bitmap.eraseColor(android.graphics.Color.BLUE); source.outputStream().use { check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) } }
            finally { bitmap.recycle() }
            val uri = FileProvider.getUriForFile(context, context.packageName + ".fileprovider", source)
            fun hash(file: File) = MessageDigest.getInstance("SHA-256").digest(file.readBytes()).toList()
            MediaUploadFiles.prepare(context, uri, "image", original = true).use { original ->
                check(original.mime == "image/png" && hash(original.file) == hash(source))
                MediaUploadFiles.prepare(context, uri, "image").use { compressed ->
                    check(hash(compressed.file) != hash(source))
                    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    BitmapFactory.decodeFile(compressed.file.absolutePath, bounds)
                    check(bounds.outWidth <= 1600 && bounds.outHeight <= 1600)
                }
                val upload = sender.uploadMedia(original.file, "image", original.mime, original = true)
                check(upload.getBoolean("original"))
                val sent = sender.sendMediaMessage(conversationId, "image", upload, "android-original-check")
                val rows = recipient.history(conversationId)
                val received = (0 until rows.length()).map { rows.getJSONObject(it) }.first { it.getInt("id") == sent.getInt("id") }
                check(received.getJSONObject("body").getBoolean("original"))
                val actual = URL(received.getJSONObject("body").getString("url")).openStream().use { it.readBytes() }
                check(MessageDigest.getInstance("SHA-256").digest(actual).toList() == hash(source))
                verifyOutbox(directory, original.file)
            }
            val oversized = File(directory, "oversized.png")
            java.io.RandomAccessFile(oversized, "rw").use { it.setLength(10L * 1024 * 1024 + 1) }
            val largeURI = FileProvider.getUriForFile(context, context.packageName + ".fileprovider", oversized)
            try { MediaUploadFiles.prepare(context, largeURI, "image", original = true).close(); error("oversized original accepted") }
            catch (_: IllegalArgumentException) {}
            check(PhotoAlbumPickerActivity.MAX_CHAT_PHOTOS == 300)
        } finally { directory.deleteRecursively() }
    }

    private fun verifyOutbox(directory: File, source: File) {
        class Storage : OutboxPersistence {
            var snapshot: ByteArray? = null
            override fun read() = snapshot?.clone()
            override fun write(value: ByteArray) { snapshot = value.clone() }
        }
        val storage = Storage()
        val key = SecretKeySpec(ByteArray(32).apply { java.security.SecureRandom().nextBytes(this) }, "AES")
        val attachments = OutboxAttachments(File(directory, "encrypted"), File(directory, "opened"), object : OutboxAttachments.Ciphers {
            override fun encrypt(id: String) = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key); updateAAD(id.toByteArray()) }
            override fun decrypt(id: String, iv: ByteArray) = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv)); updateAAD(id.toByteArray()) }
        })
        val endpoint = "http://127.0.0.1:18120/api/v2"
        val initial = DurableMediaOutbox(storage, attachments, "fixture", 1, endpoint)
        initial.enqueue("original-retry", 1, "image", "image/png", "chosen.png", source, 0, 0, true)
        val first = initial.claim(1)!!
        initial.fail(first, "injected disconnect"); initial.detach()
        val restored = DurableMediaOutbox(storage, attachments, "fixture-renewed", 1, endpoint)
        val entry = restored.pending(1).single()
        check(entry.original && entry.phase == DurableMediaOutbox.Phase.FAILED && restored.retry(entry))
        val retried = restored.claim(1)!!
        restored.openFile(retried).use { check(it.file.readBytes().contentEquals(source.readBytes())) }
        // Version-one app snapshots predate original selection. Restore without
        // losing the old pending attachment, defaulting only this new field.
        val old = ByteArrayOutputStream()
        DataOutputStream(old).use { out ->
            out.writeInt(1); out.writeInt(1); out.writeUTF(entry.requestId); out.writeUTF(endpoint); out.writeInt(1); out.writeInt(1)
            out.writeUTF(entry.kind); out.writeUTF(entry.mime); OutboxCodec.writeString(out, entry.displayName); out.writeUTF(entry.attachmentId)
            out.writeLong(entry.size); out.writeInt(0); out.writeLong(0); out.writeUTF("FAILED")
            OutboxCodec.writeString(out, "old pending"); OutboxCodec.writeString(out, "")
        }
        restored.detach(); storage.snapshot = old.toByteArray()
        val legacy = DurableMediaOutbox(storage, attachments, "fixture-renewed", 1, endpoint)
        check(!legacy.pending(1).single().original && legacy.pending(1).single().error == "old pending")
        check(legacy.discard(legacy.pending(1).single()))
        for (index in 0 until 300) {
            legacy.enqueue("photo-batch-$index", 1, "image", "image/png", "chosen.png", source, 0, 0, index % 2 == 0)
        }
        legacy.detach()
        val batch = DurableMediaOutbox(storage, attachments, "fixture-renewed", 1, endpoint)
        val entries = batch.pending(1)
        check(entries.size == 300)
        entries.forEach { check(batch.retry(it)) }
        for (index in 0 until 300) {
            val next = batch.claim(1)!!
            check(next.requestId == "photo-batch-$index" && next.original == (index % 2 == 0))
            if (index == 150) {
                check(batch.fail(next, "mid-batch failure"))
                check(batch.claim(1) == null && batch.retry(next) && batch.claim(1) === next)
            }
            check(batch.uploaded(next, "{}") && batch.committing(next))
            check(batch.acknowledge(next.requestId, 1) === next)
        }
        check(batch.pending(1).isEmpty())
    }
}

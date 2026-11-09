package com.pulseim.android

import android.content.Context
import android.util.Base64
import org.json.JSONObject
import java.io.File
import javax.crypto.Cipher

/** Queue mutations only return after encrypted account metadata has committed. */
internal class AndroidOutboxStorage(context: Context, endpoint: String, userId: Int, namespace: String) : OutboxPersistence {
    private val app = context.applicationContext
    private val ticket = LocalAccountStore.ticket(LocalAccountStore.scope(endpoint, userId), namespace)
    private fun current() = LocalAccountStore.current(ticket)
    override fun read(): ByteArray? = LocalAccountStore.read(app, ticket, "queue")?.let {
        check(it.optInt("version") == 1) { "待发队列格式不受支持" }
        Base64.decode(it.getString("data"), Base64.NO_WRAP)
    }
    override fun write(snapshot: ByteArray) {
        check(LocalAccountStore.write(app, ticket, "queue", JSONObject().put("version", 1).put("data", Base64.encodeToString(snapshot, Base64.NO_WRAP)))) { "待发队列账号已切换，请重新打开会话" }
    }
    companion object {
        private data class TextBinding(val token: String, val endpoint: String, val storage: AndroidOutboxStorage, val queue: TextSendQueue)
        private data class MediaBinding(val token: String, val endpoint: String, val storage: AndroidOutboxStorage, val queue: DurableMediaOutbox)
        private val texts = mutableMapOf<String, TextBinding>()
        private val media = mutableMapOf<String, MediaBinding>()
        @JvmStatic @Synchronized fun text(context: Context, token: String, userId: Int, endpoint: String): TextSendQueue {
            val scope = LocalAccountStore.scope(endpoint, userId)
            texts[scope]?.let { existing ->
                if (existing.token == token && existing.endpoint == endpoint && existing.storage.current()) return existing.queue
                existing.queue.clear(); texts.remove(scope)
            }
            val storage = AndroidOutboxStorage(context, endpoint, userId, "text-outbox")
            val queue = TextSendQueue().apply { bindStorage(storage, token, userId, endpoint) }
            texts[scope] = TextBinding(token, endpoint, storage, queue)
            return queue
        }
        @JvmStatic @Synchronized fun media(context: Context, token: String, userId: Int, endpoint: String): DurableMediaOutbox {
            val app = context.applicationContext
            val scope = LocalAccountStore.scope(endpoint, userId)
            media[scope]?.let { existing ->
                if (existing.token == token && existing.endpoint == endpoint && existing.storage.current()) return existing.queue
                existing.queue.detach(); media.remove(scope)
            }
            val namespace = "media-outbox"
            val attachments = OutboxAttachments(File(app.noBackupFilesDir, "outbox-attachments/$scope"), File(app.cacheDir, "outbox-open/$scope"), object : OutboxAttachments.Ciphers {
                override fun encrypt(attachmentId: String): Cipher = LocalAccountStore.encryptCipher(scope, namespace, attachmentId)
                override fun decrypt(attachmentId: String, iv: ByteArray): Cipher = LocalAccountStore.decryptCipher(scope, namespace, attachmentId, iv)
            })
            val storage = AndroidOutboxStorage(app, endpoint, userId, namespace)
            val queue = DurableMediaOutbox(storage, attachments, token, userId, endpoint)
            media[scope] = MediaBinding(token, endpoint, storage, queue)
            return queue
        }
        @JvmStatic @Synchronized fun forgetAccount(endpoint: String, userId: Int) {
            val scope = LocalAccountStore.scope(endpoint, userId)
            texts.remove(scope)?.queue?.clear()
            media.remove(scope)?.queue?.detach()
        }
    }
}

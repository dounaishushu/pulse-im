package com.pulseim.android

import android.content.Context
import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.Future
import javax.crypto.Cipher

/** Queue mutations only return after encrypted account metadata has committed. */
internal class AndroidOutboxStorage(context: Context, endpoint: String, userId: Int, namespace: String) : OutboxRowPersistence {
    private val app = context.applicationContext
    private val ticket = LocalAccountStore.ticket(LocalAccountStore.scope(endpoint, userId), namespace)
    private var clock: () -> Long = System::currentTimeMillis
    private var elapsed: () -> Long = android.os.SystemClock::elapsedRealtime
    private var boot: () -> String = { OutboxRoomStore.bootIdentity(app) }
    private fun current() = LocalAccountStore.current(ticket)
    private var retryState: ByteArray? = null
    private val room = OutboxRoomStore(app, ticket, if (namespace == "text-outbox") 1 else 3, ::readLegacy, ::writeLegacy,
        clock = { clock() }, sample = { OutboxRollout.Time(clock(), elapsed(), boot()) })
    internal constructor(context: Context, endpoint: String, userId: Int, namespace: String, clock: () -> Long) : this(context, endpoint, userId, namespace) {
        this.clock = clock
    }
    internal constructor(context: Context, endpoint: String, userId: Int, namespace: String, clock: () -> Long, elapsed: () -> Long, boot: () -> String) : this(context, endpoint, userId, namespace, clock) {
        this.elapsed = elapsed; this.boot = boot
    }
    override fun readRetryState(): ByteArray? = retryState?.clone()
    override fun read(): ByteArray? {
        retryState = null
        return room.read()?.let { retryState = it.retry(); it.data() }
    }
    private fun readLegacy(): OutboxRecord.Snapshot? {
        return LocalAccountStore.read(app, ticket, "queue")?.let {
            check(it.optInt("version") == 1) { "待发队列格式不受支持" }
            val retry = it.optString("retry_state").takeIf { value -> value.isNotEmpty() }?.let { value -> Base64.decode(value, Base64.NO_WRAP) }
            OutboxRecord.Snapshot(Base64.decode(it.getString("data"), Base64.NO_WRAP), retry)
        }
    }
    override fun write(snapshot: ByteArray) = write(snapshot, null)
    override fun write(snapshot: ByteArray, retryState: ByteArray?) {
        LocalAccountStore.outboxTransaction(app, ticket) { dao ->
            writeLegacy(OutboxRecord.Snapshot(snapshot, retryState))
            // Callers of the original snapshot API explicitly replace the full authority.
            dao.clear(ticket.scope, ticket.namespace)
            // Metadata cannot remain in Room-read mode after a legacy-only write.
            // The following bind will create a new verified shadow.
            dao.deleteMetadata(ticket.scope, ticket.namespace)
        }
        this.retryState = retryState?.clone()
    }
    private fun writeLegacy(snapshot: OutboxRecord.Snapshot) {
        val record = JSONObject().put("version", 1).put("data", Base64.encodeToString(snapshot.data(), Base64.NO_WRAP))
        val retryState = snapshot.retry()
        if (retryState != null) record.put("retry_state", Base64.encodeToString(retryState, Base64.NO_WRAP))
        check(LocalAccountStore.write(app, ticket, "queue", record)) { "待发队列账号已切换，请重新打开会话" }
    }
    override fun writeRows(upserts: List<OutboxRecord>, deletes: List<String>, replaceAll: Boolean, legacySnapshot: java.util.function.Supplier<OutboxRecord.Snapshot>) =
        room.writeRows(upserts, deletes, replaceAll) { legacySnapshot.get() }
    internal fun switchRoomReads(enabled: Boolean) = room.switchReads(enabled)
    internal fun rolloutStatus(): OutboxRollout? = room.status()
    internal fun resumeRoomDualWrites() = room.resumeDualWrites()
    companion object {
        // These lanes survive Activity recreation so a new restore cannot pass an older write.
        val textDisk = Executors.newSingleThreadExecutor { task -> Thread(task, "pulse-text-outbox") }
        val mediaDisk = Executors.newSingleThreadExecutor { task -> Thread(task, "pulse-media-outbox") }
        private data class TextBinding(val token: String, val endpoint: String, val storage: AndroidOutboxStorage, val queue: TextSendQueue)
        private data class MediaBinding(val token: String, val endpoint: String, val storage: AndroidOutboxStorage, val queue: DurableMediaOutbox)
        private val texts = mutableMapOf<String, TextBinding>()
        private val media = mutableMapOf<String, MediaBinding>()
        private var mediaScratchInitialized = false
        /** Operator rollback/cutover without UI changes. Await the result off the main thread. */
        @JvmStatic fun switchRoomReads(context: Context, endpoint: String, userId: Int, namespace: String, enabled: Boolean): Future<Boolean> {
            require(namespace == "text-outbox" || namespace == "media-outbox")
            val app = context.applicationContext
            val scope = LocalAccountStore.scope(endpoint, userId)
            val lane = if (namespace == "text-outbox") textDisk else mediaDisk
            return lane.submit<Boolean> {
                val existing = if (namespace == "text-outbox") synchronized(texts) { texts[scope]?.storage }
                    else synchronized(media) { media[scope]?.storage }
                val storage = existing?.takeIf { it.current() } ?: AndroidOutboxStorage(app, endpoint, userId, namespace)
                storage.switchRoomReads(enabled)
                true
            }
        }
        @JvmStatic fun text(context: Context, token: String, userId: Int, endpoint: String): TextSendQueue = synchronized(texts) {
            val scope = LocalAccountStore.scope(endpoint, userId)
            texts[scope]?.let { existing ->
                if (existing.token == token && existing.endpoint == endpoint && existing.storage.current()) return existing.queue
                existing.queue.clear(); texts.remove(scope)
            }
            val storage = AndroidOutboxStorage(context, endpoint, userId, "text-outbox")
            val queue = TextSendQueue().apply { bindStorage(storage, token, userId, endpoint) }
            texts[scope] = TextBinding(token, endpoint, storage, queue)
            queue
        }
        @JvmStatic fun media(context: Context, token: String, userId: Int, endpoint: String): DurableMediaOutbox = synchronized(media) {
            val app = context.applicationContext
            val scope = LocalAccountStore.scope(endpoint, userId)
            media[scope]?.let { existing ->
                if (existing.token == token && existing.endpoint == endpoint && existing.storage.current()) return existing.queue
                existing.queue.detach(); media.remove(scope)
            }
            val namespace = "media-outbox"
            val scratch = File(app.noBackupFilesDir, "outbox-open")
            if (!mediaScratchInitialized) {
                // Run once before this process starts opening attachments, including after an upgrade.
                // Rebinding an account must not delete a file still in use by a canceled upload.
                scratch.deleteRecursively()
                File(app.cacheDir, "outbox-open").deleteRecursively()
                mediaScratchInitialized = true
            }
            val attachments = OutboxAttachments(File(app.noBackupFilesDir, "outbox-attachments/$scope"), File(scratch, scope), object : OutboxAttachments.Ciphers {
                override fun encrypt(attachmentId: String): Cipher = LocalAccountStore.encryptCipher(scope, namespace, attachmentId)
                override fun decrypt(attachmentId: String, iv: ByteArray): Cipher = LocalAccountStore.decryptCipher(scope, namespace, attachmentId, iv)
            })
            val storage = AndroidOutboxStorage(app, endpoint, userId, namespace)
            val queue = DurableMediaOutbox(storage, attachments, token, userId, endpoint)
            media[scope] = MediaBinding(token, endpoint, storage, queue)
            queue
        }
        @JvmStatic fun forgetAccount(endpoint: String, userId: Int) {
            val scope = LocalAccountStore.scope(endpoint, userId)
            synchronized(texts) { texts.remove(scope)?.queue?.clear() }
            synchronized(media) { media.remove(scope)?.queue?.detach() }
        }
    }
}

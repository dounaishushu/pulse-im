package com.pulseim.android

import android.content.Context
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.util.concurrent.Executor
import java.util.concurrent.Executors

/** Only application context crosses the ViewModel lifetime boundary. */
internal class AndroidChatSendPorts(context: Context) : ChatSendPorts {
    private val app = context.applicationContext
    private val handler = Handler(Looper.getMainLooper())
    override val main = Executor { handler.post(it) }
    override val textDisk: Executor = AndroidOutboxStorage.textDisk
    override val mediaDisk: Executor = AndroidOutboxStorage.mediaDisk
    override val textNetwork = Executors.newFixedThreadPool(2)
    override val mediaNetwork = Executors.newFixedThreadPool(2)
    override val scheduler = object : OutboxRetryWakeup.Scheduler {
        override fun post(task: Runnable, delayMs: Long) { handler.postDelayed(task, delayMs) }
        override fun cancel(task: Runnable) { handler.removeCallbacks(task) }
    }
    override fun text(account: ChatAccount) = AndroidOutboxStorage.text(app, account.token, account.userId, account.endpoint)
    override fun media(account: ChatAccount) = AndroidOutboxStorage.media(app, account.token, account.userId, account.endpoint)
    private fun delivery(value: JSONObject) = ChatDelivery(value.optInt("id"), value.optInt("conversation_id"), value.optInt("sender_id"), value.toString())
    override fun sendText(entry: TextSendQueue.Entry, calls: ApiRequestScope) = delivery(ApiClient(entry.endpoint).apply {
        token = entry.token; requestScope = calls
    }.sendText(entry.conversationId, entry.text, entry.requestId, entry.replyToId, entry.mentionUserIds()))
    override fun sendMedia(queue: DurableMediaOutbox, entry: DurableMediaOutbox.Entry, attempt: Long,
        calls: ApiRequestScope, ensureCurrent: () -> Unit): ChatDelivery {
        val client = ApiClient(entry.endpoint).apply { token = entry.token; requestScope = calls }
        val upload = if (entry.uploadJson.isNotBlank()) JSONObject(entry.uploadJson) else queue.openFile(entry).use { opened ->
            ensureCurrent()
            val result = client.uploadMedia(opened.file, entry.kind, entry.mime, original = entry.original).put("name", entry.displayName)
            check(queue.uploaded(entry, result.toString(), attempt)) { "附件发送已停止" }
            if (entry.kind == "image") runCatching {
                ChatImageCache.seedUploaded(app, entry.endpoint + "|" + entry.token, client.uploadedMediaContentURL(result), opened.file) {
                    try { ensureCurrent(); true } catch (_: TextSendPolicy.NotReady) { false }
                }
            }
            result
        }
        ensureCurrent()
        check(queue.committing(entry, attempt)) { "附件发送已停止" }
        return delivery(if (entry.kind == "voice") client.sendVoice(entry.conversationId, upload.getString("url"), entry.durationMs, entry.size, entry.requestId, entry.replyToId)
            else client.sendMediaMessage(entry.conversationId, entry.kind, upload, entry.requestId, entry.replyToId))
    }
    override fun fault(code: String, error: Throwable?) { ClientDiagnostics.get(app).fault(code, error) }
    override fun close() { textNetwork.shutdownNow(); mediaNetwork.shutdownNow() }
}

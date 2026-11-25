package com.pulseim.android

import android.app.Instrumentation
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Three separate instrumentation processes, with adb force-stop between phases. No production API. */
class ChatSendRestartProbe : Instrumentation() {
    private var phase = ""
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); phase = arguments?.getString("phase").orEmpty(); start() }
    override fun onStart() {
        val checks = mutableListOf<String>()
        val app = targetContext.applicationContext
        check(app.packageName.startsWith("com.pulseim.android.chatp1.p2"))
        val account = ChatAccount("http://127.0.0.1:9/p2-restart-fixture", 1, "p2-fixture-token")
        val manifest = File(app.filesDir, "p2-restart-fixture.json")
        val ledgerFile = File(app.filesDir, "p2-restart-server.json")
        val handler = Handler(Looper.getMainLooper())
        val textWorkers = Executors.newFixedThreadPool(2)
        val mediaWorkers = Executors.newSingleThreadExecutor()
        val store = ViewModelStore()
        var model: ChatViewModel? = null
        try {
            fun text() = AndroidOutboxStorage.text(app, account.token, 1, account.endpoint)
            fun media() = AndroidOutboxStorage.media(app, account.token, 1, account.endpoint)
            fun readLedger() = if (ledgerFile.exists()) JSONObject(ledgerFile.readText()) else JSONObject()
            val ledgerLock = Any()
            fun deliver(requestId: String, kind: String): ChatDelivery = synchronized(ledgerLock) {
                val ledger = readLedger()
                val previous = ledger.optJSONObject(requestId)
                val record = previous ?: JSONObject().put("id", ledger.length() + 1).put("calls", 0)
                record.put("calls", record.getInt("calls") + 1); ledger.put(requestId, record)
                ledgerFile.writeText(ledger.toString())
                val row = JSONObject().put("id", record.getInt("id")).put("conversation_id", 10).put("sender_id", 1)
                    .put("type", kind).put("body", JSONObject().put("request_id", requestId))
                ChatDelivery(record.getInt("id"), 10, 1, row.toString())
            }
            if (phase == "seed") {
                check(!manifest.exists()) { "Seed fixture already exists; use a fresh isolated package" }
                val queue = text(); val attachments = media()
                val ids = (1..10).map { queue.enqueue(account.token, 1, account.endpoint, 10, "P2 fixture $it", 0).requestId }
                val mediaIds = listOf("p2-restart-media-a", "p2-restart-media-b")
                val source = File(app.cacheDir, "p2-restart-source.bin").apply { writeBytes(byteArrayOf(4, 5, 6)) }
                mediaIds.forEach { attachments.enqueue(it, 10, "file", "application/octet-stream", "fixture.bin", source, 0, 0) }
                source.delete()
                val first = queue.claim(account.token, 1, account.endpoint, 1).single()
                deliver(first.requestId, "text") // Accepted remotely, local record is still SENDING.
                val uploading = requireNotNull(attachments.claim(10))
                attachments.uploaded(uploading, JSONObject().put("url", "fixture://uploaded").toString(), uploading.attempt)
                attachments.committing(uploading, uploading.attempt); deliver(uploading.requestId, "file")
                manifest.writeText(JSONObject().put("text", JSONArray(ids)).put("media", JSONArray(mediaIds)).put("seed_pid", android.os.Process.myPid()).toString())
                checks.add("encrypted queue committed: ten text actions and two encrypted attachments")
                checks.add("one SENDING text and one COMMITTING media have an uncertain server acceptance")
            } else {
                check(phase in listOf("resume", "verify")); val fixture = JSONObject(manifest.readText())
                check(fixture.getInt("seed_pid") != android.os.Process.myPid()) { "A new process is required" }
                val restored = CountDownLatch(2)
                val completed = CountDownLatch(12)
                val faults = mutableListOf<String>()
                val ports = object : ChatSendPorts {
                    override val main = Executor { handler.post(it) }
                    override val textDisk: Executor = AndroidOutboxStorage.textDisk
                    override val mediaDisk: Executor = AndroidOutboxStorage.mediaDisk
                    override val textNetwork: Executor = textWorkers
                    override val mediaNetwork: Executor = mediaWorkers
                    override val scheduler = object : OutboxRetryWakeup.Scheduler {
                        override fun post(task: Runnable, delayMs: Long) { handler.postDelayed(task, delayMs) }
                        override fun cancel(task: Runnable) { handler.removeCallbacks(task) }
                    }
                    override fun text(account: ChatAccount) = text().also { restored.countDown() }
                    override fun media(account: ChatAccount) = media().also { restored.countDown() }
                    override fun sendText(entry: TextSendQueue.Entry, calls: ApiRequestScope) = deliver(entry.requestId, "text").also { completed.countDown() }
                    override fun sendMedia(queue: DurableMediaOutbox, entry: DurableMediaOutbox.Entry, attempt: Long,
                        calls: ApiRequestScope, ensureCurrent: () -> Unit): ChatDelivery {
                        ensureCurrent()
                        if (entry.uploadJson.isBlank()) queue.openFile(entry).use {
                            check(it.file.readBytes().contentEquals(byteArrayOf(4, 5, 6)))
                            check(queue.uploaded(entry, JSONObject().put("url", "fixture://uploaded").toString(), attempt))
                        }
                        ensureCurrent(); check(queue.committing(entry, attempt))
                        return deliver(entry.requestId, "file").also { completed.countDown() }
                    }
                    override fun fault(code: String, error: Throwable?) { synchronized(faults) { faults.add(code + ":" + error?.javaClass?.simpleName) } }
                    override fun close() { textWorkers.shutdownNow(); mediaWorkers.shutdownNow() }
                }
                lateinit var sender: ChatSendController
                runOnMainSync {
                    model = ViewModelProvider(store, ChatViewModel.Factory)[ChatViewModel::class.java]
                    model!!.open(account, 10); model!!.permission(model!!.ticket(), false, "loading")
                    sender = model!!.sender { ports }; sender.update(ChatSendGate(account, 10, false, false))
                }
                check(restored.await(20, TimeUnit.SECONDS)) { "Encrypted restore timed out" }; waitForIdleSync()
                if (phase == "resume") {
                    check(sender.textQueue!!.pending(account.token, 1, account.endpoint, 10).map { it.requestId } == (0 until 10).map { fixture.getJSONArray("text").getString(it) })
                    check(sender.mediaQueue!!.pending(10).map { it.requestId } == (0 until 2).map { fixture.getJSONArray("media").getString(it) })
                    check(sender.rows(10).none { it.phase == "FAILED" })
                    checks.add("a real process restart restored all twelve original request IDs through Android Keystore and SQLite")
                    checks.add("permission not ready leaves every restored action pending without FAILED")
                    runOnMainSync { model!!.permission(model!!.ticket(), true, ""); sender.update(ChatSendGate(account, 10, true, true)) }
                    check(completed.await(30, TimeUnit.SECONDS)) { "Ten texts/two attachments did not finish" }
                    // Each completion counts before its durable acknowledge; barrier both existing disk lanes and UI.
                    val barrier = CountDownLatch(1)
                    fun checkEmpty() {
                        if (sender.rows(10).isEmpty()) barrier.countDown()
                        else handler.postDelayed({ checkEmpty() }, 10)
                    }
                    handler.post { checkEmpty() }
                    check(barrier.await(20, TimeUnit.SECONDS)) { "Acknowledgements did not commit" }
                    val ledger = readLedger(); check(ledger.length() == 12)
                    check(ledger.getJSONObject(fixture.getJSONArray("text").getString(0)).getInt("calls") == 2)
                    check(ledger.getJSONObject("p2-restart-media-a").getInt("calls") == 2)
                    checks.add("ten texts and two attachments drain without permanent blocking")
                    checks.add("uncertain requests reuse original IDs; the idempotent test server contains exactly twelve messages")
                } else {
                    check(sender.rows(10).isEmpty()); val before = ledgerFile.readText()
                    runOnMainSync { sender.update(ChatSendGate(account, 10, true, true)); sender.drainText(); sender.drainMedia() }
                    val barrier = CountDownLatch(2)
                    AndroidOutboxStorage.textDisk.execute { handler.post { barrier.countDown() } }
                    AndroidOutboxStorage.mediaDisk.execute { handler.post { barrier.countDown() } }
                    check(barrier.await(20, TimeUnit.SECONDS)); waitForIdleSync()
                    check(before == ledgerFile.readText()); check(sender.rows(10).isEmpty())
                    checks.add("a third fresh process restores an empty queue and issues no duplicate request")
                }
                check(faults.isEmpty()) { faults.joinToString() }
            }
            val result = JSONObject().put("phase", phase).put("pid", android.os.Process.myPid()).put("checks", JSONArray(checks)).put("passed", true)
            File(app.filesDir, "p2-restart-$phase.json").writeText(result.toString(2))
            finish(-1, Bundle().apply { putString("report", result.toString()) })
        } catch (error: Throwable) {
            finish(1, Bundle().apply { putString("error", error.stackTraceToString()) })
        } finally {
            runOnMainSync { store.clear() }
            textWorkers.shutdownNow(); mediaWorkers.shutdownNow()
        }
    }
}

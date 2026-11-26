package com.pulseim.android

import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException
import java.util.ArrayDeque
import java.util.concurrent.Executor
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

class ChatSendControllerTest {
    @get:Rule val files = TemporaryFolder()
    private val account = ChatAccount("https://example.test/api/v2", 1, "token")
    private class Memory : OutboxPersistence {
        var bytes: ByteArray? = null; var retry: ByteArray? = null
        var fail = false
        override fun read() = bytes?.clone()
        override fun readRetryState() = retry?.clone()
        override fun write(snapshot: ByteArray) { write(snapshot, null) }
        override fun write(snapshot: ByteArray, state: ByteArray?) {
            check(!fail) { "disk full" }; bytes = snapshot.clone(); retry = state?.clone()
        }
    }
    private class Lane : Executor {
        val tasks = ArrayDeque<Runnable>()
        override fun execute(command: Runnable) { tasks.add(command) }
        fun one(): Boolean = tasks.poll()?.let { it.run(); true } ?: false
    }
    private inner class Fixture(val disk: Memory = Memory(), val mediaDiskRecord: Memory = Memory()) : ChatSendPorts {
        val ui = Lane(); val io = Lane(); val textWork = Lane(); val mediaWork = Lane()
        override val main: Executor = ui
        override val textDisk: Executor = io
        override val mediaDisk: Executor = io
        override val textNetwork: Executor = textWork
        override val mediaNetwork: Executor = mediaWork
        var time = System.currentTimeMillis(); var changes = 0
        val timers = linkedMapOf<Runnable, Long>()
        override val scheduler = object : OutboxRetryWakeup.Scheduler {
            override fun post(task: Runnable, delayMs: Long) { timers[task] = time + delayMs }
            override fun cancel(task: Runnable) { timers.remove(task) }
        }
        override fun now() = time
        override fun random() = 0.0
        val sent = mutableListOf<String>(); val server = linkedMapOf<String, ChatDelivery>()
        var failText: ((TextSendQueue.Entry) -> Exception?)? = null
        var failMedia: ((DurableMediaOutbox.Entry) -> Exception?)? = null
        var uploads = 0; val faults = mutableListOf<String>()
        val attachments = OutboxAttachments(files.newFolder(), files.newFolder(), object : OutboxAttachments.Ciphers {
            fun cipher(mode: Int, iv: ByteArray?): Cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
                val key = SecretKeySpec(ByteArray(16), "AES")
                if (iv == null) init(mode, key) else init(mode, key, GCMParameterSpec(128, iv))
            }
            override fun encrypt(id: String) = cipher(Cipher.ENCRYPT_MODE, null)
            override fun decrypt(id: String, iv: ByteArray) = cipher(Cipher.DECRYPT_MODE, iv)
        })
        override fun text(account: ChatAccount) = TextSendQueue().apply { bindStorage(disk, account.token, account.userId, account.endpoint) }
        override fun media(account: ChatAccount) = DurableMediaOutbox(mediaDiskRecord, attachments, account.token, account.userId, account.endpoint)
        val controller = ChatSendController(this) { changes++ }
        override fun sendText(entry: TextSendQueue.Entry, calls: ApiRequestScope): ChatDelivery {
            calls.checkActive(); sent.add(entry.requestId); failText?.invoke(entry)?.let { throw it }
            return server.getOrPut(entry.requestId) { ChatDelivery(server.size + 1, entry.conversationId, entry.userId, "snapshot") }
        }
        override fun sendMedia(queue: DurableMediaOutbox, entry: DurableMediaOutbox.Entry, attempt: Long,
            calls: ApiRequestScope, ensureCurrent: () -> Unit): ChatDelivery {
            ensureCurrent(); calls.checkActive()
            if (entry.uploadJson.isEmpty()) { uploads++; queue.uploaded(entry, "uploaded", attempt) }
            ensureCurrent(); queue.committing(entry, attempt)
            sent.add(entry.requestId); failMedia?.invoke(entry)?.let { throw it }
            return server.getOrPut(entry.requestId) { ChatDelivery(server.size + 1, entry.conversationId, entry.userId, "snapshot") }
        }
        override fun fault(code: String, error: Throwable?) { faults.add(code) }
        override fun close() {}
        fun open(cid: Int = 10, allowed: Boolean = true, ready: Boolean = true) {
            controller.update(ChatSendGate(account, cid, allowed, ready)); flush()
        }
        fun flush(network: Boolean = true) {
            repeat(1000) {
                val advanced = io.one() or ui.one() or (network && textWork.one()) or (network && mediaWork.one())
                if (!advanced) return
            }
            error("Actor did not become idle")
        }
        fun text(cid: Int = 10, value: String = "hello"): TextSendQueue.Entry = controller.textQueue!!.enqueue(account.token, account.userId, account.endpoint, cid, value, 0)
        fun media(id: String = "photo", cid: Int = 10): DurableMediaOutbox.Entry {
            val source = files.newFile(); source.writeBytes(byteArrayOf(1, 2, 3))
            return controller.mediaQueue!!.enqueue(id, cid, "image", "image/png", "image.png", source, 0, 0)
        }
        fun timer() {
            val due = timers.minByOrNull { it.value } ?: error("Missing retry wakeup")
            time = maxOf(time + 60_000, due.value); timers.remove(due.key); due.key.run(); flush()
        }
    }

    @Test fun tenTextsCompleteInOrderWithoutPermanentBlocking() {
        val f = Fixture(); f.open(); val ids = (1..10).map { f.text(value = "message $it").requestId }
        f.controller.drainText(); f.flush()
        assertEquals(ids, f.sent); assertTrue(f.controller.textQueue!!.pending(account.token, 1, account.endpoint, 10).isEmpty())
        assertEquals(10, f.controller.events().count { it.delivery != null })
    }
    @Test fun deniedPermissionDoesNotClaimOrFailAndRecoveryDrainsAllTen() {
        val f = Fixture(); f.open(allowed = false); val entries = (1..10).map { f.text() }
        repeat(10) { f.controller.drainText(); f.flush() }
        assertTrue(f.sent.isEmpty()); assertTrue(entries.all { it.phase == TextSendQueue.Phase.QUEUED && it.attempt == 0L })
        f.open(); f.controller.drainText(); f.flush(); assertEquals(10, f.sent.size)
    }
    @Test fun permissionLostBetweenClaimAndNetworkDefersInsteadOfFailing() {
        val f = Fixture(); f.open(); val entry = f.text(); f.controller.drainText(); f.flush(false)
        f.open(allowed = false); assertEquals(TextSendQueue.Phase.QUEUED, entry.phase); assertTrue(f.sent.isEmpty())
        f.open(); f.controller.drainText(); f.flush(); assertEquals(1, f.sent.size)
    }
    @Test fun permanentFailureDoesNotBlockTheNextText() {
        val f = Fixture(); f.open(); val bad = f.text(); val next = f.text()
        f.failText = { if (it === bad) ClientApiException(403, "denied", "denied") else null }
        f.controller.drainText(); f.flush()
        assertEquals(TextSendQueue.Phase.FAILED, bad.phase); assertEquals(listOf(bad.requestId, next.requestId), f.sent)
    }
    @Test fun automaticTextRetriesUseJitterAndStopAfterFiveRetries() {
        val f = Fixture(); f.open(); val entry = f.text(); f.failText = { IOException("offline") }
        f.controller.drainText(); f.flush(); assertEquals(1, f.sent.size)
        assertEquals(500L, entry.retryAtMs - f.time)
        repeat(5) { f.timer() }
        assertEquals(6, f.sent.size); assertEquals(TextSendQueue.Phase.FAILED, entry.phase)
        f.controller.drainText(); f.flush(); assertEquals(6, f.sent.size)
    }
    @Test fun persistedRetryBudgetCannotResetOnRestart() {
        val f = Fixture(); f.open(); val entry = f.text(); f.failText = { IOException("offline") }
        f.controller.drainText(); f.flush(); repeat(2) { f.timer() }
        val next = Fixture(f.disk); next.failText = { IOException("offline") }; next.open(ready = false)
        val restored = next.controller.textQueue!!.pending(account.token, 1, account.endpoint, 10).single()
        assertEquals(entry.requestId, restored.requestId); assertEquals(3L, restored.attempt)
        next.time += 1_000_000; next.open(); next.controller.drainText(); next.flush(); repeat(2) { next.timer() }
        assertEquals(3, next.sent.size); assertEquals(TextSendQueue.Phase.FAILED, restored.phase)
    }
    @Test fun independentConversationsUseTwoSlotsButSameConversationRemainsOrdered() {
        val f = Fixture(); f.open(); val a = f.text(10); val b = f.text(10); val other = f.text(20)
        f.controller.drainText(); f.flush(false)
        assertEquals(2, f.textWork.tasks.size); assertEquals(TextSendQueue.Phase.QUEUED, b.phase)
        assertEquals(TextSendQueue.Phase.SENDING, a.phase); assertEquals(TextSendQueue.Phase.SENDING, other.phase)
        f.flush(); assertEquals(listOf(a.requestId, other.requestId, b.requestId), f.sent)
    }
    @Test fun restartingUncertainTextUsesSameIdAndAnAcknowledgedSnapshotStaysEmpty() {
        val f = Fixture(); f.open(); val entry = f.text(); f.controller.drainText(); f.flush(false)
        // The server accepted the request before the killed process received its response.
        val accepted = ChatDelivery(41, 10, 1, "snapshot")
        val restarted = Fixture(f.disk); restarted.server[entry.requestId] = accepted; restarted.open(ready = false)
        assertTrue(restarted.sent.isEmpty()); restarted.open(); restarted.controller.drainText(); restarted.flush()
        assertEquals(listOf(entry.requestId), restarted.sent); assertEquals(1, restarted.server.size)
        val again = Fixture(f.disk); again.open(); again.controller.drainText(); again.flush(); assertTrue(again.sent.isEmpty())
    }
    @Test fun realtimeAckWinsBeforeRestoreWithoutDuplicateSend() {
        val f = Fixture(); f.open(ready = false); val entry = f.text()
        val next = Fixture(f.disk); next.controller.update(ChatSendGate(account, 10, true, false))
        next.controller.acknowledge(entry.requestId, ChatDelivery(8, 10, 1, "snapshot"), true); next.flush()
        next.open(); next.controller.drainText(); next.flush(); assertTrue(next.sent.isEmpty())
    }
    @Test fun staleAccountWorkersCannotPublishToTheNewAccount() {
        val f = Fixture(); f.open(); f.text(); f.controller.drainText(); f.flush(false)
        f.controller.update(ChatSendGate()); f.flush(); assertTrue(f.controller.events().isEmpty())
        assertNull(f.controller.textQueue); assertTrue(f.sent.isEmpty())
    }
    @Test fun mediaPermissionLossDefersThenRestoresTheSameAttachment() {
        val f = Fixture(); f.open(); val entry = f.media(); f.controller.drainMedia(); f.flush(false)
        f.open(allowed = false); assertEquals(DurableMediaOutbox.Phase.QUEUED, entry.phase); assertTrue(f.sent.isEmpty())
        f.open(); f.controller.drainMedia(); f.flush(); assertEquals(listOf("photo"), f.sent)
    }
    @Test fun transientMediaRetriesReuseUploadAndExhaustWithoutBlockingNext() {
        val f = Fixture(); f.open(); val entry = f.media(); f.media("second")
        f.failMedia = { if (it === entry) IOException("offline") else null }
        f.controller.drainMedia(); f.flush(); repeat(5) { f.timer() }
        assertEquals(6, f.sent.count { it == "photo" }); assertEquals(DurableMediaOutbox.Phase.FAILED, entry.phase)
        assertEquals(1, f.sent.count { it == "second" }); assertEquals(2, f.uploads)
    }
    @Test fun successfulMediaSnapshotSurvivesRestartWithoutResending() {
        val f = Fixture(); f.open(); f.media(); f.controller.drainMedia(); f.flush()
        val next = Fixture(mediaDiskRecord = f.mediaDiskRecord); next.open(); next.controller.drainMedia(); next.flush()
        assertTrue(next.sent.isEmpty()); assertTrue(next.controller.mediaQueue!!.pending(10).isEmpty())
    }
    @Test fun mediaPermanentFourHundredResponseStillFails() {
        val f = Fixture(); f.open(); val entry = f.media(); f.failMedia = { ClientApiException(400, "bad", "bad") }
        f.controller.drainMedia(); f.flush(); assertEquals(DurableMediaOutbox.Phase.FAILED, entry.phase); assertEquals(1, f.sent.size)
    }
    @Test fun failedMediaDeferAndRepeatedClaimFailuresResumeAfterStorageRecovers() {
        val f = Fixture(); f.open(); val entry = f.media(); f.media("next")
        f.failMedia = { if (it === entry) { f.mediaDiskRecord.fail = true; IOException("offline") } else null }
        f.controller.drainMedia(); f.flush()
        assertEquals(DurableMediaOutbox.Phase.QUEUED, entry.phase); assertEquals(1L, entry.attempt)
        repeat(3) { f.timer(); assertEquals(1L, entry.attempt); assertEquals(listOf("photo"), f.sent) }
        assertTrue(f.faults.contains("ANDROID_LOCAL_MEDIA_STATE"))
        assertEquals(1, f.controller.events().count { it.message.isNotEmpty() })
        f.mediaDiskRecord.fail = false; f.failMedia = null; f.timer()
        assertEquals(listOf("photo", "photo", "next"), f.sent); assertEquals(2, f.uploads)
        assertTrue(f.controller.mediaQueue!!.pending(10).isEmpty()); assertEquals(2, f.server.size)
    }
    @Test fun mediaPausePersistenceFailureNeverBecomesFailedWhilePermissionIsMissing() {
        val f = Fixture(); f.open(); val entry = f.media(); f.controller.drainMedia(); f.flush(false)
        f.mediaDiskRecord.fail = true; f.open(allowed = false)
        assertEquals(DurableMediaOutbox.Phase.QUEUED, entry.phase); assertTrue(f.sent.isEmpty())
        f.mediaDiskRecord.fail = false; f.open(); f.flush()
        assertEquals(listOf("photo"), f.sent); assertTrue(f.controller.mediaQueue!!.pending(10).isEmpty())
    }
    @Test fun accountSwitchCancelsLocalMediaRecoveryWakeupAndRejectsOldWork() {
        val f = Fixture(); f.open(); val entry = f.media()
        f.failMedia = { f.mediaDiskRecord.fail = true; IOException("offline") }
        f.controller.drainMedia(); f.flush(); f.timer()
        assertEquals(DurableMediaOutbox.Phase.QUEUED, entry.phase); assertFalse(f.timers.isEmpty())
        val oldWakeup = f.timers.keys.single()
        f.controller.update(ChatSendGate()); f.flush(); f.mediaDiskRecord.fail = false; oldWakeup.run(); f.flush()
        assertTrue(f.timers.isEmpty()); assertNull(f.controller.mediaQueue); assertEquals(listOf("photo"), f.sent)
        assertTrue(f.controller.events().isEmpty())
    }
    @Test fun permanentMediaFailureStaysFailedWhenItsStateWriteFailsAndNextActionRecovers() {
        val f = Fixture(); f.open(); val entry = f.media(); f.media("next")
        f.failMedia = { if (it === entry) { f.mediaDiskRecord.fail = true; ClientApiException(403, "denied", "denied") } else null }
        f.controller.drainMedia(); f.flush()
        assertEquals(DurableMediaOutbox.Phase.FAILED, entry.phase)
        f.mediaDiskRecord.fail = false; f.timer()
        assertEquals(listOf("photo", "next"), f.sent); assertEquals(DurableMediaOutbox.Phase.FAILED, entry.phase)
        val restarted = Fixture(mediaDiskRecord = f.mediaDiskRecord); restarted.open()
        assertEquals(DurableMediaOutbox.Phase.FAILED, restarted.controller.mediaQueue!!.pending(10).single().phase)
        assertTrue(restarted.sent.isEmpty())
    }
    @Test fun closingCancelsWakeupsRejectsRestoresAndKeepsDurableEntries() {
        val f = Fixture(); f.open(); val entry = f.text(); f.failText = { IOException("offline") }
        f.controller.drainText(); f.flush(); assertFalse(f.timers.isEmpty())
        f.controller.close(); f.open(); f.flush(); assertTrue(f.timers.isEmpty()); assertNull(f.controller.textQueue)
        val restored = f.text(account).pending(account.token, 1, account.endpoint, 10).single()
        assertEquals(entry.requestId, restored.requestId)
    }
    @Test fun realtimeMediaReplyIsCompletedOnlyAfterTheDurableAckAndDoesNotRenderTwice() {
        val f = Fixture(); f.open(ready = false); val q = f.controller.mediaQueue!!
        val source = files.newFile().apply { writeBytes(byteArrayOf(1)) }
        q.enqueue("reply", 10, "file", "application/octet-stream", "file.bin", source, 42, 0)
        f.controller.acknowledge("reply", ChatDelivery(8, 10, 1, "snapshot"), false)
        assertTrue(f.controller.events().isEmpty()); f.flush()
        val event = f.controller.events().single()
        assertEquals(42, event.replyToId); assertTrue(event.acknowledgementOnly); assertTrue(q.pending(10).isEmpty())
    }
    @Test fun uncertainSixthAttemptCannotBecomeASeventhAutomaticRequestAfterRestart() {
        val f = Fixture(); f.open(ready = false); val entry = f.text(); val q = f.controller.textQueue!!
        repeat(5) { q.claim(account.token, 1, account.endpoint); q.defer(entry, "offline", entry.attempt, 0) }
        q.claim(account.token, 1, account.endpoint); assertEquals(6L, entry.attempt)
        val restored = Fixture(f.disk); restored.open(); restored.controller.drainText(); restored.flush()
        assertTrue(restored.sent.isEmpty())
        assertEquals(TextSendQueue.Phase.FAILED, restored.controller.textQueue!!.pending(account.token, 1, account.endpoint, 10).single().phase)
    }
    @Test fun explicitManualTextRetryStillWorksAfterAutomaticBudgetIsExhausted() {
        val f = Fixture(); f.open(); val entry = f.text(); f.failText = { IOException("offline") }
        f.controller.drainText(); f.flush(); repeat(5) { f.timer() }; assertEquals(6, f.sent.size)
        f.failText = null; f.controller.retryText(f.controller.textQueue!!, entry); f.flush()
        assertEquals(7, f.sent.size); assertTrue(f.controller.textQueue!!.pending(account.token, 1, account.endpoint, 10).isEmpty())
    }
    @Test fun explicitManualMediaRetryStillWorksAfterAutomaticBudgetIsExhausted() {
        val f = Fixture(); f.open(); val entry = f.media(); f.failMedia = { IOException("offline") }
        f.controller.drainMedia(); f.flush(); repeat(5) { f.timer() }; assertEquals(6, f.sent.size)
        f.failMedia = null; f.controller.retryMedia(f.controller.mediaQueue!!, entry); f.flush()
        assertEquals(7, f.sent.size); assertTrue(f.controller.mediaQueue!!.pending(10).isEmpty()); assertEquals(1, f.uploads)
    }
}

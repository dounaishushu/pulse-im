package com.pulseim.android

import java.util.concurrent.Executor

internal data class ChatSendGate(val account: ChatAccount? = null, val conversationId: Int = 0,
    val canSend: Boolean = false, val ready: Boolean = false)
internal data class ChatDelivery(val id: Int, val conversationId: Int, val senderId: Int, val snapshot: String)
internal data class ChatSendEvent(val sequence: Long, val delivery: ChatDelivery? = null,
    val requestId: String = "", val replyToId: Int = 0, val message: String = "", val mutation: Long = 0,
    val acknowledgementOnly: Boolean = false)

/** All queue writes retain their existing encrypted storage and transaction boundaries. */
internal interface ChatSendPorts : AutoCloseable {
    val main: Executor
    val textDisk: Executor
    val mediaDisk: Executor
    val textNetwork: Executor
    val mediaNetwork: Executor
    val scheduler: OutboxRetryWakeup.Scheduler
    fun now(): Long = System.currentTimeMillis()
    fun random(): Double = kotlin.random.Random.nextDouble()
    fun text(account: ChatAccount): TextSendQueue
    fun media(account: ChatAccount): DurableMediaOutbox
    fun sendText(entry: TextSendQueue.Entry, calls: ApiRequestScope): ChatDelivery
    fun sendMedia(queue: DurableMediaOutbox, entry: DurableMediaOutbox.Entry, attempt: Long,
        calls: ApiRequestScope, ensureCurrent: () -> Unit): ChatDelivery
    fun fault(code: String, error: Throwable?)
}

/** The ViewModel owns this actor; ports retain application services, never an Activity. */
internal class ChatSendController(private val ports: ChatSendPorts, private val changed: () -> Unit) : AutoCloseable {
    @Volatile var gate = ChatSendGate(); private set
    @Volatile var generation = 0L; private set
    @Volatile var textQueue: TextSendQueue? = null
    @Volatile var mediaQueue: DurableMediaOutbox? = null
    @Volatile private var closed = false
    private class Restore { var loading = false; var retryAt = 0L }
    private var textRestore = Restore()
    private var mediaRestore = Restore()
    private var claimingText = false
    private var claimingMedia = false
    private var mediaWriteRetryAt = 0L
    private data class TextWork(val queue: TextSendQueue, val entry: TextSendQueue.Entry, val attempt: Long,
        val generation: Long, val budgetAttempt: Long, val calls: ApiRequestScope = ApiRequestScope())
    private data class MediaWork(val queue: DurableMediaOutbox, val entry: DurableMediaOutbox.Entry, val attempt: Long,
        val generation: Long, val budgetAttempt: Long, val calls: ApiRequestScope = ApiRequestScope())
    private val texts = linkedMapOf<String, TextWork>()
    private val media = linkedMapOf<String, MediaWork>()
    private val acknowledgements = linkedMapOf<String, ChatDelivery>()
    private val notices = mutableListOf<ChatSendEvent>()
    private var sequence = 0L
    private val manualRetryOrigins = mutableMapOf<String, Long>()
    private fun budgetAttempt(requestId: String, attempt: Long) = attempt - (manualRetryOrigins[requestId] ?: 0L)
    private class RetryExhausted(message: String) : IllegalStateException(message)
    private fun requireBudget(attempt: Long, error: String) {
        if (attempt <= 0 || attempt > ChatRetryPolicy.MAX_RETRIES + 1L)
            throw RetryExhausted(error.ifBlank { "发送未确认，请确认后重试" })
    }
    val wakeup = OutboxRetryWakeup(ports.scheduler, ports::now) { drainText(); drainMedia() }
    fun events(): List<ChatSendEvent> = notices.toList()
    fun consumed(sequence: Long) { notices.removeAll { it.sequence <= sequence } }
    private fun notify(event: ChatSendEvent? = null) { if (event != null) notices.add(event); changed() }
    private fun error(code: String, error: Throwable?, message: String) {
        ports.fault(code, error); notify(ChatSendEvent(++sequence, message = message))
    }
    fun current(account: ChatAccount, epoch: Long) = !closed && generation == epoch && gate.account == account
    private fun textAllowed(cid: Int) = TextSendPolicy.canSend(cid, gate.conversationId, gate.canSend)
    private fun mediaAllowed(cid: Int) = gate.ready && gate.canSend && gate.conversationId == cid

    fun update(value: ChatSendGate, forceMedia: Boolean = false) {
        if (closed) return
        val previous = gate
        if (gate.account != value.account) reset()
        gate = value
        val account = value.account ?: return
        val epoch = generation
        if (textQueue == null) restore(textRestore, ports.textDisk, account, epoch, false,
            "ANDROID_TEXT_OUTBOX_RESTORE", { ports.text(account) }) { attachText(it) }
        if (mediaQueue == null) restore(mediaRestore, ports.mediaDisk, account, epoch, forceMedia,
            "ANDROID_MEDIA_OUTBOX_RESTORE", { ports.media(account) }) { mediaQueue = it; reconcile(false); notify(); drainMedia() }
        if (value.ready && value != previous) { drainText(); drainMedia() }
    }

    private fun <T> restore(state: Restore, disk: Executor, account: ChatAccount, epoch: Long, force: Boolean,
        code: String, load: () -> T, ready: (T) -> Unit) {
        if (state.loading || !force && ports.now() < state.retryAt) return
        state.loading = true
        disk.execute {
            if (!current(account, epoch)) return@execute
            val result = runCatching(load)
            ports.main.execute {
                if (!current(account, epoch)) return@execute
                state.loading = false
                result.onSuccess { state.retryAt = 0; ready(it) }.onFailure {
                    state.retryAt = ports.now() + 15_000; ports.fault(code, it)
                }
            }
        }
    }
    fun attachText(queue: TextSendQueue) { textQueue = queue; reconcile(true); notify(); drainText() }

    fun rows(cid: Int): List<OutboxRow> {
        val a = gate.account ?: return emptyList()
        return textQueue?.pending(a.token, a.userId, a.endpoint, cid).orEmpty().map {
            OutboxRow(it.requestId, it.conversationId, "text", it.phase.name, it.error, it.attempt, it.retryAtMs)
        } + mediaQueue?.pending(cid).orEmpty().filter { it.token == a.token && it.userId == a.userId && it.endpoint == a.endpoint }.map {
            OutboxRow(it.requestId, it.conversationId, it.kind, it.phase.name, it.error, it.attempt, it.retryAtMs)
        }
    }

    fun changeText(queue: TextSendQueue, change: () -> Boolean) = mutate(ports.textDisk,
        { textQueue === queue }, "ANDROID_LOCAL_TEXT_STATE", "本地状态保存失败，请检查存储空间", change) { drainText() }
    fun retryText(queue: TextSendQueue, entry: TextSendQueue.Entry) {
        val account = gate.account ?: return; val origin = entry.attempt
        mutate(ports.textDisk, { textQueue === queue }, "ANDROID_LOCAL_TEXT_STATE", "本地状态保存失败，请检查存储空间",
            { queue.retry(entry, account.token, account.userId, account.endpoint) }) {
            manualRetryOrigins[entry.requestId] = origin; drainText()
        }
    }
    fun retryMedia(queue: DurableMediaOutbox, entry: DurableMediaOutbox.Entry) {
        val origin = entry.attempt
        mutate(ports.mediaDisk, { mediaQueue === queue }, "ANDROID_LOCAL_MEDIA_STATE", "本地状态保存失败，请重试",
            { queue.retry(entry) }) { manualRetryOrigins[entry.requestId] = origin; drainMedia() }
    }
    fun changeMedia(queue: DurableMediaOutbox, mutation: Long = 0, change: () -> Boolean) = mutate(ports.mediaDisk,
        { mediaQueue === queue }, "ANDROID_LOCAL_MEDIA_STATE", "本地状态保存失败，请重试", change) {
        if (mutation != 0L) notify(ChatSendEvent(++sequence, mutation = mutation)); drainMedia()
    }
    private fun mutate(disk: Executor, same: () -> Boolean, code: String, message: String,
        change: () -> Boolean, done: () -> Unit) {
        val account = gate.account ?: return; val epoch = generation
        disk.execute {
            if (!current(account, epoch) || !same()) return@execute
            val result = runCatching(change)
            ports.main.execute {
                if (!current(account, epoch) || !same()) return@execute
                result.onSuccess { if (it) { notify(); done() } }.onFailure { error(code, it, message) }
            }
        }
    }

    fun drainText() {
        val a = gate.account ?: return; val q = textQueue ?: return; val epoch = generation
        val slots = 2 - texts.size
        if (closed || !gate.ready || claimingText || slots <= 0) return
        val blocked = if (gate.canSend) 0 else gate.conversationId
        claimingText = true
        ports.textDisk.execute {
            val result = runCatching {
                val entries = if (current(a, epoch)) q.claim(a.token, a.userId, a.endpoint, slots, blocked, ports.now()) else emptyList()
                entries to q.nextRetryAt(a.token, a.userId, a.endpoint, blocked, ports.now())
            }
            ports.main.execute {
                val active = current(a, epoch) && textQueue === q
                if (active) claimingText = false
                val entries = result.getOrNull()?.first.orEmpty()
                val (ready, waiting) = entries.partition { active && gate.ready && textAllowed(it.conversationId) }
                if (waiting.isNotEmpty()) ports.textDisk.execute {
                    val deferred = runCatching { waiting.forEach { q.defer(it, "等待恢复发送…", it.attempt, 0L, ports.now()) } }
                    ports.main.execute {
                        if (current(a, epoch)) { deferred.onFailure { error("ANDROID_LOCAL_TEXT_STATE", it, "本地待发状态保存失败，请检查存储空间") }; notify(); drainText() }
                    }
                }
                if (!active) return@execute
                if (result.isFailure) { error("ANDROID_LOCAL_TEXT_STATE", result.exceptionOrNull(), "本地待发状态保存失败，请检查存储空间"); return@execute }
                wakeup.schedule(result.getOrNull()?.second ?: 0)
                if (ready.isNotEmpty()) sendText(q, ready)
                else if (entries.isEmpty() && blocked > 0 && textAllowed(blocked)) drainText()
                notify()
            }
        }
    }

    fun sendText(queue: TextSendQueue, entries: List<TextSendQueue.Entry>) {
        entries.forEach { entry ->
            val work = TextWork(queue, entry, entry.attempt, generation, budgetAttempt(entry.requestId, entry.attempt)); texts[entry.requestId] = work
            ports.textNetwork.execute {
                val result = runCatching {
                    if (!current(ChatAccount(entry.endpoint, entry.userId, entry.token), work.generation)) throw TextSendPolicy.NotReady("账号已切换，请返回原账号重试")
                    if (!gate.ready || !textAllowed(entry.conversationId)) throw TextSendPolicy.NotReady("已禁止发言")
                    requireBudget(work.budgetAttempt, entry.error)
                    ports.sendText(entry, work.calls).also { validate(it, entry.conversationId, entry.userId) }
                }
                var delivery: ChatDelivery? = null
                val persisted = runCatching {
                    result.fold(onSuccess = { sent ->
                        if (queue.acknowledge(entry.requestId, entry.token, entry.userId, entry.endpoint, entry.conversationId) != null) delivery = sent
                    }, onFailure = { failure ->
                        val exception = failure as? Exception ?: throw failure
                        val deferred = TextSendPolicy.decide(exception, textAllowed(entry.conversationId)) == TextSendDecision.DEFER
                        val paused = exception is TextSendPolicy.NotReady || !gate.ready || !textAllowed(entry.conversationId) || work.calls.cancelled
                        val delay = if (paused || exception is RetryExhausted) null else ChatRetryPolicy.retryDelayMs(work.budgetAttempt, ports.random())
                        if (deferred && (paused || delay != null)) queue.defer(entry, failure.message, work.attempt, delay ?: 0L, ports.now())
                        else queue.fail(entry, failure.message ?: "网络异常", work.attempt)
                    })
                }
                ports.main.execute {
                    if (texts[entry.requestId] === work) texts.remove(entry.requestId)
                    if (!current(ChatAccount(entry.endpoint, entry.userId, entry.token), work.generation) || textQueue !== queue) return@execute
                    persisted.onFailure { ports.fault("ANDROID_LOCAL_TEXT_STATE", it) }
                    delivery?.let { manualRetryOrigins.remove(entry.requestId); notify(ChatSendEvent(++sequence, it, entry.requestId, entry.replyToId)) }
                    if (entry.phase == TextSendQueue.Phase.QUEUED) wakeup.schedule(entry.retryAtMs)
                    notify(); drainText()
                }
            }
        }
    }

    fun drainMedia() {
        val a = gate.account ?: return; val q = mediaQueue ?: return; val epoch = generation; val cid = gate.conversationId
        if (closed || claimingMedia || !mediaAllowed(cid) || cid <= 0) return
        if (ports.now() < mediaWriteRetryAt) { wakeup.schedule(mediaWriteRetryAt); return }
        claimingMedia = true
        ports.mediaDisk.execute {
            val result = runCatching { (if (current(a, epoch)) q.claim(cid, ports.now()) else null) to q.nextRetryAt(cid, ports.now()) }
            ports.main.execute {
                val active = current(a, epoch) && mediaQueue === q
                if (active) claimingMedia = false
                val entry = result.getOrNull()?.first
                if (!active || !mediaAllowed(cid)) {
                    if (entry != null) ports.mediaDisk.execute {
                        val deferred = runCatching { q.defer(entry, "等待恢复发送…", entry.attempt, 0L, ports.now()) }
                        ports.main.execute { if (current(a, epoch)) { deferred.onFailure { ports.fault("ANDROID_LOCAL_MEDIA_STATE", it) }; notify(); drainMedia() } }
                    } else if (active && cid != gate.conversationId) drainMedia()
                    return@execute
                }
                if (result.isFailure) {
                    if (mediaWriteRetryAt == 0L) error("ANDROID_LOCAL_MEDIA_STATE", result.exceptionOrNull(), "本地待发状态保存失败，请检查存储空间")
                    else ports.fault("ANDROID_LOCAL_MEDIA_STATE", result.exceptionOrNull())
                    mediaWriteRetryAt = ports.now() + 15_000; wakeup.schedule(mediaWriteRetryAt)
                    return@execute
                }
                mediaWriteRetryAt = 0L
                wakeup.schedule(result.getOrNull()?.second ?: 0)
                if (entry != null) sendMedia(q, entry)
            }
        }
    }

    fun sendMedia(queue: DurableMediaOutbox, entry: DurableMediaOutbox.Entry) {
        val work = MediaWork(queue, entry, entry.attempt, generation, budgetAttempt(entry.requestId, entry.attempt)); media[entry.requestId] = work; notify()
        val account = ChatAccount(entry.endpoint, entry.userId, entry.token)
        fun ensureCurrent() {
            if (!current(account, work.generation) || !mediaAllowed(entry.conversationId) || work.calls.cancelled) throw TextSendPolicy.NotReady("等待恢复发送…")
        }
        ports.mediaNetwork.execute {
            var delivery: ChatDelivery? = null
            val result = runCatching {
                ensureCurrent()
                requireBudget(work.budgetAttempt, entry.error)
                val sent = ports.sendMedia(queue, entry, work.attempt, work.calls, ::ensureCurrent)
                validate(sent, entry.conversationId, entry.userId)
                if (queue.acknowledge(entry.requestId, entry.conversationId) != null) delivery = sent
            }
            result.exceptionOrNull()?.let { failure ->
                val exception = failure as? Exception ?: throw failure
                val paused = exception is TextSendPolicy.NotReady || !current(account, work.generation) || !mediaAllowed(entry.conversationId) || work.calls.cancelled
                val temporary = TextSendPolicy.decide(exception, gate.canSend) == TextSendDecision.DEFER
                val delay = if (paused || exception is RetryExhausted) null else ChatRetryPolicy.retryDelayMs(work.budgetAttempt, ports.random())
                runCatching {
                    if (failure is OutboxAttachments.Unreadable) queue.markUnreadable(entry, work.attempt)
                    else if ((paused && temporary) || temporary && delay != null) queue.defer(entry, failure.message, work.attempt, delay ?: 0L, ports.now())
                    else queue.fail(entry, failure.message ?: "发送未确认，请重试", work.attempt)
                }.onFailure { ports.fault("ANDROID_LOCAL_MEDIA_STATE", it) }
                if (!paused) ports.fault(if (failure is OutboxAttachments.Unreadable) "ANDROID_DURABLE_MEDIA_UNREADABLE" else "ANDROID_DURABLE_MEDIA_SEND", failure)
            }
            ports.main.execute {
                if (media[entry.requestId] === work) media.remove(entry.requestId)
                if (!current(account, work.generation) || mediaQueue !== queue) return@execute
                delivery?.let { manualRetryOrigins.remove(entry.requestId); notify(ChatSendEvent(++sequence, it, entry.requestId, entry.replyToId)) }
                if (entry.phase == DurableMediaOutbox.Phase.QUEUED) wakeup.schedule(entry.retryAtMs)
                notify(); drainMedia()
            }
        }
    }

    fun acknowledge(requestId: String, delivery: ChatDelivery, text: Boolean) {
        val account = gate.account ?: return
        if (delivery.id <= 0 || delivery.senderId != account.userId || delivery.conversationId <= 0 || requestId.isBlank()) return
        if ((text && textQueue == null) || (!text && mediaQueue == null)) {
            acknowledgements[requestId] = delivery
            if (acknowledgements.size > 512) acknowledgements.remove(acknowledgements.keys.first())
            return
        }
        val cid = delivery.conversationId
        if (text) textQueue?.let { q -> changeText(q) { q.acknowledge(requestId, account.token, account.userId, account.endpoint, cid) != null } }
        else mediaQueue?.let { q ->
            val work = media[requestId]
            var acknowledged: DurableMediaOutbox.Entry? = null
            mutate(ports.mediaDisk, { mediaQueue === q }, "ANDROID_LOCAL_MEDIA_ACK", "本地状态保存失败，请重试", {
                acknowledged = q.acknowledge(requestId, cid)?.also { work?.calls?.cancel() }
                acknowledged != null
            }) {
                acknowledged?.let { notify(ChatSendEvent(++sequence, delivery, requestId, it.replyToId, acknowledgementOnly = true)) }
                drainMedia()
            }
        }
    }
    fun reconcile(text: Boolean) {
        val ready = acknowledgements.filterKeys { it.startsWith("android-text-") == text }
        acknowledgements.keys.removeAll(ready.keys)
        ready.forEach { (id, delivery) -> acknowledge(id, delivery, text) }
    }
    private fun validate(delivery: ChatDelivery, cid: Int, actor: Int) {
        check(delivery.id > 0 && delivery.conversationId == cid && delivery.senderId == actor) { "消息回执无效，请重试" }
    }
    fun reset() {
        wakeup.reset(); generation++
        val interruptedText = texts.values.toList(); texts.clear()
        val interruptedMedia = media.values.toList(); media.clear()
        interruptedText.forEach { it.calls.cancel() }; interruptedMedia.forEach { it.calls.cancel() }
        ports.textDisk.execute { interruptedText.forEach { work -> runCatching { work.queue.defer(work.entry, "等待恢复发送…", work.attempt, 0L, ports.now()) }.onFailure { ports.fault("ANDROID_LOCAL_TEXT_STATE", it) } } }
        ports.mediaDisk.execute { interruptedMedia.forEach { work -> runCatching { work.queue.defer(work.entry, "等待恢复发送…", work.attempt, 0L, ports.now()) }.onFailure { ports.fault("ANDROID_LOCAL_MEDIA_STATE", it) } } }
        gate = ChatSendGate(); textQueue = null; mediaQueue = null
        textRestore = Restore(); mediaRestore = Restore(); claimingText = false; claimingMedia = false; mediaWriteRetryAt = 0L
        acknowledgements.clear(); notices.clear(); manualRetryOrigins.clear()
    }
    override fun close() { if (closed) return; reset(); closed = true; ports.close() }
}

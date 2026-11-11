package com.pulseim.android

import android.content.Context
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/** Background, resumable archive of server-visible history, separate from foreground navigation. */
internal object LocalChatArchive {
    private val diskWorker = Executors.newSingleThreadExecutor()
    val disk = java.util.concurrent.Executor { job -> diskWorker.execute { try { job.run() } catch (_: Exception) { /* Optional disk storage must never crash a network-capable client. */ } } }
    private val worker = Executors.newSingleThreadExecutor()
    private val epoch = AtomicInteger()
    private var identity = ""
    private val pending = linkedSetOf<String>()
    private var calls: ApiRequestScope? = null
    @Synchronized fun bind(scope: String) { if (identity != scope) { stop(); identity = scope } }
    @Synchronized fun stop() { epoch.incrementAndGet(); calls?.cancel(); calls = null; pending.clear(); identity = "" }
    @Synchronized private fun current(scope: String, revision: Int) = identity == scope && epoch.get() == revision
    fun save(context: Context, ticket: LocalChatStore.Ticket, page: ChatHistoryPage, before: Int = Int.MAX_VALUE, info: JSONObject? = null, cleared: Int = 0) {
        LocalChatStore.merge(context, ticket, page.items, cleared = maxOf(cleared, page.clearedBefore),
            floor = page.items.minOfOrNull { it.optInt("id") } ?: (cleared + 1), maximum = if (before == Int.MAX_VALUE && page.items.isNotEmpty()) page.items.maxOf { it.optInt("id") } else before,
            cursor = page.nextMaxId, complete = !page.hasMore, info = info, latest = before == Int.MAX_VALUE)
    }
    @Synchronized fun enqueue(context: Context, base: String, token: String, scope: String, cid: Int) {
        if (identity != scope || pending.size >= 32 || !pending.add("$scope:$cid")) return
        val revision = epoch.get(); val generation = LocalChatStore.generation(); val app = context.applicationContext
        worker.execute {
            try {
                if (!current(scope, revision) || generation != LocalChatStore.generation()) return@execute
                Thread.sleep(3000)
                if (!current(scope, revision) || generation != LocalChatStore.generation()) return@execute
                val client = ApiClient(base); client.token = token
                val control = ApiRequestScope(); client.requestScope = control
                synchronized(this) { if (!current(scope, revision)) return@execute; calls = control }
                var local = LocalChatStore.read(app, scope, cid, limit = 1)
                var cursor = local.cursor ?: return@execute
                while (!local.complete && cursor > 0 && current(scope, revision) && generation == LocalChatStore.generation()) {
                    val ticket = LocalChatStore.ticket(app, scope, cid)
                    val page = client.historyPage(cid, cursor)
                    if (!current(scope, revision) || generation != LocalChatStore.generation()) break
                    save(app, ticket, page, cursor, cleared = local.cleared)
                    if (!page.hasMore || page.nextMaxId >= cursor) break
                    local = LocalChatStore.read(app, scope, cid, limit = 1)
                    cursor = local.cursor ?: break; Thread.sleep(150)
                }
            } catch (error: Exception) {
                if (error is ClientApiException && error.status in listOf(401, 403) && current(scope, revision)) {
                    LocalChatStore.clearConversation(app, scope, cid); LocalMediaCache.purge(app, scope, cid)
                }
            } finally { synchronized(this) { pending.remove("$scope:$cid"); if (current(scope, revision)) calls = null } }
        }
    }
}

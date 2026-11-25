package com.pulseim.android

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.graphics.Bitmap
import android.os.Bundle
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** Real entry/client/adapter/delta renderer, with an in-process authenticated API fixture. */
class ChatDeltaProbe : Instrumentation() {
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); start() }
    override fun onStart() {
        var activity: MainActivity? = null
        var socket: SocketClient? = null
        val workers = CountDownLatch(1); val gates = mutableListOf<CountDownLatch>(); val checks = JSONArray()
        try {
            check(targetContext.packageName.endsWith(".scrollprobe"))
            GoV2Ids.context = targetContext.applicationContext
            activity = startActivitySync(Intent().setClassName(targetContext.packageName, MainActivity::class.java.name).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
            val host = activity
            fun field(name: String) = MainActivity::class.java.getDeclaredField(name).apply { isAccessible = true }
            fun get(name: String) = ChatProbeAccess.get(host, name)
            fun set(name: String, value: Any?) = ChatProbeAccess.set(host, name, value)
            fun ui(action: () -> Unit) { var failure: Throwable? = null; runOnMainSync { try { action() } catch (error: Throwable) { failure = error } }; failure?.let { throw it } }
            fun invoke(name: String, vararg args: Any?) = MainActivity::class.java.declaredMethods.single { it.name == name && it.parameterCount == args.size }.apply { isAccessible = true }.invoke(host, *args)
            fun until(condition: () -> Boolean) {
                val deadline = SystemClock.uptimeMillis() + 8000
                while (SystemClock.uptimeMillis() < deadline) { waitForIdleSync(); var ready = false; ui { ready = condition() }; if (ready) return; SystemClock.sleep(30) }
                error("Delta UI timed out; cursor=${get("chatDeltaCursor")}; ready=${get("chatHistoryReady")}; revalidate=${get("goChatRevalidate")}")
            }
            ui { set("lastRealtimeCatchUp", Long.MAX_VALUE) }
            val base = get("apiBaseUrl") as String; check(base.startsWith("http://127.0.0.1:9/"))
            val token = "isolated-delta-probe"; val viewerWire = UUID.randomUUID().toString(); val room = UUID.randomUUID().toString()
            val viewer = GoV2Ids.local(base, "user", viewerWire); val cid = GoV2Ids.local(base, "conversation", room)
            GoV2Ids.membership(base, viewer, cid, "1", token)
            val ids = (1..30).associateWith { UUID.randomUUID().toString() }
            fun message(seq: Int, event: Int = seq, version: Int = 1, removed: Boolean = false, text: String = "原有消息 $seq") = JSONObject()
                .put("id", ids.getValue(seq)).put("seq", "$seq").put("event_seq", "$event").put("version", "$version").put("revoked", removed)
                .put("conversation_id", room).put("sender_id", viewerWire).put("sender", JSONObject().put("name", "本人"))
                .put("request_id", "probe-$seq").put("kind", "text").put("body", if (removed) "" else text).put("content", JSONObject())
                .put("created_at", "2026-11-17T00:00:00Z").put("updated_at", "2026-11-17T00:00:00Z")
            fun personal(seq: Int, kind: String, id: Int = 0, boundary: Int = 0) = JSONObject().put("seq", "$seq").put("kind", kind)
                .apply { if (id > 0) put("message_id", ids.getValue(id)); if (boundary > 0) put("boundary_seq", "$boundary") }
            fun event(sequence: Int, row: JSONObject) = JSONObject().put("seq", "$sequence").put("kind", "message.updated").put("message", row)
            fun page(events: List<JSONObject>, maximum: Long, next: Long, more: Boolean = false) = JSONObject()
                .put("events", JSONArray(events)).put("snapshot_max_seq", "$maximum").put("next_after_seq", "$next").put("has_more", more)
                .put("membership_version", "1").put("visible_from_seq", "1").put("visible_from_event_seq", "1").put("history_allowed", true)
            val mode = AtomicInteger(1); val historyReads = AtomicInteger(); val paths = java.util.Collections.synchronizedList(mutableListOf<String>())
            val openGate = AtomicReference(CountDownLatch(1).also { gates += it })
            fun adapter() = GoV2Api(base, { token }, { 1L }) { path, _, _, _ ->
                paths += path
                val query = android.net.Uri.parse("http://fixture$path")
                when {
                    path == "/me" -> JSONObject().put("user_id", viewerWire)
                    path.endsWith("/open") -> {
                        check(openGate.get().await(15, TimeUnit.SECONDS))
                        if (mode.get() == 4) throw ClientApiException(403, "forbidden", "denied")
                        JSONObject().put("id", room).put("kind", "group").put("title", "增量切换测试").put("member_count", 245)
                            .put("my_role", "member").put("can_send", true).put("event_seq", "25").put("message_seq", "23")
                            .put("membership_version", "1").put("visible_from_seq", "1").put("visible_from_event_seq", "1").put("history_allowed", true)
                            .put("state", JSONObject().put("user_id", viewerWire).put("clear_seq", "0").put("personal_seq", "2"))
                    }
                    path.contains("/history?") -> {
                        check(historyReads.incrementAndGet() == 1) { "Returning to a known chat fetched full history again: $path" }
                        JSONObject().put("items", JSONArray((1..20).map { message(it) })).put("membership_version", "1")
                            .put("snapshot_max_seq", "20").put("next_after_seq", "0").put("has_more", false).put("clear_seq", "0").put("visible_from_seq", "1")
                    }
                    path.contains("/personal-sync?") -> {
                        val after = query.getQueryParameter("after")!!.toLong()
                        when {
                            mode.get() == 5 || mode.get() == 6 || mode.get() == 7 || mode.get() == 9 -> page(emptyList(), after, after)
                            mode.get() == 8 && after == 0L -> page(listOf(personal(1, "message.deleted", 17)), 2, 1, true)
                            mode.get() == 8 && after == 1L -> { check(query.getQueryParameter("snapshot_max_seq") == "2"); page(listOf(personal(2, "history.cleared", boundary = 5)), 2, 2) }
                            after == 0L -> page(listOf(personal(1, "message.deleted", 17)), 1, 1)
                            mode.get() >= 3 && after == 1L -> page(listOf(personal(2, "history.cleared", boundary = 5)), 2, 2)
                            else -> page(emptyList(), after, after)
                        }
                    }
                    path.contains("/sync?") -> {
                        val after = query.getQueryParameter("after")!!.toLong()
                        check(query.getQueryParameter("membership_version") == "1")
                        when {
                            mode.get() == 10 -> page(listOf(event(26, message(24, 26))), 26, 26)
                            mode.get() == 7 -> page(emptyList(), after, after).put("membership_version", "2")
                            mode.get() == 6 -> page(emptyList(), after + 1, after, true)
                            mode.get() == 5 && after == 100L -> page(emptyList(), 111, 110, true)
                            mode.get() == 5 -> page(emptyList(), 111, 111)
                            after == 20L -> page(listOf(event(21, message(21))), 23, 21, true)
                            after == 21L -> {
                                check(query.getQueryParameter("snapshot_max_seq") == "23")
                                page(listOf(event(22, message(18, 22, 2, text = "增量编辑后的内容")), event(23, message(19, 23, 2, true))), 23, 23)
                            }
                            mode.get() >= 2 && after == 23L -> page(listOf(event(24, message(22, 24))), 24, 24)
                            mode.get() >= 3 && after == 24L -> page(listOf(event(25, message(23, 25))), 25, 25)
                            else -> page(emptyList(), after, after)
                        }
                    }
                    else -> error("Unexpected fixture path $path")
                }
            }
            fun fixture(client: ApiClient) { ApiClient::class.java.getDeclaredField("go\$delegate").apply { isAccessible = true }.set(client, lazyOf(adapter())) }
            val initial = ApiClient(base).apply { this.token = token }; fixture(initial)
            val initialPage = initial.historyPage(cid, size = 20)
            val info = JSONObject().put("id", cid).put("type", "group").put("name", "增量切换测试").put("member_count", 245).put("can_send", true)
                .put("membership_version", "1").put("event_seq", "20").put("state", JSONObject().put("personal_seq", "0"))
            val scope = LocalChatStore.scope(base, viewer, token); val cache = get("chatSwitchCache") as ChatSwitchCache
            socket = SocketClient("ws://127.0.0.1:9/api/v2/realtime", token, { _, _ -> }, { _, _ -> })
            val state = SocketClient::class.java.getDeclaredField("state").apply { isAccessible = true }.get(socket) as RealtimeConnectionState
            check(state.authenticate(state.begin()!!)); SocketClient::class.java.getDeclaredField("epoch").apply { isAccessible = true }.set(socket, 1)
            repeat(2) { (get("chatLoadExecutor") as ExecutorService).execute { workers.await(30, TimeUnit.SECONDS) } }
            ui {
                (get("api") as ApiClient).token = token; set("currentUserId", viewer); set("socket", socket); set("chatSocketEpoch", 7)
                cache.bind(scope, 7); check(cache.remember(cache.ticket(cid), info, initialPage, ChatDeltaCursor(20, 0, "1")))
                invoke("handlePacket", JSONObject().put("type", "go.changed").put("change_type", "membership.changed").put("conversation_id", cid))
                check(cache.read(cache.ticket(cid), info, true) != null)
                invoke("handlePacket", JSONObject().put("type", "go.changed").put("change_type", "conversation.changed").put("conversation_id", cid).put("event_seq", "23"))
                check(cache.read(cache.ticket(cid), info, true) != null)
                invoke("openExistingChat", cid, info)
            }
            fun injectEntry() {
                val entry = get("pendingChatEntry")!!
                val client = entry.javaClass.getDeclaredField("client").apply { isAccessible = true }.get(entry) as ApiClient
                fixture(client)
            }
            ui { injectEntry() }
            lateinit var messages: LinearLayout; lateinit var retained: View; lateinit var input: EditText
            until { (get("currentMessages") as? LinearLayout)?.let { it.findViewWithTag<View>(20) != null && it.findViewWithTag<View>(16) != null } == true }
            ui { messages = get("currentMessages") as LinearLayout; retained = messages.findViewWithTag(16); input = host.findViewById(R.id.chat_message_input); input.setText("增量切换保留的草稿") }
            checks.put("a normal message hint does not discard an inactive group's cached messages")
            checks.put("a membership notification retains existing records until the actual access scope is revalidated")
            workers.countDown(); SystemClock.sleep(2300); waitForIdleSync()
            ui {
                check(get("currentMessages") === messages && messages.findViewWithTag<View>(20) != null && get("chatCanSend") == false)
                check(host.findViewById<View>(R.id.chat_history_loading).visibility == View.GONE)
            }
            checks.put("a 2.3 second held open request keeps existing messages visible and sending gated")
            uiAutomation.takeScreenshot()?.let { bitmap -> File(targetContext.filesDir, "delta-held-open.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle() }
            openGate.get().countDown()
            until { (get("chatDeltaCursor") as? ChatDeltaCursor)?.events == 23L }
            ui {
                check(get("currentMessages") === messages && messages.findViewWithTag<View>(16) === retained)
                check(messages.findViewWithTag<View>(21) != null && messages.findViewWithTag<View>(19) == null && messages.findViewWithTag<View>(17) == null)
                @Suppress("UNCHECKED_CAST") val data = get("currentMessageData") as Map<Int, JSONObject>
                check(data[18]?.getJSONObject("body")?.getString("text") == "增量编辑后的内容")
                check(input.text.toString() == "增量切换保留的草稿")
            }
            checks.put("returning to a known group uses event sync instead of requesting full history")
            checks.put("new messages append and unchanged views and the draft survive delta application")
            checks.put("edits, recalls and private deletions are applied through separate incremental streams")
            check(historyReads.get() == 1 && paths.any { it.contains("/sync?after=20&") } && paths.any { it.contains("/personal-sync?after=0&") })
            checks.put("the saved cursors predate a newer open response, preventing missed concurrent messages")
            check(paths.any { it.contains("/sync?after=21&") && it.contains("snapshot_max_seq=23") })
            checks.put("multi-page event recovery retains one fixed snapshot and membership version")
            mode.set(2)
            ui { invoke("handlePacket", JSONObject().put("type", "go.changed").put("change_type", "conversation.changed").put("conversation_id", cid).put("event_seq", "24")) }
            until { (get("chatDeltaCursor") as? ChatDeltaCursor)?.events == 24L }
            SystemClock.sleep(180); waitForIdleSync()
            ui {
                check(messages === get("currentMessages") && messages.findViewWithTag<View>(22) != null && messages.findViewWithTag<View>(16) === retained)
                val scroll = host.findViewById<ScrollView>(R.id.chat_message_scroll)
                check((messages.height - scroll.height - scroll.scrollY).coerceAtLeast(0) < 20)
                check(cache.read(cache.ticket(cid), info, true)?.cursor?.events == 24L)
            }
            checks.put("live messages advance only the saved event cursor and follow the newest row")
            checks.put("the advanced cursor and latest rows are retained for the next navigation")
            ui {
                val scroll = host.findViewById<ScrollView>(R.id.chat_message_scroll)
                val follower = get("chatMessageScroll") as ChatMessageScroll
                val down = MotionEvent.obtain(0,0,MotionEvent.ACTION_DOWN,0f,0f,0); follower.onTouch(down); down.recycle()
                scroll.scrollTo(0,200)
                messages.setOnHierarchyChangeListener(object : android.view.ViewGroup.OnHierarchyChangeListener {
                    override fun onChildViewRemoved(parent: View?, child: View?) = Unit
                    override fun onChildViewAdded(parent: View?, child: View?) {
                        if (child?.tag == 23) messages.post {
                            val move=MotionEvent.obtain(0,0,MotionEvent.ACTION_MOVE,0f,80f,0); follower.onTouch(move); move.recycle()
                            scroll.scrollTo(0,300)
                        }
                    }
                })
            }
            mode.set(9)
            ui { invoke("handlePacket", JSONObject().put("type", "go.changed").put("change_type", "conversation.changed").put("conversation_id", cid).put("event_seq", "25")) }
            until { (get("chatDeltaCursor") as? ChatDeltaCursor)?.events == 25L }
            SystemClock.sleep(180); waitForIdleSync()
            ui {
                check(host.findViewById<ScrollView>(R.id.chat_message_scroll).scrollY == 300)
                check(messages.findViewWithTag<View>(23) != null && messages.findViewWithTag<View>(16) === retained)
                messages.setOnHierarchyChangeListener(null)
                val up=MotionEvent.obtain(0,0,MotionEvent.ACTION_UP,0f,80f,0); (get("chatMessageScroll") as ChatMessageScroll).onTouch(up); up.recycle()
            }
            checks.put("background sync appends new messages without a queued anchor restoration overriding a newer drag")
            mode.set(2)
            fun holdNavigation(): CountDownLatch {
                val release = CountDownLatch(1); gates += release
                val started = CountDownLatch(2)
                repeat(2) { (get("chatLoadExecutor") as ExecutorService).execute { started.countDown(); release.await(20, TimeUnit.SECONDS) } }
                check(started.await(5, TimeUnit.SECONDS)); return release
            }
            val secondNavigation = holdNavigation()
            mode.set(3); openGate.set(CountDownLatch(1).also { gates += it })
            ui {
                invoke("returnFromChat")
                invoke("handlePacket", JSONObject().put("type", "go.changed").put("change_type", "personal.changed").put("conversation_id", cid))
                invoke("openExistingChat", cid, info); injectEntry()
            }
            secondNavigation.countDown()
            until { (get("currentMessages") as? LinearLayout)?.findViewWithTag<View>(22) != null }
            checks.put("personal-change hints while away retain the chat frame and records for cursor reconciliation")
            openGate.get().countDown()
            until { (get("chatDeltaCursor") as? ChatDeltaCursor)?.events == 25L && (get("chatDeltaCursor") as? ChatDeltaCursor)?.personal == 2L }
            ui {
                val rows = get("currentMessages") as LinearLayout
                check((1..5).all { rows.findViewWithTag<View>(it) == null } && rows.findViewWithTag<View>(23) != null)
                check(historyReads.get() == 1)
            }
            checks.put("a private clear boundary removes its rows while retaining newer messages without a page reload")
            mode.set(10)
            ui {
                check(socket?.authenticated == true)
                set("lastRealtimeCatchUp", SystemClock.elapsedRealtime() - 16000L)
                set("chatSynchronizedEpoch", get("chatSocketEpoch"))
                (get("foregroundMessageCheck") as Runnable).run()
            }
            until { (get("chatDeltaCursor") as? ChatDeltaCursor)?.events == 26L }
            ui {
                val rows = get("currentMessages") as LinearLayout
                check(rows.findViewWithTag<View>(24) != null && historyReads.get() == 1)
                check(host.findViewById<EditText>(R.id.chat_message_input).text.toString() == "增量切换保留的草稿")
                set("lastRealtimeCatchUp", Long.MAX_VALUE)
            }
            checks.put("foreground fallback catches a missed message while the socket still reports authenticated")
            checks.put("missed-hint reconciliation keeps the draft and avoids a second full history read")
            ui {
                val rows = get("currentMessages") as LinearLayout
                val accepted = rows.findViewWithTag<View>(24)
                val old = initialPage.items.first().optInt("id")
                @Suppress("UNCHECKED_CAST")
                val known = (get("messageVersions") as MessageVersionGuard<JSONObject>).value(24)
                check(accepted != null && old > 0 && known != null)
                val stale = JSONObject(known.toString()).apply { put("version", "0"); getJSONObject("body").put("text", "stale draft") }
                set("goChatRevalidate", true)
                try {
                    invoke("addMessage", rows, stale, "snapshot")
                    check(rows.findViewWithTag<View>(24) === accepted)
                } finally { set("goChatRevalidate", false) }
            }
            checks.put("a known row rejected by the access gate does not recurse or repaint")
            mode.set(5); val filtered = ApiClient(base).apply { this.token = token }; fixture(filtered)
            val empty = filtered.messageDelta(cid, ChatDeltaCursor(100, 0, "1"))
            check(empty.items.isEmpty() && empty.cursor.events == 111L)
            checks.put("filtered empty event pages still advance the cursor and terminate")
            mode.set(6)
            check(runCatching { filtered.messageDelta(cid, ChatDeltaCursor(100, 0, "1")) }.isFailure)
            checks.put("a non-progressing cursor is rejected instead of looping or committing")
            check(runCatching { filtered.messageDelta(cid, ChatDeltaCursor(100, 0, "1"), { false }) }.isFailure)
            checks.put("cancelled navigation cannot read or apply another delta page")
            mode.set(5); var activeChecks = 0; var painted = false
            check(runCatching { filtered.messageDelta(cid, ChatDeltaCursor(100, 0, "1"), { ++activeChecks < 3 }, { painted = true }) }.isFailure && !painted)
            checks.put("cancellation between pages prevents partial cursor commit or rendering")
            mode.set(7)
            check((runCatching { filtered.messageDelta(cid, ChatDeltaCursor(100, 0, "1")) }.exceptionOrNull() as? ClientApiException)?.errorCode == "membership_changed")
            checks.put("a changed membership version rejects the delta instead of applying stale-role content")
            mode.set(8)
            val privatePages = filtered.messageDelta(cid, ChatDeltaCursor(100, 0, "1"))
            check(privatePages.cursor.personal == 2L && privatePages.cleared == 5 && 17 in privatePages.removed)
            checks.put("private deletions and clears paginate with their own fixed snapshot")
            val deniedNavigation = holdNavigation()
            mode.set(4); openGate.set(CountDownLatch(1).also { gates += it })
            ui { invoke("returnFromChat"); invoke("openExistingChat", cid, info); injectEntry() }
            deniedNavigation.countDown()
            until { (get("currentMessages") as? LinearLayout)?.findViewWithTag<View>(23) != null }
            openGate.get().countDown()
            until { get("activeConversationId") != cid }
            ui { check(cache.read(cache.ticket(cid), info, true) == null) }
            checks.put("a fresh access denial still closes the restored chat and purges its snapshot")
            val report = JSONObject().put("passed", checks.length()).put("checks", checks).put("full_history_reads", historyReads.get()).put("paths", JSONArray(paths.toList()))
            File(targetContext.filesDir, "chat-delta-results.json").writeText(report.toString(2))
            finish(Activity.RESULT_OK, Bundle().apply { putString("checks", report.toString()) })
        } catch (error: Throwable) { finish(Activity.RESULT_CANCELED, Bundle().apply { putString("error", error.stackTraceToString()) }) }
        finally { gates.forEach { it.countDown() }; workers.countDown(); activity?.let { runOnMainSync { it.finish() } }; socket?.close() }
    }
}

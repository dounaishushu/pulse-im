package com.pulseim.android

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import android.view.View
import android.widget.EditText
import android.widget.LinearLayout
import android.view.ViewGroup
import android.widget.ImageView
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.drawable.BitmapDrawable
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.TimeUnit

/** Actual navigation while both HTTP workers are held; no production account/server. */
class ChatSwitchProbe : Instrumentation() {
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); start() }
    override fun onStart() {
        var activity: MainActivity? = null
        var connection: SocketClient? = null
        val gate = CountDownLatch(1)
        val checks = JSONArray()
        try {
            check(targetContext.packageName.endsWith(".scrollprobe"))
            GoV2Ids.context = targetContext.applicationContext
            activity = startActivitySync(Intent().setClassName(targetContext.packageName, MainActivity::class.java.name).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
            val host = activity
            fun field(name: String) = MainActivity::class.java.getDeclaredField(name).apply { isAccessible = true }
            fun get(name: String) = ChatProbeAccess.get(host, name)
            fun set(name: String, value: Any?) = ChatProbeAccess.set(host, name, value)
            fun ui(action: () -> Unit) {
                var failure: Throwable? = null
                runOnMainSync { try { action() } catch (error: Throwable) { failure = error } }
                failure?.let { throw it }
            }
            fun invoke(name: String, vararg args: Any?) {
                MainActivity::class.java.declaredMethods.single { it.name == name && it.parameterCount == args.size }.apply { isAccessible = true }.invoke(host, *args)
            }
            fun until(condition: () -> Boolean) {
                val deadline = SystemClock.uptimeMillis() + 6000
                while (SystemClock.uptimeMillis() < deadline) {
                    waitForIdleSync(); var ready = false; ui { ready = condition() }; if (ready) return; SystemClock.sleep(40)
                }
                error("Chat switch did not paint")
            }
            val base = get("apiBaseUrl") as String
            check(base.startsWith("http://127.0.0.1:9/"))
            val token = "isolated-chat-switch"
            val viewer = GoV2Ids.local(base, "user", UUID.randomUUID().toString())
            val scope = LocalChatStore.scope(base, viewer, token)
            val cache = get("chatSwitchCache") as ChatSwitchCache
            val photoURL = "http://127.0.0.1:9/switch-photo.png"
            ChatImageCache.seedPreview(base + "|" + token, photoURL, Bitmap.createBitmap(120, 90, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.BLUE) })
            fun cid() = GoV2Ids.local(base, "conversation", UUID.randomUUID().toString())
            fun info(id: Int, kind: String) = JSONObject().put("id", id).put("type", kind).put("name", "切换测试")
                .put("membership_version", "1").put("can_send", true).put("can_publish", true).put("cleared_before_message_id", 0).put("member_count", 2)
            fun page(id: Int) = ChatHistoryPage((1..20).map { seq -> JSONObject().put("id", seq).put("conversation_id", id)
                .put("sender_id", viewer).put("type", "text").put("status", "sent").put("created_at", "2026-11-17T00:00:00Z")
                .put("_go_version", "1".padStart(20, '0')).apply {
                    if (seq == 20) put("type", "image").put("body", JSONObject().put("url", photoURL).put("width", 120).put("height", 90))
                    else put("body", JSONObject().put("text", "已看过的消息 $seq"))
                } }, false, 0, "1", 0)
            fun seed(id: Int, kind: String) {
                GoV2Ids.membership(base, viewer, id, "1", token)
                cache.bind(scope, 7); check(cache.remember(cache.ticket(id), info(id, kind), page(id)))
            }
            fun entry() = get("pendingChatEntry")!!
            @Suppress("UNCHECKED_CAST") fun <T> future(entry: Any, name: String) = entry.javaClass.getDeclaredField(name).apply { isAccessible = true }.get(entry) as CompletableFuture<T>
            fun open(id: Int, kind: String) = ui { invoke("openExistingChat", id, info(id, kind)) }
            fun authorize(entry: Any, value: JSONObject) = ui { if (get("pendingChatEntry") === entry) set("pendingChatEntry", null); future<JSONObject>(entry, "authorization").complete(value) }
            repeat(2) { (get("chatLoadExecutor") as ExecutorService).execute { gate.await(40, TimeUnit.SECONDS) } }
            connection = SocketClient("ws://127.0.0.1:9/api/v2/realtime", token, { _, _ -> }, { _, _ -> })
            val state = SocketClient::class.java.getDeclaredField("state").apply { isAccessible = true }.get(connection) as RealtimeConnectionState
            check(state.authenticate(state.begin()!!))
            SocketClient::class.java.getDeclaredField("epoch").apply { isAccessible = true }.set(connection, 1)
            ui {
                (get("api") as ApiClient).token = token; set("currentUserId", viewer); set("socket", connection); set("chatSocketEpoch", 7)
            }
            for (kind in listOf("direct", "group")) {
                val id = cid(); val archiveCall = ApiRequestScope()
                ui {
                    seed(id, kind); LocalChatArchive.bind(scope)
                    LocalChatArchive::class.java.getDeclaredField("calls").apply { isAccessible = true }.set(LocalChatArchive, archiveCall)
                }
                open(id, kind); check(archiveCall.cancelled)
                checks.put("$kind: navigation cancels older background archive transfers before starting foreground reads")
                val opening = entry()
                lateinit var messages: LinearLayout
                lateinit var input: EditText
                ui {
                    messages = get("currentMessages") as LinearLayout; input = host.findViewById(R.id.chat_message_input)
                    check(get("activeConversationId") == id && host.findViewById<View>(R.id.chat_opening) == null)
                    check(host.findViewById<View>(R.id.chat_input_dock) != null && input.isEnabled && get("chatCanSend") == false)
                    input.setText("切换时保留草稿")
                }
                checks.put("$kind: chat frame and editable draft appear before any network response; sending remains gated")
                until { messages.findViewWithTag<View>(20) != null }
                SystemClock.sleep(250); waitForIdleSync()
                lateinit var retained: View
                ui {
                    retained = messages.findViewWithTag(20)
                    check(!future<ChatHistoryPage>(opening, "page").isDone && !future<JSONObject>(opening, "authorization").isDone)
                    check(host.findViewById<View>(R.id.chat_history_loading).visibility == View.GONE)
                }
                checks.put("$kind: recently authorized messages show while open and history requests are blocked, without a central spinner")
                fun photoPainted(view: View): Boolean = (view is ImageView && (view.drawable as? BitmapDrawable)?.bitmap?.let {
                    it.width == 120 && it.height == 90 && it.getPixel(60, 45) == Color.BLUE
                } == true) || (view is ViewGroup && (0 until view.childCount).any { photoPainted(view.getChildAt(it)) })
                ui { check(photoPainted(retained)) }
                checks.put("$kind: the warm image uses the existing bitmap before any media request completes")
                uiAutomation.takeScreenshot()?.let { bitmap -> File(targetContext.filesDir, "switch-$kind-warm.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle() }
                authorize(opening, info(id, kind))
                ui {
                    check(get("chatCanSend") == true && get("currentMessages") === messages)
                    check(input.text.toString() == "切换时保留草稿" && messages.findViewWithTag<View>(20) === retained)
                }
                checks.put("$kind: fresh authorization updates the existing frame without rebuilding rows or draft")
                val fresh = page(id).copy(items = page(id).items.filter { it.optInt("id") != 18 }.map { row ->
                    if (row.optInt("id") == 19) JSONObject(row.toString()).put("_go_version", "2".padStart(20, '0')).put("body", JSONObject().put("text", "服务器更新后的消息")) else row
                })
                future<ChatHistoryPage>(opening, "page").complete(fresh)
                until { get("chatHistoryReady") == true }
                ui {
                    check(messages === get("currentMessages") && messages.findViewWithTag<View>(20) === retained)
                    check(messages.findViewWithTag<View>(18) == null)
                    @Suppress("UNCHECKED_CAST") val data = get("currentMessageData") as Map<Int, JSONObject>
                    check(data[19]?.getJSONObject("body")?.getString("text") == "服务器更新后的消息")
                }
                checks.put("$kind: authoritative history removes deleted cached rows and updates edits while retaining unchanged rows")
                ui { check(get("chatSynchronizedEpoch") == 7) }
                checks.put("$kind: a clean first history page does not start a duplicate catch-up sync")
                ui {
                    invoke("handlePacket", JSONObject().put("type", "go.changed").put("change_type", "state.changed").put("conversation_id", id))
                    check(cache.read(cache.ticket(id), info(id, kind), true) != null)
                    invoke("handlePacket", JSONObject().put("type", "go.changed").put("change_type", "personal.changed").put("conversation_id", id))
                    check(cache.read(cache.ticket(id), info(id, kind), true) != null)
                }
                checks.put("$kind: read-state and personal-history hints retain records for incremental reconciliation")
                val cold = cid(); GoV2Ids.membership(base, viewer, cold, "1", token); open(cold, kind)
                val coldEntry = entry()
                ui {
                    check(get("activeConversationId") == cold && host.findViewById<View>(R.id.chat_opening) == null)
                    check(host.findViewById<View>(R.id.chat_message_input) != null && get("chatCanSend") == false)
                }
                checks.put("$kind: a first visit enters the chat frame before membership and history complete")
                future<ChatHistoryPage>(coldEntry, "preview").complete(page(cold))
                until { (get("currentMessages") as? LinearLayout)?.findViewWithTag<View>(20) != null }
                ui { check(!future<JSONObject>(coldEntry, "authorization").isDone && get("chatCanSend") == false) }
                checks.put("$kind: fresh authorized history can paint independently of the slower open request")
                authorize(coldEntry, info(cold, kind).put("can_send", false).put("send_disabled_reason", "group_muted"))
                ui { check(get("chatCanSend") == false && !host.findViewById<EditText>(R.id.chat_message_input).isEnabled) }
                checks.put("$kind: a fresh mute takes effect before any send becomes possible")
                ui { invoke("handlePacket", JSONObject().put("type", "go.changed").put("change_type", "conversation.changed").put("conversation_id", cold)) }
                future<ChatHistoryPage>(coldEntry, "page").complete(page(cold))
                until { get("chatHistoryReady") == true }
                ui { check(get("chatSynchronizedEpoch") != 7) }
                checks.put("$kind: a message hint during first loading retains the follow-up sync")
            }
            val offline = cid(); ui { seed(offline, "group") }; open(offline, "group"); val interrupted = entry()
            until { (get("currentMessages") as? LinearLayout)?.findViewWithTag<View>(20) != null }
            lateinit var kept: LinearLayout
            ui {
                kept = get("currentMessages") as LinearLayout
                host.findViewById<EditText>(R.id.chat_message_input).setText("网络慢时保留草稿")
                future<JSONObject>(interrupted, "authorization").completeExceptionally(java.io.IOException("held network failed"))
            }
            ui {
                check(get("currentMessages") === kept && kept.findViewWithTag<View>(20) != null)
                check(get("chatCanSend") == false && host.findViewById<EditText>(R.id.chat_message_input).text.toString() == "网络慢时保留草稿")
                check(host.findViewById<View>(R.id.chat_history_error).visibility == View.VISIBLE)
            }
            checks.put("a transient open failure retains visible history and the draft while keeping sending gated")
            val a = cid(); val b = cid(); ui { seed(a, "group"); seed(b, "group") }
            open(a, "group"); val old = entry(); open(b, "group"); val newest = entry()
            until { (get("currentMessages") as? LinearLayout)?.findViewWithTag<View>(20) != null }
            check(!future<JSONObject>(old, "authorization").complete(info(a, "group")))
            ui { check(get("activeConversationId") == b && entry() === newest) }
            checks.put("rapid A-to-B navigation ignores the cancelled A response")
            ui { future<JSONObject>(newest, "authorization").completeExceptionally(ClientApiException(403, "forbidden", "denied")) }
            ui { check(get("activeConversationId") != b && cache.read(cache.ticket(b), info(b, "group"), true) == null) }
            checks.put("a fresh 403 closes the restored chat and invalidates its snapshot")
            var clock = 100L
            val isolated = ChatSwitchCache { clock }; isolated.bind("account-a", 1)
            fun remember(id: Int) = isolated.remember(isolated.ticket(id), info(id, "group"), page(id))
            check(remember(a)); check(isolated.read(isolated.ticket(a), info(a, "group"), false) != null)
            checks.put("disconnected sessions retain existing local records; fresh authorization still gates sending")
            val stale = isolated.ticket(a); isolated.invalidate(a); check(!isolated.remember(stale, info(a, "group"), page(a)))
            checks.put("an in-flight stale page cannot repopulate an invalidated snapshot")
            check(remember(a)); check(isolated.read(isolated.ticket(a), info(a, "group").put("membership_version", "2"), true) == null)
            checks.put("a newer directory membership version rejects the old snapshot")
            check(remember(a)); check(isolated.read(isolated.ticket(a), info(a, "group").put("cleared_before_message_id", 10), true)!!.page.items.all { it.optInt("id") > 10 })
            checks.put("a newer clear-history boundary removes only the affected cached records")
            check(remember(a)); clock += 120001; check(isolated.read(isolated.ticket(a), info(a, "group"), true) != null)
            checks.put("existing records remain available beyond two minutes without caching send permissions")
            check(remember(a)); isolated.bind("account-b", 1); check(isolated.read(isolated.ticket(a), null, true) == null)
            checks.put("switching accounts clears all warm snapshots")
            check(remember(a)); isolated.bind("account-b", 2); check(isolated.read(isolated.ticket(a), null, true) != null)
            checks.put("reconnecting retains records and requires background permission checks and cursor catch-up")
            for (id in 100..108) check(remember(id))
            check(isolated.read(isolated.ticket(100), info(100, "group"), true) == null)
            checks.put("the navigation cache bounds its conversation count")
            val report = JSONObject().put("passed", checks.length()).put("checks", checks)
            File(targetContext.filesDir, "chat-switch-results.json").writeText(report.toString(2))
            finish(Activity.RESULT_OK, Bundle().apply { putString("checks", report.toString()) })
        } catch (error: Throwable) { finish(Activity.RESULT_CANCELED, Bundle().apply { putString("error", error.stackTraceToString()) }) }
        finally { activity?.let { runOnMainSync { it.finish() } }; connection?.close(); gate.countDown() }
    }
}

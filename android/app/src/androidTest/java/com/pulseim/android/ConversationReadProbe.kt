package com.pulseim.android

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.graphics.Bitmap
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** Read/mention races, actual adapter, retained list and encrypted directory; no live account. */
class ConversationReadProbe : Instrumentation() {
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); start() }
    override fun onStart() {
        var activity: MainActivity? = null
        val checks = JSONArray()
        try {
            check(targetContext.packageName.endsWith(".scrollprobe"))
            GoV2Ids.context = targetContext.applicationContext
            activity = startActivitySync(Intent().setClassName(targetContext.packageName, MainActivity::class.java.name).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
            val host = activity
            fun get(name: String) = MainActivity::class.java.getDeclaredField(name).apply { isAccessible = true }.get(host)
            fun set(name: String, value: Any?) = MainActivity::class.java.getDeclaredField(name).apply { isAccessible = true }.set(host, value)
            fun invoke(name: String, vararg args: Any?) = MainActivity::class.java.declaredMethods.single { it.name == name && it.parameterCount == args.size }.apply { isAccessible = true }.invoke(host, *args)
            fun ui(action: () -> Unit) { var failure: Throwable? = null; runOnMainSync { try { action() } catch (e: Throwable) { failure = e } }; failure?.let { throw it } }
            fun passed(name: String) { checks.put(name) }
            val base = get("apiBaseUrl") as String; check(base.startsWith("http://127.0.0.1:9/"))
            val token = "isolated-read-probe"; val viewerWire = UUID.randomUUID().toString(); val room = UUID.randomUUID().toString()
            val viewer = GoV2Ids.local(base, "user", viewerWire); val cid = GoV2Ids.local(base, "conversation", room)
            fun row(latest: Int = 20, mention: Int = 18, version: Long = 4, reminder: Boolean = false) = JSONObject()
                .put("id", cid).put("type", "group").put("name", "已读同步测试群").put("unread_count", 4)
                .put("unread_mention_count", 2).put("last_mention_message_id", mention)
                .put("last_message", JSONObject().put("id", latest).put("sender_id", viewer + 1).put("type", "text").put("body", JSONObject().put("text", "测试消息")).put("created_at", "2026-11-17 12:58:00"))
                .put("state", JSONObject().put("version", "$version").put("reminder", reminder))
            fun cleared(row: JSONObject) = row.getInt("unread_count") == 0 && row.getInt("unread_mention_count") == 0 && row.getInt("last_mention_message_id") == 0
            val reads = ConversationReadState().apply { bind(viewer, token, base) }
            check(reads.record(cid, 20)); check(row().also(reads::apply).let(::cleared)); passed("displayed messages clear both unread and mention indicators while a receipt is pending")
            val newer = row(22, 22).also(reads::apply)
            check(newer.getInt("unread_count") == 4 && newer.getInt("unread_mention_count") == 2); passed("a later message and mention remain unread beyond the displayed boundary")
            val plain = row(22, 18).also(reads::apply)
            check(plain.getInt("unread_count") == 4 && plain.getInt("unread_mention_count") == 0); passed("a read mention clears independently of a newer unread plain message")
            val failed = reads.next()!!; check(reads.finish(failed, false)); check(row().also(reads::apply).let(::cleared))
            val retry = reads.next()!!; check(retry.through == 20); passed("a failed read stays queued for a bounded retry without restoring old indicators")
            check(reads.finish(retry, true, 0, 5)); check(row().also(reads::apply).let(::cleared)); passed("a successful receipt protects a retained list after pending work has been removed")
            check(row(version = 3).also(reads::apply).let(::cleared)); passed("a late older server snapshot cannot resurrect acknowledged unread or mentions")
            check(row(version = 0).also(reads::apply).let(::cleared)); passed("a cached snapshot without state metadata also respects the confirmed boundary")
            val manual = row(20, 0, 6, true).put("unread_mention_count", 0).also(reads::apply)
            check(manual.getInt("unread_count") == 4); passed("a newer explicit unread reminder remains authoritative")
            check(row(22, 22, 6).also(reads::apply).getInt("unread_mention_count") == 2); passed("new mentions arriving after read confirmation are not erased")
            check(!reads.record(cid, 20)); check(reads.record(cid, 20, reopen = true)); val reopened = reads.next()!!
            check(reads.record(cid, 23)); check(reads.finish(reopened, true, 1, 7)); check(reads.next()!!.through == 23); passed("reopening and a message arriving during a receipt coalesce into a newer bounded request")
            reads.bind(viewer, "another-session", base); check(!reads.finish(reopened, true)); check(row().also(reads::apply).getInt("unread_count") == 4); passed("account/session changes discard pending and confirmed state")
            reads.bind(viewer, token, base); check(reads.record(cid, 20)); val other = reads.next()!!
            reads.bind(viewer, token, "http://127.0.0.1:9/other"); check(!reads.finish(other, true)); passed("endpoint changes reject a late acknowledgment")
            val race = ConversationReadState().apply { bind(viewer, token, base); record(cid, 20) }
            check(race.finish(race.next()!!, true, 1, 5)); check(row().also(race::apply).getInt("unread_count") == 1); passed("an authoritative nonzero count returned during a new-message race is preserved")

            val paths = mutableListOf<String>(); var reminder = false; var stateVersion = 5L
            val adapter = GoV2Api(base, { token }, { 1L }) { path, method, body, _ ->
                paths += path
                when {
                    path == "/me" -> JSONObject().put("user_id", viewerWire)
                    path.endsWith("/read") || path.endsWith("/delivered") -> {
                        check(method == "PUT" && body!!.getString("seq") == "20")
                        JSONObject().put("version", "$stateVersion").put("reminder", reminder)
                    }
                    path.endsWith("/reminder") -> { check(!body!!.getBoolean("reminder")); reminder = false; stateVersion++; JSONObject().put("version", "$stateVersion").put("reminder", false) }
                    path.endsWith("/unread") -> JSONObject().put("count", 0).put("truncated", false)
                    else -> error("Unexpected read fixture path $path")
                }
            }
            val client = ApiClient(base).apply { this.token = token }
            ApiClient::class.java.getDeclaredField("go\$delegate").apply { isAccessible = true }.set(client, lazyOf(adapter))
            val receipt = client.readConversation(cid, 20)
            check(receipt.getInt("through_message_id") == 20 && receipt.getString("state_version") == "5" && receipt.getInt("unread_count") == 0)
            check(paths.none { it.endsWith("/reminder") }); passed("normal reads carry the server state version without an extra reminder request")
            reminder = true
            check(client.readConversation(cid, 20).getString("state_version") == "6" && !reminder); passed("opening a manually unread conversation clears its server reminder")
            reminder = true; val beforeDelivered = paths.count { it.endsWith("/reminder") }
            adapter.request("/messages/receipt", "POST", JSONObject().put("conversation_id", cid).put("through_message_id", 20).put("status", "delivered"))
            check(reminder && paths.count { it.endsWith("/reminder") } == beforeDelivered); passed("a delivery acknowledgment does not clear a manual unread reminder")

            val scope = LocalAccountStore.scope(base, viewer)
            val chat = LocalDirectoryStore.Kind.CHATS; val groups = LocalDirectoryStore.Kind.GROUPS
            check(LocalDirectoryStore.replace(targetContext, LocalDirectoryStore.begin(scope, chat), chat, LocalDirectoryStore.Snapshot(listOf(row()), System.currentTimeMillis())))
            check(LocalDirectoryStore.replace(targetContext, LocalDirectoryStore.begin(scope, groups), groups, LocalDirectoryStore.Snapshot(listOf(row(22, 22)), System.currentTimeMillis())))
            val lateTicket = LocalDirectoryStore.begin(scope, chat)
            LocalDirectoryStore.markRead(targetContext, scope, cid, 20)
            check(LocalDirectoryStore.read(targetContext, scope, chat)!!.items.single().let(::cleared)); passed("the encrypted local directory stores cleared unread and mention fields together")
            check(LocalDirectoryStore.read(targetContext, scope, groups)!!.items.single().getInt("unread_mention_count") == 2); passed("disk updates retain newer unseen mentions and messages")
            check(!LocalDirectoryStore.replace(targetContext, lateTicket, chat, LocalDirectoryStore.Snapshot(listOf(row()), System.currentTimeMillis()))); passed("a directory download started before a read cannot overwrite its saved result")

            lateinit var home: ChatHomeView; lateinit var mainRequest: ConversationReadState.Request
            fun labels(node: View): List<String> = (if (node is TextView && node.visibility == View.VISIBLE) listOf(node.text.toString()) else emptyList()) +
                if (node is ViewGroup) (0 until node.childCount).flatMap { labels(node.getChildAt(it)) } else emptyList()
            ui {
                (get("api") as ApiClient).token = token; set("currentUserId", viewer); invoke("prepareHomeTabs")
                home = ChatHomeView(host, viewer, { it }, {}, {}, {}, {}, {}, {}, {}, {})
                home.restoreLocalSnapshot(JSONObject().put("items", JSONArray().put(row())).put("total", 1))
                set("retainedChatHome", home); set("chatHome", home); host.setContentView(home)
            }
            waitForIdleSync(); ui { check(labels(home).any { it.startsWith("有人@你") }) }
            android.os.SystemClock.sleep(250); waitForIdleSync()
            uiAutomation.takeScreenshot()?.let { bmp -> File(targetContext.filesDir, "read-before.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }; bmp.recycle() }
            val mainReads = get("conversationReads") as ConversationReadState
            ui {
                set("activeConversationId", cid); set("currentMessages", LinearLayout(host)); set("appForeground", true)
                invoke("markConversationRead", cid, 20, false)
                mainRequest = mainReads.next()!!
                set("activeConversationId", 0); set("currentMessages", null)
            }
            waitForIdleSync(); ui { check(labels(home).none { it.startsWith("有人@你") }); check(labels(home).none { it == "4" }) }
            passed("MainActivity immediately removes the red mention and unread badge from its retained chat list")
            reminder = false
            val confirmed = client.readConversation(cid, 20)
            ui {
                check(mainReads.finish(mainRequest, true, confirmed.getInt("unread_count"), confirmed.getString("state_version").toLong()))
                val stalePage = row().also(mainReads::apply)
                home.accept(JSONObject().put("items", JSONArray().put(stalePage)).put("total", 1).put("size", 50), 1, home.realtimeRevision)
            }
            waitForIdleSync(); ui { check(labels(home).none { it.startsWith("有人@你") || it == "4" }) }
            passed("a successful read followed by an older list response stays clear after leaving the chat")
            android.os.SystemClock.sleep(250); waitForIdleSync()
            uiAutomation.takeScreenshot()?.let { bmp -> File(targetContext.filesDir, "read-after.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }; bmp.recycle() }
            ui {
                val next = row(22, 22, 7).also(mainReads::apply)
                home.accept(JSONObject().put("items", JSONArray().put(next)).put("total", 1).put("size", 50), 1, home.realtimeRevision)
            }
            waitForIdleSync(); ui { check(labels(home).any { it.startsWith("有人@你") }) }; passed("a fresh mention after returning to the list displays its reminder again")
            val report = JSONObject().put("passed", checks.length()).put("checks", checks).put("paths", JSONArray(paths))
            File(targetContext.filesDir, "conversation-read-results.json").writeText(report.toString(2))
            finish(Activity.RESULT_OK, Bundle().apply { putString("checks", report.toString()) })
        } catch (error: Throwable) { finish(Activity.RESULT_CANCELED, Bundle().apply { putString("error", error.stackTraceToString()) }) }
        finally { activity?.let { runOnMainSync { it.finish() } } }
    }
}

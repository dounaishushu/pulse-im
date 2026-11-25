package com.pulseim.android

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
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

/** Actual chat renderer, incoming events, delayed ACK and local Send; no live API. */
class ChatReaderProbe : Instrumentation() {
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); start() }
    override fun onStart() {
        var activity: MainActivity? = null
        val gate = CountDownLatch(1); val checks = JSONArray()
        val diskGates = mutableListOf<CountDownLatch>()
        try {
            check(targetContext.packageName.endsWith(".scrollprobe"))
            GoV2Ids.context = targetContext.applicationContext
            activity = startActivitySync(Intent().setClassName(targetContext.packageName, MainActivity::class.java.name).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
            val host = activity
            fun get(name: String) = ChatProbeAccess.get(host, name)
            fun set(name: String, value: Any?) = ChatProbeAccess.set(host, name, value)
            fun invoke(name: String, vararg args: Any?) = MainActivity::class.java.declaredMethods.single { it.name == name && it.parameterCount == args.size }.apply { isAccessible = true }.invoke(host, *args)
            fun ui(action: () -> Unit) { var error: Throwable? = null; runOnMainSync { try { action() } catch (e: Throwable) { error = e } }; error?.let { throw it } }
            fun settle() { SystemClock.sleep(160); waitForIdleSync() }
            fun hold(worker: java.util.concurrent.Executor): CountDownLatch {
                val release = CountDownLatch(1); diskGates += release
                val entered = CountDownLatch(1)
                worker.execute { entered.countDown(); release.await(60, TimeUnit.SECONDS) }
                check(entered.await(8, TimeUnit.SECONDS))
                return release
            }
            fun until(label: String, predicate: () -> Boolean) {
                val start = SystemClock.uptimeMillis()
                while (SystemClock.uptimeMillis() - start < 5000) {
                    var done = false; ui { done = predicate() }; if (done) return
                    SystemClock.sleep(30)
                }
                error(label)
            }
            val base = get("apiBaseUrl") as String; check(base.startsWith("http://127.0.0.1:9/"))
            val token = "isolated-reader-probe"; val viewer = GoV2Ids.local(base, "user", UUID.randomUUID().toString())
            val peer = GoV2Ids.local(base, "user", UUID.randomUUID().toString())
            val storageHeld = CountDownLatch(1); diskGates += storageHeld
            val storageEntered = CountDownLatch(1)
            val storageFinished = CountDownLatch(1)
            ui {
                val scope = LocalAccountStore.scope(base, viewer)
                ChatDraftStore.disk.execute {
                    synchronized(LocalAccountStore::class.java) { storageEntered.countDown(); storageHeld.await(8, TimeUnit.SECONDS) }
                    storageFinished.countDown()
                }
                check(storageEntered.await(3, TimeUnit.SECONDS)) { "Storage fixture did not acquire its monitor" }
                try {
                    val ticket = LocalAccountStore.ticket(scope, "probe.authority")
                    check(LocalAccountStore.current(ticket)) { "New ticket not current" }
                    LocalAccountStore.invalidate(scope, "probe.authority")
                    check(!LocalAccountStore.current(ticket)) { "Invalidated ticket remained current" }
                    check(storageFinished.count == 1L) { "UI ticket depended on unfinished storage work" }
                } finally { storageHeld.countDown() }
            }
            check(storageFinished.await(5, TimeUnit.SECONDS))
            checks.put("storage generation checks do not wait for a blocked SQLite lane")
            for (worker in listOf("chatLoadExecutor", "textExecutor")) repeat(2) { (get(worker) as ExecutorService).execute { gate.await(90, TimeUnit.SECONDS) } }
            val mediaHeld = hold(AndroidOutboxStorage.mediaDisk)
            val archiveHeld = hold(LocalChatArchive.disk)
            for (kind in listOf("group", "direct")) {
                val cid = GoV2Ids.local(base, "conversation", UUID.randomUUID().toString())
                lateinit var messages: LinearLayout; lateinit var scroll: ScrollView; lateinit var input: EditText
                fun message(id: Int, mine: Boolean = false) = JSONObject().put("id",id).put("conversation_id",cid)
                    .put("sender_id",if(mine)viewer else peer).put("sender_name",if(mine)"自己" else "其他成员")
                    .put("type","text").put("body",JSONObject().put("text","历史消息 $id"))
                    .put("created_at","2026-11-17T00:00:00Z").put("version","1").put("message_seq","$id").put("event_seq","$id")
                fun touch(action: Int) { val event=MotionEvent.obtain(SystemClock.uptimeMillis(),SystemClock.uptimeMillis(),action,20f,100f,0); scroll.dispatchTouchEvent(event); event.recycle() }
                fun readEarlier() { ui { touch(MotionEvent.ACTION_DOWN); touch(MotionEvent.ACTION_MOVE); scroll.scrollTo(0,500); touch(MotionEvent.ACTION_UP) }; settle() }
                fun remains(label: String) { settle(); ui { check(scroll.scrollY==500) { "$kind $label: reader moved to ${scroll.scrollY}" } }; checks.put("$kind: $label") }
                fun bottom(label: String) { settle(); ui { check(messages.height-scroll.scrollY-scroll.height<=2) { "$kind $label: gap=${messages.height-scroll.scrollY-scroll.height}" } }; checks.put("$kind: $label") }
                val drafts = ChatDraftStore(host.applicationContext)
                val draftOwner = drafts.owner(base, viewer, cid)
                check(drafts.prepare(draftOwner, ChatDraft("磁盘里的旧草稿")).commit())
                val draftHeld = hold(ChatDraftStore.disk)
                ui {
                    (get("api") as ApiClient).token=token; set("currentUserId",viewer); set("currentNickname","阅读检查")
                    set("activeConversationId",cid); set("activeConversationType",kind); set("appForeground",true)
                    val body=LinearLayout(host).apply { orientation=LinearLayout.VERTICAL }; set("content",body); host.setContentView(body)
                    val info=JSONObject().put("id",cid).put("type",kind).put("name","阅读位置检查").put("member_count",3)
                        .put("can_send",true).put("my_role","member").put("membership_version","1")
                    GoV2Ids.membership(base,viewer,cid,"1",token)
                    invoke("loadHistory","阅读位置检查",info)
                    messages=get("currentMessages") as LinearLayout; scroll=host.findViewById(R.id.chat_message_scroll); input=host.findViewById(R.id.chat_message_input)
                    check(draftHeld.count == 1L && input.text.isEmpty())
                    input.setText("读盘时先输入的新草稿")
                    repeat(65) { invoke("addMessage",messages,message(it+1),"snapshot") }
                    set("chatHistoryReady",true)
                    invoke("postChatBottom",messages,scroll,true)
                }
                draftHeld.countDown()
                val diskFinished = CountDownLatch(1)
                ChatDraftStore.disk.execute { diskFinished.countDown() }
                check(diskFinished.await(5, TimeUnit.SECONDS))
                ui { check(input.text.toString() == "读盘时先输入的新草稿") }
                checks.put("$kind: opening remains interactive during a draft disk delay and late restore preserves new edits")
                bottom("initial history is visible at the newest message")
                ui { invoke("addMessage",messages,message(66),"event") }
                bottom("incoming events follow while already at the bottom")
                readEarlier()
                ui { invoke("addMessage",messages,message(67),"event") }
                remains("an incoming event appends without pulling down history")
                ui { repeat(12) { invoke("addMessage",messages,message(68+it),"event") } }
                remains("a burst of incoming events keeps the reader position")
                ui { invoke("addMessage",messages,message(80,true),"ack"); invoke("postChatBottom",messages,scroll,false) }
                remains("a delayed own-message ACK does not override a later reader gesture")
                ui { val last=messages.findViewWithTag<View>(80); last.minimumHeight=last.height+700; last.requestLayout() }
                remains("late media-sized row growth below the reader cannot restart following")
                ui { val button=host.findViewById<View>(R.id.chat_scroll_bottom); check(button.visibility==View.VISIBLE); check(button.performClick()) }
                bottom("the actual return-to-bottom button restores following")
                ui { invoke("addMessage",messages,message(81),"event") }
                bottom("new incoming messages follow after the explicit return")
                readEarlier()
                val textHeld = hold(AndroidOutboxStorage.textDisk)
                ui {
                    input.setText("从历史位置发送")
                    val send = host.findViewById<View>(R.id.chat_message_send)
                    check(send.performClick()); check(!send.isEnabled)
                    check(input.text.toString() == "从历史位置发送")
                    input.setText("保存期间可以继续输入")
                    check(input.text.toString() == "保存期间可以继续输入")
                }
                textHeld.countDown()
                until("text was blocked by the independent archive or media worker") {
                    (get("textSends") as? TextSendQueue)?.pending(token,viewer,base,cid)?.singleOrNull()?.text == "从历史位置发送" &&
                        host.findViewById<View>(R.id.chat_message_send).isEnabled
                }
                ui {
                    check(mediaHeld.count == 1L && archiveHeld.count == 1L && get("mediaOutbox") == null)
                    check(input.text.toString() == "保存期间可以继续输入")
                }
                checks.put("$kind: encrypted text save proceeds while the archive and media restore are blocked; new draft text survives")
                bottom("the actual Send button queues the text and reveals its pending row")
                readEarlier()
                ui { repeat(145) { invoke("addMessage",messages,message(82+it),"event") }; check(messages.findViewWithTag<View>(1)!=null) }
                remains("a busy group retains the visible history instead of trimming it away")
                ui { invoke("postChatBottom",messages,scroll,true); touch(MotionEvent.ACTION_DOWN); scroll.scrollTo(0,500); touch(MotionEvent.ACTION_UP) }
                remains("touching history cancels an already queued bottom scroll")
                ui { touch(MotionEvent.ACTION_DOWN); scroll.scrollTo(0,messages.height); touch(MotionEvent.ACTION_UP) }; settle()
                ui { invoke("addMessage",messages,message(227),"event") }
                bottom("manually scrolling all the way down resumes following")
            }
            val reports = File(host.noBackupFilesDir, "client-diagnostics-v2")
            val existingReports = reports.listFiles().orEmpty().map { it.name }.toSet()
            ui { SystemClock.sleep(7800) }
            val diagnosticDeadline = SystemClock.elapsedRealtime() + 5000
            var watchdogReport: JSONObject? = null
            while (watchdogReport == null && SystemClock.elapsedRealtime() < diagnosticDeadline) {
                watchdogReport = reports.listFiles().orEmpty().filter { it.name !in existingReports && it.extension == "json" }.mapNotNull {
                    runCatching { JSONObject(it.readText()).getJSONObject("payload").getJSONArray("incidents").optJSONObject(0) }.getOrNull()
                }.firstOrNull { it.optString("code") == "ANDROID_MAIN_STALL" }
                if (watchdogReport == null) SystemClock.sleep(40)
            }
            val samples = requireNotNull(watchdogReport).getJSONArray("samples")
            check(samples.length() in 2..3)
            check((0 until samples.length()).all { (samples.getJSONObject(it).optJSONArray("frames")?.length() ?: 0) > 0 })
            checks.put("a simulated main-thread stall records multiple bounded stack samples")
            val report=JSONObject().put("passed",checks.length()).put("checks",checks)
            File(targetContext.filesDir,"chat-reader-results.json").writeText(report.toString(2))
            finish(Activity.RESULT_OK,Bundle().apply { putString("checks",report.toString()) })
        } catch(error: Throwable) { finish(Activity.RESULT_CANCELED,Bundle().apply { putString("error",error.stackTraceToString()); putString("partial",checks.toString()) }) }
        finally { diskGates.forEach { it.countDown() }; gate.countDown(); activity?.let { runOnMainSync { it.finish() } } }
    }
}

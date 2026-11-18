package com.pulseim.android

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.os.Bundle
import android.os.Debug
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.MotionEvent
import android.view.View
import android.widget.LinearLayout
import android.widget.ScrollView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/** Runs the shipping chat renderer in a new, isolated package with no live API. */
class ChatRenderProbe : Instrumentation() {
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); start() }
    override fun onStart() {
        var host: MainActivity? = null
        val gate = CountDownLatch(1)
        val samples = JSONArray(); val checks = JSONArray()
        try {
            check(targetContext.packageName == "com.pulseim.android.renderfix.performanceprobe")
            GoV2Ids.context = targetContext.applicationContext
            host = startActivitySync(Intent().setClassName(targetContext.packageName, MainActivity::class.java.name).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
            val activity = host
            val fields = MainActivity::class.java.declaredFields.associateBy { it.name }.onEach { it.value.isAccessible = true }
            fun get(name: String) = fields.getValue(name).get(activity)
            fun set(name: String, value: Any?) = fields.getValue(name).set(activity, value)
            val add = MainActivity::class.java.declaredMethods.single { it.name == "addMessage" && it.parameterCount == 3 }.apply { isAccessible = true }
            val load = MainActivity::class.java.declaredMethods.single { it.name == "loadHistory" && it.parameterCount == 2 }.apply { isAccessible = true }
            val selection = MainActivity::class.java.declaredMethods.single { it.name == "renderMessageSelection" && it.parameterCount == 0 }.apply { isAccessible = true }
            fun ui(action: () -> Unit) {
                var failure: Throwable? = null
                runOnMainSync { try { action() } catch (error: Throwable) { failure = error } }
                failure?.let { throw it }
            }
            val base = get("apiBaseUrl") as String
            check(base == "http://127.0.0.1:9/api/v2")
            for ((name, size) in listOf("executor" to 1, "chatLoadExecutor" to 2, "textExecutor" to 2, "messageExecutor" to 2)) {
                repeat(size) { (get(name) as ExecutorService).execute { gate.await(180, TimeUnit.SECONDS) } }
            }
            val token = "isolated-performance-audit"
            val viewer = GoV2Ids.local(base, "user", UUID.randomUUID().toString())
            val peer = GoV2Ids.local(base, "user", UUID.randomUUID().toString())
            ui { set("lastRealtimeCatchUp", Long.MAX_VALUE); (get("api") as ApiClient).token = token; set("currentUserId", viewer); set("currentNickname", "性能检查"); set("appForeground", true) }
            for (kind in listOf("group", "direct")) {
                val cid = GoV2Ids.local(base, "conversation", UUID.randomUUID().toString())
                GoV2Ids.membership(base, viewer, cid, "1", token)
                val rows = (1..1100).associateWith { id -> JSONObject().put("id", id).put("conversation_id", cid)
                    .put("sender_id", if (id % 3 == 0) viewer else peer).put("sender_name", if (id % 3 == 0) "自己" else "其他成员")
                    .put("type", "text").put("body", JSONObject().put("text", "性能检查 $id " + "日常聊天内容 ".repeat(8)))
                    .put("created_at", "2026-11-18T00:00:00Z").put("status", "sent").put("_go_version", "1") }
                lateinit var messages: LinearLayout
                lateinit var scroll: ScrollView
                ui {
                    set("activeConversationId", cid); set("activeConversationType", kind)
                    val content = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
                    set("content", content); activity.setContentView(content)
                    val info = JSONObject().put("id", cid).put("type", kind).put("name", "性能检查").put("member_count", 3)
                        .put("can_send", true).put("my_role", "member").put("membership_version", "1")
                    load.invoke(activity, "性能检查", info)
                    messages = get("currentMessages") as LinearLayout
                    scroll = activity.findViewById(R.id.chat_message_scroll)
                    set("chatHistoryReady", true)
                }
                var count = 0
                for (target in listOf(50, 200, 500, 1000)) {
                    val fillStarted = SystemClock.elapsedRealtimeNanos()
                    ui { while (count < target) { count++; add.invoke(activity, messages, rows.getValue(count), "snapshot") } }
                    val fillMS = (SystemClock.elapsedRealtimeNanos() - fillStarted) / 1_000_000.0
                    waitForIdleSync()
                    // Exercise a real reader gesture: new messages must not trim this history.
                    ui {
                        val tracking = get("chatMessageScroll") as ChatMessageScroll
                        val event = MotionEvent.obtain(0, 0, MotionEvent.ACTION_DOWN, 10f, 10f, 0)
                        tracking.onTouch(event); event.recycle()
                        scroll.scrollTo(0, 0)
                    }
                    val delayed = CountDownLatch(1); val lag = AtomicLong(-1)
                    var batchMS = 0.0
                    ui {
                        val scheduled = SystemClock.uptimeMillis()
                        Handler(Looper.getMainLooper()).postDelayed({ lag.set(SystemClock.uptimeMillis() - scheduled - 16); delayed.countDown() }, 16)
                        val started = SystemClock.elapsedRealtimeNanos()
                        repeat(50) { count++; add.invoke(activity, messages, rows.getValue(count), "snapshot") }
                        batchMS = (SystemClock.elapsedRealtimeNanos() - started) / 1_000_000.0
                    }
                    check(delayed.await(15, TimeUnit.SECONDS)); waitForIdleSync()
                    var selectionMS = 0.0
                    ui { val start = SystemClock.elapsedRealtimeNanos(); selection.invoke(activity); selectionMS = (SystemClock.elapsedRealtimeNanos() - start) / 1_000_000.0 }
                    var incomingMS = 0.0
                    ui { val start = SystemClock.elapsedRealtimeNanos(); count++; add.invoke(activity, messages, rows.getValue(count), "event"); incomingMS = (SystemClock.elapsedRealtimeNanos() - start) / 1_000_000.0 }
                    waitForIdleSync()
                    var retained = 0
                    ui { retained = (get("currentMessageData") as Map<*, *>).size }
                    check(retained == count) { "History was unexpectedly trimmed: $retained / $count" }
                    val runtime = Runtime.getRuntime()
                    val sample = JSONObject().put("kind", kind).put("retained_before_batch", target).put("retained_after", retained)
                        .put("fill_ms", fillMS).put("append_50_main_ms", batchMS).put("main_callback_late_ms", lag.get())
                        .put("selection_scan_ms", selectionMS).put("one_incoming_main_ms", incomingMS)
                        .put("heap_mb", (runtime.totalMemory() - runtime.freeMemory()) / 1048576.0).put("pss_mb", Debug.getPss() / 1024.0)
                    samples.put(sample); Log.i("PulsePerf", sample.toString())
                    File(targetContext.filesDir, "mobile-performance-partial.json").writeText(samples.toString(2))
                }
                fun invoke(name: String, vararg args: Any?) = MainActivity::class.java.declaredMethods.single { it.name == name && it.parameterCount == args.size }.apply { isAccessible = true }.invoke(activity, *args)
                fun extra(id: Int) = JSONObject(rows.getValue(20).toString()).put("id", id)
                ui {
                    val old = messages.findViewWithTag<SelectableMessageRow>(20)
                    val oldCheckBackground = old.getChildAt(1).background
                    add.invoke(activity, messages, extra(2000), "snapshot")
                    add.invoke(activity, messages, extra(1500), "snapshot")
                    val ids = (0 until messages.childCount).mapNotNull { (messages.getChildAt(it).tag as? Int)?.takeIf { id -> id > 0 } }
                    check(ids == ids.distinct().sorted()); checks.put("$kind: out-of-order rows remain sorted without duplicates")
                    check(old.getChildAt(1).background === oldCheckBackground); checks.put("$kind: appending rows does not repaint older selection controls")
                    invoke("toggleMessageSelection", 20)
                    check(20 in (get("selectedMessageIds") as Set<*>))
                    check(old.getChildAt(1).visibility == View.VISIBLE)
                    val selectedBackground = old.getChildAt(1).background
                    add.invoke(activity, messages, extra(2100), "snapshot")
                    check(messages.findViewWithTag<SelectableMessageRow>(2100).getChildAt(1).visibility == View.VISIBLE)
                    check(old.getChildAt(1).background === selectedBackground)
                    invoke("toggleMessageSelection", 1500)
                    check((get("selectedMessageIds") as Set<*>).size == 2)
                    check(old.getChildAt(1).background === selectedBackground); checks.put("$kind: selection survives incoming rows without repainting unchanged rows")
                    val edited = extra(20).put("_go_version", "2").put("body", JSONObject().put("text", "修改后的内容"))
                    add.invoke(activity, messages, edited, "snapshot")
                    val replaced = messages.findViewWithTag<SelectableMessageRow>(20)
                    check(replaced !== old && replaced.contentDescription.toString().contains("已选择") && replaced.contentDescription.toString().contains("修改后的内容"))
                    invoke("applyDeltaMessageEvent", "message.deleted", extra(1500).put("_go_version", "2").put("status", "deleted"), true)
                    check(messages.findViewWithTag<View>(1500) == null)
                    check((get("selectedMessageIds") as Set<*>) == setOf(20)); checks.put("$kind: edits and deletions update selected rows and selected IDs")
                    invoke("clearMessageSelection")
                    for (i in 0 until messages.childCount) (messages.getChildAt(i) as? SelectableMessageRow)?.let { row ->
                        check(row.getChildAt(1).visibility == View.GONE)
                        check((row.getChildAt(0).layoutParams as android.widget.FrameLayout.LayoutParams).leftMargin == 0)
                    }
                    check((get("selectedMessageIds") as Set<*>).isEmpty()); checks.put("$kind: cancelling selection restores all rows and margins")
                }
                waitForIdleSync()
                ui {
                    val row = messages.findViewWithTag<SelectableMessageRow>(20)
                    check(!row.isLayoutRequested)
                    row.update(false, false, "ignored while selection is inactive")
                    check(!row.isLayoutRequested); checks.put("$kind: unchanged inactive selection state does not request layout")
                }
            }
            val report = JSONObject().put("behavior_checks", checks).put("samples", samples).put("source", "shipping MainActivity.addMessage + actual views")
                .put("environment", "isolated Android emulator; not physical-device or production-load measurements")
                .put("api", "http://127.0.0.1:9/api/v2")
            File(targetContext.filesDir, "mobile-performance-results.json").writeText(report.toString(2))
            finish(Activity.RESULT_OK, Bundle().apply { putString("performance", report.toString()) })
        } catch (error: Throwable) {
            finish(Activity.RESULT_CANCELED, Bundle().apply { putString("error", error.stackTraceToString()); putString("partial", samples.toString()) })
        } finally { gate.countDown(); host?.let { runOnMainSync { it.finish() } } }
    }
}

package com.pulseim.android

import android.app.Activity
import android.app.Application
import android.app.Instrumentation
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.View
import android.widget.EditText
import android.widget.LinearLayout
import kotlinx.coroutines.Job
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Runs only in an isolated, closed-endpoint APK, including real lifecycle transitions. */
class ChatStateProbe : Instrumentation() {
    private lateinit var host: MainActivity
    private val checks = JSONArray()
    private val handler = Handler(Looper.getMainLooper())
    private fun get(name: String) = ChatProbeAccess.get(host, name)
    private fun set(name: String, value: Any?) = ChatProbeAccess.set(host, name, value)
    private fun invoke(name: String, vararg values: Any?) = MainActivity::class.java.declaredMethods
        .single { it.name == name && it.parameterCount == values.size }.apply { isAccessible = true }.invoke(host, *values)
    private fun ui(action: () -> Unit) {
        var failure: Throwable? = null
        runOnMainSync { try { action() } catch (error: Throwable) { failure = error } }
        failure?.let { throw it }
    }
    private fun await(label: String, condition: () -> Boolean) {
        val done = CountDownLatch(1); var failure: Throwable? = null
        val deadline = SystemClock.uptimeMillis() + 12_000
        handler.post(object : Runnable {
            override fun run() {
                try {
                    if (condition()) { done.countDown(); return }
                    check(SystemClock.uptimeMillis() < deadline) { "Timed out: $label" }
                    handler.postDelayed(this, 16)
                } catch (error: Throwable) { failure = error; done.countDown() }
            }
        })
        check(done.await(15, TimeUnit.SECONDS)) { label }; failure?.let { throw it }; waitForIdleSync()
    }
    private fun record(value: String) {
        checks.put(value)
        File(targetContext.filesDir, "p2-state-checks.json").writeText(checks.toString(2))
    }
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); start() }
    override fun onStart() {
        val gate = CountDownLatch(1)
        val released = CountDownLatch(7)
        var cover: Activity? = null
        var callbacks: Application.ActivityLifecycleCallbacks? = null
        try {
            check(targetContext.packageName.startsWith("com.pulseim.android.chatp1."))
            check(targetContext.getString(R.string.pulse_api_base_url) == "http://127.0.0.1:9/api/v2")
            GoV2Ids.context = targetContext.applicationContext
            host = startActivitySync(Intent().setClassName(targetContext.packageName, MainActivity::class.java.name)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
            for ((name, count) in listOf("executor" to 1, "chatLoadExecutor" to 2, "textExecutor" to 2, "messageExecutor" to 2))
                repeat(count) { (get(name) as ExecutorService).execute { gate.await(300, TimeUnit.SECONDS); released.countDown() } }
            val base = get("apiBaseUrl") as String
            val token = "isolated-p2-state"
            val viewer = GoV2Ids.local(base, "user", UUID.nameUUIDFromBytes("p2-viewer".toByteArray()).toString())
            val peer = GoV2Ids.local(base, "user", UUID.nameUUIDFromBytes("p2-peer".toByteArray()).toString())
            val cid = GoV2Ids.local(base, "conversation", UUID.nameUUIDFromBytes("p2-group".toByteArray()).toString())
            val other = GoV2Ids.local(base, "conversation", UUID.nameUUIDFromBytes("p2-other".toByteArray()).toString())
            GoV2Ids.membership(base, viewer, cid, "1", token)
            lateinit var messages: LinearLayout
            lateinit var model: ChatViewModel
            ui {
                (get("messageHandler") as Handler).removeCallbacks(get("foregroundMessageCheck") as Runnable)
                (get("api") as ApiClient).token = token; set("currentUserId", viewer); set("currentNickname", "自己")
                set("activeConversationId", cid); set("activeConversationType", "group")
                set("lastRealtimeCatchUp", Long.MAX_VALUE); set("appForeground", true)
                val content = LinearLayout(host).apply { orientation = LinearLayout.VERTICAL }
                set("content", content); host.setContentView(content)
                invoke("loadHistory", "P2 状态检查", JSONObject().put("id", cid).put("type", "group").put("name", "P2 状态检查")
                    .put("can_send", true).put("my_role", "member").put("membership_version", "1"))
                messages = get("currentMessages") as LinearLayout
                model = get("chatViewModel") as ChatViewModel
                set("chatHistoryReady", true); set("goChatRevalidate", false); set("goChatInvalidated", false)
                for (id in 1..200) invoke("addMessage", messages, JSONObject().put("id", id).put("conversation_id", cid)
                    .put("sender_id", peer).put("sender_name", "群成员").put("type", "text").put("_go_version", "1")
                    .put("body", JSONObject().put("text", "状态消息 $id")).put("status", "sent"), "snapshot")
            }
            await("initial permission") { host.findViewById<EditText>(R.id.chat_message_input)?.isEnabled == true }
            check(model.uiState.value.messages.size == 200)
            check(model.uiState.value.messages.last().snapshot.contains("状态消息 200"))
            record("200 live message snapshots are owned by the ViewModel; UI and state permission agree")

            val ticket = model.ticket()!!
            ui { invoke("applyChatSendPermission", ChatSendPermission(false, "member_muted")) }
            await("mute rendered") { host.findViewById<EditText>(R.id.chat_message_input)?.isEnabled == false }
            check(!model.uiState.value.canSend)
            check(host.findViewById<EditText>(R.id.chat_message_input).hint.toString() == "已禁止发言")
            ui { invoke("applyChatSendPermission", ChatSendPermission(true)) }
            await("permission restored") { host.findViewById<EditText>(R.id.chat_message_input)?.isEnabled == true }
            record("permission changes are published through StateFlow and update the existing composer")

            ui {
                var loading by model.loadingOlder(ticket); var more by model.hasMoreOlder(ticket)
                loading = true; more = false
                check(model.uiState.value.loadingOlder && !model.uiState.value.hasMoreOlder)
                loading = false; more = true
                val queue = TextSendQueue()
                queue.enqueue(token, viewer, base, cid, "待发状态", 0)
                set("textSends", queue); invoke("renderPendingTextMessages", messages)
                check(model.uiState.value.outbox.single().phase == "QUEUED")
                set("textSends", null); invoke("renderPendingTextMessages", messages)
                check(model.uiState.value.outbox.isEmpty())
            }
            record("pagination delegates and pending-text snapshots update the same conversation state")

            cover = startActivitySync(Intent().setClassName(targetContext.packageName, ChatProbeCoverActivity::class.java.name)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            await("main observer stopped") { (get("chatStateJob") as? Job)?.isActive != true }
            val before = host.findViewById<EditText>(R.id.chat_message_input).hint.toString()
            model.permission(ticket, false, "member_muted")
            ui { check(host.findViewById<EditText>(R.id.chat_message_input).hint.toString() == before) }
            record("real Activity stop cancels collection; background state mutation does not touch the view")
            ui { cover!!.finish() }; cover = null
            await("latest state replayed on start") {
                (get("chatStateJob") as? Job)?.isActive == true &&
                    host.findViewById<EditText>(R.id.chat_message_input)?.isEnabled == false
            }
            record("real Activity restart subscribes again and renders the latest permission")

            ui {
                model.open(ticket.account, other); model.open(ticket.account, cid)
                check(!model.permission(ticket, true, "stale"))
                check(model.uiState.value.messages.isEmpty() && model.uiState.value.outbox.isEmpty())
                var staleLoading by model.loadingOlder(ticket); staleLoading = true
                check(!model.uiState.value.loadingOlder)
            }
            record("switching A to B to A rejects old permission/history callbacks and clears private rows")

            val previous = host
            val recreated = AtomicReference<MainActivity?>()
            callbacks = object : Application.ActivityLifecycleCallbacks {
                override fun onActivityCreated(activity: Activity, state: Bundle?) { if (activity is MainActivity && activity !== previous) recreated.set(activity) }
                override fun onActivityStarted(activity: Activity) = Unit
                override fun onActivityResumed(activity: Activity) = Unit
                override fun onActivityPaused(activity: Activity) = Unit
                override fun onActivityStopped(activity: Activity) = Unit
                override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) = Unit
                override fun onActivityDestroyed(activity: Activity) = Unit
            }
            gate.countDown()
            check(released.await(5, TimeUnit.SECONDS)) { "Test workers did not release before Activity recreation" }
            ui { host.application.registerActivityLifecycleCallbacks(callbacks!!); host.recreate() }
            await("Activity recreated") { recreated.get()?.let { it.hasWindowFocus() && !it.isDestroyed } == true }
            host = recreated.get()!!
            check(get("chatViewModel") === model)
            check(previous.isDestroyed)
            record("real Activity recreation retains the same framework ViewModelStore and ViewModel")
            gate.countDown()
            ui { host.finish() }
            await("Activity destroyed") { host.isDestroyed }
            check(model.ticket() == null && model.open(ticket.account, cid) == null)
            record("permanent Activity destruction clears the ViewModel and rejects late work")
            val report = JSONObject().put("checks", checks).put("chat_v2", BuildConfig.CHAT_V2).put("passed", true)
            File(targetContext.filesDir, "p2-state-result.json").writeText(report.toString(2))
            finish(Activity.RESULT_OK, Bundle().apply { putString("report", report.toString()) })
        } catch (error: Throwable) {
            val report = JSONObject().put("checks", checks).put("passed", false).put("error", error.stackTraceToString())
            File(targetContext.filesDir, "p2-state-result.json").writeText(report.toString(2))
            finish(Activity.RESULT_CANCELED, Bundle().apply { putString("error", report.toString()) })
        } finally {
            gate.countDown()
            released.await(5, TimeUnit.SECONDS)
            if (::host.isInitialized) ui {
                callbacks?.let { host.application.unregisterActivityLifecycleCallbacks(it) }
                cover?.finish(); if (!host.isDestroyed) host.finish()
            }
        }
    }
}

/** Visible test-only cover, declared only in the copied debug test manifest. */
class ChatProbeCoverActivity : Activity() {
    override fun onCreate(state: Bundle?) { super.onCreate(state); setContentView(View(this)) }
}

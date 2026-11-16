package com.pulseim.android

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject

/** Real lifecycle/hint handlers, isolated application ID and unreachable local API. */
class ChatRefreshProbe : Instrumentation() {
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); start() }
    override fun onStart() {
        var activity: MainActivity? = null
        val checks = JSONArray()
        try {
            check(targetContext.packageName.endsWith(".scrollprobe")) { "Requires isolated application ID" }
            activity = startActivitySync(Intent().setClassName(targetContext.packageName, MainActivity::class.java.name).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
            val host = activity
            fun field(name: String) = MainActivity::class.java.getDeclaredField(name).apply { isAccessible = true }
            fun get(name: String): Any? = field(name).get(host)
            fun set(name: String, value: Any?) = field(name).set(host, value)
            fun ui(action: () -> Unit) = runOnMainSync(action)
            fun settle() { waitForIdleSync(); SystemClock.sleep(150); waitForIdleSync() }
            val client = get("api") as ApiClient
            check((get("apiBaseUrl") as String).startsWith("http://127.0.0.1:9/")) { "Requires local-only probe API" }
            for (kind in listOf("direct", "group")) {
                lateinit var messages: LinearLayout
                lateinit var message: TextView
                lateinit var input: EditText
                ui {
                    client.token = "isolated-refresh-probe"
                    set("currentUserId", 1); set("activeConversationId", if (kind == "direct") 1 else 2)
                    set("activeConversationType", kind); set("chatHistoryReady", true); set("goChatInvalidated", false)
                    set("goMembershipVersion", "1"); set("chatCanSend", true)
                    val root = LinearLayout(host).apply { orientation = LinearLayout.VERTICAL }
                    messages = LinearLayout(host).apply { orientation = LinearLayout.VERTICAL }
                    message = TextView(host).apply { text = "已经加载的聊天记录"; tag = 1 }
                    messages.addView(message)
                    input = EditText(host).apply { id = R.id.chat_message_input; setText("未发送的草稿") }
                    root.addView(messages); root.addView(input); host.setContentView(root)
                    set("currentMessages", messages)
                    callActivityOnPause(host)
                    check(get("currentMessages") === messages && message.parent === messages && get("chatHistoryReady") == true)
                    check(input.text.toString() == "未发送的草稿")
                    check(get("chatCanSend") == false) { "Sends resumed before access revalidation" }
                }
                checks.put("$kind: transient pause retains message views and ready history")
                checks.put("$kind: existing composer and draft survive")
                checks.put("$kind: sending waits for fresh access metadata")
                ui { callActivityOnResume(host) }
                settle()
                ui { check(get("currentMessages") === messages && message.parent === messages && get("chatHistoryReady") == true) }
                checks.put("$kind: unavailable resume metadata does not blank the chat")
                ui {
                    MainActivity::class.java.getDeclaredMethod("handlePacket", JSONObject::class.java).apply { isAccessible = true }
                        .invoke(host, JSONObject().put("type", "go.changed").put("change_type", "personal.changed").put("conversation_id", get("activeConversationId")))
                    check(message.parent === messages && get("chatHistoryReady") == true)
                }
                checks.put("$kind: personal hint preserves loaded history")
                ui {
                    MainActivity::class.java.getDeclaredMethod("invalidateGoChat").apply { isAccessible = true }.invoke(host)
                    check(messages.childCount == 0 && get("chatHistoryReady") == false)
                    client.token = null
                }
                checks.put("$kind: confirmed access invalidation still clears history")
            }
            val result = JSONObject().put("passed", checks.length()).put("checks", checks)
            java.io.File(targetContext.filesDir, "chat-refresh-results.json").writeText(result.toString(2))
            finish(Activity.RESULT_OK, Bundle().apply { putString("checks", result.toString()) })
        } catch (error: Throwable) {
            finish(Activity.RESULT_CANCELED, Bundle().apply { putString("error", error.stackTraceToString()) })
        } finally { activity?.let { runOnMainSync { it.finish() } } }
    }
}

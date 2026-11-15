package com.pulseim.android

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject

/** Real picker and mention spans, isolated from saved accounts and live groups. */
class GroupMentionProbe : Instrumentation() {
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); start() }
    override fun onStart() {
        var activity: Activity? = null
        val checks = JSONArray()
        try {
            activity = startActivitySync(Intent().setClassName(targetContext.packageName, MainActivity::class.java.name).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            val host = activity
            for (role in listOf("member", "owner", "admin")) {
                lateinit var input: EditText
                lateinit var picker: GroupMentionPicker
                var allowed = true
                val queries = java.util.concurrent.CopyOnWriteArrayList<String>()
                fun views(view: View): List<View> = listOf(view) + if (view is ViewGroup) (0 until view.childCount).flatMap { views(view.getChildAt(it)) } else emptyList()
                fun ui(action: () -> Unit) = runOnMainSync(action)
                fun awaitRow() {
                    repeat(100) {
                        waitForIdleSync()
                        var ready = false
                        ui { ready = views(picker).any { it.contentDescription == "艾特 呆萌萌" } }
                        if (ready) return
                        SystemClock.sleep(30)
                    }
                    error("$role did not receive a fuzzy mention candidate")
                }
                ui {
                    val root = LinearLayout(host).apply { orientation = LinearLayout.VERTICAL }
                    input = EditText(host)
                    root.addView(input)
                    picker = GroupMentionPicker(host, input, { true }, { allowed }, { query, _ ->
                        queries.add(query)
                        JSONObject().put("can_search", true).put("show_accounts", role != "member").put("has_more", false)
                            .put("items", JSONArray().apply {
                                if ("呆萌萌".contains(query)) put(JSONObject().put("user_id", 2).put("nickname", "呆萌萌").put("username", "wenwen3").put("public_id", "123456"))
                            })
                    }, { _, _, _ -> })
                    root.addView(picker.action); root.addView(picker)
                    host.setContentView(root)
                    input.requestFocus(); input.setText("@萌"); input.setSelection(input.length())
                }
                awaitRow()
                check(queries.contains("萌")) { "fuzzy query was not sent" }
                checks.put("$role: fuzzy candidate search")
                ui {
                    check(picker.action.visibility == View.VISIBLE)
                    val text = views(picker).filterIsInstance<TextView>().joinToString(" ") { it.text }
                    if (role == "member") check(!text.contains("wenwen3") && !text.contains("123456")) { "ordinary member saw account labels" }
                    else check(text.contains("@wenwen3")) { "manager labels changed" }
                    views(picker).first { it.contentDescription == "艾特 呆萌萌" }.performClick()
                    check(input.text.toString() == "@呆萌萌 ")
                    check(GroupAvatarMention.targets(input.text).contentEquals(intArrayOf(2))) { "selected mention lost recipient identity" }
                    input.text.delete(1, 2)
                    check(GroupAvatarMention.targets(input.text).isEmpty()) { "edited mention still retained identity" }
                    allowed = false; picker.refreshPermission()
                    check(picker.action.visibility == View.GONE && picker.visibility == View.GONE)
                }
                checks.put("$role: account labels follow role")
                checks.put("$role: selection retains target identity")
                checks.put("$role: editing removes stale mention identity")
                checks.put("$role: sending permission still closes the picker")
            }
            val result = JSONObject().put("passed", checks.length()).put("checks", checks)
            java.io.File(targetContext.filesDir, "mention-probe-results.json").writeText(result.toString(2))
            finish(Activity.RESULT_OK, Bundle().apply { putString("mention_checks", result.toString()) })
        } catch (error: Throwable) {
            finish(Activity.RESULT_CANCELED, Bundle().apply { putString("error", error.stackTraceToString()) })
        } finally { activity?.let { runOnMainSync { it.finish() } } }
    }
}

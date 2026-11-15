package com.pulseim.android

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject

/** Uses an isolated application ID and fixture views; never opens a live group. */
class GroupDirectoryProbe : Instrumentation() {
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); start() }
    override fun onStart() {
        var activity: Activity? = null
        val checks = JSONArray()
        try {
            activity = startActivitySync(Intent().setClassName(targetContext.packageName, MainActivity::class.java.name).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            val host = activity
            fun views(view: View): List<View> = listOf(view) + if (view is ViewGroup) (0 until view.childCount).flatMap { views(view.getChildAt(it)) } else emptyList()
            fun profile(role: String, allow: Boolean) = JSONObject().put("name", "目录测试群").put("member_count", 4).put("my_role", role)
                .put("can_manage", role != "member").put("allow_member_add_friend", allow).put("is_owner", role == "owner")
            val managers = JSONArray().put(JSONObject().put("user_id", 2).put("nickname", "群主测试").put("role", "owner"))
                .put(JSONObject().put("user_id", 3).put("nickname", "管理测试").put("role", "admin"))
            val full = JSONArray(managers.toString()).put(JSONObject().put("user_id", 4).put("nickname", "普通隐藏成员").put("role", "member"))
            for (role in listOf("member", "owner", "admin")) {
                for (allow in listOf(false, true)) {
                    runOnMainSync {
                        val data = profile(role, allow)
                        val sheet = GroupInfoSheet(host, data, if (role == "member") managers else full, 1, { _, _, _ -> }, { _, _ -> }, {}, {}, {}, {}, {})
                        sheet.show()
                        val text = views(sheet.window!!.decorView).filterIsInstance<TextView>().joinToString(" ") { it.text }
                        check(text.contains("群主测试") && text.contains("管理测试"))
                        check(text.contains("普通隐藏成员") == (role != "member"))
                        check(sheet.membersSnapshot().length() == if (role == "member") 2 else 3)
                        sheet.dismiss()
                    }
                    checks.put("$role, allow-add=$allow: permitted roster and snapshot")
                }
            }
            runOnMainSync {
                val sheet = GroupInfoSheet(host, profile("owner", true), full, 1, { _, _, _ -> }, { _, _ -> }, {}, {}, {}, {}, {})
                sheet.show(); sheet.updateProfile(profile("member", true))
                check(sheet.membersSnapshot().length() == 0)
                check(views(sheet.window!!.decorView).filterIsInstance<TextView>().none { it.text.contains("普通隐藏成员") })
                sheet.updateMembers(managers)
                check(sheet.membersSnapshot().length() == 2)
                check(views(sheet.window!!.decorView).filterIsInstance<TextView>().any { it.text.contains("仅显示群主和管理员") })
                sheet.dismiss()
            }
            checks.put("demotion immediately discards the old full roster")
            checks.put("fresh manager-only roster restores the member view")
            val result = JSONObject().put("passed", checks.length()).put("checks", checks)
            java.io.File(targetContext.filesDir, "directory-probe-results.json").writeText(result.toString(2))
            finish(Activity.RESULT_OK, Bundle().apply { putString("directory_checks", result.toString()) })
        } catch (error: Throwable) {
            finish(Activity.RESULT_CANCELED, Bundle().apply { putString("error", error.stackTraceToString()) })
        } finally { activity?.let { runOnMainSync { it.finish() } } }
    }
}

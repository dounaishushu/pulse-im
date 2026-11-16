package com.pulseim.android

import android.app.Activity
import android.app.Instrumentation
import android.os.Bundle
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

internal object ExperienceChecks {
    fun run(probe: Instrumentation) {
        val result = Bundle()
        val report = JSONObject()
        try {
            GoV2Ids.context = probe.targetContext.applicationContext
            val base = "http://127.0.0.1:18471/api/v2"
            val user = UUID.randomUUID().toString()
            val avatar = UUID.randomUUID().toString()
            val attachment = UUID.randomUUID().toString()
            val senderAvatar = UUID.randomUUID().toString()
            val cid = UUID.randomUUID().toString()
            val mid = UUID.randomUUID().toString()
            val parent = UUID.randomUUID().toString()
            var unavailable = false
            val paths = mutableListOf<String>()
            val authorized = mutableListOf<String>()
            fun message(conversation: String = cid) = JSONObject().put("id", mid).put("conversation_id", conversation)
                .put("sender_id", user).put("seq", "2").put("event_seq", "2").put("version", "1").put("kind", "image")
                .put("body", "摘要").put("request_id", "probe").put("reply_to_id", parent)
                .put("created_at", "2026-11-16T00:00:00Z").put("updated_at", "2026-11-16T00:00:00Z")
                .put("sender", JSONObject().put("name", "成员").put("avatar_id", senderAvatar))
                .put("content", JSONObject().put("media", JSONObject().put("id", attachment).put("bytes", "24").put("mime", "image/png")))
            fun conversation(id: String) = JSONObject().put("id", id).put("kind", "group").put("title", "群聊").put("avatar_id", avatar)
                .put("membership_version", "1").put("visible_from_seq", "1").put("can_send", true).put("last_message", message(id))
                .put("state", JSONObject().put("user_id", user).put("clear_seq", "0")).put("my_role", "member")
            val adapter = GoV2Api(base, { "experience-probe" }, { 1L }) { path, _, body, _ ->
                paths.add(path)
                when {
                    path == "/me" -> JSONObject().put("user_id", user)
                    path.startsWith("/client/conversation-page") -> JSONObject().put("items", JSONArray((0..7).map { conversation(if(it == 0)cid else UUID.randomUUID().toString()) }))
                    path == "/conversations/$cid" -> conversation(cid)
                    path == "/media/grants" -> {
                        val ids = requireNotNull(body).getJSONArray("media_ids")
                        JSONObject().put("items", JSONArray((0 until ids.length()).map {
                            val id = ids.getString(it); authorized.add(id)
                            JSONObject().put("id", id).put("access", JSONObject().put("content_path", "/api/v2/media-grants/" + "a".repeat(64) + "/content").put("expires_in", 120))
                        }))
                    }
                    path.endsWith("/reply-contexts") -> JSONObject().put("items", JSONArray().put(JSONObject().put("message_id", mid).put("reply_seq", if(unavailable)"0" else "1")
                        .put("message", if(unavailable)JSONObject.NULL else message().put("id", parent).put("seq", "1").put("kind", "text").put("content", JSONObject()).put("body", "引用正文").removeAndReturn("reply_to_id"))))
                    path.contains("/history?") -> JSONObject().put("items", JSONArray().put(message())).put("membership_version", "1")
                        .put("snapshot_max_seq", "2").put("next_after_seq", "0").put("visible_from_seq", "1").put("clear_seq", "0").put("has_more", false)
                    else -> error("Unexpected probe route: $path")
                }
            }
            val page = adapter.request("/conversations", "GET", null).getJSONObject("data")
            check(page.getJSONArray("items").length() == 8)
            report.put("coldListRequests", paths.size)
            check(paths.size == 3 && authorized == listOf(avatar))
            check(page.getJSONArray("items").getJSONObject(0).getJSONObject("last_message").getJSONObject("body").getString("text") == "摘要")
            report.put("listOnlyLoadsVisibleAvatar", true)
            val local = GoV2Ids.local(base, "conversation", cid)
            paths.clear(); adapter.request("/conversations/info?conversation_id=$local", "GET", null)
            check(paths == listOf("/conversations/$cid")); report.put("permissionRefreshRequests", paths.size)
            val history = adapter.request("/messages/history?conversation_id=$local&size=20", "GET", null).getJSONObject("data").getJSONArray("items").getJSONObject(0)
            check(history.getJSONObject("body").getString("url").endsWith("/content"))
            check(history.getJSONObject("body").getJSONObject("reply_to").getString("text") == "引用正文")
            check(history.getString("sender_avatar_url").endsWith("/content")); report.put("historyStillLoadsImagesAndReplies", true)
            unavailable = true
            val refreshed = adapter.request("/messages/history?conversation_id=$local&size=20", "GET", null).getJSONObject("data").getJSONArray("items").getJSONObject(0)
            check(refreshed.getJSONObject("body").getJSONObject("reply_to").getBoolean("unavailable"))
            report.put("unavailableReplyDoesNotBlockHistory", true)
            checkNotifications(probe, report)
            result.putString("result", "passed")
        } catch(error: Throwable) {
            result.putString("result", "failed"); report.put("error", error.toString()).put("stack", error.stackTrace.take(5).joinToString("\n"))
        }
        result.putString("report", report.toString())
        probe.finish(if(result.getString("result") == "passed") Activity.RESULT_OK else Activity.RESULT_CANCELED, result)
    }
    private fun JSONObject.removeAndReturn(key: String): JSONObject { remove(key); return this }
    private fun checkNotifications(probe: Instrumentation, report: JSONObject) {
        val context = probe.targetContext
        val actor = 1_000_000_000 + java.security.SecureRandom().nextInt(100_000_000)
        val prefs = context.getSharedPreferences("pulse_notify_$actor", android.content.Context.MODE_PRIVATE)
        prefs.edit().putBoolean("sound", false).putBoolean("vibrate", false).apply()
        val stored = context.getSharedPreferences("pulse_message_alerts", android.content.Context.MODE_PRIVATE)
        val manager = context.getSystemService(android.content.Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
        val channels = manager.notificationChannels.map { it.id }.toSet()
        try {
            for(cid in listOf(11, 22, 11)) {
                MessageAlerts.show(context, actor, JSONObject().put("id", cid).put("type", "group").put("name", "Probe"),
                    JSONObject().put("id", 1).put("conversation_id", cid).put("sender_id", 2).put("type", "text").put("body", JSONObject().put("text", "Probe")), false)
            }
            val keys = stored.getStringSet("seen", emptySet()).orEmpty()
            check(keys.contains("$actor:11:1") && keys.contains("$actor:22:1"))
            val expectedTags = setOf("pulse:$actor:11", "pulse:$actor:22")
            // 系统通知服务异步入队，等待实际发布后检查，不能将 notify 返回当作已经展示。
            val deadline = android.os.SystemClock.elapsedRealtime() + 3000
            var visible = manager.activeNotifications.filter { it.tag in expectedTags }
            while (visible.size < 2 && android.os.SystemClock.elapsedRealtime() < deadline) {
                Thread.sleep(20)
                visible = manager.activeNotifications.filter { it.tag in expectedTags }
            }
            check(visible.size == 2 && visible.all { it.id == 1 })
            check(visible[0].notification.contentIntent != visible[1].notification.contentIntent)
            report.put("notificationDedupeIncludesConversation", true).put("sameSequenceNotificationsCoexist", true)
                .put("notificationDestinationsAreDistinct", true)
        } finally {
            for(cid in listOf(11, 22)) manager.cancel("pulse:$actor:$cid", 1)
            val remaining = stored.getStringSet("seen", emptySet()).orEmpty().filterNot { it.startsWith("$actor:") }.toSet()
            stored.edit().putStringSet("seen", remaining).commit()
            prefs.edit().clear().commit()
            if("pulse_silent_still" !in channels)manager.deleteNotificationChannel("pulse_silent_still")
        }
    }
}

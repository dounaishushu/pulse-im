package com.pulseim.android

import android.app.Activity
import android.app.Instrumentation
import android.content.Context
import android.content.SharedPreferences
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.net.URL

/** Seed with the old APK, install the new APK without clearing data, then exercise the real chat screen. */
internal object VoiceOutboxUpgradeProbe {
    fun run(probe: Instrumentation, args: Bundle) {
        val result = Bundle()
        var activity: MainActivity? = null
        var restoreSettings: (() -> Unit)? = null
        var passed = false
        try {
            val context = probe.targetContext.applicationContext
            val base = requireNotNull(args.getString("base"))
            val prefix = requireNotNull(args.getString("prefix"))
            val password = requireNotNull(args.getString("password"))
            require(base.matches(Regex("http://10\\.0\\.2\\.2:[0-9]{4,5}/api/v2")) && prefix.matches(Regex("voiceprobe[a-f0-9]{8}")))
            val sessionSettings = context.getSharedPreferences("pulse_im_session", Context.MODE_PRIVATE)
            val fixture = File(context.noBackupFilesDir, "$prefix.json")
            GoV2Ids.context = context
            MobileDeviceIdentity.initialize(context)
            RouteManager.initialize(context, base, base.replaceFirst("http://", "ws://") + "/realtime")
            val accounts = AccountSessions(context, base)
            val peer = ApiClient(base).apply { token = login(prefix + "b", password) }
            val version = context.packageManager.getPackageInfo(context.packageName, 0).versionName
            val checks = JSONArray()
            fun request(index: Int) = "$prefix-$index"
            if (args.getString("stage") == "seed") {
                check(version == "0.2.108" && !fixture.exists())
                val sender = ApiClient(base).apply { token = login(prefix + "a", password) }
                val privacy = peer.goPrivacy()
                peer.updateGoPrivacy(JSONObject().put("expected_version", privacy.getString("version"))
                    .put("temporary_chat", JSONObject().put("visibility", "everyone").put("allow", JSONArray()).put("deny", JSONArray())))
                val profile = sender.me()
                val user = profile.getInt("id")
                val cid = sender.createDirectConversation(peer.me().getInt("id")).getInt("id")
                val token = requireNotNull(sender.token)
                val scope = LocalAccountStore.scope(base, user)
                val queue = AndroidOutboxStorage.media(context, token, user, base)
                val audioUrl = requireNotNull(args.getString("audio"))
                require(audioUrl.matches(Regex("http://10\\.0\\.2\\.2:[0-9]{4,5}/voice\\.m4a")))
                val source = File.createTempFile("voice-probe-", ".m4a", context.cacheDir)
                try {
                    URL(audioUrl).openConnection().apply { connectTimeout = 5000; readTimeout = 5000 }.getInputStream().use { input ->
                        source.outputStream().use { output -> input.copyTo(output) }
                    }
                    for (i in 0..4) queue.enqueue(request(i), cid, "voice", "audio/mp4", "语音.m4a", source, 0, 1400)
                } finally { source.delete() }
                check(File(context.cacheDir, "outbox-open/$scope").deleteRecursively())
                val first = checkNotNull(queue.claim(cid))
                check(first.requestId == request(0))
                val failure = runCatching { queue.openFile(first).close() }.exceptionOrNull()
                check(failure?.message == "无法读取待发附件，请保留本地数据后重试") { "Expected old cache read failure" }
                check(queue.fail(first, failure.message) && queue.claim(cid) == null)
                checks.put("old APK reproduces the read error and leaves all later voices queued")
                val pending = queue.pending(cid)
                check(pending.size == 5)
                val durable = File(context.noBackupFilesDir, "outbox-attachments/$scope")
                RandomAccessFile(File(durable, "${pending[1].attachmentId}.bin"), "rw").use { file ->
                    val position = file.length() - 1
                    file.seek(position)
                    val original = file.readByte().toInt()
                    file.seek(position)
                    file.writeByte(original xor 1)
                }
                check(File(durable, "${pending[3].attachmentId}.bin").delete())
                accounts.save(profile, token)
                fixture.writeText(JSONObject().put("user", user).put("cid", cid)
                    .put("previous_base", sessionSettings.getString("go_api_base_url", null) ?: JSONObject.NULL).toString())
                check(sessionSettings.edit().putString("go_api_base_url", base).commit())
            } else {
                val state = JSONObject(fixture.readText())
                restoreSettings = { restoreEndpoint(sessionSettings, state) }
                val user = state.getInt("user")
                val cid = state.getInt("cid")
                val scope = LocalAccountStore.scope(base, user)
                val token = checkNotNull(accounts.token())
                val queue = AndroidOutboxStorage.media(context, token, user, base)
                check(queue.pending(cid).size == 5 && queue.pending(cid).first().phase == DurableMediaOutbox.Phase.QUEUED)
                checks.put("in-place upgrade restores the legacy queue with the original Android Keystore")
                val scratchRoot = File(context.noBackupFilesDir, "outbox-open/$scope")
                val original = checkNotNull(queue.claim(cid))
                queue.openFile(original).use { decrypted ->
                    check(decrypted.file.parentFile == scratchRoot && decrypted.file.length() == original.size)
                    check(File(context.cacheDir, "outbox-open").deleteRecursively())
                    check(decrypted.file.isFile && decrypted.file.length() == original.size)
                }
                check(queue.defer(original, "test interruption", original.attempt, 0))
                checks.put("cache clearing cannot remove the active upload file")
                val chat = probe.startActivitySync(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
                activity = chat
                fun field(name: String): Any? = chat.javaClass.getDeclaredField(name).apply { isAccessible = true }.get(chat)
                fun waitFor(description: String, predicate: () -> Boolean) {
                    val until = android.os.SystemClock.elapsedRealtime() + 35_000
                    while (android.os.SystemClock.elapsedRealtime() < until) {
                        var ready = false
                        probe.runOnMainSync { ready = predicate() }
                        if (ready) return
                        Thread.sleep(100)
                    }
                    error("Timed out: $description")
                }
                waitFor("fixture account") { field("currentUserId") == user && field("mediaOutbox") === queue }
                probe.runOnMainSync {
                    chat.javaClass.getDeclaredMethod("openExistingChat", Int::class.javaPrimitiveType).apply { isAccessible = true }.invoke(chat, cid)
                }
                waitFor("remaining voice sends") {
                    queue.pending(cid).map { it.requestId to it.phase } == listOf(
                        request(1) to DurableMediaOutbox.Phase.UNREADABLE, request(3) to DurableMediaOutbox.Phase.UNREADABLE)
                }
                val sender = ApiClient(base).apply { this.token = token }
                val history = sender.history(cid)
                // The compatibility history API returns the newest message first.
                val sentIds = (history.length() - 1 downTo 0).map { history.getJSONObject(it) }
                    .filter { it.optString("type") == "voice" }.map { it.getJSONObject("body").getString("request_id") }
                check(sentIds == listOf(request(0), request(2), request(4))) { "Recovered messages were missing, reordered or duplicated" }
                val peerHistory = peer.history(cid)
                check((0 until peerHistory.length()).count { peerHistory.getJSONObject(it).optString("type") == "voice" } == 3)
                checks.put("three intact voices upload to Go and reach the recipient once in order")
                fun labels(view: View): List<String> = when (view) {
                    is TextView -> listOf(view.text.toString())
                    is ViewGroup -> (0 until view.childCount).flatMap { labels(view.getChildAt(it)) }
                    else -> emptyList()
                }
                waitFor("unreadable voice feedback") {
                    val list = field("currentMessages") as? ViewGroup ?: return@waitFor false
                    listOf(1, 3).all { index ->
                        val row = list.findViewWithTag<View>("pending-media:${request(index)}") ?: return@all false
                        val text = labels(row)
                        text.any { it.contains("请重新录制") } && text.none { it.contains("点击重试") }
                    }
                }
                check(scratchRoot.listFiles().orEmpty().isEmpty())
                checks.put("missing and corrupt recordings show a rerecord prompt and leave no upload plaintext")
            }
            result.putString("report", JSONObject().put("version", version).put("checks", checks).toString())
            passed = true
        } catch (failure: Throwable) {
            result.putString("error", failure.stackTraceToString().take(3800))
        } finally {
            activity?.let { host -> probe.runOnMainSync { host.finish() } }
            restoreSettings?.invoke()
        }
        probe.finish(if (passed) Activity.RESULT_OK else Activity.RESULT_CANCELED, result)
    }

    private fun restoreEndpoint(settings: SharedPreferences, state: JSONObject) {
        val edit = settings.edit()
        if (state.isNull("previous_base")) edit.remove("go_api_base_url") else edit.putString("go_api_base_url", state.getString("previous_base"))
        edit.commit()
    }
}

package com.pulseim.android

import android.app.Activity
import android.app.Instrumentation
import android.database.sqlite.SQLiteDatabase
import android.os.Bundle
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

internal object RepeatedWorkChecks {
    fun run(probe: Instrumentation, baseline: Boolean = false) {
        val result = Bundle()
        val report = JSONObject()
        val context = probe.targetContext.applicationContext
        GoV2Ids.context = context
        val base = "http://127.0.0.1:18124/${UUID.randomUUID()}/api/v2"
        val wire = UUID.randomUUID().toString()
        var database: SQLiteDatabase? = null
        try {
            val id = GoV2Ids.local(base, "user", wire)
            database = SQLiteDatabase.openDatabase(File(context.noBackupFilesDir, "go-v2-identifiers.db").path, null, SQLiteDatabase.OPEN_READWRITE)
            fun sequence(): Long = database.rawQuery("SELECT seq FROM sqlite_sequence WHERE name='ids'", null).use { check(it.moveToFirst()); it.getLong(0) }
            val before = sequence()
            var started = System.nanoTime()
            repeat(2000) {
                check(GoV2Ids.local(base, "user", wire) == id)
                check(GoV2Ids.wire(base, "user", id) == wire)
            }
            report.put("idIterations", 2000).put("idMs", (System.nanoTime() - started) / 1_000_000.0)
                .put("idSequenceWrites", sequence() - before)
            repeat(2050) { GoV2Ids.local(base, "user", UUID.randomUUID().toString()) }
            val evictedSequence = sequence()
            check(GoV2Ids.local(base, "user", wire) == id)
            check(GoV2Ids.wire(base, "user", id) == wire)
            if (!baseline) check(sequence() == evictedSequence)
            report.put("evictedIdentityRestoredWithoutWrite", sequence() == evictedSequence)
            check(GoV2Ids.local(base, "conversation", wire) != id)
            check(GoV2Ids.local("$base/other", "user", wire) != id)
            val changed = runCatching { GoV2Ids.wire(base, "conversation", id) }.isFailure
            check(changed)
            val cid = GoV2Ids.local(base, "conversation", UUID.randomUUID().toString())
            check(!GoV2Ids.membership(base, id, cid, "2", "probe"))
            repeat(50) { check(!GoV2Ids.membership(base, id, cid, "2", "probe")) }
            check(runCatching { GoV2Ids.membership(base, id, cid, "1", "probe") }.isFailure)
            val scope = "probe-account"
            val identity = "pulse-media:ee111111-1111-4111-8111-111111111111/content"
            val expected = AvatarDiskCache.key(scope, identity)
            started = System.nanoTime()
            repeat(5000) { check(AvatarDiskCache.key(scope, identity) == expected) }
            report.put("avatarIterations", 5000).put("avatarKeyMs", (System.nanoTime() - started) / 1_000_000.0)
            check(AvatarDiskCache.key(scope + "-other", identity) != expected)
            check(AvatarDiskCache.key(scope, identity + "-other") != expected)
            report.put("identityIsolation", true).put("membershipRollbackRejected", true)
            val granted = "11111111-2222-4222-8222-111111111111"
            val delayed = "22222222-2222-4222-8222-111111111111"
            val entered = CountDownLatch(1)
            val release = CountDownLatch(1)
            val pool = Executors.newFixedThreadPool(2)
            val adapter = GoV2Api(base, { "probe-token" }, { 1L }) { path, _, _, _ ->
                when {
                    path.startsWith("/profiles/") -> JSONObject().put("id", wire).put("avatar_id", delayed)
                    path.startsWith("/client/friend-page") -> JSONObject().put("items", org.json.JSONArray().put(JSONObject().put("id", wire).put("avatar_id", granted)))
                    path == "/media/$delayed/grants" -> {
                        entered.countDown()
                        check(release.await(5, TimeUnit.SECONDS))
                        JSONObject().put("content_path", "/api/v2/media-grants/" + "b".repeat(64) + "/content").put("expires_in", 120)
                    }
                    else -> error("Unexpected probe route")
                }
            }
            adapter.rememberMediaAccess(granted, JSONObject().put("content_path", "/api/v2/media-grants/" + "a".repeat(64) + "/content").put("expires_in", 120))
            try {
                val slow = pool.submit<JSONObject> { adapter.request("/contacts/profile?user_id=$id", "GET", null) }
                check(entered.await(2, TimeUnit.SECONDS))
                val cached = pool.submit<JSONObject> { adapter.request("/contacts", "GET", null) }
                val nonblocking = try { cached.get(300, TimeUnit.MILLISECONDS); true } catch (_: java.util.concurrent.TimeoutException) { false }
                report.put("cachedMediaBypassesUnrelatedRequest", nonblocking)
                release.countDown()
                slow.get(3, TimeUnit.SECONDS); cached.get(3, TimeUnit.SECONDS)
                if (!baseline) check(nonblocking)
            } finally { release.countDown(); pool.shutdownNow() }
            result.putString("result", "passed")
        } catch (error: Throwable) {
            result.putString("result", "failed")
            report.put("error", error.toString()).put("stack", error.stackTrace.take(6).joinToString("\n"))
        } finally {
            database?.let { db ->
                for (table in listOf("ids", "messages", "memberships")) db.delete(table, "base=? OR base=?", arrayOf(base, "$base/other"))
                db.close()
            }
        }
        result.putString("report", report.toString())
        probe.finish(if (result.getString("result") == "passed") Activity.RESULT_OK else Activity.RESULT_CANCELED, result)
    }
}

package com.pulseim.android

import android.app.Instrumentation
import android.app.Notification
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/** Local-payload/Android delivery checks only; never sends to a Firebase or production endpoint. */
class PushNotificationProbe : Instrumentation() {
    private var phase = "checks"
    private val checks = JSONArray()
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); phase = arguments?.getString("phase") ?: "checks"; start() }
    private fun await(label: String, condition: () -> Boolean) {
        val done = CountDownLatch(1); var failure: Throwable? = null
        val deadline = SystemClock.uptimeMillis() + 5000
        val handler = Handler(Looper.getMainLooper())
        handler.post(object : Runnable {
            override fun run() {
                try {
                    if (condition()) { done.countDown(); return }
                    check(SystemClock.uptimeMillis() < deadline) { "Timed out: $label" }
                    handler.postDelayed(this, 16)
                } catch (error: Throwable) { failure = error; done.countDown() }
            }
        })
        check(done.await(6, TimeUnit.SECONDS)) { label }; failure?.let { throw it }
    }
    override fun onStart() {
        // Instrumentation.start() can run this thread before Application.onCreate finishes.
        waitForIdleSync()
        val app = targetContext.applicationContext
        val report = JSONObject().put("phase", phase).put("pid", android.os.Process.myPid())
            .put("real_fcm_delivery_tested", false).put("production_api_used", false)
        try {
            check(app.packageName == "com.pulseim.android.chatp1.push")
            val base = app.getString(R.string.pulse_api_base_url)
            check(base == "http://127.0.0.1:9/api/v2" && BuildConfig.GO_BACKEND)
            check(BuildConfig.FCM_CONFIGURED) { "This probe requires the isolated FCM compilation fixture" }
            val firebase = Class.forName("com.google.firebase.FirebaseApp").getMethod("getInstance").invoke(null)
            check(firebase.javaClass.getMethod("getName").invoke(firebase) == "[DEFAULT]")
            val messaging = Class.forName("com.google.firebase.messaging.FirebaseMessaging").getMethod("getInstance").invoke(null)
            check(messaging.javaClass.getMethod("isAutoInitEnabled").invoke(messaging) == false)
            checks.put("Application cold-start initializes the default Firebase app without an Activity; signed-out auto-init stays disabled")
            val worker = PushNotifications::class.java.getDeclaredField("executor").apply { isAccessible = true }.get(PushNotifications) as ScheduledExecutorService
            val drained = CountDownLatch(1); worker.execute { drained.countDown() }; check(drained.await(5, TimeUnit.SECONDS))
            val service = app.packageManager.getServiceInfo(ComponentName(app, PulseMessagingService::class.java), PackageManager.MATCH_DISABLED_COMPONENTS)
            check(service.enabled && !service.exported)
            checks.put("Merged manifest enables only the non-exported FCM service")
            if (Build.VERSION.SDK_INT >= 33) uiAutomation.grantRuntimePermission(app.packageName, android.Manifest.permission.POST_NOTIFICATIONS)
            val manager = app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            check(manager.areNotificationsEnabled()); manager.cancelAll(); await("clear task notifications") { manager.activeNotifications.isEmpty() }
            val prefs = app.getSharedPreferences("pulse_push", Context.MODE_PRIVATE)
            val sessions = AccountSessions(app, base)
            val ownerWire = "11111111-1111-4111-8111-111111111111"
            val otherWire = "44444444-4444-4444-8444-444444444444"
            val cidWire = "22222222-2222-4222-8222-222222222222"
            val midWire = "33333333-3333-4333-8333-333333333333"
            fun payload(seq: Int, owner: String = ownerWire, muted: Boolean = false) = mapOf(
                "user_id" to owner, "conversation_id" to cidWire, "message_id" to midWire,
                "seq" to seq.toString(), "conversation_type" to "group", "body" to "fixture preview", "notifications_muted" to muted.toString())
            PushNotifications.foreground = false; PushNotifications.activeConversation = 0
            if (phase == "checks") {
                check(sessions.activeId() == 0 && AccountSessions(app).token() == null)
                val uid = GoV2Ids.local(base, "user", ownerWire)
                val cid = GoV2Ids.local(base, "conversation", cidWire)
                val otherUid = GoV2Ids.local(base, "user", otherWire)
                sessions.save(JSONObject().put("id", uid).put("nickname", "推送测试"), "isolated-push-session-a")
                check(AccountSessions(app).token() == null)
                app.getSharedPreferences("pulse_notify_$uid", Context.MODE_PRIVATE).edit().putBoolean("sound", false).putBoolean("vibrate", false).commit()
                prefs.edit().putBoolean("disabled", false).commit()
                var registrations = 0
                val client = GoV2Api(base, { "isolated-push-session-a" }, { 1L }) { path, method, body, version ->
                    check(path == "/me/push-device" && method == "PUT" && version == 1L)
                    check(body!!.getString("platform") == "android" && body.getString("token") == "fixture-fcm-token-0123456789")
                    check(body.getInt("payload_version") == 2); registrations++
                    JSONObject().put("registered", true)
                }
                check(client.request("/notifications/devices/register", "POST", JSONObject().put("device_token", "fixture-fcm-token-0123456789")).getJSONObject("data").getString("status") == "registered")
                check(registrations == 1)
                checks.put("Real Go adapter registers payload_version=2 through the existing push-device contract")
                PushNotifications.receive(app, payload(101)); await("first notification") { manager.activeNotifications.size == 1 }
                val first = manager.activeNotifications.single()
                check(first.tag == "pulse:$uid:$cid" && first.id == 101)
                check(first.notification.extras.getCharSequence(Notification.EXTRA_TEXT).toString() == "fixture preview")
                checks.put("Endpoint-scoped Go login receives a UUID push and posts the local conversation/sequence notification")
                PushNotifications.receive(app, payload(101))
                MessageAlerts.show(app, uid, JSONObject().put("id", cid).put("type", "group"), JSONObject().put("id", 101).put("conversation_id", cid), false)
                PushNotifications.receive(app, payload(102, otherWire)); PushNotifications.receive(app, payload(103, muted = true))
                PushNotifications.receive(app, payload(104)); await("dedup and recipient fence") { manager.activeNotifications.size == 2 }
                check(manager.activeNotifications.map { it.id }.toSet() == setOf(101, 104))
                checks.put("Repeated FCM/WebSocket sequence, wrong recipient and muted payload create no extra alert")
                sessions.save(JSONObject().put("id", otherUid).put("nickname", "第二账号"), "isolated-push-session-b")
                app.getSharedPreferences("pulse_notify_$otherUid", Context.MODE_PRIVATE).edit().putBoolean("sound", false).putBoolean("vibrate", false).putBoolean("preview", false).commit()
                PushNotifications.receive(app, payload(105)); PushNotifications.receive(app, payload(106, otherWire))
                await("new account notification") { manager.activeNotifications.size == 3 }
                check(manager.activeNotifications.single { it.id == 106 }.tag == "pulse:$otherUid:$cid")
                check(manager.activeNotifications.single { it.id == 106 }.notification.extras.getCharSequence(Notification.EXTRA_TEXT).toString() == "收到一条新消息")
                checks.put("Switching the saved active account rejects the old recipient and preserves hidden-preview settings")
                prefs.edit().putBoolean("disabled", true).commit(); PushNotifications.receive(app, payload(107, otherWire))
                check(manager.activeNotifications.size == 3)
                File(app.filesDir, "push-probe-fixture.json").writeText(JSONObject().put("pid", android.os.Process.myPid()).put("uid", otherUid).put("cid", cid).toString())
                checks.put("Local logout gate suppresses delivery before unregister reaches the network")
            } else {
                check(phase == "cold")
                val saved = JSONObject(File(app.filesDir, "push-probe-fixture.json").readText())
                check(saved.getInt("pid") != android.os.Process.myPid())
                check(sessions.activeId() == saved.getInt("uid") && sessions.token() == "isolated-push-session-b")
                check(prefs.getBoolean("disabled", false)); PushNotifications.receive(app, payload(201, otherWire)); check(manager.activeNotifications.isEmpty())
                prefs.edit().putBoolean("disabled", false).commit()
                PushNotifications.receive(app, payload(202, otherWire)); await("cold-process notification") { manager.activeNotifications.size == 1 }
                check(manager.activeNotifications.single().tag == "pulse:${saved.getInt("uid")}:${saved.getInt("cid")}")
                checks.put("New process restores encrypted Go account and UUID mappings, respects logout, then posts a correctly addressed local-payload alert")
                sessions.invalidate(saved.getInt("uid")); PushNotifications.receive(app, payload(203, otherWire)); check(manager.activeNotifications.size == 1)
                checks.put("An invalidated account cannot display a subsequent push")
            }
            prefs.edit().putBoolean("disabled", true).commit(); manager.cancelAll()
            report.put("passed", true).put("checks", checks)
            File(app.filesDir, "push-probe-$phase.json").writeText(report.toString(2))
            finish(-1, Bundle().apply { putString("report", report.toString()) })
        } catch (error: Throwable) {
            report.put("passed", false).put("checks", checks).put("error", error.stackTraceToString())
            File(app.filesDir, "push-probe-$phase.json").writeText(report.toString(2))
            finish(0, Bundle().apply { putString("error", report.toString()) })
        }
    }
}

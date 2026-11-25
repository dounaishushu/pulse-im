package com.pulseim.android

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** Exercises the shipping renderer with isolated IDs and a closed localhost endpoint. */
class ChatRecyclerProbe : Instrumentation() {
    private lateinit var activity: MainActivity
    private val fields by lazy { MainActivity::class.java.declaredFields.associateBy { it.name }.onEach { it.value.isAccessible = true } }
    private val checks = JSONArray()
    private var arguments = Bundle()
    private val handler = Handler(Looper.getMainLooper())
    private var performanceStats: ChatFrameStats? = null
    private fun get(name: String): Any? = fields.getValue(name).get(activity)
    private fun set(name: String, value: Any?) = fields.getValue(name).set(activity, value)
    private fun invoke(name: String, vararg args: Any?): Any? = MainActivity::class.java.declaredMethods
        .single { it.name == name && it.parameterCount == args.size }.apply { isAccessible = true }.invoke(activity, *args)
    private fun ui(action: () -> Unit) {
        var failure: Throwable? = null
        runOnMainSync { try { action() } catch (error: Throwable) { failure = error } }
        failure?.let { throw it }
    }
    private fun await(label: String, condition: () -> Boolean) {
        val done = CountDownLatch(1); var failure: Throwable? = null
        val deadline = SystemClock.uptimeMillis() + 10_000
        handler.post(object : Runnable {
            override fun run() {
                try {
                    if (condition()) { done.countDown(); return }
                    check(SystemClock.uptimeMillis() < deadline) { "Timed out: $label" }
                    handler.postDelayed(this, 16)
                } catch (error: Throwable) { failure = error; done.countDown() }
            }
        })
        check(done.await(12, TimeUnit.SECONDS)) { label }; failure?.let { throw it }; waitForIdleSync()
    }
    private fun frames() {
        val done = CountDownLatch(1)
        ui { val view = activity.window.decorView; var left = 4
            view.postOnAnimation(object : Runnable { override fun run() { if (--left == 0) done.countDown() else view.postOnAnimation(this) } }) }
        check(done.await(5, TimeUnit.SECONDS)); waitForIdleSync()
    }
    private fun shell(command: String) = ParcelFileDescriptor.AutoCloseInputStream(uiAutomation.executeShellCommand(command)).bufferedReader().use { it.readText() }
    private fun record(value: String) { checks.put(value); File(targetContext.filesDir, "p1-checks.json").writeText(checks.toString(2)) }
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); this.arguments = arguments ?: Bundle(); start() }
    override fun onStart() {
        val gate = CountDownLatch(1)
        try {
            check(targetContext.packageName.startsWith("com.pulseim.android.chatp1."))
            check(targetContext.getString(R.string.pulse_api_base_url) == "http://127.0.0.1:9/api/v2")
            GoV2Ids.context = targetContext.applicationContext
            activity = startActivitySync(Intent().setClassName(targetContext.packageName, MainActivity::class.java.name).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
            for ((name, size) in listOf("executor" to 1, "chatLoadExecutor" to 2, "textExecutor" to 2, "messageExecutor" to 2)) {
                repeat(size) { (get(name) as ExecutorService).execute { gate.await(300, TimeUnit.SECONDS) } }
            }
            val base = get("apiBaseUrl") as String; check(base == "http://127.0.0.1:9/api/v2")
            val token = "isolated-render-regression"
            val viewer = GoV2Ids.local(base, "user", UUID.nameUUIDFromBytes("p1-viewer".toByteArray()).toString())
            val peer = GoV2Ids.local(base, "user", UUID.nameUUIDFromBytes("p1-peer".toByteArray()).toString())
            ui {
                (get("messageHandler") as Handler).removeCallbacks(get("foregroundMessageCheck") as Runnable)
                (get("api") as ApiClient).token = token; set("currentUserId", viewer); set("currentNickname", "自己")
                set("lastRealtimeCatchUp", Long.MAX_VALUE); set("appForeground", true)
            }
            for (kind in listOf("group", "direct")) {
                val cid = GoV2Ids.local(base, "conversation", UUID.nameUUIDFromBytes("p1-$kind".toByteArray()).toString())
                GoV2Ids.membership(base, viewer, cid, "1", token)
                fun message(id: Int) = JSONObject().put("id", id).put("conversation_id", cid).put("sender_id", if (id % 3 == 0) viewer else peer)
                    .put("sender_name", if (id % 3 == 0) "自己" else "群成员").put("type", "text").put("body", JSONObject().put("text", "消息 $id：日常聊天内容"))
                    .put("created_at", "2026-11-18T12:34:00Z").put("status", "sent").put("_go_version", "1")
                lateinit var messages: LinearLayout
                ui {
                    set("activeConversationId", cid); set("activeConversationType", kind); set("chatLocateTarget", 0)
                    val content = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }; set("content", content); activity.setContentView(content)
                    invoke("loadHistory", "回归检查", JSONObject().put("id", cid).put("type", kind).put("name", "回归检查")
                        .put("member_count", 3).put("can_send", true).put("my_role", "member").put("membership_version", "1"))
                    messages = get("currentMessages") as LinearLayout; set("chatHistoryReady", true)
                    activity.findViewById<View>(R.id.chat_history_loading)?.visibility = View.GONE
                    activity.findViewById<View>(R.id.chat_history_error)?.visibility = View.GONE
                    set("goChatRevalidate", false); set("goChatInvalidated", false)
                    repeat(200) { invoke("addMessage", messages, message(it + 1), "snapshot") }
                }
                val list = fields["chatRecycler"]?.get(activity) as? ChatRecyclerList
                if (list != null) await("200 messages committed") { list.adapter.currentList.count { it.kind == ChatRowKind.MESSAGE } == 200 && !list.view.hasPendingAdapterUpdates() }
                frames()
                val digest = snapshot(messages, "$kind-initial.png")
                record("$kind: 200 messages rendered; CHAT_V2=${BuildConfig.CHAT_V2}; pixels=$digest")
                if (list == null) {
                    val scroll = activity.findViewById<ScrollView>(R.id.chat_message_scroll)
                    ui { check(messages.findViewWithTag<View>(200) != null); pause(); scroll.scrollTo(0, scroll.scrollY - scroll.height * 2) }
                    frames(); var oldY = 0
                    ui { oldY = scroll.scrollY; repeat(5) { invoke("addMessage", messages, message(201 + it), "event") } }
                    frames(); ui { check(scroll.scrollY == oldY); check(messages.findViewWithTag<View>(205) != null) }
                    record("$kind: legacy incoming preserves reader position")
                    continue
                }
                if (arguments.getString("perf") == "true" && kind == "group") performance(list)
                var full = 0; var ranges = 0
                list.adapter.registerAdapterDataObserver(object : RecyclerView.AdapterDataObserver() {
                    override fun onChanged() { full++ }
                    override fun onItemRangeChanged(start: Int, count: Int, payload: Any?) { ranges += count }
                })
                ui { pause(); list.view.scrollBy(0, -list.view.height * 2) }; frames()
                var anchor: ChatRecyclerList.Anchor? = null; var beforeBinds = 0
                ui { anchor = list.capture(); beforeBinds = list.binds; repeat(5) { invoke("addMessage", messages, message(201 + it), "event") } }
                await("five arrivals") { list.adapter.currentList.any { it.id == 205 } && !list.view.hasPendingAdapterUpdates() }; frames()
                ui { sameAnchor(list, anchor); check(full == 0); check(list.binds - beforeBinds <= 5) { "Arrival binds=${list.binds - beforeBinds}" } }
                record("$kind: five arrivals; full invalidations=$full; binds=${list.binds - beforeBinds}; reader two pages up stays fixed")
                val target = list.adapter.currentList.first { it.key == anchor!!.key }.id
                var row: View? = null
                ui { row = list.bound(target); invoke("addMessage", messages, message(target).put("_go_version", "2").put("body", JSONObject().put("text", "修改后的消息")), "event") }
                await("text edit") { list.bound(target)?.findViewById<TextView>(R.id.chat_message_text)?.text.toString() == "修改后的消息" }; frames()
                ui { check(list.bound(target) === row); sameAnchor(list, anchor) }
                record("$kind: edit retains selectable row and reader anchor")
                ui { invoke("toggleMessageSelection", target) }; frames()
                ui { check(list.bound(target) === row); check(list.bound(target)!!.contentDescription.toString().contains("已选择")); sameAnchor(list, anchor) }
                record("$kind: selection payload retains rows and position")
                var selectionRanges = ranges
                ui { invoke("toggleMessageSelection", target) }; frames()
                ui {
                    check(ranges - selectionRanges == 1) { "Single deselection notified ${ranges - selectionRanges} rows" }
                    check(list.bound(target) === row); check(list.bound(target)!!.contentDescription.toString().contains("未选择")); sameAnchor(list, anchor)
                }
                selectionRanges = ranges
                ui { invoke("renderMessageSelection") }; frames()
                ui { check(ranges == selectionRanges) { "Unchanged selection notified ${ranges - selectionRanges} rows" } }
                ui { invoke("toggleMessageSelection", target) }; frames()
                ui {
                    check(ranges - selectionRanges == 1) { "Single selection notified ${ranges - selectionRanges} rows" }
                    check(list.bound(target) === row); check(list.bound(target)!!.contentDescription.toString().contains("已选择")); sameAnchor(list, anchor)
                    invoke("clearMessageSelection")
                }
                frames(); record("$kind: individual selection/deselection notifies exactly one row; unchanged selection notifies none")
                ui { invoke("applyDeltaMessageEvent", "message.recalled", message(target).put("_go_version", "3").put("status", "recalled"), true) }
                await("recall notice") { list.bound(target)?.findViewById<TextView>(R.id.chat_message_text)?.text.toString().contains("消息已撤回") }
                ui { check(list.bound(target) === row); check((get("currentMessageData") as Map<*, *>)[target] == null); check(ranges > 0); check(full == 0) }
                ui { invoke("applyDeltaMessageEvent", "message.recalled", message(900).put("_go_version", "2").put("status", "recalled"), false) }
                frames(); ui { check(list.adapter.currentList.none { it.id == 900 }); check(list.adapter.currentList.first { it.id == target }.snapshot.contains("消息已撤回")) }
                record("$kind: recall uses partial bind, discards original content and retains row identity")
                // Real quote/voice/image factories are exercised without contacting a remote server.
                val quoteId = 210
                val imageId = 211
                val imageUrl = "http://127.0.0.1:9/p1-image-$kind.jpg"
                val imageValue = message(imageId).put("type", "image").put("body", JSONObject().put("url", imageUrl).put("width", 120).put("height", 240))
                val bitmap = Bitmap.createBitmap(120, 240, Bitmap.Config.ARGB_8888).apply { eraseColor(0xFF40AA80.toInt()) }
                ui {
                    ChatImageCache.seedPreview("$base|$token", imageUrl, bitmap)
                    invoke("addMessage", messages, message(quoteId).put("body", JSONObject().put("text", "引用回复").put("reply_to", JSONObject().put("id", 20).put("sender_name", "群成员").put("text", "原消息"))), "event")
                    invoke("addMessage", messages, imageValue, "event")
                    invoke("addMessage", messages, message(212).put("type", "voice").put("body", JSONObject().put("url", "http://127.0.0.1:9/voice.m4a").put("duration_ms", 3200)), "event")
                }
                await("rich messages committed") { list.adapter.currentList.any { it.id == 212 } }
                reveal(list, quoteId); ui { check(list.bound(quoteId)?.findViewById<View>(R.id.chat_reply_block) != null) }
                var quoteAnchor: ChatRecyclerList.Anchor? = null
                ui { quoteAnchor = list.capture(); invoke("applyDeltaMessageEvent", "message.updated", message(20).put("_go_version", "2").put("body", JSONObject().put("text", "更新后的原消息".repeat(20))), true) }
                await("quote summary update") { list.bound(quoteId)?.let { descendants(it).filterIsInstance<TextView>().any { label -> label.text.toString().contains("更新后的原消息") } } == true }
                frames(); ui { sameAnchor(list, quoteAnchor, tolerancePx = 1) }
                reveal(list, imageId); frames()
                var imageRow: View? = null; var width = 0; var height = 0
                ui { imageRow = list.bound(imageId); val image = imageRow!!.findViewWithTag<ImageView>("ios-group-image") ?: descendants(imageRow!!).filterIsInstance<ImageView>().first()
                    val box = image.parent as View; width = box.width; height = box.height; check(width > 0 && height > width); check(image.drawable != null) }
                var imageAnchor: ChatRecyclerList.Anchor? = null
                ui { imageAnchor = list.capture(); val image = imageRow!!.findViewWithTag<ImageView>("ios-group-image") ?: descendants(imageRow!!).filterIsInstance<ImageView>().first()
                    invoke("loadChatImage", image, (image.parent as android.widget.FrameLayout).getChildAt(1) as TextView, imageUrl, messages, token, imageValue) }
                frames(); ui { val image = imageRow!!.findViewWithTag<ImageView>("ios-group-image") ?: descendants(imageRow!!).filterIsInstance<ImageView>().first(); check((image.parent as View).width == width && (image.parent as View).height == height); sameAnchor(list, imageAnchor) }
                reveal(list, 150); reveal(list, imageId); frames()
                ui { val image = list.bound(imageId)!!.findViewWithTag<ImageView>("ios-group-image") ?: descendants(list.bound(imageId)!!).filterIsInstance<ImageView>().first(); check(image.drawable != null) { "Image was not restored after recycling" } }
                reveal(list, 212)
                var voiceAnchor: ChatRecyclerList.Anchor? = null
                ui { voiceAnchor = list.capture(); check(list.bound(212)?.findViewById<View>(R.id.chat_message_voice) is VoiceMessageView)
                    list.voice(GroupMessageMedia.VoiceState(212, loading = true, playing = false, durationSeconds = 4)) }
                frames(); ui { sameAnchor(list, voiceAnchor) }
                reveal(list, 150); reveal(list, 212)
                ui { check((list.bound(212)?.findViewById<View>(R.id.chat_message_voice) as VoiceMessageView).loading)
                    list.voice(GroupMessageMedia.VoiceState(212, loading = false, playing = false, durationSeconds = 4)) }
                record("$kind: quote updates, image refill and voice loading keep the reader anchor; quote locates by adapter ID")
                val queue = TextSendQueue()
                lateinit var entry: TextSendQueue.Entry
                ui { set("textSends", queue); entry = queue.enqueue(token, viewer, base, cid, "待发送检查", 0, intArrayOf()); invoke("renderPendingTextMessages", messages); set("chatLocateTarget", 0); (get("chatMessageScroll") as ChatMessageScroll).followLatest(true) }
                await("pending row") { list.bound(entry.requestId) != null }; frames()
                var pending: View? = null; var pendingAnchor: ChatRecyclerList.Anchor? = null
                ui { pause(); list.view.scrollBy(0, -(36 * activity.resources.displayMetrics.density).toInt()) }; frames()
                ui { pending = list.bound(entry.requestId); pendingAnchor = list.capture(); queue.claim(token, viewer, base, 1); queue.fail(entry, "离线检查"); invoke("renderPendingTextMessages", messages) }
                await("pending failed state") { list.bound(entry.requestId)?.findViewById<TextView>(R.id.chat_pending_status)?.text.toString().contains("点击重试") }; frames()
                ui { check(list.bound(entry.requestId) === pending); sameAnchor(list, pendingAnchor); queue.retry(entry, token, viewer, base); invoke("renderPendingTextMessages", messages) }
                await("pending retry") { list.bound(entry.requestId)?.findViewById<TextView>(R.id.chat_pending_status)?.text.toString().contains("等待发送") }
                ui { check(list.bound(entry.requestId) === pending); set("textSends", null); invoke("renderPendingTextMessages", messages); (get("chatMessageScroll") as ChatMessageScroll).followLatest(true) }
                frames(); ui { check(list.atBottom()); check(full == 0) }; record("$kind: pending failed/retry payload retains row; explicit bottom resumes follow")
                val (media, fileEntry) = mediaFixture(token, viewer, base, cid)
                ui { set("mediaOutbox", media); invoke("renderPendingMediaMessages", messages); (get("chatMessageScroll") as ChatMessageScroll).followLatest(true) }
                await("pending file") { list.bound(fileEntry.requestId) != null }; frames()
                ui { pause(); list.view.scrollBy(0, -(36 * activity.resources.displayMetrics.density).toInt()) }; frames()
                var fileRow: View? = null; var fileAnchor: ChatRecyclerList.Anchor? = null
                ui { fileRow = list.bound(fileEntry.requestId); fileAnchor = list.capture(); check(fileRow != null) }
                for ((change, label) in listOf<Pair<() -> Unit, String>>(
                    ({ media.claim(cid); Unit }) to "正在上传", ({ media.uploaded(fileEntry, "{}"); media.committing(fileEntry); Unit }) to "正在发送",
                    ({ media.fail(fileEntry, "测试失败"); Unit }) to "点击重试", ({ media.retry(fileEntry); Unit }) to "等待发送")) {
                    change(); ui { invoke("renderPendingMediaMessages", messages) }
                    await("media phase $label") { list.bound(fileEntry.requestId)?.findViewById<TextView>(R.id.chat_pending_status)?.text.toString().contains(label) }; frames()
                    ui { check(list.bound(fileEntry.requestId) === fileRow); sameAnchor(list, fileAnchor) }
                }
                ui { set("mediaOutbox", null); invoke("renderPendingMediaMessages", messages) }
                record("$kind: pending media queued/uploading/committing/failed/retry states retain row and anchor")
                ui { messages.removeAllViews(); (get("currentMessageData") as MutableMap<*, *>).clear() }
                await("clear invalidates outstanding submissions") { list.adapter.itemCount <= 1 }
                ui { check(list.bound(quoteId) == null) }; record("$kind: clearing history removes stale and recalled rows")
            }
            val report = JSONObject().put("chat_v2", BuildConfig.CHAT_V2).put("checks", checks).put("environment", "isolated API 37 emulator; no production API/account")
            performanceStats?.let { stats ->
                report.put("performance", JSONObject().put("frames", stats.frames).put("p99_ms", stats.p99Ms)
                    .put("janky_frames", stats.jankyFrames).put("jank_percent", stats.jankPercent).put("passed", stats.passed))
            }
            File(targetContext.filesDir, "p1-result.json").writeText(report.toString(2))
            check(arguments.getString("perf") != "true" || performanceStats?.passed == true) {
                "P1 performance gate failed: $performanceStats; required p99 < 16ms and jank < 1%"
            }
            finish(Activity.RESULT_OK, Bundle().apply { putString("report", report.toString()) })
        } catch (error: Throwable) {
            val report = JSONObject().put("error", error.stackTraceToString()).put("checks", checks)
            performanceStats?.let { stats -> report.put("performance", JSONObject().put("frames", stats.frames)
                .put("p99_ms", stats.p99Ms).put("janky_frames", stats.jankyFrames).put("jank_percent", stats.jankPercent).put("passed", stats.passed)) }
            File(targetContext.filesDir, "p1-result.json").writeText(report.toString(2))
            finish(Activity.RESULT_CANCELED, Bundle().apply { putString("error", report.toString()) })
        } finally { gate.countDown(); if (::activity.isInitialized) ui { activity.finish() } }
    }
    private fun pause() {
        val event = MotionEvent.obtain(0, 0, MotionEvent.ACTION_SCROLL, 10f, 10f, 0)
        (get("chatMessageScroll") as ChatMessageScroll).onTouch(event); event.recycle(); set("chatLocateTarget", 0)
    }
    private fun sameAnchor(list: ChatRecyclerList, expected: ChatRecyclerList.Anchor?, tolerancePx: Int = 0) {
        val actual = list.capture()
        // Text line-height rounding at the bottom can differ by one physical pixel after a quote changes.
        check(actual?.key == expected?.key && actual != null && expected != null && kotlin.math.abs(actual.offset - expected.offset) <= tolerancePx) { "Reader moved: $expected -> $actual" }
    }
    private fun reveal(list: ChatRecyclerList, id: Int) {
        val done = CountDownLatch(1); var bound: View? = null
        ui { set("chatLocateTarget", id); list.reveal(id) { bound = it; done.countDown() } }
        check(done.await(10, TimeUnit.SECONDS)); check(bound != null) { "Locate failed for $id" }; frames()
    }
    private fun descendants(view: View): List<View> = listOf(view) + (view as? android.view.ViewGroup)?.let { group -> (0 until group.childCount).flatMap { descendants(group.getChildAt(it)) } }.orEmpty()
    private fun snapshot(view: View, name: String): String {
        var bitmap: Bitmap? = null
        ui { bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888).also { view.draw(Canvas(it)) } }
        val file = File(targetContext.filesDir, name); file.outputStream().use { bitmap!!.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap!!.recycle()
        return MessageDigest.getInstance("SHA-256").digest(file.readBytes()).joinToString("") { "%02x".format(it) }
    }
    private fun mediaFixture(token: String, viewer: Int, base: String, cid: Int): Pair<DurableMediaOutbox, DurableMediaOutbox.Entry> {
        val root = File(targetContext.cacheDir, "p1-fixture-${UUID.randomUUID()}").apply { mkdirs() }
        val storage = object : OutboxPersistence {
            var bytes: ByteArray? = null
            override fun read() = bytes
            override fun write(snapshot: ByteArray) { bytes = snapshot.copyOf() }
        }
        // This key exists only in this isolated fixture; production keystore code is untouched.
        val ciphers = object : OutboxAttachments.Ciphers {
            private fun cipher(mode: Int, iv: ByteArray?): Cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
                val key = SecretKeySpec(ByteArray(16), "AES")
                if (iv == null) init(mode, key) else init(mode, key, GCMParameterSpec(128, iv))
            }
            override fun encrypt(id: String) = cipher(Cipher.ENCRYPT_MODE, null)
            override fun decrypt(id: String, iv: ByteArray) = cipher(Cipher.DECRYPT_MODE, iv)
        }
        val queue = DurableMediaOutbox(storage, OutboxAttachments(File(root, "encrypted"), File(root, "scratch"), ciphers), token, viewer, base)
        val source = File(root, "fixture.bin").apply { writeBytes(byteArrayOf(1, 2, 3)) }
        return queue to queue.enqueue(UUID.randomUUID().toString(), cid, "file", "application/octet-stream", "fixture.bin", source, 0, 0)
    }
    private fun performance(list: ChatRecyclerList) {
        shell("dumpsys gfxinfo ${targetContext.packageName} reset")
        val descriptor = uiAutomation.executeShellCommand("perfetto -o /data/misc/perfetto-traces/p1-on.perfetto-trace -t 10s sched freq idle am wm gfx view binder_driver")
        val done = CountDownLatch(1)
        ui {
            pause(); var previous = 0f
            ValueAnimator.ofFloat(0f, 12000f).apply {
                duration = 10_000; interpolator = android.view.animation.LinearInterpolator()
                addUpdateListener { val value = it.animatedValue as Float; val direction = if ((value / 3000).toInt() % 2 == 0) -1 else 1; list.view.scrollBy(0, ((value - previous) * direction).toInt()); previous = value }
                addListener(object : AnimatorListenerAdapter() { override fun onAnimationEnd(animation: Animator) { done.countDown() } }); start()
            }
        }
        check(done.await(20, TimeUnit.SECONDS)); frames()
        File(targetContext.filesDir, "p1-perfetto.txt").writeText(ParcelFileDescriptor.AutoCloseInputStream(descriptor).bufferedReader().use { it.readText() })
        val gfxinfo = shell("dumpsys gfxinfo ${targetContext.packageName} framestats")
        File(targetContext.filesDir, "p1-gfxinfo.txt").writeText(gfxinfo)
        performanceStats = ChatFrameStats.parse(gfxinfo)
        record("10s 200-message scroll: $performanceStats; jank=${performanceStats!!.jankPercent}%; gate=${performanceStats!!.passed}")
    }
}

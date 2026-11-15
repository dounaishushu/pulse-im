package com.pulseim.android

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject

/** Run in a separate application ID with no saved accounts or live API. */
class ChatScrollProbe : Instrumentation() {
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); start() }
    override fun onStart() {
        val checks = JSONArray()
        var activity: Activity? = null
        try {
            activity = startActivitySync(Intent().setClassName(targetContext.packageName, MainActivity::class.java.name).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            val host = activity
            for (kind in listOf("direct", "group")) {
                lateinit var messages: LinearLayout
                lateinit var scroll: ScrollView
                lateinit var follower: ChatMessageScroll
                var current = true
                var revision = 1L
                fun ui(action: () -> Unit) = runOnMainSync(action)
                fun settle() { waitForIdleSync(); SystemClock.sleep(80); waitForIdleSync() }
                fun bottom(label: String) {
                    settle()
                    ui { check(messages.height - scroll.scrollY - scroll.height <= 2) { "$kind $label: bottom gap=${messages.height - scroll.scrollY - scroll.height}" } }
                    checks.put("$kind: $label")
                }
                fun row(height: Int = 100) = TextView(host).apply { text = "本地滚动测试"; layoutParams = LinearLayout.LayoutParams(-1, height) }
                fun readEarlier() {
                    ui {
                        val event = MotionEvent.obtain(0, 0, MotionEvent.ACTION_MOVE, 0f, 0f, 0)
                        follower.onTouch(event); event.recycle()
                        scroll.scrollTo(0, 400)
                    }
                    settle()
                }
                ui {
                    val root = FrameLayout(host)
                    messages = LinearLayout(host).apply { orientation = LinearLayout.VERTICAL; if (kind == "group") setPadding(16, 16, 16, 16) }
                    scroll = ScrollView(host).apply { isFillViewport = true; addView(messages) }
                    root.addView(scroll, FrameLayout.LayoutParams(-1, 500))
                    host.setContentView(root)
                    follower = ChatMessageScroll(messages, scroll, { current }, { revision })
                    repeat(65) { messages.addView(row()) }
                    follower.followLatest()
                }
                bottom("initial history")
                readEarlier()
                ui { messages.addView(row()); follower.followLatest() }
                bottom("own outgoing message from an earlier position")
                readEarlier()
                ui { messages.addView(row()); follower.followLatest() }
                bottom("incoming message from an earlier position")
                ui { messages.addView(row(10)); follower.followLatest() }
                bottom("photo placeholder")
                ui { messages.getChildAt(messages.childCount - 1).layoutParams = LinearLayout.LayoutParams(-1, 700) }
                bottom("late image height")
                ui { scroll.layoutParams = FrameLayout.LayoutParams(-1, 280) }
                bottom("keyboard viewport resize")
                ui {
                    val rows = (0 until messages.childCount).map(messages::getChildAt)
                    messages.removeAllViews(); rows.forEach(messages::addView)
                }
                bottom("temporary row replacement")
                readEarlier()
                ui { messages.getChildAt(messages.childCount - 1).layoutParams = LinearLayout.LayoutParams(-1, 900) }
                settle()
                ui { check(scroll.scrollY == 400) { "manual history position changed" } }
                checks.put("$kind: reader gesture pauses following")
                ui { follower.followLatest() }; bottom("new message resumes following")
                ui { revision++; scroll.scrollTo(0, 400); messages.requestLayout() }
                settle()
                ui { check(scroll.scrollY == 400) { "navigation retained an old follow intent" } }
                checks.put("$kind: navigation invalidates old follow intent")
                ui { follower.followLatest() }; bottom("following can restart for current navigation")
                ui { current = false; scroll.scrollTo(0, 400); messages.requestLayout() }
                settle()
                ui { check(scroll.scrollY == 400) { "inactive account still followed" }; follower.dispose() }
                checks.put("$kind: inactive account cannot move the viewport")
            }
            val result = JSONObject().put("passed", checks.length()).put("checks", checks)
            java.io.File(targetContext.filesDir, "scroll-probe-results.json").writeText(result.toString(2))
            finish(Activity.RESULT_OK, Bundle().apply { putString("scroll_checks", result.toString()) })
        } catch (error: Throwable) {
            finish(Activity.RESULT_CANCELED, Bundle().apply { putString("error", error.stackTraceToString()) })
        } finally { activity?.let { runOnMainSync { it.finish() } } }
    }
}

package com.pulseim.android

import android.app.Activity
import android.app.Dialog
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import java.util.concurrent.Executor
import org.json.JSONObject

/** A confirmed force-add opens contact details before an explicit private-chat action. */
internal class ForceAddedContactProfile(
    private val activity: Activity,
    private val peerId: Int,
    private val client: ApiClient,
    private val executor: Executor,
    private val current: () -> Boolean,
    mediaUrl: (String) -> String,
    private val opened: (JSONObject) -> Unit,
    private val closed: () -> Unit
) {
    private val dialog = BackSwipeDialog(activity, if (AppAppearance.dark) R.style.AppThemeDark else R.style.AppTheme)
    private var revision = 0L
    private var disposed = false
    private var busy = false
    private var loaded = false
    private val view = ContactProfileView(activity, mediaUrl, close = { dispose() }, share = {}, edit = {}, notifications = {}, block = {}, remove = {},
        send = { send() }, loadMedia = {}, loadGroups = {}, openMedia = {}, openGroup = {}, pageChanged = {}, profileOnly = true, retryProfile = { load() })

    fun show() {
        if (disposed || !current()) return
        (activity.getSystemService(Activity.INPUT_METHOD_SERVICE) as? android.view.inputmethod.InputMethodManager)?.hideSoftInputFromWindow(activity.currentFocus?.windowToken, 0)
        activity.currentFocus?.clearFocus()
        view.id = R.id.force_contact_profile
        dialog.setContentView(view)
        dialog.onSwipeBack = { dispose() }
        dialog.swipeBackEnabled = { live() && !busy }
        dialog.swipePageIdentity = { view.page }
        dialog.setOnDismissListener { if (!disposed) { disposed = true; revision++; closed() } }
        dialog.setOnKeyListener { _, key, event -> if (key == KeyEvent.KEYCODE_BACK && event.action == KeyEvent.ACTION_UP) { dispose(); true } else false }
        dialog.show()
        dialog.window?.apply {
            setLayout(-1, -1); setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT)); clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            statusBarColor = 0xFFA7ABB5.toInt(); navigationBarColor = AppAppearance.background(0xFFF7F7F7.toInt())
            decorView.systemUiVisibility = if (AppAppearance.dark) 0 else View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        }
        load()
    }

    private fun live() = !disposed && dialog.isShowing && current() && !activity.isFinishing && !activity.isDestroyed
    private fun load() {
        if (!live() || busy) return
        val request = ++revision; busy = true; loaded = false; view.accept(JSONObject(), false); view.pending(true)
        executor.execute {
            try {
                check(live()) { "页面已切换" }
                val profile = client.contactProfile(peerId)
                check(exactId(profile, "user_id", peerId)) { "联系人资料响应无效" }
                activity.runOnUiThread { if (live() && request == revision) { busy = false; loaded = true; view.accept(profile, false) } }
            } catch (_: Exception) {
                activity.runOnUiThread { if (live() && request == revision) { busy = false; view.showError("好友已添加，资料加载失败，请重新加载资料") } }
            }
        }
    }

    private fun send() {
        if (!live() || busy || !loaded) return
        val request = ++revision; busy = true; view.pending(true)
        executor.execute {
            try {
                check(live()) { "页面已切换" }
                val created = client.createDirectConversation(peerId)
                val id = created.optInt("id")
                check(id > 0 && exactId(created, "id", id) && created.opt("type") == "direct" && exactId(created, "peer_user_id", peerId)) { "私聊响应无效" }
                check(live()) { "页面已切换" }
                val conversation = client.openConversation(id)
                check(exactId(conversation, "id", id) && conversation.opt("type") == "direct" && exactId(conversation, "peer_user_id", peerId)) { "私聊目标不匹配" }
                activity.runOnUiThread { if (live() && request == revision) { dispose(); opened(conversation) } }
            } catch (_: Exception) {
                activity.runOnUiThread { if (live() && request == revision) { busy = false; view.showError("打开私聊失败，请重试发消息") } }
            }
        }
    }

    fun dispose() {
        if (disposed) return
        disposed = true; revision++; dialog.dismiss(); closed()
    }

    companion object {
        fun exactId(value: JSONObject, key: String, expected: Int): Boolean {
            val number = value.opt(key) as? Number ?: return false
            return expected > 0 && number.toDouble() == expected.toDouble()
        }
        fun accepted(value: JSONObject, peerId: Int) = value.opt("status") == "accepted" && value.opt("forced") == true && exactId(value, "user_id", peerId)
    }
}

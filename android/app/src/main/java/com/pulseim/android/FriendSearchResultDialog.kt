package com.pulseim.android

import android.app.Dialog
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject

internal class FriendSearchResultDialog(
    context: Context,
    private val users: JSONArray,
    private val selfId: Int,
    private val loadAvatar: (ImageView, String) -> Unit,
    private val onAdd: (JSONObject) -> Unit,
    private val title: String = "搜索结果",
    private val onMessage: ((JSONObject) -> Unit)? = null,
    private val onRequest: ((JSONObject, (Boolean, String?) -> Unit) -> Unit)? = null
) : Dialog(context) {
    private fun dp(value: Int) = (value * context.resources.displayMetrics.density + .5f).toInt()
    private fun background(color: Int, radius: Int) = GradientDrawable().apply { setColor(color); cornerRadius = dp(radius).toFloat() }
    private fun label(value: String, size: Float, color: Int = 0xFF263746.toInt()) = TextView(context).apply { text = value; textSize = size; setTextColor(color) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestWindowFeature(Window.FEATURE_NO_TITLE)
        val root = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            background = background(Color.WHITE, 12)
            clipToOutline = true
            addView(label(title, 20f).apply { setTypeface(typeface, android.graphics.Typeface.BOLD); setPadding(dp(20), dp(20), dp(20), dp(8)) })
        }
        val rows = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), 0, dp(20), dp(4)) }
        for (index in 0 until users.length()) rows.addView(result(users.getJSONObject(index)))
        root.addView(object : ScrollView(context) {
            override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
                val maxHeight = (context.resources.displayMetrics.heightPixels * .60f).toInt()
                super.onMeasure(widthMeasureSpec, View.MeasureSpec.makeMeasureSpec(maxHeight, View.MeasureSpec.AT_MOST))
            }
        }.apply { addView(rows) }, LinearLayout.LayoutParams(-1, -2))
        root.addView(LinearLayout(context).apply {
            gravity = Gravity.END
            setPadding(dp(12), 0, dp(12), dp(8))
            addView(Button(context).apply {
                text = "取消"; setTextColor(0xFF2785D7.toInt()); background = ColorDrawable(Color.TRANSPARENT)
                setOnClickListener { dismiss() }
            }, LinearLayout.LayoutParams(dp(76), dp(44)))
        }, LinearLayout.LayoutParams(-1, -2))
        setContentView(root)
        window?.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN or WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
    }

    override fun onStart() {
        super.onStart()
        window?.setLayout(minOf(dp(420), context.resources.displayMetrics.widthPixels - dp(32)), ViewGroup.LayoutParams.WRAP_CONTENT)
    }

    private fun result(user: JSONObject): View {
        val userId = user.optInt("id")
        val name = user.optString("nickname", "用户").ifBlank { "用户" }
        val card = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL; setPadding(0, dp(12), 0, dp(12)) }
        val profile = LinearLayout(context).apply { gravity = Gravity.CENTER_VERTICAL }
        profile.addView(FrameLayout(context).apply {
            id = R.id.friend_search_avatar
            contentDescription = "$name 的头像"
            background = background(0xFFE8F2FF.toInt(), 28); clipToOutline = true
            addView(label(name.take(1), 22f, 0xFF2785D7.toInt()).apply { gravity = Gravity.CENTER }, FrameLayout.LayoutParams(-1, -1))
            val raw = if (user.isNull("avatar_url")) "" else user.optString("avatar_url")
            if (raw.isNotBlank()) addView(ImageView(context).apply {
                scaleType = ImageView.ScaleType.CENTER_CROP; importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
                loadAvatar(this, raw)
            }, FrameLayout.LayoutParams(-1, -1))
        }, LinearLayout.LayoutParams(dp(56), dp(56)).apply { rightMargin = dp(12) })
        profile.addView(LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            addView(label(name, 17f).apply { id = R.id.friend_search_name; setTypeface(typeface, android.graphics.Typeface.BOLD) })
            val username = if (user.isNull("username")) "" else user.optString("username")
            if (username.isNotBlank()) addView(label("用户名：$username", 13f, 0xFF6E7C89.toInt()))
            addView(label("用户 ID：${PublicUserId.display(user.opt("public_id"))}", 12f, 0xFF6E7C89.toInt()).apply { id = R.id.friend_search_public_id })
        }, LinearLayout.LayoutParams(0, -2, 1f))
        card.addView(profile, LinearLayout.LayoutParams(-1, -2))
        card.addView(LinearLayout(context).apply {
            gravity = Gravity.END; setPadding(0, dp(10), 0, 0)
            addView(Button(context).apply {
                this.id = R.id.friend_search_add
                var contact = user.optBoolean("is_contact") && onMessage != null
                val canAdd = user.optBoolean("can_add_friend", true)
                isEnabled = userId > 0 && userId != selfId && (contact || canAdd)
                text = if (userId == selfId) "这是你自己" else if (contact) "发送消息" else if (!canAdd) "暂不能添加" else "添加好友"
                contentDescription = if (contact) "发送消息：$name" else "添加好友：$name"
                setTextColor(if (isEnabled) Color.WHITE else 0xFF83909D.toInt())
                background = background(if (isEnabled) 0xFF2785D7.toInt() else 0xFFEDF1F5.toInt(), 6)
                setPadding(dp(14), 0, dp(14), 0); textSize = 14f; minHeight = 0
                setOnClickListener {
                    if (userId <= 0 || userId == selfId) return@setOnClickListener
                    if (!contact && onRequest != null) {
                        isEnabled = false; text = "处理中…"
                        onRequest.invoke(user) { added, error ->
                            if (!isShowing || !isAttachedToWindow) return@invoke
                            if (error != null) {
                                text = "添加好友"; isEnabled = canAdd
                                android.widget.Toast.makeText(context, error, android.widget.Toast.LENGTH_LONG).show()
                            } else {
                                contact = added; user.put("is_contact", added)
                                text = if (added) "聊天" else "已申请添加好友"
                                contentDescription = text.toString(); isEnabled = added
                            }
                        }
                        return@setOnClickListener
                    }
                    isEnabled = false; dismiss(); if (contact) onMessage?.invoke(user) else onAdd(user)
                }
            }, LinearLayout.LayoutParams(if (title == "联系人名片") -1 else -2, dp(44)))
        }, LinearLayout.LayoutParams(-1, -2))
        val restriction = user.optString("add_friend_restriction").takeUnless { user.isNull("add_friend_restriction") || it.isBlank() }
        if (!restriction.isNullOrEmpty() && !user.optBoolean("is_contact")) card.addView(label(restriction, 12f, 0xFF6E7C89.toInt()))
        return card
    }
}

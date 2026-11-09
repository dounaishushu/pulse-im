package com.pulseim.android

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.widget.*
import org.json.JSONObject

/** Contact pages retain the live chat underneath; no chat state is recreated. */
internal class ContactProfileView(
    context: Context,
    private val mediaUrl: (String) -> String,
    private val close: () -> Unit,
    private val share: (JSONObject) -> Unit,
    private val edit: () -> Unit,
    private val notifications: (Boolean) -> Unit,
    private val block: (Boolean) -> Unit,
    private val remove: () -> Unit,
    private val send: () -> Unit,
    private val loadMedia: (Int) -> Unit,
    private val loadGroups: (Int) -> Unit,
    private val openMedia: (JSONObject) -> Unit,
    private val openGroup: (JSONObject) -> Unit,
    private val pageChanged: (Page) -> Unit,
    private val groupContext: Boolean = false,
    private val profileOnly: Boolean = false,
    private val retryProfile: (() -> Unit)? = null
) : FrameLayout(context) {
    enum class Page { PROFILE, MORE, MEDIA, GROUPS }
    var page = Page.PROFILE; private set
    var generation = 0L; private set
    private var profile = JSONObject()
    private var enabledNotifications = true
    private var busy = false
    private var loadedPage = 0
    private var total = 0
    private val rows = mutableListOf<JSONObject>()
    private var error = ""
    private val bg = 0xFFF7F7F7.toInt()
    private val muted = 0xFF999999.toInt()
    private val blue = 0xFF0733F4.toInt()
    private fun px(value: Float) = (value * resources.displayMetrics.density + .5f).toInt()
    private fun dp(value: Int) = px(value.toFloat())
    private fun scaled(value: Float) = px(value * resources.displayMetrics.widthPixels / resources.displayMetrics.density / 400f)
    private fun text(value: String, size: Float = 17f, color: Int = Color.BLACK) = TextView(context).apply {
        text = value; textSize = size; setTextColor(AppAppearance.ink(color)); includeFontPadding = false
    }
    private fun shape(color: Int, radius: Int = 12) = GradientDrawable().apply { setColor(AppAppearance.background(color)); cornerRadius = dp(radius).toFloat() }
    private fun column() = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    private fun label(key: String) = profile.optString(key).takeUnless { it == "null" }.orEmpty()
    fun accept(value: JSONObject, notificationsEnabled: Boolean) {
        profile = value; enabledNotifications = notificationsEnabled; busy = false; error = ""; render()
    }
    fun pending(value: Boolean) { busy = value; render() }
    fun showError(message: String) { busy = false; error = message; render() }
    fun handleBack(): Boolean {
        generation++
        when (page) {
            Page.PROFILE -> close()
            Page.MORE -> { page = Page.PROFILE; render() }
            else -> { page = Page.MORE; render() }
        }
        return true
    }
    fun acceptRows(target: Page, number: Int, data: JSONObject) {
        if (page != target) return
        if (number == 1) rows.clear()
        val items = data.optJSONArray("items")
        if (items != null) for (i in 0 until items.length()) {
            val item = items.getJSONObject(i)
            if (rows.none { it.optInt("id") == item.optInt("id") }) rows.add(item)
        }
        loadedPage = number; total = data.optInt("total", rows.size); if (target == Page.GROUPS) profile.put("common_group_count", total)
        busy = false; error = ""; render()
    }
    private fun navigate(target: Page) {
        generation++
        page = target; rows.clear(); loadedPage = 0; total = 0; busy = target == Page.MEDIA || target == Page.GROUPS; error = ""; render()
        if (target == Page.MEDIA) loadMedia(1)
        if (target == Page.GROUPS) loadGroups(1)
    }
    private fun header(title: String, white: Boolean): FrameLayout = FrameLayout(context).apply {
        val color = if (white) Color.WHITE else Color.BLACK
        addView(text(title, 19f, color).apply { gravity = Gravity.CENTER; typeface = Typeface.DEFAULT_BOLD }, LayoutParams(-1, -1))
        addView(FrameLayout(context).apply {
            id = R.id.contact_profile_back; contentDescription = "返回"; isClickable = true; setOnClickListener { handleBack() }
            addView(ChatStyleIconView(context, "back", color), LayoutParams(dp(25), dp(25), Gravity.CENTER))
        }, LayoutParams(dp(58), -1, Gravity.START))
        if (white && !groupContext && !profileOnly) addView(FrameLayout(context).apply {
            id = R.id.contact_profile_share; contentDescription = "分享联系人"; isClickable = true; setOnClickListener { if (profile.length() > 0) share(profile) }
            addView(ChatStyleIconView(context, "share", Color.WHITE), LayoutParams(dp(27), dp(27), Gravity.CENTER))
        }, LayoutParams(dp(58), -1, Gravity.END))
    }
    private fun cardRow(title: String, subtitle: String = "", idValue: Int, arrow: Boolean = false, right: String = "", action: (() -> Unit)? = null, switchValue: Boolean? = null, switchAction: ((Boolean) -> Unit)? = null): LinearLayout {
        return LinearLayout(context).apply {
            id = idValue; orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(18), 0, dp(14), 0); minimumHeight = scaled(if (subtitle.isNotEmpty()) 68f else 58f)
            addView(column().apply {
                gravity = Gravity.CENTER_VERTICAL
                addView(text(title, 17f))
                if (subtitle.isNotEmpty()) addView(text(subtitle, 14f, muted).apply { setPadding(0, dp(5), 0, 0); maxLines = 1; ellipsize = TextUtils.TruncateAt.END })
            }, LinearLayout.LayoutParams(0, -2, 1f))
            if (right.isNotEmpty()) addView(text(right, 17f, 0xFF1743AD.toInt()).apply { setPadding(dp(6), 0, dp(6), 0) })
            if (switchValue != null) addView(Switch(context).apply {
                isChecked = switchValue; isEnabled = !busy; contentDescription = title
                thumbTintList = ColorStateList(arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf()), intArrayOf(0xFF008D81.toInt(), 0xFFEEEEEE.toInt()))
                trackTintList = ColorStateList(arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf()), intArrayOf(0xFF9DD6D0.toInt(), 0xFFAAAAAA.toInt()))
                setOnCheckedChangeListener { _, checked -> if (!busy) switchAction?.invoke(checked) }
            }, LinearLayout.LayoutParams(dp(48), dp(40)))
            if (arrow) addView(ChatStyleIconView(context, "chevron", 0xFFB5B5B5.toInt()), LinearLayout.LayoutParams(dp(22), dp(22)))
            if (action != null) { isClickable = true; isEnabled = !busy; setOnClickListener { action() } }
        }
    }
    private fun addLine(card: LinearLayout) { card.addView(View(context).apply { setBackgroundColor(AppAppearance.background(0xFFEEEEEE.toInt())) }, LinearLayout.LayoutParams(-1, dp(1)).apply { leftMargin = dp(18) }) }
    private fun render() {
        pageChanged(page)
        removeAllViews(); setBackgroundColor(AppAppearance.background(bg))
        val body = column()
        val scroll = ScrollView(context).apply { isFillViewport = true; clipToPadding = false; addView(body, FrameLayout.LayoutParams(-1, -2)) }
        addView(scroll, LayoutParams(-1, -1))
        if (page == Page.PROFILE) {
            val coverHeight = (resources.displayMetrics.widthPixels * .75f).toInt()
            val avatarSize = (resources.displayMetrics.widthPixels * .21f).toInt()
            val hero = FrameLayout(context).apply { setBackgroundColor(AppAppearance.background(Color.WHITE)) }
            hero.addView(ImageView(context).apply {
                id = R.id.contact_profile_cover; scaleType = ImageView.ScaleType.CENTER_CROP; setBackgroundColor(0xFFA7ABB5.toInt())
                val res = resources.getIdentifier("contact_profile_cover", "drawable", context.packageName)
                if (res != 0) setImageResource(res)
            }, LayoutParams(-1, coverHeight))
            hero.addView(header("个人信息", true), LayoutParams(-1, dp(68)))
            val avatar = FrameLayout(context).apply {
                id = R.id.contact_profile_avatar; background = shape(0xFF51CC23.toInt(), 13); clipToOutline = true
                addView(text(label("nickname").take(1).ifBlank { "友" }, 22f, Color.WHITE).apply { gravity = Gravity.CENTER; typeface = Typeface.DEFAULT_BOLD }, LayoutParams(-1, -1))
                if (label("avatar_url").isNotBlank()) addView(ImageView(context).apply { scaleType = ImageView.ScaleType.CENTER_CROP; ChatAvatars.bind(this, mediaUrl(label("avatar_url"))) }, LayoutParams(-1, -1))
            }
            hero.addView(avatar, LayoutParams(avatarSize, avatarSize, Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply { topMargin = coverHeight - avatarSize / 2 })
            val summary = column().apply {
                gravity = Gravity.CENTER_HORIZONTAL
                addView(text(label("nickname").ifBlank { "用户" }, 20f).apply { id = R.id.contact_profile_name; maxLines = 1; ellipsize = TextUtils.TruncateAt.END; typeface = Typeface.DEFAULT_BOLD; gravity = Gravity.CENTER; setPadding(dp(20), 0, dp(20), 0) }, LinearLayout.LayoutParams(-1, -2))
                val seen = when {
                    profile.optBoolean("online") -> "在线"
                    profile.optBoolean("last_seen_hidden") -> "最近在线时间不可见"
                    label("last_seen_at").isNotBlank() -> "最近在线 ${label("last_seen_at").replace('T', ' ').take(16)}"
                    else -> "暂无最近在线时间"
                }
                addView(text(seen, 14f, muted).apply { id = R.id.contact_profile_seen; gravity = Gravity.CENTER; setPadding(0, dp(10), 0, 0) })
                addView(text("用户 ID：${PublicUserId.display(profile.opt("public_id"))}", 14f, muted).apply { id = R.id.contact_profile_public_id; gravity = Gravity.CENTER; setPadding(dp(12), dp(8), dp(12), 0); maxLines = 2; setTag(R.id.appearance_user_content, true) })
            }
            hero.addView(summary, LayoutParams(-1, -2, Gravity.TOP).apply { topMargin = coverHeight + avatarSize / 2 + scaled(39f) })
            body.addView(hero, LinearLayout.LayoutParams(-1, coverHeight + scaled(183f)))
            val card = column().apply { background = shape(Color.WHITE, 10) }
            if (!groupContext && !profileOnly) {
                card.addView(cardRow("分组和备注", label("group_name").ifBlank { if (profile.optBoolean("is_contact")) "我的好友" else "非联系人" }, R.id.contact_profile_remark, arrow = true, action = edit)); addLine(card)
                card.addView(cardRow("消息通知", if (enabledNotifications) "开启" else "关闭", R.id.contact_profile_notifications, switchValue = enabledNotifications, switchAction = notifications)); addLine(card)
            }
            if (!profileOnly) {
                card.addView(cardRow("更多信息", idValue = R.id.contact_profile_more, arrow = true, action = { navigate(Page.MORE) }))
                body.addView(card, LinearLayout.LayoutParams(-1, -2).apply { setMargins(dp(14), dp(14), dp(14), 0) })
            }
            if (!profileOnly && !profile.optBoolean("is_contact")) body.addView(text(if (profile.optBoolean("request_sent")) "好友申请已发送" else "添加联系人", 17f, 0xFFF66B4F.toInt()).apply {
                id = R.id.contact_profile_delete; gravity = Gravity.CENTER_VERTICAL; setPadding(dp(18), 0, dp(18), 0); background = shape(Color.WHITE, 12)
                isEnabled = !busy && !profile.optBoolean("request_sent") && (!groupContext || profile.optBoolean("can_add_friend")); setOnClickListener { if (isEnabled && !profile.optBoolean("is_contact")) remove() }
            }, LinearLayout.LayoutParams(-1, scaled(58f)).apply { setMargins(dp(14), dp(14), dp(14), 0) })
            if (profileOnly && error.isNotEmpty()) body.addView(text(error, 14f, 0xFFE45A5A.toInt()).apply { id = R.id.force_contact_error; setPadding(dp(20), dp(12), dp(20), dp(12)); gravity = Gravity.CENTER })
            if (profileOnly && error.isNotEmpty() && retryProfile != null) body.addView(Button(context).apply {
                id = R.id.force_contact_retry; text = "重新加载资料"; isEnabled = !busy; setOnClickListener { retryProfile.invoke() }
            }, LinearLayout.LayoutParams(-1, dp(48)).apply { setMargins(dp(18), dp(8), dp(18), 0) })
            if (profileOnly && busy) body.addView(text("正在加载…", 14f, muted).apply { id = R.id.force_contact_loading; gravity = Gravity.CENTER }, LinearLayout.LayoutParams(-1, dp(40)))
            body.addView(text(if (groupContext && !profile.optBoolean("is_contact")) { if (profile.optBoolean("request_sent")) "好友申请已发送" else if (profile.optBoolean("can_add_friend")) "添加好友" else "暂不可添加好友" } else "发消息", 20f, Color.WHITE).apply {
                id = R.id.contact_profile_send; gravity = Gravity.CENTER; background = shape(blue, 40); isEnabled = !busy && profile.optInt("user_id") > 0 && !(groupContext && !profile.optBoolean("is_contact") && (profile.optBoolean("request_sent") || !profile.optBoolean("can_add_friend"))); setOnClickListener { if (isEnabled) send() }
            }, LinearLayout.LayoutParams(-1, scaled(54f)).apply { setMargins(dp(18), dp(14), dp(18), dp(16)) })
        } else {
            body.addView(header(when (page) { Page.MORE -> "更多信息"; Page.MEDIA -> "共享媒体"; else -> "共同加入的群组" }, false).apply { setBackgroundColor(AppAppearance.background(Color.WHITE)) }, LinearLayout.LayoutParams(-1, dp(70)))
            val card = column().apply { background = shape(Color.WHITE, 6) }
            if (page == Page.MORE) {
                if (!groupContext) { card.addView(cardRow("共享媒体", idValue = R.id.contact_more_media, arrow = true, action = { navigate(Page.MEDIA) }).apply { setBackgroundColor(AppAppearance.background(0xFFEEEEEE.toInt())) }); addLine(card) }
                card.addView(cardRow("共同加入的群组", idValue = R.id.contact_more_groups, arrow = true, right = profile.optInt("common_group_count").toString(), action = { navigate(Page.GROUPS) }).apply { setBackgroundColor(AppAppearance.background(0xFFEEEEEE.toInt())) }); addLine(card)
                card.addView(cardRow("好友来源", label("friend_source_label").ifBlank { "未知" }, R.id.contact_more_source))
            } else {
                rows.forEach { item ->
                    if (page == Page.GROUPS) card.addView(cardRow(item.optString("name", "群组"), "${item.optInt("member_count")} 位成员", R.id.contact_common_group, arrow = !groupContext, action = if (groupContext) null else ({ openGroup(item) })))
                    else {
                        val bodyData = item.optJSONObject("body") ?: JSONObject()
                        val name = bodyData.optString("name").takeUnless { it.isBlank() || it == "null" } ?: when (item.optString("type")) { "image" -> "图片"; "video" -> "视频文件"; "voice" -> "语音消息"; else -> "文件" }
                        card.addView(cardRow(name, item.optString("created_at").replace('T', ' '), R.id.contact_shared_item, arrow = true, action = { openMedia(item) }))
                    }
                    addLine(card)
                }
                if (rows.isEmpty()) card.addView(cardRow(if (busy) "正在加载…" else if (page == Page.MEDIA) "暂无共享媒体" else "暂无共同加入的群组", idValue = View.NO_ID))
                if (rows.size < total) card.addView(cardRow(if (busy) "正在加载…" else "加载更多", idValue = R.id.contact_profile_load_more, action = {
                    if (!busy) { busy = true; render(); if (page == Page.MEDIA) loadMedia(loadedPage + 1) else loadGroups(loadedPage + 1) }
                }))
            }
            body.addView(card, LinearLayout.LayoutParams(-1, -2).apply { setMargins(dp(14), dp(14), dp(14), dp(20)) })
        }
        if (error.isNotEmpty() && !profileOnly) body.addView(text(error, 14f, 0xFFE45A5A.toInt()).apply { setPadding(dp(20), dp(12), dp(20), dp(12)) })
    }
}

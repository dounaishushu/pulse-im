package com.pulseim.android

import android.content.Context
import android.graphics.*
import android.view.Gravity
import android.view.View
import android.widget.*
import org.json.JSONArray
import org.json.JSONObject

internal const val MY_BLUE = 0xFF0633DD.toInt()

/** Scrollable native controls preserve the supplied spacing on tall and short displays. */
internal class MyScreen(
    context: Context, val page: String, user: JSONObject, accounts: JSONArray,
    private val resolveAvatar: (String) -> String, private val action: (String) -> Unit,
    private val navigate: (String) -> Unit
) : ChatScreen(context) {
    val panel = LinearLayout(context).apply { orientation = VERTICAL }
    val status = label("", 13f, 0xFFC44545.toInt()).apply { id = R.id.my_status; gravity = Gravity.CENTER; visibility = GONE; accessibilityLiveRegion = ACCESSIBILITY_LIVE_REGION_POLITE }
    private val body = FrameLayout(context)
    private val scroll = ScrollView(context).apply { isFillViewport = true; isVerticalScrollBarEnabled = false; addView(panel) }
    private val backgroundColor = if (page != "home") 0xFFF7F7F7.toInt() else CHAT_BG
    private var qrCard: MyQrCard? = null
    private var qrSave: TextView? = null
    init {
        id = R.id.my_screen
        setBackgroundColor(AppAppearance.background(backgroundColor))
        setWillNotDraw(false)
        if (page == "home") {
            addView(FrameLayout(context).apply {
                setBackgroundColor(Color.WHITE)
                addView(label("我的", 20f).apply { id = R.id.my_title; typeface = Typeface.DEFAULT_BOLD; gravity = Gravity.CENTER_VERTICAL }, FrameLayout.LayoutParams(-1, -1).apply { leftMargin = px(40) })
                addView(MyGlyph(context, "qr", Color.BLACK).apply { id = R.id.my_qr; contentDescription = "我的二维码"; setOnClickListener { action("qr") } }, FrameLayout.LayoutParams(px(52), px(52), Gravity.END or Gravity.CENTER_VERTICAL).apply { rightMargin = px(50) })
            }, LayoutParams(-1, px(128)))
            val profile = LinearLayout(context).apply {
                id = R.id.my_profile; gravity = Gravity.CENTER_VERTICAL; setPadding(px(58), px(28), px(58), px(28)); setBackgroundColor(Color.WHITE)
                addView(photo(user, 132, R.id.my_avatar))
                addView(LinearLayout(context).apply {
                    orientation = VERTICAL
                    addView(label(display(user, "nickname"), 18f).apply { id = R.id.my_nickname; typeface = Typeface.DEFAULT_BOLD; setTag(R.id.appearance_user_content, true) })
                    addView(label("账号：${display(user, "username")}", 14.5f, CHAT_GREY).apply { id = R.id.my_username }, LayoutParams(-1, -2).apply { topMargin = px(19) })
                    addView(label("用户 ID：${PublicUserId.display(user.opt("public_id"))}", 14.5f, CHAT_GREY).apply { id = R.id.my_public_id; setTag(R.id.appearance_user_content, true); maxLines = 2 }, LayoutParams(-1, -2).apply { topMargin = px(10) })
                }, LayoutParams(0, -2, 1f).apply { leftMargin = px(30) })
                addView(MyGlyph(context, "chevron", 0xFFCACBCD.toInt()), LayoutParams(px(28), px(40)))
                setOnClickListener { action("profile") }
            }
            addView(profile, LayoutParams(-1, px(270)))
        } else {
            val title = when (page) { "phone-privacy" -> "手机号码"; "invite-privacy" -> "邀请权限控制"; "blocked" -> "已屏蔽的用户"; "block-picker" -> "屏蔽用户"; "two-step", "two-step-setup", "two-step-confirm", "two-step-success", "two-step-change", "two-step-delete", "two-step-recovery" -> "两步验证"; "passcode" -> "锁定码"; "profile" -> "编辑资料"; "accounts" -> "添加账号"; "qr" -> "我的二维码"; "appearance" -> "外观显示"; "privacy" -> "隐私安全"; "notifications" -> "通知声音"; "language" -> "语言设置"; else -> "我的" }
            addView(FrameLayout(context).apply {
                setBackgroundColor(Color.WHITE)
                addView(label(title, 19f).apply { id = R.id.my_title; gravity = Gravity.CENTER; typeface = if (page in PrivacyFeature.pages) Typeface.DEFAULT else Typeface.DEFAULT_BOLD }, FrameLayout.LayoutParams(-1, -1))
                addView(ContactIconView(context, "back", CHAT_INK).apply {
                    id = R.id.my_back; contentDescription = "返回"; setPadding(px(41), px(35), px(41), px(35)); setOnClickListener { action("back") }
                }, FrameLayout.LayoutParams(px(140), -1, Gravity.START))
                if (page == "appearance") addView(label("完成", 17f, MY_BLUE).apply {
                    id = R.id.appearance_done; gravity = Gravity.CENTER; setOnClickListener { action("appearance-done") }
                }, FrameLayout.LayoutParams(px(160), -1, Gravity.END))
                if (page == "block-picker") addView(ContactIconView(context, "search", CHAT_INK).apply { id = R.id.privacy_search_button; contentDescription = "搜索用户"; setPadding(px(41), px(35), px(41), px(35)); setOnClickListener { action("block-search") } }, FrameLayout.LayoutParams(px(140), -1, Gravity.END))
            }, LayoutParams(-1, px(128)))
        }
        panel.addView(status, LayoutParams(-1, -2))
        body.setBackgroundColor(backgroundColor)
        body.addView(scroll, FrameLayout.LayoutParams(-1, -1))
        if (page == "home") buildHome()
        if (page == "profile") buildProfile(user)
        if (page == "accounts") buildAccounts(user, accounts)
        if (page == "appearance") panel.addView(MyAppearancePanel(context) { action("theme:$it") })
        if (page == "qr") {
            qrCard = MyQrCard(context, user, resolveAvatar)
            panel.addView(qrCard, LayoutParams(-1, -2).apply { setMargins(px(37), px(44), px(37), px(40)) })
        }
        addView(body, LayoutParams(-1, 0, 1f))
        if (page == "qr") {
            qrSave = label("保存二维码", 18f, Color.WHITE).apply {
                id = R.id.my_qr_save; gravity = Gravity.CENTER; background = surface(MY_BLUE, 58)
                isEnabled = qrCard?.ready == true; alpha = if (isEnabled) 1f else .6f
                setOnClickListener { action("qr-save") }
            }
            addView(qrSave, LayoutParams(-1, maxOf(px(116), dp(48))).apply { setMargins(px(58), px(14), px(58), px(40)) })
        }
        if (page == "home") addView(ContactsNavigation(context, "me", navigate))
    }
    private fun display(user: JSONObject, name: String) = jsonText(user, name)
    private fun photo(user: JSONObject, size: Int, viewId: Int) = FrameLayout(context).apply {
        id = viewId; background = surface(0xFFF68A42.toInt(), 24); clipToOutline = true
        addView(label(display(user, "nickname").take(1), if (size > 160) 28f else 20f, Color.WHITE).apply { gravity = Gravity.CENTER; typeface = Typeface.DEFAULT_BOLD; setTag(R.id.appearance_user_content, true) }, FrameLayout.LayoutParams(-1, -1))
        val url = jsonText(user, "avatar_url")
        if (url.isNotBlank()) addView(ImageView(context).apply { scaleType = ImageView.ScaleType.CENTER_CROP; ChatAvatars.bind(this, resolveAvatar(url)) }, FrameLayout.LayoutParams(-1, -1))
        layoutParams = LayoutParams(px(size), px(size))
    }
    private fun buildHome() {
        val main = card(22)
        listOf(Triple("appearance", "外观显示", R.id.my_appearance), Triple("privacy", "隐私安全", R.id.my_privacy),
            Triple("notifications", "通知声音", R.id.my_notifications), Triple("language", "语言设置", R.id.my_language)).forEachIndexed { i, (key, title, id) ->
            row(main, title, "", id, key, i == 4) { action(key) }
        }
        val support = card(34)
        row(support, "清除缓存", "", R.id.my_clear_cache, "cache") { action("cache") }
        row(support, "上传日志", "", R.id.my_upload_logs, "upload", true) { action("logs") }
        panel.addView(Space(context), LayoutParams(-1, 0, 1f))
        val version = context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: ""
        panel.addView(label("${context.getString(R.string.app_name)} v$version", 13.5f, CHAT_GREY).apply { id = R.id.my_version; gravity = Gravity.CENTER }, LayoutParams(-1, px(90)).apply { topMargin = px(30); bottomMargin = px(9) })
    }
    private fun buildProfile(user: JSONObject) {
        val upper = LinearLayout(context).apply { orientation = VERTICAL; setBackgroundColor(Color.WHITE) }
        val avatar = photo(user, 204, R.id.profile_avatar).apply {
            getChildAt(0).visibility = GONE
            contentDescription = "上传头像"; setOnClickListener { action("avatar") }
            addView(MyGlyph(context, "avatar_add", CHAT_INK), FrameLayout.LayoutParams(px(52), px(52), Gravity.CENTER))
        }
        upper.addView(avatar, LayoutParams(px(204), px(204)).apply { gravity = Gravity.CENTER_HORIZONTAL; topMargin = px(51) })
        val bio = LinearLayout(context).apply {
            id = R.id.profile_signature; gravity = Gravity.CENTER_VERTICAL; background = surface(0xFFF7F6FC.toInt(), 16); setPadding(px(44), 0, px(44), 0)
            addView(MyGlyph(context, "bio", 0xFFDAD5F8.toInt()), LayoutParams(px(49), px(49)))
            addView(label(display(user, "signature").ifBlank { "修改个人简介，让人们更了解你" }, 15.5f, CHAT_GREY).apply { maxLines = 2; setTag(R.id.appearance_user_content, display(user, "signature").isNotBlank()) }, LayoutParams(0, -2, 1f).apply { leftMargin = px(29) })
            addView(MyGlyph(context, "edit", CHAT_GREY), LayoutParams(px(30), px(30)))
            setOnClickListener { action("signature") }
        }
        upper.addView(bio, LayoutParams(-1, px(110)).apply { setMargins(px(49), px(50), px(49), px(70)) })
        row(upper, "用户 ID", PublicUserId.display(user.opt("public_id")), R.id.profile_public_id)
        listOf(Triple("nickname", "昵称", R.id.profile_nickname), Triple("username", "账号", R.id.profile_username), Triple("password", "修改登录密码", R.id.profile_password),
            Triple("birthday", "生日", R.id.profile_birthday), Triple("gender", "性别", R.id.profile_gender)).forEachIndexed { i, (key, title, id) ->
            row(upper, title, if (key == "password") "" else display(user, key), id, null, i == 4) { action(key) }
        }
        panel.addView(upper)
        button("添加账号", R.id.profile_add_account) { action("accounts") }
        button("退出登录", R.id.profile_logout) { action("logout") }
        panel.addView(Space(context), LayoutParams(-1, px(310)))
    }
    private fun buildAccounts(user: JSONObject, accounts: JSONArray) {
        panel.addView(label("轻触头像以切换账号", 14f, CHAT_GREY).apply { setPadding(px(40), px(32), px(40), px(24)) })
        val card = LinearLayout(context).apply { id = R.id.accounts_list; orientation = VERTICAL; background = surface(Color.WHITE, 12) }
        panel.addView(card, LayoutParams(-1, -2).apply { setMargins(px(29), 0, px(29), 0) })
        for (i in 0 until accounts.length()) {
            val account = accounts.getJSONObject(i)
            val entry = LinearLayout(context).apply {
                id = R.id.account_row; gravity = Gravity.CENTER_VERTICAL; setPadding(px(39), px(27), px(37), px(27)); minimumHeight = px(156)
                addView(photo(account, 103, View.NO_ID))
                addView(label(display(account, "nickname"), 18f).apply { id = R.id.account_name; maxLines = 1; setTag(R.id.appearance_user_content, true) }, LayoutParams(0, -2, 1f).apply { leftMargin = px(30) })
                addView(label(if (account.optInt("id") == user.optInt("id")) "当前使用" else if (!account.has("sealed_token")) "重新登录" else "", 14f, CHAT_GREY).apply { id = R.id.account_state })
                setOnClickListener { action("switch:${account.getInt("id")}") }
            }
            card.addView(entry)
            divider(card, 168)
        }
        card.addView(LinearLayout(context).apply {
            id = R.id.account_add; gravity = Gravity.CENTER_VERTICAL; setPadding(px(39), px(27), px(37), px(27)); minimumHeight = px(156)
            addView(FrameLayout(context).apply { background = surface(0xFFF7F7F7.toInt(), 12); addView(MyGlyph(context, "plus", CHAT_GREY), FrameLayout.LayoutParams(px(39), px(39), Gravity.CENTER)) }, LayoutParams(px(103), px(103)))
            addView(label("添加账号", 18f), LayoutParams(0, -2, 1f).apply { leftMargin = px(30) })
            setOnClickListener { action("add") }
        })
    }
    fun card(top: Int = 24): LinearLayout = LinearLayout(context).apply {
        orientation = VERTICAL; background = surface(Color.WHITE, 24)
        panel.addView(this, LayoutParams(-1, -2).apply { setMargins(px(39), px(top), px(39), 0) })
    }
    fun row(parent: LinearLayout, title: String, value: String, idValue: Int, icon: String? = null, last: Boolean = false, click: (() -> Unit)? = null) {
        parent.addView(LinearLayout(context).apply {
            id = idValue; gravity = Gravity.CENTER_VERTICAL; setPadding(px(if (icon == null) 49 else 40), px(18), px(34), px(18)); minimumHeight = maxOf(px(126), dp(52))
            if (icon != null) addView(MyGlyph(context, icon, MY_BLUE), LayoutParams(px(43), px(43)).apply { rightMargin = px(33) })
            addView(label(title, 16.5f), LayoutParams(0, -2, 1f))
            addView(label(value, 15.5f, CHAT_GREY).apply { maxLines = if (idValue == R.id.profile_public_id) 2 else 1; ellipsize = android.text.TextUtils.TruncateAt.END; maxWidth = px(if (idValue == R.id.profile_public_id) 600 else 350); if (idValue in listOf(R.id.profile_nickname, R.id.profile_username, R.id.profile_public_id)) setTag(R.id.appearance_user_content, true) })
            if (click != null) addView(MyGlyph(context, "chevron", 0xFFCACBCD.toInt()), LayoutParams(px(26), px(36)).apply { leftMargin = px(22) })
            if (click != null) setOnClickListener { click() }
        })
        if (!last) divider(parent, if (icon == null) 49 else 120)
    }
    fun notificationRow(parent: LinearLayout, title: String, idValue: Int, checked: Boolean, onChanged: (Boolean) -> Unit, last: Boolean = false) {
        val toggle = NotificationToggle(context, checked).apply {
            id = idValue
            contentDescription = "$title，${if (checked) "已开启" else "已关闭"}"
            setOnCheckedChangeListener { value ->
                contentDescription = "$title，${if (value) "已开启" else "已关闭"}"
                onChanged(value)
            }
        }
        parent.addView(LinearLayout(context).apply {
            gravity = Gravity.CENTER_VERTICAL
            setPadding(px(49), px(15), px(34), px(15))
            minimumHeight = maxOf(px(126), dp(52))
            addView(label(title, 16.5f), LayoutParams(0, -2, 1f))
            addView(toggle, LayoutParams(px(108), px(92)))
            setOnClickListener { toggle.toggle() }
        })
        if (!last) divider(parent, 49)
    }
    private fun divider(parent: LinearLayout, left: Int) { parent.addView(View(context).apply { setBackgroundColor(0xFFEEEEEE.toInt()) }, LayoutParams(-1, 1).apply { setMargins(px(left), 0, px(34), 0) }) }
    private fun button(title: String, idValue: Int, click: () -> Unit) {
        panel.addView(label(title, 17f, Color.WHITE).apply { id = idValue; gravity = Gravity.CENTER; background = surface(MY_BLUE, 21); setOnClickListener { click() } }, LayoutParams(-1, maxOf(px(116), dp(48))).apply { setMargins(px(39), px(30), px(39), 0) })
    }
    fun showError(value: String, retry: (() -> Unit)? = null) {
        status.text = value.replace("来顺", context.getString(R.string.app_name)); status.visibility = VISIBLE
        if (retry != null) { status.id = R.id.my_retry; status.text = "$value · 重新加载"; status.setOnClickListener { retry() } }
    }
    fun setQrSaving(saving: Boolean) {
        qrSave?.apply { isEnabled = !saving && qrCard?.ready == true; alpha = if (isEnabled) 1f else .6f; text = AppAppearance.text(if (saving) "正在保存…" else "保存二维码") }
        if (saving) status.visibility = GONE
    }
    fun exportQr(): Bitmap = requireNotNull(qrCard).export()
    override fun onDraw(canvas: Canvas) { super.onDraw(canvas); canvas.drawRect(0f, 0f, width.toFloat(), paddingTop.toFloat(), Paint().apply { color = AppAppearance.background(Color.WHITE) }) }
}

/** Compact reference-style switch used by notification settings. */
internal class NotificationToggle(context: Context, checked: Boolean) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private var checkedState = checked
    private var listener: ((Boolean) -> Unit)? = null

    init {
        isClickable = true
        setOnClickListener { toggle() }
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    }

    fun setOnCheckedChangeListener(value: (Boolean) -> Unit) { listener = value }
    fun toggle() { checkedState = !checkedState; contentDescription = if (checkedState) "已开启" else "已关闭"; invalidate(); listener?.invoke(checkedState) }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val scale = minOf(width, height) / 100f
        val centerY = height / 2f
        val trackLeft = width - 96f * scale
        val trackRight = width - 12f * scale
        val trackHeight = 38f * scale
        val knobRadius = 27f * scale
        paint.style = Paint.Style.FILL
        paint.color = if (checkedState) 0xFFBFE7E0.toInt() else 0xFFD9DADC.toInt()
        canvas.drawRoundRect(trackLeft, centerY - trackHeight / 2f, trackRight, centerY + trackHeight / 2f, trackHeight / 2f, trackHeight / 2f, paint)
        paint.color = if (checkedState) 0xFF079F91.toInt() else 0xFF9A9B9D.toInt()
        val knobX = if (checkedState) trackRight - knobRadius else trackLeft + knobRadius
        canvas.drawCircle(knobX, centerY, knobRadius, paint)
    }
}

/** Flat reference icons, drawn without emoji or dependence on a device font. */
internal class MyGlyph(context: Context, private val kind: String, private val tint: Int) : View(context) {
    private val p = Paint(Paint.ANTI_ALIAS_FLAG)
    override fun onDraw(c: Canvas) {
        super.onDraw(c); c.save(); val s = minOf(width, height) / 100f; c.translate((width - 100 * s) / 2, (height - 100 * s) / 2); c.scale(s, s)
        p.color = AppAppearance.ink(tint); p.style = Paint.Style.STROKE; p.strokeWidth = 7f; p.strokeCap = Paint.Cap.ROUND; p.strokeJoin = Paint.Join.ROUND
        when (kind) {
            "chevron" -> { p.strokeWidth = 5f; c.drawLine(32f, 14f, 67f, 50f, p); c.drawLine(67f, 50f, 32f, 86f, p) }
            "plus" -> { p.strokeWidth = 5f; c.drawLine(15f, 50f, 85f, 50f, p); c.drawLine(50f, 15f, 50f, 85f, p) }
            "qr" -> { p.style = Paint.Style.FILL; for ((x,y) in listOf(0f to 0f, 56f to 0f, 0f to 56f)) { c.drawRect(x, y, x+40, y+40, p); p.color=Color.WHITE; c.drawRect(x+8,y+8,x+32,y+32,p); p.color=AppAppearance.ink(tint); c.drawRect(x+15,y+15,x+25,y+25,p) }; for ((x,y) in listOf(57f to 57f,76f to 57f,86f to 76f,57f to 86f,71f to 76f)) c.drawRect(x,y,x+12,y+12,p) }
            "privacy" -> { p.style=Paint.Style.FILL; c.drawPath(Path().apply { moveTo(50f,5f); lineTo(90f,16f); lineTo(87f,60f); quadTo(74f,84f,50f,98f); quadTo(22f,82f,13f,60f); lineTo(10f,16f); close() },p); p.style=Paint.Style.STROKE; p.color=Color.WHITE; c.drawLine(31f,50f,46f,65f,p); c.drawLine(46f,65f,71f,37f,p) }
            "notifications" -> { p.style=Paint.Style.FILL; c.drawPath(Path().apply { moveTo(17f,77f); lineTo(23f,65f); lineTo(23f,35f); cubicTo(23f,-1f,77f,-1f,77f,35f); lineTo(77f,65f); lineTo(87f,77f); close() },p); c.drawRoundRect(41f,87f,62f,94f,4f,4f,p) }
            "language" -> { p.style=Paint.Style.FILL; c.drawCircle(50f,50f,47f,p); p.color=Color.WHITE; c.drawPath(Path().apply { moveTo(24f,11f); lineTo(48f,12f); lineTo(46f,29f); lineTo(31f,33f); lineTo(21f,48f); lineTo(9f,34f); close() },p); c.drawPath(Path().apply { moveTo(52f,47f); lineTo(66f,43f); lineTo(76f,57f); lineTo(76f,71f); lineTo(59f,91f); lineTo(50f,72f); close() },p) }
            "appearance" -> { c.drawArc(RectF(8f,12f,89f,93f),110f,253f,false,p); c.drawPath(Path().apply { moveTo(66f,9f); lineTo(87f,18f); lineTo(98f,4f) },p); for (a in 0..5) { c.save(); c.rotate(a*44f,50f,50f); c.drawLine(51f,7f,51f,14f,p); c.restore() }; p.style=Paint.Style.FILL; c.drawCircle(73f,76f,6f,p); c.drawCircle(55f,92f,5f,p); c.drawCircle(89f,54f,5f,p) }
            "cache" -> { c.drawLine(76f,7f,60f,47f,p); p.style=Paint.Style.FILL; c.drawPath(Path().apply { moveTo(37f,40f); lineTo(77f,57f); quadTo(67f,89f,40f,96f); lineTo(10f,80f); quadTo(37f,75f,37f,40f); close() },p); p.style=Paint.Style.STROKE; p.color=Color.WHITE; c.drawLine(32f,82f,53f,58f,p); c.drawLine(47f,90f,65f,63f,p); p.color=tint; p.style=Paint.Style.FILL; c.drawCircle(15f,26f,5f,p); c.drawCircle(26f,34f,6f,p); c.drawCircle(13f,49f,5f,p) }
            "upload" -> { c.drawPath(Path().apply { moveTo(31f,35f); lineTo(17f,35f); lineTo(17f,90f); lineTo(84f,90f); lineTo(84f,35f); lineTo(69f,35f) },p); c.drawLine(50f,62f,50f,7f,p); c.drawLine(32f,23f,50f,7f,p); c.drawLine(50f,7f,68f,23f,p) }
            "edit" -> { c.drawPath(Path().apply { moveTo(43f,18f); lineTo(14f,18f); lineTo(14f,87f); lineTo(84f,87f); lineTo(84f,52f) },p); c.drawLine(48f,52f,92f,8f,p) }
            "bio" -> { p.style=Paint.Style.FILL; c.drawCircle(50f,50f,48f,p); p.style=Paint.Style.STROKE; p.color=Color.WHITE; c.drawArc(RectF(30f,30f,73f,74f),0f,170f,false,p) }
            "avatar_add" -> { p.style=Paint.Style.FILL; c.drawCircle(50f,50f,48f,p); p.style=Paint.Style.STROKE; p.color=Color.WHITE; c.drawLine(29f,50f,71f,50f,p); c.drawLine(50f,29f,50f,71f,p) }
        }
        c.restore()
    }
}

package com.pulseim.android

import android.app.Activity
import android.app.Dialog
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.text.InputFilter
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.roundToInt

/** UI only. The caller owns API requests, conversation/account checks and confirmations. */
internal class GroupInfoSheet(
    activity: Activity,
    profile: JSONObject,
    members: JSONArray,
    private val currentUserId: Int,
    private val loadAvatar: (ImageView, TextView, String) -> Unit,
    private val onSettings: (Boolean, Boolean) -> Unit,
    private val onEdit: () -> Unit,
    private val onAdd: () -> Unit,
    private val onMember: (JSONObject) -> Unit,
    private val onProfile: (Int) -> Unit,
    private val onDissolve: () -> Unit
) : GroupSheetDialog(activity, "群组资料") {
    private var profile = JSONObject(profile.toString())
    private var members = JSONArray(members.toString())
    var contactName: (Int, String) -> String = { _, fallback -> fallback }
        set(value) { field = value; render() }
    fun refreshContactNames() { window?.decorView?.let { ContactNameLabels.refresh(it, contactName) } }

    init { render() }
    fun profileSnapshot(): JSONObject = JSONObject(profile.toString())
    private fun canViewProfiles() = profile.optBoolean("can_manage") || profile.optBoolean("allow_member_add_friend")
    private fun membersRestricted() = !canViewProfiles() || string(profile, "members_visibility") == "managers"
    private fun membersConsistent() = !membersRestricted() || (0 until members.length()).all {
        val row = members.optJSONObject(it)
        row?.optString("role") in listOf("owner", "admin") && row?.optInt("user_id") != currentUserId
    }
    fun membersSnapshot(): JSONArray = if (membersConsistent()) JSONArray(members.toString()) else JSONArray()

    fun updateProfile(value: JSONObject) {
        profile = JSONObject(value.toString())
        clearError()
        render()
    }

    fun updateMembers(value: JSONArray) {
        members = JSONArray(value.toString())
        render()
    }

    /** A failed setting request needs only setBusy(false): rebuild restores authoritative switches. */
    override fun setBusy(value: Boolean) {
        super.setBusy(value)
        if (!value) render()
    }

    private fun render() {
        clearRows()
        val canManage = profile.optBoolean("can_manage")
        val canInvite = canManage && profile.optString("my_role") in listOf("owner", "admin") && profile.optBoolean("can_invite", true)
        val restrictedMembers = membersRestricted()
        val consistentMembers = membersConsistent()
        val owner = profile.optBoolean("is_owner")
        title.text = string(profile, "name").ifBlank { "群组资料" }
        setActions(if (canManage) ({ onEdit() }) else null, if (canInvite) onAdd else null)

        val information = section()
        information.addView(column().apply {
            setPadding(dp(16), dp(14), dp(16), dp(14))
            addView(label(string(profile, "name").ifBlank { "群组" }, 17f, ink, true))
            addView(label("群号：${string(profile, "invite_code").ifBlank { "暂无" }} · ${profile.optInt("member_count")} 名成员", 12f, muted).apply { id = R.id.group_member_count },
                LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(6) })
            string(profile, "description").takeIf { it.isNotBlank() }?.let {
                addView(label(it, 14f, muted), LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(6) })
            }
            string(profile, "announcement").takeIf { it.isNotBlank() }?.let {
                addView(label("群公告：$it", 14f, blue), LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(6) })
            }
        }, LinearLayout.LayoutParams(-1, -2))
        divider(information)
        toggleRow(information, "消息免打扰", profile.optBoolean("notifications_muted")) { value ->
            setBusy(true)
            onSettings(value, profile.optBoolean("is_pinned"))
        }
        divider(information)
        toggleRow(information, "置顶会话", profile.optBoolean("is_pinned")) { value ->
            setBusy(true)
            onSettings(profile.optBoolean("notifications_muted"), value)
        }

        val people = section().apply { id = R.id.group_member_list }
        var count = 0
        for (index in 0 until if (consistentMembers) members.length() else 0) {
            val member = members.optJSONObject(index) ?: continue
            val userId = member.optInt("user_id")
            if (userId <= 0) continue
            if (count > 0) divider(people)
            val role = string(member, "role")
            people.addView(row().apply {
                if (canViewProfiles() && userId != currentUserId) {
                    isClickable = true; isFocusable = true
                    contentDescription = "查看${string(member, "nickname").ifBlank { "成员" }}资料"
                    setOnClickListener { if (!operationBusy) onProfile(userId) }
                }
                minimumHeight = dp(52)
                setPadding(dp(16), dp(4), dp(8), dp(4))
                addView(IOSGroupChatStyle.avatar(host, string(member, "nickname"), string(member, "avatar_url"), loadAvatar).apply {
                    id = R.id.group_member_avatar
                }, LinearLayout.LayoutParams(dp(30), dp(30)).apply { rightMargin = dp(10) })
                addView(label(string(member, "nickname").ifBlank { "用户 $userId" }, 15f, ink).apply {
                    ContactNameLabels.bind(this, userId, string(member, "nickname").ifBlank { "用户 $userId" }, contactName)
                    id = R.id.group_member_name
                    maxLines = 2; ellipsize = TextUtils.TruncateAt.END
                }, LinearLayout.LayoutParams(0, -2, 1f))
                addView(label(if (role == "owner") "群主" else if (role == "admin") "管理员" else "成员", 12f, muted),
                    LinearLayout.LayoutParams(-2, -2).apply { leftMargin = dp(8); rightMargin = dp(8) })
                if (canManage && role != "owner" && userId != currentUserId) {
                    addView(control("⋯", "管理${string(member, "nickname").ifBlank { "用户 $userId" }}", 22f) {
                        onMember(JSONObject(member.toString()))
                    }, LinearLayout.LayoutParams(dp(36), dp(44)))
                }
            }, LinearLayout.LayoutParams(-1, -2))
            count++
        }
        if (count == 0) people.addView(label(if (consistentMembers) "暂无群成员" else "成员权限已变更，请重新打开群资料重试", 14f, muted).apply { gravity = Gravity.CENTER; setPadding(dp(16), dp(18), dp(16), dp(18)) })
        if (restrictedMembers) people.addView(label("其他成员设置隐私，无法查看", 13f, muted).apply {
            id = R.id.group_members_privacy
            setPadding(dp(16), dp(12), dp(16), dp(16))
        }, LinearLayout.LayoutParams(-1, -2))

        if (canInvite) { val add = section(); actionRow(add, "添加成员", blue, onAdd) }
        if (owner) { val danger = section(); actionRow(danger, "解散群组", red, onDissolve) }
        applyBusy()
    }

    private fun toggleRow(parent: LinearLayout, text: String, checked: Boolean, changed: (Boolean) -> Unit) {
        parent.addView(row().apply {
            minimumHeight = dp(52); setPadding(dp(16), dp(6), dp(16), dp(6))
            addView(label(text, 16f, ink), LinearLayout.LayoutParams(0, -2, 1f))
            val toggle = Switch(host).apply {
                showText = false; isChecked = checked; contentDescription = text
                thumbTintList = ColorStateList.valueOf(Color.WHITE)
                trackTintList = ColorStateList(arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf()), intArrayOf(0xFF34C759.toInt(), if (AppAppearance.dark) 0xFF55555B.toInt() else 0xFFCCCCD1.toInt()))
                setOnCheckedChangeListener { _, value -> if (!operationBusy) changed(value) }
            }
            track(toggle)
            addView(toggle, LinearLayout.LayoutParams(-2, -2))
        }, LinearLayout.LayoutParams(-1, -2))
    }
}

/** Save calls the supplied callback; only its successful API completion should dismiss this sheet. */
internal class GroupProfileEditSheet(
    activity: Activity,
    profile: JSONObject,
    private val onSave: (String, String, String, Boolean) -> Unit
) : GroupSheetDialog(activity, "编辑群资料") {
    private val name = field("群名称", string(profile, "name"), 128, false)
    private val description = field("群简介", string(profile, "description"), 500, true)
    private val announcement = field("群公告", string(profile, "announcement"), 10000, true)
    private val banMemberFriends = Switch(activity).apply {
        showText = false; isChecked = !profile.optBoolean("allow_member_add_friend", true)
        contentDescription = "禁止群成员互加好友"
    }

    init {
        close.text = "取消"
        val fields = section()
        fields.addView(name, LinearLayout.LayoutParams(-1, dp(50)))
        divider(fields)
        fields.addView(description, LinearLayout.LayoutParams(-1, -2))
        divider(fields)
        fields.addView(announcement, LinearLayout.LayoutParams(-1, -2))
        divider(fields)
        fields.addView(row().apply {
            minimumHeight = dp(52); setPadding(dp(16), dp(6), dp(16), dp(6))
            addView(label("禁止群成员互加好友", 16f, ink), LinearLayout.LayoutParams(0, -2, 1f))
            addView(banMemberFriends, LinearLayout.LayoutParams(-2, -2))
        })
        track(banMemberFriends)
        rightActions.addView(control("保存", "保存群资料", 15f) {
            val groupName = name.text.toString().trim()
            if (groupName.isBlank()) { showError("请输入群名称"); return@control }
            clearError(); setBusy(true)
            onSave(groupName, description.text.toString().trim(), announcement.text.toString().trim(), !banMemberFriends.isChecked)
        }, LinearLayout.LayoutParams(dp(52), dp(44)))
        applyBusy()
    }

    private fun field(hint: String, value: String, limit: Int, multiline: Boolean) = EditText(host).apply {
        this.hint = hint; contentDescription = hint; setText(value); textSize = 16f
        setTextColor(ink); setHintTextColor(muted); background = ColorDrawable(Color.TRANSPARENT)
        setPadding(dp(16), dp(13), dp(16), dp(13)); filters = arrayOf(InputFilter.LengthFilter(limit))
        if (multiline) { minLines = 2; maxLines = 5; gravity = Gravity.TOP or Gravity.START; inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE }
        else setSingleLine(true)
        track(this)
    }
}

/** Selection never closes optimistically; the caller dismisses only after add-member succeeds. */
internal class GroupMemberPickerSheet(
    activity: Activity,
    contacts: JSONArray,
    private val onAdd: (Int) -> Unit,
    existingMemberIds: Set<Int> = emptySet()
) : GroupSheetDialog(activity, "添加成员") {
    init {
        val source = JSONArray(contacts.toString())
        val card = section()
        var count = 0
        for (index in 0 until source.length()) {
            val contact = source.optJSONObject(index) ?: continue
            val userId = contact.optInt("user_id", contact.optInt("id"))
            if (userId <= 0) continue
            if (count > 0) divider(card)
            val existing = userId in existingMemberIds
            card.addView(row().apply {
                minimumHeight = dp(54); setPadding(dp(16), dp(8), dp(16), dp(8))
                addView(personIcon(), LinearLayout.LayoutParams(dp(24), dp(24)).apply { rightMargin = dp(10) })
                val nickname = string(contact, "nickname").ifBlank { "用户 $userId" }
                addView(label(nickname, 16f, if (existing) muted else ink), LinearLayout.LayoutParams(0, -2, 1f))
                if (existing) addView(label("已在群中", 12f, muted))
                else {
                    contentDescription = "添加${nickname}到群组"
                    isClickable = true; isFocusable = true
                    setOnClickListener { if (!operationBusy) { clearError(); setBusy(true); onAdd(userId) } }
                    track(this)
                }
            }, LinearLayout.LayoutParams(-1, -2))
            count++
        }
        if (count == 0) card.addView(label("暂无可添加的联系人", 14f, muted).apply { gravity = Gravity.CENTER; setPadding(dp(16), dp(24), dp(16), dp(24)) })
        applyBusy()
    }
}

internal open class GroupSheetDialog(protected val host: Activity, heading: String) : BackSwipeDialog(host, if (AppAppearance.dark) R.style.AppThemeDark else R.style.AppTheme) {
    protected val ink = if (AppAppearance.dark) 0xFFF3F3F7.toInt() else Color.BLACK
    protected val muted = if (AppAppearance.dark) 0xFFAAAAAF.toInt() else 0xFF8E8E93.toInt()
    protected val blue = if (AppAppearance.dark) 0xFF8AB9FF.toInt() else 0xFF2F80ED.toInt()
    protected val red = 0xFFE45151.toInt()
    protected var operationBusy = false
    private val interactive = mutableListOf<View>()
    private val backgroundColor = if (AppAppearance.dark) 0xFF171A21.toInt() else 0xFFF2F2F7.toInt()
    private val surfaceColor = if (AppAppearance.dark) 0xFF22252D.toInt() else Color.WHITE
    private val error = label("", 12f, red).apply { visibility = View.GONE; setPadding(dp(16), dp(9), dp(16), dp(9)) }
    private val progress = ProgressBar(host).apply { visibility = View.GONE; indeterminateTintList = ColorStateList.valueOf(blue); contentDescription = "正在处理群组操作" }
    protected val body = column().apply { setPadding(0, 0, 0, dp(20)) }
    protected val title = label(heading, 16f, ink, true).apply { gravity = Gravity.CENTER; maxLines = 1; ellipsize = TextUtils.TruncateAt.END }
    protected val close = control("关闭", "关闭$heading", 15f) { dismiss() }
    protected val rightActions = row().apply { gravity = Gravity.END }

    init {
        requestWindowFeature(Window.FEATURE_NO_TITLE)
        val root = column().apply { background = shape(backgroundColor, 18); clipToOutline = true }
        root.addView(FrameLayout(host).apply {
            setBackgroundColor(surfaceColor)
            addView(title, FrameLayout.LayoutParams(-1, -1).apply { leftMargin = dp(100); rightMargin = dp(100) })
            addView(close, FrameLayout.LayoutParams(dp(60), -1, Gravity.START))
            addView(rightActions, FrameLayout.LayoutParams(dp(96), -1, Gravity.END))
            addView(progress, FrameLayout.LayoutParams(dp(20), dp(20), Gravity.CENTER).apply { gravity = Gravity.CENTER_VERTICAL or Gravity.START; leftMargin = dp(66) })
        }, LinearLayout.LayoutParams(-1, dp(50)))
        root.addView(error, LinearLayout.LayoutParams(-1, -2))
        root.addView(ScrollView(host).apply { isFillViewport = false; isVerticalScrollBarEnabled = false; addView(body) }, LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(root)
        setCanceledOnTouchOutside(true)
    }

    override fun onStart() {
        super.onStart()
        window?.apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            setLayout(ViewGroup.LayoutParams.MATCH_PARENT, (host.resources.displayMetrics.heightPixels * .90f).roundToInt())
            setGravity(Gravity.BOTTOM)
            addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            attributes = attributes.apply { dimAmount = .28f }
            setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE or WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN)
        }
    }

    open fun setBusy(value: Boolean) {
        operationBusy = value
        setCancelable(!value)
        setCanceledOnTouchOutside(!value)
        applyBusy()
    }

    fun showError(message: String) {
        setBusy(false)
        error.text = message
        error.visibility = if (message.isBlank()) View.GONE else View.VISIBLE
    }

    protected fun clearError() { error.text = ""; error.visibility = View.GONE }
    protected fun clearRows() { body.removeAllViews(); rightActions.removeAllViews(); interactive.clear(); track(close) }
    protected fun applyBusy() { interactive.forEach { it.isEnabled = !operationBusy }; progress.visibility = if (operationBusy) View.VISIBLE else View.GONE }
    protected fun track(view: View) { interactive.add(view); view.isEnabled = !operationBusy }
    protected fun setActions(edit: (() -> Unit)?, add: (() -> Unit)?) {
        rightActions.removeAllViews()
        if (edit != null) rightActions.addView(control("编辑", "编辑群资料", 14f, edit), LinearLayout.LayoutParams(dp(48), dp(44)))
        if (add != null) rightActions.addView(control("＋", "添加成员", 24f, add), LinearLayout.LayoutParams(dp(44), dp(44)))
    }
    protected fun actionRow(parent: LinearLayout, text: String, color: Int, click: () -> Unit) {
        parent.addView(control(text, text, 16f, click).apply { setTextColor(color); gravity = Gravity.START or Gravity.CENTER_VERTICAL; setPadding(dp(16), dp(10), dp(16), dp(10)) }, LinearLayout.LayoutParams(-1, dp(50)))
    }
    protected fun control(text: String, description: String, size: Float, click: () -> Unit) = label(text, size, blue).apply {
        gravity = Gravity.CENTER; contentDescription = description; isClickable = true; isFocusable = true
        setOnClickListener { if (!operationBusy) click() }; track(this)
    }
    protected fun section() = column().apply { background = shape(surfaceColor, 11); body.addView(this, LinearLayout.LayoutParams(-1, -2).apply { leftMargin = dp(16); rightMargin = dp(16); topMargin = dp(16) }) }
    protected fun divider(parent: LinearLayout) { parent.addView(View(host).apply { setBackgroundColor(if (AppAppearance.dark) 0xFF3A3A3C.toInt() else 0xFFD9D9DD.toInt()) }, LinearLayout.LayoutParams(-1, dp(1)).apply { leftMargin = dp(16) }) }
    protected fun personIcon() = ImageView(host).apply { setImageResource(android.R.drawable.ic_menu_myplaces); imageTintList = ColorStateList.valueOf(muted); importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO }
    protected fun row() = LinearLayout(host).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    protected fun column() = LinearLayout(host).apply { orientation = LinearLayout.VERTICAL }
    protected fun label(value: String, size: Float, color: Int, bold: Boolean = false) = TextView(host).apply { text = value; textSize = size; setTextColor(color); includeFontPadding = false; if (bold) typeface = Typeface.DEFAULT_BOLD }
    protected fun shape(color: Int, radius: Int) = GradientDrawable().apply { setColor(color); cornerRadius = dp(radius).toFloat() }
    protected fun dp(value: Int) = (value * host.resources.displayMetrics.density).roundToInt()
    protected fun string(source: JSONObject, key: String) = source.optString(key).takeUnless { it == "null" }.orEmpty().trim()
}

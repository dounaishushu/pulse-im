package com.pulseim.android

import android.app.Activity
import android.app.AlertDialog
import android.graphics.Color
import android.text.*
import android.view.*
import android.widget.*
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ExecutorService

internal class PrivacyFeature(
    private val activity: Activity, private val executor: ExecutorService, private val sessions: AccountSessions,
    private val api: () -> ApiClient, private val show: (String) -> Unit, private val resolveAvatar: (String) -> String,
    private val sessionList: () -> Unit
) {
    companion object { val pages = setOf("privacy", "phone-privacy", "invite-privacy", "blocked", "block-picker", "two-step", "two-step-setup", "two-step-confirm", "two-step-success", "two-step-change", "two-step-delete", "two-step-recovery", "passcode") }
    private var current: MyScreen? = null
    private var settings = JSONObject()
    private var busy = false
    private var pickerTab = "contacts"
    private var pickerSearch: EditText? = null
    private var pickerRows = JSONArray()
    private var pickerList: LinearLayout? = null
    private var blockCount = 0
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())
    private var pickerVersion = 0
    private var pickerPage = 0
    private var pickerLoaded = 0
    private var pendingTwoStepPassword = ""
    private var pendingLoginPassword = ""
    private var pendingTwoStepAction = "enable"
    private var pendingRecoveryCodes = JSONArray()
    private val dialogs = mutableSetOf<android.app.Dialog>()
    fun pause() { dialogs.toList().forEach { it.dismiss() }; dialogs.clear() }
    fun close() { pause(); current = null; pickerVersion++; pendingTwoStepPassword=""; pendingLoginPassword=""; handler.removeCallbacksAndMessages(null) }
    private fun ui(action: () -> Unit) = activity.runOnUiThread { if (!activity.isFinishing && !activity.isDestroyed) action() }
    private fun valid(view: MyScreen, id: Int) = current === view && view.isAttachedToWindow && sessions.activeId() == id && (activity as? MainActivity)?.isAppLocked() != true
    private fun request(view: MyScreen, operation: (ApiClient) -> JSONObject, done: (JSONObject) -> Unit) {
        val id = sessions.activeId(); val client = api(); val sessionToken = sessions.token(id)
        view.status.text = "正在加载…"; view.status.visibility = View.VISIBLE
        executor.execute {
            try { val value = operation(client); ui { if (valid(view, id) && sessions.token(id) == sessionToken) { view.status.visibility = View.GONE; done(value); AppAppearance.apply(view) } } }
            catch (e: Exception) { ui { if (valid(view, id) && sessions.token(id) == sessionToken) { busy = false; view.showError(e.message ?: "获取失败，请重试") { show(view.page) } } } }
        }
    }
    fun render(view: MyScreen) {
        current = view; busy = false; pickerSearch = null
        pickerRows = JSONArray()
        settings = JSONObject()
        when (view.page) {
            "privacy", "phone-privacy", "invite-privacy" -> request(view, { client ->
                client.userSettings().also { if (view.page == "privacy") blockCount = client.blocksPage(1).optInt("total") }
            }) {
                settings = it
                if (view.page != "privacy" && !canManagePrivacy()) show("privacy") else build(view)
            }
            "blocked" -> blocked(view)
            "block-picker" -> picker(view)
            "two-step" -> request(view, { it.security() }) { twoStep(view, it) }
            "two-step-setup" -> twoStepPassword(view, "enable")
            "two-step-confirm" -> twoStepConfirm(view)
            "two-step-success" -> twoStepSuccess(view)
            "two-step-change" -> twoStepPassword(view, "change")
            "two-step-delete" -> twoStepDelete(view)
            "two-step-recovery" -> twoStepRecovery(view)
            "passcode" -> passcode(view)
        }
    }
    fun search() { pickerSearch?.let { it.visibility = View.VISIBLE; it.requestFocus(); (activity.getSystemService(Activity.INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager).showSoftInput(it, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT) } }
    private fun panel(view: MyScreen) = MyPrivacyPanel(activity).also { view.panel.addView(it) }
    private fun build(view: MyScreen) {
        val p = panel(view)
        val labels = mapOf("everyone" to "所有人", "contacts" to "我的联系人", "nobody" to "不允许任何人")
        if (view.page == "privacy") {
            p.section("安全")
            val security = p.card()
            p.entry(security, "已屏蔽的用户", "$blockCount", R.id.settings_blocks, "block", 0xFFEE4D58.toInt()) { show("blocked") }
            p.entry(security, "两步验证", "", R.id.privacy_two_step, "key", 0xFF30B4D6.toInt()) { show("two-step") }
            p.entry(security, "锁定码", "", R.id.privacy_passcode, "scan", 0xFF46B987.toInt(), true) { show("passcode") }
            p.help("控制您在其它设备上的会话。")
            if(BuildConfig.GO_BACKEND){
                p.section("聊天隐私",90)
                val controls=p.card()
                p.entry(controls,"临时聊天",labels[settings.optString("temporary_chat_visibility")]?:"所有人",View.generateViewId(),last=true){
                    editGoPrivacy(view,"temporary_chat")
                }
            }
            if (canManagePrivacy()) {
                p.section("隐私", 90)
                val privacy = p.card()
                p.entry(privacy, "手机号码", labels[settings.optString("phone_visibility")] ?: "不允许任何人", R.id.settings_phone) { show("phone-privacy") }
                p.entry(privacy, "邀请权限控制", labels[settings.optString("invite_visibility")] ?: "所有人", R.id.settings_invites, last = true) { if(BuildConfig.GO_BACKEND)editGoPrivacy(view,"group_invites") else show("invite-privacy") }
                p.help("控制谁能邀请您进入群组或频道。")
            }
            p.section("高级", 91)
            val days = settings.optInt("account_auto_delete_days", 180)
            p.entry(p.card(), "删除我的帐户若离线时间达", mapOf(0 to "关闭", 30 to "1个月", 90 to "3个月", 180 to "6个月", 365 to "1年")[days] ?: "6个月", R.id.settings_auto_delete, last = true) {
                p.retention { save(view, JSONObject().put("account_auto_delete_days", it)) }
            }
            p.help("如果在此期间没有上线，账号将被停用；管理员可恢复账号，历史消息和记录保留。")
        } else if (view.page == "phone-privacy") {
            p.section("谁可以看到我的手机号码？")
            val card = p.card()
            listOf(Triple("everyone", "所有人", R.id.phone_everyone), Triple("contacts", "我的联系人", R.id.phone_contacts), Triple("nobody", "不允许任何人", R.id.phone_nobody)).forEach { (key, title, id) -> p.radio(card, title, settings.optString("phone_visibility") == key, id) { save(view, JSONObject().put("phone_visibility", key)) } }
            p.help("此设置控制其他用户在${activity.getString(R.string.app_name)}中查看您的手机号码。“我的联系人”指您在本程序中添加的联系人。")
            p.section("谁可以通过我的手机号找到我？", 55)
            val search = p.card()
            p.radio(search, "所有人", settings.optString("phone_search_visibility") == "everyone", R.id.phone_search_everyone) { save(view, JSONObject().put("phone_search_visibility", "everyone")) }
            p.radio(search, "我的联系人", settings.optString("phone_search_visibility") == "contacts", R.id.phone_search_contacts) { save(view, JSONObject().put("phone_search_visibility", "contacts")) }
        } else {
            p.section("谁可以邀请我进入群组？")
            val card = p.card()
            p.radio(card, "所有人", settings.optString("invite_visibility") == "everyone", R.id.invite_everyone) { save(view, JSONObject().put("invite_visibility", "everyone")) }
            p.radio(card, "我的联系人", settings.optString("invite_visibility") == "contacts", R.id.invite_contacts) { save(view, JSONObject().put("invite_visibility", "contacts")) }
            p.help("您可以精确控制其他人能否邀请您进入任意群组或频道。")
        }
    }
    private fun editGoPrivacy(view:MyScreen,scope:String){
        val id=sessions.activeId();val token=sessions.token(id)
        GoPrivacyEditor.open(activity,api(),executor,scope,{valid(view,id)&&sessions.token(id)==token},{dialog->dialogs.add(dialog);dialog.setOnDismissListener{dialogs.remove(dialog)}}){show("privacy")}
    }
    private fun save(view: MyScreen, patch: JSONObject) {
        if (!canManagePrivacy() && patch.keys().asSequence().any { it in setOf("phone_visibility", "phone_search_visibility", "last_seen_visibility", "voice_call_visibility", "voice_call_peer_to_peer", "invite_visibility", "privacy_exceptions") }) {
            show("privacy"); return
        }
        if (busy) return; busy = true
        request(view, { it.updateUserSettings(patch) }) { settings = it; show(view.page) }
    }
    private fun canManagePrivacy() = settings.opt("can_manage_privacy") == true
    private fun blocked(view: MyScreen) {
        val p = panel(view)
        p.entry(p.card(70), "屏蔽用户", "", R.id.privacy_block_add, "add-user", last = true) { pickerTab = "contacts"; show("block-picker") }
        p.help("被屏蔽的用户将无法与您联系，也无法看到您的最后上线时间。", true)
        var loaded = 0; var page = 0
        var list: LinearLayout? = null
        fun load() {
            request(view, { it.blocksPage(page + 1) }) { result ->
                page++; blockCount = result.optInt("total")
                val rows = result.getJSONArray("items"); loaded += rows.length()
                if (rows.length() > 0 && list == null) list = p.card(35)
                list?.let { entries ->
                    entries.findViewById<View>(R.id.privacy_block_more)?.let { entries.removeView(it) }
                    for (i in 0 until rows.length()) {
                        val user = rows.getJSONObject(i)
                        p.person(entries, user, R.id.privacy_block_row, resolveAvatar, "解除屏蔽") {
                            AlertDialog.Builder(activity).setTitle("解除屏蔽").setMessage("解除对${jsonText(user, "nickname")}的屏蔽？").setNegativeButton("取消", null).setPositiveButton("解除屏蔽") { _, _ -> request(view, { it.unblock(user.getInt("blocked_id")) }) { show("blocked") } }.show()
                        }
                    }
                    if (loaded < blockCount) entries.addView(p.label("加载更多", 15f, MY_BLUE).apply { id = R.id.privacy_block_more; gravity = Gravity.CENTER; minimumHeight = p.px(110); setOnClickListener { isEnabled = false; load() } })
                }
            }
        }
        load()
    }
    private fun picker(view: MyScreen) {
        val p = panel(view)
        val tabs = LinearLayout(activity).apply { orientation = LinearLayout.HORIZONTAL; setBackgroundColor(Color.WHITE) }
        listOf(Triple("dialogs", "对话", R.id.privacy_picker_dialogs), Triple("contacts", "联系人", R.id.privacy_picker_contacts)).forEach { (key, title, id) ->
            tabs.addView(LinearLayout(activity).apply {
                orientation = LinearLayout.VERTICAL
                addView(p.label(title, 16f, if (pickerTab == key) MY_BLUE else CHAT_GREY).apply { this.id = id; gravity = Gravity.CENTER; contentDescription = "$title，${if (pickerTab == key) "已选中" else "未选中"}"; setOnClickListener { pickerTab = key; show("block-picker") } }, LinearLayout.LayoutParams(-1, p.px(114)))
                addView(View(activity).apply { setBackgroundColor(if (pickerTab == key) MY_BLUE else Color.TRANSPARENT) }, LinearLayout.LayoutParams(-1, p.px(3)))
            }, LinearLayout.LayoutParams(0, -2, 1f))
        }; p.addView(tabs)
        pickerSearch = EditText(activity).apply {
            id = R.id.privacy_picker_search; hint = "搜索昵称或账号"; isSingleLine = true; textSize = 15f; visibility = View.GONE; setPadding(p.px(40), 0, p.px(40), 0)
            addTextChangedListener(object : TextWatcher { override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {} ; override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { pickerVersion++; handler.removeCallbacksAndMessages(null); handler.postDelayed({ if (current === view) loadPicker(view, p, true) }, 250) }; override fun afterTextChanged(s: Editable?) {} })
        }.also { p.addView(it, LinearLayout.LayoutParams(-1, p.px(110))) }
        pickerList = p.card(35)
        loadPicker(view, p, true)
    }
    private fun loadPicker(view: MyScreen, p: MyPrivacyPanel, reset: Boolean) {
        val list = pickerList ?: return
        val version = ++pickerVersion; val id = sessions.activeId(); val client = api()
        val query = pickerSearch?.text?.toString()?.trim().orEmpty(); val kind = pickerTab
        val next = if (reset) 1 else pickerPage + 1
        view.status.text = "正在加载…"; view.status.visibility = View.VISIBLE
        executor.execute {
            try {
                val result = client.blockCandidates(kind, query, next)
                ui {
                    if (!valid(view, id) || pickerVersion != version) return@ui
                    view.status.visibility = View.GONE
                    if (reset) { list.removeAllViews(); pickerLoaded = 0 }
                    else list.findViewById<View>(R.id.privacy_picker_more)?.let { list.removeView(it) }
                    pickerPage = next
                    val rows = result.getJSONArray("items"); pickerLoaded += rows.length()
                    for (i in 0 until rows.length()) {
                        val person = rows.getJSONObject(i); val targetId = person.getInt("user_id")
                        p.person(list, person, R.id.privacy_picker_row, resolveAvatar, "屏蔽") {
                            AlertDialog.Builder(activity).setTitle("屏蔽用户").setMessage("确定屏蔽${jsonText(person, "nickname")}？").setNegativeButton("取消", null).setPositiveButton("屏蔽") { _, _ -> request(view, { it.blockUser(targetId) }) { show("blocked") } }.show()
                        }
                    }
                    if (pickerLoaded < result.optInt("total")) list.addView(p.label("加载更多", 15f, MY_BLUE).apply { this.id = R.id.privacy_picker_more; gravity = Gravity.CENTER; minimumHeight = p.px(110); setOnClickListener { isEnabled = false; loadPicker(view, p, false) } })
                    AppAppearance.apply(p)
                }
            } catch (e: Exception) { ui { if (valid(view, id) && pickerVersion == version) { list.findViewById<View>(R.id.privacy_picker_more)?.isEnabled = true; view.showError(e.message ?: "用户列表获取失败") { loadPicker(view, p, reset) } } } }
        }
    }
    private fun input(hint: String, id: Int, numeric: Boolean = false) = EditText(activity).apply {
        this.id = id; this.hint = hint; inputType = if (numeric) InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD else 0x81; isSingleLine = true
        filters = arrayOf(InputFilter.LengthFilter(if (numeric) 6 else 128))
    }
    private fun form(view: MyScreen, title: String, inputs: List<View>, operation: (ApiClient) -> JSONObject, done: (JSONObject) -> Unit) {
        val id = sessions.activeId(); val client = api()
        val error = TextView(activity).apply { this.id = R.id.profile_dialog_error; setTextColor(0xFFD44545.toInt()); visibility = View.GONE }
        val panel = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; setPadding(view.dp(20), view.dp(10), view.dp(20), view.dp(10)); inputs.forEach { addView(it) }; addView(error) }
        val dialog = AlertDialog.Builder(activity).setTitle(title).setView(panel).setNegativeButton("取消", null).setPositiveButton("保存", null).create()
        dialogs.add(dialog); dialog.setOnDismissListener { dialogs.remove(dialog) }
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = false
                executor.execute {
                    try { val result = operation(client); ui { if (valid(view, id) && dialog.isShowing) { dialog.dismiss(); done(result) } } }
                    catch (e: Exception) { ui { if (valid(view, id) && dialog.isShowing) { error.text = e.message ?: "保存失败"; error.visibility = View.VISIBLE; dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = true } } }
                }
            }
        }; dialog.show(); dialog.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    }
    private fun twoStep(view: MyScreen, state: JSONObject) {
        val p = panel(view); val enabled = state.optBoolean("enabled")
        p.section("两步验证")
        p.help(if (enabled) "已开启。登录本账号时需要额外验证密码。" else "为账号设置独立验证密码，登录新设备时需要同时验证登录密码和两步验证密码。")
        val card = p.card(35)
        if (!enabled) p.entry(card, "设置两步验证密码", "", R.id.security_enable, last = true) { pendingTwoStepPassword = ""; show("two-step-setup") }
        else {
            p.entry(card, "更改密码", "", R.id.security_change) { show("two-step-change") }
            p.entry(card, "重新生成恢复码", "剩余${state.optInt("recovery_codes_remaining")}个", R.id.security_recovery) { show("two-step-recovery") }
            p.entry(card, "删除密码", "", R.id.security_disable, last = true) { show("two-step-delete") }
        }
        p.help("恢复码用于忘记验证密码时登录，每个码只能使用一次。请妥善保存，重新生成会使旧码失效。")
        p.entry(p.card(40), "登录设备", "", R.id.settings_sessions, last = true, click = sessionList)
    }
    private fun twoStepInput(hint: String, id: Int): EditText = EditText(activity).apply {
        this.id = id; this.hint = hint; isSingleLine = true
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        filters = arrayOf(InputFilter.LengthFilter(128)); textSize = 16f
        val density = activity.resources.displayMetrics.density
        setPadding((24 * density).toInt(), (4 * density).toInt(), (18 * density).toInt(), (4 * density).toInt()); background = current?.let { MyPrivacyPanel(activity).surface(0xFFF3F4F8.toInt(), 18) }
    }
    private fun passwordRow(p: MyPrivacyPanel, field: EditText, toggleId: Int): LinearLayout = LinearLayout(activity).apply {
        gravity = Gravity.CENTER_VERTICAL; background = p.surface(0xFFF3F4F8.toInt(), 18); setPadding(p.px(20), 0, p.px(14), 0)
        addView(field, LinearLayout.LayoutParams(0, p.px(92), 1f))
        addView(p.label("显示", 14f, MY_BLUE).apply {
            id = toggleId; gravity = Gravity.CENTER; setPadding(p.px(10), 0, p.px(10), 0)
            setOnClickListener {
                val visible = (field.inputType and android.text.InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD) != 0
                field.inputType = if (visible) InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD else InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
                field.setSelection(field.text.length); text = if (visible) "显示" else "隐藏"
            }
        }, LinearLayout.LayoutParams(p.px(72), p.px(92)))
    }
    private fun twoStepButton(p: MyPrivacyPanel, text: String, id: Int, enabled: Boolean, click: () -> Unit): TextView = p.label(text, 17f, Color.WHITE).apply {
        this.id = id; gravity = Gravity.CENTER; isEnabled = enabled; alpha = if (enabled) 1f else .38f; background = p.surface(MY_BLUE, 20)
        setOnClickListener { if (isEnabled) click() }
    }
    private fun twoStepTitle(p: MyPrivacyPanel, title: String, hint: String? = null) {
        p.addView(p.label(title, 23f, Color.BLACK).apply { gravity = Gravity.CENTER; typeface = android.graphics.Typeface.DEFAULT_BOLD }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = p.px(58); bottomMargin = p.px(16) })
        hint?.let { p.addView(p.label(it, 14f, CHAT_GREY).apply { gravity = Gravity.CENTER; setLineSpacing(p.px(5).toFloat(), 1f) }, LinearLayout.LayoutParams(-1, -2).apply { leftMargin = p.px(68); rightMargin = p.px(68); bottomMargin = p.px(30) }) }
    }
    private fun twoStepPassword(view: MyScreen, action: String) {
        val p = panel(view); pendingTwoStepAction = action
        twoStepTitle(p, if (action == "enable") "请输入二次验证密码" else "更改两步验证密码", if (action == "enable") "设置密码后，登录新设备时需要输入此密码。" else "请输入当前密码和新的两步验证密码。")
        val card = p.card(0)
        var current: EditText? = null
        if (action != "enable") {
            current = twoStepInput("请输入当前密码或恢复码", R.id.security_current_code)
            card.addView(passwordRow(p, current, R.id.two_step_confirm_toggle), LinearLayout.LayoutParams(-1, p.px(92)))
            p.help("请输入当前两步验证密码，也可以使用一次性恢复码。")
        }
        val loginPassword=twoStepInput("请输入当前账号登录密码",View.generateViewId())
        card.addView(passwordRow(p,loginPassword,View.generateViewId()),LinearLayout.LayoutParams(-1,p.px(92)).apply{topMargin=p.px(14)})
        p.help("为保护账号设置，请验证当前登录密码。")
        val next = twoStepInput("请输入密码", R.id.security_new_password)
        card.addView(passwordRow(p, next, R.id.two_step_password_toggle), LinearLayout.LayoutParams(-1, p.px(92)))
        if (action == "enable") p.help("密码至少需要8个字符。")
        val confirm = twoStepInput("请再次输入密码", R.id.security_confirm_password)
        card.addView(passwordRow(p, confirm, R.id.two_step_confirm_toggle), LinearLayout.LayoutParams(-1, p.px(92)).apply { topMargin = p.px(14) })
        val error = p.label("", 13f, 0xFFD44545.toInt()).apply { id = R.id.two_step_error; visibility = View.GONE; setPadding(0, p.px(16), 0, 0) }
        card.addView(error, LinearLayout.LayoutParams(-1, -2))
        val actionButton = twoStepButton(p, if (action == "enable") "下一步" else "确认", R.id.two_step_action, false) {
            if (action == "enable") { pendingTwoStepPassword = next.text.toString(); pendingLoginPassword=loginPassword.text.toString(); show("two-step-confirm") }
            else submitTwoStepChange(view, current?.text?.toString().orEmpty(), next.text.toString(),loginPassword.text.toString())
        }
        p.addView(actionButton, LinearLayout.LayoutParams(-1, p.px(92)).apply { setMargins(p.px(39), p.px(30), p.px(39), 0) })
        val update = object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { val ok = next.text.length in 8..128 && confirm.text.toString() == next.text.toString() && loginPassword.text.isNotBlank() && (action == "enable" || !current?.text.isNullOrBlank()); actionButton.isEnabled = ok; actionButton.alpha = if (ok) 1f else .38f; error.visibility = if (confirm.text.isNotEmpty() && confirm.text.toString() != next.text.toString()) View.VISIBLE else View.GONE; error.text = "两次输入的密码不一致" }
            override fun afterTextChanged(s: Editable?) = Unit
        }
        next.addTextChangedListener(update); confirm.addTextChangedListener(update); current?.addTextChangedListener(update);loginPassword.addTextChangedListener(update)
    }
    private fun twoStepConfirm(view: MyScreen) {
        val p = panel(view); twoStepTitle(p, "请再次输入密码", "请再次输入刚才设置的两步验证密码。")
        val card = p.card(0); val confirm = twoStepInput("请再次输入密码", R.id.security_confirm_password)
        card.addView(passwordRow(p, confirm, R.id.two_step_confirm_toggle), LinearLayout.LayoutParams(-1, p.px(92)))
        val error = p.label("", 13f, 0xFFD44545.toInt()).apply { id = R.id.two_step_error; visibility = View.GONE; setPadding(0, p.px(16), 0, 0) }
        card.addView(error, LinearLayout.LayoutParams(-1, -2))
        val button = twoStepButton(p, "确认", R.id.two_step_action, false) { submitTwoStepEnable(view, confirm.text.toString()) }
        p.addView(button, LinearLayout.LayoutParams(-1, p.px(92)).apply { setMargins(p.px(39), p.px(30), p.px(39), 0) })
        confirm.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { val ok = confirm.text.toString() == pendingTwoStepPassword && confirm.text.length >= 8; button.isEnabled = ok; button.alpha = if (ok) 1f else .38f; error.visibility = if (confirm.text.isNotEmpty() && !ok) View.VISIBLE else View.GONE; error.text = if (confirm.text.length < 8) "密码至少需要8个字符" else "两次输入的密码不一致" }
            override fun afterTextChanged(s: Editable?) = Unit
        })
    }
    private fun submitTwoStepEnable(view: MyScreen, confirmed: String) {
        if (confirmed != pendingTwoStepPassword || pendingTwoStepPassword.length !in 8..128) return
        busy = true
        request(view, { it.updateSecurity(JSONObject().put("action", "enable").put("new_password", pendingTwoStepPassword).put("login_password",pendingLoginPassword)) }) { result ->
            busy = false;pendingLoginPassword=""; pendingRecoveryCodes = result.optJSONArray("recovery_codes") ?: JSONArray(); show("two-step-success")
        }
    }
    private fun submitTwoStepChange(view: MyScreen, current: String, next: String,loginPassword:String) {
        if (current.isBlank() || next.length !in 8..128||loginPassword.isBlank()) return
        busy = true
        request(view, { it.updateSecurity(JSONObject().put("action", "change").put("current_code", current).put("current",current).put("login_password",loginPassword).put("new_password", next).put("next",next)) }) { result ->
            busy = false; pendingTwoStepPassword = next; pendingRecoveryCodes = result.optJSONArray("recovery_codes") ?: JSONArray(); show("two-step-success")
        }
    }
    private fun twoStepSuccess(view: MyScreen) {
        val p = panel(view); twoStepTitle(p, "请输入密码", "您已启用两步验证。今后您在登录新设备时将需要输入您设置的附加密码。")
        val card = p.card(0); val password = twoStepInput("请输入密码", R.id.two_step_password)
        card.addView(passwordRow(p, password, R.id.two_step_password_toggle), LinearLayout.LayoutParams(-1, p.px(92)))
        val codes = pendingRecoveryCodes
        if (codes.length() > 0) {
            val text = (0 until codes.length()).joinToString("\n") { codes.getString(it) }
            p.addView(p.label("请保存以下一次性恢复码，关闭后无法再次查看：\n$text", 12.5f, CHAT_GREY).apply { id = R.id.security_recovery_codes; setLineSpacing(p.px(8).toFloat(), 1f) }, LinearLayout.LayoutParams(-1, -2).apply { setMargins(p.px(88), p.px(22), p.px(88), 0) })
        }
        val done = twoStepButton(p, "完成", R.id.two_step_success, false) { pendingTwoStepPassword = ""; pendingRecoveryCodes = JSONArray(); activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE); show("two-step") }
        p.addView(done, LinearLayout.LayoutParams(-1, p.px(92)).apply { setMargins(p.px(39), p.px(30), p.px(39), 0) })
        password.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { val ok = password.text.toString() == pendingTwoStepPassword; done.isEnabled = ok; done.alpha = if (ok) 1f else .38f }
            override fun afterTextChanged(s: Editable?) = Unit
        })
        activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    }
    private fun twoStepDelete(view: MyScreen) {
        val p = panel(view); twoStepTitle(p, "删除两步验证密码", "删除后登录新设备时不再需要附加密码。")
        val card = p.card(0); val current = twoStepInput("请输入当前密码或恢复码", R.id.security_current_code);val login=twoStepInput("请输入当前账号登录密码",View.generateViewId())
        card.addView(passwordRow(p, current, R.id.two_step_confirm_toggle), LinearLayout.LayoutParams(-1, p.px(92)))
        card.addView(passwordRow(p,login,View.generateViewId()),LinearLayout.LayoutParams(-1,p.px(92)).apply{topMargin=p.px(12)})
        val button = twoStepButton(p, "删除密码", R.id.two_step_action, false) { busy = true; request(view, { it.updateSecurity(JSONObject().put("action", "disable").put("current_code", current.text.toString()).put("current",current.text.toString()).put("login_password",login.text.toString())) }) { busy = false; show("two-step") } }
        p.addView(button, LinearLayout.LayoutParams(-1, p.px(92)).apply { setMargins(p.px(39), p.px(30), p.px(39), 0) })
        current.addTextChangedListener(simpleEnabled(button) { current.text.isNotBlank()&&login.text.isNotBlank() });login.addTextChangedListener(simpleEnabled(button) { current.text.isNotBlank()&&login.text.isNotBlank() })
    }
    private fun twoStepRecovery(view: MyScreen) {
        val p = panel(view); twoStepTitle(p, "重新生成恢复码", "请输入当前两步验证密码后生成新的恢复码。")
        val card = p.card(0); val current = twoStepInput("请输入当前密码或恢复码", R.id.security_current_code);val login=twoStepInput("请输入当前账号登录密码",View.generateViewId())
        card.addView(passwordRow(p, current, R.id.two_step_confirm_toggle), LinearLayout.LayoutParams(-1, p.px(92)))
        card.addView(passwordRow(p,login,View.generateViewId()),LinearLayout.LayoutParams(-1,p.px(92)).apply{topMargin=p.px(12)})
        val button = twoStepButton(p, "重新生成", R.id.two_step_action, false) { busy = true; request(view, { it.updateSecurity(JSONObject().put("action", "recovery").put("current_code", current.text.toString()).put("current",current.text.toString()).put("login_password",login.text.toString())) }) { result -> busy = false; pendingRecoveryCodes = result.optJSONArray("recovery_codes") ?: JSONArray(); show("two-step-success") } }
        p.addView(button, LinearLayout.LayoutParams(-1, p.px(92)).apply { setMargins(p.px(39), p.px(30), p.px(39), 0) })
        current.addTextChangedListener(simpleEnabled(button) { current.text.isNotBlank()&&login.text.isNotBlank() });login.addTextChangedListener(simpleEnabled(button) { current.text.isNotBlank()&&login.text.isNotBlank() })
    }
    private fun simpleEnabled(button: TextView, ready: () -> Boolean) = object : TextWatcher {
        override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
        override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { val ok = ready(); button.isEnabled = ok; button.alpha = if (ok) 1f else .38f }
        override fun afterTextChanged(s: Editable?) = Unit
    }
    private fun passcode(view: MyScreen) {
        val p = panel(view); val enabled = AppPasscode.enabled(activity)
        p.section("锁定码"); p.help("设置六位数字锁定码。应用重启或从后台返回时需要解锁，保护本机的全部账号。")
        val card = p.card(35)
        if (!enabled) p.entry(card, "设置锁定码", "", R.id.security_enable, last = true) { passcodeForm(view, "enable") }
        else {
            p.entry(card, "修改锁定码", "", R.id.security_change) { passcodeForm(view, "change") }
            p.entry(card, "关闭锁定码", "", R.id.security_disable) { passcodeForm(view, "disable") }
            p.entry(card, "立即锁定", "", R.id.passcode_lock_now, last = true) { (activity as? MainActivity)?.lockNow() }
        }
        p.help("锁定码只保存在本设备，不会修改登录密码。启用后隐藏通知内容，并保护应用画面不被截屏。请牢记锁定码。")
        AppAppearance.apply(view)
    }
    private fun passcodeForm(view: MyScreen, action: String) {
        val old = input("当前六位锁定码", R.id.passcode_current, true)
        val next = input("新的六位锁定码", R.id.passcode_new, true)
        val confirm = input("再次输入锁定码", R.id.passcode_confirm, true)
        val inputs = mutableListOf<View>(); if (action != "enable") inputs.add(old); if (action != "disable") inputs.addAll(listOf(next, confirm))
        form(view, if (action == "disable") "关闭锁定码" else "设置锁定码", inputs, {
            if (action != "enable") AppPasscode.verify(activity, old.text.toString())
            if (action == "disable") AppPasscode.disable(activity)
            else { require(next.text.toString() == confirm.text.toString()) { "两次输入的锁定码不一致" }; AppPasscode.set(activity, next.text.toString()) }
            JSONObject()
        }) { if (AppPasscode.enabled(activity)) activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE) else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE); show("passcode") }
    }
}

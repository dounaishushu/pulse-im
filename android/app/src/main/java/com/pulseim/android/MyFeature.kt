package com.pulseim.android

import android.app.Activity
import android.app.AlertDialog
import android.app.DatePickerDialog
import android.app.Dialog
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.content.Intent
import android.net.Uri
import android.view.View
import android.view.Gravity
import android.view.WindowManager
import android.widget.*
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Calendar
import java.util.concurrent.ExecutorService

/** Account UI requests use their own captured token, preventing changes from leaking across switches. */
internal class MyFeature(
    private val activity: Activity, private val base: String, private val executor: ExecutorService,
    private val sessions: AccountSessions, private val diagnostics: ClientDiagnostics,
    private val activate: (JSONObject, String) -> Unit, private val loggedOut: () -> Unit,
    private val navigate: (String) -> Unit, private val invite: () -> Unit,
    private val resolveAvatar: (String) -> String
) {
    var page = "home"
        private set
    private var screen: MyScreen? = null
    private var user = sessions.profile() ?: JSONObject()
    private var settings = JSONObject()
    private val privacyFeature by lazy { PrivacyFeature(activity, executor, sessions, { api() }, ::show, resolveAvatar, ::sessionsDialog) }
    private var generation = 0
    private var adding: AuthFlowView? = null
    private var accountBusy = false
    private var avatarTarget = 0
    private var qrSaving = false
    private var qrPermissionAccount = 0
    private val qrStoragePermission = 1908
    private fun ui(operation: () -> Unit) = activity.runOnUiThread { if (!activity.isFinishing && !activity.isDestroyed) operation() }
    private fun api(token: String? = sessions.token()) = ApiClient(base).apply { this.token = token }
    private fun sameAccount(id: Int, token: String?) = id > 0 && token != null && sessions.activeId() == id && sessions.token(id) == token
    fun visible() = screen?.isAttachedToWindow == true || adding?.isAttachedToWindow == true
    internal fun swipeBackIdentity(): Any = listOf(generation, page, adding?.swipeBackPage(), accountBusy)
    fun close() { generation++; screen = null; adding = null; privacyFeature.close() }
    fun pause() { privacyFeature.pause() }
    fun show(next: String = "home") {
        user = sessions.profile() ?: JSONObject()
        if (android.os.Build.VERSION.SDK_INT >= 30) activity.window.insetsController?.show(android.view.WindowInsets.Type.statusBars())
        page = next; generation++; adding = null
        privacyFeature.close()
        AppAppearance.load(activity)
        val view = MyScreen(activity, next, user, sessions.accounts(), resolveAvatar, ::action, navigate)
        screen = view; activity.setContentView(view)
        view.setQrSaving(qrSaving)
        AppAppearance.apply(view)
        if (android.os.Build.VERSION.SDK_INT >= 30) activity.window.insetsController?.setSystemBarsAppearance(
            if (AppAppearance.dark) 0 else android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,
            android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS)
        activity.window.navigationBarColor = AppAppearance.background(if (next != "home") 0xFFF7F7F7.toInt() else CHAT_BG)
        if (next in listOf("home", "profile", "qr")) loadProfile(view)
        when (next) {
            "appearance" -> AppAppearance.apply(view)
            "language" -> language(view)
            in PrivacyFeature.pages -> privacyFeature.render(view)
            "notifications" -> notifications(view)
        }
        diagnostics.record("page.$next")
    }
    fun resume() { if (screen?.isAttachedToWindow == true && adding == null) show(page) }
    fun back(): Boolean {
        if (!visible()) return false
        adding?.let {
            if (accountBusy) return true
            if (it.handleBack()) return true
            show("accounts"); return true
        }
        when (page) {
            "home" -> { close(); navigate("chat") }
            "accounts" -> show("profile")
            "block-picker" -> show("blocked")
            "two-step-setup", "two-step-confirm", "two-step-success", "two-step-change", "two-step-delete", "two-step-recovery" -> show("two-step")
            "phone-privacy", "invite-privacy", "blocked", "two-step", "passcode" -> show("privacy")
            else -> show("home")
        }
        return true
    }
    private fun loadProfile(view: MyScreen) {
        val id = sessions.activeId(); val client = api(); val version = generation
        executor.execute {
            try {
                val loaded = client.me()
                check(loaded.optInt("id") == id) { "个人资料账号不匹配" }
                ui {
                    if (screen !== view || generation != version || !sameAccount(id, client.token)) return@ui
                    sessions.save(loaded, requireNotNull(client.token)); user = loaded
                    // Rebuild once using returned data, without recursively reloading.
                    val fresh = MyScreen(activity, page, user, sessions.accounts(), resolveAvatar, ::action, navigate)
                    fresh.setQrSaving(qrSaving); screen = fresh; activity.setContentView(fresh); AppAppearance.apply(fresh)
                }
            } catch (e: Exception) { ui { if (screen === view && generation == version && sameAccount(id, client.token)) view.showError(error(e, "获取资料失败")) { show(page) } } }
        }
    }
    private fun action(key: String) {
        when {
            key.startsWith("theme:") -> { AppAppearance.set(activity, "theme_mode", key.substringAfter(':')); show("appearance") }
            key == "appearance-done" -> { notice("外观设置已保存"); show("home") }
            key.startsWith("switch:") -> switchAccount(key.substringAfter(':').toInt())
            key in listOf("profile", "accounts", "appearance", "privacy", "notifications", "language", "qr") -> show(key)
            key == "back" -> back()
            key == "block-search" -> privacyFeature.search()
            key == "qr-save" -> saveQr()
            key == "invite" -> invite()
            key == "add" -> showAddAccount()
            key == "logout" -> logout()
            key == "avatar" -> pickAvatar()
            key == "nickname" || key == "signature" -> editField(key)
            key == "username" -> if (jsonText(user, key).isNotBlank()) notice("账号设置后不能再次修改") else editField(key)
            key == "birthday" -> birthday()
            key == "gender" -> choice("性别", listOf("男", "女", "保密")) { saveProfile(JSONObject().put("gender", it)) }
            key == "password" -> password()
            key == "cache" -> clearCacheReference()
            key == "logs" -> uploadLogs()
        }
    }
    private fun saveQr() {
        val view = screen ?: return
        if (page != "qr" || qrSaving) return
        if (android.os.Build.VERSION.SDK_INT <= 28 && activity.checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            qrPermissionAccount = sessions.activeId()
            activity.requestPermissions(arrayOf(android.Manifest.permission.WRITE_EXTERNAL_STORAGE), qrStoragePermission)
            return
        }
        val image = try { view.exportQr() } catch (e: Exception) { view.showError(error(e, "二维码图片生成失败，请重试")); return }
        val id = sessions.activeId()
        qrSaving = true; view.setQrSaving(true)
        executor.execute {
            try {
                MyQrExport.save(activity.applicationContext, image, id)
                ui { if (sessions.activeId() == id) { notice("二维码已保存到相册"); diagnostics.record("qr.save") } }
            } catch (e: Exception) {
                ui { if (sessions.activeId() == id && page == "qr") screen?.showError(error(e, "保存失败，请检查相册空间后重试")) }
            } finally {
                image.recycle()
                ui { qrSaving = false; screen?.setQrSaving(false) }
            }
        }
    }
    fun permissionResult(requestCode: Int, grantResults: IntArray): Boolean {
        if (requestCode != qrStoragePermission) return false
        val id = qrPermissionAccount; qrPermissionAccount = 0
        if (id != sessions.activeId() || !visible() || page != "qr") return true
        if (grantResults.firstOrNull() == android.content.pm.PackageManager.PERMISSION_GRANTED) saveQr()
        else { screen?.showError("需要允许保存图片权限才能保存二维码，可再次点击重试"); notice("未保存二维码") }
        return true
    }
    private fun error(e: Exception, fallback: String) = when (e.message) {
        "Current password is incorrect." -> "当前密码不正确"
        "New password must contain 8 to 128 characters." -> "新密码需要8到128个字符"
        else -> e.message?.takeIf { it.any { c -> c.code in 0x4e00..0x9fff } } ?: fallback
    }
    private fun notice(message: String) = Toast.makeText(activity, AppAppearance.text(message.replace("来顺", activity.getString(R.string.app_name))), Toast.LENGTH_SHORT).show()
    private fun choice(title: String, values: List<String>, done: (String) -> Unit) {
        AlertDialog.Builder(activity).setTitle(AppAppearance.text(title)).setItems(values.map { AppAppearance.text(it) }.toTypedArray()) { _, index -> done(values[index]) }.setNegativeButton(AppAppearance.text("取消"), null).show()
    }
    private fun editField(field: String) {
        val title = when (field) { "nickname" -> "昵称"; "signature" -> "个人简介"; else -> "账号" }
        val input = EditText(activity).apply { id = R.id.profile_dialog_input; setText(jsonText(user, field)); filters = arrayOf(android.text.InputFilter.LengthFilter(if (field == "signature") 70 else 32)); if (field != "signature") isSingleLine = true }
        form(title, listOf(input), operation = { client -> client.updateProfile(JSONObject().put(field, input.text.toString().trim())) }) { saved -> updateUser(saved); show("profile") }
    }
    private fun updateUser(saved: JSONObject) {
        val id = sessions.activeId(); val token = sessions.token() ?: return
        if (id <= 0 || saved.optInt("id") != id) { notice("个人资料账号不匹配，请重试"); return }
        sessions.save(saved, token); user = saved; activate(saved, token)
    }
    private fun saveProfile(patch: JSONObject) {
        val id = sessions.activeId(); val client = api(); val view = screen
        executor.execute {
            try { val saved = client.updateProfile(patch); ui { if (sameAccount(id, client.token) && screen === view) { updateUser(saved); show("profile"); notice("资料已保存") } } }
            catch (e: Exception) { ui { if (screen === view && sameAccount(id, client.token)) view?.showError(error(e, "资料保存失败")) } }
        }
    }
    private fun birthday() {
        if (user.optInt("birthday_change_count") >= 1) { notice("生日只能修改一次，不能再次修改"); return }
        val calendar = Calendar.getInstance()
        val old = jsonText(user, "birthday").split('-')
        if (old.size == 3) runCatching { calendar.set(old[0].toInt(), old[1].toInt() - 1, old[2].toInt()) }
        val dialog = DatePickerDialog(activity, { _, y, m, d ->
            val date = String.format(java.util.Locale.US, "%04d-%02d-%02d", y, m + 1, d)
            AlertDialog.Builder(activity).setTitle("设置生日").setMessage("生日：$date\n生日设置后仅可修改一次，请确认填写正确。")
                .setNegativeButton("取消", null).setPositiveButton("保存") { _, _ -> saveProfile(JSONObject().put("birthday", date)) }.show()
        }, calendar.get(Calendar.YEAR), calendar.get(Calendar.MONTH), calendar.get(Calendar.DAY_OF_MONTH))
        dialog.datePicker.maxDate = System.currentTimeMillis(); dialog.show()
    }
    private fun password() {
        val current = EditText(activity).apply { id = R.id.profile_password_current; hint = "当前密码"; inputType = 0x81 }
        val next = EditText(activity).apply { id = R.id.profile_password_new; hint = "新密码（至少8位）"; inputType = 0x81 }
        form("修改登录密码", listOf(current, next), operation = { client -> client.changePassword(current.text.toString(), next.text.toString()) }) {
            sessions.invalidate(sessions.activeId()); loggedOut(); notice("密码已修改，请重新登录")
        }
    }
    private fun form(title: String, inputs: List<View>, positive: String = "保存", operation: (ApiClient) -> JSONObject, done: (JSONObject) -> Unit) {
        val id = sessions.activeId(); val client = api(); val version = generation
        val error = TextView(activity).apply { this.id = R.id.profile_dialog_error; setTextColor(0xFFC44545.toInt()); visibility = View.GONE; accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE }
        val panel = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; setPadding(30, 15, 30, 15); inputs.forEach { addView(it) }; addView(error) }
        val dialog = AlertDialog.Builder(activity).setTitle(AppAppearance.text(title)).setView(panel).setNegativeButton(AppAppearance.text("取消"), null).setPositiveButton(AppAppearance.text(positive), null).create()
        dialog.setOnShowListener {
            val save = dialog.getButton(AlertDialog.BUTTON_POSITIVE)
            save.setOnClickListener {
                save.isEnabled = false; error.visibility = View.GONE
                executor.execute {
                    try {
                        val result = operation(client)
                        ui { if (sameAccount(id, client.token) && generation == version && dialog.isShowing) { dialog.dismiss(); done(result); diagnostics.record("profile.save") } }
                    } catch (e: Exception) { ui { if (sameAccount(id, client.token) && generation == version && dialog.isShowing) { save.isEnabled = true; error.text = error(e, "$title 保存失败"); error.visibility = View.VISIBLE } } }
                }
            }
        }
        dialog.show()
    }
    private fun pickAvatar() {
        avatarTarget = sessions.activeId()
        activity.startActivityForResult(PhotoAlbumPickerActivity.intent(activity), 43)
    }
    fun activityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
        if (adding?.registrationAvatarResult(requestCode, resultCode, data) == true) return true
        if (requestCode != 43) return false
        val id = avatarTarget; val token = sessions.token(id); val uri = data?.data
        if (resultCode != Activity.RESULT_OK || uri == null || token == null) return true
        val client = api(token)
        executor.execute {
            try {
                MediaUploadFiles.prepare(activity, uri, "image", avatar = true).use { prepared ->
                    val upload = client.uploadMedia(prepared.file, "image", prepared.mime)
                    val saved = client.updateProfile(JSONObject().put("avatar_url", upload.getString("url")))
                    ui { if (sameAccount(id, token)) { updateUser(saved); if (visible()) show("profile"); notice("头像已更新") } }
                }
            } catch (e: Exception) { ui { if (sameAccount(id, token)) screen?.showError(error(e, "头像上传失败，请重试")) } }
        }
        return true
    }
    private fun showAddAccount(account: String = "") {
        val form = AuthFlowView(activity, onLogin = { account, password -> authenticate(account, password) },
            onRegister = { account, password, name, captchaId, captchaCode, avatar -> authenticate(account, password, name, captchaId = captchaId, captchaCode = captchaCode, avatarDataURL = avatar) },
            loadRegisterChallenge = { complete ->
                executor.execute {
                    try { val challenge = api(null).registerChallenge(); ui { complete(challenge, null) } }
                    catch (e: Exception) { ui { complete(null, error(e, "验证码加载失败，请重试")) } }
                }
            }, startRegister = account.isBlank(), onExit = { show("accounts") }, initialAccount = account,
            rememberedLogins = RememberedLogins(activity), loginServer = base)
        generation++; screen = null; adding = form
        if (android.os.Build.VERSION.SDK_INT >= 30) activity.window.insetsController?.hide(android.view.WindowInsets.Type.statusBars())
        activity.setContentView(form)
    }
    private fun authenticate(account: String, password: String, name: String? = null, twoStepCode: String = "", captchaId: String = "", captchaCode: String = "", avatarDataURL: String = "") {
        val form = adding ?: return
        val rememberChoice = form.rememberPasswordRequested()
        if (accountBusy) return
        accountBusy = true
        val client = api(null)
        executor.execute {
            try {
                val registered = name?.let { client.register(account, password, it, captchaId, captchaCode, avatarDataURL = avatarDataURL) }
                val token = registered?.getString("access_token") ?: client.login(account, password, twoStepCode); client.token = token
                val loaded = if (registered == null) client.me() else JSONObject().put("id", registered.getInt("user_id")).put("username", account).put("nickname", name).put("avatar_url", registered.optString("avatar_url")).apply {
                    PublicUserId.value(registered.opt("public_id"))?.let { put("public_id", it) }
                }
                ui {
                    accountBusy = false
                    if (adding !== form) return@ui
                    sessions.save(loaded, token); user = loaded
                    val rememberFailure = form.persistSuccessfulLogin(account,password,loaded,rememberChoice)
                    form.clearCredentials(); adding = null
                    if (android.os.Build.VERSION.SDK_INT >= 30) activity.window.insetsController?.show(android.view.WindowInsets.Type.statusBars())
                    activate(loaded, token)
                    if (registered != null) navigate("chat") else show("accounts")
                    diagnostics.record("account.add")
                    if (rememberFailure != null) notice(rememberFailure)
                }
            } catch (e: Exception) { ui { accountBusy = false; if (adding === form) { form.showError(error(e, if (name == null) "登录失败，请重试" else "注册失败，请重试")); if (name == null && TwoStepLogin.required(e) && (activity as? MainActivity)?.isAppLocked() != true) TwoStepLogin.prompt(activity) { authenticate(account, password, twoStepCode = it) } } } }
        }
    }
    private fun switchAccount(id: Int) {
        if (accountBusy || id == sessions.activeId()) return
        val token = sessions.token(id)
        if (token == null) { showAddAccount(jsonText(sessions.profile(id) ?: JSONObject(), "username")); return }
        val origin = screen; val originId = sessions.activeId(); val originToken = sessions.token(); val version = generation; accountBusy = true
        executor.execute {
            try {
                val loaded = api(token).me()
                check(loaded.optInt("id") == id) { "切换账号资料不匹配" }
                ui { accountBusy = false; if (screen === origin && generation == version && sameAccount(originId, originToken) && sessions.token(id) == token) { sessions.save(loaded, token); user = loaded; activate(loaded, token); show("accounts"); notice("账号已切换"); diagnostics.record("account.switch") } }
            } catch (e: Exception) {
                ui { accountBusy = false; if (screen === origin && generation == version && sameAccount(originId, originToken)) {
                    if (e.message?.contains("登录状态") == true || e.message?.contains("账号不可用") == true) { sessions.invalidate(id); show("accounts") }
                    screen?.showError(error(e, "账号切换失败，请重新登录")); diagnostics.record("account.switch", "failed")
                } }
            }
        }
    }
    private fun logout() {
        AlertDialog.Builder(activity).setTitle("退出登录").setMessage("确定退出当前账号吗？其他已添加的账号会保留。")
            .setNegativeButton("取消", null).setPositiveButton("退出登录") { _, _ ->
                val id = sessions.activeId(); val client = api()
                executor.execute {
                    try { PushNotifications.unbind(activity, client); client.logout(); ui { if (sessions.activeId() == id) { sessions.remove(id); close(); loggedOut() } } }
                    catch (e: Exception) { ui { screen?.showError(error(e, "退出失败，请重试")) } }
                }
            }.show()
    }
    private fun language(view: MyScreen) {
        val card = view.card()
        view.row(card, "简体中文", if (AppAppearance.language == "zh") "✓" else "", R.id.settings_language_zh) { AppAppearance.set(activity, "language", "zh"); show("language") }
        view.row(card, "English", if (AppAppearance.language == "en") "✓" else "", R.id.settings_language_en, last = true) { AppAppearance.set(activity, "language", "en"); show("language") }
        AppAppearance.apply(view)
    }
    private fun sessionsDialog() {
        val client = api(); val id = sessions.activeId()
        executor.execute {
            try { val rows = client.sessions(); ui {
                if (sessions.activeId() != id || !visible()) return@ui
                val labels = Array(rows.length()) { i -> val row = rows.getJSONObject(i); "${row.optString("device_type")} · ${row.optString("last_used_at")} ${if (row.optBoolean("is_current")) "（当前设备）" else ""}" }
                AlertDialog.Builder(activity).setTitle("登录设备").setItems(labels) { _, i ->
                    val row = rows.getJSONObject(i)
                    if (row.optBoolean("is_current")) notice("这是当前设备") else AlertDialog.Builder(activity).setMessage("确定撤销这台设备的登录状态吗？").setNegativeButton("取消", null).setPositiveButton("撤销") { _, _ ->
                        executor.execute { try { client.revokeSession(row.getInt("id")); ui { if (sessions.activeId() == id) sessionsDialog() } } catch (e: Exception) { ui { notice(error(e, "撤销失败")) } } }
                    }.show()
                }.setNegativeButton("关闭", null).show()
            } } catch (e: Exception) { ui { notice(error(e, "设备获取失败")) } }
        }
    }
    private fun blocksDialog() {
        val client = api(); val id = sessions.activeId()
        executor.execute {
            try { val rows = client.blocks(); ui {
                if (sessions.activeId() != id || !visible()) return@ui
                if (rows.length() == 0) { AlertDialog.Builder(activity).setTitle("屏蔽联系人").setMessage("暂无屏蔽联系人").setPositiveButton("关闭", null).show(); return@ui }
                AlertDialog.Builder(activity).setTitle("选择联系人取消屏蔽").setItems(Array(rows.length()) { rows.getJSONObject(it).optString("nickname") }) { _, i ->
                    executor.execute { try { client.unblock(rows.getJSONObject(i).getInt("blocked_id")); ui { if (sessions.activeId() == id) blocksDialog() } } catch (e: Exception) { ui { notice(error(e, "取消屏蔽失败")) } } }
                }.setNegativeButton("关闭", null).show()
            } } catch (e: Exception) { ui { notice(error(e, "屏蔽列表获取失败")) } }
        }
    }
    private fun notifications(view: MyScreen) {
        val prefs = activity.getSharedPreferences("pulse_notify_${sessions.activeId()}", Activity.MODE_PRIVATE)
        view.panel.addView(view.label("消息通知", 15.5f, MY_BLUE).apply { id = R.id.settings_notify_section }, LinearLayout.LayoutParams(-1, -2).apply { setMargins(view.px(88), view.px(58), view.px(40), view.px(28)) })
        val card = view.card(0)
        view.notificationRow(card, "声音", R.id.settings_notify_sound, prefs.getBoolean("sound", true), { enabled ->
            prefs.edit().putBoolean("sound", enabled).commit()
        })
        view.notificationRow(card, "振动", R.id.settings_notify_vibrate, prefs.getBoolean("vibrate", true), { enabled ->
            prefs.edit().putBoolean("vibrate", enabled).commit()
        }, last = true)
        AppAppearance.apply(view)
    }
    private fun clearCacheReference() {
        val factor = activity.resources.displayMetrics.widthPixels / 873f
        fun size(value: Int) = Math.round(value * factor).toInt()
        val dialog = BackSwipeDialog(activity)
        val card = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                setColor(Color.WHITE)
                cornerRadius = size(24).toFloat()
            }
            clipToOutline = true
        }
        card.addView(TextView(activity).apply {
            text = "\u6e05\u9664\u7f13\u5b58"
            textSize = 24f
            setTextColor(Color.BLACK)
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            includeFontPadding = false
        }, LinearLayout.LayoutParams(-1, size(128)))
        card.addView(TextView(activity).apply {
            text = "\u5df2\u6e05\u7a7a"
            textSize = 23f
            setTextColor(0xFF858589.toInt())
            gravity = Gravity.CENTER
            includeFontPadding = false
        }, LinearLayout.LayoutParams(-1, size(112)))

        val actions = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
        actions.addView(View(activity).apply { setBackgroundColor(0xFFE9E9EA.toInt()) }, LinearLayout.LayoutParams(-1, 1))
        actions.addView(LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(TextView(activity).apply {
                text = "\u53d6\u6d88"
                textSize = 23f
                setTextColor(0xFF77777B.toInt())
                gravity = Gravity.CENTER
                includeFontPadding = false
                isClickable = true
                setOnClickListener { dialog.dismiss() }
            }, LinearLayout.LayoutParams(0, -1, 1f))
            addView(View(activity).apply { setBackgroundColor(0xFFE9E9EA.toInt()) }, LinearLayout.LayoutParams(1, -1))
            addView(TextView(activity).apply {
                text = "\u786e\u5b9a"
                textSize = 23f
                setTextColor(0xFF1647B8.toInt())
                typeface = Typeface.DEFAULT_BOLD
                gravity = Gravity.CENTER
                includeFontPadding = false
                isClickable = true
                setOnClickListener {
                    isEnabled = false
                    alpha = .55f
                    executor.execute {
                        var cleared = true
                        try {
                            ChatImageCache.clear(activity)
                            val root = activity.cacheDir.canonicalFile
                            val rootPath = root.toPath()
                            root.listFiles()?.forEach { file ->
                                val target = file.canonicalFile
                                if (target.toPath().startsWith(rootPath)) target.deleteRecursively()
                            }
                            ChatAvatars.clear(activity)
                        } catch (_: Exception) {
                            cleared = false
                        }
                        ui {
                            dialog.dismiss()
                            if (cleared) {
                                notice("\u7f13\u5b58\u5df2\u6e05\u9664")
                                diagnostics.record("cache.clear")
                            } else {
                                notice("\u7f13\u5b58\u6e05\u9664\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5")
                            }
                        }
                    }
                }
            }, LinearLayout.LayoutParams(0, -1, 1f))
        }, LinearLayout.LayoutParams(-1, 0, 1f))
        card.addView(actions, LinearLayout.LayoutParams(-1, size(120)))

        dialog.setContentView(card)
        dialog.setCanceledOnTouchOutside(true)
        dialog.setOnShowListener {
            dialog.window?.apply {
                setBackgroundDrawableResource(android.R.color.transparent)
                addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
                attributes = attributes.apply {
                    dimAmount = .62f
                    gravity = Gravity.CENTER
                }
                setLayout(size(622), size(360))
            }
        }
        dialog.show()
    }

    private fun clearCache() {
        val size = activity.cacheDir.walkTopDown().filter { it.isFile }.sumOf { it.length() }
        AlertDialog.Builder(activity).setTitle("清除缓存").setMessage("清理图片、视频、语音与临时文件缓存（${String.format(java.util.Locale.US, "%.2f", size / 1048576.0)} MB），账号和聊天记录会保留。")
            .setNegativeButton("取消", null).setPositiveButton("清除") { _, _ ->
                executor.execute {
                    ChatImageCache.clear(activity)
                    val root = activity.cacheDir.canonicalFile
                    root.listFiles()?.forEach { file -> if (file.canonicalFile.toPath().startsWith(root.toPath())) file.deleteRecursively() }
                    LocalMediaCache.clear(activity); ChatAvatars.clear(activity); ui { notice("缓存已清除"); diagnostics.record("cache.clear") }
                }
            }.show()
    }
    private fun uploadLogs() {
        AlertDialog.Builder(activity).setTitle("上传日志").setMessage("上传应用版本、设备型号和操作结果，供后台排查问题。")
            .setNegativeButton("取消", null).setPositiveButton("上传") { _, _ ->
                val client = api(); val view = screen
                executor.execute { try { val result = client.uploadDiagnostics(diagnostics.payload()); ui { if (screen === view) { view?.status?.apply { text = "日志上传成功，编号：${result.optString("report_id")}"; visibility = View.VISIBLE }; diagnostics.record("diagnostics.upload") } } } catch (e: Exception) { ui { if (screen === view) view?.showError(error(e, "日志上传失败，请重试")) } } }
            }.show()
    }
}

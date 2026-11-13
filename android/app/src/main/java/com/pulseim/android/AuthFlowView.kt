package com.pulseim.android

import android.content.Context
import android.graphics.Canvas
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.InputFilter
import android.text.InputType
import android.text.TextUtils
import android.text.method.PasswordTransformationMethod
import android.util.TypedValue
import android.util.Base64
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.ImageView
import android.widget.CheckBox
import android.widget.LinearLayout
import android.app.AlertDialog
import android.text.TextWatcher
import android.text.Editable
import org.json.JSONObject
import kotlin.math.roundToInt

/** Native controls positioned in the proportions of the supplied 873 × 1920 references. */
class AuthFlowView(
    context: Context,
    private val onLogin: (String, String) -> Unit,
    private val onRegister: (String, String, String, String, String, String) -> Unit,
    private val loadRegisterChallenge: ((JSONObject?, String?) -> Unit) -> Unit,
    private val onRoute: (() -> Unit)? = null,
    private val startRegister: Boolean = false,
    private val onExit: (() -> Unit)? = null,
    initialAccount: String = "",
    private val rememberedLogins: RememberedLogins? = null,
    private val loginServer: String = ""
) : FrameLayout(context) {
    private enum class Page { LOGIN, REGISTER }
    private var page = if (startRegister) Page.REGISTER else Page.LOGIN
    private var accountDraft = initialAccount
    private var passwordDraft = ""
    private var nicknameDraft = ""
    private var avatarDataURL = ""
    private var avatarImage: ImageView? = null
    private var avatarStatus: TextView? = null
    private var avatarGeneration = 0
    private var pickingAvatar = false
    private var avatarLoading = false
    private var passwordVisible = false
    private var rememberPasswordFlag = true
    private var rememberCheck: CheckBox? = null
    private var rememberedDialog: AlertDialog? = null
    private var autofilled: RememberedLogins.Credential? = null
    private var autofilledID: String? = null
    private var fillingRemembered = false
    private var rememberedError = ""
    private var busy = false
    private var accountInput: EditText? = null
    private var passwordInput: EditText? = null
    private var nicknameInput: EditText? = null
    private var captchaInput: EditText? = null
    private var captchaImage: ImageView? = null
    private var captchaRefresh: TextView? = null
    private var captchaStatus: TextView? = null
    private var captchaId = ""
    private var captchaExpiresAt = 0L
    private var captchaGeneration = 0
    private var captchaLoading = false
    private val handler = Handler(Looper.getMainLooper())
    private var captchaExpiry: Runnable? = null
    private lateinit var errorLabel: TextView
    private lateinit var primaryAction: TextView
    private val controls = mutableListOf<View>()
    private val appName get() = context.getString(R.string.app_name)

    init {
        isFocusableInTouchMode = true
        if (page == Page.LOGIN && rememberedLogins != null) try {
            val rows = rememberedLogins.list(loginServer)
            val selected = if (accountDraft.isBlank()) rows.firstOrNull() else rows.firstOrNull { it.account.equals(accountDraft,true) }
            if (selected != null) {
                val saved = rememberedLogins.credential(loginServer,selected.id)
                accountDraft = saved.account; passwordDraft = saved.password; autofilled = saved; autofilledID = selected.id
            }
        } catch (_: Exception) { rememberedError = "无法读取已记住的账号，请手动登录" }
        render()
        if (rememberedError.isNotEmpty()) showError(rememberedError)
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        if (page == Page.REGISTER && !busy && captchaId.isEmpty() && !captchaLoading) refreshCaptcha()
    }

    override fun onDetachedFromWindow() {
        rememberedDialog?.dismiss(); rememberedDialog = null
        avatarGeneration++; avatarLoading = false; pickingAvatar = false
        invalidateCaptcha()
        super.onDetachedFromWindow()
    }

    override fun onWindowFocusChanged(hasWindowFocus: Boolean) {
        super.onWindowFocusChanged(hasWindowFocus)
        if (hasWindowFocus && page == Page.REGISTER && !busy && captchaId.isNotEmpty() && SystemClock.elapsedRealtime() >= captchaExpiresAt) {
            captchaId = ""
            captchaInput?.text?.clear()
            captchaStatus?.text = "验证码已过期，请换一张"
            updateCaptchaControls()
        }
    }

    internal fun swipeBackPage(): Any? = if (!busy && page != Page.LOGIN) page else null

    fun handleBack(): Boolean {
        if (busy) return true
        return when (page) {
            Page.REGISTER -> { rememberInputs(); page = Page.LOGIN; render(); true }
            Page.LOGIN -> false
        }
    }

    fun showError(message: String) {
        val refresh = busy && page == Page.REGISTER
        setBusy(false)
        errorLabel.text = message.replace("来顺", appName)
        errorLabel.visibility = View.VISIBLE
        if (refresh) refreshCaptcha()
    }

    fun clearCredentials() {
        autofilled = null; autofilledID = null
        passwordDraft = ""
        passwordInput?.text?.clear()
    }
    fun rememberPasswordRequested(): Boolean = rememberedLogins != null && rememberPasswordFlag
    fun persistSuccessfulLogin(account: String, password: String, user: JSONObject, remember: Boolean): String? {
        val store = rememberedLogins ?: return null
        return try {
            if (remember) store.save(loginServer,account,password,user) else store.remove(loginServer,account=account)
            null
        } catch (_: Exception) { "已登录，但未能保存记住密码的设置，请检查本机存储后重试" }
    }

    private fun rememberInputs() {
        accountInput?.let { accountDraft = it.text.toString().trim() }
        passwordInput?.let { passwordDraft = it.text.toString() }
        nicknameInput?.let { nicknameDraft = it.text.toString().trim() }
    }

    private fun render() {
        avatarGeneration++; avatarLoading = false; pickingAvatar = false
        invalidateCaptcha()
        removeAllViews()
        controls.clear()
        accountInput = null
        passwordInput = null
        nicknameInput = null
        captchaInput = null
        captchaImage = null
        captchaRefresh = null
        captchaStatus = null
        avatarImage = null; avatarStatus = null
        val isNickname = page == Page.REGISTER
        background = if (isNickname) GradientDrawable().apply { setColor(PROFILE_BACKGROUND) }
        else GradientDrawable(GradientDrawable.Orientation.TL_BR, intArrayOf(0xFFADDEFF.toInt(), 0xFF70AFF9.toInt(), 0xFF287BF0.toInt()))
        val scroll = ScrollView(context).apply {
            isFillViewport = true
            isVerticalScrollBarEnabled = false
            overScrollMode = View.OVER_SCROLL_NEVER
            clipToPadding = false
        }
        val sheet = ReferenceSheet(context)
        scroll.addView(sheet, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        addView(scroll, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        if (isNickname) buildRegistration(sheet) else buildCredentials(sheet)
        requestFocus()
        if (isNickname && isAttachedToWindow) refreshCaptcha()
    }

    private fun buildCredentials(sheet: ReferenceSheet) {
        val registering = page == Page.REGISTER
        if (onExit != null) sheet.place(AuthIconView(context, AuthIconView.Kind.BACK, Color.WHITE).apply {
            id = R.id.auth_back; contentDescription = "返回添加账号"; setOnClickListener { if (!busy) { hideKeyboard(); onExit.invoke() } }
        }, 23f, 90f, 53f, 62f)
        sheet.place(label("切换路线", 28f, Color.BLACK).apply {
            id = R.id.auth_network
            background = GradientDrawable().apply { setColor(Color.WHITE); cornerRadius = 12f }
            gravity = Gravity.CENTER
            isClickable = onRoute != null
            isFocusable = onRoute != null
            setOnClickListener { if (!busy) { hideKeyboard(); onRoute?.invoke() } }
            contentDescription = "切换路线"
            controls.add(this)
        }, 24f, if (onExit == null) 78f else 175f, 155f, 47f)
        sheet.place(label(if (registering) "账号注册" else "账号登录", 64f, Color.WHITE).apply {
            id = R.id.auth_title
            gravity = Gravity.CENTER
        }, 0f, 292f, 873f, 106f)

        sheet.place(pillView(FIELD_BACKGROUND), 58f, 492f, 757f, 127f)
        sheet.place(AuthIconView(context, AuthIconView.Kind.ACCOUNT, ICON_BLUE), 92f, 531f, 48f, 50f)
        val account = edit(
            if (registering) "用户名：5–32位字母或数字" else "请输入用户名或手机号",
            accountDraft,
            R.id.auth_account,
            32
        ).apply {
            contentDescription = if (registering) "用户名，5至32位，以字母开头，只含字母和数字" else "用户名或手机号"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            imeOptions = EditorInfo.IME_ACTION_NEXT
            setOnEditorActionListener { _, action, _ ->
                if (action == EditorInfo.IME_ACTION_NEXT) { passwordInput?.requestFocus(); true } else false
            }
        }
        accountInput = account
        sheet.place(account, 170f, 507f, if (rememberedLogins == null) 623f else 536f, 97f)
        if (rememberedLogins != null) {
            val saved = label("⌄",40f,ICON_BLUE).apply { id = R.id.auth_saved_accounts; gravity=Gravity.CENTER; contentDescription="选择已保存账号，最多10个"; setOnClickListener { showRememberedAccounts() } }
            controls.add(saved); sheet.place(saved,718f,509f,76f,94f)
            account.addTextChangedListener(object:TextWatcher {
                override fun beforeTextChanged(s:CharSequence?,start:Int,count:Int,after:Int) {}
                override fun onTextChanged(s:CharSequence?,start:Int,before:Int,count:Int) {
                    val old=autofilled
                    if(!fillingRemembered && old!=null && !s.toString().trim().equals(old.account,true)) {
                        if(passwordInput?.text?.toString()==old.password) passwordInput?.text?.clear()
                        autofilled=null;autofilledID=null
                    }
                }
                override fun afterTextChanged(s:Editable?) {}
            })
        }

        sheet.place(pillView(FIELD_BACKGROUND), 58f, 682f, 757f, 127f)
        sheet.place(AuthIconView(context, AuthIconView.Kind.PASSWORD, ICON_BLUE), 92f, 722f, 48f, 50f)
        val password = edit(
            if (registering) "密码需要8~16位，须含字母和数字" else "请输入密码",
            passwordDraft,
            R.id.auth_password,
            if (registering) 16 else 128
        ).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            typeface = Typeface.DEFAULT
            transformationMethod = if (passwordVisible) null else PasswordTransformationMethod.getInstance()
            imeOptions = EditorInfo.IME_ACTION_DONE
            setOnEditorActionListener { _, action, _ ->
                if (action == EditorInfo.IME_ACTION_DONE) { submitCredentials(); true } else false
            }
        }
        passwordInput = password
        sheet.place(password, 170f, 697f, 536f, 97f)
        val eye = AuthIconView(context, if (passwordVisible) AuthIconView.Kind.EYE else AuthIconView.Kind.EYE_OFF, 0xFF25252A.toInt()).apply {
            id = R.id.auth_password_toggle
            contentDescription = if (passwordVisible) "隐藏密码" else "显示密码"
            isFocusable = true
            setOnClickListener {
                passwordVisible = !passwordVisible
                password.transformationMethod = if (passwordVisible) null else PasswordTransformationMethod.getInstance()
                password.setSelection(password.length())
                kind = if (passwordVisible) AuthIconView.Kind.EYE else AuthIconView.Kind.EYE_OFF
                contentDescription = if (passwordVisible) "隐藏密码" else "显示密码"
            }
        }
        controls.add(eye)
        sheet.place(eye, 718f, 699f, 76f, 94f)

        errorLabel = label("", 29f, Color.WHITE).apply {
            id = R.id.auth_error
            gravity = Gravity.CENTER
            visibility = View.GONE
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        val offset = if (rememberedLogins != null) 100f else 0f
        if (rememberedLogins != null) placeRememberChoice(sheet,817f,Color.WHITE)
        sheet.place(errorLabel, 58f, 817f + offset, 757f, 68f)
        primaryAction = action(if (registering) "注册" else "登录", true) { submitCredentials() }
        sheet.place(primaryAction, 58f, 905f + offset, 757f, 116f)
        sheet.place(action(if (registering) "登录" else "注册", false).apply {
            id = R.id.auth_switch_mode
            setOnClickListener {
                rememberInputs()
                if (autofilled != null) { passwordDraft="";autofilled=null;autofilledID=null }
                hideKeyboard()
                page = if (registering) Page.LOGIN else Page.REGISTER
                render()
            }
        }, 58f, 1061f + offset, 757f, 116f)
        sheet.place(ImageView(context).apply {
            setImageResource(R.drawable.auth_brand)
            scaleType = ImageView.ScaleType.FIT_CENTER
            contentDescription = "$appName 标志"
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }, 342f, 1548f, 189f, 239f)
    }

    private fun buildRegistration(sheet: ReferenceSheet) {
        sheet.place(label("账号注册", 42f, Color.BLACK).apply { id = R.id.auth_title; gravity = Gravity.CENTER }, 180f, 84f, 513f, 80f)
        sheet.place(AuthIconView(context, AuthIconView.Kind.BACK, Color.BLACK).apply {
            id = R.id.auth_back; contentDescription = "返回登录"; setOnClickListener { if (!busy && !avatarLoading) handleBack() }; controls.add(this)
        }, 32f, 84f, 76f, 80f)
        sheet.place(ImageView(context).apply { setImageResource(R.drawable.auth_brand); scaleType = ImageView.ScaleType.FIT_CENTER; importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO }, 340f, 192f, 193f, 244f)
        avatarImage = ImageView(context).apply {
            id = R.id.auth_register_avatar; contentDescription = "点击选择注册头像，必选"; scaleType = ImageView.ScaleType.CENTER_CROP
            background = pill(0xFFEDEFF4.toInt()); clipToOutline = true
            outlineProvider = object : android.view.ViewOutlineProvider() {
                override fun getOutline(view: View, outline: android.graphics.Outline) { outline.setOval(0, 0, view.width, view.height) }
            }
            if (avatarDataURL.isNotEmpty()) {
                val bytes = Base64.decode(avatarDataURL.substringAfter(','), Base64.DEFAULT); setImageBitmap(BitmapFactory.decodeByteArray(bytes, 0, bytes.size))
            } else { setImageResource(android.R.drawable.ic_menu_camera); scaleType = ImageView.ScaleType.CENTER_INSIDE }
            setOnClickListener { pickRegistrationAvatar() }; controls.add(this)
        }.also { sheet.place(it, 345f, 480f, 184f, 184f) }
        avatarStatus = label(if (avatarDataURL.isEmpty()) "点击上传头像（必选）" else "点击更换头像", 28f, 0xFF858993.toInt()).apply { id = R.id.auth_register_avatar_status; gravity = Gravity.CENTER }.also { sheet.place(it, 150f, 677f, 573f, 50f) }
        fun row(y: Float) { sheet.place(pillView(Color.WHITE), 58f, y, 757f, 112f) }
        row(755f)
        accountInput = edit("用户名（5–10位字母+数字）", accountDraft, R.id.auth_account, 10).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            imeOptions = EditorInfo.IME_ACTION_NEXT
            setOnEditorActionListener { _, action, _ -> if (action == EditorInfo.IME_ACTION_NEXT) { nicknameInput?.requestFocus(); true } else false }
        }.also { sheet.place(it, 88f, 765f, 697f, 92f) }
        row(905f)
        nicknameInput = edit("昵称（网名/姓名/别称）", nicknameDraft, R.id.auth_nickname, 32).apply {
            inputType = InputType.TYPE_CLASS_TEXT; imeOptions = EditorInfo.IME_ACTION_NEXT
            setOnEditorActionListener { _, action, _ -> if (action == EditorInfo.IME_ACTION_NEXT) { passwordInput?.requestFocus(); true } else false }
        }.also { sheet.place(it, 88f, 915f, 697f, 92f) }
        row(1055f)
        passwordInput = edit("密码（8–16位字母+数字）", passwordDraft, R.id.auth_password, 16).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD; typeface = Typeface.DEFAULT
            transformationMethod = if (passwordVisible) null else PasswordTransformationMethod.getInstance(); imeOptions = EditorInfo.IME_ACTION_NEXT
            setOnEditorActionListener { _, action, _ -> if (action == EditorInfo.IME_ACTION_NEXT) { captchaInput?.requestFocus(); true } else false }
        }.also { sheet.place(it, 88f, 1065f, 610f, 92f) }
        sheet.place(AuthIconView(context, if (passwordVisible) AuthIconView.Kind.EYE else AuthIconView.Kind.EYE_OFF, 0xFF25252A.toInt()).apply {
            id = R.id.auth_password_toggle; contentDescription = "显示或隐藏密码"; controls.add(this)
            setOnClickListener { passwordVisible = !passwordVisible; passwordInput?.transformationMethod = if (passwordVisible) null else PasswordTransformationMethod.getInstance(); passwordInput?.setSelection(passwordInput?.length() ?: 0); kind = if (passwordVisible) AuthIconView.Kind.EYE else AuthIconView.Kind.EYE_OFF }
        }, 718f, 1064f, 76f, 94f)
        row(1205f)
        val captchaLength=if(BuildConfig.GO_BACKEND)5 else 4
        captchaInput = edit(if(BuildConfig.GO_BACKEND)"5位字母或数字验证码" else "4位数字验证码", "", R.id.auth_captcha_code, captchaLength).apply {
            contentDescription = if(BuildConfig.GO_BACKEND)"5位字母或数字验证码" else "4位数字验证码"
            inputType = if(BuildConfig.GO_BACKEND) InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS else InputType.TYPE_CLASS_NUMBER
            filters = if(BuildConfig.GO_BACKEND) arrayOf(InputFilter.AllCaps(),InputFilter.LengthFilter(5)) else arrayOf(android.text.method.DigitsKeyListener.getInstance("0123456789"), InputFilter.LengthFilter(4))
            imeOptions = EditorInfo.IME_ACTION_DONE; setOnEditorActionListener { _, action, _ -> if (action == EditorInfo.IME_ACTION_DONE) { submitRegistration(); true } else false }
        }.also { sheet.place(it, 88f, 1215f, 340f, 92f) }
        captchaImage = ImageView(context).apply {
            id = R.id.auth_captcha_image; contentDescription = "验证码图片，点击换一张"; scaleType = ImageView.ScaleType.FIT_CENTER
            setOnClickListener { refreshCaptcha() }; controls.add(this)
        }.also { sheet.place(it, 455f, 1215f, 330f, 92f) }
        captchaStatus = label("正在加载验证码…", 24f, 0xFF717481.toInt()).also { sheet.place(it, 58f, 1328f, 500f, 45f) }
        captchaRefresh = label("换一张", 25f, BUTTON_BLUE).apply { id = R.id.auth_captcha_refresh; gravity = Gravity.CENTER; setOnClickListener { refreshCaptcha() }; controls.add(this) }.also { sheet.place(it, 600f, 1328f, 215f, 45f) }
        errorLabel = label("", 40f, 0xFFD33131.toInt()).apply { id = R.id.auth_error; gravity = Gravity.CENTER; maxLines = 4; visibility = View.GONE; accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE }
        val offset = if (rememberedLogins != null) 100f else 0f
        if (rememberedLogins != null) placeRememberChoice(sheet,1390f,0xFF717481.toInt())
        sheet.place(errorLabel, 58f, 1390f + offset, 757f, 210f)
        primaryAction = action("注册", true) { submitRegistration() }; sheet.place(primaryAction, 58f, 1630f + offset, 757f, 116f)
        updateCaptchaControls()
    }

    private fun pickRegistrationAvatar() {
        if (busy || avatarLoading || pickingAvatar || page != Page.REGISTER) return
        rememberInputs(); hideKeyboard(); pickingAvatar = true
        try { val activity = context as android.app.Activity; activity.startActivityForResult(PhotoAlbumPickerActivity.intent(activity), 46) }
        catch (_: Exception) { pickingAvatar = false; showError("相册无法打开，请重试") }
    }

    fun registrationAvatarResult(requestCode: Int, resultCode: Int, data: android.content.Intent?): Boolean {
        if (requestCode != 46 || !pickingAvatar) return false
        pickingAvatar = false
        val uri = data?.data
        if (resultCode != android.app.Activity.RESULT_OK || uri == null || page != Page.REGISTER) return true
        val revision = ++avatarGeneration; avatarLoading = true; avatarStatus?.text = "正在处理头像…"; updateCaptchaControls()
        Thread({
            try {
                val bytes = RegistrationAvatar.prepare(context.applicationContext, uri)
                handler.post {
                    if (revision != avatarGeneration || page != Page.REGISTER || !isAttachedToWindow) return@post
                    avatarDataURL = RegistrationAvatar.dataURL(bytes); avatarImage?.scaleType = ImageView.ScaleType.CENTER_CROP
                    avatarImage?.setImageBitmap(BitmapFactory.decodeByteArray(bytes, 0, bytes.size)); avatarLoading = false; avatarStatus?.text = "点击更换头像"; errorLabel.visibility = View.GONE; updateCaptchaControls()
                }
            } catch (error: Exception) { handler.post { if (revision == avatarGeneration && page == Page.REGISTER && isAttachedToWindow) { avatarLoading = false; avatarStatus?.text = "请选择头像（必选）"; showError(error.message ?: "头像读取失败，请重试"); updateCaptchaControls() } } }
        }, "registration-avatar").apply { isDaemon = true; start() }
        return true
    }

    private fun dp(value: Float) = (value * resources.displayMetrics.density).roundToInt()
    private fun placeRememberChoice(sheet: ReferenceSheet, y: Float, color: Int) {
        val choice = CheckBox(context).apply {
            id=R.id.auth_remember_password; text="记住密码（本机最多10个账号）"; setTextColor(color)
            setTextSize(TypedValue.COMPLEX_UNIT_PX,28f); isChecked=rememberPasswordFlag
            contentDescription="记住账号和密码，最多10个"; controls.add(this)
            setOnCheckedChangeListener { button, checked ->
                rememberPasswordFlag=checked
                if(!checked) try { rememberedLogins?.remove(loginServer,id=autofilledID,account=accountInput?.text?.toString()) }
                catch (_: Exception) { button.isChecked=true; showError("无法移除保存的账号，请重试") }
            }
        }
        rememberCheck=choice; sheet.place(choice,58f,y,757f,96f)
    }
    private fun showRememberedAccounts() {
        if(busy || (context as? MainActivity)?.isAppLocked()==true) return
        val store=rememberedLogins ?: return
        try {
            val rows=store.list(loginServer)
            val content=LinearLayout(context).apply { orientation=LinearLayout.VERTICAL; id=R.id.auth_saved_account_list; setPadding(12,8,12,8) }
            if(rows.isEmpty())content.addView(TextView(context).apply { text="登录成功后可在这里选择账号"; setPadding(24,24,24,24) })
            val dialog=AlertDialog.Builder(context).setTitle("已保存账号（最多10个）")
                .setView(ScrollView(context).apply { addView(content) }).setNegativeButton("关闭",null).create()
            rows.forEach { item ->
                val line=LinearLayout(context).apply { orientation=LinearLayout.HORIZONTAL; gravity=Gravity.CENTER_VERTICAL; setPadding(8,8,8,8) }
                val choose=LinearLayout(context).apply {
                    orientation=LinearLayout.HORIZONTAL; gravity=Gravity.CENTER_VERTICAL; setPadding(8,10,8,10); isClickable=true
                    contentDescription="选择账号 ${item.nickname} ${item.account}"
                }
                choose.addView(TextView(context).apply {
                    text=(item.nickname.ifBlank { item.account }).take(1); textSize=18f; gravity=Gravity.CENTER; setTextColor(BUTTON_BLUE)
                    background=GradientDrawable().apply { shape=GradientDrawable.OVAL; setColor(0xFFE7EFFF.toInt()) }
                },LinearLayout.LayoutParams(dp(38f),dp(38f)))
                choose.addView(LinearLayout(context).apply {
                    orientation=LinearLayout.VERTICAL;setPadding(dp(12f),0,0,0)
                    addView(TextView(context).apply { text=item.nickname.ifBlank { item.account }; textSize=15f; setTextColor(Color.BLACK); maxLines=1;ellipsize=TextUtils.TruncateAt.END })
                    addView(TextView(context).apply { text=item.account;textSize=12f;setTextColor(Color.GRAY);maxLines=1 })
                },LinearLayout.LayoutParams(0,ViewGroup.LayoutParams.WRAP_CONTENT,1f))
                choose.setOnClickListener {
                    if(busy || (context as? MainActivity)?.isAppLocked()==true)return@setOnClickListener
                    try {
                        val saved=store.credential(loginServer,item.id)
                        fillingRemembered=true
                        accountDraft=saved.account;passwordDraft=saved.password
                        accountInput?.setText(saved.account);passwordInput?.setText(saved.password)
                        autofilled=saved;autofilledID=item.id;rememberPasswordFlag=true;rememberCheck?.isChecked=true
                        fillingRemembered=false
                        passwordVisible=false;passwordInput?.transformationMethod=PasswordTransformationMethod.getInstance()
                        findViewById<AuthIconView>(R.id.auth_password_toggle)?.apply { kind=AuthIconView.Kind.EYE_OFF;contentDescription="显示密码" }
                        dialog.dismiss();passwordInput?.requestFocus()
                    } catch (_: Exception) { fillingRemembered=false;showError("无法读取保存的密码，请手动输入") }
                }
                line.addView(choose,LinearLayout.LayoutParams(0,ViewGroup.LayoutParams.WRAP_CONTENT,1f))
                line.addView(TextView(context).apply {
                    text="×";textSize=24f;gravity=Gravity.CENTER;contentDescription="移除已记住的账号 ${item.account}";isClickable=true
                    setOnClickListener {
                        try {
                            store.remove(loginServer,id=item.id);content.removeView(line)
                            if(autofilledID==item.id) { autofilled=null;autofilledID=null;passwordDraft="";passwordInput?.text?.clear() }
                        } catch (_: Exception) { showError("移除账号失败，请重试") }
                    }
                },LinearLayout.LayoutParams(dp(42f),dp(48f)))
                content.addView(line)
            }
            rememberedDialog?.dismiss();rememberedDialog=dialog;hideKeyboard();dialog.show()
        } catch (_: Exception) { showError("无法读取已保存账号，请手动登录") }
    }
    private fun submitCredentials() {
        if (busy) return
        rememberInputs()
        if (page == Page.REGISTER) {
            submitRegistration()
        } else {
            if (accountDraft.isBlank() || passwordDraft.isEmpty()) {
                showError("请输入账号和密码")
                return
            }
            hideKeyboard()
            setBusy(true)
            onLogin(accountDraft, passwordDraft)
        }
    }

    private fun submitRegistration() {
        if (busy || avatarLoading || page != Page.REGISTER) return
        rememberInputs()
        if (avatarDataURL.isEmpty()) { showError("请先选择头像"); return }
        if (!Regex("^[A-Za-z][A-Za-z0-9]{4,9}$").matches(accountDraft) || !accountDraft.any { it in '0'..'9' }) { showError("用户名需5到10位，以字母开头，包含字母和数字"); accountInput?.requestFocus(); return }
        if (passwordDraft.length !in 8..16 || !passwordDraft.any { it in 'A'..'Z' || it in 'a'..'z' } || !passwordDraft.any { it in '0'..'9' } || passwordDraft.any { it.isWhitespace() }) { showError("密码需8~16位，包含字母和数字，不能有空格"); passwordInput?.requestFocus(); return }
        val count = nicknameDraft.codePointCount(0, nicknameDraft.length)
        if (count !in 2..32) {
            showError("昵称需要2~32个字符")
            nicknameInput?.requestFocus()
            return
        }
        if (captchaId.isEmpty() || SystemClock.elapsedRealtime() >= captchaExpiresAt) {
            showError("请先刷新并填写有效的图形验证码")
            if (!captchaLoading) refreshCaptcha()
            return
        }
        val code = captchaInput?.text?.toString()?.trim()?.uppercase(java.util.Locale.ROOT).orEmpty()
        if (!(if(BuildConfig.GO_BACKEND)Regex("^[A-Z0-9]{5}$") else Regex("^[0-9]{4}$")).matches(code)) {
            showError(if(BuildConfig.GO_BACKEND)"请输入图片中的5位字母或数字" else "请输入图片中的4位数字")
            captchaInput?.requestFocus()
            return
        }
        val challenge = captchaId
        invalidateCaptcha()
        hideKeyboard()
        setBusy(true)
        captchaStatus?.text = "正在验证…"
        onRegister(accountDraft, passwordDraft, nicknameDraft, challenge, code, avatarDataURL)
    }

    private fun setBusy(value: Boolean) {
        busy = value
        errorLabel.visibility = View.GONE
        controls.forEach { it.isEnabled = !value }
        primaryAction.text = if (value) {
            if (page == Page.REGISTER) "注册中…" else "登录中…"
        } else when (page) { Page.LOGIN -> "登录"; Page.REGISTER -> "注册" }
        primaryAction.alpha = if (value) 0.7f else 1f
        updateCaptchaControls()
    }

    private fun invalidateCaptcha() {
        captchaGeneration++
        captchaId = ""
        captchaExpiresAt = 0
        captchaLoading = false
        captchaExpiry?.let(handler::removeCallbacks)
        captchaExpiry = null
    }

    private fun updateCaptchaControls() {
        if (page != Page.REGISTER) return
        val valid = captchaId.isNotEmpty() && SystemClock.elapsedRealtime() < captchaExpiresAt
        primaryAction.isEnabled = !busy && !avatarLoading && valid
        primaryAction.alpha = if (primaryAction.isEnabled) 1f else 0.55f
        captchaInput?.isEnabled = !busy && valid
        captchaImage?.isEnabled = !busy && !captchaLoading
        captchaRefresh?.isEnabled = !busy && !captchaLoading
    }

    private fun refreshCaptcha() {
        if (busy || captchaLoading || page != Page.REGISTER || !isAttachedToWindow) return
        invalidateCaptcha()
        val request = captchaGeneration
        val startedAt = SystemClock.elapsedRealtime()
        captchaLoading = true
        captchaInput?.text?.clear()
        captchaImage?.setImageDrawable(null)
        captchaStatus?.text = "正在加载验证码…"
        updateCaptchaControls()
        loadRegisterChallenge { data, failure ->
            if (request != captchaGeneration || page != Page.REGISTER || !isAttachedToWindow || busy) return@loadRegisterChallenge
            captchaLoading = false
            try {
                if (data == null) throw IllegalStateException(failure ?: "验证码加载失败，请点击换一张")
                val id = data.getString("challenge_id")
                val raw = data.getString("image_data_url")
                val ttl = data.getInt("expires_in")
                require(id.isNotBlank() && id.length <= 200 && data.getInt("code_length") == (if(BuildConfig.GO_BACKEND)5 else 4) && ttl in 1..120 && raw.startsWith("data:image/png;base64,") && raw.length <= 262144) { "验证码数据无效，请重试" }
                val bytes = Base64.decode(raw.substringAfter(','), Base64.DEFAULT)
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                require(bounds.outWidth in 1..1600 && bounds.outHeight in 1..600) { "验证码图片无效，请重试" }
                val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: throw IllegalStateException("验证码图片加载失败")
                val expires = startedAt + ttl * 1000L
                require(expires > SystemClock.elapsedRealtime()) { "验证码已过期，请换一张" }
                captchaImage?.setImageBitmap(bitmap)
                captchaId = id
                captchaExpiresAt = expires
                captchaStatus?.text = if(BuildConfig.GO_BACKEND)"请输入图片中的5位字母或数字" else "请输入图片中的4位数字"
                captchaExpiry = Runnable {
                    if (request == captchaGeneration && page == Page.REGISTER && !busy) {
                        captchaId = ""
                        captchaInput?.text?.clear()
                        captchaStatus?.text = "验证码已过期，请换一张"
                        updateCaptchaControls()
                    }
                }.also { handler.postDelayed(it, expires - SystemClock.elapsedRealtime()) }
            } catch (error: Exception) {
                captchaId = ""
                captchaStatus?.text = failure ?: error.message ?: "验证码加载失败，请点击换一张"
            }
            updateCaptchaControls()
        }
    }

    private fun edit(hintText: String, value: String, viewId: Int, maxLength: Int) = EditText(context).apply {
        id = viewId
        hint = hintText
        contentDescription = when (viewId) { R.id.auth_account -> "账号"; R.id.auth_password -> "密码"; else -> "昵称" }
        setText(value)
        setTextColor(0xFF202127.toInt())
        setHintTextColor(0xFF9E9EA6.toInt())
        background = null
        setPadding(0, 0, 0, 0)
        setSingleLine(true)
        ellipsize = TextUtils.TruncateAt.END
        typeface = Typeface.DEFAULT
        gravity = Gravity.CENTER_VERTICAL
        filters = arrayOf(InputFilter.LengthFilter(maxLength))
        minimumHeight = 0
        includeFontPadding = false
        setTextSize(TypedValue.COMPLEX_UNIT_PX, 34f)
        controls.add(this)
    }

    private fun action(title: String, primary: Boolean, onClick: () -> Unit = {}) = label(title, 40f, if (primary) Color.WHITE else ICON_BLUE).apply {
        id = R.id.auth_primary_action
        gravity = Gravity.CENTER
        background = pill(if (primary) BUTTON_BLUE else Color.WHITE)
        isFocusable = true
        setOnClickListener { onClick() }
        controls.add(this)
    }

    private fun label(value: String, size: Float, color: Int) = TextView(context).apply {
        text = value
        setTextColor(color)
        typeface = Typeface.DEFAULT
        includeFontPadding = false
        setTextSize(TypedValue.COMPLEX_UNIT_PX, size)
    }

    private fun pillView(color: Int) = View(context).apply { background = pill(color) }
    private fun pill(color: Int) = GradientDrawable().apply { setColor(color); cornerRadius = 10000f }
    private fun hideKeyboard() {
        (context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(windowToken, 0)
        clearFocus()
    }

    companion object {
        private const val PROFILE_BACKGROUND = 0xFFF8F7FF.toInt()
        private const val FIELD_BACKGROUND = 0xFFF4F2FA.toInt()
        private const val ICON_BLUE = 0xFF001C96.toInt()
        private const val BUTTON_BLUE = 0xFF0025DF.toInt()
    }
}

/** Width-based scaling preserves the reference geometry; a ScrollView handles the keyboard. */
private class ReferenceSheet(context: Context) : ViewGroup(context) {
    private data class Placement(val view: View, val x: Float, val y: Float, val width: Float, val height: Float, val fontSize: Float?)
    private val placements = mutableListOf<Placement>()

    fun place(view: View, x: Float, y: Float, width: Float, height: Float) {
        placements.add(Placement(view, x, y, width, height, (view as? TextView)?.textSize))
        addView(view)
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val availableWidth = MeasureSpec.getSize(widthMeasureSpec)
        val scale = availableWidth / 873f
        val sheetHeight = (1920f * scale).roundToInt()
        setMeasuredDimension(availableWidth, resolveSize(sheetHeight, heightMeasureSpec))
        for (item in placements) {
            if (item.view is TextView && item.fontSize != null) item.view.setTextSize(TypedValue.COMPLEX_UNIT_PX, item.fontSize * scale)
            if (item.view.id == R.id.auth_network) (item.view.background as GradientDrawable).cornerRadius = 12f * scale
            item.view.measure(MeasureSpec.makeMeasureSpec((item.width * scale).roundToInt(), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec((item.height * scale).roundToInt(), MeasureSpec.EXACTLY))
        }
    }

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        val scale = width / 873f
        for (item in placements) {
            val x = (item.x * scale).roundToInt()
            val y = (item.y * scale).roundToInt()
            item.view.layout(x, y, x + item.view.measuredWidth, y + item.view.measuredHeight)
        }
    }
}

/** Flat vector strokes keep the supplied icons crisp at every screen density. */
private class AuthIconView(context: Context, kind: Kind, private val color: Int) : View(context) {
    enum class Kind { ACCOUNT, PASSWORD, EYE, EYE_OFF, BACK, BRAND }
    var kind: Kind = kind
        set(value) { field = value; invalidate() }
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        canvas.save()
        if (kind == Kind.BRAND) {
            canvas.scale(width / 100f, height / 120f)
            paint.color = color
            paint.style = Paint.Style.FILL
            val ring = Path().apply {
                fillType = Path.FillType.EVEN_ODD
                addOval(RectF(5f, 5f, 100f, 117f), Path.Direction.CW)
                addOval(RectF(22f, 22f, 82f, 98f), Path.Direction.CW)
            }
            val notch = Path().apply { moveTo(58f, 0f); lineTo(53f, 22f); lineTo(68f, 26f); lineTo(66f, 0f); close() }
            ring.op(notch, Path.Op.DIFFERENCE)
            canvas.drawPath(ring, paint)
            canvas.drawPath(Path().apply { moveTo(18f, 94f); lineTo(4f, 104f); lineTo(31f, 115f); close() }, paint)
            canvas.drawRoundRect(RectF(35f, 54f, 44f, 74f), 5f, 5f, paint)
            canvas.drawRoundRect(RectF(59f, 54f, 68f, 74f), 5f, 5f, paint)
        } else {
            val side = minOf(width, height).toFloat() * if (kind == Kind.EYE || kind == Kind.EYE_OFF) 0.7f else 1f
            canvas.translate((width - side) / 2f, (height - side) / 2f)
            canvas.scale(side / 48f, side / 48f)
            paint.color = color
            paint.style = Paint.Style.STROKE
            paint.strokeWidth = if (kind == Kind.BACK) 2.2f else 3.3f
            when (kind) {
                Kind.ACCOUNT -> {
                    canvas.drawCircle(24f, 12f, 8f, paint)
                    canvas.drawPath(Path().apply { moveTo(6f, 44f); cubicTo(7f, 21f, 41f, 21f, 42f, 44f) }, paint)
                }
                Kind.PASSWORD -> {
                    canvas.drawRoundRect(RectF(7f, 22f, 41f, 45f), 1.5f, 1.5f, paint)
                    canvas.drawPath(Path().apply { moveTo(14f, 22f); lineTo(14f, 14f); cubicTo(14f, 0f, 34f, 0f, 34f, 14f); lineTo(34f, 22f) }, paint)
                    canvas.drawLine(24f, 30f, 24f, 37f, paint)
                }
                Kind.EYE, Kind.EYE_OFF -> {
                    canvas.drawPath(Path().apply { moveTo(4f, 24f); cubicTo(14f, 9f, 34f, 9f, 44f, 24f); cubicTo(34f, 39f, 14f, 39f, 4f, 24f) }, paint)
                    canvas.drawCircle(24f, 24f, 6f, paint)
                    if (kind == Kind.EYE_OFF) canvas.drawLine(5f, 7f, 43f, 41f, paint)
                }
                Kind.BACK -> canvas.drawPath(Path().apply { moveTo(27f, 11f); lineTo(15f, 24f); lineTo(27f, 37f) }, paint)
                else -> Unit
            }
        }
        canvas.restore()
    }
}

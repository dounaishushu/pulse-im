package com.pulseim.android

import android.app.Activity
import android.app.Dialog
import android.content.Context
import android.graphics.Color
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.text.InputFilter
import android.text.InputType
import android.view.*
import android.widget.*
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey
import android.util.Base64

internal object AppPasscode {
    private const val ALIAS = "pulse_passcode_hmac_v1"
    private fun prefs(context: Context) = context.getSharedPreferences("pulse_passcode", Context.MODE_PRIVATE)
    fun enabled(context: Context) = prefs(context).contains("verifier")
    @Synchronized private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_HMAC_SHA256, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY).setDigests(KeyProperties.DIGEST_SHA256).build())
        }.generateKey()
    }
    private fun signature(pin: String, salt: String) = Mac.getInstance("HmacSHA256").apply { init(key()) }.doFinal("$salt:$pin".toByteArray(Charsets.UTF_8))
    @Synchronized fun set(context: Context, pin: String) {
        require(Regex("^[0-9]{6}$").matches(pin)) { "锁定码必须是六位数字" }
        val salt = Base64.encodeToString(ByteArray(24).also { SecureRandom().nextBytes(it) }, Base64.NO_WRAP)
        require(prefs(context).edit().putString("salt", salt).putString("verifier", Base64.encodeToString(signature(pin, salt), Base64.NO_WRAP)).putInt("failures", 0).putLong("blocked_until", 0).commit()) { "锁定码保存失败" }
    }
    @Synchronized fun verify(context: Context, pin: String) {
        val prefs = prefs(context)
        require(enabled(context)) { "尚未设置锁定码" }
        val remaining = prefs.getLong("blocked_until", 0) - System.currentTimeMillis()
        require(remaining <= 0) { "尝试次数过多，请${(remaining + 999) / 1000}秒后再试" }
        val stored = Base64.decode(requireNotNull(prefs.getString("verifier", null)), Base64.NO_WRAP)
        val valid = MessageDigest.isEqual(stored, signature(pin, requireNotNull(prefs.getString("salt", null))))
        if (!valid) {
            val failures = prefs.getInt("failures", 0) + 1
            prefs.edit().putInt("failures", failures).putLong("blocked_until", if (failures >= 5) System.currentTimeMillis() + 60000 else 0).commit()
            throw IllegalArgumentException(if (failures >= 5) "尝试次数过多，请60秒后再试" else "锁定码不正确")
        }
        prefs.edit().putInt("failures", 0).putLong("blocked_until", 0).commit()
    }
    @Synchronized fun disable(context: Context) { require(prefs(context).edit().clear().commit()) { "关闭锁定码失败" } }
}

/** A separate modal window prevents asynchronous page updates and the Back key bypassing the lock. */
internal class AppLock(private val activity: Activity, private val unlocked: () -> Unit) {
    var locked = AppPasscode.enabled(activity)
        private set
    private var dialog: Dialog? = null
    fun lock() { if (AppPasscode.enabled(activity)) { locked = true; enforce() } }
    fun enforce() {
        if (!locked || activity.isFinishing || activity.isDestroyed || dialog?.isShowing == true) return
        activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val content = ChatScreen(activity).apply {
            id = R.id.passcode_overlay; gravity = Gravity.CENTER; setBackgroundColor(AppAppearance.background(0xFFF7F7F7.toInt())); setPadding(dp(30), dp(25), dp(30), dp(25))
        }
        content.addView(content.label(activity.getString(R.string.app_name), 24f).apply { gravity = Gravity.CENTER })
        content.addView(content.label("输入锁定码", 18f).apply { gravity = Gravity.CENTER }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = content.dp(30) })
        val input = EditText(activity).apply { id = R.id.passcode_unlock_input; inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD; filters = arrayOf(InputFilter.LengthFilter(6)); gravity = Gravity.CENTER; hint = "六位数字"; isSingleLine = true; textSize = 24f }
        content.addView(input, LinearLayout.LayoutParams(-1, content.dp(70)).apply { topMargin = content.dp(20) })
        val error = content.label("", 14f, 0xFFD44545.toInt()).apply { id = R.id.passcode_error; gravity = Gravity.CENTER }
        content.addView(error, LinearLayout.LayoutParams(-1, content.dp(60)))
        content.addView(content.label("解锁", 18f, Color.WHITE).apply {
            id = R.id.passcode_unlock; gravity = Gravity.CENTER; background = content.surface(MY_BLUE, 24)
            setOnClickListener {
                try {
                    AppPasscode.verify(activity, input.text.toString()); input.text.clear()
                    (activity.getSystemService(Context.INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager).hideSoftInputFromWindow(input.windowToken, 0)
                    locked = false; dialog?.dismiss(); dialog = null; unlocked()
                } catch (e: Exception) { error.text = e.message ?: "解锁失败"; input.text.clear() }
            }
        }, LinearLayout.LayoutParams(-1, content.dp(52)))
        AppAppearance.apply(content)
        dialog = Dialog(activity, if (AppAppearance.dark) R.style.AppThemeDark else R.style.AppTheme).apply {
            setCancelable(false); setCanceledOnTouchOutside(false); setContentView(content)
            window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
            show(); window?.setLayout(-1, -1)
        }
    }
    fun destroy() { dialog?.dismiss(); dialog = null }
}

internal object TwoStepLogin {
    const val REQUIRED = "请输入两步验证密码或恢复码。"
    fun required(error: Exception) = error.message == REQUIRED || error.message == "两步验证密码或恢复码不正确。"
    fun prompt(activity: Activity, submit: (String) -> Unit) {
        val input = EditText(activity).apply { id = R.id.two_step_login_code; hint = "两步验证密码或一次性恢复码"; inputType = 0x81; isSingleLine = true; filters = arrayOf(InputFilter.LengthFilter(128)); setPadding(45, 20, 45, 20) }
        val dialog = android.app.AlertDialog.Builder(activity).setTitle("两步验证").setView(input).setNegativeButton("取消", null).setPositiveButton("验证", null).create()
        dialog.setOnShowListener { dialog.getButton(Dialog.BUTTON_POSITIVE).setOnClickListener { val code = input.text.toString(); if (code.isBlank()) input.error = "请输入验证密码或恢复码" else { input.text.clear(); dialog.dismiss(); submit(code) } } }
        dialog.show(); dialog.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    }
}

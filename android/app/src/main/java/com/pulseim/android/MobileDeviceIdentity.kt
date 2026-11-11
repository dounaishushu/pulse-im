package com.pulseim.android

import android.content.Context
import android.os.Build
import android.provider.Settings
import java.security.MessageDigest
import java.util.UUID

/** Independent of accounts, login tokens and the user-clearable media cache. */
object MobileDeviceIdentity {
    @Volatile private var value: String? = null
    @Synchronized fun initialize(context: Context) {
        if (value != null) return
        val raw = runCatching { Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID) }.getOrNull()
            ?.trim()?.takeIf { it.isNotEmpty() && it != "9774d56d682e549c" }
        val stable = raw ?: run {
            val preferences = context.applicationContext.getSharedPreferences("mobile_device_identity_v1", Context.MODE_PRIVATE)
            preferences.getString("installation", null) ?: UUID.randomUUID().toString().also {
                check(preferences.edit().putString("installation", it).commit()) { "无法保存设备标识，请重试" }
            }
        }
        value = "android_" + MessageDigest.getInstance("SHA-256").digest(("pulse-mobile-device-v1:" + stable).toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 255) }
    }
    fun id(): String = checkNotNull(value) { "设备验证尚未就绪，请重新打开应用" }
    fun name(): String = "${Build.MANUFACTURER} ${Build.MODEL}".filter { !it.isISOControl() }.trim().take(128)
}

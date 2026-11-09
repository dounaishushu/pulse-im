package com.pulseim.android

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.TextView

internal object AppAppearance {
    var dark = false
        private set
    var language = "zh"
        private set
    var fontScale = 1f
        private set
    var mode = "system"
        private set
    var messageSize = 16
        private set
    fun load(context: Context) {
        val prefs = context.getSharedPreferences("pulse_appearance", Context.MODE_PRIVATE)
        mode = prefs.getString("theme_mode", if (prefs.contains("dark")) { if (prefs.getBoolean("dark", false)) "dark" else "light" } else "system") ?: "system"
        dark = mode == "dark" || (mode == "system" && context.resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK == android.content.res.Configuration.UI_MODE_NIGHT_YES)
        messageSize = prefs.getInt("message_size", 16).coerceIn(12, 24)
        if (context is android.app.Activity) context.setTheme(if (dark) R.style.AppThemeDark else R.style.AppTheme)
        language = prefs.getString("language", "zh") ?: "zh"
        fontScale = prefs.getFloat("font_scale", 1f).coerceIn(.85f, 1.2f)
        val locale = if (language == "en") java.util.Locale.ENGLISH else java.util.Locale.SIMPLIFIED_CHINESE
        val configuration = android.content.res.Configuration(context.resources.configuration)
        configuration.setLocale(locale)
        context.resources.updateConfiguration(configuration, context.resources.displayMetrics)
    }
    fun set(context: Context, name: String, value: String) {
        val edit = context.getSharedPreferences("pulse_appearance", Context.MODE_PRIVATE).edit()
        when (name) {
            "dark" -> { edit.putBoolean(name, value == "true"); edit.putString("theme_mode", if (value == "true") "dark" else "light") }
            "theme_mode" -> { require(value in listOf("system", "light", "dark")); edit.putString(name, value) }
            "message_size" -> edit.putInt(name, value.toInt().coerceIn(12, 24))
            "language" -> edit.putString(name, value)
            "font_scale" -> edit.putFloat(name, value.toFloat())
        }
        edit.commit(); load(context)
    }
    fun background(color: Int): Int = if (!dark) color else when (color) {
        Color.WHITE, 0xFFFCFCFF.toInt() -> 0xFF22252D.toInt()
        0xFFF8F7FF.toInt(), 0xFFF7F7F7.toInt(), 0xFFF5F7F8.toInt(), 0xFFF3F2FA.toInt(), 0xFFF7F6FC.toInt(), 0xFFEFEFEF.toInt(), 0xFFF5F4F9.toInt() -> 0xFF171A21.toInt()
        0xFFE1EEFF.toInt() -> 0xFF27436A.toInt()
        0xFFF0EFF6.toInt(), 0xFFE7ECEE.toInt(), 0xFFEEEEEE.toInt() -> 0xFF343841.toInt()
        0xFFE3F5EE.toInt() -> 0xFF26443D.toInt()
        else -> color
    }
    fun ink(color: Int): Int {
        if (!dark || Color.alpha(color) == 0) return color
        return if (Color.red(color) < 85 && Color.green(color) < 85 && Color.blue(color) < 85) 0xFFF3F3F7.toInt() else color
    }
    // Translate the native navigation and account/settings controls; user content is preserved.
    private val english = mapOf(
        "跟随系统" to "System default", "浅色模式" to "Light", "深色模式" to "Dark", "消息文字大小" to "Message text size",
        "自动跟随设备的浅色或深色外观" to "Use the device's light or dark appearance", "始终使用浅色外观" to "Always use light appearance", "始终使用深色外观" to "Always use dark appearance",
        "我的" to "Me", "聊天" to "Chats", "消息" to "Messages", "联系人" to "Contacts", "发现" to "Discover",
        "我的二维码" to "My QR code", "保存二维码" to "Save QR code", "正在保存…" to "Saving…",
        "扫一扫上面的二维码图案，加我好友" to "Scan the QR code above to add me as a friend", "二维码已保存到相册" to "QR code saved to Photos",
        "需要允许保存图片权限才能保存二维码，可再次点击重试" to "Allow photo saving, then try again", "未保存二维码" to "QR code was not saved",
        "保存失败，请检查相册空间后重试" to "Couldn't save. Check available storage and try again",
        "外观显示" to "Appearance", "隐私安全" to "Privacy & security", "通知声音" to "Notifications", "语言设置" to "Language",
        "清除缓存" to "Clear cache", "上传日志" to "Upload diagnostics", "编辑资料" to "Edit profile", "添加账号" to "Add account", "退出登录" to "Sign out",
        "昵称" to "Nickname", "账号" to "Username", "修改登录密码" to "Change password", "生日" to "Birthday", "性别" to "Gender",
        "修改个人简介，让人们更了解你" to "Add a bio to tell people about you", "个人简介" to "Bio", "当前使用" to "Active", "重新登录" to "Sign in again",
        "轻触头像以切换账号" to "Tap an avatar to switch accounts", "夜间模式" to "Dark mode", "字体大小" to "Text size", "标准" to "Normal",
        "简体中文" to "简体中文", "小" to "Small", "大" to "Large", "手机号可见范围" to "Phone visibility", "手机号搜索" to "Find by phone",
        "最近登录时间" to "Last seen", "群组邀请" to "Group invites", "自动删除账号" to "Delete inactive account", "登录设备" to "Sessions", "屏蔽联系人" to "Blocked contacts",
        "所有人" to "Everyone", "仅联系人" to "Contacts only", "不允许" to "Nobody", "开启" to "On", "关闭" to "Off", "消息通知" to "Message notifications",
        "在私聊中" to "Private chats", "在群组里" to "Groups", "在频道中" to "Channels", "提示声音" to "Sound", "振动" to "Vibration", "显示消息预览" to "Message preview",
        "系统通知权限" to "System notification permission", "已允许" to "Allowed", "未允许" to "Not allowed", "可用余额" to "Available balance", "冻结余额" to "Frozen balance",
        "加载更多" to "Load more", "正在加载…" to "Loading…", "重新加载" to "Retry",
        "我的群组" to "My groups", "我的频道" to "My channels", "新的朋友" to "New friends", "添加好友" to "Add friend", "搜索用户" to "Search users",
        "您还未关注任何频道" to "You haven't followed any channels", "您还未加入群组" to "You haven't joined any groups", "您还未添加联系人" to "You haven't added contacts",
        "暂时未有新申请" to "No new requests", "暂无消息" to "No messages", "账号注册" to "Create account", "账号登录" to "Sign in", "注册" to "Register", "登录" to "Sign in",
        "完善个人信息" to "Complete profile", "完成" to "Done", "返回" to "Back", "保存" to "Save", "取消" to "Cancel", "男" to "Male", "女" to "Female", "保密" to "Private"
    )
    fun text(value: String): String = if (language == "en") english[value] ?: value else value
    fun apply(view: View) {
        if (view !is AuthFlowView) {
            when (val bg = view.background) {
                is ColorDrawable -> bg.color = background(bg.color)
                is GradientDrawable -> bg.color?.defaultColor?.let { bg.setColor(background(it)) }
            }
            if (view is TextView) {
                view.setTextColor(ink(view.currentTextColor))
                if (view !is EditText && view.getTag(R.id.appearance_user_content) != true) view.text = text(view.text.toString())
                val original = (view.getTag(R.id.appearance_text_size) as? Float) ?: view.textSize.also { view.setTag(R.id.appearance_text_size, it) }
                if (view.getTag(R.id.appearance_message) == true) view.textSize = messageSize.toFloat()
                else view.setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX, original * fontScale)
            }
        } else return // The reference registration gradient has its own fixed palette.
        if (view is ViewGroup) for (i in 0 until view.childCount) apply(view.getChildAt(i))
    }
}

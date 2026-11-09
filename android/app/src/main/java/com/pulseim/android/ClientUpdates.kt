package com.pulseim.android
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import org.json.JSONObject

internal object ClientUpdates {
    private var owner = java.lang.ref.WeakReference<Activity>(null)
    private var baseUrl = ""
    private var dialog: AlertDialog? = null
    private var prompted = ""
    fun bind(activity: Activity, base: String) { owner = java.lang.ref.WeakReference(activity); baseUrl = base }
    fun refreshRequired() {
        val activity = owner.get() ?: return
        val endpoint = baseUrl
        Thread {
            runCatching { val config = ApiClient(endpoint).clientConfig(); activity.runOnUiThread { if (!activity.isFinishing && !activity.isDestroyed) apply(activity, config.put("force_update", true)) } }
        }.start()
    }
    fun apply(activity: Activity, config: JSONObject) {
        val latest = config.optString("latest_version")
        if (!ClientPolicy.newer(latest, BuildConfig.VERSION_NAME)) { dialog?.dismiss(); dialog = null; return }
        val forced = config.optBoolean("force_update")
        val url = config.optString("android_download_url")
        if (dialog?.isShowing == true || (!forced && prompted == latest)) return
        prompted = latest
        val builder = AlertDialog.Builder(activity).setTitle(if (forced) "请更新后继续使用" else "发现新版本 $latest")
            .setMessage(config.optString("update_description").ifBlank { "当前版本 ${BuildConfig.VERSION_NAME}，最新版本 $latest" } + if (!ClientPolicy.secureEndpoint(url, debug = false)) "\n更新地址尚未配置，请联系管理员。" else "")
            .setCancelable(!forced).setPositiveButton("打开更新地址", null)
        if (!forced) builder.setNegativeButton("稍后", null)
        else builder.setNegativeButton("退出应用") { _, _ -> activity.finishAndRemoveTask() }
        dialog = builder.create().also { d ->
            d.setOnShowListener { d.getButton(AlertDialog.BUTTON_POSITIVE).apply {
                isEnabled = ClientPolicy.secureEndpoint(url, debug = false)
                setOnClickListener { runCatching { activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }; if (!forced) d.dismiss() }
            } }
            d.show()
        }
    }
}

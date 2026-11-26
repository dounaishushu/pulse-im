package com.pulseim.android
import android.content.Context
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
internal object PushNotifications {
    private val executor = Executors.newSingleThreadScheduledExecutor()
    @Volatile private var registration: PushRegistration? = null
    @Volatile var foreground = false
    @Volatile var activeConversation = 0
    private fun base(context: Context): String = (
        if (BuildConfig.GO_BACKEND && BuildConfig.DEBUG) context.getSharedPreferences("pulse_im_session", Context.MODE_PRIVATE).getString("go_api_base_url", null) else null
    )?.trimEnd('/') ?: context.getString(R.string.pulse_api_base_url).trimEnd('/')
    private fun account(context: Context, allowDisabled: Boolean = false): PushAccount? {
        if (!allowDisabled && context.getSharedPreferences("pulse_push", Context.MODE_PRIVATE).getBoolean("disabled", false)) return null
        return try {
            val endpoint = base(context)
            val sessions = AccountSessions(context, if (BuildConfig.GO_BACKEND) endpoint else null)
            val id = sessions.activeId(); val token = sessions.token() ?: return null
            if (id <= 0 || sessions.activeId() != id) null else PushAccount(endpoint, id, token)
        } catch (error: Exception) { ClientDiagnostics.get(context).fault("ANDROID_PUSH_ACCOUNT", error); null }
    }
    private fun registration(context: Context): PushRegistration = registration ?: synchronized(this) {
        registration ?: run {
            val app = context.applicationContext
            PushRegistration(object : PushRegistrationPorts {
                override fun account() = account(app)
                override fun execute(task: () -> Unit) { executor.execute(task) }
                override fun schedule(delayMs: Long, task: () -> Unit): () -> Unit {
                    val future = executor.schedule(task, delayMs, TimeUnit.MILLISECONDS)
                    return { future.cancel(false); Unit }
                }
                override fun obtainToken(received: (String) -> Unit, failed: (Throwable) -> Unit) = PushTransport.start(app, received, failed)
                override fun saveToken(value: String) {
                    check(app.getSharedPreferences("pulse_push", Context.MODE_PRIVATE).edit().putString("token", value).commit()) { "FCM token persistence failed" }
                }
                override fun register(account: PushAccount, deviceToken: String) {
                    val result = ApiClient(account.base).apply { token = account.token }.registerNotificationDevice(deviceToken)
                    check(!BuildConfig.GO_BACKEND || result.optString("status") == "registered") { "FCM registration was not acknowledged" }
                }
                override fun retryable(error: Throwable) = error !is ClientApiException || error.status == 408 || error.status == 429 || error.status >= 500
                override fun fault(error: Throwable) { ClientDiagnostics.get(app).fault("ANDROID_PUSH_REGISTER", error) }
                override fun now() = android.os.SystemClock.elapsedRealtime()
            }).also { registration = it }
        }
    }
    fun bind(context: Context) {
        if (!BuildConfig.FCM_CONFIGURED || account(context, allowDisabled = true) == null) return
        val app = context.applicationContext
        if (!app.getSharedPreferences("pulse_push", Context.MODE_PRIVATE).edit().putBoolean("disabled", false).commit()) {
            ClientDiagnostics.get(app).fault("ANDROID_PUSH_ENABLE"); return
        }
        registration(app).bind()
    }
    fun tokenChanged(context: Context, value: String) {
        if (BuildConfig.FCM_CONFIGURED) registration(context).tokenChanged(value)
    }
    fun unbind(context: Context, client: ApiClient) {
        val prefs = context.getSharedPreferences("pulse_push", Context.MODE_PRIVATE)
        val old = prefs.getString("token", null)
        // Signing out a saved, inactive account must not disable the active account's device.
        if (account(context, allowDisabled = true)?.token == client.token) {
            check(prefs.edit().remove("token").putBoolean("disabled", true).commit()) { "FCM logout state persistence failed" }
            registration?.stop()
            try { PushTransport.disable(context.applicationContext) } catch (error: Exception) { ClientDiagnostics.get(context).fault("ANDROID_PUSH_DISABLE", error) }
            MessageAlerts.clear(context)
        }
        if (old != null || BuildConfig.GO_BACKEND) try { client.unregisterNotificationDevice(old.orEmpty()) }
        catch (error: Exception) { ClientDiagnostics.get(context).fault("ANDROID_PUSH_UNREGISTER", error) }
    }
    fun receive(context: Context, data: Map<String, String>) {
        if (context.getSharedPreferences("pulse_push", Context.MODE_PRIVATE).getBoolean("disabled", false)) return
        val current = account(context) ?: return
        val owner = data["user_id"]?.toIntOrNull() ?: return
        if (owner != current.userId) return
        val conversation = data["conversation_id"]?.toIntOrNull() ?: return
        if (foreground && activeConversation == conversation) return
        val info = JSONObject().put("id", conversation).put("type", data["conversation_type"] ?: "direct").put("name", context.getString(R.string.app_name)).put("notifications_muted", data["notifications_muted"] == "true")
        val message = JSONObject().put("id", data["message_id"]?.toIntOrNull() ?: 0).put("conversation_id", conversation).put("sender_id", data["sender_id"]?.toIntOrNull() ?: 0).put("type", "system").put("body", JSONObject().put("text", "收到一条新消息"))
        MessageAlerts.show(context, owner, info, message, foreground)
    }
}

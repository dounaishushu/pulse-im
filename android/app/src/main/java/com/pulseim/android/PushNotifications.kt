package com.pulseim.android
import android.content.Context
import org.json.JSONObject
import java.util.concurrent.Executors
internal object PushNotifications {
    private val executor = Executors.newSingleThreadExecutor()
    @Volatile var foreground = false
    @Volatile var activeConversation = 0
    fun bind(context: Context) {
        if (AccountSessions(context).token() == null) return
        val app = context.applicationContext
        app.getSharedPreferences("pulse_push", Context.MODE_PRIVATE).edit().putBoolean("disabled", false).commit()
        PushTransport.start(app) { tokenChanged(app, it) }
    }
    fun tokenChanged(context: Context, value: String) {
        context.getSharedPreferences("pulse_push", Context.MODE_PRIVATE).edit().putString("token", value).apply()
        executor.execute {
            if (context.getSharedPreferences("pulse_push", Context.MODE_PRIVATE).getBoolean("disabled", false)) return@execute
            val sessions = AccountSessions(context); val id = sessions.activeId(); val token = sessions.token() ?: return@execute
            val base = context.getSharedPreferences("pulse_im_session", Context.MODE_PRIVATE).getString("api_base_url", null) ?: context.getString(R.string.pulse_api_base_url)
            runCatching { if (sessions.activeId() == id && sessions.token() == token) ApiClient(base).apply { this.token = token }.registerNotificationDevice(value) }
        }
    }
    fun unbind(context: Context, client: ApiClient) {
        val prefs = context.getSharedPreferences("pulse_push", Context.MODE_PRIVATE)
        // Local delivery is disabled even if unregister fails; server logout revokes the session.
        val old = prefs.getString("token", null)
        prefs.edit().remove("token").putBoolean("disabled", true).commit(); PushTransport.disable(context); MessageAlerts.clear(context)
        old?.let { runCatching { client.unregisterNotificationDevice(it) } }
    }
    fun receive(context: Context, data: Map<String, String>) {
        if (context.getSharedPreferences("pulse_push", Context.MODE_PRIVATE).getBoolean("disabled", false)) return
        val sessions = AccountSessions(context); val owner = data["user_id"]?.toIntOrNull() ?: return
        if (owner != sessions.activeId() || sessions.token() == null) return
        val conversation = data["conversation_id"]?.toIntOrNull() ?: return
        if (foreground && activeConversation == conversation) return
        val info = JSONObject().put("id", conversation).put("type", data["conversation_type"] ?: "direct").put("name", context.getString(R.string.app_name)).put("notifications_muted", data["notifications_muted"] == "true")
        val message = JSONObject().put("id", data["message_id"]?.toIntOrNull() ?: 0).put("conversation_id", conversation).put("sender_id", data["sender_id"]?.toIntOrNull() ?: 0).put("type", "system").put("body", JSONObject().put("text", "收到一条新消息"))
        MessageAlerts.show(context, owner, info, message, foreground)
    }
}

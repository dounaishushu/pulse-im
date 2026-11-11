package com.pulseim.android

import android.app.*
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.media.RingtoneManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject

internal object MessageAlerts {
    private val seen = linkedSetOf<String>()
    @Synchronized fun show(activity: Context, userId: Int, info: JSONObject, message: JSONObject, foreground: Boolean) {
        val messageId = message.optInt("id")
        if (messageId > 0) {
            val stored = activity.getSharedPreferences("pulse_message_alerts", Context.MODE_PRIVATE)
            val key = "$userId:$messageId"
            if (seen.isEmpty()) seen.addAll(stored.getStringSet("seen", emptySet()) ?: emptySet())
            if (!seen.add(key)) return
            if (seen.size > 500) seen.remove(seen.first())
            stored.edit().putStringSet("seen", seen.toSet()).apply()
        }
        val type = info.optString("type")
        if (BuildConfig.DEBUG) android.util.Log.d("PulseAlerts", "alert type=$type muted=${info.optBoolean("notifications_muted")} foreground=$foreground allowed=${NotificationManagerCompat.from(activity).areNotificationsEnabled()}")
        if (info.optBoolean("notifications_muted") || message.optInt("sender_id") == userId) return
        val prefs = activity.getSharedPreferences("pulse_notify_$userId", Context.MODE_PRIVATE)
        if (!prefs.getBoolean(if (type in listOf("group", "channel")) type else "direct", true)) return
        val sound = prefs.getBoolean("sound", true); val vibrate = prefs.getBoolean("vibrate", true)
        if (foreground) {
            if (sound) RingtoneManager.getRingtone(activity, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION))?.play()
            if (vibrate) (activity.getSystemService(Context.VIBRATOR_SERVICE) as android.os.Vibrator).vibrate(android.os.VibrationEffect.createOneShot(100, android.os.VibrationEffect.DEFAULT_AMPLITUDE))
            return
        }
        if (!NotificationManagerCompat.from(activity).areNotificationsEnabled()) return
        val manager = activity.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val channelId = "pulse_${if (sound) "sound" else "silent"}_${if (vibrate) "vibrate" else "still"}"
        val channel = NotificationChannel(channelId, "消息通知", NotificationManager.IMPORTANCE_DEFAULT).apply {
            enableVibration(vibrate)
            if (!sound) setSound(null, null)
        }
        manager.createNotificationChannel(channel)
        val intent = Intent(activity, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra("notification_conversation_id", info.optInt("id")).putExtra("notification_user_id", userId)
        val pending = PendingIntent.getActivity(activity, info.optInt("id"), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val preview = if (!AppPasscode.enabled(activity) && prefs.getBoolean("preview", true)) messageSummary(message, userId, activity.getString(R.string.app_name)) else "收到一条新消息"
        val notification = NotificationCompat.Builder(activity, channelId).setSmallIcon(android.R.drawable.ic_dialog_email)
            .setContentTitle(if (AppPasscode.enabled(activity)) activity.getString(R.string.app_name) else info.optString("name", activity.getString(R.string.app_name))).setContentText(preview)
            .setContentIntent(pending).setAutoCancel(true).setColor(Color.rgb(6, 51, 221)).build()
        try { manager.notify(messageId.takeIf { it > 0 } ?: message.optInt("conversation_id"), notification) } catch (e: SecurityException) { if (BuildConfig.DEBUG) android.util.Log.w("PulseAlerts", "notification permission denied", e) }
    }
    fun clear(context: Context) { (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancelAll() }
}

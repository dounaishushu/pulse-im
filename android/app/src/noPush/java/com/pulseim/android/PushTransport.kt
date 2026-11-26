package com.pulseim.android
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
internal object PushTransport {
    fun initialize(context: Context) {}
    fun start(context: Context, received: (String) -> Unit, failed: (Throwable) -> Unit) {}
    fun disable(context: Context) {}
}
class PulseMessagingService : Service() { override fun onBind(intent: Intent?): IBinder? = null }

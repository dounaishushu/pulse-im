package com.pulseim.android
import android.content.Context
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
internal object PushTransport {
    private fun initialize(context: Context) {
        if (FirebaseApp.getApps(context).isEmpty()) FirebaseApp.initializeApp(context, FirebaseOptions.Builder()
            .setApplicationId(BuildConfig.FIREBASE_APP_ID).setApiKey(BuildConfig.FIREBASE_API_KEY)
            .setProjectId(BuildConfig.FIREBASE_PROJECT_ID).setGcmSenderId(BuildConfig.FIREBASE_SENDER_ID).build())
    }
    fun start(context: Context, received: (String) -> Unit) {
        initialize(context); FirebaseMessaging.getInstance().isAutoInitEnabled = true
        FirebaseMessaging.getInstance().token.addOnSuccessListener { received(it) }
    }
    fun disable(context: Context) { initialize(context); FirebaseMessaging.getInstance().isAutoInitEnabled = false; FirebaseMessaging.getInstance().deleteToken() }
}
class PulseMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) { PushNotifications.tokenChanged(applicationContext, token) }
    override fun onMessageReceived(message: RemoteMessage) { PushNotifications.receive(applicationContext, message.data) }
}

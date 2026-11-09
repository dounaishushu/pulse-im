package com.pulseim.android

import android.app.Activity
import android.app.Application
import android.content.ComponentCallbacks2
import android.os.Bundle

class PulseApplication : Application() {
    private var activities = 0
    override fun onCreate() {
        super.onCreate()
        val diagnostics = ClientDiagnostics.get(this)
        diagnostics.start()
        registerActivityLifecycleCallbacks(object : ActivityLifecycleCallbacks {
            override fun onActivityStarted(activity: Activity) { activities++; diagnostics.foreground(true) }
            override fun onActivityStopped(activity: Activity) { activities = (activities - 1).coerceAtLeast(0); diagnostics.foreground(activities > 0) }
            override fun onActivityCreated(activity: Activity, state: Bundle?) = Unit
            override fun onActivityResumed(activity: Activity) = Unit
            override fun onActivityPaused(activity: Activity) = Unit
            override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) = Unit
            override fun onActivityDestroyed(activity: Activity) = Unit
        })
    }
    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) ChatImageCache.trimMemory()
    }
    override fun onLowMemory() {
        super.onLowMemory(); ChatImageCache.trimMemory(); ClientDiagnostics.get(this).fault("ANDROID_MEMORY")
    }
}

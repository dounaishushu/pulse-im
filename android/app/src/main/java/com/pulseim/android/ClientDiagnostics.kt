package com.pulseim.android

import android.content.Context
import android.os.Build
import android.os.Debug
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Persist operation codes, exception classes and stack locations, never raw messages or URLs. */
internal class ClientDiagnostics private constructor(context: Context) {
    companion object {
        @Volatile private var instance: ClientDiagnostics? = null
        fun get(context: Context): ClientDiagnostics = instance ?: synchronized(this) {
            instance ?: ClientDiagnostics(context.applicationContext).also { instance = it }
        }
    }
    private val app = context.applicationContext
    private val directory = File(app.noBackupFilesDir, "client-diagnostics-v2")
    private val preferences = app.getSharedPreferences("pulse_diagnostics_v2", Context.MODE_PRIVATE)
    private val events = ArrayDeque<JSONObject>()
    private val io = Executors.newSingleThreadExecutor { task -> Thread(task, "pulse-diagnostic-upload").apply { isDaemon = true } }
    private val monitor = Executors.newSingleThreadScheduledExecutor { task -> Thread(task, "pulse-main-watchdog").apply { isDaemon = true } }
    private val main = Handler(Looper.getMainLooper())
    private val pendingUpload = AtomicBoolean(false)
    private val pingQueued = AtomicBoolean(false)
    private val lastFault = mutableMapOf<String, Long>()
    private data class Session(val base: String, val token: String, val userId: Int) {
        val baseHash = MessageDigest.getInstance("SHA-256").digest(base.trimEnd('/').toByteArray()).joinToString("") { "%02x".format(it) }
    }
    @Volatile private var session: Session? = null
    @Volatile private var foreground = false
    @Volatile private var acknowledged = SystemClock.uptimeMillis()
    @Volatile private var stalled = false
    @Volatile private var started = false
    private var lastUploadAttempt = 0L

    fun start() {
        if (started) return
        started = true
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            try { persist(incident("ANDROID_JAVA_CRASH", error, thread.stackTrace), session) } catch (_: Throwable) { }
            // Preserve Android crash termination; networking resumes on the next launch.
            if (previous != null) previous.uncaughtException(thread, error)
            else { android.os.Process.killProcess(android.os.Process.myPid()); kotlin.system.exitProcess(10) }
        }
        io.execute { runCatching { directory.mkdirs(); historicalExit(); flush() } }
        monitor.scheduleAtFixedRate({ runCatching { watchdog() } }, 1, 1, TimeUnit.SECONDS)
        monitor.scheduleAtFixedRate({ requestUpload() }, 15, 60, TimeUnit.SECONDS)
    }
    fun foreground(value: Boolean) {
        foreground = value; acknowledged = SystemClock.uptimeMillis(); stalled = false
        if (value) requestUpload()
    }
    @Synchronized fun record(event: String, status: String = "success") {
        if (!Regex("[a-z][a-z0-9._]{0,63}").matches(event) || status !in listOf("success", "failed")) return
        if (events.size >= 60) events.removeFirst()
        events.addLast(JSONObject().put("event", event).put("status", status).put("at", System.currentTimeMillis()))
    }
    fun bind(base: String, token: String?, userId: Int) {
        session = if (token.isNullOrBlank() || userId <= 0) null else Session(base, token, userId)
        requestUpload()
    }
    fun fault(code: String, error: Throwable? = null, durationMs: Long = 0) {
        val now = SystemClock.elapsedRealtime()
        synchronized(lastFault) {
            if (now - (lastFault[code] ?: -120_000L) < 60_000L) return
            lastFault[code] = now
        }
        val value = incident(code, error, error?.stackTrace ?: emptyArray()).put("duration_ms", durationMs.coerceIn(0, 86_400_000))
        val owner = session
        io.execute { runCatching { persist(value, owner); flush() } }
    }
    @Synchronized fun payload(): JSONObject = JSONObject().put("app_name", app.getString(R.string.app_name))
        .put("app_version", BuildConfig.VERSION_NAME).put("platform", "android").put("sdk", Build.VERSION.SDK_INT)
        .put("model", Build.MODEL.take(80)).put("events", JSONArray(events.toList()))
    private fun incident(code: String, error: Throwable?, fallback: Array<StackTraceElement>): JSONObject {
        val frames = JSONArray()
        fun add(stack: Array<StackTraceElement>) {
            for (frame in stack.take(16)) {
                if (frames.length() >= 20) break
                val raw = "${frame.className}.${frame.methodName}(${frame.fileName ?: "Unknown"}:${frame.lineNumber})"
                frames.put(raw.replace(Regex("[^A-Za-z0-9_.$<>():-]"), "_").take(220))
            }
        }
        if (error == null) add(fallback) else {
            var current: Throwable? = error
            repeat(3) { current?.let { cause -> add(cause.stackTrace); current = cause.cause?.takeUnless { it === cause } } }
        }
        val runtime = Runtime.getRuntime()
        return JSONObject().put("code", code).put("at", System.currentTimeMillis())
            .put("exception_class", error?.javaClass?.name?.take(160) ?: "").put("frames", frames).put("foreground", foreground)
            .put("heap_used_kb", (runtime.totalMemory() - runtime.freeMemory()) / 1024).put("heap_limit_kb", runtime.maxMemory() / 1024)
    }
    private fun persist(value: JSONObject, owner: Session?) {
        directory.mkdirs()
        val id = UUID.randomUUID().toString()
        val envelope = JSONObject().put("owner_user_id", owner?.userId ?: 0).put("owner_base_hash", owner?.baseHash ?: "")
            .put("payload", payload().put("schema_version", 2).put("diagnostic_id", id).put("upload_mode", "automatic").put("incidents", JSONArray().put(value)))
        val bytes = envelope.toString().toByteArray(Charsets.UTF_8)
        if (bytes.size > 28_000) return
        val atomic = AtomicFile(File(directory, "$id.json")); val stream = atomic.startWrite()
        try { stream.write(bytes); atomic.finishWrite(stream) } catch (error: Throwable) { atomic.failWrite(stream); throw error }
        pendingFiles().dropLast(12).forEach { it.delete() }
    }
    private fun pendingFiles(): List<File> = directory.listFiles()?.filter { it.isFile && it.extension == "json" }?.sortedBy { it.lastModified() } ?: emptyList()
    private fun requestUpload() {
        if (!pendingUpload.compareAndSet(false, true)) return
        io.execute { try { runCatching { flush() } } finally { pendingUpload.set(false) } }
    }
    private fun flush() {
        val owner = session ?: return
        val now = System.currentTimeMillis()
        if (now - lastUploadAttempt < 60_000L) return
        for (file in pendingFiles()) {
            if (file.length() !in 1..28_000) { file.delete(); continue }
            val envelope = runCatching { JSONObject(file.readText()) }.getOrNull() ?: continue
            val userId = envelope.optInt("owner_user_id")
            if (userId != 0 && (userId != owner.userId || envelope.optString("owner_base_hash") != owner.baseHash)) continue
            if (session !== owner) return
            lastUploadAttempt = now
            try {
                val data = envelope.getJSONObject("payload")
                val result = ApiClient(owner.base).apply { token = owner.token }.uploadDiagnostics(data)
                // Older servers cannot retain exception details, so keep the local report.
                if (result.optInt("schema_version") == 2 && result.optString("diagnostic_id") == data.getString("diagnostic_id")) {
                    preferences.edit().putString("last_report_id", result.optString("report_id")).apply(); file.delete()
                }
            } catch (_: Exception) { /* Keep the same UUID for idempotent retry after reconnect/restart. */ }
            return
        }
    }
    private fun watchdog() {
        if (!foreground || Debug.isDebuggerConnected()) { acknowledged = SystemClock.uptimeMillis(); return }
        val delay = SystemClock.uptimeMillis() - acknowledged
        if (delay >= 6000 && !stalled) {
            stalled = true
            val value = incident("ANDROID_MAIN_STALL", null, Looper.getMainLooper().thread.stackTrace).put("duration_ms", delay)
            val owner = session
            runCatching { persist(value, owner) }
            requestUpload()
        }
        if (pingQueued.compareAndSet(false, true)) main.post { acknowledged = SystemClock.uptimeMillis(); stalled = false; pingQueued.set(false) }
    }
    private fun historicalExit() {
        if (Build.VERSION.SDK_INT < 30) return
        val manager = app.getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager
        val previous = preferences.getLong("exit_checked_at", System.currentTimeMillis())
        val exits = manager.getHistoricalProcessExitReasons(app.packageName, 0, 5)
        val newest = exits.maxOfOrNull { it.timestamp } ?: previous
        for (exit in exits.filter { it.timestamp > previous }.take(3)) {
            if (exit.reason in listOf(android.app.ApplicationExitInfo.REASON_ANR, android.app.ApplicationExitInfo.REASON_CRASH,
                    android.app.ApplicationExitInfo.REASON_CRASH_NATIVE, android.app.ApplicationExitInfo.REASON_LOW_MEMORY)) {
                persist(incident("ANDROID_PROCESS_EXIT", null, emptyArray()).put("at", exit.timestamp).put("exit_reason", exit.reason), session)
            }
        }
        preferences.edit().putLong("exit_checked_at", maxOf(previous, newest)).apply()
    }
}

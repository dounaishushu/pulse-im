package com.pulseim.android

import android.app.Activity
import android.app.Instrumentation
import android.os.Bundle

internal object LoginClientVersionChecks {
    fun run(instrumentation: Instrumentation, args: Bundle) {
        val result = Bundle()
        try {
            val base = requireNotNull(args.getString("base"))
            require(base.startsWith("http://10.0.2.2:") || base.startsWith("http://127.0.0.1:"))
            GoV2Ids.context = instrumentation.targetContext.applicationContext
            MobileDeviceIdentity.initialize(instrumentation.targetContext)
            val api = ApiClient(base)
            api.token = api.login(requireNotNull(args.getString("account")), requireNotNull(args.getString("password")))
            check(api.me().getInt("id") > 0)
            if (args.getString("diagnostics") == "true") {
                val id = java.util.UUID.randomUUID().toString()
                val payload = org.json.JSONObject().put("schema_version", 2).put("diagnostic_id", id)
                    .put("incidents", org.json.JSONArray().put(org.json.JSONObject().put("code", "ANDROID_ACK_CHECK").put("at", System.currentTimeMillis())))
                repeat(3) {
                    val ack = api.uploadDiagnostics(payload)
                    check(ack.getInt("schema_version") == 2 && ack.getString("diagnostic_id") == id && ack.getString("report_id") == id)
                }
                result.putString("diagnostic_id", id)
                result.putString("diagnostic_ack", "passed")
            }
            api.logout()
            result.putString("result", "passed")
            result.putString("client_version", BuildConfig.VERSION_NAME)
            instrumentation.finish(Activity.RESULT_OK, result)
        } catch (error: Exception) {
            result.putString("error", error.javaClass.simpleName + ": " + error.message)
            instrumentation.finish(Activity.RESULT_CANCELED, result)
        }
    }
}

package com.pulseim.android

import android.app.Activity
import android.app.Instrumentation
import android.os.Bundle
import org.json.JSONObject

/** Real ApiClient/Go adapter over loopback HTTP; no production credentials. */
internal object TaskVerificationChecks {
    fun run(probe: Instrumentation, args: Bundle) {
        val result = Bundle(); val report = JSONObject()
        try {
            val base = requireNotNull(args.getString("base"))
            require(Regex("http://(?:127\\.0\\.0\\.1|10\\.0\\.2\\.2):[0-9]+/api/v2").matches(base))
            GoV2Ids.context = probe.targetContext.applicationContext
            val client = ApiClient(base).apply { token = "isolated-task-verification" }
            val task = GoV2Ids.local(base, "task", "33333333-3333-4333-8333-333333333333")
            fun failure(code: String): ClientApiException {
                try { client.startWorkTask(task, code); error("Expected task rejection") }
                catch (error: ClientApiException) { return error }
            }
            val invalid = failure("000000")
            report.put("observedInvalidCodeMessage", invalid.message)
            report.put("invalidCodeHasSpecificFeedback", invalid.status == 403 && invalid.errorCode == "task_code_invalid" &&
                invalid.message!!.contains("验证码") && !invalid.message!!.contains("登录"))
            report.put("invalidCodeKeepsSession", !invalid.authenticationRejected && client.token == "isolated-task-verification" && client.me().getInt("id") > 0)
            val closed = failure("000001")
            report.put("openingTimeHasSpecificFeedback", closed.status == 409 && closed.errorCode == "task_not_open" && closed.message!!.contains("尚未开放"))
            val forbidden = failure("000002")
            report.put("realPermissionDenialPreserved", forbidden.status == 403 && forbidden.errorCode == "forbidden" && !forbidden.authenticationRejected)
            val expired = failure("000003")
            report.put("realExpiredLoginPreserved", expired.status == 401 && expired.authenticationRejected && expired.message!!.contains("重新登录"))
            val unknown = failure("000004")
            report.put("unknown403DoesNotClaimExpiredLogin", unknown.status == 403 && !unknown.authenticationRejected && !unknown.message!!.contains("登录"))
            val limited = failure("000005")
            report.put("rateLimitIsNotBypassed", limited.status == 429 && limited.errorCode == "rate_limited" && limited.message!!.contains("频繁"))
            val accepted = client.startWorkTask(task, "123456").getJSONObject("record")
            report.put("correctCodeStartsInternTask", accepted.getInt("task_id") == task && accepted.getString("employee_type") == "intern" && accepted.getString("status") == "in_progress")
            if (args.getString("baseline") != "true") {
                for (key in report.keys()) if (key != "observedInvalidCodeMessage") check(report.getBoolean(key)) { key }
            }
            result.putString("result", "passed")
        } catch (error: Throwable) {
            result.putString("result", "failed"); result.putString("error", error.stackTraceToString())
        }
        result.putString("report", report.toString())
        probe.finish(if (result.getString("result") == "passed") Activity.RESULT_OK else Activity.RESULT_CANCELED, result)
    }
}

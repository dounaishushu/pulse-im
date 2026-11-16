package com.pulseim.android

import android.app.Activity
import android.app.Instrumentation
import android.os.Bundle
import org.json.JSONObject
import java.util.UUID

internal object APILogicChecks {
    fun run(probe: Instrumentation, baseline: Boolean) {
        val result = Bundle()
        val report = JSONObject()
        try {
            GoV2Ids.context = probe.targetContext.applicationContext
            val base = "http://127.0.0.1:18461/api/v2"
            val conversation = UUID.randomUUID().toString()
            val message = UUID.randomUUID().toString()
            val cid = GoV2Ids.local(base, "conversation", conversation)
            GoV2Ids.message(base, cid, JSONObject().put("seq", "5").put("id", message).put("version", "1"))
            val paths = mutableListOf<String>()
            val clears = mutableListOf<Int>()
            val adapter = GoV2Api(base, { "probe-token" }, { 1L }) { path, _, body, _ ->
                paths.add(path)
                when {
                    path.endsWith("/clear") -> {
                        val boundary = requireNotNull(body).getString("through_seq").toInt()
                        clears.add(boundary)
                        JSONObject().put("clear_seq", boundary.toString())
                    }
                    path.endsWith("/unread") -> JSONObject().put("count", 0)
                    path.endsWith("/receipt") -> JSONObject().put("status", requireNotNull(body).getString("status"))
                    else -> JSONObject().put("message_seq", "9")
                }
            }
            repeat(2) { adapter.request("/messages/clear-history", "POST", JSONObject().put("conversation_id", cid).put("through_message_id", 3)) }
            report.put("clearUsesChosenBoundary", clears == listOf(3, 3))
            val request = JSONObject().put("conversation_id", cid).put("through_message_id", 3).put("status", "delivered")
            paths.clear(); adapter.request("/messages/receipt", "POST", request)
            report.put("deliveredDoesNotMarkRead", paths.any { it.endsWith("/delivered") } && paths.none { it.endsWith("/read") })
            paths.clear()
            val rejected = runCatching { adapter.request("/messages/receipt", "POST", JSONObject(request.toString()).put("status", "invalid")) }.isFailure
            report.put("invalidReceiptRejectedWithoutMutation", rejected && paths.isEmpty())
            paths.clear()
            val single = runCatching { adapter.request("/messages/receipt", "POST", JSONObject().put("conversation_id", cid).put("message_id", 5).put("status", "read")) }.isSuccess
            report.put("singleReceiptStaysSparse", single && paths.any { it.endsWith("/messages/$message/receipt") } && paths.none { it.endsWith("/read") })
            paths.clear()
            val absent = runCatching { adapter.request("/messages/clear-history", "POST", JSONObject().put("conversation_id", cid)) }.isFailure
            report.put("missingClearBoundaryRejected", absent && paths.isEmpty())
            val media = UUID.randomUUID().toString()
            val batchFault = GoV2Api(base, { "probe-token" }, { 1L }) { path, _, _, _ ->
                if(path.startsWith("/client/friend-page"))JSONObject().put("items",org.json.JSONArray().put(JSONObject().put("id",message).put("avatar_id",media)))
                else if(path=="/media/grants")JSONObject().put("items",org.json.JSONArray().put(JSONObject().put("id",media).put("error",JSONObject().put("status",503).put("code","temporarily_unavailable"))))
                else JSONObject().put("content_path","/api/v2/media-grants/"+"a".repeat(64)+"/content").put("expires_in",120)
            }
            val propagated=try{batchFault.request("/contacts","GET",null);false}catch(e:ClientApiException){e.status==503}
            report.put("batchServiceFaultPreserved",propagated)
            if (!baseline) for (key in report.keys()) check(report.getBoolean(key)) { key }
            result.putString("result", "passed")
        } catch (error: Throwable) {
            result.putString("result", "failed"); report.put("error", error.toString())
        }
        result.putString("report", report.toString())
        probe.finish(if (result.getString("result") == "passed") Activity.RESULT_OK else Activity.RESULT_CANCELED, result)
    }
}

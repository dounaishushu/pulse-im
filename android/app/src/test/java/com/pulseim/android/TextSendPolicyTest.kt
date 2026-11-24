package com.pulseim.android

import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

class TextSendPolicyTest {
    @Test fun permissionGateAndNormalSend() {
        assertEquals(TextSendDecision.SEND, TextSendPolicy.decide(null, true))
        assertEquals(TextSendDecision.DEFER, TextSendPolicy.decide(null, false))
    }
    @Test fun localPermissionAndAccountChangesKeepOriginalError() {
        for (message in listOf("已禁止发言", "账号已切换，请返回原账号重试")) {
            val error = TextSendPolicy.NotReady(message)
            assertEquals(TextSendDecision.DEFER, TextSendPolicy.decide(error, false))
            assertEquals(message, error.message)
        }
        assertEquals(TextSendDecision.DEFER, TextSendPolicy.decide(ClientApiException(409, "stale_session", "账号已改变，本次操作已取消"), true))
    }
    @Test fun realHttpFailuresRemainPermanentRegardlessOfPermission() {
        for (status in listOf(400, 401, 403, 404, 409)) for (allowed in listOf(true, false))
            assertEquals(TextSendDecision.FAIL, TextSendPolicy.decide(ClientApiException(status, "invalid_request", "original"), allowed))
        assertEquals(TextSendDecision.FAIL, TextSendPolicy.decide(IllegalStateException("消息回执无效，请重试"), false))
    }
    @Test fun transportAndExistingTemporaryFailuresDefer() {
        assertEquals(TextSendDecision.DEFER, TextSendPolicy.decide(IOException("network"), true))
        for (status in listOf(408, 425, 429, 500, 502, 503, 504))
            assertEquals(TextSendDecision.DEFER, TextSendPolicy.decide(ClientApiException(status, "temporary", "original"), true))
        assertEquals(TextSendDecision.DEFER, TextSendPolicy.decide(ClientApiException(409, "membership_changed", "changed"), true))
    }
}

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
    @Test fun aRestrictedChatDoesNotRestrictOtherChatsOrTheHomePage() {
        assertFalse(TextSendPolicy.canSend(1, 1, false))
        assertTrue(TextSendPolicy.canSend(2, 1, false))
        assertTrue(TextSendPolicy.canSend(1, 0, false))
        assertTrue(TextSendPolicy.canSend(1, 1, true))
    }
    @Test fun permissionChangeAfterClaimOnlyDefersTheAffectedMessage() {
        val q = TextSendQueue()
        val a = q.enqueue("token", 1, "endpoint", 1, "a", 0)
        val b = q.enqueue("token", 1, "endpoint", 2, "b", 0)
        val c = q.enqueue("token", 1, "endpoint", 3, "c", 0)
        val claimed = q.claim("token", 1, "endpoint", 2, 0)
        val (ready, waiting) = claimed.partition { TextSendPolicy.canSend(it.conversationId, 1, false) }
        assertEquals(listOf(b), ready); assertEquals(listOf(a), waiting)
        waiting.forEach { assertTrue(q.defer(it, "已禁止发言", it.attempt, 0)) }
        assertEquals(TextSendQueue.Phase.QUEUED, a.phase); assertEquals("已禁止发言", a.error)
        assertEquals(TextSendQueue.Phase.SENDING, b.phase)
        assertEquals(listOf(c), q.claim("token", 1, "endpoint", 1, 1))
        assertEquals(TextSendDecision.DEFER, TextSendPolicy.decide(TextSendPolicy.NotReady(a.error), false))
    }
    @Test fun switchingChatsRechecksEachClaimBeforeDispatch() {
        val q = TextSendQueue()
        val a = q.enqueue("token", 1, "endpoint", 1, "a", 0)
        val b = q.enqueue("token", 1, "endpoint", 2, "b", 0)
        val c = q.enqueue("token", 1, "endpoint", 3, "c", 0)
        val claimed = q.claim("token", 1, "endpoint", 2, 1)
        assertEquals(listOf(b, c), claimed)
        val (ready, waiting) = claimed.partition { TextSendPolicy.canSend(it.conversationId, 2, false) }
        assertEquals(listOf(c), ready); assertEquals(listOf(b), waiting)
        waiting.forEach { assertTrue(q.defer(it, "已禁止发言", it.attempt, 0)) }
        assertEquals(listOf(a), q.claim("token", 1, "endpoint", 1, 2))
        assertEquals(TextSendQueue.Phase.QUEUED, b.phase)
    }
    @Test fun permissionRecoveryDuringAnEmptyClaimKeepsWorkClaimable() {
        val q = TextSendQueue()
        val a = q.enqueue("token", 1, "endpoint", 1, "a", 0)
        assertTrue(q.claim("token", 1, "endpoint", 2, 1).isEmpty())
        assertEquals(0L, a.attempt); assertEquals(TextSendQueue.Phase.QUEUED, a.phase)
        assertTrue(TextSendPolicy.canSend(1, 1, true))
        assertEquals(listOf(a), q.claim("token", 1, "endpoint", 2, 0))
    }
}

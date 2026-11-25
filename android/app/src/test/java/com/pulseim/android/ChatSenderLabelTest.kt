package com.pulseim.android

import org.junit.Assert.*
import org.junit.Test

class ChatSenderLabelTest {
    private fun label(name: Any?, nickname: Any? = null, id: Int = 7, remark: String = "") =
        ChatSenderLabel.resolve(id, name, nickname) { _, fallback -> remark.ifBlank { fallback } }

    @Test fun changedAuthorNameInvalidatesTheReusedLabel() {
        val previous = label("旧昵称"); val next = label("新昵称")
        assertFalse(next.matches(previous.userId, previous.fallback, previous.text))
        assertEquals("新昵称", next.text)
    }
    @Test fun aPrivateRemarkStillWinsWhenTheAuthorNameChanges() {
        val previous = label("旧昵称", remark = "我的备注")
        val next = label("新昵称", remark = "我的备注")
        assertEquals("我的备注", next.text)
        assertEquals("新昵称", next.fallback)
        assertFalse(next.matches(previous.userId, previous.fallback, previous.text))
    }
    @Test fun removingARemarkReturnsToTheLatestAuthorName() {
        val withRemark = label("最新昵称", remark = "我的备注")
        val withoutRemark = label(withRemark.fallback)
        assertEquals("最新昵称", withoutRemark.text)
        assertFalse(withoutRemark.matches(withRemark.userId, withRemark.fallback, withRemark.text))
    }
    @Test fun changingTheRemarkInvalidatesAnOtherwiseIdenticalLabel() {
        val previous = label("昵称", remark = "旧备注")
        assertFalse(label("昵称", remark = "新备注").matches(previous.userId, previous.fallback, previous.text))
    }
    @Test fun independentViewersResolveTheirOwnPrivateRemarks() {
        val first = label("真实昵称", remark = "账号一的备注")
        val second = label("真实昵称", remark = "账号二的备注")
        assertEquals(first.fallback, second.fallback)
        assertEquals("账号一的备注", first.text); assertEquals("账号二的备注", second.text)
    }
    @Test fun sameDisplayTextForAnotherAuthorMustRebindIdentity() {
        val previous = label("同名", id = 7)
        assertFalse(label("同名", id = 8).matches(previous.userId, previous.fallback, previous.text))
    }
    @Test fun identicalVisibleAndFallbackValuesAvoidAnotherLabelWrite() {
        val value = label("昵称", remark = "备注")
        assertTrue(label("昵称", remark = "备注").matches(value.userId, value.fallback, StringBuilder(value.text)))
    }
    @Test fun namePrecedesNicknameAndPreservesUnicode() {
        val value = label("  昵称😀  ", "备用昵称")
        assertEquals("昵称😀", value.fallback); assertEquals("昵称😀", value.text)
    }
    @Test fun invalidPrimaryNamesUseTheNickname() {
        for (name in listOf(null, "", "  ", "null", " null ", 123))
            assertEquals("备用昵称", label(name, " 备用昵称 ").fallback)
    }
    @Test fun missingNamesUseTheExistingGroupMemberFallback() {
        for (nickname in listOf(null, "", " ", "null", 123))
            assertEquals("群成员", label(null, nickname).fallback)
    }
}

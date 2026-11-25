package com.pulseim.android

import org.junit.Assert.*
import org.junit.Test

class ChatTextBindingTest {
    private class Port(initial: CharSequence?) {
        var value = initial
        val writes = mutableListOf<String>()
        fun write(next: String) { writes.add(next); value = next }
    }
    // The resolver is outside the binder, just as contact/@ rendering is in the app.
    private fun render(port: Port, raw: String, resolved: String?, labels: () -> Unit = {}) {
        ChatTextBinding.bind(port.value, raw, resolved != null, port::write) {
            labels()
            if (resolved != null) ChatTextBinding.value(port.value, resolved, port::write)
        }
    }
    @Test fun metadataMentionDoesNotWriteTheSendersPrivateLabel() {
        val port = Port("@自己 你好"); var names = 0
        render(port, "@发送者备注 你好", "@自己 你好") { names++ }
        assertEquals(emptyList<String>(), port.writes); assertEquals(1, names)
    }
    @Test fun editedMentionOnlyWritesTheViewerDisplay() {
        val port = Port("@自己 你好")
        render(port, "@发送者备注 已更新", "@自己 已更新")
        assertEquals(listOf("@自己 已更新"), port.writes)
    }
    @Test fun plainReadReceiptDoesNotRewriteContent() {
        val port = Port("普通文字")
        render(port, "普通文字", "普通文字")
        assertTrue(port.writes.isEmpty())
    }
    @Test fun currentViewerRemarksRemainIndependent() {
        val first = Port(""); val second = Port("")
        render(first, "@真实昵称", "@账号一备注")
        render(second, "@真实昵称", "@账号二备注")
        assertEquals(listOf("@账号一备注"), first.writes)
        assertEquals(listOf("@账号二备注"), second.writes)
    }
    @Test fun recalledNoticeUsesFallbackAndStillClearsBindings() {
        val port = Port("原消息"); var clears = 0
        render(port, "消息已撤回", null) { clears++ }
        assertEquals(listOf("消息已撤回"), port.writes); assertEquals(1, clears)
    }
    @Test fun identicalUnavailableNoticeSkipsWriteButStillClearsBindings() {
        val port = Port("消息已撤回"); var clears = 0
        render(port, "消息已撤回", null) { clears++ }
        assertTrue(port.writes.isEmpty()); assertEquals(1, clears)
    }
    @Test fun emptyBodyClearsPreviousText() {
        val port = Port("原消息")
        render(port, "", null)
        assertEquals(listOf(""), port.writes)
    }
    @Test fun missingInitialValueGetsBound() {
        val port = Port(null)
        ChatTextBinding.value(port.value, "", port::write)
        assertEquals(listOf(""), port.writes)
    }
    @Test fun identicalTimeIsNotAssignedAgain() {
        val port = Port("12:34")
        repeat(3) { ChatTextBinding.value(port.value, "12:34", port::write) }
        assertTrue(port.writes.isEmpty())
    }
    @Test fun changedTimeIsAssignedOnce() {
        val port = Port("12:34")
        ChatTextBinding.value(port.value, "12:35", port::write)
        ChatTextBinding.value(port.value, "12:35", port::write)
        assertEquals(listOf("12:35"), port.writes)
    }
    @Test fun equalCharSequencePreservesTheExistingObject() {
        val original = StringBuilder("12:34"); val port = Port(original)
        ChatTextBinding.value(port.value, "12:34", port::write)
        assertSame(original, port.value); assertTrue(port.writes.isEmpty())
    }
    @Test(expected = IllegalStateException::class) fun resolverFailurePropagates() {
        render(Port("原消息"), "原消息", "显示值") { throw IllegalStateException("resolver failed") }
    }
}

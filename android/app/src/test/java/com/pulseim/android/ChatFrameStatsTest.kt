package com.pulseim.android

import org.junit.Assert.*
import org.junit.Test

class ChatFrameStatsTest {
    private fun dump(frames: Int = 602, janky: Int = 1, p99: Int = 15) = """
        Total frames rendered: $frames
        Janky frames: $janky (0.17%)
        Janky frames (legacy): 527 (87.54%)
        99th percentile: ${p99}ms
        99th gpu percentile: 6ms
    """.trimIndent()

    @Test fun acceptsTheMeasuredFifteenMillisecondSample() {
        val stats = ChatFrameStats.parse(dump())
        assertEquals(602, stats.frames); assertEquals(1, stats.jankyFrames)
        assertEquals(15, stats.p99Ms); assertTrue(stats.passed)
        assertEquals(100.0 / 602, stats.jankPercent, 0.000001)
    }
    @Test fun sixteenMillisecondsIsNotBelowTheRequiredThreshold() {
        assertFalse(ChatFrameStats.parse(dump(p99 = 16)).passed)
    }
    @Test fun rejectsThePreviousTwentyTwoMillisecondResult() {
        assertFalse(ChatFrameStats.parse(dump(janky = 2, p99 = 22)).passed)
    }
    @Test fun onePercentJankDoesNotPassEvenWhenPrintedPercentageIsLower() {
        assertFalse(ChatFrameStats.parse(dump(frames = 100, janky = 1)).passed)
        assertFalse(ChatFrameStats.parse(dump(frames = 100, janky = 2)).passed)
    }
    @Test fun ignoresLegacyJankAndGpuPercentiles() {
        val value = dump().replace("99th gpu percentile: 6ms", "99th gpu percentile: 90ms")
        assertTrue(ChatFrameStats.parse(value).passed)
    }
    @Test fun handlesWindowsLineEndings() {
        assertEquals(15, ChatFrameStats.parse(dump().replace("\n", "\r\n")).p99Ms)
    }
    @Test fun ignoresRepeatedPerWindowCountersFromRealFramestatsOutput() {
        assertTrue(ChatFrameStats.parse(dump() + "\nProfile data in ms:\nWindow: MainActivity\n" + dump()).passed)
    }
    @Test fun fasterWindowCountersCannotHideSlowAppFrames() {
        val value = dump(p99 = 22) + "\nProfile data in ms:\nWindow: MainActivity\n" + dump(p99 = 5)
        assertFalse(ChatFrameStats.parse(value).passed)
    }
    @Test(expected = IllegalArgumentException::class) fun rejectsWindowCountersWithoutTheAppSummary() {
        ChatFrameStats.parse("Profile data in ms:\nWindow: MainActivity\n" + dump())
    }
    @Test(expected = IllegalArgumentException::class) fun rejectsMultipleProcessSummaries() {
        ChatFrameStats.parse("** Graphics info for pid 1 [app] **\n" + dump() + "\nProfile data in ms:\n** Graphics info for pid 2 [other] **\n" + dump(p99 = 5))
    }
    @Test(expected = IllegalArgumentException::class) fun rejectsAnEmptySample() {
        ChatFrameStats.parse(dump(frames = 0, janky = 0))
    }
    @Test(expected = IllegalArgumentException::class) fun rejectsTruncatedOutput() {
        ChatFrameStats.parse("Total frames rendered: 602\n99th percentile: 5ms")
    }
    @Test(expected = IllegalArgumentException::class) fun rejectsImpossibleJankCounts() {
        ChatFrameStats.parse(dump(frames = 1, janky = 2))
    }
    @Test(expected = IllegalArgumentException::class) fun rejectsOverflowInsteadOfWrappingCounters() {
        ChatFrameStats.parse(dump().replace("rendered: 602", "rendered: 999999999999999"))
    }
    @Test(expected = IllegalArgumentException::class) fun rejectsCombinedRunsInsteadOfPickingTheBestOne() {
        ChatFrameStats.parse(dump() + "\n" + dump(p99 = 22))
    }
}

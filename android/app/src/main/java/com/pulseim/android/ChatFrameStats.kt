package com.pulseim.android

/** Pure-JVM interpretation of gfxinfo's app summary, not its GPU/legacy counters. */
internal data class ChatFrameStats(
    val frames: Int, val jankyFrames: Int, val p99Ms: Int
) {
    val jankPercent: Double get() = jankyFrames * 100.0 / frames
    val passed: Boolean get() = p99Ms < 16 && jankPercent < 1.0

    companion object {
        fun parse(dump: String): ChatFrameStats {
            require(Regex("^\\*\\* Graphics info for pid ", RegexOption.MULTILINE).findAll(dump).count() <= 1) {
                "Ambiguous gfxinfo process summaries"
            }
            // framestats repeats these counters for each window after the app summary.
            val summary = dump.substringBefore("Profile data in ms:")
            fun metric(pattern: String): Int {
                val matches = Regex(pattern, RegexOption.MULTILINE).findAll(summary).toList()
                require(matches.size == 1) { "Missing or ambiguous gfxinfo metric: $pattern" }
                return requireNotNull(matches.single().groupValues[1].toIntOrNull()) { "Invalid gfxinfo counter" }
            }
            val frames = metric("^[ \\t]*Total frames rendered:[ \\t]*(\\d+)[ \\t]*\\r?$")
            val janky = metric("^[ \\t]*Janky frames:[ \\t]*(\\d+)[ \\t]+\\([^\\r\\n]*\\)[ \\t]*\\r?$")
            val p99 = metric("^[ \\t]*99th percentile:[ \\t]*(\\d+)ms[ \\t]*\\r?$")
            require(frames > 0 && janky <= frames) { "No valid rendered-frame sample" }
            return ChatFrameStats(frames, janky, p99)
        }
    }
}

package com.pulseim.android

import kotlin.math.abs

/** A deliberate single-finger right swipe can begin anywhere in the page. */
internal class PageBackGesture(
    private val touchSlop: Float,
    private val minimumTravel: Float
) {
    private var candidate = false
    private var claimed = false
    private var startX = 0f
    private var startY = 0f
    private var width = 0f

    fun begin(x: Float, y: Float, viewWidth: Float): Boolean {
        reset()
        candidate = viewWidth > 0 && x >= 0 && x < viewWidth
        startX = x; startY = y; width = viewWidth
        return candidate
    }

    fun move(x: Float, y: Float, pointerCount: Int): Boolean {
        if (pointerCount != 1) { reset(); return false }
        if (!candidate) return false
        val dx = x - startX; val dy = abs(y - startY)
        if (!claimed) {
            if (dx < -touchSlop || (dy > touchSlop && dy >= dx)) { reset(); return false }
            claimed = dx > touchSlop && dx > dy * 1.5f
        }
        return claimed
    }

    fun finish(x: Float, y: Float): Boolean {
        val dx = x - startX
        val accepted = candidate && claimed && dx >= maxOf(minimumTravel, width * 0.18f) && dx > abs(y - startY) * 1.5f
        reset()
        return accepted
    }

    fun reset() { candidate = false; claimed = false }
}

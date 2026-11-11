package com.pulseim.android

import android.content.Context
import android.view.View
import android.view.ViewGroup

/** Reserve timestamp/edit-label space before wrapping the text, including under a quoted reply. */
internal class GroupMessageTextLine(context: Context, private val maximumWidth: Int) : ViewGroup(context) {
    override fun generateDefaultLayoutParams() = MarginLayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT)
    override fun generateLayoutParams(params: LayoutParams) = MarginLayoutParams(params)
    override fun checkLayoutParams(params: LayoutParams) = params is MarginLayoutParams

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val available = if (MeasureSpec.getMode(widthMeasureSpec) == MeasureSpec.UNSPECIFIED) maximumWidth
            else minOf(maximumWidth, (MeasureSpec.getSize(widthMeasureSpec) - paddingLeft - paddingRight).coerceAtLeast(0))
        var metadataWidth = 0
        var tallest = 0
        for (index in 1 until childCount) {
            val child = getChildAt(index)
            if (child.visibility == View.GONE) continue
            val margin = child.layoutParams as MarginLayoutParams
            child.measure(MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
            metadataWidth += child.measuredWidth + margin.leftMargin + margin.rightMargin
            tallest = maxOf(tallest, child.measuredHeight + margin.topMargin + margin.bottomMargin)
        }
        var textWidth = 0
        if (childCount > 0) {
            val text = getChildAt(0)
            val margin = text.layoutParams as MarginLayoutParams
            text.measure(MeasureSpec.makeMeasureSpec((available - metadataWidth - margin.leftMargin - margin.rightMargin).coerceAtLeast(0), MeasureSpec.AT_MOST), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
            textWidth = text.measuredWidth + margin.leftMargin + margin.rightMargin
            tallest = maxOf(tallest, text.measuredHeight + margin.topMargin + margin.bottomMargin)
        }
        setMeasuredDimension(resolveSize(textWidth + metadataWidth + paddingLeft + paddingRight, widthMeasureSpec), resolveSize(tallest + paddingTop + paddingBottom, heightMeasureSpec))
    }

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        var x = paddingLeft
        for (index in 0 until childCount) {
            val child = getChildAt(index)
            if (child.visibility == View.GONE) continue
            val margin = child.layoutParams as MarginLayoutParams
            x += margin.leftMargin
            val y = height - paddingBottom - margin.bottomMargin - child.measuredHeight
            child.layout(x, y, x + child.measuredWidth, y + child.measuredHeight)
            x += child.measuredWidth + margin.rightMargin
        }
    }
}

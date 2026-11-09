package com.pulseim.android

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Matrix
import android.graphics.RectF
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.widget.ImageView

/** Fits the complete question, then lets every edge remain reachable while zooming. */
internal class QuestionZoomImageView(context: Context) : ImageView(context) {
    private val transform = Matrix()
    private var minimumScale = 1f
    private var scaling = false
    internal val ownsImageDrag get() = scaling || currentScale() > minimumScale * 1.05f
    private val scale = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScaleBegin(detector: ScaleGestureDetector): Boolean { scaling = true; return true }
        override fun onScale(detector: ScaleGestureDetector): Boolean {
            zoom(detector.scaleFactor, detector.focusX, detector.focusY); return true
        }
        override fun onScaleEnd(detector: ScaleGestureDetector) { scaling = false }
    })
    private val gestures = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
        override fun onDown(event: MotionEvent) = true
        override fun onSingleTapConfirmed(event: MotionEvent): Boolean { performClick(); return true }
        override fun onDoubleTap(event: MotionEvent): Boolean {
            if (currentScale() > minimumScale * 1.05f) fit() else zoom(3f, event.x, event.y)
            return true
        }
        override fun onScroll(first: MotionEvent?, current: MotionEvent, dx: Float, dy: Float): Boolean {
            if (!scaling && current.pointerCount == 1) { transform.postTranslate(-dx, -dy); constrain() }
            return true
        }
    })
    init { scaleType = ScaleType.MATRIX; isClickable = true; contentDescription = "题目图片，可双指缩放和拖动，双击还原" }
    override fun setImageBitmap(bitmap: Bitmap?) { super.setImageBitmap(bitmap); fit() }
    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) { super.onSizeChanged(w, h, oldw, oldh); fit() }
    private fun currentScale(): Float = FloatArray(9).also { transform.getValues(it) }[Matrix.MSCALE_X]
    private fun fit() {
        val picture = drawable ?: return
        if (width <= 0 || height <= 0 || picture.intrinsicWidth <= 0 || picture.intrinsicHeight <= 0) return
        minimumScale = minOf(width.toFloat() / picture.intrinsicWidth, height.toFloat() / picture.intrinsicHeight)
        transform.setScale(minimumScale, minimumScale)
        transform.postTranslate((width - picture.intrinsicWidth * minimumScale) / 2f, (height - picture.intrinsicHeight * minimumScale) / 2f)
        imageMatrix = transform
    }
    private fun zoom(factor: Float, x: Float, y: Float) {
        if (drawable == null || !factor.isFinite() || factor <= 0) return
        val old = currentScale(); if (old <= 0) return
        val next = (old * factor).coerceIn(minimumScale, minimumScale * 12f)
        transform.postScale(next / old, next / old, x, y); constrain()
    }
    private fun constrain() {
        val picture = drawable ?: return
        val rect = RectF(0f, 0f, picture.intrinsicWidth.toFloat(), picture.intrinsicHeight.toFloat()); transform.mapRect(rect)
        val dx = if (rect.width() <= width) (width - rect.width()) / 2f - rect.left else when { rect.left > 0 -> -rect.left; rect.right < width -> width - rect.right; else -> 0f }
        val dy = if (rect.height() <= height) (height - rect.height()) / 2f - rect.top else when { rect.top > 0 -> -rect.top; rect.bottom < height -> height - rect.bottom; else -> 0f }
        transform.postTranslate(dx, dy); imageMatrix = transform
    }
    override fun onTouchEvent(event: MotionEvent): Boolean {
        parent?.requestDisallowInterceptTouchEvent(true)
        scale.onTouchEvent(event); gestures.onTouchEvent(event)
        if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) scaling = false
        return true
    }
    override fun performClick(): Boolean { super.performClick(); return true }
}

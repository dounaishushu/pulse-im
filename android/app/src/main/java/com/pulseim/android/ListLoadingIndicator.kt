package com.pulseim.android

import android.content.Context
import android.content.res.ColorStateList
import android.widget.ProgressBar

/** Native indeterminate animation pauses automatically when hidden or detached. */
internal fun listLoadingIndicator(context: Context) = ProgressBar(context).apply {
    id = R.id.home_list_loading
    isIndeterminate = true
    indeterminateTintList = ColorStateList.valueOf(0xFF3498DB.toInt())
    contentDescription = "正在加载"
    importantForAccessibility = android.view.View.IMPORTANT_FOR_ACCESSIBILITY_YES
}

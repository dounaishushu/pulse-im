package com.pulseim.android

import android.view.View
import android.view.ViewGroup
import android.widget.TextView

internal object ContactNameLabels {
    fun bind(view: TextView, userId: Int, fallback: String, resolve: (Int, String) -> String): TextView {
        view.setTag(R.id.contact_name_user, userId); view.setTag(R.id.contact_name_fallback, fallback)
        view.text = resolve(userId, fallback); return view
    }
    fun refresh(view: View, resolve: (Int, String) -> String) {
        if (view is TextView) {
            val id = view.getTag(R.id.contact_name_user) as? Int
            val fallback = view.getTag(R.id.contact_name_fallback) as? String
            if (id != null && fallback != null) {
                val next = resolve(id, fallback); if (view.text.toString() != next) view.text = next
            }
        }
        if (view is ViewGroup) for (i in 0 until view.childCount) refresh(view.getChildAt(i), resolve)
    }
}

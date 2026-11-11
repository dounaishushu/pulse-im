package com.pulseim.android

import android.view.View
import android.view.ViewGroup

/** Long-clickable children consume taps; retain the nearest existing card action. */
internal object ChatMessageTouch {
    fun bind(view: View, onLongClick: (View) -> Unit) {
        val listener = View.OnLongClickListener { anchor -> onLongClick(anchor); true }
        fun attach(node: View, parentClickTarget: View? = null) {
            if (node.id == R.id.chat_peer_avatar || node.id == R.id.group_message_avatar) return
            val clickTarget = if (node.hasOnClickListeners()) node else parentClickTarget
            if (clickTarget != null && clickTarget !== node) node.setOnClickListener { clickTarget.performClick() }
            node.setOnLongClickListener(listener)
            if (node is ViewGroup) for (i in 0 until node.childCount) attach(node.getChildAt(i), clickTarget)
        }
        attach(view)
    }
}

package com.pulseim.android

import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import org.json.JSONObject

internal object ContactNameLabels {
    private data class TextBinding(val body: JSONObject, val summary: Boolean, val trim: Boolean)
    fun bind(view: TextView, userId: Int, fallback: String, resolve: (Int, String) -> String, prefix: String = ""): TextView {
        view.setTag(R.id.contact_name_user, userId); view.setTag(R.id.contact_name_fallback, fallback)
        view.setTag(R.id.contact_name_prefix, prefix)
        view.text = prefix + resolve(userId, fallback); return view
    }
    fun bindText(view: TextView, body: JSONObject, resolve: (Int, String) -> String, summary: Boolean = false, trim: Boolean = false): TextView {
        view.setTag(R.id.contact_message_text, null)
        if (body.isNull("text") || body.optString("text").isBlank()) return view
        val binding = TextBinding(body, summary, trim)
        view.setTag(R.id.contact_message_text, binding)
        updateText(view, binding, resolve); return view
    }
    private fun updateText(view: TextView, binding: TextBinding, resolve: (Int, String) -> String) {
        var text = MentionDisplayText.text(binding.body, resolve)
        if (binding.trim) text = text.trim()
        if (binding.summary) text = text.replace('\n', ' ').take(180)
        if (view.text.toString() != text) view.text = text
    }
    fun bindMessage(view: View, message: JSONObject, resolve: (Int, String) -> String) {
        if (!RichMessageContent.available(message)) {
            for (id in listOf(R.id.chat_message_text, R.id.chat_image_caption))
                view.findViewById<TextView>(id)?.setTag(R.id.contact_message_text, null)
            return
        }
        val body = message.optJSONObject("body") ?: return
        if (message.optString("type") in listOf("text", "system"))
            view.findViewById<TextView>(R.id.chat_message_text)?.let { bindText(it, body, resolve) }
        view.findViewById<TextView>(R.id.chat_image_caption)?.let { bindText(it, body, resolve, trim = true) }
    }
    fun refresh(view: View, resolve: (Int, String) -> String) {
        if (view is TextView) {
            val id = view.getTag(R.id.contact_name_user) as? Int
            val fallback = view.getTag(R.id.contact_name_fallback) as? String
            if (id != null && fallback != null) {
                val next = (view.getTag(R.id.contact_name_prefix) as? String).orEmpty() + resolve(id, fallback)
                if (view.text.toString() != next) view.text = next
            }
        }
        if (view is TextView) (view.getTag(R.id.contact_message_text) as? TextBinding)?.let { updateText(view, it, resolve) }
        if (view is ViewGroup) for (i in 0 until view.childCount) refresh(view.getChildAt(i), resolve)
    }
}

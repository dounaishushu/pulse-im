package com.pulseim.android

import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import org.json.JSONObject

/** Retains the selectable row and its callbacks when only the displayed value changes. */
internal class RecyclerMessageBinding(
    private val create: (JSONObject) -> SelectableMessageRow,
    private val names: (View, JSONObject) -> Unit
) {
    var builds = 0; private set
    private val timePattern = Regex("[T ](\\d{2}:\\d{2})")
    private fun shape(value: JSONObject): String {
        val body = JSONObject(value.optJSONObject("body")?.toString() ?: "{}"); body.remove("text")
        return listOf(value.optString("type"), value.optInt("sender_id"), value.optString("sender_avatar_url"),
            value.optString("recalled_at"), value.optString("status") == "recalled", !value.isNull("edited_at"), body.toString()).toString()
    }
    fun bind(previous: View?, item: ChatListRow): View {
        val fresh = JSONObject(item.snapshot)
        val existing = previous as? SelectableMessageRow
        val model = existing?.getTag(R.id.chat_v2_binding) as? JSONObject
        if (existing == null || model == null) {
            builds++
            return create(fresh).apply { setTag(R.id.chat_v2_binding, fresh) }
        }
        val textKind = fresh.optString("type") == "text" && model.optString("type") == "text"
        val keepContent = if (textKind) shape(model) == shape(fresh) else
            model.optJSONObject("body")?.toString() == fresh.optJSONObject("body")?.toString() && shape(model) == shape(fresh)
        val patchText = textKind && keepContent
        model.keys().asSequence().toList().forEach { model.remove(it) }; fresh.keys().forEach { key -> model.put(key, fresh.get(key)) }
        existing.rebindId(item.id)
        if (!keepContent) {
            builds++; val replacement = create(model).contentView()
            (replacement.parent as? ViewGroup)?.removeView(replacement)
            existing.replaceContent(replacement)
        }
        val time = timePattern.find(model.optString("created_at"))?.groupValues?.get(1).orEmpty()
        existing.findViewById<TextView>(R.id.group_message_time)?.let { label -> ChatTextBinding.value(label.text, time) { label.text = it } }
        existing.findViewById<TextView>(R.id.chat_v2_time)?.let { label -> ChatTextBinding.value(label.text, time) { label.text = it } }
        if (patchText) {
            val text = existing.findViewById<TextView>(R.id.chat_message_text)
            val body = model.optJSONObject("body")
            val resolve = RichMessageContent.available(model) && body != null && !body.isNull("text") && body.optString("text").isNotBlank()
            ChatTextBinding.bind(text?.text, body?.optString("text").orEmpty(), resolve, { text?.text = it }) { names(existing, model) }
        } else names(existing, model)
        return existing
    }
}

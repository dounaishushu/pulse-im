package com.pulseim.android

import org.json.JSONArray
import org.json.JSONObject

/** Resolve verified @ tokens for the viewing account; never mutate shared text. */
internal object MentionDisplayText {
    fun text(body: JSONObject?, name: (Int, String) -> String): String {
        if (body == null || body.isNull("text")) return ""
        val text = body.optString("text")
        val ids = body.optJSONArray("mention_user_ids") ?: return text
        val users = body.optJSONArray("mention_users") ?: return text
        if (text.isEmpty() || ids.length() == 0 || users.length() == 0) return text
        val targets = (0 until ids.length()).map { ids.optInt(it) }.filter { it > 0 }.toSet()
        // Older mobile caches retained wire UUIDs alongside the local target IDs.
        val legacy = linkedMapOf<String, Int>()
        body.optJSONArray("mentions")?.takeIf { it.length() == ids.length() && targets.size == ids.length() }?.let { wires ->
            for (index in 0 until wires.length()) {
                val wire = wires.opt(index) as? String
                if (wire.isNullOrEmpty() || legacy.containsKey(wire) || ids.optInt(index) <= 0) { legacy.clear(); break }
                legacy[wire] = ids.optInt(index)
            }
        }
        val labels = linkedMapOf<String, LinkedHashMap<Int, String>>()
        for (index in 0 until users.length()) {
            val user = users.optJSONObject(index) ?: continue
            val id = user.optInt("user_id").takeIf { it > 0 } ?: legacy[user.optString("user_id")] ?: continue
            if (id !in targets) continue
            val choices = user.optJSONArray("labels") ?: continue
            val fallback = user.optString("nickname").ifBlank { "会话成员" }
            val display = name(id, fallback).ifBlank { fallback }
            for (choice in 0 until choices.length()) {
                val label = choices.opt(choice) as? String ?: continue
                if (label.isNotEmpty()) labels.getOrPut(label) { linkedMapOf() }[id] = display
            }
        }
        if (labels.isEmpty()) return text
        val alternatives = labels.keys.sortedByDescending { it.length }.joinToString("|") { Regex.escape(it) }
        val space = "[\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]"
        return Regex("(^|$space)@($alternatives)(?=$space|$)").replace(text) { match ->
            match.groupValues[1] + labels.getValue(match.groupValues[2]).values.joinToString(" ") { "@$it" }
        }
    }

    fun copyMetadata(source: JSONObject, target: JSONObject) {
        for (field in listOf("mention_user_ids", "mention_users")) {
            source.optJSONArray(field)?.let { target.put(field, JSONArray(it.toString())) }
        }
    }
}

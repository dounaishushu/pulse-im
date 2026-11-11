package com.pulseim.android

import android.text.NoCopySpan
import android.text.Spanned
import android.text.SpannableStringBuilder
import android.widget.EditText
import org.json.JSONObject

/** A visible message author can be addressed without opening the member roster. */
internal object GroupAvatarMention {
    private class Target(val userId: Int, val text: String) : NoCopySpan

    fun authorName(message: JSONObject): String = sequenceOf("sender_nickname", "sender_name")
        .mapNotNull { message.opt(it) as? String }
        .map { normalize(it) }.firstOrNull { it.isNotEmpty() && it != "null" }.orEmpty()

    private fun normalize(value: String): String {
        val normalized = value.filter { !it.isISOControl() && Character.getType(it) != Character.FORMAT.toInt() }
            .replace(Regex("[\\s\\p{Z}]+"), " ").trim()
        val points = normalized.codePoints().limit(80).toArray()
        return String(points, 0, points.size).trim()
    }

    fun insert(input: EditText, userId: Int, name: String): Boolean {
        if (userId <= 0 || name.isBlank()) return false
        val start = input.selectionStart.coerceIn(0, input.length())
        val end = input.selectionEnd.coerceIn(0, input.length())
        val from = minOf(start, end); val to = maxOf(start, end)
        val prefix = if (from > 0 && !space(input.text[from - 1])) " " else ""
        val token = "@$name"; val insertion = "$prefix$token "
        if (input.length() - (to - from) + insertion.length > 5000) return false
        if (targets(input.text).toSet().let { it.size >= 100 && userId !in it }) return false
        input.text.replace(from, to, insertion)
        input.text.setSpan(Target(userId, token), from + prefix.length, from + prefix.length + token.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        input.setSelection(from + insertion.length)
        return true
    }

    /** Editing/deleting a token removes its identity; a plain copied name grants none. */
    fun targets(value: CharSequence): IntArray {
        return snapshot(value).map { it.userId }.distinct().take(100).toIntArray()
    }

    fun snapshot(value: CharSequence): List<ChatDraft.Mention> {
        if (value !is Spanned) return emptyList()
        return ChatDraft.validMentions(value.toString(), value.getSpans(0, value.length, Target::class.java).map { target ->
            ChatDraft.Mention(target.userId, value.getSpanStart(target), value.getSpanEnd(target), target.text)
        })
    }

    fun restore(text: String, mentions: List<ChatDraft.Mention>): CharSequence = SpannableStringBuilder(text).apply {
        for (item in ChatDraft.validMentions(text, mentions)) {
            setSpan(Target(item.userId, item.text), item.start, item.end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
    }

    fun copy(value: CharSequence): CharSequence = restore(value.toString(), snapshot(value))

    fun restore(input: EditText, text: String, mentions: List<ChatDraft.Mention>) {
        input.setText(text)
        // EditText.setText copies NoCopySpan away, so install identities on its final Editable.
        for (item in ChatDraft.validMentions(text, mentions)) {
            input.text.setSpan(Target(item.userId, item.text), item.start, item.end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
    }

    private fun space(value: Char): Boolean = value.isWhitespace() || Character.isSpaceChar(value)
}

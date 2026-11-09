package com.pulseim.android

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** Complete directory snapshots, independent of which pages the user has opened. */
internal object LocalDirectoryStore {
    enum class Kind { CHATS, CONTACTS, REQUESTS, GROUPS, CHANNELS }
    data class Snapshot(val items: List<JSONObject>, val savedAt: Long, val complete: Boolean = true, val requestTicket: LocalAccountStore.Ticket? = null) {
        fun toResult(): JSONObject = JSONObject().put("items", JSONArray(items.map { JSONObject(it.toString()) }))
            .put("page", 1).put("size", items.size.coerceAtLeast(1)).put("total", items.size)
        fun page(number: Int, size: Int = 50): JSONObject {
            require(number > 0 && size in 1..100)
            val from = ((number.toLong() - 1) * size).coerceAtMost(items.size.toLong()).toInt()
            return JSONObject().put("items", JSONArray(items.subList(from, (from + size).coerceAtMost(items.size)).map { JSONObject(it.toString()) }))
                .put("page", number).put("size", size).put("total", items.size)
        }
    }
    fun namespace(kind: Kind) = "directory.${kind.name.lowercase(java.util.Locale.ROOT)}"
    private fun identity(kind: Kind, item: JSONObject): Int = item.optInt(if (kind == Kind.CONTACTS) "user_id" else "id")
    private fun validate(kind: Kind, items: List<JSONObject>) {
        require(items.size <= 500_000 && items.all { identity(kind, it) > 0 })
        require(items.map { identity(kind, it) }.toSet().size == items.size)
        if (kind == Kind.GROUPS) require(items.all { it.optString("type") == "group" })
        if (kind == Kind.CHANNELS) require(items.all { it.optString("type") == "channel" })
    }
    fun read(context: Context, scope: String, kind: Kind): Snapshot? {
        val value = LocalAccountStore.read(context, scope, namespace(kind), "snapshot") ?: return null
        require(value.getInt("version") == 1)
        val rows = value.getJSONArray("items")
        val items = (0 until rows.length()).map { rows.getJSONObject(it) }
        validate(kind, items)
        return Snapshot(items, value.getLong("saved_at"), value.optBoolean("complete", false))
    }
    fun begin(scope: String, kind: Kind) = LocalAccountStore.ticket(scope, namespace(kind))
    @Synchronized fun replace(context: Context, ticket: LocalAccountStore.Ticket, kind: Kind, snapshot: Snapshot): Boolean {
        require(ticket.namespace == namespace(kind)); validate(kind, snapshot.items)
        val value = JSONObject().put("version", 1).put("saved_at", snapshot.savedAt).put("complete", snapshot.complete).put("items", JSONArray(snapshot.items))
        return LocalAccountStore.write(context, ticket, "snapshot", value)
    }

    /** A foreground page can enrich a saved directory without discarding untouched pages. */
    @Synchronized fun mergePage(context: Context, ticket: LocalAccountStore.Ticket, kind: Kind, result: JSONObject): Boolean {
        if (!LocalAccountStore.current(ticket)) return false
        val array = result.getJSONArray("items")
        val incoming = (0 until array.length()).map { array.getJSONObject(it) }; validate(kind, incoming)
        val previous = read(context, ticket.scope, kind)
        val rows = linkedMapOf<Int, JSONObject>()
        if (result.getInt("page") == 1) incoming.forEach { rows[identity(kind, it)] = it }
        previous?.items?.forEach { rows.putIfAbsent(identity(kind, it), it) }
        incoming.forEach { rows[identity(kind, it)] = it }
        return replace(context, ticket, kind, Snapshot(rows.values.toList(), System.currentTimeMillis(), false))
    }

    /** The accumulator rejects drift, holes and duplicate pages instead of replacing with a partial directory. */
    class Refresh(val ticket: LocalAccountStore.Ticket, val kind: Kind) {
        var nextPage = 1; private set
        var done = false; private set
        private var total = -1
        private var size = 0
        private val rows = linkedMapOf<Int, JSONObject>()
        fun append(result: JSONObject) {
            check(!done)
            val page = result.getInt("page"); val nextSize = result.getInt("size"); val nextTotal = result.getInt("total")
            require(page == nextPage && nextSize in 1..500 && nextTotal in 0..500_000)
            if (total < 0) { total = nextTotal; size = nextSize } else require(total == nextTotal && size == nextSize)
            val items = result.getJSONArray("items")
            val expected = (total.toLong() - (page.toLong() - 1) * size).coerceIn(0, size.toLong()).toInt()
            require(items.length() == expected)
            for (i in 0 until items.length()) {
                val item = JSONObject(items.getJSONObject(i).toString()); val id = identity(kind, item)
                require(id > 0 && !rows.containsKey(id)); rows[id] = item
            }
            done = page.toLong() * size >= total
            nextPage++
        }
        fun snapshot(): Snapshot {
            check(done && rows.size == total)
            val values = rows.values.toList(); validate(kind, values)
            return Snapshot(values, System.currentTimeMillis())
        }
    }
    fun invalidate(scope: String, kind: Kind) = LocalAccountStore.invalidate(scope, namespace(kind))

    private val conversationKinds = listOf(Kind.CHATS, Kind.GROUPS, Kind.CHANNELS)
    @Synchronized private fun change(context: Context, scope: String, kind: Kind, invalidateUnchanged: Boolean = false, transform: (List<JSONObject>) -> List<JSONObject>) {
        val old = read(context, scope, kind) ?: run {
            // A first download captured before a destructive event must not reintroduce it.
            if (invalidateUnchanged) invalidate(scope, kind)
            return
        }
        val changed = transform(old.items.map { JSONObject(it.toString()) })
        if (JSONArray(old.items).toString() == JSONArray(changed).toString()) {
            // A downloaded page may already contain a row absent from the saved snapshot.
            if (invalidateUnchanged) invalidate(scope, kind)
            return
        }
        // Ordinary unchanged events must not starve a complete directory download.
        val ticket = begin(scope, kind)
        replace(context, ticket, kind, Snapshot(changed, old.savedAt, old.complete))
    }
    private val conversationInfoFields = listOf("can_send", "send_disabled_reason", "my_muted_until", "all_muted", "my_role", "can_publish", "status", "frozen_at", "can_manage", "allow_member_add_friend")
    fun updateConversationInfo(context: Context, scope: String, conversationId: Int, fields: JSONObject) {
        require(conversationId > 0)
        conversationKinds.forEach { kind -> change(context, scope, kind) { rows -> rows.onEach { row ->
            if (row.optInt("id") == conversationId) conversationInfoFields.forEach { key ->
                if (fields.has(key)) row.put(key, fields.get(key))
            }
        } } }
    }
    fun removeConversation(context: Context, scope: String, conversationId: Int) {
        require(conversationId > 0)
        conversationKinds.forEach { kind -> change(context, scope, kind, invalidateUnchanged = true) { rows -> rows.filter { it.optInt("id") != conversationId } } }
    }
    fun removeContact(context: Context, scope: String, userId: Int) {
        require(userId > 0)
        change(context, scope, Kind.CONTACTS, invalidateUnchanged = true) { rows -> rows.filter { it.optInt("user_id") != userId } }
    }
    fun updateUnread(context: Context, scope: String, conversationId: Int, count: Int) {
        require(conversationId > 0 && count >= 0)
        conversationKinds.forEach { kind -> change(context, scope, kind) { rows -> rows.onEach { if (it.optInt("id") == conversationId) it.put("unread_count", count) } } }
    }
    fun updateMessage(context: Context, scope: String, message: JSONObject) {
        val cid = message.optInt("conversation_id"); val id = message.optInt("id")
        require(cid > 0 && id > 0)
        val removed = !message.isNull("recalled_at") || message.optString("status") in listOf("recalled", "deleted")
        conversationKinds.forEach { kind -> change(context, scope, kind, invalidateUnchanged = removed) { rows ->
            val row = rows.firstOrNull { it.optInt("id") == cid } ?: return@change rows
            val before = row.toString()
            val oldId = row.optJSONObject("last_message")?.optInt("id") ?: 0
            if (removed && oldId == id) row.remove("last_message")
            else if (!removed && id >= oldId && id > row.optInt("cleared_before_message_id")) {
                row.put("last_message", JSONObject(message.toString()))
                message.optString("created_at").takeIf { it.isNotBlank() }?.let { row.put("updated_at", it) }
            }
            if (before == row.toString()) rows else rows.sortedWith(compareByDescending<JSONObject> { it.optBoolean("is_pinned") }.thenByDescending { it.optString("updated_at") }.thenByDescending { it.optInt("id") })
        } }
    }
    fun clearConversationMessages(context: Context, scope: String, conversationId: Int, cutoff: Int) {
        require(conversationId > 0 && cutoff >= 0)
        conversationKinds.forEach { kind -> change(context, scope, kind, invalidateUnchanged = true) { rows -> rows.onEach { row -> if (row.optInt("id") == conversationId) {
            row.put("cleared_before_message_id", maxOf(cutoff, row.optInt("cleared_before_message_id"))).put("unread_count", 0)
            if ((row.optJSONObject("last_message")?.optInt("id") ?: 0) <= cutoff) row.remove("last_message")
        } } } }
    }
}

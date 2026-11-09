package com.pulseim.android

import org.json.JSONObject
import java.util.concurrent.Executor

/** Private to the signed-in account and endpoint. Shared messages retain real author names. */
internal class ContactNameDirectory(
    private val context: () -> Scope?, private val executor: Executor, private val ui: (() -> Unit) -> Unit,
    private val fetch: (Scope, Int) -> JSONObject, private val changed: () -> Unit,
    private val now: () -> Long = { android.os.SystemClock.elapsedRealtime() }
) {
    data class Scope(val base: String, val token: String, val userId: Int)
    private data class Name(val remark: String, val nickname: String, val revision: Long)
    private var owner: Scope? = null
    private var revision = 0L
    private var records = mapOf<Int, Name>()
    private var loading: Any? = null
    private var queued = false
    private var nextRefresh = 0L
    private var seeded = false
    private var remoteLoaded = false
    private fun scope(): Scope? {
        val current = context()
        if (current != owner) { owner = current; revision++; records = emptyMap(); loading = null; queued = false; nextRefresh = 0; seeded = false; remoteLoaded = false }
        return current
    }
    fun resolve(userId: Int, fallback: String): String {
        if (scope() == null || userId <= 0) return fallback
        val value = records[userId] ?: return fallback
        return value.remark.ifBlank { value.nickname.ifBlank { fallback } }
    }
    fun remember(userId: Int, remark: String, nickname: String) {
        if (scope() == null || userId <= 0) return
        records = records + (userId to Name(remark.trim(), nickname.trim(), ++revision)); changed()
    }
    fun seed(expected: Scope, items: List<JSONObject>): Boolean {
        if (scope() != expected || seeded || remoteLoaded) return false
        val cached = linkedMapOf<Int, Name>()
        for (item in items) {
            val id = item.optInt("user_id"); if (id <= 0) continue
            cached[id] = Name(item.optString("remark").takeUnless { it == "null" }.orEmpty().trim(), item.optString("nickname").takeUnless { it == "null" }.orEmpty().trim(), 0)
        }
        // Disk data is older than any in-flight network refresh and explicit local remark edit.
        cached.putAll(records); records = cached; seeded = true; changed(); return true
    }
    fun refresh(force: Boolean = false) {
        val ownerScope = scope() ?: return
        if (loading != null) { if (force) queued = true; return }
        if (!force && now() < nextRefresh) return
        val request = Any(); val ticket = revision; loading = request
        executor.execute {
            try {
                val result = linkedMapOf<Int, Name>(); var page = 1; var pages = 1; var expectedTotal: Int? = null
                do {
                    val body = fetch(ownerScope, page); val items = body.getJSONArray("items"); val size = body.getInt("size"); val total = body.getInt("total")
                    require(body.getInt("page") == page && size in 1..100 && total >= 0 && items.length() <= size)
                    if (expectedTotal == null) { expectedTotal = total; pages = maxOf(1, ((total.toLong() + size - 1) / size).toInt()); require(pages <= 10000) }
                    require(total == expectedTotal && (page >= pages || items.length() > 0))
                    for (i in 0 until items.length()) {
                        val row = items.getJSONObject(i); val id = row.getInt("user_id")
                        require(id > 0 && !result.containsKey(id))
                        result[id] = Name(row.getString("remark").trim(), row.getString("nickname").trim(), ticket)
                    }
                    page++
                } while (page <= pages)
                require(result.size == expectedTotal)
                ui {
                    if (scope() != ownerScope || loading !== request) return@ui
                    val merged = result.toMutableMap()
                    records.filterValues { it.revision > ticket }.forEach { (id, value) -> merged[id] = value }
                    val again = queued; queued = false; loading = null
                    if (!again) { records = merged; remoteLoaded = true; nextRefresh = now() + 30000; changed() }
                    if (again) refresh(true)
                }
            } catch (_: Exception) {
                ui {
                    if (scope() != ownerScope || loading !== request) return@ui
                    loading = null; nextRefresh = now() + 5000
                    val again = queued; queued = false; if (again) refresh(true)
                }
            }
        }
    }
}

package com.pulseim.android

import android.content.Context
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.security.MessageDigest

/** A row and the legacy snapshot commit together, under the existing account ticket. */
internal class OutboxRoomStore(
    context: Context,
    private val ticket: LocalAccountStore.Ticket,
    private val version: Int,
    private val readLegacy: () -> OutboxRecord.Snapshot?,
    private val writeLegacy: (OutboxRecord.Snapshot) -> Unit,
    private val clock: () -> Long = System::currentTimeMillis,
    private val sample: (() -> OutboxRollout.Time)? = null,
    private val capacityLimit: () -> Long = { OutboxCapacity.MAX_JSON_BYTES.toLong() },
) {
    private val app = context.applicationContext
    private val scope get() = ticket.scope
    private val namespace get() = ticket.namespace
    private var verifiedBeforeRestore = false
    private fun time() = sample?.invoke() ?: OutboxRollout.Time(clock(), SystemClock.elapsedRealtime(), bootIdentity(app))
    private data class Metadata(val rollout: OutboxRollout, val capacity: OutboxCapacity?)

    fun read(): OutboxRecord.Snapshot? = LocalAccountStore.outboxTransaction(app, ticket) { dao ->
        val metadata = metadata(dao); val rollout = metadata?.rollout
        if (rollout?.roomReads == true) {
            verifiedBeforeRestore = true
            snapshot(dao, metadata?.capacity)
        } else {
            val legacy = readLegacy()
            // A divergent shadow is rebuilt from the authoritative legacy queue on bind.
            // Cryptographic/database errors still throw; they are never treated as an empty queue.
            verifiedBeforeRestore = rollout != null && !rollout.legacyOnly && rollout.dualSince > 0 && legacy != null && OutboxRecord.same(legacy, snapshot(dao, metadata?.capacity))
            legacy
        }
    }

    fun writeRows(upserts: List<OutboxRecord>, deletes: List<String>, replaceAll: Boolean, legacy: () -> OutboxRecord.Snapshot) {
        LocalAccountStore.outboxTransaction(app, ticket) { dao ->
            val stamp = time(); val now = stamp.wall
            val metadata = metadata(dao)
            var rollout = metadata?.rollout ?: OutboxRollout(false, 0, 0, 0)
            if (rollout.legacyOnly) {
                writeLegacy(legacy())
                saveMetadata(dao, rollout.observed(stamp, rollout.nextPosition), null)
                return@outboxTransaction
            }
            check(replaceAll || rollout.dualSince > 0) { "待发队列尚未加载" }
            check(upserts.map { it.requestId }.distinct().size == upserts.size && deletes.distinct().size == deletes.size && upserts.none { it.requestId in deletes })
            val previous = if (replaceAll) dao.headers(scope, namespace).associateBy { it.requestId } else emptyMap()
            var capacity = if (replaceAll) OutboxCapacity.empty() else metadata?.capacity ?: measure(records(dao))
            var position = if (replaceAll) 0L else rollout.nextPosition
            if (replaceAll) dao.clear(scope, namespace)
            upserts.forEach { record ->
                val old = if (replaceAll) previous[record.requestId] else dao.header(scope, namespace, record.requestId)
                if (!replaceAll && old != null) capacity = capacity.remove(OutboxCapacity.Cost.of(loadRecord(dao, old)))
                capacity = capacity.add(OutboxCapacity.Cost.of(record))
                val ordinal = if (replaceAll || old == null) position.also { position = Math.incrementExact(position) } else old.position
                val createdAt = old?.createdAt ?: now
                val row = OutboxEntity().apply {
                    accountKey = scope; namespace = this@OutboxRoomStore.namespace; requestId = record.requestId
                    this.position = ordinal; this.createdAt = createdAt
                    data = LocalAccountStore.seal(scope, namespace, rowKey(requestId), encode(record, ordinal, createdAt))
                }
                dao.upsert(row)
            }
            deletes.forEach { id ->
                dao.header(scope, namespace, id)?.let { capacity = capacity.remove(OutboxCapacity.Cost.of(loadRecord(dao, it))) }
                dao.delete(scope, namespace, id)
            }
            capacity.requireFits(capacityLimit())
            if (!rollout.roomReads) {
                val full = legacy()
                writeLegacy(full)
                if (replaceAll) {
                    check(OutboxRecord.same(full, snapshot(dao, capacity))) { "待发队列双写校验失败，请保留本地数据后重试" }
                    rollout = rollout.verified(stamp, position, verifiedBeforeRestore)
                } else rollout = rollout.observed(stamp, position)
            } else rollout = rollout.observed(stamp, position)
            saveMetadata(dao, rollout, capacity)
        }
    }

    /** Explicit operator switch only. Elapsed time alone never enables Room reads. */
    fun switchReads(room: Boolean) {
        val eligible = LocalAccountStore.outboxTransaction(app, ticket) { dao ->
            val metadata = requireNotNull(metadata(dao)) { "待发队列尚未加载" }; val rollout = metadata.rollout
            val now = time()
            if (room && rollout.roomReads) return@outboxTransaction true
            if (room) {
                if (rollout.legacyOnly) return@outboxTransaction false
                val full = readLegacy()
                val rows = records(dao); val capacity = measure(rows)
                check(metadata.capacity == null || capacity.same(metadata.capacity)) { "Outbox capacity metadata mismatch" }
                val same = full != null && OutboxRecord.same(full, OutboxRecord.combine(rows, version))
                if (!same) {
                    // Commit the reset even though the requested cutover is refused below.
                    saveMetadata(dao, rollout.verified(now, rollout.nextPosition, false), capacity)
                    return@outboxTransaction false
                }
                val checked = rollout.verified(now, rollout.nextPosition, true)
                if (!checked.eligible(now)) {
                    saveMetadata(dao, checked, capacity)
                    return@outboxTransaction false
                }
                capacity.requireFits(capacityLimit())
                saveMetadata(dao, checked.cutover(now, true), capacity)
            } else {
                // Once Room is authoritative the old blob can lag. Rebuild it before switching.
                if (rollout.roomReads) writeLegacy(snapshot(dao, metadata.capacity))
                saveMetadata(dao, rollout.rollback(now), null)
            }
            true
        }
        check(eligible) { "待发队列尚未完成一周双写校验" }
    }

    fun status(): OutboxRollout? = LocalAccountStore.outboxTransaction(app, ticket) { metadata(it)?.rollout }

    /** Call on the owner's disk lane, then rebind the queue before sending again. */
    fun resumeDualWrites() = LocalAccountStore.outboxTransaction(app, ticket) { dao ->
        val rollout = requireNotNull(metadata(dao)) { "待发队列尚未加载" }.rollout
        check(!rollout.roomReads) { "请先回滚到旧待发存储" }
        saveMetadata(dao, OutboxRollout(false, 0, 0, 0), null)
    }

    private fun measure(rows: List<OutboxRecord>): OutboxCapacity = rows.fold(OutboxCapacity.empty()) { total, row -> total.add(OutboxCapacity.Cost.of(row)) }
    private fun snapshot(dao: OutboxDao, expected: OutboxCapacity?): OutboxRecord.Snapshot {
        val rows = records(dao)
        check(expected == null || measure(rows).same(expected)) { "Outbox capacity metadata mismatch" }
        return OutboxRecord.combine(rows, version)
    }
    private fun records(dao: OutboxDao): List<OutboxRecord> {
        val headers = dao.headers(scope, namespace)
        check(headers.size <= 10000) { "待发队列条目过多" }
        check(headers.map { it.position }.distinct().size == headers.size)
        return headers.map { loadRecord(dao, it) }
    }
    private fun loadRecord(dao: OutboxDao, header: OutboxRowHeader): OutboxRecord {
        check(header.position >= 0 && header.createdAt > 0 && header.byteCount in 28..(40 * 1024 * 1024))
        val bytes = ByteArray(header.byteCount)
        var offset = 0
        while (offset < bytes.size) {
            val count = minOf(256 * 1024, bytes.size - offset)
            val chunk = requireNotNull(dao.chunk(scope, namespace, header.requestId, offset + 1, count))
            check(chunk.size == count)
            chunk.copyInto(bytes, offset); offset += count
        }
        val plain = LocalAccountStore.unseal(scope, namespace, rowKey(header.requestId), bytes)
        return DataInputStream(ByteArrayInputStream(plain)).use { input ->
            check(input.readInt() == 1 && input.readUTF() == header.requestId)
            check(input.readLong() == header.position && input.readLong() == header.createdAt)
            val data = readBytes(input); val retry = readBytes(input)
            check(input.available() == 0)
            OutboxRecord(header.requestId, data, retry)
        }
    }
    private fun readBytes(input: DataInputStream): ByteArray {
        val size = input.readInt()
        check(size in 0..(32 * 1024 * 1024) && size <= input.available())
        return ByteArray(size).also { input.readFully(it) }
    }
    private fun encode(record: OutboxRecord, position: Long, createdAt: Long): ByteArray {
        val bytes = ByteArrayOutputStream()
        DataOutputStream(bytes).use { out ->
            out.writeInt(1); out.writeUTF(record.requestId); out.writeLong(position); out.writeLong(createdAt)
            val data = record.snapshot.data(); val retry = requireNotNull(record.snapshot.retry())
            out.writeInt(data.size); out.write(data); out.writeInt(retry.size); out.write(retry)
        }
        return bytes.toByteArray()
    }
    private fun metadata(dao: OutboxDao): Metadata? = dao.metadata(scope, namespace)?.let {
        val data = JSONObject(String(LocalAccountStore.unseal(scope, namespace, "room-rollout", it.data), Charsets.UTF_8))
        val format = data.getInt("version"); check(format in 1..3)
        val rollout = OutboxRollout(data.getBoolean("room_reads"), data.optBoolean("legacy_only", false), data.getLong("dual_since"), data.getLong("verified_at"), data.getLong("observed_at"), data.getLong("next_position"),
            if (format >= 2) data.getLong("since_elapsed") else -1, if (format >= 2) data.getLong("last_elapsed") else -1, if (format >= 2) data.getString("boot_id") else "")
        Metadata(rollout, if (format == 3) OutboxCapacity(data.getLong("row_count"), data.getLong("data_bytes"), data.getLong("retry_bytes"), data.getLong("slash_allowance")) else null)
    }
    private fun saveMetadata(dao: OutboxDao, value: OutboxRollout, capacity: OutboxCapacity?) {
        val record = JSONObject().put("version", if (capacity == null) 2 else 3).put("room_reads", value.roomReads).put("legacy_only", value.legacyOnly).put("dual_since", value.dualSince)
            .put("verified_at", value.lastVerifiedAt).put("observed_at", value.lastObservedAt).put("next_position", value.nextPosition)
            .put("since_elapsed", value.sinceElapsed).put("last_elapsed", value.lastElapsed).put("boot_id", value.bootId)
        capacity?.let { record.put("row_count", it.count).put("data_bytes", it.dataBytes).put("retry_bytes", it.retryBytes).put("slash_allowance", it.slashAllowance) }
        dao.upsert(OutboxMetadata().apply {
            accountKey = scope; namespace = this@OutboxRoomStore.namespace
            data = LocalAccountStore.seal(scope, namespace, "room-rollout", record.toString().toByteArray(Charsets.UTF_8))
        })
    }
    private fun rowKey(id: String): String = "row-" + MessageDigest.getInstance("SHA-256")
        .digest(id.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    companion object {
        private var systemBootId: String? = null
        @Synchronized internal fun bootIdentity(context: Context): String {
            return systemBootId ?: run {
                val boot = try { Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT, -1) }
                catch (error: SecurityException) { Log.w("PulseOutbox", "Cannot verify boot identity; Room cutover stays disabled", error); -1 }
                (if (boot >= 0) "boot-$boot" else "").also { systemBootId = it }
            }
        }
    }
}

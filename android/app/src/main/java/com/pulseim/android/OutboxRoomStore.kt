package com.pulseim.android

import android.content.Context
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
) {
    private val app = context.applicationContext
    private val scope get() = ticket.scope
    private val namespace get() = ticket.namespace
    private var verifiedBeforeRestore = false

    fun read(): OutboxRecord.Snapshot? = LocalAccountStore.outboxTransaction(app, ticket) { dao ->
        val rollout = metadata(dao)
        if (rollout?.roomReads == true) {
            verifiedBeforeRestore = true
            snapshot(dao)
        } else {
            val legacy = readLegacy()
            // A divergent shadow is rebuilt from the authoritative legacy queue on bind.
            // Cryptographic/database errors still throw; they are never treated as an empty queue.
            verifiedBeforeRestore = rollout != null && !rollout.legacyOnly && rollout.dualSince > 0 && legacy != null && OutboxRecord.same(legacy, snapshot(dao))
            legacy
        }
    }

    fun writeRows(upserts: List<OutboxRecord>, deletes: List<String>, replaceAll: Boolean, legacy: () -> OutboxRecord.Snapshot) {
        LocalAccountStore.outboxTransaction(app, ticket) { dao ->
            val now = clock()
            var rollout = metadata(dao) ?: OutboxRollout(false, 0, 0, 0)
            if (rollout.legacyOnly) {
                writeLegacy(legacy())
                saveMetadata(dao, rollout.observed(now, rollout.nextPosition))
                return@outboxTransaction
            }
            check(replaceAll || rollout.dualSince > 0) { "待发队列尚未加载" }
            val previous = if (replaceAll) dao.headers(scope, namespace).associateBy { it.requestId } else emptyMap()
            var position = if (replaceAll) 0L else rollout.nextPosition
            if (replaceAll) dao.clear(scope, namespace)
            upserts.forEach { record ->
                val old = if (replaceAll) previous[record.requestId] else dao.header(scope, namespace, record.requestId)
                val ordinal = if (replaceAll || old == null) position.also { position = Math.incrementExact(position) } else old.position
                val createdAt = old?.createdAt ?: now
                val row = OutboxEntity().apply {
                    accountKey = scope; namespace = this@OutboxRoomStore.namespace; requestId = record.requestId
                    this.position = ordinal; this.createdAt = createdAt
                    data = LocalAccountStore.seal(scope, namespace, rowKey(requestId), encode(record, ordinal, createdAt))
                }
                dao.upsert(row)
            }
            deletes.forEach { dao.delete(scope, namespace, it) }
            if (!rollout.roomReads) {
                val full = legacy()
                writeLegacy(full)
                if (replaceAll) {
                    check(OutboxRecord.same(full, snapshot(dao))) { "待发队列双写校验失败，请保留本地数据后重试" }
                    rollout = rollout.verified(now, position, verifiedBeforeRestore)
                } else rollout = rollout.observed(now, position)
            } else rollout = rollout.observed(now, position)
            saveMetadata(dao, rollout)
        }
    }

    /** Explicit operator switch only. Elapsed time alone never enables Room reads. */
    fun switchReads(room: Boolean) {
        val eligible = LocalAccountStore.outboxTransaction(app, ticket) { dao ->
            val rollout = requireNotNull(metadata(dao)) { "待发队列尚未加载" }
            val now = clock()
            if (room && rollout.roomReads) return@outboxTransaction true
            if (room) {
                if (rollout.legacyOnly) return@outboxTransaction false
                val full = readLegacy()
                val same = full != null && OutboxRecord.same(full, snapshot(dao))
                if (!same) {
                    // Commit the reset even though the requested cutover is refused below.
                    saveMetadata(dao, rollout.verified(now, rollout.nextPosition, false))
                    return@outboxTransaction false
                }
                val checked = rollout.verified(now, rollout.nextPosition, true)
                if (now - checked.dualSince < OutboxRollout.WEEK_MS) {
                    saveMetadata(dao, checked)
                    return@outboxTransaction false
                }
                saveMetadata(dao, checked.cutover(now, true))
            } else {
                // Once Room is authoritative the old blob can lag. Rebuild it before switching.
                if (rollout.roomReads) writeLegacy(snapshot(dao))
                saveMetadata(dao, rollout.rollback(now))
            }
            true
        }
        check(eligible) { "待发队列尚未完成一周双写校验" }
    }

    fun status(): OutboxRollout? = LocalAccountStore.outboxTransaction(app, ticket) { metadata(it) }

    /** Call on the owner's disk lane, then rebind the queue before sending again. */
    fun resumeDualWrites() = LocalAccountStore.outboxTransaction(app, ticket) { dao ->
        val rollout = requireNotNull(metadata(dao)) { "待发队列尚未加载" }
        check(!rollout.roomReads) { "请先回滚到旧待发存储" }
        saveMetadata(dao, OutboxRollout(false, 0, 0, 0))
    }

    private fun snapshot(dao: OutboxDao): OutboxRecord.Snapshot {
        val headers = dao.headers(scope, namespace)
        check(headers.size <= 10000) { "待发队列条目过多" }
        val records = headers.map { header ->
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
            DataInputStream(ByteArrayInputStream(plain)).use { input ->
                check(input.readInt() == 1 && input.readUTF() == header.requestId)
                check(input.readLong() == header.position && input.readLong() == header.createdAt)
                val data = readBytes(input); val retry = readBytes(input)
                check(input.available() == 0)
                OutboxRecord(header.requestId, data, retry)
            }
        }
        check(headers.map { it.position }.distinct().size == headers.size)
        return OutboxRecord.combine(records, version)
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
    private fun metadata(dao: OutboxDao): OutboxRollout? = dao.metadata(scope, namespace)?.let {
        val data = JSONObject(String(LocalAccountStore.unseal(scope, namespace, "room-rollout", it.data), Charsets.UTF_8))
        check(data.getInt("version") == 1)
        OutboxRollout(data.getBoolean("room_reads"), data.optBoolean("legacy_only", false), data.getLong("dual_since"), data.getLong("verified_at"), data.getLong("observed_at"), data.getLong("next_position"))
    }
    private fun saveMetadata(dao: OutboxDao, value: OutboxRollout) {
        val record = JSONObject().put("version", 1).put("room_reads", value.roomReads).put("legacy_only", value.legacyOnly).put("dual_since", value.dualSince)
            .put("verified_at", value.lastVerifiedAt).put("observed_at", value.lastObservedAt).put("next_position", value.nextPosition)
        dao.upsert(OutboxMetadata().apply {
            accountKey = scope; namespace = this@OutboxRoomStore.namespace
            data = LocalAccountStore.seal(scope, namespace, "room-rollout", record.toString().toByteArray(Charsets.UTF_8))
        })
    }
    private fun rowKey(id: String): String = "row-" + MessageDigest.getInstance("SHA-256")
        .digest(id.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
}

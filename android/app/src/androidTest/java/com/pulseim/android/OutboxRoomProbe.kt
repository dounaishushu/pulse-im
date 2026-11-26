package com.pulseim.android

import android.app.Instrumentation
import android.database.sqlite.SQLiteDatabase
import android.os.Bundle
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.function.BiConsumer
import javax.crypto.Cipher

/** Real SQLite/Room/Keystore checks, restricted to the isolated acceptance package. */
class OutboxRoomProbe : Instrumentation() {
    private var phase = ""
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); phase = arguments?.getString("phase").orEmpty(); start() }
    override fun onStart() {
        val app = targetContext.applicationContext
        check(app.packageName.startsWith("com.pulseim.android.chatp1.p2"))
        val checks = mutableListOf<String>()
        val trace = mutableListOf<JSONObject>()
        val report = JSONObject().put("phase", phase).put("pid", android.os.Process.myPid())
        val endpoint = "http://127.0.0.1:9/p3-room-fixture"
        val scope = LocalAccountStore.scope(endpoint, 1)
        val dbFile = File(app.noBackupFilesDir, "local-account-v1.db")
        fun raw() = SQLiteDatabase.openDatabase(dbFile.absolutePath, null, SQLiteDatabase.OPEN_READWRITE)
        fun hash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        fun record(snapshot: OutboxRecord.Snapshot) = JSONObject().put("version", 1)
            .put("data", Base64.encodeToString(snapshot.data(), Base64.NO_WRAP))
            .put("retry_state", Base64.encodeToString(snapshot.retry(), Base64.NO_WRAP))
        var elapsed = android.os.SystemClock.elapsedRealtime()
        fun store(user: Int = 1, namespace: String = "text-outbox", clock: (() -> Long)? = null) =
            if (clock == null) AndroidOutboxStorage(app, endpoint, user, namespace) else AndroidOutboxStorage(app, endpoint, user, namespace, clock, { elapsed }, { "fixture-boot" })
        fun text(storage: AndroidOutboxStorage, user: Int = 1, token: String = "fixture-token") = TextSendQueue().apply { bindStorage(storage, token, user, endpoint) }
        fun legacy(owner: String, namespace: String = "text-outbox") = requireNotNull(LocalAccountStore.read(app, owner, namespace, "queue"))
        fun snapshot(json: JSONObject) = OutboxRecord.Snapshot(Base64.decode(json.getString("data"), Base64.NO_WRAP), Base64.decode(json.getString("retry_state"), Base64.NO_WRAP))
        fun attachments(user: Int): OutboxAttachments {
            val owner = LocalAccountStore.scope(endpoint, user)
            return OutboxAttachments(File(app.noBackupFilesDir, "outbox-attachments/$owner"), File(app.noBackupFilesDir, "outbox-open/$owner"), object : OutboxAttachments.Ciphers {
                override fun encrypt(id: String): Cipher = LocalAccountStore.encryptCipher(owner, "media-outbox", id)
                override fun decrypt(id: String, iv: ByteArray): Cipher = LocalAccountStore.decryptCipher(owner, "media-outbox", id, iv)
            })
        }
        try {
            OutboxRoomDatabase.trace = BiConsumer { sql, args ->
                synchronized(trace) { trace.add(JSONObject().put("sql", sql).put("blob_bytes", args.filterIsInstance<ByteArray>().sumOf { it.size })) }
            }
            if (phase == "migration") {
                check(!dbFile.exists()) { "Migration must use a fresh isolated package" }
                var saved: OutboxRecord.Snapshot? = null
                val queue = TextSendQueue().apply { bindStorage(object : OutboxPersistence {
                    override fun read(): ByteArray? = null
                    override fun write(data: ByteArray) = error("retry metadata required")
                    override fun write(data: ByteArray, retry: ByteArray?) { saved = OutboxRecord.Snapshot(data, retry) }
                }, "fixture-token", 1, endpoint) }
                val ids = (1..3).map { queue.enqueue("fixture-token", 1, endpoint, it, "legacy $it", 0).requestId }
                queue.claim("fixture-token", 1, endpoint, 1)
                val encrypted = LocalAccountStore.seal(scope, "text-outbox", "queue", record(requireNotNull(saved)).toString().toByteArray())
                val directory = JSONObject().put("fixture", "unchanged non-outbox namespace")
                val directoryBytes = LocalAccountStore.seal(scope, "directory", "snapshot", directory.toString().toByteArray())
                dbFile.parentFile?.mkdirs()
                SQLiteDatabase.openOrCreateDatabase(dbFile, null).use { db ->
                    db.execSQL("CREATE TABLE records(scope TEXT NOT NULL,namespace TEXT NOT NULL,record_key TEXT NOT NULL,data BLOB NOT NULL,PRIMARY KEY(scope,namespace,record_key))")
                    db.execSQL("INSERT INTO records VALUES(?,?,?,?)", arrayOf(scope, "text-outbox", "queue", encrypted))
                    db.execSQL("INSERT INTO records VALUES(?,?,?,?)", arrayOf(scope, "directory", "snapshot", directoryBytes))
                    db.version = 1
                }
                check(LocalAccountStore.read(app, scope, "directory", "snapshot").toString() == directory.toString())
                raw().use { db ->
                    check(db.version == 2)
                    db.rawQuery("SELECT data FROM records WHERE namespace='text-outbox'", null).use { c -> check(c.moveToFirst()); check(c.getBlob(0).contentEquals(encrypted)) }
                }
                checks.add("v1 raw SQLite upgrades to Room v2 without changing legacy ciphertext or another namespace")
                val storage = store(); val restored = text(storage, token = "refreshed-token")
                check((1..3).flatMap { restored.pending("refreshed-token", 1, endpoint, it) }.map { it.requestId } == ids)
                check(restored.pending("refreshed-token", 1, endpoint, 1).single().attempt == 1L)
                check(restored.pending("refreshed-token", 1, endpoint, 1).single().phase == TextSendQueue.Phase.QUEUED)
                check(storage.rolloutStatus()?.roomReads == false)
                checks.add("legacy uncertain action, request IDs and monotonic retry count survive migration; reads remain legacy")
            } else if (phase == "checks") {
                var now = System.currentTimeMillis()
                val storage = store(clock = { now }); val queue = text(storage)
                (1..3).forEach { cid -> queue.pending("fixture-token", 1, endpoint, cid).forEach { queue.acknowledge(it.requestId, "fixture-token", 1, endpoint, cid) } }
                val actions = (1..50).map { queue.enqueue("fixture-token", 1, endpoint, it, "P3 protected text $it", 0) }
                trace.clear()
                val entry = queue.claim("fixture-token", 1, endpoint, 1, 0, now).single()
                fun traceSummary(label: String): JSONObject {
                    val items = synchronized(trace) { trace.toList() }
                    val writes = items.filter { val sql = it.getString("sql").uppercase(); sql.startsWith("INSERT") || sql.startsWith("UPDATE") || sql.startsWith("DELETE") }
                    val outbox = writes.filter { it.getString("sql").contains("`outbox`") }
                    check(outbox.isNotEmpty() && outbox.size <= 2)
                    check(outbox.none { it.getString("sql").startsWith("DELETE", true) })
                    return JSONObject().put("mode", label).put("pending", 50).put("changed_actions", 1)
                        .put("outbox_statements", JSONArray(outbox)).put("all_writes", JSONArray(writes))
                }
                val dualTrace = traceSummary("dual: one row plus legacy full snapshot")
                check(dualTrace.getJSONArray("all_writes").let { (0 until it.length()).any { i -> it.getJSONObject(i).getString("sql").contains("records") } })
                report.put("dual_trace", dualTrace)
                checks.add("50 pending actions: one claim touches one Room action and one legacy snapshot atomically")
                check(runCatching { storage.switchRoomReads(true) }.exceptionOrNull() is IllegalStateException)
                check(storage.rolloutStatus()?.roomReads == false)
                checks.add("real default refuses early cutover; no implicit Room reads")
                now += OutboxRollout.WEEK_MS
                check(runCatching { storage.switchRoomReads(true) }.exceptionOrNull() is IllegalStateException)
                check(storage.rolloutStatus()?.roomReads == false)
                checks.add("wall-clock-only jump cannot satisfy the monotonic one-week gate")
                elapsed += OutboxRollout.WEEK_MS
                storage.switchRoomReads(true) // Both clocks simulated; not evidence of a real week.
                check(storage.rolloutStatus()?.roomReads == true)
                trace.clear(); queue.defer(entry, "fixture network", entry.attempt, 1000, now)
                val rowTrace = traceSummary("Room reads: simulated one-week clock")
                check(rowTrace.getJSONArray("all_writes").let { (0 until it.length()).none { i -> it.getJSONObject(i).getString("sql").contains("records") } })
                report.put("row_trace", rowTrace)
                checks.add("test-clock eligible cutover: row-only mutation never writes or evaluates the legacy full snapshot")
                val before = snapshot(legacy(scope))
                check(!OutboxRecord.same(before, requireNotNull(storage.read()).let { OutboxRecord.Snapshot(it, storage.readRetryState()) }))
                storage.switchRoomReads(false)
                val after = snapshot(legacy(scope)); storage.read()
                check(OutboxRecord.same(after, OutboxRecord.Snapshot(requireNotNull(storage.read()), storage.readRetryState())))
                check(storage.rolloutStatus()?.roomReads == false)
                checks.add("rollback reconstructs the current legacy snapshot before changing authority; no stale queue resurrection")
                check(storage.rolloutStatus()?.legacyOnly == true)
                trace.clear(); queue.enqueue("fixture-token", 1, endpoint, 70, "legacy rollback write", 0)
                check(trace.none { it.getString("sql").contains("`outbox`") && it.getString("sql").startsWith("INSERT", true) })
                storage.resumeRoomDualWrites(); queue.bindStorage(storage, "fixture-token", 1, endpoint)
                checks.add("rollback disables shadow writes; explicit resume rebuilds and starts a fresh soak")
                val legacyHash = hash(legacy(scope).toString().toByteArray())
                val rowHash = LocalAccountStore.outboxTransaction(app, LocalAccountStore.ticket(scope, "p3-inspect")) { dao -> dao.rows(scope, "text-outbox").associate { it.requestId to hash(it.data) } }
                raw().use { it.execSQL("CREATE TRIGGER p3_fail BEFORE UPDATE ON outbox_metadata BEGIN SELECT RAISE(ABORT,'p3 injected disk failure'); END") }
                try {
                    check(runCatching { queue.enqueue("fixture-token", 1, endpoint, 99, "must not publish", 0) }.isFailure)
                    check(queue.pending("fixture-token", 1, endpoint, 99).isEmpty())
                    check(hash(legacy(scope).toString().toByteArray()) == legacyHash)
                    val current = LocalAccountStore.outboxTransaction(app, LocalAccountStore.ticket(scope, "p3-inspect")) { dao -> dao.rows(scope, "text-outbox").associate { it.requestId to hash(it.data) } }
                    check(current == rowHash)
                } finally { raw().use { it.execSQL("DROP TRIGGER p3_fail") } }
                checks.add("failure after legacy write rolls back both stores and does not publish the action")
                val otherStorage = store(user = 2); val other = text(otherStorage, user = 2)
                val collision = actions[1].requestId
                val one = actions[1]
                val row = LocalAccountStore.outboxTransaction(app, LocalAccountStore.ticket(scope, "p3-inspect")) { it.row(scope, "text-outbox", collision) }
                check(row != null)
                other.enqueue("fixture-token", 2, endpoint, 1, "another account", 0)
                check(queue.pending("fixture-token", 1, endpoint, one.conversationId).single().requestId == one.requestId)
                LocalAccountStore.clearAccount(app, LocalAccountStore.scope(endpoint, 2))
                check(runCatching { other.enqueue("fixture-token", 2, endpoint, 2, "stale", 0) }.isFailure)
                val newOther = text(store(user = 2), user = 2)
                check(newOther.pending("fixture-token", 2, endpoint, 1).isEmpty())
                check(queue.pending("fixture-token", 1, endpoint, 2).size == 1)
                checks.add("cleared account cannot be resurrected by stale writes or another account's rows")
                val oldStorage = storage
                val reboundStorage = store(clock = { now }); val rebound = text(reboundStorage, token = "new-token")
                check(runCatching { oldStorage.switchRoomReads(false) }.isFailure)
                check(rebound.pending("new-token", 1, endpoint, 1).single().requestId == entry.requestId)
                checks.add("same-account rebind invalidates old ticket and retains the original action with a refreshed token")
                val large = "L".repeat(3 * 1024 * 1024)
                val big = rebound.enqueue("new-token", 1, endpoint, 80, large, 0)
                val largeStorage = store(clock = { now }); val loaded = text(largeStorage, token = "again")
                check(loaded.pending("again", 1, endpoint, 80).single().text == large)
                loaded.acknowledge(big.requestId, "again", 1, endpoint, 80)
                checks.add("3 MiB draft survives legacy and Room bounded BLOB reads without CursorWindow overflow")
                LocalAccountStore.clearNamespace(app, scope, "text-outbox")
                val emptyStorage = store(); val empty = text(emptyStorage)
                check((1..80).all { empty.pending("fixture-token", 1, endpoint, it).isEmpty() })
                checks.add("namespace clear removes both tables and rollout metadata atomically")
                val bound = AndroidOutboxStorage.text(app, "fixture-token", 1, endpoint)
                bound.enqueue("fixture-token", 1, endpoint, 90, "bound before rollback", 0)
                check(AndroidOutboxStorage.switchRoomReads(app, endpoint, 1, "text-outbox", false).get(10, TimeUnit.SECONDS))
                bound.enqueue("fixture-token", 1, endpoint, 91, "bound after rollback", 0)
                check(bound.pending("fixture-token", 1, endpoint, 90).size == 1 && bound.pending("fixture-token", 1, endpoint, 91).size == 1)
                checks.add("operator rollback runs on the existing disk lane and keeps the active cached queue writable")
                val mediaStorage = store(namespace = "media-outbox")
                val media = DurableMediaOutbox(mediaStorage, attachments(1), "fixture-token", 1, endpoint)
                val mediaOtherStorage = store(user = 2, namespace = "media-outbox")
                val mediaOther = DurableMediaOutbox(mediaOtherStorage, attachments(2), "fixture-token", 2, endpoint)
                val source = File(app.cacheDir, "p3-media.bin").apply { writeBytes(byteArrayOf(3, 4, 5)) }
                (1..50).forEach { media.enqueue("p3-media-$it", it, "file", "application/octet-stream", "fixture.bin", source, 0, 0) }
                mediaOther.enqueue("p3-media-1", 1, "file", "application/octet-stream", "fixture.bin", source, 0, 0)
                trace.clear(); val claimed = requireNotNull(media.claim(1))
                report.put("media_trace", traceSummary("50 media actions, one upload claim"))
                check(media.uploaded(claimed, "{\"url\":\"fixture\"}", claimed.attempt))
                check(media.committing(claimed, claimed.attempt))
                check(media.acknowledge(claimed.requestId, 1) != null)
                val remoteAccount = requireNotNull(mediaOther.claim(1))
                mediaOther.openFile(remoteAccount).use { check(it.file.readBytes().contentEquals(byteArrayOf(3, 4, 5))) }
                checks.add("50 encrypted media actions use one changed row; identical request IDs across accounts remain independent")
                // Two actual concurrent account writers share the database transaction authority.
                val exec = Executors.newFixedThreadPool(2)
                try {
                    val start = CountDownLatch(1)
                    val results = (3..4).map { user -> exec.submit<Int> {
                        start.await(); val q = text(store(user = user), user = user)
                        (1..10).forEach { q.enqueue("fixture-token", user, endpoint, it, "parallel $user/$it", 0) }
                        (1..10).sumOf { q.pending("fixture-token", user, endpoint, it).size }
                    } }
                    start.countDown(); check(results.all { it.get(30, TimeUnit.SECONDS) == 10 })
                } finally { exec.shutdownNow() }
                checks.add("two concurrent account writers commit twenty actions without deadlock or cross-account leakage")
                val corruptStorage = store(user = 3)
                raw().use { it.execSQL("UPDATE outbox SET data=zeroblob(length(data)) WHERE accountKey=?", arrayOf(LocalAccountStore.scope(endpoint, 3))) }
                check(runCatching { corruptStorage.read() }.isFailure)
                checks.add("corrupt authenticated row fails visibly instead of becoming an empty replacement")
                corruptStorage.switchRoomReads(false)
                val safe = text(corruptStorage, user = 3)
                check((1..10).sumOf { safe.pending("fixture-token", 3, endpoint, it).size } == 10)
                corruptStorage.resumeRoomDualWrites(); safe.bindStorage(corruptStorage, "fixture-token", 3, endpoint)
                check((1..10).sumOf { safe.pending("fixture-token", 3, endpoint, it).size } == 10)
                checks.add("explicit rollback bypasses a corrupt shadow; resume rebuilds it from the verified legacy authority")
                val repairedStorage = store(user = 5, clock = { now }); val repaired = text(repairedStorage, user = 5)
                val failed = repaired.enqueue("fixture-token", 5, endpoint, 1, "permanent failure", 0)
                repaired.claim("fixture-token", 5, endpoint, 1, 0, now)
                val repairedScope = LocalAccountStore.scope(endpoint, 5)
                raw().use { it.execSQL("CREATE TRIGGER p3_fail_state BEFORE UPDATE ON outbox_metadata WHEN NEW.accountKey='$repairedScope' BEGIN SELECT RAISE(ABORT,'state failure'); END") }
                try { check(repaired.fail(failed, "HTTP 400", failed.attempt)) }
                finally { raw().use { it.execSQL("DROP TRIGGER p3_fail_state") } }
                repaired.enqueue("fixture-token", 5, endpoint, 2, "flush earlier failed state", 0)
                now += OutboxRollout.WEEK_MS; elapsed += OutboxRollout.WEEK_MS
                repairedStorage.switchRoomReads(true)
                val restartedFailure = text(repairedStorage, user = 5).pending("fixture-token", 5, endpoint, 1).single()
                check(restartedFailure.phase == TextSendQueue.Phase.FAILED && restartedFailure.error == failed.error)
                checks.add("real SQL state failure is flushed by another action; equality cutover and Room recovery retain permanent FAILED")
                val pausedStorage = store(user = 6, namespace = "media-outbox", clock = { now })
                val paused = DurableMediaOutbox(pausedStorage, attachments(6), "fixture-token", 6, endpoint)
                val pa = paused.enqueue("pause-a", 1, "file", "application/octet-stream", "fixture.bin", source, 0, 0)
                paused.enqueue("pause-b", 1, "file", "application/octet-stream", "fixture.bin", source, 0, 0)
                paused.claim(1, now); paused.uploaded(pa, "uploaded", pa.attempt); paused.committing(pa, pa.attempt)
                val pausedScope = LocalAccountStore.scope(endpoint, 6)
                raw().use { it.execSQL("CREATE TRIGGER p3_fail_pause BEFORE UPDATE ON outbox_metadata WHEN NEW.accountKey='$pausedScope' BEGIN SELECT RAISE(ABORT,'pause failure'); END") }
                try { check(runCatching { paused.defer(pa, "offline", pa.attempt, 1000, now) }.isFailure) }
                finally { raw().use { it.execSQL("DROP TRIGGER p3_fail_pause") } }
                check(pa.phase == DurableMediaOutbox.Phase.QUEUED && paused.claim(1, now + 999) == null)
                check(paused.claim(1, now + 1000) === pa && pa.uploadJson == "uploaded")
                paused.acknowledge(pa.requestId, 1); check(paused.claim(1, now + 1000)?.requestId == "pause-b")
                checks.add("real failed COMMITTING defer recovers without restart and releases the following encrypted attachment")
                val capStorage = AndroidOutboxStorage(app, endpoint, 7, "text-outbox", { now }, { elapsed }, { "fixture-boot" }, 4096)
                val capped = text(capStorage, user = 7); capped.enqueue("fixture-token", 7, endpoint, 1, "baseline", 0)
                now += OutboxRollout.WEEK_MS; elapsed += OutboxRollout.WEEK_MS; capStorage.switchRoomReads(true)
                val oldLegacy = hash(legacy(LocalAccountStore.scope(endpoint, 7)).toString().toByteArray())
                var admitted = 1; var rejected = false
                for (cid in 2..50) {
                    val result = runCatching { capped.enqueue("fixture-token", 7, endpoint, cid, "\uFFFF".repeat(90), 0) }
                    if (result.isFailure) {
                        check(result.exceptionOrNull()?.message == "Local outbox rollback capacity exceeded")
                        check(capped.pending("fixture-token", 7, endpoint, cid).isEmpty()); rejected = true; break
                    }
                    admitted++
                }
                check(rejected && admitted in 2..49 && capStorage.rolloutStatus()?.roomReads == true)
                check(hash(legacy(LocalAccountStore.scope(endpoint, 7)).toString().toByteArray()) == oldLegacy)
                val accepted = OutboxRecord.Snapshot(requireNotNull(capStorage.read()), capStorage.readRetryState())
                val freshCapStorage = AndroidOutboxStorage(app, endpoint, 7, "text-outbox", { now }, { elapsed }, { "fixture-boot" }, 4096)
                check(OutboxRecord.same(accepted, OutboxRecord.Snapshot(requireNotNull(freshCapStorage.read()), freshCapStorage.readRetryState())))
                val recoveredCapQueue = text(freshCapStorage, user = 7)
                check((1..50).sumOf { recoveredCapQueue.pending("fixture-token", 7, endpoint, it).size } == admitted)
                val rollbackSnapshot = OutboxRecord.Snapshot(requireNotNull(freshCapStorage.read()), freshCapStorage.readRetryState())
                checks.add("Room-only capacity rejection rolls back row and encrypted counters; fresh storage verifies the accepted snapshot")
                freshCapStorage.switchRoomReads(false)
                val capLegacy = legacy(LocalAccountStore.scope(endpoint, 7))
                check(capLegacy.toString().toByteArray().size <= 4096 && OutboxRecord.same(rollbackSnapshot, snapshot(capLegacy)))
                report.put("capacity_guard", JSONObject().put("test_limit_bytes", 4096).put("accepted_actions", admitted).put("actual_rollback_json_bytes", capLegacy.toString().toByteArray().size))
                checks.add("Base64 slash-escaping is budgeted and every accepted Room-only action rolls back within the injected legacy limit")
                val oldMetadataStorage = store(user = 8, clock = { now }); val oldMetadataQueue = text(oldMetadataStorage, user = 8)
                oldMetadataQueue.enqueue("fixture-token", 8, endpoint, 1, "pre-monotonic metadata", 0)
                val oldScope = LocalAccountStore.scope(endpoint, 8)
                LocalAccountStore.outboxTransaction(app, LocalAccountStore.ticket(oldScope, "p3-inspect")) { dao ->
                    val metadata = requireNotNull(dao.metadata(oldScope, "text-outbox"))
                    val json = JSONObject(String(LocalAccountStore.unseal(oldScope, "text-outbox", "room-rollout", metadata.data)))
                    json.put("version", 1).put("dual_since", now - OutboxRollout.WEEK_MS)
                    listOf("since_elapsed", "last_elapsed", "boot_id", "row_count", "data_bytes", "retry_bytes", "slash_allowance").forEach { json.remove(it) }
                    metadata.data = LocalAccountStore.seal(oldScope, "text-outbox", "room-rollout", json.toString().toByteArray()); dao.upsert(metadata)
                }
                val upgradedStorage = store(user = 8, clock = { now }); text(upgradedStorage, user = 8)
                check(upgradedStorage.rolloutStatus()?.dualSince == now)
                check(runCatching { upgradedStorage.switchRoomReads(true) }.isFailure)
                checks.add("v1 wall-only metadata upgrades with verified counters and restarts soak instead of gaining an unobserved week")
                LocalAccountStore.clearAll(app)
                val wiped = text(store(user = 4), user = 4)
                check((1..10).all { wiped.pending("fixture-token", 4, endpoint, it).isEmpty() })
                checks.add("global wipe removes legacy data, Room actions, and cutover metadata")
            } else if (phase == "capacity-restart-seed") {
                var now = System.currentTimeMillis()
                val storage = AndroidOutboxStorage(app, endpoint, 9, "text-outbox", { now }, { elapsed }, { "fixture-boot" }, 4096)
                val queue = text(storage, user = 9); val ids = mutableListOf(queue.enqueue("fixture-token", 9, endpoint, 1, "seed", 0).requestId)
                now += OutboxRollout.WEEK_MS; elapsed += OutboxRollout.WEEK_MS; storage.switchRoomReads(true)
                for (cid in 2..50) {
                    val result = runCatching { queue.enqueue("fixture-token", 9, endpoint, cid, "\uFFFF".repeat(90), 0) }
                    if (result.isFailure) { check(result.exceptionOrNull()?.message == "Local outbox rollback capacity exceeded"); break }
                    ids.add(result.getOrThrow().requestId)
                }
                check(ids.size in 2..49)
                File(app.filesDir, "p3-capacity-seed.json").writeText(JSONObject().put("ids", JSONArray(ids)).put("pid", android.os.Process.myPid()).toString())
                checks.add("bounded Room-only queue is persisted near capacity before actual process exit")
            } else if (phase == "capacity-restart-verify") {
                val fixture = JSONObject(File(app.filesDir, "p3-capacity-seed.json").readText())
                check(fixture.getInt("pid") != android.os.Process.myPid())
                val ids = fixture.getJSONArray("ids").let { values -> (0 until values.length()).map { values.getString(it) } }
                val storage = AndroidOutboxStorage(app, endpoint, 9, "text-outbox", System::currentTimeMillis, android.os.SystemClock::elapsedRealtime, { "fixture-boot" }, 4096)
                check(storage.rolloutStatus()?.roomReads == true)
                val queue = text(storage, user = 9)
                check((1..50).flatMap { queue.pending("fixture-token", 9, endpoint, it) }.map { it.requestId } == ids)
                val recovered = OutboxRecord.Snapshot(requireNotNull(storage.read()), storage.readRetryState())
                storage.switchRoomReads(false)
                val saved = legacy(LocalAccountStore.scope(endpoint, 9))
                check(saved.toString().toByteArray().size <= 4096 && OutboxRecord.same(recovered, snapshot(saved)))
                checks.add("actual process restart recovers every admitted Room-only action and rolls back within 4096 bytes")
            } else if (phase == "oversized-restart-seed") {
                var now = System.currentTimeMillis()
                val textStorage = store(user = 10, clock = { now }); val queue = text(textStorage, user = 10)
                val textIds = mutableListOf(queue.enqueue("fixture-token", 10, endpoint, 1, "\uFFFF".repeat(90), 0).requestId)
                val mediaStorage = store(user = 11, namespace = "media-outbox", clock = { now })
                val media = DurableMediaOutbox(mediaStorage, attachments(11), "fixture-token", 11, endpoint)
                val source = File(app.cacheDir, "p3-oversized.bin").apply { writeBytes(byteArrayOf(6, 7, 8)) }
                val mediaIds = mutableListOf(media.enqueue("oversized-media-1", 1, "file", "application/octet-stream", "\uFFFF".repeat(90) + ".bin", source, 0, 0).requestId)
                now += OutboxRollout.WEEK_MS; elapsed += OutboxRollout.WEEK_MS
                textStorage.switchRoomReads(true); mediaStorage.switchRoomReads(true)
                (2..20).forEach { i ->
                    textIds.add(queue.enqueue("fixture-token", 10, endpoint, 1, "\uFFFF".repeat(90), 0).requestId)
                    mediaIds.add(media.enqueue("oversized-media-$i", 1, "file", "application/octet-stream", "\uFFFF".repeat(90) + ".bin", source, 0, 0).requestId)
                }
                val failed = queue.claim("fixture-token", 10, endpoint, 1, 0, now).single(); queue.fail(failed, "HTTP 403", failed.attempt)
                val failedMedia = requireNotNull(media.claim(1, now)); media.fail(failedMedia, "HTTP 400", failedMedia.attempt)
                val inflight = requireNotNull(media.claim(1, now)); media.uploaded(inflight, "uploaded", inflight.attempt); media.committing(inflight, inflight.attempt)
                // Emulate pre-budget metadata, keeping every existing ciphertext/action intact.
                listOf(10 to "text-outbox", 11 to "media-outbox").forEach { (user, namespace) ->
                    val owner = LocalAccountStore.scope(endpoint, user)
                    LocalAccountStore.outboxTransaction(app, LocalAccountStore.ticket(owner, "p3-inspect")) { dao ->
                        val metadata = requireNotNull(dao.metadata(owner, namespace))
                        val json = JSONObject(String(LocalAccountStore.unseal(owner, namespace, "room-rollout", metadata.data)))
                        json.put("version", if (user == 10) 1 else 2)
                        listOf("row_count", "data_bytes", "retry_bytes", "slash_allowance").forEach { json.remove(it) }
                        if (user == 10) listOf("since_elapsed", "last_elapsed", "boot_id").forEach { json.remove(it) }
                        metadata.data = LocalAccountStore.seal(owner, namespace, "room-rollout", json.toString().toByteArray()); dao.upsert(metadata)
                    }
                }
                File(app.filesDir, "p3-oversized-seed.json").writeText(JSONObject().put("pid", android.os.Process.myPid()).put("text_ids", JSONArray(textIds)).put("media_ids", JSONArray(mediaIds))
                    .put("text_legacy", hash(legacy(LocalAccountStore.scope(endpoint, 10)).toString().toByteArray()))
                    .put("media_legacy", hash(legacy(LocalAccountStore.scope(endpoint, 11), "media-outbox").toString().toByteArray())).toString())
                checks.add("twenty text and twenty encrypted media actions seeded as oversized Room authority with old v1/v2 metadata")
            } else if (phase == "oversized-restart-verify") {
                val fixture = JSONObject(File(app.filesDir, "p3-oversized-seed.json").readText()); check(fixture.getInt("pid") != android.os.Process.myPid())
                fun ids(key: String) = fixture.getJSONArray(key).let { array -> (0 until array.length()).map { array.getString(it) } }
                val textStorage = AndroidOutboxStorage(app, endpoint, 10, "text-outbox", System::currentTimeMillis, android.os.SystemClock::elapsedRealtime, { "fixture-boot" }, 4096)
                val queue = text(textStorage, user = 10); val originalIds = ids("text_ids")
                check(queue.pending("fixture-token", 10, endpoint, 1).map { it.requestId } == originalIds)
                check(queue.pending("fixture-token", 10, endpoint, 1).first().phase == TextSendQueue.Phase.FAILED)
                check(runCatching { textStorage.switchRoomReads(false) }.exceptionOrNull()?.message == "Local outbox rollback capacity exceeded")
                check(textStorage.rolloutStatus()?.roomReads == true && hash(legacy(LocalAccountStore.scope(endpoint, 10)).toString().toByteArray()) == fixture.getString("text_legacy"))
                check(runCatching { queue.enqueue("fixture-token", 10, endpoint, 1, "must not append", 0) }.isFailure)
                check(queue.pending("fixture-token", 10, endpoint, 1).map { it.requestId } == originalIds)
                checks.add("oversized Room restart retains all text IDs and permanent failure; append and premature rollback preserve authority")
                val first = queue.claim("fixture-token", 10, endpoint, 1).single(); val owner = LocalAccountStore.scope(endpoint, 10)
                raw().use { it.execSQL("CREATE TRIGGER p3_oversized_ack BEFORE UPDATE ON outbox_metadata WHEN NEW.accountKey='$owner' BEGIN SELECT RAISE(ABORT,'ack failure'); END") }
                try { check(runCatching { queue.acknowledge(first.requestId, "fixture-token", 10, endpoint, 1) }.isFailure) }
                finally { raw().use { it.execSQL("DROP TRIGGER p3_oversized_ack") } }
                check(queue.pending("fixture-token", 10, endpoint, 1).size == 20)
                queue.acknowledge(first.requestId, "fixture-token", 10, endpoint, 1)
                var removed = 1
                while (runCatching { textStorage.switchRoomReads(false) }.isFailure) {
                    val entry = queue.claim("fixture-token", 10, endpoint, 1).single()
                    queue.acknowledge(entry.requestId, "fixture-token", 10, endpoint, 1); removed++; check(removed < 20)
                }
                check(queue.pending("fixture-token", 10, endpoint, 1).size == 20 - removed)
                check(queue.pending("fixture-token", 10, endpoint, 1).first().requestId == originalIds.first())
                check(legacy(owner).toString().toByteArray().size <= 4096)
                report.put("oversized_text_acked", removed).put("oversized_text_remaining", 20 - removed)
                checks.add("oversized text ack failure rolls back atomically; only explicitly acknowledged actions leave before safe legacy rollback")
                val mediaStorage = AndroidOutboxStorage(app, endpoint, 11, "media-outbox", System::currentTimeMillis, android.os.SystemClock::elapsedRealtime, { "fixture-boot" }, 4096)
                val media = DurableMediaOutbox(mediaStorage, attachments(11), "fixture-token", 11, endpoint)
                val mediaOwner = LocalAccountStore.scope(endpoint, 11); val directory = File(app.noBackupFilesDir, "outbox-attachments/$mediaOwner")
                check(media.pending(1).map { it.requestId } == ids("media_ids") && media.pending(1).first().phase == DurableMediaOutbox.Phase.FAILED)
                val source = File(app.cacheDir, "p3-new-denied.bin").apply { writeBytes(byteArrayOf(1)) }
                val filesBefore = directory.listFiles()!!.map { it.name }.sorted()
                check(runCatching { media.enqueue("new-denied", 1, "file", "application/octet-stream", "new.bin", source, 0, 0) }.isFailure)
                check(directory.listFiles()!!.map { it.name }.sorted() == filesBefore)
                check(runCatching { mediaStorage.switchRoomReads(false) }.isFailure && mediaStorage.rolloutStatus()?.roomReads == true)
                check(hash(legacy(mediaOwner, "media-outbox").toString().toByteArray()) == fixture.getString("media_legacy"))
                checks.add("oversized encrypted media restart retains all actions/files; rejected append leaves no orphan or stale rollback")
                var mediaRemoved = 0
                while (runCatching { mediaStorage.switchRoomReads(false) }.isFailure) {
                    val entry = requireNotNull(media.claim(1))
                    if (mediaRemoved == 0) check(entry.uploadJson == "uploaded")
                    media.openFile(entry).use { check(it.file.readBytes().contentEquals(byteArrayOf(6, 7, 8))) }
                    if (entry.uploadJson.isEmpty()) media.uploaded(entry, "uploaded", entry.attempt)
                    media.committing(entry, entry.attempt); media.acknowledge(entry.requestId, 1); mediaRemoved++; check(mediaRemoved < 20)
                }
                check(directory.listFiles()!!.size == media.pending(1).size && media.pending(1).size == 20 - mediaRemoved)
                check(media.pending(1).first().phase == DurableMediaOutbox.Phase.FAILED)
                check(legacy(mediaOwner, "media-outbox").toString().toByteArray().size <= 4096)
                report.put("oversized_media_acked", mediaRemoved).put("oversized_media_remaining", 20 - mediaRemoved)
                checks.add("oversized media resumes saved upload and commit, removes only acknowledged files, and rolls back with remaining failure intact")
            } else if (phase == "crash-seed") {
                val queue = text(store())
                val ids = (1..10).map { queue.enqueue("fixture-token", 1, endpoint, it, "crash $it", 0).requestId }
                File(app.filesDir, "p3-crash-seed.json").writeText(JSONObject().put("ids", JSONArray(ids)).toString())
                checks.add("ten dual-written actions committed before crash injection")
            } else if (phase == "crash") {
                val ticket = LocalAccountStore.ticket(scope, "text-outbox")
                LocalAccountStore.outboxTransaction(app, ticket) { dao ->
                    dao.clear(scope, "text-outbox")
                    check(LocalAccountStore.write(app, ticket, "queue", record(OutboxRecord.combine(emptyList(), 1))))
                    File(app.filesDir, "p3-killed-in-transaction.json").writeText(JSONObject().put("pid", android.os.Process.myPid()).put("before_commit", true).toString())
                    android.os.Process.killProcess(android.os.Process.myPid())
                    error("Process kill returned")
                }
            } else if (phase == "crash-verify") {
                val fixture = JSONObject(File(app.filesDir, "p3-crash-seed.json").readText()).getJSONArray("ids")
                val ids = (0 until fixture.length()).map { fixture.getString(it) }
                val killed = JSONObject(File(app.filesDir, "p3-killed-in-transaction.json").readText())
                check(killed.getInt("pid") != android.os.Process.myPid())
                val queue = text(store())
                check((1..10).flatMap { queue.pending("fixture-token", 1, endpoint, it) }.map { it.requestId } == ids)
                checks.add("a real process death between both writes and SQLite commit restores all ten original actions")
            } else error("Unknown phase")
            report.put("passed", true).put("checks", JSONArray(checks)).put("sqlite_trace", JSONArray(trace))
            File(app.filesDir, "p3-room-$phase.json").writeText(report.toString(2))
            finish(-1, Bundle().apply { putString("report", report.toString()) })
        } catch (error: Throwable) {
            File(app.filesDir, "p3-room-$phase-failed.txt").writeText(error.stackTraceToString())
            finish(1, Bundle().apply { putString("error", error.stackTraceToString()) })
        } finally { OutboxRoomDatabase.trace = null }
    }
}

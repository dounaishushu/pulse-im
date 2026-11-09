package com.pulseim.android

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicInteger
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Indexed private message archive; bodies and conversation metadata are encrypted with a device key. */
internal object LocalChatStore {
    data class Ticket(val scope: String, val conversation: Int, val revision: Long, val epoch: Int)
    data class Page(val items: List<JSONObject>, val cursor: Int?, val complete: Boolean, val cleared: Int, val info: JSONObject?)
    private val epoch = AtomicInteger()
    private var helper: SQLiteOpenHelper? = null
    private var secret: SecretKey? = null
    fun scope(base: String, user: Int, token: String?) = MessageDigest.getInstance("SHA-256").digest("$base|$user|${token.orEmpty()}".toByteArray()).joinToString("") { "%02x".format(it) }
    @Synchronized private fun db(context: Context): SQLiteDatabase {
        if (helper == null) helper = object : SQLiteOpenHelper(context.applicationContext, File(context.applicationContext.noBackupFilesDir, "local-chat-v1.db").absolutePath, null, 1) {
            override fun onConfigure(db: SQLiteDatabase) { db.setForeignKeyConstraintsEnabled(true) }
            override fun onCreate(db: SQLiteDatabase) {
                db.execSQL("CREATE TABLE messages(scope TEXT NOT NULL,cid INTEGER NOT NULL,id INTEGER NOT NULL,edited TEXT NOT NULL,removed INTEGER NOT NULL,rev INTEGER NOT NULL,data BLOB,PRIMARY KEY(scope,cid,id))")
                db.execSQL("CREATE TABLE meta(scope TEXT NOT NULL,cid INTEGER NOT NULL,rev INTEGER NOT NULL DEFAULT 0,cleared INTEGER NOT NULL DEFAULT 0,cursor INTEGER,complete INTEGER NOT NULL DEFAULT 0,info BLOB,upper_id INTEGER NOT NULL DEFAULT 0,bridge INTEGER,resume INTEGER,resume_complete INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(scope,cid))")
            }
            override fun onUpgrade(db: SQLiteDatabase, old: Int, next: Int) = Unit
        }.apply { setWriteAheadLoggingEnabled(true) }
        return requireNotNull(helper).writableDatabase
    }
    private fun key(): SecretKey {
        secret?.let { return it }
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val alias = "pulse-local-messages-v1"
        val value = (store.getKey(alias, null) as? SecretKey) ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build())
        }.generateKey()
        secret = value; return value
    }
    private fun encode(scope: String, cid: Int, id: Int, value: JSONObject): ByteArray {
        val data = value.toString().toByteArray(); require(data.size <= 1024 * 1024)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()); updateAAD("$scope:$cid:$id".toByteArray()) }
        return cipher.iv + cipher.doFinal(data)
    }
    private fun decode(scope: String, cid: Int, id: Int, data: ByteArray): JSONObject {
        require(data.size in 29..(1024 * 1024 + 64))
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, data.copyOfRange(0, 12))); updateAAD("$scope:$cid:$id".toByteArray()) }
        return JSONObject(String(cipher.doFinal(data.copyOfRange(12, data.size)), Charsets.UTF_8))
    }
    @Synchronized fun ticket(context: Context, scope: String, cid: Int): Ticket {
        require(scope.matches(Regex("[a-f0-9]{64}")) && cid > 0)
        val revision = db(context).rawQuery("SELECT rev FROM meta WHERE scope=? AND cid=?", arrayOf(scope, cid.toString())).use { if (it.moveToFirst()) it.getLong(0) else 0L }
        return Ticket(scope, cid, revision, epoch.get())
    }
    @Synchronized fun read(context: Context, scope: String, cid: Int, before: Int = Int.MAX_VALUE, limit: Int = 50): Page {
        val database = db(context); var cursor: Int? = null; var complete = false; var cleared = 0; var info: JSONObject? = null
        database.rawQuery("SELECT cleared,cursor,complete,info FROM meta WHERE scope=? AND cid=?", arrayOf(scope, cid.toString())).use {
            if (it.moveToFirst()) { cleared = it.getInt(0); cursor = if (it.isNull(1)) null else it.getInt(1); complete = it.getInt(2) == 1; if (!it.isNull(3)) info = runCatching { decode(scope, cid, 0, it.getBlob(3)) }.getOrNull() }
        }
        val items = mutableListOf<JSONObject>()
        database.rawQuery("SELECT id,data FROM messages WHERE scope=? AND cid=? AND id>? AND id<=? AND removed=0 ORDER BY id DESC LIMIT ?", arrayOf(scope, cid.toString(), cleared.toString(), before.toString(), limit.coerceIn(1, 100).toString())).use {
            while (it.moveToNext()) runCatching { decode(scope, cid, it.getInt(0), it.getBlob(1)) }.getOrNull()?.takeIf { m -> m.optInt("id") == it.getInt(0) && m.optInt("conversation_id") == cid }?.let(items::add)
        }
        return Page(items.asReversed(), cursor, complete, cleared, info)
    }
    @Synchronized fun merge(context: Context, ticket: Ticket, items: List<JSONObject>, cleared: Int = 0, floor: Int? = null, maximum: Int? = null,
        cursor: Int? = null, complete: Boolean = false, info: JSONObject? = null, event: Boolean = false, latest: Boolean = false): Boolean {
        if (ticket.epoch != epoch.get()) return false
        require(items.size <= 500 && items.all { it.optInt("id") > 0 && it.optInt("conversation_id") == ticket.conversation })
        val d = db(context); val ns = ticket.scope; val cid = ticket.conversation; d.beginTransaction()
        try {
            d.execSQL("INSERT OR IGNORE INTO meta(scope,cid) VALUES(?,?)", arrayOf(ns, cid))
            d.execSQL("UPDATE meta SET rev=rev+1,cleared=MAX(cleared,?) WHERE scope=? AND cid=?", arrayOf(cleared, ns, cid))
            var revision = 0L; var cutoff = 0; var oldCursor: Int? = null; var oldComplete = false; var upper = 0; var bridge: Int? = null; var resume: Int? = null; var resumeComplete = false
            d.rawQuery("SELECT rev,cleared,cursor,complete,upper_id,bridge,resume,resume_complete FROM meta WHERE scope=? AND cid=?", arrayOf(ns, cid.toString())).use { it.moveToFirst(); revision = it.getLong(0); cutoff = it.getInt(1); oldCursor = if (it.isNull(2)) null else it.getInt(2); oldComplete = it.getInt(3) == 1; upper = it.getInt(4); bridge = if (it.isNull(5)) null else it.getInt(5); resume = if (it.isNull(6)) null else it.getInt(6); resumeComplete = it.getInt(7) == 1 }
            for (m in items) {
                val id = m.optInt("id"); if (id <= cutoff) continue
                val removed = !m.isNull("recalled_at") || m.optString("status") in listOf("deleted", "recalled")
                var skip = false
                d.rawQuery("SELECT edited,removed,rev FROM messages WHERE scope=? AND cid=? AND id=?", arrayOf(ns, cid.toString(), id.toString())).use {
                    if (it.moveToFirst() && !removed) skip = it.getInt(1) == 1 || it.getString(0) > m.optString("edited_at").takeUnless { v -> v == "null" }.orEmpty() || (!event && it.getLong(2) > ticket.revision)
                }
                if (skip) continue
                val encrypted = if (removed) null else encode(ns, cid, id, m)
                d.execSQL("INSERT OR REPLACE INTO messages(scope,cid,id,edited,removed,rev,data) VALUES(?,?,?,?,?,?,?)", arrayOf(ns, cid, id, m.optString("edited_at").takeUnless { it == "null" }.orEmpty(), if (removed) 1 else 0, revision, encrypted))
            }
            if (floor != null && maximum != null && maximum >= floor) {
                val ids = items.map { it.optInt("id") }
                val exclusion = if (ids.isEmpty()) "" else " AND id NOT IN (${ids.joinToString(",") { "?" }})"
                d.execSQL("UPDATE messages SET removed=1,data=NULL,rev=? WHERE scope=? AND cid=? AND id>=? AND id<=? AND rev<=?" + exclusion,
                    (listOf<Any>(revision, ns, cid, floor, maximum, ticket.revision) + ids).toTypedArray())
            }
            if (cutoff > 0) d.execSQL("DELETE FROM messages WHERE scope=? AND cid=? AND id<=?", arrayOf(ns, cid, cutoff))
            if (cursor != null) {
                var next = minOf(oldCursor ?: cursor, cursor); var done = oldComplete || complete
                if (latest && items.isNotEmpty() && !complete && upper > 0 && items.minOf { it.optInt("id") } > upper) {
                    if (bridge == null) { bridge = upper; resume = oldCursor; resumeComplete = oldComplete }
                    next = cursor; done = false
                } else if (!latest && bridge != null && cursor <= bridge!!) {
                    next = resume ?: cursor; done = resumeComplete || complete; bridge = null; resume = null; resumeComplete = false
                }
                if (latest) upper = maxOf(upper, items.maxOfOrNull { it.optInt("id") } ?: 0)
                d.execSQL("UPDATE meta SET cursor=?,complete=?,upper_id=?,bridge=?,resume=?,resume_complete=? WHERE scope=? AND cid=?", arrayOf(next, if (done) 1 else 0, upper, bridge, resume, if (resumeComplete) 1 else 0, ns, cid))
            }
            if (info != null) d.execSQL("UPDATE meta SET info=? WHERE scope=? AND cid=?", arrayOf(encode(ns, cid, 0, info), ns, cid))
            if (ticket.epoch != epoch.get()) return false
            d.setTransactionSuccessful(); return true
        } finally { d.endTransaction() }
    }
    @Synchronized fun clearConversation(context: Context, scope: String, cid: Int, cutoff: Int = 0) {
        epoch.incrementAndGet(); val d = db(context); d.beginTransaction()
        try { d.execSQL("DELETE FROM messages WHERE scope=? AND cid=?", arrayOf(scope, cid)); d.execSQL("INSERT OR REPLACE INTO meta(scope,cid,rev,cleared) VALUES(?,?,1,?)", arrayOf(scope, cid, cutoff)); d.setTransactionSuccessful() } finally { d.endTransaction() }
    }
    @Synchronized fun clear(context: Context) {
        epoch.incrementAndGet(); val d = db(context); d.beginTransaction()
        try { d.delete("messages", null, null); d.delete("meta", null, null); d.setTransactionSuccessful() } finally { d.endTransaction() }
    }
    fun generation() = epoch.get()
}

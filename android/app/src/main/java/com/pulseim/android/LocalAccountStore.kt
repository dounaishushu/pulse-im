package com.pulseim.android

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URI
import java.security.KeyStore
import java.security.MessageDigest
import java.util.Locale
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Private durable account data. Call disk methods off the UI thread except bounded lifecycle flushes. */
internal object LocalAccountStore {
    data class Ticket internal constructor(val scope: String, val namespace: String, internal val global: Long, internal val account: Long, internal val revision: Long)
    private const val MAX_JSON_BYTES = 64 * 1024 * 1024
    private var helper: SQLiteOpenHelper? = null
    private var secret: SecretKey? = null
    private var global = 0L
    private val accounts = mutableMapOf<String, Long>()
    private val revisions = mutableMapOf<Pair<String, String>, Long>()

    /** A token refresh/relogin must not create a different archive for the same endpoint and user. */
    @JvmStatic fun scope(endpoint: String, userId: Int): String {
        require(userId > 0)
        val uri = URI(endpoint.trim())
        val scheme = uri.scheme?.lowercase(Locale.ROOT)
        require(scheme in listOf("http", "https") && uri.host != null && uri.userInfo == null && uri.fragment == null)
        val host = uri.host.lowercase(Locale.ROOT)
        val port = uri.port.takeUnless { it == -1 || (scheme == "https" && it == 443) || (scheme == "http" && it == 80) }
        val canonical = "$scheme://$host${port?.let { ":$it" }.orEmpty()}${uri.rawPath.orEmpty().trimEnd('/')}${uri.rawQuery?.let { "?$it" }.orEmpty()}"
        val identity = JSONArray().put(canonical).put(userId).toString().toByteArray(Charsets.UTF_8)
        return MessageDigest.getInstance("SHA-256").digest(identity).joinToString("") { "%02x".format(it) }
    }

    private fun validate(scope: String, namespace: String, key: String = "snapshot") {
        require(scope.matches(Regex("[a-f0-9]{64}")))
        require(namespace.matches(Regex("[A-Za-z0-9._-]{1,80}")))
        require(key.isNotEmpty() && key.length <= 160 && key.none { it.code < 32 })
    }

    /** Reserve before queuing asynchronous work. A newer reservation invalidates older work in this namespace. */
    @JvmStatic @Synchronized fun ticket(scope: String, namespace: String): Ticket {
        validate(scope, namespace)
        val pair = scope to namespace
        val revision = (revisions[pair] ?: 0L) + 1
        revisions[pair] = revision
        return Ticket(scope, namespace, global, accounts[scope] ?: 0L, revision)
    }
    @JvmStatic @Synchronized fun current(ticket: Ticket): Boolean = ticket.global == global && ticket.account == (accounts[ticket.scope] ?: 0L) && ticket.revision == revisions[ticket.scope to ticket.namespace]
    @JvmStatic @Synchronized fun invalidate(scope: String, namespace: String) { ticket(scope, namespace) }
    @JvmStatic @Synchronized fun invalidateAccount(scope: String) {
        require(scope.matches(Regex("[a-f0-9]{64}")))
        accounts[scope] = (accounts[scope] ?: 0L) + 1
    }

    @Synchronized private fun db(context: Context): SQLiteDatabase {
        if (helper == null) helper = object : SQLiteOpenHelper(context.applicationContext, File(context.applicationContext.noBackupFilesDir, "local-account-v1.db").absolutePath, null, 1) {
            override fun onCreate(db: SQLiteDatabase) {
                db.execSQL("CREATE TABLE records(scope TEXT NOT NULL,namespace TEXT NOT NULL,record_key TEXT NOT NULL,data BLOB NOT NULL,PRIMARY KEY(scope,namespace,record_key))")
            }
            override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
        }.apply { setWriteAheadLoggingEnabled(true) }
        return requireNotNull(helper).writableDatabase
    }
    @Synchronized private fun secretKey(): SecretKey {
        secret?.let { return it }
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val alias = "pulse-local-account-v1"
        return ((store.getKey(alias, null) as? SecretKey) ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build())
        }.generateKey()).also { secret = it }
    }
    private fun aad(scope: String, namespace: String, key: String): ByteArray {
        validate(scope, namespace, key)
        return JSONArray().put("pulse-account-v1").put(scope).put(namespace).put(key).toString().toByteArray(Charsets.UTF_8)
    }
    @JvmStatic fun encryptCipher(scope: String, namespace: String, key: String): Cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
        val additional = aad(scope, namespace, key)
        init(Cipher.ENCRYPT_MODE, secretKey()); updateAAD(additional)
    }
    @JvmStatic fun decryptCipher(scope: String, namespace: String, key: String, iv: ByteArray): Cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
        require(iv.size == 12)
        val additional = aad(scope, namespace, key)
        init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, iv)); updateAAD(additional)
    }
    @JvmStatic fun seal(scope: String, namespace: String, key: String, bytes: ByteArray): ByteArray {
        val cipher = encryptCipher(scope, namespace, key)
        return cipher.iv + cipher.doFinal(bytes)
    }
    @JvmStatic fun unseal(scope: String, namespace: String, key: String, bytes: ByteArray): ByteArray {
        require(bytes.size >= 28)
        return decryptCipher(scope, namespace, key, bytes.copyOfRange(0, 12)).doFinal(bytes.copyOfRange(12, bytes.size))
    }

    /** Missing is null; corruption/keystore/database failures are errors, never an empty replacement. */
    @JvmStatic @Synchronized fun read(context: Context, scope: String, namespace: String, key: String): JSONObject? {
        validate(scope, namespace, key)
        val database = db(context)
        val owner = arrayOf(scope, namespace, key)
        // Complete directories can exceed Android's CursorWindow. Read bounded chunks from
        // one SQLite snapshot instead of asking a cursor to materialize the entire BLOB.
        database.beginTransactionNonExclusive()
        val data = try {
            val size = database.rawQuery("SELECT length(data) FROM records WHERE scope=? AND namespace=? AND record_key=?", owner).use {
                if (it.moveToFirst()) it.getInt(0) else null
            }
            val bytes = size?.let {
                require(it in 28..(MAX_JSON_BYTES + 64))
                ByteArray(it).also { target ->
                    var offset = 0
                    while (offset < target.size) {
                        val count = minOf(256 * 1024, target.size - offset)
                        database.rawQuery("SELECT substr(data,?,?) FROM records WHERE scope=? AND namespace=? AND record_key=?", arrayOf((offset + 1).toString(), count.toString(), *owner)).use { cursor ->
                            check(cursor.moveToFirst())
                            val chunk = cursor.getBlob(0); check(chunk.size == count)
                            chunk.copyInto(target, offset); offset += count
                        }
                    }
                }
            }
            database.setTransactionSuccessful(); bytes
        } finally { database.endTransaction() }
        return data?.let { JSONObject(String(unseal(scope, namespace, key, it), Charsets.UTF_8)) }
    }
    @JvmStatic @Synchronized @JvmOverloads fun read(context: Context, ticket: Ticket, key: String = "snapshot"): JSONObject? =
        if (current(ticket)) read(context, ticket.scope, ticket.namespace, key) else null

    /** SQLite commit replaces one complete record atomically; encryption failure leaves the old record intact. */
    @JvmStatic @Synchronized fun write(context: Context, ticket: Ticket, key: String, value: JSONObject): Boolean {
        if (!current(ticket)) return false
        validate(ticket.scope, ticket.namespace, key)
        val bytes = value.toString().toByteArray(Charsets.UTF_8); require(bytes.size <= MAX_JSON_BYTES)
        val encrypted = seal(ticket.scope, ticket.namespace, key, bytes)
        val database = db(context); database.beginTransaction()
        try {
            if (!current(ticket)) return false
            database.execSQL("INSERT OR REPLACE INTO records(scope,namespace,record_key,data) VALUES(?,?,?,?)", arrayOf(ticket.scope, ticket.namespace, key, encrypted))
            database.setTransactionSuccessful(); return true
        } finally { database.endTransaction() }
    }
    @JvmStatic @Synchronized fun remove(context: Context, ticket: Ticket, key: String): Boolean {
        if (!current(ticket)) return false
        validate(ticket.scope, ticket.namespace, key)
        db(context).delete("records", "scope=? AND namespace=? AND record_key=?", arrayOf(ticket.scope, ticket.namespace, key)); return true
    }
    @JvmStatic @Synchronized fun clearNamespace(context: Context, scope: String, namespace: String) {
        invalidate(scope, namespace)
        db(context).delete("records", "scope=? AND namespace=?", arrayOf(scope, namespace))
    }
    @JvmStatic @Synchronized fun clearAccount(context: Context, scope: String) {
        invalidateAccount(scope)
        db(context).delete("records", "scope=?", arrayOf(scope))
        File(context.applicationContext.noBackupFilesDir, "outbox-attachments/$scope").deleteRecursively()
        File(context.applicationContext.cacheDir, "outbox-open/$scope").deleteRecursively()
    }
    @JvmStatic @Synchronized fun clearAll(context: Context) {
        global++; revisions.clear(); accounts.clear()
        db(context).delete("records", null, null)
        File(context.applicationContext.noBackupFilesDir, "outbox-attachments").deleteRecursively()
        File(context.applicationContext.cacheDir, "outbox-open").deleteRecursively()
    }
}

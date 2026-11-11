package com.pulseim.android

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URI
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Separate from active-session tokens; the whole archive is encrypted at rest. */
class RememberedLogins(context: Context) {
    data class Account(val id: String, val account: String, val nickname: String, val avatarUrl: String)
    class Credential(val account: String, val password: String) { override fun toString() = "RememberedLoginCredential" }
    private val file = AtomicFile(File(context.applicationContext.noBackupFilesDir, "remembered-logins-v1.bin"))
    private val alias = "pulse-remembered-logins-v1"
    private fun server(raw: String): String {
        val url = URI(raw.trim())
        require(url.scheme?.lowercase() in listOf("http", "https") && !url.host.isNullOrBlank() && url.userInfo == null && url.query == null && url.fragment == null) { "服务器地址无效" }
        return URI(url.scheme.lowercase(), null, url.host.lowercase(), url.port, url.path.orEmpty().trimEnd('/'), null, null).toASCIIString()
    }
    private fun key(create: Boolean): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        check(create) { "无法解密保存的账号密码，请手动登录" }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    private fun read(): MutableList<JSONObject> {
        if (!file.baseFile.exists() && !File(file.baseFile.path + ".bak").exists()) return mutableListOf()
        try {
            check(file.baseFile.length() <= 131072)
            val bytes = file.readFully(); check(bytes.size in 29..131072)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(false), GCMParameterSpec(128, bytes.copyOfRange(0,12))) }
            val archive = JSONObject(cipher.doFinal(bytes.copyOfRange(12, bytes.size)).toString(Charsets.UTF_8))
            check(archive.getInt("version") == 1)
            val rows = archive.getJSONArray("entries"); check(rows.length() <= LIMIT)
            val result = (0 until rows.length()).map { rows.getJSONObject(it) }.toMutableList()
            val identities = mutableSetOf<String>(); val ids = mutableSetOf<String>()
            result.forEach { row ->
                val account = row.getString("account"); val password = row.getString("password"); val endpoint = row.getString("server")
                check(account.isNotBlank() && account.length <= 128 && password.isNotEmpty() && password.length <= 1024)
                check(row.getInt("user_id") > 0 && server(endpoint) == endpoint && ids.add(row.getString("id")) && identities.add(endpoint + "\n" + row.getInt("user_id")))
            }
            return result
        } catch (error: Exception) { throw IllegalStateException("保存的账号密码无法读取，请手动登录", error) }
    }
    private fun write(rows: List<JSONObject>) {
        check(rows.size <= LIMIT)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key(true)) }
        val archive = JSONObject().put("version",1).put("entries",JSONArray(rows)).toString()
        val bytes = cipher.iv + cipher.doFinal(archive.toByteArray(Charsets.UTF_8))
        val stream = file.startWrite()
        try { stream.write(bytes); file.finishWrite(stream) }
        catch (error: Exception) { file.failWrite(stream); throw IllegalStateException("账号密码保存失败，请重试",error) }
    }
    fun list(endpoint: String): List<Account> = synchronized(LOCK) {
        val scope = server(endpoint)
        read().filter { it.getString("server") == scope }.map { Account(it.getString("id"),it.getString("account"),it.optString("nickname"),it.optString("avatar_url")) }
    }
    fun credential(endpoint: String, id: String): Credential = synchronized(LOCK) {
        val scope = server(endpoint); val row = read().firstOrNull { it.getString("server") == scope && it.getString("id") == id }
        checkNotNull(row) { "该账号已移除，请重新选择" }; Credential(row.getString("account"), row.getString("password"))
    }
    fun save(endpoint: String, account: String, password: String, user: JSONObject) = synchronized(LOCK) {
        val scope = server(endpoint); val name = account.trim(); val userId = user.getInt("id")
        require(name.isNotEmpty() && name.length <= 128 && password.isNotEmpty() && password.length <= 1024 && userId > 0)
        val rows = read(); val previous = rows.firstOrNull { it.getString("server") == scope && (it.getInt("user_id") == userId || it.getString("account").equals(name, true)) }
        rows.removeAll { it.getString("server") == scope && (it.getInt("user_id") == userId || it.getString("account").equals(name,true)) }
        rows.add(0,JSONObject().put("id",previous?.getString("id") ?: UUID.randomUUID().toString()).put("server",scope).put("user_id",userId)
            .put("account",name).put("password",password).put("nickname",user.optString("nickname").take(128)).put("avatar_url",user.optString("avatar_url").take(4096)))
        write(rows.take(LIMIT))
    }
    fun remove(endpoint: String, id: String? = null, account: String? = null) = synchronized(LOCK) {
        val scope = server(endpoint); val rows = read(); val count = rows.size
        rows.removeAll { it.getString("server") == scope && (it.getString("id") == id || (!account.isNullOrBlank() && it.getString("account").equals(account.trim(),true))) }
        if (rows.size != count) write(rows)
    }
    companion object { const val LIMIT = 10; private val LOCK = Any() }
}

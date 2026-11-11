package com.pulseim.android

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Passwords never enter this store. Tokens are encrypted with a device-bound Keystore key. */
internal class AccountSessions(context: Context, endpoint: String? = null) {
    private val prefs = context.getSharedPreferences(if(endpoint==null) "pulse_accounts" else "pulse_accounts_go_" + java.security.MessageDigest.getInstance("SHA-256").digest(endpoint.trimEnd('/').toByteArray()).joinToString(""){"%02x".format(it)}, Context.MODE_PRIVATE)
    private val alias = "pulse-account-tokens-v1"
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    private fun encrypt(token: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        return Base64.encodeToString(cipher.iv + cipher.doFinal(token.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
    }
    private fun decrypt(value: String): String? = runCatching {
        val bytes = Base64.decode(value, Base64.NO_WRAP)
        require(bytes.size > 28)
        Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12))) }
            .doFinal(bytes.copyOfRange(12, bytes.size)).toString(Charsets.UTF_8)
    }.getOrNull()
    fun activeId() = prefs.getInt("active_id", 0)
    fun accounts(): JSONArray = runCatching { JSONArray(prefs.getString("accounts", "[]")) }.getOrDefault(JSONArray())
    fun profile(userId: Int = activeId()): JSONObject? = accounts().let { rows ->
        (0 until rows.length()).map { rows.getJSONObject(it) }.firstOrNull { it.optInt("id") == userId }
            ?.let { JSONObject(it.toString()).apply { remove("sealed_token") } }
    }
    fun token(userId: Int = activeId()): String? = accounts().let { rows ->
        (0 until rows.length()).map { rows.getJSONObject(it) }.firstOrNull { it.optInt("id") == userId }
            ?.optString("sealed_token")?.takeIf { it.isNotBlank() }?.let { decrypt(it) }
    }
    fun save(user: JSONObject, token: String, activate: Boolean = true) {
        val id = user.getInt("id")
        require(id > 0 && token.isNotBlank())
        val rows = accounts()
        val record = JSONObject().apply {
            for (field in listOf("id", "nickname", "username", "avatar_url", "birthday", "birthday_change_count", "gender", "signature")) {
                if (user.has(field)) put(field, user.get(field))
            }
            PublicUserId.value(user.opt("public_id"))?.let { put("public_id", it) }
            put("sealed_token", encrypt(token))
        }
        val index = (0 until rows.length()).firstOrNull { rows.getJSONObject(it).optInt("id") == id }
        if (index == null) rows.put(record) else rows.put(index, record)
        val edit = prefs.edit().putString("accounts", rows.toString())
        if (activate) edit.putInt("active_id", id)
        check(edit.commit()) { "账号信息保存失败，请重试" }
    }
    fun invalidate(id: Int) {
        val rows = accounts()
        for (i in 0 until rows.length()) if (rows.getJSONObject(i).optInt("id") == id) rows.getJSONObject(i).remove("sealed_token")
        val edit = prefs.edit().putString("accounts", rows.toString())
        if (activeId() == id) edit.putInt("active_id", 0)
        edit.commit()
    }
    fun remove(id: Int) {
        val result = JSONArray(); val rows = accounts()
        for (i in 0 until rows.length()) if (rows.getJSONObject(i).optInt("id") != id) result.put(rows.getJSONObject(i))
        val edit = prefs.edit().putString("accounts", result.toString())
        if (activeId() == id) edit.putInt("active_id", 0)
        edit.commit()
    }
}

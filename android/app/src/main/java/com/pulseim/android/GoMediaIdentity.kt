package com.pulseim.android

import java.net.URI
import java.util.LinkedHashMap
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import android.content.Context

/** A grant is short lived; the authorized media UUID and variant identify its bytes.
 * Bindings stay inside the exact API/login scope and never authorize a network read. */
internal object GoMediaIdentity {
    private val uuid = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", RegexOption.IGNORE_CASE)
    private val scopes = LinkedHashMap<String, LinkedHashMap<String, String>>(16, .75f, true)
    private val pending = LinkedHashMap<String, String>()
    private val writer = Executors.newSingleThreadScheduledExecutor()
    private var scheduled = false
    private fun hash(value: String): String {
        val hex="0123456789abcdef";val bytes=MessageDigest.getInstance("SHA-256").digest(value.toByteArray())
        return buildString(bytes.size*2){for(byte in bytes){val n=byte.toInt() and 255;append(hex[n ushr 4]);append(hex[n and 15])}}
    }
    private fun preferences() = runCatching { GoV2Ids.context.getSharedPreferences("pulse-media-identities-v1",Context.MODE_PRIVATE) }.getOrNull()
    private fun bindingKey(scope: String, raw: String): Pair<String,String>? {
        val uri=runCatching { URI(raw) }.getOrNull() ?: return null
        if(uri.scheme !in listOf("http","https")||uri.userInfo!=null||uri.rawQuery!=null||uri.fragment!=null||
            !Regex("/api/v2/media-grants/[a-f0-9]{64}/(content|preview)").matches(uri.path))return null
        val variant=uri.path.substringAfterLast('/')
        return hash(scope)+":"+hash(uri.resolve(uri.path.substringBeforeLast('/')+"/").toString()) to variant
    }
    fun flushBindings() {
        val update=synchronized(this) {
            scheduled=false
            if(pending.isEmpty())return
            LinkedHashMap(pending).also { pending.clear() }
        }
        // 磁盘配置枚举和写入不能占用供主线程查询图片标识的锁。
        val prefs=preferences() ?: run { synchronized(this){update.forEach{(key,value)->pending.putIfAbsent(key,value)}};return }
        val editor=prefs.edit()
        if(prefs.all.size+update.size>8192)prefs.all.keys.take((prefs.all.size+update.size-6144).coerceAtLeast(0)).forEach(editor::remove)
        update.forEach { (key,value)->editor.putString(key,value) };editor.apply()
    }
    @Synchronized internal fun discardMemoryForTest() { scopes.clear() }
    @Synchronized fun remember(base: String, token: String?, mediaId: String, content: String) {
        if (token.isNullOrBlank() || !uuid.matches(mediaId)) return
        val uri = runCatching { URI(content) }.getOrNull() ?: return
        if (uri.scheme !in listOf("http", "https") || uri.host.isNullOrBlank() || uri.userInfo != null || uri.rawQuery != null || uri.fragment != null ||
            !Regex("/api/v2/media-grants/[a-f0-9]{64}/content").matches(uri.path)) return
        val scope = base.trimEnd('/') + "|" + token
        val bindings = scopes.getOrPut(scope) { LinkedHashMap(128, .75f, true) }
        val prefix = URI(base).resolve("/api/v2/media/${mediaId.lowercase()}/").toString()
        bindings[content] = prefix + "content"
        bindings[content.removeSuffix("content") + "preview"] = prefix + "preview"
        bindingKey(scope,content)?.first?.let { pending[it]=prefix }
        while(pending.size>8192)pending.remove(pending.keys.first())
        if(!scheduled){scheduled=true;writer.schedule({flushBindings()},120,TimeUnit.MILLISECONDS)}
        while (bindings.size > 8192) bindings.remove(bindings.keys.first())
        while (scopes.size > 16) scopes.remove(scopes.keys.first())
    }
    @Synchronized fun identity(scope: String, source: String): String {
        scopes[scope]?.get(source)?.let { return it }
        val (key,variant)=bindingKey(scope,source) ?: return source
        val prefix=pending[key] ?: preferences()?.getString(key,null) ?: return source
        val identity=prefix+variant
        val bindings=scopes.getOrPut(scope){LinkedHashMap(128,.75f,true)}
        bindings[source]=identity
        while(bindings.size>8192)bindings.remove(bindings.keys.first())
        while(scopes.size>16)scopes.remove(scopes.keys.first())
        return identity
    }
}

package com.pulseim.android

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.net.URL
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.Callable
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import okhttp3.OkHttpClient
import okhttp3.Request

data class ClientRoute(val id: String, val name: String, val apiUrl: String, val wsUrl: String, val mediaUrl: String, val sort: Int = 0)

/** Monotonic, consecutive samples avoid reacting to one spike or oscillating between routes. */
internal class RouteLatencyPolicy {
    private var poorSamples = 0
    private var candidateID: String? = null
    private var candidateSamples = 0
    private var changedAt: Long? = null

    fun reset() { poorSamples = 0; candidateID = null; candidateSamples = 0 }
    fun routeChanged(now: Long) { reset(); changedAt = now }
    fun observe(currentMs: Long?, now: Long): Boolean {
        if (changedAt?.let { now - it < 60000L } == true || (currentMs != null && currentMs < 1500L)) {
            reset(); return false
        }
        poorSamples = minOf(3, poorSamples + 1)
        return poorSamples >= 3
    }
    fun consider(id: String?, delayMs: Long?, currentMs: Long?): String? {
        val better = id != null && delayMs != null && delayMs <= 1000L &&
            (currentMs == null || (currentMs - delayMs >= 300L && delayMs * 100 <= currentMs * 65))
        if (!better) { candidateID = null; candidateSamples = 0; return null }
        candidateSamples = if (candidateID == id) candidateSamples + 1 else 1
        candidateID = id
        return id.takeIf { candidateSamples >= 2 }
    }
}

/** One stable business identity; endpoint changes must not mix saved account namespaces. */
object RouteManager {
    @Volatile private var manager: VerifiedRoutes? = null
    private val background = Executors.newSingleThreadExecutor()
    private val healthWorker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val healthBusy = AtomicBoolean(false)
    private val foregroundGeneration = AtomicLong(0)
    @Volatile private var foreground = false
    private val healthTick = object : Runnable {
        override fun run() {
            if (!foreground) return
            refreshInBackground()
            val expected = manager
            val generation = foregroundGeneration.get()
            if (expected != null && healthBusy.compareAndSet(false, true)) healthWorker.execute {
                try { runCatching { expected.optimize { foreground && foregroundGeneration.get() == generation && manager === expected } } }
                finally { healthBusy.set(false) }
            }
            main.postDelayed(this, 20000L)
        }
    }
    fun setForeground(active: Boolean) {
        if (foreground == active) return
        foreground = active; foregroundGeneration.incrementAndGet()
        manager?.invalidateOptimization()
        main.removeCallbacks(healthTick)
        if (active) main.postDelayed(healthTick, 3000L)
    }
    @Volatile private var lastRefresh = 0L
    fun refreshInBackground() {
        val now = android.os.SystemClock.elapsedRealtime()
        if (now - lastRefresh < 300000L) return
        lastRefresh = now
        background.execute { runCatching { manager?.refresh() } }
    }
    fun initialize(context: Context, api: String, ws: String, monotonic: () -> Long = { android.os.SystemClock.elapsedRealtime() }) {
        if (manager?.logicalApi == api.trimEnd('/')) return
        manager = VerifiedRoutes(context.applicationContext, api.trimEnd('/'), ws, monotonic)
        background.execute { runCatching { manager?.refresh() } }
    }
    fun forBase(base: String): VerifiedRoutes? = manager?.takeIf { it.logicalApi == base.trimEnd('/') }
    fun api(base: String): String = forBase(base)?.activeRoute()?.apiUrl ?: base.trimEnd('/')
    fun webSocket(base: String, fallback: String): String = forBase(base)?.activeRoute()?.wsUrl ?: if(BuildConfig.GO_BACKEND) base.trimEnd('/').replaceFirst("https://","wss://").replaceFirst("http://","ws://")+"/realtime" else fallback
    fun media(raw: String, base: String): String = forBase(base)?.media(raw) ?: runCatching { URL(URL(base), raw).toString() }.getOrDefault(raw)
    fun failover(base: String, failed: String): Boolean = forBase(base)?.failover(failed) ?: false
}

class VerifiedRoutes(private val context: Context, val logicalApi: String, websocket: String,
    private val monotonic: () -> Long = { android.os.SystemClock.elapsedRealtime() }) {
    private val prefs = context.getSharedPreferences("pulse_verified_routes_v1", Context.MODE_PRIVATE)
    private val goMode=URI(logicalApi).path.trimEnd('/')=="/api/v2"
    private val main = Handler(Looper.getMainLooper())
    private val listeners = CopyOnWriteArrayList<() -> Unit>()
    private val cluster = BuildConfig.ROUTE_CLUSTER_ID
    private val publicKey = decode64(BuildConfig.ROUTE_PUBLIC_KEY_SPKI)
    private val keyId = MessageDigest.getInstance("SHA-256").digest(publicKey).joinToString("") { "%02x".format(it) }.take(24)
    private val cacheKey = cluster + ":" + logicalApi
    private val seed = ClientRoute("seed-main", "主线路", endpoint(logicalApi), endpoint(websocket, true), URI(logicalApi).let { "${it.scheme}://${it.rawAuthority}/storage" })
    private val seeds = if(goMode)listOf(seed) else runCatching { JSONArray(BuildConfig.ROUTE_SEEDS_JSON).let { rows -> (0 until rows.length()).map { parseRoute(rows.getJSONObject(it)) } } }.getOrDefault(emptyList()).ifEmpty { listOf(seed) }
    private val seedDiscovery = runCatching { JSONArray(BuildConfig.ROUTE_DISCOVERY_JSON).let { rows -> (0 until rows.length()).map { endpoint(rows.getString(it)) } } }.getOrDefault(emptyList())
    @Volatile var current: ClientRoute = seed; private set
    @Volatile var routes: List<ClientRoute> = listOf(seed); private set
    @Volatile var preferred: String = ""; private set
    @Volatile var error: String = ""; private set
    @Volatile private var revision = -1L
    @Volatile private var expires = 0L
    private var envelope: JSONObject? = null
    private var discovery: List<String> = emptyList()
    val latencies = java.util.concurrent.ConcurrentHashMap<String, Long>()
    private val gate = Any()
    private val optimizationEpoch = AtomicLong(0)
    private val optimizing = AtomicBoolean(false)
    private var sampledEpoch = -1L
    private var configurationGeneration = 0L
    private var goPolicyLoaded=false
    private val latencyPolicy = RouteLatencyPolicy()
    private data class OptimizationSnapshot(val current: ClientRoute, val alternatives: List<ClientRoute>, val epoch: Long, val generation: Long)
    private val probes = Executors.newFixedThreadPool(8)
    // These credential-free GETs may safely reconnect after an idle keep-alive is closed.
    private val anonymousHttp = OkHttpClient.Builder().retryOnConnectionFailure(true).followRedirects(false).followSslRedirects(false).callTimeout(4, TimeUnit.SECONDS).build()

    init {
        current = seeds.first(); routes = seeds
        if(goMode)preferred=prefs.getString(cacheKey+":go-preferred","").orEmpty()
        if(!goMode)runCatching {
            val cached = JSONObject(prefs.getString(cacheKey, "") ?: "")
            val signed = cached.getJSONObject("envelope")
            val valid = runCatching { verify(signed) }
            if (valid.isSuccess) {
                install(valid.getOrThrow(), signed)
                preferred = cached.optString("preferred")
                current = routes.firstOrNull { it.id == cached.optString("current") } ?: routes.first()
                persist()
            } else {
                val expired = verify(signed, true)
                revision = expired.getLong("revision")
                val sources = expired.getJSONArray("discovery_urls")
                discovery = (0 until sources.length()).map { sources.getString(it) }
            }
        }
    }
    fun observe(action: () -> Unit): () -> Unit { listeners.add(action); return { listeners.remove(action) } }
    private fun changed() { listeners.forEach { action -> main.post { runCatching { action() } } } }
    private fun persist() { if(goMode){prefs.edit().putString(cacheKey+":go-preferred",preferred).apply();return};envelope?.let { prefs.edit().putString(cacheKey, JSONObject().put("envelope", it).put("current", current.id).put("preferred", preferred).toString()).apply() } }
    private fun decode64(value: String): ByteArray {
        require(value.length <= 360000 && Regex("(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?").matches(value)) { "线路签名格式无效" }
        return Base64.decode(value, Base64.NO_WRAP)
    }
    private fun endpoint(value: String, ws: Boolean = false, media: Boolean = false): String {
        require(value.length <= 2048 && ClientPolicy.secureEndpoint(value, ws)) { "线路地址必须使用安全连接" }
        val uri = URI(value)
        require(uri.rawQuery == null && uri.fragment == null && uri.userInfo == null) { "线路地址无效" }
        if (media) require(uri.path.trimEnd('/').endsWith("/storage")) { "附件入口路径必须以 /storage 结尾" }
        if (uri.scheme in listOf("http", "ws")) require(BuildConfig.DEBUG && (goMode||uri.host in listOf("127.0.0.1", "localhost", "10.0.2.2"))) { "测试线路必须使用回环地址" }
        return value.trimEnd('/')
    }
    private fun number(json: JSONObject, key: String): Long {
        val value = json.get(key)
        require(value is Number && value.toDouble().isFinite() && value.toDouble() == value.toLong().toDouble()) { "线路版本格式无效" }
        return value.toLong()
    }
    private fun verify(signed: JSONObject, expiredDiscoveryOnly: Boolean = false): JSONObject {
        require(signed.optString("algorithm") == "ES256-DER" && signed.optString("key_id") == keyId) { "线路清单来自未受信任的签名者" }
        val bytes = decode64(signed.getString("payload")); require(bytes.size <= 262144) { "线路清单过大" }
        val key = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(publicKey))
        val verifier = Signature.getInstance("SHA256withECDSA"); verifier.initVerify(key); verifier.update(bytes)
        require(verifier.verify(decode64(signed.getString("signature")))) { "线路签名校验失败" }
        val json = JSONObject(bytes.toString(Charsets.UTF_8)); val now = System.currentTimeMillis() / 1000
        require(number(json, "version") == 1L && json.getString("cluster_id") == cluster) { "线路不属于当前业务" }
        require(number(json, "revision") >= maxOf(1L, revision)) { "线路版本已过期" }
        val issued = number(json, "issued_at"); val until = number(json, "expires_at")
        require(issued <= now + 300 && (expiredDiscoveryOnly || until > now) && until > issued && until - issued <= 604800) { "线路清单已过期" }
        val items = json.getJSONArray("routes"); require(items.length() in 1..32) { "线路数量无效" }
        val parsed = (0 until items.length()).map { parseRoute(items.getJSONObject(it)) }
        require(parsed.map { it.id }.toSet().size == parsed.size && parsed.map { it.apiUrl }.toSet().size == parsed.size) { "线路重复" }
        val sources = json.getJSONArray("discovery_urls"); require(sources.length() <= 32) { "配置入口过多" }
        for (i in 0 until sources.length()) endpoint(sources.getString(i))
        return json
    }
    private fun parseRoute(item: JSONObject): ClientRoute {
        val name = item.getString("name"); require(name.isNotBlank() && name.length <= 64) { "线路名称无效" }
        return ClientRoute(item.get("id").toString(), name, endpoint(item.optString("api_url", item.optString("url"))), endpoint(item.getString("ws_url"), true), endpoint(item.getString("media_url"), media = true), item.optInt("sort"))
    }
    private fun install(policy: JSONObject, signed: JSONObject) {
        val items = policy.getJSONArray("routes")
        val next = (0 until items.length()).map { parseRoute(items.getJSONObject(it)) }.sortedBy { it.sort }
        val sources = policy.getJSONArray("discovery_urls")
        val old = current
        routes = next; discovery = (0 until sources.length()).map { sources.getString(it) }
        revision = policy.getLong("revision"); expires = policy.getLong("expires_at"); envelope = JSONObject(signed.toString())
        current = next.firstOrNull { it.id == old.id && it.apiUrl == old.apiUrl } ?: next.firstOrNull { it.apiUrl == old.apiUrl } ?: next.first()
        configurationGeneration++
        if (old != current) latencyPolicy.routeChanged(monotonic())
        persist(); if (old != current) changed()
    }
    private fun json(url: String, limit: Int = 393216): JSONObject {
        return anonymousHttp.newCall(Request.Builder().url(url).header("Accept", "application/json").header("Cache-Control", "no-store").build()).execute().use { response ->
            require(response.code in 200..299) { "线路服务暂不可用" }
            val body = response.body ?: error("线路响应为空")
            require(body.contentLength() <= limit) { "线路响应过大" }
            val bytes = body.byteStream().use { input ->
                val output = java.io.ByteArrayOutputStream(); val block = ByteArray(4096)
                while (true) { val count = input.read(block); if (count < 0) break; require(output.size() + count <= limit) { "线路响应过大" }; output.write(block, 0, count) }; output.toByteArray()
            }
            JSONObject(bytes.toString(Charsets.UTF_8))
        }
    }
    fun refresh(): Boolean = synchronized(gate) {
        if(goMode){
            val config=json(logicalApi+"/client/config");require(config.optString("protocol")=="pulse-v2"){"线路协议无效"}
            val values=config.getJSONArray("routes");require(values.length()<=32){"线路清单过大"}
            val next=(0 until values.length()).map{values.getJSONObject(it)}.filter{it.optBoolean("enabled")}.map{row->
                val api=endpoint(row.getString("api_url"));require(URI(api).path=="/api/v2"){"线路必须使用 Go API"}
                ClientRoute(row.getString("id"),row.getString("name"),api,api.replaceFirst("https://","wss://").replaceFirst("http://","ws://")+"/realtime",api,row.optInt("sort_order"))
            }.sortedBy{it.sort}.toMutableList()
            require(next.map{it.id}.toSet().size==next.size&&next.map{it.apiUrl}.toSet().size==next.size){"线路重复"}
            if(next.none{it.apiUrl==logicalApi})next.add(0,seed)
            val previous=current;routes=next;current=(if(!goPolicyLoaded)next.firstOrNull{it.id==preferred}else null)?:next.firstOrNull{it.apiUrl==previous.apiUrl}?:next.first();goPolicyLoaded=true
            configurationGeneration++;error="";if(previous!=current)changed();return@synchronized true
        }
        expireIfNeeded()
        val sources = (listOf(current.apiUrl + "/client/route-manifest") + discovery + seedDiscovery + seeds.map { it.apiUrl + "/client/route-manifest" }).distinct().take(8)
        var best: Pair<JSONObject, JSONObject>? = null
        val responses = probes.invokeAll(sources.map { source -> Callable { runCatching { json(source) }.getOrNull() } }, 5, TimeUnit.SECONDS)
        for (future in responses) runCatching {
            val response = if (future.isDone && !future.isCancelled) future.get() else null
            if (response == null) return@runCatching
            val signed = response.optJSONObject("data") ?: response; val policy = verify(signed)
            if (best == null || policy.getLong("revision") > best!!.first.getLong("revision") || (policy.getLong("revision") == best!!.first.getLong("revision") && policy.getLong("issued_at") > best!!.first.getLong("issued_at"))) best = policy to signed
        }
        if (best == null) { error = "暂时无法更新线路，继续使用已保存线路"; false }
        else { install(best!!.first, best!!.second); error = ""; true }
    }
    fun probe(item: ClientRoute): Long {
        if(goMode){val start=android.os.SystemClock.elapsedRealtime();require(json(item.apiUrl+"/client/config").optString("protocol")=="pulse-v2"){"线路协议无效"};return (android.os.SystemClock.elapsedRealtime()-start).also{latencies[item.id]=it}}
        val nonce = ByteArray(16).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
        val start = android.os.SystemClock.elapsedRealtime()
        val response = json(item.apiUrl + "/client/route-probe?nonce=" + nonce, 4096); val data = response.getJSONObject("data")
        require(response.optBoolean("ok") && data.optBoolean("ready") && data.optString("cluster_id") == cluster && data.optString("nonce") == nonce) { "线路暂不可接管或不属于当前业务" }
        return (android.os.SystemClock.elapsedRealtime() - start).also { latencies[item.id] = it }
    }
    fun invalidateOptimization() { optimizationEpoch.incrementAndGet() }
    fun select(id: String) { invalidateOptimization(); synchronized(gate) {
        expireIfNeeded()
        val item = routes.firstOrNull { it.id == id } ?: throw IllegalArgumentException("请先更新线路")
        val deadline = expires
        probe(item); require(deadline == 0L || deadline > System.currentTimeMillis() / 1000) { "线路清单已过期，请更新线路" }
        require(routes.contains(item)) { "线路配置已更新，请重新选择" }
        val previous = current; preferred = item.id; current = item; error = ""; persist(); if (previous != current) changed()
        configurationGeneration++; latencyPolicy.routeChanged(monotonic())
    } }

    /** Anonymous foreground probes never replay an application request or promote a standby. */
    fun optimize(stillForeground: () -> Boolean = { true }): Boolean {
        if (!stillForeground() || !optimizing.compareAndSet(false, true)) return false
        try {
            val snapshot = synchronized(gate) {
                expireIfNeeded()
                val epoch = optimizationEpoch.get()
                if (sampledEpoch != epoch) { latencyPolicy.reset(); sampledEpoch = epoch }
                if (!stillForeground() || routes.size < 2) return false
                OptimizationSnapshot(current, routes.filter { it != current }, epoch, configurationGeneration)
            }
            val delay = runCatching { probe(snapshot.current) }.getOrNull()
            fun valid(): Boolean = stillForeground() && optimizationEpoch.get() == snapshot.epoch &&
                configurationGeneration == snapshot.generation && current == snapshot.current &&
                (expires == 0L || expires > System.currentTimeMillis() / 1000)
            val scan = synchronized(gate) { if (!valid()) return false; latencyPolicy.observe(delay, monotonic()) }
            if (!scan) return false
            val measured = mutableListOf<Pair<ClientRoute, Long>>()
            for (batch in snapshot.alternatives.chunked(8)) {
                if (!stillForeground() || optimizationEpoch.get() != snapshot.epoch) return false
                val results = probes.invokeAll(batch.map { route -> Callable { runCatching { route to probe(route) }.getOrNull() } }, 5, TimeUnit.SECONDS)
                results.forEach { result -> if (result.isDone && !result.isCancelled) runCatching { result.get() }.getOrNull()?.let { measured.add(it) } }
            }
            return synchronized(gate) {
                if (!valid()) return false
                val best = measured.filter { routes.contains(it.first) }.minWithOrNull(compareBy<Pair<ClientRoute, Long>> { it.second }.thenBy { it.first.sort })
                val selected = latencyPolicy.consider(best?.first?.id, best?.second, delay) ?: return false
                val target = best?.first?.takeIf { it.id == selected } ?: return false
                current = target; error = ""; configurationGeneration++; latencyPolicy.routeChanged(monotonic())
                persist(); changed(); true
            }
        } finally { optimizing.set(false) }
    }
    fun failover(failed: String): Boolean = synchronized(gate) {
        expireIfNeeded()
        if (current.apiUrl != failed) return@synchronized true
        fun attempt(): Boolean {
            val candidates = routes.filter { it.apiUrl != failed }.sortedBy { if (it.id == preferred) Int.MIN_VALUE else it.sort }
            for (batch in candidates.chunked(8)) {
                val results = probes.invokeAll(batch.map { item -> Callable { runCatching { probe(item) }.isSuccess } }, 5, TimeUnit.SECONDS)
                expireIfNeeded()
                val item = batch.indices.firstOrNull { results[it].isDone && !results[it].isCancelled && runCatching { results[it].get() }.getOrDefault(false) && routes.contains(batch[it]) }?.let { batch[it] }
                if (item != null) { current = item; error = ""; configurationGeneration++; latencyPolicy.routeChanged(monotonic()); persist(); changed(); return true }
            }
            return false
        }
        if (attempt()) return@synchronized true
        refresh()
        if (current.apiUrl != failed && runCatching { probe(current) }.isSuccess) return@synchronized true
        attempt()
    }
    fun activeRoute(): ClientRoute { expireIfNeeded(); return current }
    private fun expireIfNeeded() {
        if (expires == 0L || expires > System.currentTimeMillis() / 1000) return
        synchronized(gate) {
            if (expires == 0L || expires > System.currentTimeMillis() / 1000) return
            val previous = current; current = seeds.first(); routes = seeds; expires = 0L; envelope = null
            configurationGeneration++; latencyPolicy.routeChanged(monotonic())
            error = "保存的线路已过期，正在尝试更新"
            if (previous != current) changed()
        }
    }
    fun media(raw: String): String = runCatching {
        expireIfNeeded()
        val original = URL(URL(logicalApi), raw)
        val uri = original.toURI(); val decoded = uri.path ?: return@runCatching original.toString()
        if(goMode&&Regex("/api/v2/media-grants/[a-f0-9]{64}/(content|preview)").matches(decoded)&&uri.rawQuery==null&&(routes+seeds).any{val source=URI(it.apiUrl);source.scheme==uri.scheme&&source.rawAuthority==uri.rawAuthority})return@runCatching URI(current.apiUrl).resolve(decoded).toString()
        val query = uri.rawQuery.orEmpty().split('&').filter { it.isNotEmpty() }
        val mediaPath = if (decoded.endsWith("/media")) query.firstOrNull { it.startsWith("path=") }?.substringAfter('=')?.let { java.net.URLDecoder.decode(it, "UTF-8") }.orEmpty()
            else decoded.substringAfter("/storage/", "")
        if (!Regex("(?:uploads/\\d{4}/(?:0[1-9]|1[0-2])/[a-f0-9]{32}\\.[a-z0-9]{1,8}|work-questions/\\d{4}/(?:0[1-9]|1[0-2])/[a-f0-9]{64}\\.(?:jpg|png|gif|webp))").matches(mediaPath)) return@runCatching original.toString()
        val suffix = query.filterNot { it.startsWith("path=") }.joinToString("&")
        current.mediaUrl + "/" + mediaPath + if (suffix.isEmpty()) "" else "?$suffix"
    }.getOrDefault(raw)
}

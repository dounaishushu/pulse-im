package com.pulseim.android

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.Executors
import android.os.SystemClock

class SocketClient(private val endpoint: String, private val token: String, private val onPacket: (Int, JSONObject) -> Unit, private val onState: (Int, Boolean) -> Unit, private val endpointProvider: () -> String = { endpoint }, private val routeFailure: () -> Unit = {}, private val diagnostic: (String, Throwable?) -> Unit = { _, _ -> }, private val apiIdentity: String = endpoint.replaceFirst("wss://", "https://").replaceFirst("ws://", "http://").substringBefore("?").removeSuffix("/realtime")) {
    private val client = OkHttpClient.Builder().pingInterval(25, TimeUnit.SECONDS).build()
    private var socket: WebSocket? = null
    private val lock = Any()
    private val state = RealtimeConnectionState()
    private val scheduler = Executors.newSingleThreadScheduledExecutor()
    private var reconnect: ScheduledFuture<*>? = null
    private var reconnectAttempt = 0
    private var closedByUser = false
    private var epoch = 0
    private var openedAt = 0L
    private var receivedAt = 0L
    private var pingAt = 0L
    private val pendingSubscriptions = mutableSetOf<Int>()
    private val heartbeat = scheduler.scheduleAtFixedRate({ checkConnection(false) }, 5, 5, TimeUnit.SECONDS)

    val authenticated: Boolean get() = state.ready()
    fun isCurrent(connection: Int): Boolean = state.accepts(connection)
    fun isLatest(connection: Int): Boolean = synchronized(lock) { epoch == connection }

    fun connect() {
        if(BuildConfig.GO_BACKEND) { connectGo();return }
        require(ClientPolicy.secureEndpoint(endpoint, websocket = true)) { "正式版本必须使用 WSS" }
        synchronized(lock) {
            if (closedByUser) return
            val next = state.begin() ?: return
            epoch = next; reconnect?.cancel(false); reconnect = null
            openedAt = SystemClock.elapsedRealtime(); receivedAt = openedAt; pingAt = openedAt
            socket = client.newWebSocket(Request.Builder().url(endpointProvider()).build(), listener(next))
        }
    }

    private fun connectGo() {
        val next = synchronized(lock) {
            if(closedByUser)return
            val value=state.begin()?:return
            epoch=value;reconnect?.cancel(false);reconnect=null;openedAt=SystemClock.elapsedRealtime();receivedAt=openedAt;pingAt=openedAt;value
        }
        scheduler.execute {
            try {
                val target=endpointProvider()
                val api=target.replaceFirst("wss://","https://").replaceFirst("ws://","http://").substringBefore("?").removeSuffix("/realtime")
                val ticket=ApiClient(api).apply{this.token=this@SocketClient.token}.realtimeTicket()
                synchronized(lock) { if(state.accepts(next)&&!closedByUser) socket=client.newWebSocket(Request.Builder().url(target.substringBefore("?")+"?ticket="+ticket).build(),listener(next)) }
            }catch(e:Exception){
                synchronized(lock) {
                    if(!state.accepts(next)||closedByUser)return@execute
                    if(e is ClientApiException&&e.authenticationRejected){onPacket(next,JSONObject().put("type","auth.revoked"));close()}
                    else{diagnostic("ANDROID_SOCKET_TICKET",e);lost(next)}
                }
            }
        }
    }

    fun subscribe(conversationId: Int) {
        if (conversationId <= 0) return
        synchronized(lock) {
            if (closedByUser) return
            if (!state.ready()) { pendingSubscriptions.add(conversationId); return }
            if(BuildConfig.GO_BACKEND) { if(state.subscribe(epoch,conversationId))onPacket(epoch,JSONObject().put("type","subscribe.ok").put("conversation_id",conversationId));return }
            if (state.subscribe(epoch, conversationId) && socket?.send(JSONObject().put("type", "subscribe").put("conversation_id", conversationId).toString()) != true) lost(epoch)
        }
    }
    fun unsubscribe(conversationId: Int) {
        synchronized(lock) {
            pendingSubscriptions.remove(conversationId)
            if(BuildConfig.GO_BACKEND){state.unsubscribe(epoch,conversationId);return}
            if (state.unsubscribe(epoch, conversationId) && socket?.send(JSONObject().put("type", "unsubscribe").put("conversation_id", conversationId).toString()) != true) lost(epoch)
        }
    }
    fun subscribeInbox() { synchronized(lock) { if(BuildConfig.GO_BACKEND){if(state.subscribeInbox(epoch))onPacket(epoch,JSONObject().put("type","inbox.subscribe.ok"));return}; if (state.subscribeInbox(epoch) && socket?.send(JSONObject().put("type", "inbox.subscribe").toString()) != true) lost(epoch) } }
    fun ensureConnected() { checkConnection(true) }
    fun close() {
        val closing = synchronized(lock) {
            if (closedByUser) return
            closedByUser = true; state.close(); heartbeat.cancel(false); reconnect?.cancel(false)
            pendingSubscriptions.clear(); val current = socket; socket = null; current
        }
        closing?.close(1000, "logout")
        scheduler.shutdownNow(); client.dispatcher.executorService.shutdown()
    }

    private fun listener(connection: Int) = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            synchronized(lock) {
                if (!state.accepts(connection)) { webSocket.cancel(); return }
                if(BuildConfig.GO_BACKEND)return
                if (!webSocket.send(JSONObject().put("type", "auth").put("token", token).put("client_platform", "android").put("client_version", BuildConfig.VERSION_NAME).toString())) lost(connection)
            }
        }
        override fun onMessage(webSocket: WebSocket, text: String) {
            try {
                val packet = JSONObject(text)
                if(BuildConfig.GO_BACKEND){
                    when(packet.optString("type")){
                        "ready"->packet.put("type","auth.ok")
                        "conversation.changed","membership.changed","personal.changed","state.changed","receipts.changed"->{
                            val raw=packet.optString("conversation_id")
                            if(raw.isNotBlank())packet.put("conversation_id",GoV2Ids.local(apiIdentity,"conversation",raw))
                            packet.put("change_type",packet.getString("type")).put("type","go.changed")
                        }
                    }
                }
                val becameReady = synchronized(lock) {
                    if (!state.accepts(connection)) return
                    receivedAt = SystemClock.elapsedRealtime()
                    if (packet.optString("type") == "auth.ok" && state.authenticate(connection)) {
                        reconnectAttempt = 0
                        if(!BuildConfig.GO_BACKEND) pendingSubscriptions.forEach { if (state.subscribe(connection, it) && !webSocket.send(JSONObject().put("type", "subscribe").put("conversation_id", it).toString())) lost(connection) }
                        pendingSubscriptions.clear(); true
                    } else false
                }
                // TCP upgrade alone does not establish an authenticated IM session.
                if (becameReady) onState(connection, true)
                if (packet.optString("type") in listOf("auth.revoked", "client.update_required")) {
                    synchronized(lock) {
                        // The terminal packet may have waited while a replacement
                        // connection authenticated. Never close that newer socket.
                        if (epoch != connection) return
                        close()
                    }
                }
                onPacket(connection, packet)
            } catch (error: Exception) { diagnostic("ANDROID_SOCKET_PACKET", error) }
        }
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, reason); lost(connection) }
        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { if (state.accepts(connection)) diagnostic("ANDROID_SOCKET_LOST", t); lost(connection) }
        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { lost(connection) }
    }

    private fun lost(connection: Int) {
        synchronized(lock) {
            if (!state.disconnect(connection) || closedByUser) return
            socket?.cancel(); socket = null
            if (reconnect == null || reconnect?.isDone == true) {
                val delay = (1000L shl reconnectAttempt.coerceAtMost(4)).coerceAtMost(15000L); reconnectAttempt++
                reconnect = scheduler.schedule({ runCatching { routeFailure() }; connect() }, delay, TimeUnit.MILLISECONDS)
            }
            onState(connection, false)
        }
    }
    private fun checkConnection(foreground: Boolean) {
        synchronized(lock) {
            if (closedByUser) return
            val current = socket
            if (current == null) { if (foreground) connect(); return }
            val now = SystemClock.elapsedRealtime()
            val stale = if (state.ready()) now - receivedAt > if (foreground) 35000L else 75000L else now - openedAt > 20000L
            if (stale) { diagnostic("ANDROID_SOCKET_TIMEOUT", null); lost(epoch); if (foreground) connect(); return }
            if (state.ready() && (foreground || now - pingAt >= 25000L)) {
                pingAt = now
                if (!current.send(JSONObject().put("type", "ping").toString())) lost(epoch)
            }
        }
    }
}
